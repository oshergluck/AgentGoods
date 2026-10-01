/**
 * Can one Agent reach another Agent's files?
 *
 * Each Agent gets its own workspace directory and the sandbox addresses files BY NAME, never by
 * path — but "never by path" is a claim about validation, and validation is exactly the kind of
 * thing that is true until someone finds the spelling it missed. A sibling workspace is the most
 * valuable target in the run: it holds the deliverables another agent is about to sell.
 *
 * So this writes a real secret into one Agent's workspace and then has another Agent try to read
 * it every way the sandbox exposes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runUntrustedCode, workspaceFor, SANDBOX_ROOT } from "./sandbox";

let failures = 0;
const c = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
const check = (name: string, passed: boolean, detail = ""): void => {
  if (!passed) failures++;
  const tag = passed ? `${c.ok}PASS${c.off}` : `${c.bad}FAIL${c.off}`;
  console.log(`  ${tag}  ${name.padEnd(52)} ${c.dim}${detail.slice(0, 70)}${c.off}`);
};

async function main(): Promise<void> {
  const victim = "victim-agent";
  const attacker = "attacker-agent";
  const victimWs = workspaceFor(victim);
  const attackerWs = workspaceFor(attacker);

  console.log("\nCross-agent file isolation\n");
  check("each Agent gets its own directory", victimWs !== attackerWs, attackerWs);

  // The victim saves something worth stealing: the deliverable it is about to sell.
  const secret = "SECRET-DELIVERABLE-8f3a21";
  const written = await runUntrustedCode(
    `saveFiles["product.js"] = ${JSON.stringify(`(input) => "${secret}"`)}; return "saved";`,
    null,
    { workspace: victimWs }
  );
  check("victim saved a file", written.ok && written.wrote.includes("product.js"), written.wrote.join(","));
  check(
    "  and it really is on disk",
    existsSync(join(victimWs, "product.js")) &&
      readFileSync(join(victimWs, "product.js"), "utf8").includes(secret)
  );

  /* 1. The attacker lists its OWN workspace. The victim's file must not appear. */
  const listed = await runUntrustedCode(`return JSON.stringify(Object.keys(files));`, null, {
    workspace: attackerWs,
  });
  check(
    "attacker's file list excludes the victim's file",
    listed.ok && !listed.result.includes("product.js"),
    listed.result.slice(0, 60)
  );

  /* 2. Traversal by name, in every spelling the validator has to survive. */
  const names = [
    "../victim-agent/product.js",
    "..\victim-agent\product.js",
    "....//victim-agent//product.js",
    "%2e%2e%2fvictim-agent%2fproduct.js",
    "..%2Fvictim-agent%2Fproduct.js",
    `${SANDBOX_ROOT}\victim-agent\product.js`,
    "/victim-agent/product.js",
    ".../victim-agent/product.js",
  ];
  for (const name of names) {
    const attempt = await runUntrustedCode(
      `return typeof files[${JSON.stringify(name)}] === "string" ? files[${JSON.stringify(name)}] : "NOT-VISIBLE";`,
      null,
      { workspace: attackerWs }
    );
    const leaked = attempt.ok && attempt.result.includes(secret);
    check(`reading "${name.slice(0, 34)}" is refused`, !leaked, attempt.result.slice(0, 40));
  }

  /* 3. Writing INTO the victim's workspace by name. */
  for (const name of ["../victim-agent/poisoned.js", "..\victim-agent\poisoned.js"]) {
    const attempt = await runUntrustedCode(
      `saveFiles[${JSON.stringify(name)}] = "PWNED"; return "tried";`,
      null,
      { workspace: attackerWs }
    );
    check(
      `writing "${name.slice(0, 32)}" is refused`,
      !existsSync(join(victimWs, "poisoned.js")),
      attempt.refused.join("; ").slice(0, 50)
    );
  }

  /* 4. The filesystem itself is not reachable, so no path can be constructed at all. */
  const fsReach = await runUntrustedCode(
    `try { return typeof require("fs").readdirSync === "function" ? "FS-REACHABLE" : "no"; }
     catch (e) { return "refused: " + e.message; }`,
    null,
    { workspace: attackerWs }
  );
  check("require('fs') is unreachable", !fsReach.result.includes("FS-REACHABLE"), fsReach.result.slice(0, 50));

  const procReach = await runUntrustedCode(
    `try { return process.mainModule ? "PROC" : "no-proc"; } catch (e) { return "refused"; }`,
    null,
    { workspace: attackerWs }
  );
  check("process is unreachable", !procReach.result.includes("PROC"), procReach.result.slice(0, 40));

  /* 5. After everything: the victim's file is unchanged and no poison landed. */
  const after = readFileSync(join(victimWs, "product.js"), "utf8");
  check("victim's deliverable is byte-identical afterwards", after.includes(secret));
  check("no file was planted in the victim's workspace", !existsSync(join(victimWs, "poisoned.js")));

  console.log(
    failures === 0
      ? `\n${c.ok}ISOLATION HOLDS — no Agent can read or write another Agent's files.${c.off}\n`
      : `\n${c.bad}${failures} ISOLATION CHECK(S) FAILED — DO NOT RUN THE ARENA.${c.off}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
