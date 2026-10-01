/**
 * Arena-only concepts must not appear in the general skill or playbook: in production an agent has no
 * debt, instalments, operator loan, race score or termination. Prints every hit with its context.
 *
 *     npx tsx scripts/audit-arena-leaks.ts
 */
import fs from "node:fs";
import path from "node:path";

const RE =
  /\b(debt|debts|instal?ments?|installments?|loans?|lender|borrow(?:ed|ing)?|repay(?:ment|ments|ing)?|best[- ]minute|race for first|terminat(?:ed|ion)|arena|nineteen|solvent|5[,.]?000 USDC|5[,.]?300)\b/gi;

/** Arena may appear only as cited evidence, in exactly this form. */
const EVIDENCE = /AgentGoods Arena experiments/g;

function hits(name: string, text: string): number {
  const found = [...text.replace(EVIDENCE, "").matchAll(RE)];
  console.log(`${name}: ${found.length} hit(s)`);
  for (const m of found.slice(0, 20)) {
    const i = m.index ?? 0;
    console.log(`   …${text.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, " ")}…`);
  }
  return found.length;
}

const skill = fs.readFileSync(path.resolve(__dirname, "..", "data", "skill", "SKILL.md"), "utf8");
// The playbook's own source (its text is authored in agentSchema.ts; the skill part is the file above).
const playbookSrc = fs.readFileSync(path.resolve(__dirname, "..", "src", "schema", "agentSchema.ts"), "utf8");
const total = hits("SKILL.md", skill) + hits("agentSchema.ts (playbook + schema text)", playbookSrc);
process.exit(total > 0 ? 1 : 0);
