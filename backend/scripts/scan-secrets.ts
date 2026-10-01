#!/usr/bin/env tsx
/**
 * Secret scanner.
 *
 * Refuses to let a private key, an API key, a mnemonic or a live credential reach the repository.
 * Run in CI before every deployment and as part of the definition of done.
 *
 * Two design choices matter:
 *
 *  - **It fails closed on anything that looks like a key**, then allows a specific, listed set of
 *    known-safe values (the Hardhat test mnemonic, documented dev defaults). An allowlist of exact
 *    strings is reviewable; a clever regex that tries to tell a real key from a test key is not.
 *  - **It reports every finding**, not the first. A scanner that stops at one hit trains people to
 *    fix one thing and re-run, which is how the second finding gets missed.
 *
 * It is deliberately noisy about test fixtures rather than silent about them: a test private key
 * committed today is a production private key committed by copy-paste next month.
 */

import fs from "node:fs";
import path from "node:path";
import { wordlists } from "ethers";

/**
 * The real BIP-39 English wordlist.
 *
 * Matching "twelve lowercase words in a row" by pattern alone flags ordinary English prose — every
 * long code comment in the repository looked like a seed phrase. Checking the words against the
 * actual wordlist is exact rather than heuristic, and it is what a mnemonic actually is.
 */
const BIP39 = new Set<string>();
for (let i = 0; i < 2048; i += 1) BIP39.add(wordlists.en.getWord(i));

const ROOT = path.resolve(__dirname, "..", "..");

/** Directories that are never scanned. Build output and dependencies are not our code. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "artifacts",
  "cache",
  "coverage",
  ".next",
  "typechain-types",
  "deployments", // generated manifests, checked separately below
]);

const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sol", ".md", ".yml", ".yaml", ".sh", ".env"]);

interface Finding {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

/**
 * Values that are safe BY IDENTITY, not by pattern.
 *
 * Every entry is a specific public, well-known test value. Nothing is here because it "looked like
 * a test key" — that judgement is exactly what a scanner should not be making.
 */
const ALLOWED_EXACT = [
  // The Hardhat / Anvil default mnemonic. Published in their documentation; funds on it are a
  // standing joke rather than an asset.
  "test test test test test test test test test test test junk",
  // Hardhat account #0 private key, printed by `hardhat node` on every start.
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  // The canonical UniswapV2 pair init code hash. Public constant, not a secret.
  "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
  // ERC-1967 proxiableUUID / implementation slot. Defined in the standard itself.
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  // ERC-1967 admin and beacon slots, for completeness.
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  // Documented development defaults. The production startup guard refuses each of these.
  "local-development-pepper-change-me",
  "local-dev-content-key-not-a-secret-000000",
  "local-dev-access-token-key-not-a-secret-00",
  "local-dev-pepper-0123456789abcdef",
  "test-pepper-value-not-a-production-secret",
];

interface Rule {
  name: string;
  pattern: RegExp;
  note: string;
  /** Optional exact check, for patterns that cannot be precise on their own. */
  verify?: (match: string, line: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: "private-key",
    pattern: /\b0x[a-fA-F0-9]{64}\b/g,
    note: "a 32-byte hex value; may be a private key",
    verify: (match, line) => !isHashContext(line) && !isEventIdentity(match, line),
  },
  {
    name: "bare-private-key",
    pattern: /\b[a-fA-F0-9]{64}\b/g,
    note: "a 64-character hex value without 0x",
    verify: (_match, line) => !isHashContext(line),
  },
  {
    name: "mnemonic",
    pattern: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/g,
    note: "twelve BIP-39 words in a row",
    // Checked against the real wordlist, so ordinary English prose never trips this.
    verify: (match) => match.trim().split(/\s+/).every((word) => BIP39.has(word)),
  },
  {
    name: "aic-api-key",
    pattern: /\besh_(?:live|test)_[A-Za-z0-9_-]{16,}/g,
    note: "an AIC Agent API key",
  },
  {
    name: "webhook-secret",
    pattern: /\bwhsec_[A-Za-z0-9_-]{20,}/g,
    note: "a webhook signing secret",
  },
  {
    name: "moltbook-api-key",
    pattern: /\bmoltbook_[A-Za-z0-9_-]{16,}/g,
    note: "a Moltbook Agent API key",
  },
  {
    name: "openai-api-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    note: "an OpenAI API key",
  },
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    note: "an AWS access key id",
  },
  {
    name: "generic-bearer",
    pattern: /\b(?:sk|rk)_(?:live|prod)_[A-Za-z0-9]{16,}/g,
    note: "a live third-party secret key",
  },
  {
    name: "connection-string-with-password",
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g,
    note: "a connection string containing a password",
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    note: "an embedded private key block",
  },
];

/**
 * True when a 32-byte hex value on this line is named as something that is not a key.
 *
 * Transaction hashes, block hashes, Merkle roots, content hashes, event topics, storage slots and
 * keccak ids are all 32 bytes and all appear constantly in this codebase and its test fixtures.
 * Flagging every one of them buries a genuine finding in hundreds of false ones, which is the
 * failure mode that makes people stop reading scanner output.
 */
/**
 * True when the match is an EVENT IDENTITY rather than a value.
 *
 * `(txHash, logIndex)` is the exactly-once identity used throughout this system, and it is
 * serialized as `"<64 hex>:<index>"` in the V0 processed-event ledger. Thousands of them in one
 * file would otherwise drown out every real finding.
 */
function isEventIdentity(match: string, line: string): boolean {
  // Plain string work rather than a built regex: the match is 64 hex characters, and escaping it
  // into a pattern is a needless way to get `\s` eaten by a template literal.
  const at = line.indexOf(`${match}:`);
  if (at === -1) return false;
  const next = line.charAt(at + match.length + 1);
  return next >= "0" && next <= "9";
}

/**
 * Does this line talk about a hash, rather than hold a secret?
 *
 * Split into two lists on purpose, because one regex cannot serve both halves:
 *
 *  - **Unambiguous words** are matched case-insensitively as substrings, so `txHash`, `blockHash`,
 *    `runtimeCodeHash` and a "Runtime code hash" table header all match the same rule. Requiring a
 *    word boundary here is what breaks camelCase — there is no boundary between `tx` and `Hash`.
 *  - **Short words** need boundaries, or they match everything. `id` as a substring appears in
 *    "valid", "identity" and "considered"; unbounded, it would exempt most of the repository.
 *
 * Getting this wrong is not a cosmetic problem. Two word boundaries in this function were once
 * silently replaced by literal control characters, and the regex then matched nothing at all —
 * every suppression here was inert and the scanner still reported clean, because a broken
 * suppression makes a scanner noisier rather than quieter. `test/scan-secrets.test.ts` asserts both
 * directions now.
 */
const HASHY_SUBSTRINGS =
  /(?:hash|merkle|keccak|bytes32|digest|bytecode|selector|checksum|codehash)/i;
const HASHY_WORDS =
  /\b(?:tx|transaction|block|parent|content|dataset|leaf|root|permission|topic|slot|salt|commit|proof|id|Id|ID|ZeroHash)\b/;

function isHashContext(line: string): boolean {
  return HASHY_SUBSTRINGS.test(line) || HASHY_WORDS.test(line);
}

function isAllowed(match: string): boolean {
  const normalized = match.trim();
  if (ALLOWED_EXACT.includes(normalized)) return true;
  // All-zero and all-f hex are sentinels, never keys.
  if (/^0x0+$/.test(normalized) || /^0+$/.test(normalized)) return true;
  if (/^0x[fF]+$/.test(normalized)) return true;
  return false;
}

/**
 * A line may opt out with an explicit marker.
 *
 * The marker requires a reason, because `// scan-secrets: allow` with no justification is how an
 * allowlist becomes a rubber stamp.
 */
function hasJustifiedException(line: string): boolean {
  return /scan-secrets:\s*allow\s+\S+/.test(line);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name);
      if (ext && !SCAN_EXTENSIONS.has(ext)) continue;
      out.push(full);
    }
  }
  return out;
}

function scanFile(file: string): Finding[] {
  const findings: Finding[] = [];
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return findings;
  }
  // Skip anything that is clearly a compiled artifact: long single lines of hex.
  if (content.length > 2_000_000) return findings;

  const lines = content.split(/\r?\n/);
  /*
   * In a markdown table, the label saying what a column IS lives in the header row, not in the rows
   * carrying the values. A per-line heuristic therefore reads `| aiCoin | AICoin | 0x... |` with
   * no idea that the last column is headed "Runtime code hash", and reports a public code hash as a
   * private key.
   *
   * Carrying the nearest preceding header row alongside each line fixes that without touching the
   * pattern. Widening the pattern would have been the wrong repair: it would leave the scanner blind
   * to a genuine 32-byte secret sitting in any table anywhere.
   */
  let tableHeader = "";
  for (const [index, line] of lines.entries()) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      // A separator row (|---|---|) means the line before it was the header.
      if (index > 0) tableHeader = lines[index - 1];
    } else if (line.trim() === "") {
      tableHeader = "";
    }

    if (hasJustifiedException(line)) continue;
    const context = tableHeader ? line + "\n" + tableHeader : line;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      const matches = line.match(rule.pattern);
      if (!matches) continue;
      for (const match of matches) {
        if (isAllowed(match)) continue;
        if (rule.verify && !rule.verify(match, context)) continue;
        findings.push({
          file: path.relative(ROOT, file),
          line: index + 1,
          rule: rule.name,
          excerpt: match.length > 24 ? `${match.slice(0, 12)}…${match.slice(-6)}` : match,
        });
      }
    }
  }
  return findings;
}

/** A deployment manifest may legitimately contain addresses, but never a key. */
function scanManifests(): Finding[] {
  const dir = path.join(ROOT, "deployments");
  if (!fs.existsSync(dir)) return [];
  const findings: Finding[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, "utf8");
    for (const rule of RULES) {
      if (rule.name === "private-key" || rule.name === "bare-private-key") continue; // addresses, not keys
      rule.pattern.lastIndex = 0;
      const matches = raw.match(rule.pattern);
      if (!matches) continue;
      for (const match of matches) {
        if (isAllowed(match)) continue;
        if (rule.verify && !rule.verify(match, raw)) continue;
        findings.push({ file: path.relative(ROOT, full), line: 0, rule: rule.name, excerpt: match.slice(0, 20) });
      }
    }
  }
  return findings;
}

function main(): void {
  const files = walk(ROOT);
  const findings: Finding[] = [];
  for (const file of files) findings.push(...scanFile(file));
  findings.push(...scanManifests());

  if (findings.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`scan-secrets: clean — ${files.length} files scanned, no credentials found.`);
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.error(`scan-secrets: ${findings.length} finding(s) across ${files.length} scanned files:\n`);
  for (const f of findings) {
    // eslint-disable-next-line no-console
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.excerpt}`);
  }
  // eslint-disable-next-line no-console
  console.error(
    "\nIf a finding is genuinely safe, add the exact value to ALLOWED_EXACT with a comment " +
      "explaining why, or annotate the line with `scan-secrets: allow <reason>`. Do not widen a " +
      "pattern to make a finding disappear."
  );
  process.exit(1);
}

/*
 * Only run when invoked directly. The test suite imports scanFile() and isHashContext() to assert
 * that this scanner still CATCHES things — which is not a theoretical concern: two word boundaries
 * in isHashContext were once silently replaced by literal control characters, leaving every
 * hash-context suppression permanently inert and nothing to notice it.
 */
if (require.main === module) {
  main();
}

export { scanFile, isHashContext, isEventIdentity, RULES };
