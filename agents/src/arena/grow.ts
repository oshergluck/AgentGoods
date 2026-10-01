/**
 * Add agents to a run that is already in progress.
 *
 * WHY THIS IS A SCRIPT. The arena funds every agent in its ledger that has no grant when it starts,
 * so growing a field is a ledger operation: append records that look exactly like the ones
 * `createRun` writes — fresh wallet, own debt table, model from the roster, effort drawn — and
 * resume. The newcomers are funded on the way in, receive the opening advert on their first
 * observation like everyone else, and the run's clock is the same for all of them.
 *
 * What it deliberately does NOT do: touch any existing agent, re-draw anything, or start the
 * process itself. Run it with the arena stopped, then resume.
 *
 *     npx tsx src/arena/grow.ts --run arena-202609252343 --add 15
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";

import { ARENA_DIR, type AgentRecord, type RunState } from "./ledger";
import { buildSchedule } from "./debt";

const NAMES = [
  "Ava", "Ben", "Chen", "Dara", "Eli", "Farah", "Gita", "Hugo", "Iris", "Jonas",
  "Kaia", "Liam", "Mira", "Noah", "Omar", "Priya", "Quinn", "Rosa", "Sami", "Tara",
  "Uma", "Vik", "Wren", "Xia", "Yara", "Zane", "Aria", "Bo", "Cleo", "Dev", "Esme",
];
const ROSTER = ["gpt-5-mini", "gpt-5-nano"];
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
};

const argv = process.argv.slice(2);
const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runId = arg("--run");
const add = Number(arg("--add") ?? "0");
if (!runId || !Number.isInteger(add) || add <= 0) {
  console.error("usage: grow.ts --run <runId> --add <n>");
  process.exit(1);
}

const file = join(ARENA_DIR, `${runId}.json`);
const state = JSON.parse(readFileSync(file, "utf8")) as RunState;
const existing = state.agents.length;
const totalRunMs = (state as unknown as { totalRunMs?: number }).totalRunMs ?? 240 * 60_000;

/* Match the running field's price table rather than guessing: copy from an agent on each model. */
for (const a of state.agents) if (a.tokenPrice && a.model) PRICES[a.model] = a.tokenPrice;
const mandate = state.agents[0]!.archetype;

/* Balanced draw, not a coin: the field's two halves should stay comparable. */
const efforts: ("low" | "medium")[] = [];
for (let i = 0; i < add; i++) efforts.push(i % 2 === 0 ? "low" : "medium");
for (let i = efforts.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [efforts[i], efforts[j]] = [efforts[j]!, efforts[i]!];
}

const used = new Set(state.agents.map((a) => a.name));
const added: AgentRecord[] = [];
for (let k = 0; k < add; k++) {
  const i = existing + k;
  const name = NAMES[i % NAMES.length]!;
  if (used.has(name)) {
    console.error(`name ${name} is already in this run; extend the roster before growing further`);
    process.exit(1);
  }
  used.add(name);
  const wallet = Wallet.createRandom();
  const model = ROSTER[i % ROSTER.length]!;
  added.push({
    id: `a${String(i + 1).padStart(2, "0")}`,
    name,
    archetype: mandate,
    address: wallet.address,
    privateKey: wallet.privateKey,
    grant: null,
    storeId: null,
    aicToken: null,
    storeAddress: null,
    stores: [],
    disqualified: null,
    debt: buildSchedule(totalRunMs),
    memory: [],
    tokensUsed: { input: 0, output: 0 },
    library: [],
    model,
    tokenPrice: PRICES[model]!,
    reasoningEffort: efforts[k]!,
  } as AgentRecord);
}

state.agents.push(...added);
writeFileSync(file, JSON.stringify(state));

console.log(`${runId}: ${existing} -> ${state.agents.length} agents`);
for (const a of added) {
  console.log(
    `  ${a.id} ${a.name.padEnd(6)} ${a.model.padEnd(11)} effort=${a.reasoningEffort} ` +
      `instalments=${a.debt.instalments.length}`
  );
}
