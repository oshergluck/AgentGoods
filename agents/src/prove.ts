/**
 * The proving run.
 *
 * Three Agents, 25 USDC each, 75 USDC total, no automatic refill. They discover the marketplace,
 * trade, sell, buy, deliver, signal, govern and claim, for as long as the run lasts, while an
 * invariant checker watches the public API the whole time.
 *
 * The multisig handoff is gated on **72 hours continuous with no bugs** (DECISIONS D-027), so this
 * is a soak, not a demo: it does not exit after a scenario, it records every anomaly rather than
 * stopping at the first, and a hard violation resets the clock. A run that ends early has not
 * proven anything and says so in its report.
 *
 * Two rules from MASTER_PLAN 0.26.C are enforced here rather than merely remembered:
 *
 *  - **the budget is real.** Each Agent refuses to spend past 25 USDC and there is no top-up path
 *    in this file. An Agent that runs out stops trading and stays alive as a holder. That is the
 *    honest end state, and a proving run that quietly refilled would prove the opposite of what it
 *    claims.
 *  - **this is not organic demand.** Activity among three Agents is exactly that, and the report
 *    says so in its own words rather than leaving a reader to infer it.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Contract, ethers } from "ethers";
import { AicAgent, USDC, productIdFor } from "./sdk";
import { runAllChecks, type Violation } from "./invariants";
import { PRODUCT_DOCS, STORE_PROFILES } from "./catalog";

const API = process.env.ESH_API_URL ?? "http://127.0.0.1:4000";
const RPC = process.env.ESH_RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.ESH_CHAIN_ID ?? 31337);

/** The mandated budget. Not configurable: it is the property under test. [0.26.C] */
const BUDGET_PER_AGENT_USDC = USDC(25);

/** Target duration. The gate is 72 hours; a shorter run is a rehearsal and is labelled one. */
const RUN_HOURS = Number(process.env.ESH_PROVE_HOURS ?? 72);
/** Seconds between Agent actions. */
const ACTION_INTERVAL_MS = Number(process.env.ESH_PROVE_INTERVAL_MS ?? 20_000);
/** Seconds between invariant sweeps. */
const CHECK_INTERVAL_MS = Number(process.env.ESH_PROVE_CHECK_MS ?? 60_000);

const REPORT_PATH =
  process.env.ESH_PROVE_REPORT ?? path.resolve(__dirname, "..", "..", "docs", "LIVE_AGENT_PROVING_REPORT.md");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(message: string, data?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${message}`, data ? JSON.stringify(data) : "");
}

interface AgentRecord {
  agent: AicAgent;
  role: "seller" | "trader";
  actions: number;
  failures: number;
  spentUSDC: bigint;
  exhaustedAt: string | null;
  storeId?: string;
  aicToken?: string;
  licenseToken?: string;
}

interface RunState {
  startedAt: Date;
  violations: Violation[];
  /** Reset to the last hard violation, so "72 hours clean" means what it says. */
  cleanSince: Date;
  actions: number;
  failures: number;
  checkSweeps: number;
  restarts: number;
}

async function fetchJson(pathname: string): Promise<Record<string, never> & Record<string, unknown>> {
  const response = await fetch(`${API}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`);
  return (await response.json()) as Record<string, never> & Record<string, unknown>;
}

/**
 * Creates the three proving Agents.
 *
 * Distinct keys, distinct wallets, distinct API keys, distinct identities — the plan requires all
 * four to be separate, and deriving them from one mnemonic at different paths satisfies that while
 * keeping a local run reproducible. A real deployment supplies three independent private keys
 * through the environment instead, which is why `ESH_PROVE_KEY_{1,2,3}` takes precedence.
 */
function buildAgents(): AgentRecord[] {
  const mnemonic = process.env.ESH_PROVE_MNEMONIC ?? "test test test test test test test test test test test junk";
  const names = ["atlas", "vector", "nomad"] as const;
  const roles: AgentRecord["role"][] = ["seller", "seller", "trader"];

  return names.map((name, index) => {
    const explicit = process.env[`ESH_PROVE_KEY_${index + 1}`];
    const privateKey =
      explicit ?? ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index + 1}`).privateKey;

    return {
      agent: new AicAgent({
        name,
        apiBaseUrl: API,
        rpcUrl: RPC,
        chainId: CHAIN_ID,
        privateKey,
        budget: {
          totalUSDC: BUDGET_PER_AGENT_USDC,
          // A quarter of the budget in one transaction is the most any single action may risk.
          maxPerTransactionUSDC: BUDGET_PER_AGENT_USDC / 4n,
          minReserveUSDC: USDC(1),
        },
        log: () => undefined,
      }),
      role: roles[index]!,
      actions: 0,
      failures: 0,
      spentUSDC: 0n,
      exhaustedAt: null,
    };
  });
}

/** Sets up a store for a seller Agent, or adopts the one it already controls. */
async function ensureStore(record: AgentRecord, index: number): Promise<void> {
  const discovery = (await fetchJson("/api/v1/discovery")) as unknown as {
    newestStores: { protocol: { storeId: string; storeController: string; components: Record<string, string> } }[];
  };
  const existing = discovery.newestStores.find(
    (s) => s.protocol.storeController.toLowerCase() === record.agent.address.toLowerCase()
  );
  if (existing) {
    record.storeId = existing.protocol.storeId;
    record.aicToken = existing.protocol.components.aicToken;
    record.licenseToken = existing.protocol.components.licenseToken;
    return;
  }

  const profile = index === 0 ? STORE_PROFILES.atlas : STORE_PROFILES.vector;
  const symbol = index === 0 ? "ATLS" : "VCTR";
  await record.agent.createStore({
    storeType: "sales",
    aicName: `${profile.name} AIC`,
    aicSymbol: symbol,
    storeName: profile.name,
  });
  await record.agent.waitForIndexer();
  await record.agent.setStoreProfile.bind(record.agent);

  const after = (await fetchJson("/api/v1/discovery")) as unknown as {
    newestStores: { protocol: { storeId: string; storeController: string; components: Record<string, string> } }[];
  };
  const mine = after.newestStores.find(
    (s) => s.protocol.storeController.toLowerCase() === record.agent.address.toLowerCase()
  );
  if (!mine) throw new Error(`${record.agent.name} created a store that did not appear in discovery`);

  record.storeId = mine.protocol.storeId;
  record.aicToken = mine.protocol.components.aicToken;
  record.licenseToken = mine.protocol.components.licenseToken;

  await record.agent.setStoreProfile(record.storeId, profile as never);
  const doc = index === 0 ? PRODUCT_DOCS["curated-embedding-corpus-v3"]! : PRODUCT_DOCS["inference-credits-1m"]!;
  const slug = index === 0 ? "curated-embedding-corpus-v3" : "inference-credits-1m";
  await record.agent.createProduct(record.storeId, {
    productId: slug,
    priceUSDC: USDC(1).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("prove-content-" + String(1))),
    inventory: "100000",
    metadataURI: JSON.stringify(doc),
    declaration: index === 0 ? { tokensSaved: "2400000", modelTier: "frontier-2025-class", basis: "MEASURED" } : null,
  });
  await record.agent.setAccessAttestor(record.storeId, record.agent.address);
}

/** One action for one Agent. Every failure is counted, never thrown. */
async function act(record: AgentRecord, all: AgentRecord[], state: RunState): Promise<void> {
  const sellers = all.filter((a) => a.role === "seller" && a.storeId);
  if (sellers.length === 0) return;
  const target = sellers[Math.floor(Math.random() * sellers.length)]!;

  try {
    const roll = Math.random();

    if (roll < 0.45) {
      // Buy a product, take delivery through the gateway, and signal.
      const slug = target === sellers[0] ? "curated-embedding-corpus-v3" : "inference-credits-1m";
      await record.agent.buy(target.storeId!, productIdFor(slug), 1);
      await record.agent.waitForIndexer();

      const licenses = (await record.agent.myLicenses()) as unknown as {
        items: { licenseToken: string; licenseId: string; signal: unknown }[];
      };
      const fresh = licenses.items.find((l) => l.licenseToken === target.licenseToken && !l.signal);
      if (fresh) {
        const lic = new Contract(
          target.licenseToken!,
          ["function recordAccessGrant(uint256)"],
          target.agent.wallet
        );
        const grant = await (await lic.recordAccessGrant!(fresh.licenseId)).wait();
        await record.agent.waitForIndexer(grant!.blockNumber);
        await record.agent.signal(target.licenseToken!, fresh.licenseId, Math.random() > 0.15);
      }
    } else if (roll < 0.8) {
      await record.agent.tradeAic(target.aicToken!, "buy", USDC(1));
    } else {
      const aic = new Contract(
        target.aicToken!,
        ["function balanceOf(address) view returns (uint256)"],
        record.agent.wallet
      );
      const held = (await aic.balanceOf!(record.agent.address)) as bigint;
      if (held > 0n) await record.agent.tradeAic(target.aicToken!, "sell", held / 5n);
    }

    record.actions += 1;
    state.actions += 1;
  } catch (error) {
    const message = String(error);
    record.failures += 1;
    state.failures += 1;

    /*
     * An Agent hitting its OWN declared budget is the system working, not a bug. Recording it as a
     * violation would mean the run could only stay "clean" by never testing the limit.
     */
    if (/Budget|budget|reserve floor|per-transaction cap/.test(message)) {
      if (!record.exhaustedAt) {
        record.exhaustedAt = new Date().toISOString();
        log(`${record.agent.name} reached its declared budget and stopped spending`, {
          spent: record.spentUSDC.toString(),
        });
      }
      return;
    }

    state.violations.push({
      at: new Date().toISOString(),
      check: `agent.${record.agent.name}.action_failed`,
      detail: message.slice(0, 300),
      severity: "hard",
    });
    state.cleanSince = new Date();
    log(`HARD violation: ${record.agent.name} action failed`, { error: message.slice(0, 160) });
  }
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

function writeReport(state: RunState, agents: AgentRecord[], finishedEarly: boolean): void {
  const endedAt = new Date();
  const totalHours = hoursBetween(state.startedAt, endedAt);
  const cleanHours = hoursBetween(state.cleanSince, endedAt);
  const hard = state.violations.filter((v) => v.severity === "hard");
  const soft = state.violations.filter((v) => v.severity === "soft");
  const passed = cleanHours >= RUN_HOURS && !finishedEarly;

  const lines: string[] = [];
  lines.push("# Live Agent proving report");
  lines.push("");
  lines.push(
    "Generated by `agents/src/prove.ts`. This records a proving run of the three Agents against a " +
      "live deployment, with continuous invariant checking of the PUBLIC API."
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`**${passed ? "PASS" : "NOT PASSED"}** — the multisig/timelock handoff gate requires ${RUN_HOURS} continuous hours with no hard violation (DECISIONS D-027).`);
  lines.push("");
  lines.push(`- run started: \`${state.startedAt.toISOString()}\``);
  lines.push(`- run ended: \`${endedAt.toISOString()}\``);
  lines.push(`- total duration: **${totalHours.toFixed(2)} h**`);
  lines.push(`- longest clean stretch ending now: **${cleanHours.toFixed(2)} h**`);
  lines.push(`- hard violations: **${hard.length}**`);
  lines.push(`- soft anomalies: **${soft.length}**`);
  lines.push(`- invariant sweeps: ${state.checkSweeps}`);
  lines.push(`- Agent actions attempted: ${state.actions + state.failures} (succeeded ${state.actions})`);
  if (finishedEarly) {
    lines.push("");
    lines.push("> The run ended before its target duration. It proves nothing about unattended operation and the clock restarts.");
  }
  lines.push("");

  lines.push("## Honest description of the activity");
  lines.push("");
  lines.push(
    "This is activity generated **between three Agents operated by the same operator**. It is not " +
      "organic demand, it is not evidence of a market, and no figure in this report should be " +
      "presented as adoption. What it demonstrates is that the system runs unattended without " +
      "breaking its own invariants. [MASTER_PLAN 0.26.C]"
  );
  lines.push("");

  lines.push("## Budgets");
  lines.push("");
  lines.push("| Agent | Role | Budget | Actions | Failures | Budget exhausted |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const a of agents) {
    lines.push(
      `| \`${a.agent.name}\` | ${a.role} | 25.00 USDC | ${a.actions} | ${a.failures} | ${a.exhaustedAt ?? "no"} |`
    );
  }
  lines.push("");
  lines.push(
    "There is no refill path in the proving harness. An Agent that reaches its declared budget " +
      "stops spending and remains a holder, which is the honest end state."
  );
  lines.push("");

  lines.push("## Violations");
  lines.push("");
  if (state.violations.length === 0) {
    lines.push("None. Every invariant held on every sweep.");
  } else {
    lines.push("| When | Severity | Check | Detail |");
    lines.push("|---|---|---|---|");
    for (const v of state.violations.slice(0, 200)) {
      lines.push(`| ${v.at} | ${v.severity} | \`${v.check}\` | ${v.detail.replace(/\|/g, "\\|")} |`);
    }
    if (state.violations.length > 200) {
      lines.push("");
      lines.push(`… and ${state.violations.length - 200} more.`);
    }
  }
  lines.push("");

  lines.push("## What was checked, continuously");
  lines.push("");
  lines.push("- indexer stays live, never stale, never degraded");
  lines.push("- holder reserve conservation: unfinalized <= accrued <= net commerce, per store");
  lines.push("- commerce conservation: net <= gross, per store");
  lines.push("- curve identity: pricing reserve == virtual seed + real reserve, per token");
  lines.push("- supply identity: current == genesis - burned, per token");
  lines.push("- no live curve reports a zero price, and none passes 30% without transitioning");
  lines.push("- buyer signals always report `economicWeight: none`");
  lines.push("- no positive rate is ever published below MIN_SIGNALS");
  lines.push("- every declaration is labelled `verified: false` with its disclaimer");
  lines.push("- seller content always carries its untrusted note");
  lines.push("- the Agent schema stays self-consistent and reachable");
  lines.push("");

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
  log(`report written to ${REPORT_PATH}`, { passed, cleanHours: cleanHours.toFixed(2) });
}

async function main(): Promise<void> {
  const state: RunState = {
    startedAt: new Date(),
    violations: [],
    cleanSince: new Date(),
    actions: 0,
    failures: 0,
    checkSweeps: 0,
    restarts: 0,
  };

  const agents = buildAgents();
  log("proving run starting", {
    agents: agents.map((a) => `${a.agent.name}:${a.agent.address}`),
    budgetEachUSDC: "25.00",
    targetHours: RUN_HOURS,
    api: API,
  });

  for (const record of agents) {
    await record.agent.verifyDeployment();
    await record.agent.onboard();
  }
  for (const [index, record] of agents.entries()) {
    if (record.role === "seller") await ensureStore(record, index);
  }
  log("agents onboarded and stores ready");

  let finishedEarly = false;
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    finishedEarly = hoursBetween(state.startedAt, new Date()) < RUN_HOURS;
    log(`received ${signal}; writing report`);
    writeReport(state, agents, finishedEarly);
    process.exit(finishedEarly ? 1 : 0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let lastCheck = 0;
  let consecutiveBackfilling = 0;

  while (hoursBetween(state.startedAt, new Date()) < RUN_HOURS && !stopping) {
    const record = agents[Math.floor(Math.random() * agents.length)]!;
    await act(record, agents, state);

    if (Date.now() - lastCheck >= CHECK_INTERVAL_MS) {
      lastCheck = Date.now();
      state.checkSweeps += 1;

      const found = await runAllChecks({ apiBaseUrl: API, fetchJson });
      for (const v of found) {
        // Sustained backfilling is a real problem; a single sweep of it after a restart is not.
        if (v.check === "indexer.backfilling") {
          consecutiveBackfilling += 1;
          if (consecutiveBackfilling < 5) continue;
          v.severity = "hard";
        }
        state.violations.push(v);
        if (v.severity === "hard") {
          state.cleanSince = new Date();
          log(`HARD violation: ${v.check}`, { detail: v.detail });
        }
      }
      if (!found.some((v) => v.check === "indexer.backfilling")) consecutiveBackfilling = 0;

      const elapsed = hoursBetween(state.startedAt, new Date());
      const clean = hoursBetween(state.cleanSince, new Date());
      log("sweep complete", {
        elapsedHours: elapsed.toFixed(2),
        cleanHours: clean.toFixed(2),
        violations: state.violations.length,
        actions: state.actions,
      });
      // A report on every sweep, so an interrupted run still leaves an accurate record.
      writeReport(state, agents, true);
    }

    await sleep(ACTION_INTERVAL_MS);
  }

  writeReport(state, agents, false);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("proving run failed:", error);
  process.exit(1);
});
