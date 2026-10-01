/**
 * The Catalyst is Alpha the market unchanged, bounded, and measured apart from the participants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { CATALYST_POLICY, measureMarket, renderCatalysis } from "./catalyst";
import type { RunState } from "./ledger";

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

test("the vendored tool is byte-for-byte the product in Alpha's store", () => {
  const vendored = path.join(__dirname, "vendor", "alpha-the-market.js");
  const product = path.join(__dirname, "..", "..", "..", "products", "alpha-the-market", "alpha-the-market.js");
  assert.equal(sha(vendored), sha(product));
});

test("the bounds are hard and valid under Alpha's own rules", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Alpha = require(path.join(__dirname, "vendor", "alpha-the-market.js"));
  const p = Alpha.normalizePolicy(CATALYST_POLICY);
  assert.equal(p.testSizeUSDC, 2);
  assert.ok(p.maxExposureUSDC <= p.maxLossUSDC, "exposure fits inside the loss cap");
  assert.ok(p.maxLossUSDC >= p.testSizeUSDC);
});

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), CAT = "0x" + "c".repeat(40), OP = "0x" + "d".repeat(40);
const T1 = "0x" + "1".repeat(40), T2 = "0x" + "2".repeat(40), T3 = "0x" + "3".repeat(40);

function mockApi(trades: Record<string, { at: number; side: string; trader: string; grossUSDC: string }[]>, purchases: unknown[]) {
  const rows = [
    { aicToken: T1, storeId: "s1", realUSDCReserve: { base: "5000000" }, store: { protocol: { storeController: A } } },
    { aicToken: T2, storeId: "s2", realUSDCReserve: { base: "0" }, store: { protocol: { storeController: B } } },
    { aicToken: T3, storeId: "s3", realUSDCReserve: { base: "900000000" }, store: { protocol: { storeController: OP } } },
  ];
  return (async (url: string) => {
    const u = new URL(url);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname === "/api/v1/market/tokens") return ok({ items: rows });
    const m = u.pathname.match(/^\/api\/v1\/market\/tokens\/(0x[0-9a-f]{40})\/trades$/);
    if (m) return ok({ items: trades[m[1]!] ?? [] });
    if (u.pathname === "/api/v1/market/products") return ok({ items: [] });
    if (u.pathname === "/api/v1/updates") return ok({ purchases });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("measurements keep participant investment, own-token trades and catalyst trades apart", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockApi({
    [T1]: [
      { at: 1, side: "buy", trader: A, grossUSDC: "3000000" },   // A buys its own token: not investment in others
      { at: 2, side: "buy", trader: CAT, grossUSDC: "2000000" }, // the catalyst
      { at: 3, side: "buy", trader: B, grossUSDC: "4000000" },   // B invests in A
    ],
    [T3]: [{ at: 1, side: "buy", trader: OP, grossUSDC: "900000000" }],
  }, [{ storeId: "s1", buyer: B, grossUSDC: "1" }, { storeId: "s1", buyer: A, grossUSDC: "1" }]);
  try {
    const state = { agents: [{ address: A }, { address: B }], catalysis: { wallet: CAT } } as unknown as RunState;
    const m = await measureMarket(state, "https://sim", 42);
    assert.equal(m.participantBuysOfOtherParticipantsTokens, 1);
    assert.equal(m.uniqueParticipantInvestorsInOthers, 1);
    assert.equal(m.participantCapitalIntoOthersUSDC, 4);
    assert.equal(m.catalystBuys, 1);
    assert.equal(m.participantTokenBuys, 2, "A's own-token buy and B's buy");
    assert.equal(m.crossParticipantProductPurchases, 1, "B buying from A counts; A buying its own does not");
    assert.equal(m.tokensWithRealReserve, 2);
  } finally { globalThis.fetch = realFetch; }
});

test("the report states regime A as observation and labels the interpretation", () => {
  const zero = { tokens: 3, tokensWithRealReserve: 1, participantBuysOfOtherParticipantsTokens: 0, uniqueParticipantInvestorsInOthers: 0,
    participantCapitalIntoOthersUSDC: 0, crossParticipantProductPurchases: 0, productPurchasesTotal: 0, productsSoldAtLeastOnce: 0,
    topInvestorShareOfParticipantCapital: 0 };
  const state = { agents: [], catalysis: {
    wallet: CAT, activatedAt: "t", activatedAtElapsedMs: 90 * 60_000, funding: { usdcBase: "30000000", gasWei: "0" },
    policy: CATALYST_POLICY, alpha: { realizedPnlUSDC: 0 }, cycles: 0, tokens: {}, series: [], baseline: zero,
  } } as unknown as RunState;
  const text = renderCatalysis(state);
  assert.match(text, /MARKET CATALYSIS EXPERIMENT/);
  assert.match(text, /did not originate cross-agent demand or investment before the intervention/);
  assert.match(text, /Interpretation \(not an observed internal state\)/);
  assert.doesNotMatch(text, /afraid/i);
  assert.match(text, /minute 0 to 90\.0/);
});
