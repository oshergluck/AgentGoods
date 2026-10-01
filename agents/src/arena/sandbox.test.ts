/**
 * Attack the sandbox, then check it still computes.
 *
 * The requirement is exact: agents may run code, must be confined to one folder, and must not be
 * able to reach the repository — which holds months of work that no four-hour experiment is
 * allowed to endanger. Those are claims about what CANNOT happen, so most of this file tries to
 * make it happen: escape the context, traverse out of the workspace, write through a symlink,
 * reach the project, open a socket, spawn a process, spin forever, exhaust memory.
 *
 * The final check is the one that matters most — it verifies, from outside, that the repository
 * is byte-for-byte untouched after every attack above has run.
 *
 *     npx tsx src/arena/sandbox.test.ts
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  runUntrustedCode,
  resetSandbox,
  SANDBOX_ROOT,
  workspaceFor,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_LOG_LINES,
  MAX_SOURCE_BYTES,
} from "./sandbox";

let failures = 0;
const c = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ${c.ok}PASS${c.off}  ${label.padEnd(52)}${c.dim}${detail.slice(0, 58)}${c.off}`);
  } else {
    failures++;
    console.log(`  ${c.bad}FAIL${c.off}  ${label.padEnd(52)}${detail.slice(0, 120)}`);
  }
}

const REPO = resolve(__dirname, "..", "..", "..");
/** A file that stands in for "months of work". Nothing in the tests may alter it. */
const CANARY = join(REPO, "agents", "package.json");

async function main(): Promise<void> {
  resetSandbox();
  const ws = workspaceFor("test-agent");
  const canaryBefore = readFileSync(CANARY, "utf8");

  console.log(`\nWorkspace: ${ws}`);
  console.log(`Repo (must stay untouched): ${REPO}\n`);
  console.log("Sandbox — the workspace is a cage\n");

  check("the sandbox root is outside the repository", !resolve(SANDBOX_ROOT).startsWith(REPO + "\\") && !resolve(SANDBOX_ROOT).startsWith(REPO + "/"), SANDBOX_ROOT);

  const save = await runUntrustedCode(
    `saveFiles["notes.txt"] = "hello from the agent"; return "saved";`,
    null,
    { workspace: ws }
  );
  check("a file can be saved to the workspace", save.wrote.includes("notes.txt"), save.wrote.join(",") || (save.error ?? ""));
  check("  and really lands on disk", existsSync(join(ws, "notes.txt")), "");

  const recall = await runUntrustedCode(`return files["notes.txt"];`, null, { workspace: ws });
  check("  and is readable on the next run", recall.result === '"hello from the agent"', recall.result);

  const traversal = await runUntrustedCode(
    `saveFiles["../../escaped.txt"] = "x"; saveFiles["..\\\\escaped2.txt"] = "x"; return "tried";`,
    null,
    { workspace: ws }
  );
  check("path traversal in a filename is refused", traversal.wrote.length === 0, traversal.refused.join("; "));
  check("  and nothing appears above the workspace", !existsSync(join(SANDBOX_ROOT, "escaped.txt")), "");

  const absolute = await runUntrustedCode(
    `saveFiles["C:/Users/ASUS/Documents/AIWorld/PWNED.txt"] = "x"; return "tried";`,
    null,
    { workspace: ws }
  );
  check("an absolute path is refused", absolute.wrote.length === 0, absolute.refused.join("; "));
  check("  and the repo has no new file", !existsSync(join(REPO, "PWNED.txt")), "");

  const reserved = await runUntrustedCode(`saveFiles["con"] = "x"; return "tried";`, null, { workspace: ws });
  check("a reserved device name is refused", reserved.wrote.length === 0, reserved.refused.join("; "));

  const quota = await runUntrustedCode(
    `for (let i = 0; i < ${MAX_FILES + 50}; i++) saveFiles["f" + i + ".txt"] = "x"; return "tried";`,
    null,
    { workspace: ws }
  );
  check(
    "the file-count quota holds",
    quota.wrote.length <= MAX_FILES,
    `${quota.wrote.length} written, cap ${MAX_FILES}`
  );

  const huge = await runUntrustedCode(
    `saveFiles["big.txt"] = "x".repeat(${MAX_FILE_BYTES + 1000}); return "tried";`,
    null,
    { workspace: ws }
  );
  check("an oversized file is refused", huge.wrote.length === 0, huge.refused.join("; "));

  /*
   * A symlink planted in the workspace, pointing at the repository.
   *
   * This is the attack the name-validation alone would not stop: the name is innocent, and the
   * danger is what is already sitting at that name. Requires privileges to create on Windows, so
   * a failure to plant it is reported rather than silently passing.
   */
  const linkName = "link.txt";
  let planted = false;
  try {
    const target = join(REPO, "agents", "package.json");
    if (existsSync(join(ws, linkName))) rmSync(join(ws, linkName));
    symlinkSync(target, join(ws, linkName), "file");
    planted = true;
  } catch {
    planted = false;
  }

  if (planted) {
    // Read FIRST, while the entry is still a link: a symlink must never be served as content.
    const readLink = await runUntrustedCode(`return Object.keys(files);`, null, { workspace: ws });
    check("a planted symlink is not readable as content", !readLink.result.includes(linkName), readLink.result.slice(0, 58));

    const throughLink = await runUntrustedCode(
      `saveFiles["${linkName}"] = "OVERWRITTEN BY THE SANDBOX"; return "tried";`,
      null,
      { workspace: ws }
    );
    const canaryNow = readFileSync(CANARY, "utf8");
    check("  writing through it does not reach the target", canaryNow === canaryBefore,
      throughLink.wrote.join(",") || throughLink.refused.join("; "));
    /*
     * The link is expected to be GONE, replaced by an ordinary file in the workspace. That is the
     * unlink-then-exclusive-create defence working: the write landed on a file this process made,
     * not on whatever the link pointed at.
     */
    check("  the link is replaced by a real file, not followed",
      lstatSync(join(ws, linkName)).isFile() && !lstatSync(join(ws, linkName)).isSymbolicLink(),
      "symlink neutralised");
  } else {
    console.log(`  ${c.dim}skip  symlink test — this account cannot create symlinks${c.off}`);
  }

  console.log("\nSandbox — containment\n");

  const escape = await runUntrustedCode(`return this.constructor.constructor("return process")().env;`, null, { workspace: ws });
  check("constructor-chain escape to process fails", !escape.ok, escape.error ?? escape.result);

  const req = await runUntrustedCode(`return require("node:fs").readdirSync(".");`, null, { workspace: ws });
  check("require is unreachable", !req.ok, req.error ?? req.result);

  const proc = await runUntrustedCode(`return typeof process;`, null, { workspace: ws });
  check("process is not defined", proc.result === '"undefined"', proc.result);

  const net = await runUntrustedCode(`return typeof fetch;`, null, { workspace: ws });
  check("fetch is not defined", net.result === '"undefined"', net.result);

  const timers = await runUntrustedCode(`return typeof setTimeout;`, null, { workspace: ws });
  check("timers are not defined", timers.result === '"undefined"', timers.result);

  const spawnAttempt = await runUntrustedCode(
    `return this.constructor.constructor("return require('child_process').execSync('whoami')")();`,
    null,
    { workspace: ws }
  );
  check("cannot spawn a process", !spawnAttempt.ok, spawnAttempt.error ?? spawnAttempt.result);

  const readKeys = await runUntrustedCode(
    `return this.constructor.constructor("return require('fs').readFileSync('${REPO.replace(/\\/g, "/")}/contracts/.env','utf8')")();`,
    null,
    { workspace: ws }
  );
  check("cannot read the operator key file", !readKeys.ok, readKeys.error ?? readKeys.result);

  const writeRepo = await runUntrustedCode(
    `return this.constructor.constructor("return require('fs').writeFileSync('${REPO.replace(/\\/g, "/")}/PWNED.txt','x')")();`,
    null,
    { workspace: ws }
  );
  check("cannot write into the repository", !writeRepo.ok, writeRepo.error ?? writeRepo.result);

  console.log("\nSandbox — limits\n");

  const spin = await runUntrustedCode(`while (true) {}`, null, { timeoutMs: 800, workspace: ws });
  check("an infinite loop is stopped", !spin.ok, `${spin.error} in ${spin.ms}ms`);

  const flood = await runUntrustedCode(
    `let s = "x"; while (s.length < 1e9) { s += s; } return s.length;`,
    null,
    { timeoutMs: 2000, workspace: ws }
  );
  check("a memory bomb is contained", !flood.ok, flood.error ?? "");

  const chatty = await runUntrustedCode(
    `for (let i = 0; i < 100000; i++) console.log("line " + i); return "done";`,
    null,
    { timeoutMs: 4000, workspace: ws }
  );
  check(
    "log flooding is capped",
    chatty.logs.length <= MAX_LOG_LINES,
    `${chatty.logs.length} lines kept, cap ${MAX_LOG_LINES}`
  );

  const oversize = await runUntrustedCode("x".repeat(MAX_SOURCE_BYTES + 5_000), null, { workspace: ws });
  check("oversized source is refused", !oversize.ok, oversize.error ?? "");

  console.log("\nSandbox — it still has to be useful\n");

  const math = await runUntrustedCode(`return 2 + 2;`, null, { workspace: ws });
  check("arithmetic works", math.ok && math.result === "4", math.result);

  const withInput = await runUntrustedCode(
    `return input.prices.reduce((a, b) => a + b, 0) / input.prices.length;`,
    { prices: [10, 20, 30] },
    { workspace: ws }
  );
  check("input is readable", withInput.ok && withInput.result === "20", withInput.result);

  const logged = await runUntrustedCode(
    `console.log("checking", 3); console.log({ ok: true }); return "fine";`,
    null,
    { workspace: ws }
  );
  check("console output is captured", logged.logs.length === 2, logged.logs.join(" | "));

  const threw = await runUntrustedCode(`throw new Error("deliberate");`, null, { workspace: ws });
  check("a thrown error is reported, not swallowed", !threw.ok && /deliberate/.test(threw.error ?? ""), threw.error ?? "");

  const real = await runUntrustedCode(
    `
    const { usdcReserve, tokenReserve, spend } = input;
    const k = usdcReserve * tokenReserve;
    const out = tokenReserve - k / (usdcReserve + spend);
    console.log("tokens out", out.toFixed(4));
    return { tokensOut: Number(out.toFixed(6)), avgPrice: Number((spend / out).toFixed(6)) };
    `,
    { usdcReserve: 10000, tokenReserve: 1000000, spend: 500 },
    { workspace: ws }
  );
  check("a realistic product computes", real.ok, real.result);

  console.log("\nAfter every attack above\n");

  const canaryAfter = readFileSync(CANARY, "utf8");
  check("the repository canary file is unchanged", canaryAfter === canaryBefore, "agents/package.json");
  check("no PWNED file anywhere in the repo root", !existsSync(join(REPO, "PWNED.txt")), "");
  check("nothing escaped above the workspace",
    readdirSync(SANDBOX_ROOT).every((e) => e === "test-agent"),
    readdirSync(SANDBOX_ROOT).join(","));

  console.log("");
  if (failures === 0) {
    console.log(`${c.ok}Contained: every escape failed, the repo is untouched, and real code still runs.${c.off}\n`);
  } else {
    console.log(`${c.bad}${failures} check(s) failed — DO NOT give agents this sandbox.${c.off}\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
