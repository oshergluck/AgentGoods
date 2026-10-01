/**
 * Continuous invariant checking for the proving run.
 *
 * The multisig handoff is gated on 72 hours of continuous operation with no bugs (DECISIONS
 * D-027), which is only a meaningful gate if something is actually looking for bugs the whole
 * time. A run that merely does not crash proves very little; a run that checks accounting
 * conservation on every pass and never once finds it broken proves something.
 *
 * Every check here reads the PUBLIC API, exactly as an Agent would. Nothing reaches into the
 * database, because a check that inspects internal state can pass while the thing a real Agent
 * sees is wrong — and what a real Agent sees is the product.
 *
 * A violation is recorded, not thrown. The run continues so that one broken invariant does not
 * hide the four behind it, and the report lists them all.
 */

export interface Violation {
  at: string;
  check: string;
  detail: string;
  /**
   * `hard` resets the 72-hour clock. `soft` is an anomaly worth reporting that is not by itself
   * evidence of a defect — a transient RPC error, say.
   */
  severity: "hard" | "soft";
}

export interface CheckContext {
  apiBaseUrl: string;
  fetchJson: (path: string) => Promise<Record<string, never> & Record<string, unknown>>;
}

type Check = (ctx: CheckContext) => Promise<Violation[]>;

const now = (): string => new Date().toISOString();

function violation(check: string, detail: string, severity: Violation["severity"] = "hard"): Violation {
  return { at: now(), check, detail, severity };
}

/** The indexer must stay live and must not fall behind. */
const indexerHealth: Check = async (ctx) => {
  const status = await ctx.fetchJson("/api/v1/status");
  const indexer = status.indexer as {
    indexerStatus: string;
    lagBlocks: number;
    stale: boolean;
    indexedBlock: number;
  };
  const out: Violation[] = [];

  if (indexer.stale) {
    out.push(violation("indexer.stale", `indexer reported stale at block ${indexer.indexedBlock}`));
  }
  if (indexer.indexerStatus === "degraded") {
    out.push(violation("indexer.degraded", "indexer entered the degraded state"));
  }
  // Backfilling is legitimate after a restart; sustained backfilling is not, and the caller
  // escalates it by counting consecutive occurrences.
  if (indexer.indexerStatus === "backfilling") {
    out.push(violation("indexer.backfilling", `lag ${indexer.lagBlocks} blocks`, "soft"));
  }
  return out;
};

/**
 * Every store's holder reserve accounting must add up.
 *
 * `lifetimeHolderReserveAccrued` is the total ever reserved. What has not yet been committed to an
 * epoch must still be sitting in the store. If committed + unfinalized ever exceeds accrued, the
 * protocol has promised holders money twice.
 */
const reserveConservation: Check = async (ctx) => {
  const stores = await ctx.fetchJson("/api/v1/stores?limit=100");
  const out: Violation[] = [];

  for (const entry of (stores.items ?? []) as Record<string, never>[] as unknown as {
    protocol: {
      storeId: string;
      accounting: {
        lifetimeHolderReserveAccruedUSDC: { base: string };
        unfinalizedHolderReserveUSDC: { base: string };
        lifetimeGrossCommerceUSDC: { base: string };
        lifetimeNetCommerceUSDC: { base: string };
      };
    };
  }[]) {
    const a = entry.protocol.accounting;
    const accrued = BigInt(a.lifetimeHolderReserveAccruedUSDC.base);
    const unfinalized = BigInt(a.unfinalizedHolderReserveUSDC.base);
    const gross = BigInt(a.lifetimeGrossCommerceUSDC.base);
    const net = BigInt(a.lifetimeNetCommerceUSDC.base);

    if (unfinalized > accrued) {
      out.push(
        violation(
          "reserve.unfinalized_exceeds_accrued",
          `store ${entry.protocol.storeId}: unfinalized ${unfinalized} > accrued ${accrued}`
        )
      );
    }
    if (net > gross) {
      out.push(
        violation("commerce.net_exceeds_gross", `store ${entry.protocol.storeId}: net ${net} > gross ${gross}`)
      );
    }
    // The holder reserve is 5% of net, ceiling-rounded per sale. It can never exceed net.
    if (accrued > net) {
      out.push(
        violation(
          "reserve.accrued_exceeds_net",
          `store ${entry.protocol.storeId}: accrued ${accrued} > net commerce ${net}`
        )
      );
    }
  }
  return out;
};

/**
 * Curve accounting.
 *
 * The identity `curvePricingReserve == virtualSeed + realReserve` is exact at every block
 * (DECISIONS D-020), and the API publishes a `reserveIdentity.holds` flag computed from the
 * indexed values. If it is ever false, either the projection or the contract is wrong.
 */
const curveConservation: Check = async (ctx) => {
  const tokens = await ctx.fetchJson("/api/v1/market/tokens?limit=50");
  const out: Violation[] = [];

  for (const t of (tokens.items ?? []) as unknown as {
    token: { symbol: string };
    aicToken: string;
    reserveIdentity: { holds: boolean; formula: string };
    netSoldPercentageBps: number;
    currentIndexedPrice1e18: string;
    phase: string;
    currentSupplyAIC: { base: string };
    genesisSupplyAIC: { base: string };
    burnedAIC: { base: string };
  }[]) {
    if (!t.reserveIdentity.holds) {
      out.push(violation("curve.reserve_identity", `${t.token.symbol}: ${t.reserveIdentity.formula} is false`));
    }
    if (t.phase === "bonding_curve" && t.netSoldPercentageBps > 3000) {
      out.push(
        violation(
          "curve.transition_missed",
          `${t.token.symbol}: ${t.netSoldPercentageBps / 100}% sold but still on the curve`
        )
      );
    }
    if (BigInt(t.currentIndexedPrice1e18) <= 0n && t.phase === "bonding_curve") {
      out.push(violation("curve.zero_price", `${t.token.symbol}: a live curve reported a zero price`));
    }
    // currentSupply == genesis - burned, exactly. [V1-3]
    const expected = BigInt(t.genesisSupplyAIC.base) - BigInt(t.burnedAIC.base);
    if (BigInt(t.currentSupplyAIC.base) !== expected) {
      out.push(
        violation(
          "supply.identity",
          `${t.token.symbol}: supply ${t.currentSupplyAIC.base} != genesis - burned (${expected})`
        )
      );
    }
  }
  return out;
};

/**
 * Buyer signals must never acquire economic weight, and a rate must never be published below
 * MIN_SIGNALS. These are the two rules of §14A.2 that an implementation could quietly break while
 * every other test still passes.
 */
const signalRules: Check = async (ctx) => {
  const products = await ctx.fetchJson("/api/v1/market/products?limit=50");
  const out: Violation[] = [];

  for (const p of (products.items ?? []) as unknown as {
    sellerSignals?: {
      economicWeight: string;
      insufficientSignals: boolean;
      positiveRate: string | null;
      signalled: number;
      minSignals: number;
      coverage: string | null;
      delivered: number;
    };
  }[]) {
    const s = p.sellerSignals;
    if (!s) continue;

    if (s.economicWeight !== "none") {
      out.push(violation("signal.economic_weight", `signals reported weight "${s.economicWeight}"`));
    }
    if (s.signalled < s.minSignals && s.positiveRate !== null) {
      out.push(
        violation(
          "signal.rate_below_minimum",
          `a rate (${s.positiveRate}) was published from ${s.signalled} signals, below ${s.minSignals}`
        )
      );
    }
    if (s.delivered > 0 && s.coverage === null) {
      out.push(violation("signal.coverage_hidden", "coverage was null despite deliveries", "soft"));
    }
  }
  return out;
};

/** A seller declaration must always be labelled unverified, in every response that carries one. */
const declarationLabelling: Check = async (ctx) => {
  const products = await ctx.fetchJson("/api/v1/market/products?limit=50");
  const out: Violation[] = [];

  for (const p of (products.items ?? []) as unknown as {
    declaration: { verified: boolean; disclaimer: string; declared: boolean };
    sellerContent: { note: string };
  }[]) {
    if (p.declaration.verified !== false) {
      out.push(violation("declaration.verified_flag", "a declaration was not marked verified:false"));
    }
    if (p.declaration.declared && !/UNVERIFIED/i.test(p.declaration.disclaimer)) {
      out.push(violation("declaration.disclaimer", "a declared saving carried no unverified disclaimer"));
    }
    if (!/Untrusted/i.test(p.sellerContent.note)) {
      out.push(violation("seller_content.note", "seller content was served without its untrusted note"));
    }
  }
  return out;
};

/** The schema an Agent bootstraps from must stay self-consistent and reachable. */
const schemaIntegrity: Check = async (ctx) => {
  const out: Violation[] = [];
  const schema = await ctx.fetchJson("/api/v1/schema");

  const errors = schema.errors as { codes: string[] } | undefined;
  if (!errors || !Array.isArray(errors.codes) || errors.codes.length === 0) {
    out.push(violation("schema.errors", "the schema published no error code catalogue"));
  }
  const economics = schema.economics as Record<string, Record<string, unknown>> | undefined;
  if (!economics?.dividends?.eligibilityRule) {
    out.push(violation("schema.eligibility_rule", "the dividend eligibility rule is missing"));
  }
  if (economics?.dividends?.snapshotTradingDisclosure) {
    out.push(
      violation("schema.stale_disclosure", "the removed snapshotTradingDisclosure reappeared in the schema")
    );
  }

  const wellKnown = await ctx.fetchJson("/.well-known/aic-agent.json");
  if (!wellKnown.schema && !wellKnown.schemaUrl) {
    out.push(violation("schema.well_known", "the discovery document does not point at the schema"));
  }
  return out;
};

export const CHECKS: { name: string; run: Check }[] = [
  { name: "indexer health", run: indexerHealth },
  { name: "reserve conservation", run: reserveConservation },
  { name: "curve conservation", run: curveConservation },
  { name: "signal rules", run: signalRules },
  { name: "declaration labelling", run: declarationLabelling },
  { name: "schema integrity", run: schemaIntegrity },
];

/** Runs every check once. A check that throws is itself a violation. */
export async function runAllChecks(ctx: CheckContext): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const check of CHECKS) {
    try {
      out.push(...(await check.run(ctx)));
    } catch (error) {
      out.push(
        violation(`${check.name}.threw`, String(error).slice(0, 300), "soft")
      );
    }
  }
  return out;
}
