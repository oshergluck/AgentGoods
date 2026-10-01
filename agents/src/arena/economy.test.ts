import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { applyCreditDraw, creditAvailableBase, economyDebt, financingFeesBase, INITIAL_EQUITY_BASE, openStrategySlot, outstandingBase } from "./economy";
import { allocateProRata } from "./settlement";
import { ECONOMY_ACTION_CATALOG, systemPromptFor } from "./brain";
import { buildEdges, decompose, findCycles, renderEconomyReport } from "./economyReport";
import type { AgentMetrics } from "./telemetry";
import type { RunState } from "./ledger";

const U = (x: string): bigint => ethers.parseUnits(x, 6);

test("an economy run starts owing 5,300 against 5,000: equity −300, no schedule", () => {
  const d = economyDebt();
  assert.equal(d.instalments.length, 0);
  assert.equal(outstandingBase(d), U("5300"));
  assert.equal(INITIAL_EQUITY_BASE, -U("300"));
});

test("a credit draw adds principal plus a one-time 10% fee; the limit is 5,000 principal", () => {
  const d = economyDebt();
  const r1 = applyCreditDraw(d, U("2000"));
  assert.ok(r1.ok);
  assert.equal(outstandingBase(d), U("7500")); // 5300 + 2200
  assert.equal(financingFeesBase(d), U("200"));
  assert.equal(creditAvailableBase(d), U("3000"));
  const r2 = applyCreditDraw(d, U("3000.01"));
  assert.equal(r2.ok, false);
  assert.ok(applyCreditDraw(d, U("3000")).ok);
  assert.equal(creditAvailableBase(d), 0n);
  assert.equal(financingFeesBase(d), U("500"));
});

test("strategy summaries are requested at fixed minutes, one open slot at a time", () => {
  assert.equal(openStrategySlot(0), null);
  assert.equal(openStrategySlot(5), 0);
  assert.equal(openStrategySlot(60), 1);
  assert.equal(openStrategySlot(239), 4);
});

test("batch settlement allocates realizable proceeds pro rata, and the parts sum to the whole", () => {
  const rows = allocateProRata(U("4200"), [
    { agentId: "A", amount: 10n },
    { agentId: "B", amount: 20n },
    { agentId: "C", amount: 30n },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.agentId, r.share]));
  assert.equal(by.A, U("700"));
  assert.equal(by.B, U("1400"));
  assert.equal(by.C, U("2100"));
  const odd = allocateProRata(100n, [{ agentId: "A", amount: 1n }, { agentId: "B", amount: 1n }, { agentId: "C", amount: 1n }]);
  assert.equal(odd.reduce((n, r) => n + r.share, 0n), 100n);
});

test("the economy prompt and catalog carry no score, rank, race, clock, schedule or role", () => {
  const prompt = systemPromptFor("economy");
  for (const word of [/\bscore/i, /\brank/i, /\brace\b/i, /standings/i, /instalment/i, /minutes? (left|remaining)/i, /best minute/i, /nineteen/i, /leaderboard/i, /four hours/i, /agentgoods/i]) {
    assert.doesNotMatch(prompt, word, `prompt mentions ${word}`);
    assert.doesNotMatch(ECONOMY_ACTION_CATALOG, word, `catalog mentions ${word}`);
  }
  assert.match(prompt, /make money for your owner/);
  assert.match(prompt, /operating expense/i);
  assert.match(prompt, /realizable value/);
  assert.doesNotMatch(prompt, /buy products from other agents\./i);
});

function metrics(over: Partial<AgentMetrics>): AgentMetrics {
  return {
    agentId: "a01", name: "Ava", block: 1, cashBase: U("5000").toString(), liabilitiesBase: U("5300").toString(),
    creditUsedBase: "0", creditAvailableBase: U("5000").toString(), financingFeesBase: "0", repaidBase: "0",
    holdings: [], holdingsValueBase: "0", storeProceedsBase: "0", marketFeesWithdrawnBase: "0", marketFeesAccruedBase: "0",
    equityEstimateBase: (-U("300")).toString(), revenueGrossBase: "0", revenueNetBase: "0", salesCount: 0, a2aSalesBase: "0",
    externalSalesBase: "0", uniqueBuyers: 0, repeatBuyers: 0, purchasesBase: "0", purchasesCount: 0, a2aPurchasesBase: "0",
    uniqueSellers: 0, repeatSellers: 0, productsCreated: 0, productsSold: 0, storesCreated: 0, seedBase: "0", ownTokenBuysBase: "0",
    businessInvestmentBase: "0", marketingAIC: "0", marketingEstimateBase: "0", inferenceCostBase: "0", gasCostBase: "0",
    operatingProfitBase: "0", operatingCashFlowBase: "0", directTransfersInBase: "0", directTransfersOutBase: "0", trades: 0,
    tradingVolumeBase: "0", flows: [], counterparties: 0, ...over,
  };
}

test("value created decomposes into operating, token, financing and transfers with no residual", () => {
  // Borrowed 1000 (fee 100); sold products for 400 net; bought a product for 150; model 20, gas 5;
  // bought token T for 600, sold part for 300, remainder settles at 250.
  const cash = 5000 + 1000 + 400 - 150 - 600 + 300;
  const m = metrics({
    cashBase: U(String(cash)).toString(),
    liabilitiesBase: U("6400").toString(),
    creditUsedBase: U("1000").toString(),
    financingFeesBase: U("100").toString(),
    revenueNetBase: U("400").toString(),
    purchasesBase: U("150").toString(),
    inferenceCostBase: U("20").toString(),
    gasCostBase: U("5").toString(),
    holdings: [{ token: "0xt", amount: "1", exitValueBase: U("999").toString(), own: false }],
    flows: [{ token: "0xt", own: false, usdcSpentBase: U("600").toString(), usdcReceivedBase: U("300").toString(), tokensBought: "2", tokensSold: "1", trades: 2 }],
  });
  m.equityEstimateBase = (U(String(cash)) + U("250") - U("6400") - U("25")).toString();
  const d = decompose(m, { "0xt": U("250").toString() });
  assert.equal(d.operating, U("225"));
  assert.equal(d.trading, -U("50"));
  assert.equal(d.financing, -U("100"));
  assert.equal(d.residual, 0n);
  assert.equal(d.valueCreated, U("75"));
});

test("payment cycles are found, and a report renders for a run with no commerce at all", () => {
  const edges = [
    { sourceAgent: "A", targetAgent: "B" }, { sourceAgent: "B", targetAgent: "C" }, { sourceAgent: "C", targetAgent: "A" },
  ].map((e) => ({ ...e, transactionCount: 1, totalValueUSDC: "10.00", productsPurchased: [], kinds: ["purchase"], firstTransaction: "", lastTransaction: "", repeat: false }));
  const cycles = findCycles(edges, new Set(["A", "B", "C"]));
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]!.length, 3);

  const state = {
    runId: "arena-test", startedAt: new Date(0).toISOString(), endedAt: new Date(4 * 3600e3).toISOString(),
    endsAt: "", elapsedMs: 4 * 3600e3, totalRunMs: 4 * 3600e3, chainId: 84532, apiBaseUrl: "", grantUSDCBase: "0",
    agents: [{ id: "a01", name: "Ava", model: "gpt-6-luna", debt: economyDebt() } as any],
    actions: [], snapshots: [], integrityAlerts: [], economy: { researchSnapshots: [], startBlock: 1 },
  } as unknown as RunState;
  const { markdown } = renderEconomyReport({
    state, final: { a01: metrics({}) }, settlement: { freezeBlock: 9, frozenAt: "", tokens: [], allocation: {}, method: "m" },
    sales: [], purchases: [], transfers: [], productNames: {}, tokenSymbols: {}, contracts: {}, models: { "gpt-6-luna": 1 }, arenaVersion: "t",
  });
  assert.match(markdown, /No meaningful autonomous economy emerged/);
  assert.match(markdown, /## Terminal Settlement/);
  assert.equal(buildEdges(state, [], [], {}).length, 0);
});
