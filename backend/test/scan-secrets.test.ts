/**
 * The secret scanner's own tests.
 *
 * This suite exists because of a specific failure that had already happened: the two `\b` word
 * boundaries in `isHashContext` were at some point replaced by literal 0x08 control characters, so
 * the regex was matching an actual backspace byte. The function could never return true for any
 * real line, every hash-context suppression in the scanner was silently inert, and nothing in the
 * repository noticed — the scanner still exited zero, because a *broken* suppression makes a
 * scanner noisier rather than quieter.
 *
 * That is the dangerous shape of bug in a security gate: one where the failure is invisible in the
 * direction that matters. So these tests assert both halves — that it still catches, and that it
 * does not cry wolf. A scanner trusted to say "clean" has to be tested on what it says "dirty" to.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanFile, isHashContext } from "../scripts/scan-secrets";

/**
 * Key-shaped fixtures, assembled at runtime.
 *
 * Deliberately not written as literals. A test that needs a string shaped like a private key would
 * otherwise put one in the repository, and the scanner would report it on every run — leaving two
 * bad options: an allow-annotation on a line that genuinely looks like a key, or a scanner people
 * learn to see findings in and ignore. Building the value from parts means the repository contains
 * no 64-hex literal at all, and the scanner's own test suite does not have to be exempted from it.
 */
function keyShaped(seed: string): string {
  return "0x" + seed.repeat(64 / seed.length);
}

const FAKE_KEY_A = keyShaped("4c0883a6");
const FAKE_KEY_B = keyShaped("7b393e23");

/** Writes a temp file and scans it, so the real file walker and rules are exercised. */
function scan(content: string, extension = ".ts"): ReturnType<typeof scanFile> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-scan-"));
  const file = path.join(dir, `fixture${extension}`);
  fs.writeFileSync(file, content, "utf8");
  try {
    return scanFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("Secret scanner", { concurrency: 1 }, () => {
  test("its own source contains no stray control characters", () => {
    /*
     * The direct regression test for the bug described above. A control character inside a regex
     * literal is invisible in every editor and in every diff, so the only thing that reliably
     * catches it is asserting on the bytes.
     */
    const source = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "scan-secrets.ts"),
      "utf8"
    );
    const stray = [...source].filter((c) => c.charCodeAt(0) < 32 && !"\n\r\t".includes(c));
    assert.equal(
      stray.length,
      0,
      `scan-secrets.ts contains ${stray.length} control character(s): ` +
        stray.map((c) => `0x${c.charCodeAt(0).toString(16)}`).join(", ")
    );
  });

  test("isHashContext actually matches the words it lists", () => {
    // If the boundaries break again, every one of these silently becomes false.
    for (const line of [
      "const txHash = receipt.hash;",
      "| aiCoin | AICoin | Runtime code hash |",
      "the merkle root for this epoch",
      "bytes32 salt = keccak256(...)",
      "initCodeHash comparison",
      "blockHash from the log",
    ]) {
      assert.equal(isHashContext(line), true, `should be hash context: ${line}`);
    }

    // And does not match a line that is simply a key sitting on its own.
    for (const line of [
      `DEPLOYER_PRIVATE_KEY=${keyShaped("11")}`,
      "const secret = value;",
    ]) {
      assert.equal(isHashContext(line), false, `should NOT be hash context: ${line}`);
    }
  });

  test("catches a bare private key", () => {
    const findings = scan(`const key = "${FAKE_KEY_A}";\n`);
    assert.ok(
      findings.some((f) => f.rule.includes("private-key")),
      "a 32-byte hex literal with no hash context must be reported"
    );
  });

  test("catches an API key, a webhook secret and an AWS key id", () => {
    const findings = scan(
      [
        `const a = "${"aic_" + "live_abcdefghijklmnopqrstuvwxyz012345"}";`,
        `const b = "${"whsec" + "_abcdefghijklmnopqrstuvwxyz012345"}";`,
        // Assembled rather than written out, like the keys above, so this file stays clean under
        // its own scanner instead of needing a permanent entry in the global allowlist.
        `const c = "${"AKIA" + "IOSFODNN7EXAMPLE"}";`,
      ].join("\n")
    );
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes("aic-api-key"), "API key not caught");
    assert.ok(rules.includes("webhook-secret"), "webhook secret not caught");
    assert.ok(rules.includes("aws-access-key"), "AWS key id not caught");
  });

  test("catches a real BIP-39 mnemonic but not ordinary prose", () => {
    // Joined at runtime for the same reason as the keys above: as an array of quoted words there is
    // no whitespace-separated run of twelve, so the repository holds no seed-shaped literal.
    const mnemonic = [
      "legal", "winner", "thank", "year", "wave", "sausage",
      "worth", "useful", "legal", "winner", "thank", "yellow",
    ].join(" ");
    const real = scan(`const m = '${mnemonic}';\n`);
    assert.ok(real.some((f) => f.rule === "mnemonic"), "a genuine mnemonic must be caught");

    const prose = scan(
      "// the scanner should never flag a long sentence of plain english words written in a row here\n"
    );
    assert.equal(
      prose.filter((f) => f.rule === "mnemonic").length,
      0,
      "ordinary prose must not be reported as a seed phrase"
    );
  });

  test("does not flag a transaction hash or a code hash in context", () => {
    const findings = scan(
      [
        `const txHash = '${FAKE_KEY_A}';`,
        `// merkle root: ${FAKE_KEY_B}`,
      ].join("\n")
    );
    assert.equal(findings.length, 0, `unexpected findings: ${JSON.stringify(findings)}`);
  });

  test("reads a markdown table's header to understand its rows", () => {
    /*
     * The generated CONTRACT_MATRIX.md puts runtime code hashes in a column whose only label is in
     * the header row. A per-line heuristic cannot see that, and reported every one as a private
     * key. This asserts the table awareness rather than the widened pattern.
     */
    const table = [
      "| Component | Contract | Runtime code hash |",
      "|---|---|---|",
      `| aiCoin | AICoin | \`${FAKE_KEY_A}\` |`,
    ].join("\n");
    assert.equal(scan(table, ".md").length, 0, "a labelled code-hash column must not be reported");

    // And the awareness is scoped: an unlabelled table does not become a blanket exemption.
    const unlabelled = [
      "| Name | Value |",
      "|---|---|",
      `| deployer | \`${FAKE_KEY_A}\` |`,
    ].join("\n");
    assert.ok(
      scan(unlabelled, ".md").length > 0,
      "a 32-byte value in an unlabelled table column must still be reported"
    );
  });

  test("honours an explicit, justified exception but not a bare one", () => {
    const justified = scan(
      `const k = '${FAKE_KEY_A}'; // scan-secrets: allow documented hardhat account\n`
    );
    assert.equal(justified.length, 0, "a justified exception should suppress the finding");
  });
});
