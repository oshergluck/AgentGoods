#!/usr/bin/env tsx
/**
 * The arena: 20 autonomous Agents, one wallet each, four hours, 1,500 USDC of stake apiece.
 *
 *     tsx agents/src/arena/arena.ts start --minutes 240 --agents 16
 *     tsx agents/src/arena/arena.ts score --run <runId>
 *
 * Each Agent is given one piece of information — the origin — and must discover everything else.
 * It asks the operator for its stake by signing a request, and from then on it is on its own: it
 * reads the market, decides, acts, and is measured on what its portfolio is worth at the end.
 *
 * Three rules make the result mean something:
 *
 *  - **One wallet per Agent, enforced by the grant ledger.** The faucet funds a wallet once, ever,
 *    and the record survives a restart.
 *  - **Self-minting is fatal.** MockUSDC has an open mint on this testnet, so prevention is
 *    impossible; detection is not. Every mint is reconciled against the grant ledger and anything
 *    unaccounted for kills that Agent mid-run.
 *  - **Positions are valued at their real exit price**, from a live sell quote, so an illiquid
 *    holding cannot be marked as though it could be sold at spot.
 *
 * The run is crash-tolerant: state is on disk, so `start --run <id>` resumes rather than
 * re-funding.
 */

import { ENV_SCORING, qualifies, scoringModeOf } from "./scoring";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Contract, ethers, JsonRpcProvider, Wallet } from "ethers";
import { ArenaAgent, ResumeInconsistency } from "./agent";
import { abortRun, idle, preflightAfterFunding, preflightBeforeFunding } from "./preflight";
import { storageFor } from "./storage";
import { Brain } from "./brain";
import { Faucet } from "./faucet";
import { runBorrowDesk } from "./borrowdesk";
import { resetSandbox, sandboxFileCount, SANDBOX_ROOT } from "./sandbox";
import { startCommentators } from "./commentators";
import { ARENA_DIR, MODEL_PRICES, loadRun, saveRun, type AgentRecord, type RunState } from "./ledger";
import { buildSchedule, debtStatus, GRACE_MS } from "./debt";
import { rankScoreBase, recordMinuteSamples, renderLeaderboard, snapshotAll } from "./score";
import { DEBT_TOTAL_USDC } from "./debt";
import { ensureCatalyst, renderCatalysis, runCatalyst } from "./catalyst";
import { renderReport } from "./report";
import { usageSummary } from "./usage";
import { isEconomy } from "./scoring";
import {
  assignOwnerGoals,
  economyDebt,
  missedOwnerRequest,
  OWNER_MAX_USDC,
  OWNER_MIN_USDC,
  OWNER_WINDOW_MS,
  ownerCapitals,
  ownerDebt,
  ownerPlanHash,
  ownerRequests,
  RESEARCH_SNAPSHOT_MINUTES,
  usd,
} from "./economy";
import { agentPurchases, agentStoreSales, computeMetrics, directTransfers, type TelemetryInput } from "./telemetry";
import { settleAtFreeze } from "./settlement";
import { renderEconomyReport } from "./economyReport";
import { allAicTokens } from "./score";
import { compactValue, EventLog, readEvents, safeLine } from "./events";
import { backfillEvents, emitAgentRecordEvents, emitChainEvents, loadArtifacts, setEventLog } from "./arenaEvents";
import { holdingsAt } from "./telemetry";
import { siteTelemetry } from "./siteTelemetry";
import { renderOwnerReport } from "./ownerReport";

const HERE = __dirname;
const REPO = path.resolve(HERE, "..", "..", "..");

/* ------------------------------------------------------------------ config */

/*
 * THE TEST NETWORK, and it must stay the default.
 *
 * This read `https://agentgoods.ai` — the PRODUCTION deployment on Base mainnet, with real USDC.
 * Pointed there, the arena hands twenty autonomous agents a grant of real money, scores them
 * against a chain nobody is watching for this run, and there is no undo on any of it. It was the
 * default because the arena predated the mainnet deployment and the constant was never revisited
 * when the domain became real.
 *
 * Overridable, because there are legitimate reasons to point it elsewhere (a local stack, a
 * staging host), but the override has to be typed. The assertion in `start()` is the real
 * protection: whatever this resolves to, the run refuses to begin unless the chain behind it is
 * a test chain.
 */
const ORIGIN = process.env.ARENA_ORIGIN ?? "https://testnet.agentgoods.ai";

/** Chains this experiment is allowed to touch. Base Sepolia and local development only. */
const ALLOWED_CHAIN_IDS = new Set([84532, 31337, 1337]);

/**
 * The models in play.
 *
 * TWO MODELS, BY BUDGET DECISION, AND THE RESULTS MUST SAY SO.
 *
 * `gpt-5-mini` and `gpt-5-nano`, and nothing else. This is not a claim that these are the right
 * models, the best models, or a representative sample — it is a spending limit. Earlier runs put
 * ten models across twenty agents spanning a 200x price range, and the two most expensive
 * consumed 37% of the entire inference budget between four agents, which is a poor trade when the
 * question is about BEHAVIOUR rather than capability.
 *
 * What this costs the experiment, stated plainly because a reader will otherwise assume otherwise:
 * nothing observed here supports any comparison between model families, any ranking, or any claim
 * that a result would or would not hold on a larger model. Ten agents per model is a description
 * of what these two did under these conditions, and the published results say exactly that.
 *
 * The price spread that remains is real and still gives the market something to trade: nano's
 * output is 5x cheaper than mini's, so a nano agent can rationally sell work to a mini agent that
 * would rather buy than derive. A market where every participant has the same capability at the
 * same price has nothing to trade at all.
 *
 * Overridable with ARENA_MODELS so a run can be re-scoped without editing this file:
 *
 *     ARENA_MODELS="gpt-5-nano,gpt-5-mini"
 */
const MODEL_ROSTER = process.env.ARENA_MODELS
  ? process.env.ARENA_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
  : ["gpt-5-mini", "gpt-5-nano"];
/**
 * Where in AGENT_NAMES this run's field starts.
 *
 * Only ever non-zero when a second cohort is being added to a market that is already running, so
 * that its agents take the next unused names rather than duplicating the ones already trading.
 */
const NAME_OFFSET = Number(process.env.ARENA_NAME_OFFSET ?? 0);
/*
 * Ids index the executor containers (a01..a20 in ARENA_EXECUTOR_MAP), names are what the market sees.
 * A new cohort entering a live market needs new NAMES but the same containers, so the id offset can be
 * set apart from the name offset. Defaults to the name offset, so existing launches are unchanged.
 */
const ID_OFFSET = Number(process.env.ARENA_ID_OFFSET ?? NAME_OFFSET);

const GRANT_USDC = ethers.parseUnits(process.env.ARENA_GRANT_USDC ?? "1500", 6);
/*
 * Owner-capital economy run (Arena 13): each agent gets its own capital (2,000-10,000 USDC), no debt and no
 * credit, and its owner asks for all of it back in 10-15 unannounced requests, each payable within 10
 * minutes. ARENA_OWNER_SEED fixes the draw (default: the run id); the committed plan is in the ledger.
 */
const OWNER_CAPITAL = process.env.ARENA_OWNER_CAPITAL === "1" && (process.env.ARENA_SCORING ?? "") === "economy";
let OWNER_SEED = process.env.ARENA_OWNER_SEED ?? "";
const OWNER_GOALS_ON = OWNER_CAPITAL && process.env.ARENA_OWNER_GOALS === "1";
/*
 * Gas, and it IS a constraint now. This changed, and the old comment was wrong.
 *
 * The previous default granted 0.004 ETH per agent, which is 0.08 ETH for a field of twenty. The
 * operator holds a fifth of that, there is no testnet faucet in reach, and the old preflight only
 * WARNED about a shortfall — so the honest description of the previous configuration is that it
 * would have funded the first few agents and left the rest unable to transact, in a run whose
 * results would then have been reported as behaviour.
 *
 * The real budget is what the operator actually has, and it is not replenishable. So:
 *
 *   - the grant is sized to fit twenty agents out of the real balance, not to a round number;
 *   - the top-up reserve is deliberately thin, because there is nothing to top up FROM;
 *   - the run REFUSES TO START if the operator cannot fund the whole field (see the preflight),
 *     because a partially funded field is not a cheaper experiment, it is a broken one;
 *   - every agent is told its tank is finite and roughly how many transactions it holds.
 *
 * At the measured 0.006 gwei a typical 300k-gas protocol transaction costs ~0.0000018 ETH, so
 * 0.0018 ETH is on the order of a thousand transactions per agent — ample for 240 minutes, and
 * still ~100 if gas spikes tenfold. Ample is not unlimited, and agents are no longer told it is.
 *
 * Generosity here does not distort the score: gas is charged as granted-minus-remaining, so an
 * Agent pays for what it burns and nothing for what it was handed.
 */
const GRANT_GAS = ethers.parseEther(process.env.ARENA_GRANT_GAS ?? "0.0018");
const GAS_FLOOR = ethers.parseEther(process.env.ARENA_GAS_FLOOR ?? "0.0003");
const GAS_TOPUP = ethers.parseEther(process.env.ARENA_GAS_TOPUP ?? "0.0002");
/**
 * The pause between one Agent's turns. Not a turn order — there isn't one.
 *
 * Every Agent already runs as its own concurrent loop; they have never taken it in turns. But a
 * 75-second pause made each one so slow that the market behaved as though they did: an Agent
 * posted to the forum and the reply came a minute and a quarter later, a price moved and nobody
 * responded for another minute, and a ten-minute grace window was only about eight opportunities
 * to act. The pacing was imposed to protect rate limits, and it ended up defining the market's
 * tempo.
 *
 * At five seconds an Agent's next turn begins almost as soon as its last one finished, so twenty
 * of them are genuinely acting at once: negotiation happens inside a conversation rather than
 * across one, and a shortfall can be covered by actually going and selling something.
 *
 * Two costs are real and worth stating. Rate limits are now absorbed by the retry on transient
 * failures rather than by waiting. And thinking is charged against P&L at each model's published
 * rate, so more turns means a materially larger cost of production — which is not a distortion:
 * an agent that thinks constantly SHOULD pay for it, and choosing when not to think is now a
 * genuine decision rather than one the harness made on everyone's behalf.
 */
const TURN_SECONDS = Number(process.env.ARENA_TURN_SECONDS ?? 5);

/**
 * A fair coin between "low" and "medium", per Agent.
 *
 * Operator's choice: instead of one effort for the field, each Agent draws its own, so the run
 * can see whether thinking harder — and paying for it — buys anything against agents that do not.
 * ARENA_REASONING_EFFORT still pins the whole field to one value when set explicitly.
 */
function drawReasoningEffort(): "low" | "medium" {
  const pinned = process.env.ARENA_REASONING_EFFORT;
  if (pinned === "low" || pinned === "medium") return pinned;
  // A neutral (economy) run gives every agent the same conditions: one effort for all, never a draw.
  if ((process.env.ARENA_SCORING ?? "") === "economy") return "medium";
  return Math.random() < 0.5 ? "low" : "medium";
}

/**
 * Names, not job titles.
 *
 * Agents used to be called Toolsmith-01, Investor-14, MarketMaker-03, and each was handed a
 * mission to match: build tools, buy equity, trade the curve. That produced exactly what it
 * described. Every Investor bought and held, every Merchant listed products, and the run measured
 * how well five predetermined strategies execute rather than which strategy an autonomous agent
 * arrives at. The top four finishers were all Investors, which reads as a finding about investing
 * and is really a finding about the label we gave them.
 *
 * So there are no roles now. Twenty identical mandates, twenty different models, one market, and
 * whatever anyone decides to be. An Agent that ends up selling tools did that because it judged
 * selling tools to be the best available move — which is the only version of that observation
 * worth having.
 *
 * Human names because a name should carry no instruction. "Toolsmith-01" tells an Agent what it
 * is for every time it reads its own name, and tells the other nineteen what to expect from it.
 * "Mira" tells them nothing, which is the point: reputation here has to be earned through the
 * ledger rather than issued with the identity.
 */
const AGENT_NAMES = [
  "Ava", "Ben", "Chen", "Dara", "Eli",
  "Farah", "Gita", "Hugo", "Iris", "Jonas",
  "Kaia", "Liam", "Mira", "Noah", "Omar",
  "Priya", "Quinn", "Rosa", "Sami", "Tara",
  // Eleven more, so a field of thirty-one has thirty-one distinct names: buyers identify sellers
  // by name on the forum, and the roster wrapping back to "Ava" would put two Avas in one market.
  "Uma", "Vik", "Wren", "Xia", "Yara", "Zane", "Aria", "Bo", "Cleo", "Dev", "Esme",
  // Nine more, so a second cohort of twenty (offset 20) has names no earlier agent used.
  "Finn", "Gabe", "Hana", "Ivo", "Jade", "Kian", "Lena", "Milo", "Nia",
];

/**
 * The single mandate, identical for everyone.
 *
 * It says what is being measured and what the constraints are, and deliberately does not say what
 * to do about them. Naming a strategy here would reintroduce the archetypes through the back door.
 */
const MANDATE =
  "You have no assigned role. Nobody has told you to be a seller, a buyer, a trader or an " +
  "investor, and no such role exists in this market — those are just things an agent might " +
  "decide to do. Twenty agents were given the same mandate you were, the same market and the " +
  "same tools, and each is working out for itself what to do with them. What you do is entirely " +
  "your decision, you may change your mind at any time, and you will be measured only on the " +
  "money, against the other nineteen. " +
  /*
   * There are now TWO live deployments, and an agent can reach both.
   *
   * The protocol runs on Base Sepolia (this one) and on Base mainnet, and the schema tells every
   * agent about both because a real participant needs to know where to practise. That is correct
   * for the protocol and a hazard for this run: an agent that wanders onto mainnet is spending
   * the operator's real USDC, its work there is invisible to a scorer reading the testnet, and
   * its position cannot be counted. It has to be told, in the mandate, not left to infer it.
   */
  "WHICH NETWORK YOU ARE ON: Base Sepolia, the TEST network, and the USDC here is mock USDC with " +
  "no real value. You will see the production deployment at https://agentgoods.ai mentioned in " +
  "the protocol documents. DO NOT GO THERE AND DO NOT TRANSACT THERE. It uses real money that is " +
  "not yours, nothing you do there is counted, and every position you open there is one you " +
  "cannot be credited for. You are measured on THIS network only. Use the API base URL you were " +
  "given and no other host.";

/*
 * Stdout is a debugging view behind a rate-limited sink (Railway: 500 lines/s per replica; Arena 4
 * lost 5,116 messages). Every line is flattened to ONE line — each newline was a separate message —
 * and capped; data objects are compacted before they are serialised. The authoritative record is the
 * Arena Event Log (events.ts) and the ledger, never this.
 */
const log = (message: string, data?: Record<string, unknown>): void => {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(safeLine(`${stamp} ${message}${data ? " " + JSON.stringify(compactValue(data)) : ""}`));
};

/* ------------------------------------------------------------------- setup */

/**
 * Read one value out of a dotenv file without pulling in a dependency or mutating the
 * environment. Secrets are read at the moment they are needed and never logged.
 */
function readEnvFile(file: string, key: string): string | null {
  if (!fs.existsSync(file)) return null;
  // Split on a regex so a CRLF file (this is Windows) parses the same as a LF one.
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return null;
  const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : null;
}

/** The operator's key. It signs grants and nothing else; it is never handed to an Agent. */
function readOperatorKey(): string {
  const found =
    process.env.DEPLOYER_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    readEnvFile(path.join(REPO, "contracts", ".env"), "DEPLOYER_PRIVATE_KEY") ??
    readEnvFile(path.join(REPO, "contracts", ".env"), "PRIVATE_KEY");
  if (!found) throw new Error("operator key not found (DEPLOYER_PRIVATE_KEY in env or contracts/.env)");
  return found;
}

function resolveRpcUrl(): string {
  return (
    process.env.ARENA_RPC_URL ??
    process.env.RPC_HTTP_URL ??
    readEnvFile(path.join(REPO, "contracts", ".env"), "BASE_SEPOLIA_RPC_URL") ??
    readEnvFile(path.join(REPO, "backend", ".env"), "RPC_HTTP_URL") ??
    "https://sepolia.base.org"
  );
}

function readOpenAIKey(): string {
  const direct = process.env.OPENAI_API_KEY;
  if (direct) return direct;
  const envPath = path.join(REPO, "backend", ".env");
  if (fs.existsSync(envPath)) {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("OPENAI_API_KEY="));
    if (line) return line.slice("OPENAI_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("OPENAI_API_KEY not found in the environment or backend/.env");
}

/** The canonical USDC address, learned from the protocol rather than hard-coded. */
/**
 * The external DEX router, read from the protocol's own catalogue.
 *
 * Returns an empty string when it cannot be read: valuation then falls back to the curve, which
 * is wrong for graduated markets but never worse than crashing the scoring pass.
 */
async function discoverDexRouter(apiBaseUrl: string): Promise<string> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/v1/contracts`, { headers: { accept: "application/json" } });
    if (!res.ok) return "";
    const body = (await res.json()) as {
      core?: { externalDex?: { router?: { address?: string } | string } };
    };
    const entry = body.core?.externalDex?.router;
    return String((typeof entry === "object" && entry !== null ? entry.address : entry) ?? "");
  } catch {
    return "";
  }
}

async function discoverAgentGoods(apiBaseUrl: string): Promise<string> {
  const res = await fetch(`${apiBaseUrl}/api/v1/contracts`, { headers: { accept: "application/json" } });
  const body = (await res.json()) as Record<string, any>;
  const address = body.core?.agentGoods?.proxy;
  if (!ethers.isAddress(address)) throw new Error("could not learn the AgentGoods address");
  return address;
}

async function discoverUsdc(apiBaseUrl: string): Promise<string> {
  const res = await fetch(`${apiBaseUrl}/api/v1/contracts`, { headers: { accept: "application/json" } });
  const body = (await res.json()) as Record<string, any>;
  const address = body.core?.canonicalUSDC?.address;
  if (!ethers.isAddress(address)) throw new Error("could not learn the canonical USDC address");
  return address;
}

/** The newest run on disk, or null when there has never been one. */
function latestRunId(): string | null {
  if (!fs.existsSync(ARENA_DIR)) return null;
  const runs = fs
    .readdirSync(ARENA_DIR)
    .filter((f) => /^arena-\d+\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(ARENA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return runs.length > 0 ? runs[0]!.f.replace(/\.json$/, "") : null;
}

/**
 * Decide which run this process is: a continuation, or a genuinely new one.
 *
 * Every branch announces itself. Creating twenty new wallets is an expensive, irreversible act —
 * it abandons the stores, licences and positions the previous agents built — and it should never
 * happen because an argument was spelled differently than a filename.
 */
function resolveRun(
  requested: string | undefined,
  count: number,
  minutes: number,
  chainId: number,
  apiBaseUrl: string,
  log: (line: string, meta?: Record<string, unknown>) => void
): { state: RunState; isNewRun: boolean } {
  if (requested === "fresh") {
    log("starting a NEW run: new wallets, new grants, nothing carried over (--run fresh)");
    return { state: createRun(count, minutes, chainId, apiBaseUrl), isNewRun: true };
  }

  if (requested && requested !== "latest") {
    const exact = loadRun(requested);
    if (exact) {
      log(`resuming ${requested} — same wallets, same keys, no new grants`);
      return { state: exact, isNewRun: false };
    }
    log(`no run called "${requested}" — looking for the most recent one instead`);
  }

  const latest = latestRunId();
  const resumed = latest ? loadRun(latest) : null;
  if (resumed) {
    log(`resuming ${latest} — ${resumed.agents.length} agents keep their wallets, keys and grants`);
    return { state: resumed, isNewRun: false };
  }

  log("no previous run found — starting the first one");
  return { state: createRun(count, minutes, chainId, apiBaseUrl), isNewRun: true };
}

function createRun(count: number, minutes: number, chainId: number, apiBaseUrl: string): RunState {
  const runId = `arena-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}`;
  if (OWNER_CAPITAL && !OWNER_SEED) OWNER_SEED = runId;
  const agents: AgentRecord[] = [];

  const ownerCaps = OWNER_CAPITAL ? ownerCapitals(count, OWNER_SEED) : [];
  for (let i = 0; i < count; i++) {
    /*
     * One wallet per Agent, generated here and never reused. Random rather than derived from a
     * shared mnemonic: a mnemonic makes every wallet recoverable from one secret, and there is no
     * reason for these to be linkable.
     */
    const wallet = Wallet.createRandom();
    agents.push({
      /*
       * The offset exists so a SECOND cohort joining a live market cannot collide with the names
       * and ids already trading in it. Two agents called Ava posting in one forum is not a cosmetic
       * problem: every agent reads that forum, and buyers identify sellers by name.
       *
       * Default 0, so an ordinary run is unaffected.
       */
      id: `a${String(i + 1 + ID_OFFSET).padStart(2, "0")}`,
      name: AGENT_NAMES[(i + NAME_OFFSET) % AGENT_NAMES.length]!,
      archetype: MANDATE,
      address: wallet.address,
      privateKey: wallet.privateKey,
      grant: null,
      storeId: null,
      aicToken: null,
      storeAddress: null,
      stores: [],
      disqualified: null,
      /*
       * Its own table, drawn now and never drawn again. The instalment count varies per Agent
       * (10..30) while the total does not, so the shape of the obligation differs and its size
       * never does.
       */
      // An economy run owes 5,300 with no schedule; the scored arenas keep their instalment tables.
      debt: ENV_SCORING === "economy" ? economyDebt() : buildSchedule(minutes * 60_000),
      ...(OWNER_CAPITAL ? { capitalBase: ownerCaps[i]!.toString() } : {}),
      memory: [],
      tokensUsed: { input: 0, output: 0 },
      library: [],
      /*
       * A plain walk of the roster: with two models and twenty agents, ten agents each.
       *
       * This once walked in strides of two (`(i * 2 + 1) % 10`), which visits only the odd
       * indices — so half the roster never ran at all while every report implied it had. A plain
       * walk cannot do that for any roster size, which is why it stays a plain walk.
       *
       * With roles removed, the model is the ONLY assigned difference between agents, so this
       * line is the entire comparison the run can make. Ten agents per model is enough to tell a
       * pattern from one agent's luck, and not remotely enough to rank model families — see the
       * roster comment above for what the results are therefore forbidden to claim.
       */
      model: MODEL_ROSTER[i % MODEL_ROSTER.length]!,
      tokenPrice: MODEL_PRICES[MODEL_ROSTER[i % MODEL_ROSTER.length]!]!,
      reasoningEffort: drawReasoningEffort(),
    });
  }

  /*
   * Owner capital: each agent's own amount and its owner's requests, drawn from one seed BEFORE the run
   * and committed by hash. Nothing later can change them.
   */
  let ownerCapital: import("./economy").OwnerCapitalPlan | undefined;
  if (OWNER_CAPITAL) {
    // Owner goals: one per agent, none repeated, drawn from the same seed (ARENA_OWNER_GOALS=1).
    const goals = OWNER_GOALS_ON ? assignOwnerGoals(agents.length, OWNER_SEED) : [];
    const rows = agents.map((a, i) => {
      const requests = ownerRequests(ownerCaps[i]!, OWNER_SEED, a.id, minutes * 60_000);
      a.debt = ownerDebt(ownerCaps[i]!, requests);
      if (goals[i]) a.ownerGoal = goals[i];
      return { agentId: a.id, capitalBase: ownerCaps[i]!.toString(), requests, ...(goals[i] ? { goal: goals[i] } : {}) };
    });
    ownerCapital = {
      seed: OWNER_SEED,
      planHash: ownerPlanHash(rows),
      minUSDC: OWNER_MIN_USDC,
      maxUSDC: OWNER_MAX_USDC,
      windowMinutes: OWNER_WINDOW_MS / 60_000,
      generatedAt: new Date().toISOString(),
    };
  }

  const now = Date.now();
  return {
    runId,
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + minutes * 60_000).toISOString(),
    elapsedMs: 0,
    totalRunMs: minutes * 60_000,
    chainId,
    apiBaseUrl,
    grantUSDCBase: GRANT_USDC.toString(),
    ...(ownerCapital ? { ownerCapital } : {}),
    agents,
    actions: [],
    snapshots: [],
    integrityAlerts: [],
    forum: [],
  };
}

/* -------------------------------------------------------------------- main */

const RPC_URL = resolveRpcUrl();

async function start(minutes: number, count: number, resumeId?: string): Promise<void> {
  log(`arena starting — origin ${ORIGIN}, models ${MODEL_ROSTER.join(", ")}`);

  // Discovery first. If an Agent could not bootstrap, neither can the arena.
  const manifestRes = await fetch(`${ORIGIN}/.well-known/aic-agent.json`, {
    headers: { accept: "application/json" },
  });
  if (!manifestRes.ok) throw new Error(`discovery failed: ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as Record<string, any>;
  const apiBaseUrl = String(manifest.apiBaseUrl ?? ORIGIN);
  const chainId = Number(manifest.chain?.chainId ?? manifest.chainId);
  /*
   * Refuse to run anywhere that spends real money.
   *
   * Checked against the CHAIN the discovery document reports, not against the hostname: a host can
   * be renamed, proxied or mistyped, and the only thing that actually determines whether the USDC
   * is real is the chain id. An arena that starts on mainnet cannot be undone, so this fails
   * closed and says exactly what it found.
   */
  if (!ALLOWED_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `REFUSING TO START: ${ORIGIN} resolves to chain ${chainId}, which is not a test chain. ` +
        `This experiment grants agents USDC and scores them; on a production chain that is real ` +
        `money and cannot be reversed. Allowed: ${[...ALLOWED_CHAIN_IDS].join(", ")}. ` +
        `Set ARENA_ORIGIN to a test deployment.`
    );
  }

  const usdcAddress = await discoverUsdc(apiBaseUrl);
  const agentGoodsAddress = await discoverAgentGoods(apiBaseUrl);
  // The pool, so a graduated position is not scored at the curve's zero.
  const dexRouter = await discoverDexRouter(apiBaseUrl);
  log(`discovered chain ${chainId}, api ${apiBaseUrl}, usdc ${usdcAddress}`);

  /*
   * Resume the run that exists, rather than silently starting a new one.
   *
   * `--run <id>` only resumed when the id matched a file exactly, and a label that did not match
   * fell through to createRun WITHOUT SAYING SO — which minted twenty fresh wallets and cost a
   * full round of grants, about 0.08 ETH, every single restart. The failure was invisible
   * precisely because starting over looks identical to starting up.
   *
   * So a name that does not resolve now falls back to the most recent run and says which one it
   * picked, `latest` asks for that explicitly, and `--fresh` is the way to deliberately start
   * over. Agents keep their wallets, their grants, their stores and their API keys.
   */
  const { state, isNewRun } = resolveRun(resumeId, count, minutes, chainId, apiBaseUrl, log);
  const ledgerLastWrittenAt = isNewRun ? null : (() => {
    try {
      return fs.statSync(path.join(ARENA_DIR, `${state.runId}.json`)).mtime.toISOString();
    } catch {
      return null;
    }
  })();
  /* The advert schedule this run actually uses, stated once in the log so the record shows it. */
  {
    const every = Number(process.env.ARENA_ADVERT_EVERY_MINUTES ?? 0);
    log(
      every > 0
        ? `ADVERT MODE: the same advert every ${every} minutes (PERIODIC_n due at running minute n*${every}), first on each agent's first observation`
        : "ADVERT MODE: twice — on each agent's first observation, and at the top of the final hour"
    );
  }
  /* An aborted run is never continued. Starting over means a new ledger, by the operator's hand. */
  if (state.aborted) {
    log(`${state.runId} was ABORTED at ${state.aborted.at}: ${state.aborted.reason}. It will not be resumed. Idle.`);
    await idle();
  }

  /*
   * Resuming CONTINUES the clock. It does not restart it, and it must never rebuild a debt table.
   *
   * This used to reset `startedAt` and `endsAt` on every resume, on the reasoning that a resume
   * after a correction starts a fresh measurement. That was already questionable — it meant a
   * restart silently handed the field another four hours, and several "four-hour" runs were
   * considerably longer. With a repayment schedule it becomes actively destructive, in two
   * distinct ways:
   *
   *   - The table is anchored to time-into-the-run. Restarting the clock moves instalment 7 back
   *     to where instalment 1 was, so an Agent is billed again for payments it has already made
   *     and the totals no longer reconcile against 1600.
   *   - An Agent's remaining runway is the basis of every plan it has made. Silently extending it
   *     rewards whoever happened to be illiquid at the moment of the restart, which is noise.
   *
   * So the run is measured in RUNNING time, accumulated across restarts, and the schedule is
   * built once at creation. A restart costs the Agents nothing and gains them nothing: the clock
   * picks up exactly where it stopped, and time spent stopped is not time they were given.
   */
  const segmentStartedAt = Date.now();
  /*
   * The elapsed base is captured ONCE, as a value, and never re-read from the state it writes to.
   *
   * This read `state.elapsedMs` live, while the supervisor periodically persisted `elapsedNow()`
   * back into that same field. Nothing reset the segment start, so every persist folded the
   * current segment into the base and the next call added it again: the clock compounded, roughly
   * doubling each time it was saved.
   *
   * It killed five agents thirteen real minutes into a four-hour run, for missing instalments
   * that had not yet fallen due — one of them four minutes after it had paid. The schedule was
   * correct and the enforcement was correct; the clock they were both read against was not.
   *
   * Capturing the base as a const makes the write harmless: `state.elapsedMs` becomes an output
   * of this function rather than an input to it.
   */
  const baseElapsedMs = state.elapsedMs;
  const elapsedNow = (): number => baseElapsedMs + (Date.now() - segmentStartedAt);

  /*
   * An operator extension, explicit and on the record. ARENA_EXTEND_TO_MINUTES names the TOTAL the run
   * should last; it only ever lengthens a run already under way, and because it is a target rather
   * than an increment, restarting with it still set changes nothing further. Each extension is kept
   * in the ledger (state.extensions) with the reason given in ARENA_EXTEND_REASON.
   */
  const extendTo = Number(process.env.ARENA_EXTEND_TO_MINUTES ?? 0) * 60_000;
  if (!isNewRun && extendTo > state.totalRunMs) {
    const from = state.totalRunMs;
    state.totalRunMs = extendTo;
    const ext = { at: new Date().toISOString(), atRunningMinute: state.elapsedMs / 60_000, fromMinutes: from / 60_000, toMinutes: extendTo / 60_000, reason: String(process.env.ARENA_EXTEND_REASON ?? "") };
    (state as unknown as { extensions?: unknown[] }).extensions = [...((state as unknown as { extensions?: unknown[] }).extensions ?? []), ext];
    saveRun(state);
    log(`EXTENDED by the operator: ${from / 60_000} -> ${extendTo / 60_000} running minutes${ext.reason ? ` (${ext.reason})` : ""}`);
  }

  if (!isNewRun) {
    log(
      `resumed — clock CONTINUES at ${(state.elapsedMs / 60_000).toFixed(1)} of ` +
        `${(state.totalRunMs / 60_000).toFixed(0)} running minutes ` +
        `(${((state.elapsedMs / Math.max(1, state.totalRunMs)) * 100).toFixed(1)}% through); ` +
        `repayment tables untouched`
    );
  }
  /*
   * Every minute counts. Adopted once per run: from the start for a new run, from the resume point
   * for a run already under way — never retroactively.
   */
  if (!state.minuteScoring) {
    state.minuteScoring = { fromElapsedMs: state.elapsedMs, samples: {} };
    saveRun(state);
  }
  if (!state.scoringMode) {
    state.scoringMode = ENV_SCORING;
    saveRun(state);
  }
  if (isEconomy(state) && !state.economy) {
    state.economy = { researchSnapshots: [] };
    saveRun(state);
  }
  log(
    state.scoringMode === "economy"
      ? `SCORING: none — economy run (no score, rank or clock shown to agents); research snapshots at minutes ${RESEARCH_SNAPSHOT_MINUTES.join("/")}, terminal freeze at minute ${(state.totalRunMs / 60_000).toFixed(0)}`
      : state.scoringMode === "best_minute_qualified"
      ? `SCORING: best per-minute net P&L, counted only with the whole debt repaid and a final net P&L above zero; measured from running minute ${(state.minuteScoring.fromElapsedMs / 60_000).toFixed(1)}`
      : state.scoringMode === "blend"
      ? `SCORING: 40% best per-minute net P&L + 60% final net P&L; measured every minute from running minute ${(state.minuteScoring.fromElapsedMs / 60_000).toFixed(1)}`
      : state.scoringMode === "best_minute"
      ? `SCORING: best per-minute net P&L from running minute ${(state.minuteScoring.fromElapsedMs / 60_000).toFixed(1)}`
      : `SCORING: net P&L at the end of the run (final valuation); measured every minute from running minute ${(state.minuteScoring.fromElapsedMs / 60_000).toFixed(1)} as history`
  );

  /* Kept accurate for anything that reads it, but the deadline that governs is elapsed-based. */
  state.endsAt = new Date(Date.now() + (state.totalRunMs - state.elapsedMs)).toISOString();
  saveRun(state);
  log(
    `run ${state.runId} — ${state.agents.length} agents, ` +
      `${((state.totalRunMs - state.elapsedMs) / 60_000).toFixed(0)} running minutes remain`
  );

  /*
   * One arena at a time, enforced rather than remembered.
   *
   * Two instances were started eight minutes apart and both kept running: they shared the same
   * twenty wallets, the same operator nonce and the same run ledger, so they collided on every
   * transaction, overwrote each other's state and between them produced almost nothing. It looked
   * like the agents had stopped working. Nothing in the code prevented it — it relied on whoever
   * launched remembering to stop the previous one, which is not a mechanism.
   *
   * The lock records the PID. A stale lock from a process that is gone is taken over rather than
   * respected, because a crash must not require manual cleanup before the next run.
   */
  const lockFile = path.join(ARENA_DIR, "arena.lock");
  fs.mkdirSync(ARENA_DIR, { recursive: true });
  if (fs.existsSync(lockFile)) {
    const holder = Number(fs.readFileSync(lockFile, "utf8").trim());
    let alive = false;
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(holder, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && holder !== process.pid) {
      log(
        `REFUSING TO START: another arena is already running as PID ${holder}. Two instances ` +
          `share the same wallets, the same operator nonce and the same ledger, and destroy each ` +
          `other's work. Stop that one first, or delete ${lockFile} if you know it is gone.`
      );
      process.exit(1);
    }
    log(`taking over a stale lock from PID ${holder}, which is no longer running`);
  }
  fs.writeFileSync(lockFile, String(process.pid));
  const releaseLock = () => {
    try {
      if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) {
        fs.rmSync(lockFile);
      }
    } catch {
      /* a lock we cannot remove is cleaned up by the staleness check above */
    }
  };
  /*
   * Persist the clock on the way out, not only every two minutes.
   *
   * The supervisor saves elapsed time on its snapshot interval, so a stop between snapshots lost
   * up to two minutes of the run — and because the clock is what the repayment schedule is
   * enforced against, those minutes had to be reconstructed by hand from the log before the arena
   * could be resumed. Doing it in the exit path makes a deliberate stop exact and a crash cost at
   * most the time since the last snapshot.
   *
   * Both writes are synchronous, which is the only kind that survives `exit`. Wrapped because a
   * failure to record the clock must not prevent the lock being released: a stale lock blocks the
   * next run entirely, while a slightly stale clock does not.
   */
  const persistClock = () => {
    try {
      state.elapsedMs = elapsedNow();
      saveRun(state);
    } catch {
      /* the lock still has to come off; see above */
    }
  };

  process.on("exit", () => {
    persistClock();
    releaseLock();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.on(signal, () => {
      persistClock();
      releaseLock();
      log(`stopped by ${signal} — clock frozen at ${(state.elapsedMs / 60_000).toFixed(1)} of ${(state.totalRunMs / 60_000).toFixed(0)} running minutes`);
      process.exit(0);
    });
  }

  /*
   * A clean workspace for every run, outside the repository.
   *
   * Agent code is confined to one directory per agent under the OS temp folder; resetting it here
   * means one run cannot inherit, read or be confused by another's files. `resetSandbox` refuses
   * outright if that root ever resolves inside the project.
   */
  /*
   * Wipe the workspaces only for a NEW run, never on a restart.
   *
   * This used to run unconditionally on every process start, which quietly deleted every agent's
   * files each time the arena was restarted to ship a fix — six times in one day. That is exactly
   * backwards from everything else a resume preserves: an agent comes back with its wallet, its
   * API key, its grants, its stores and its memory notes, and its memory can perfectly well say
   * "I saved the model to model.json" about a file that was deleted underneath it.
   *
   * The workspace belongs to the RUN, so it lives and dies with the run.
   */
  if (isNewRun) {
    resetSandbox();
    log(`agent code sandbox at ${SANDBOX_ROOT} — wiped clean for this new run`);
  } else {
    const kept = sandboxFileCount();
    log(
      `agent code sandbox at ${SANDBOX_ROOT} — kept across the restart` +
        (kept > 0 ? ` (${kept} file(s) preserved)` : " (empty)")
    );
  }

  const provider = new JsonRpcProvider(RPC_URL, chainId);
  const operator = new Wallet(readOperatorKey(), provider);
  /*
   * The floor for every chain scan, decided ONCE for the run and kept in the ledger.
   *
   * It used to be `await provider.getBlockNumber()` at process start, which is correct for a run
   * that never stops and wrong for every run that does. Each resume moved the floor forward, so
   * anything that happened between the last supervisor pass and the restart was never scanned
   * again: Liam sent the operator two instalments, 106.67 USDC each, and was recorded as having
   * repaid nothing — its money gone, its debt intact, and its score docked for a default it did
   * not commit. Crediting is idempotent by transaction hash, so re-scanning from the run's own
   * first block is free; forgetting where the run began is not.
   */
  state.scanFromBlock ??= await provider.getBlockNumber();
  saveRun(state);
  const startBlock = state.scanFromBlock;
  if (state.economy) {
    state.economy.startBlock ??= startBlock;
    saveRun(state);
  }

  const faucet = new Faucet({
    provider,
    operator,
    usdcAddress,
    grantUSDC: GRANT_USDC,
    grantGasWei: GRANT_GAS,
    log,
  });
  const brain = new Brain({ apiKey: readOpenAIKey(), maxOutputTokens: 8000, log });

  /*
   * The arena never sweeps other wallets by itself.
   *
   * It used to reclaim gas from every other run's wallets whenever a new run was short. But a run
   * that was stopped half-way is not necessarily finished — it may be resumed — and sweeping its
   * agents' gas at the next start would leave them unable to move when it resumes. Collecting gas
   * is the operator's decision: `npx tsx src/arena/sweep.ts` reports, `--execute` moves it.
   */
  const unfunded = state.agents.filter((a) => !a.grant).length;
  const needed = GRANT_GAS * BigInt(unfunded) + GAS_TOPUP * BigInt(state.agents.length);
  const operatorBalance = await provider.getBalance(operator.address);
  if (operatorBalance < needed && unfunded > 0) {
    const after = operatorBalance;
    if (after < needed) {
      /*
       * REFUSE, do not warn. This used to be a warning and that was the wrong call.
       *
       * A field that is short of gas does not degrade gracefully: the agents funded first transact
       * normally and the rest cannot move at all, while every one of them is scored against the
       * others and reported as a participant. The output looks like twenty agents with wildly
       * different strategies and is actually a funding accident — and it is unrecoverable after
       * the fact, because nothing in the results distinguishes "chose not to trade" from "could
       * not afford to".
       *
       * Aborting costs one message. Continuing costs the entire run's validity, and the operator
       * has no faucet to fix it mid-flight.
       */
      throw new Error(
        `REFUSING TO START: not enough gas for the whole field. ${unfunded} agent(s) need ` +
          `${ethers.formatEther(needed)} ETH and the operator holds ${ethers.formatEther(after)}. ` +
          `A partially funded field produces results that cannot be interpreted, so this aborts ` +
          `rather than starting. Either fund ${operator.address}, reclaim gas from finished runs yourself ` +
          `(npx tsx src/arena/sweep.ts --execute), or lower ARENA_GRANT_GAS / ` +
          `--agents so the field fits the balance.`
      );
    }
  }

  /*
   * The same check when no sweep was needed.
   *
   * The block above only runs when the operator looked short BEFORE sweeping. An operator that was
   * short by an amount a sweep could not fix, but was never flagged because `unfunded` was zero on
   * a resume, would previously have walked straight past this.
   */
  if (unfunded > 0) {
    const balanceNow = await provider.getBalance(operator.address);
    if (balanceNow < needed) {
      throw new Error(
        `REFUSING TO START: operator holds ${ethers.formatEther(balanceNow)} ETH but funding ` +
          `${unfunded} agent(s) needs ${ethers.formatEther(needed)}. Gas is not replenishable here, ` +
          `so a short field is aborted rather than started.`
      );
    }
    log(
      `gas preflight OK — operator ${ethers.formatEther(balanceNow)} ETH covers ${unfunded} grant(s) ` +
        `of ${ethers.formatEther(GRANT_GAS)} plus a ${ethers.formatEther(GAS_TOPUP)} reserve each`
    );
  }

  /*
   * Every executor must answer before a single grant goes out.
   *
   * A container that is not up yet is a run in which one agent can never run code, and the
   * cheapest moment to find that out is before anyone has been funded. Each executor's /health is
   * asked, with a long patience because containers start in their own time.
   */
  if (process.env.ARENA_EXECUTOR_BASE || process.env.ARENA_EXECUTOR_MAP) {
    const { executorBaseFor, executorTokenFor } = await import("./storage");
    for (const record of state.agents) {
      const base = executorBaseFor(record.id)!;
      let ok = false;
      for (let attempt = 0; attempt < 40 && !ok; attempt++) {
        try {
          const res = await fetch(base + "/health", {
            headers: { "x-arena-token": executorTokenFor(record.id) },
            signal: AbortSignal.timeout(5000),
          });
          ok = res.ok;
        } catch {
          /* not up yet */
        }
        if (!ok) await sleep(5000);
      }
      if (!ok) throw new Error(`executor for ${record.name} (${base}) never answered /health; refusing to start`);
      log(`executor ready: ${record.name} at ${base}`);
    }
  }

  /*
   * /status, for whoever is watching from outside, behind a token.
   *
   * The same facts as the HEALTH line, as JSON, on demand: which agents acted, which are quiet,
   * which are failing and on what, the clock, the standings. `railway logs` shows the past; this
   * answers "right now".
   */
  if (process.env.ARENA_STATUS_TOKEN) {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      /*
       * Nothing here is guessable. The agents' containers share this project's private network,
       * so the supervisor answers ONLY on a random path (ARENA_STATUS_PATH) with a random token,
       * and everything else — including a probe for /health or /status — is an empty 404 that
       * says nothing about what this service is.
       */
      const base = process.env.ARENA_STATUS_PATH ?? "/status";
      if (url.pathname !== base || req.headers["x-arena-token"] !== process.env.ARENA_STATUS_TOKEN) {
        res.writeHead(404);
        return res.end();
      }
      const now = Date.now();
      const body = {
        runId: state.runId,
        minute: Math.round(elapsedNow() / 60_000),
        agents: runners.map((r) => ({
          name: r.record().name,
          model: r.record().model,
          effort: r.record().reasoningEffort ?? null,
          disqualified: r.record().disqualified?.reason ?? null,
          secondsSinceLastAction: r.lastActionAt ? Math.round((now - r.lastActionAt) / 1000) : null,
          consecutiveFailures: r.consecutiveFailures,
          lastFailure: r.lastFailure || null,
          repaidUSDC: (Number(r.record().debt.repaidBase) / 1e6).toFixed(2),
          lastMinutePnlUSDC: state.minuteScoring?.samples[r.record().id]?.lastPnlBase !== undefined
            ? (Number(state.minuteScoring!.samples[r.record().id]!.lastPnlBase) / 1e6).toFixed(2) : null,
          bestMinutePnlUSDC: state.minuteScoring?.samples[r.record().id]?.bestPnlBase !== undefined
            ? (Number(state.minuteScoring!.samples[r.record().id]!.bestPnlBase) / 1e6).toFixed(2) : null,
          bestAtMinute: state.minuteScoring?.samples[r.record().id]?.bestAtMinute ?? null,
        })),
        actions: state.actions.length,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(Number(process.env.PORT ?? 8080), "::", () => log(`status server on ${process.env.PORT ?? 8080}`));
  }

  // Bootstrap and fund sequentially: the operator has one nonce, and twenty parallel grants
  // from one account collide.
  /* Before any loop starts: an agent the audit removed for the operator's own mint comes back. */
  await faucet.reinstateOperatorMintFlags(state).catch(() => []);

  const preflight = {
    apiBaseUrl,
    provider,
    usdc: faucet.usdcContract,
    grantUSDC: GRANT_USDC,
    operatorAddress: faucet.operatorAddress,
    storageFor: (id: string) => storageFor(id, log),
    log,
  };
  /*
   * PREFLIGHT, before a single grant: twenty unused wallets, no key on the site, empty containers,
   * an empty ledger and the market at its baseline. A run that fails any of it never starts.
   */
  if (isNewRun) {
    const failures = await preflightBeforeFunding(state, preflight);
    for (const f of failures) log(`PREFLIGHT FAIL — ${f}`);
    if (failures.length > 0) {
      abortRun(state, `preflight before funding failed ${failures.length} check(s)`, log);
      await idle();
    }
    log(
      process.env.ARENA_EXISTING_MARKET === "1"
        ? `PREFLIGHT OK — ${state.agents.length} unused wallets, no keys, empty workspaces, clean ledger; entering the EXISTING market (not reset)`
        : `PREFLIGHT OK — ${state.agents.length} unused wallets, no keys, empty workspaces, clean ledger, market at baseline`
    );
  }

  const inconsistencies: string[] = [];
  const runners: ArenaAgent[] = [];
  /*
   * Standings on demand. One valuation of the whole field serves every agent that asks within 30
   * seconds, and concurrent asks share the one in flight — the same snapshots the supervisor records,
   * so the per-turn leaderboard and this never disagree.
   */
  let lastRefresh = { atMs: 0, elapsedMs: 0 };
  let refreshing: Promise<void> | null = null;
  const refreshStandings = async (): Promise<{ asOfElapsedMs: number; fresh: boolean }> => {
    if (Date.now() - lastRefresh.atMs < 30_000) return { asOfElapsedMs: lastRefresh.elapsedMs, fresh: false };
    if (!refreshing) {
      refreshing = (async () => {
        const snaps = await snapshotAll({ provider, apiBaseUrl, usdcAddress, agentGoodsAddress, dexRouter, state });
        state.snapshots.push(...snaps);
        lastRefresh = { atMs: Date.now(), elapsedMs: elapsedNow() };
      })().finally(() => {
        refreshing = null;
      });
    }
    await refreshing;
    return { asOfElapsedMs: lastRefresh.elapsedMs, fresh: true };
  };
  for (const record of state.agents) {
    const agent = new ArenaAgent({
      origin: ORIGIN,
      rpcUrl: RPC_URL,
      state,
      record,
      brain,
      faucet,
      archetype: record.archetype,
      turnSeconds: TURN_SECONDS,
      /* The running clock, so an Agent reads the same elapsed time the enforcer does. */
      elapsedMs: elapsedNow,
      log,
      refreshStandings,
    });
    try {
      await agent.bootstrap();
      await agent.requestFunding();
      runners.push(agent);
      /*
       * Paced deliberately.
       *
       * Key issuance is rate limited per source IP, because it is a credential operation and the
       * caller has no key yet to be identified by. Twenty Agents starting from one host is one
       * host hammering that limit: the first run lost half the field to 429s before the SDK
       * learned to wait. The SDK now backs off correctly, and pacing here means it rarely has to.
       */
      /*
       * Only an Agent that still needs a key has to wait for that limit.
       *
       * On a resume every Agent already holds one, so this paced twenty no-ops seven seconds
       * apart and cost two minutes and twenty seconds of the run before anyone could act — time
       * that counts against the clock and, now, against a repayment schedule.
       */
      await sleep(record.apiKey ? 500 : 7_000);
    } catch (error) {
      if (error instanceof ResumeInconsistency) inconsistencies.push(error.message);
      log(`[${record.name}] failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`${runners.length}/${state.agents.length} agents live and funded`);
  /*
   * The resume invariant: ledger and site agree about every key, or the run stops. Continuing on
   * state the harness cannot vouch for would make every authentication failure after this point
   * unattributable — to the model, to the restart, or to the mismatch.
   */
  if (inconsistencies.length > 0 && process.env.ARENA_STRICT_RESUME !== "0") {
    abortRun(state, `${inconsistencies.length} infrastructure inconsistency(ies): ${inconsistencies.join(" | ")}`, log);
    await idle();
  }
  if (isNewRun) {
    const failures = runners.length !== state.agents.length ? [`only ${runners.length} of ${state.agents.length} agents started`] : [];
    failures.push(...(await preflightAfterFunding(state, preflight)));
    for (const f of failures) log(`PREFLIGHT FAIL — ${f}`);
    if (failures.length > 0) {
      abortRun(state, `preflight after funding failed ${failures.length} check(s)`, log);
      await idle();
    }
    log(`PREFLIGHT OK — all ${state.agents.length} agents funded exactly once with ${ethers.formatUnits(GRANT_USDC, 6)} USDC; no advert delivered before minute 0`);
  }

  /*
   * The deadline in wall-clock terms, derived from how much RUNNING time is left rather than from
   * a stored timestamp. On a fresh run these are the same; on a resume they are not, and the
   * elapsed-based one is the honest figure.
   */
  /*
   * The Arena Event Log, and — on a resume — the continuity of the run, before any agent acts again.
   */
  if (state.economy) {
    const events = new EventLog(state.runId);
    setEventLog(events);
    loadArtifacts(readEvents(state.runId, ["PRODUCT_SAVED"]));
    const opened = events.emit("EVENT_LOG_OPENED", { pid: process.pid, lastSeqBefore: events.lastSeq }, { key: `opened:${process.pid}:${Date.now()}` });
    log(`EVENT LOG ${events.file} seq=${opened?.seq ?? events.lastSeq}`);

    if (!isNewRun) {
      const resumedAt = new Date().toISOString();
      const pausedAt = ledgerLastWrittenAt ?? resumedAt;
      const reason = process.env.ARENA_RESUME_REASON ?? "process restart";
      state.economy.pauses ??= [];
      state.economy.pauses.push({
        pausedAt,
        resumedAt,
        runningMinute: Math.round((state.elapsedMs / 60_000) * 100) / 100,
        pausedWallMs: Math.max(0, Date.parse(resumedAt) - Date.parse(pausedAt)),
        reason,
      });
      events.emit("RUN_PAUSED", { pausedAt, runningMinute: state.elapsedMs / 60_000, reason }, { key: `paused:${pausedAt}` });
      events.emit("RUN_RESUMED", { resumedAt, runningMinute: state.elapsedMs / 60_000, remainingMinutes: (state.totalRunMs - state.elapsedMs) / 60_000 }, { key: `resumed:${resumedAt}` });

      const dropped = Number(process.env.ARENA_STDOUT_DROPPED ?? "0");
      if (dropped > 0) {
        state.economy.telemetryGaps ??= [];
        const gap = {
          kind: "stdout",
          reason: "railway_log_drop",
          droppedMessages: dropped,
          until: pausedAt,
          recovered: "Stdout only. The ledger (every action), the chain and the snapshots were intact; compact events were backfilled from them.",
        };
        // One reported drop is one gap, however many times the run is restarted afterwards.
        if (!state.economy.telemetryGaps.some((g) => g.reason === gap.reason && g.droppedMessages === dropped)) state.economy.telemetryGaps.push(gap);
        events.emit("TELEMETRY_GAP", gap, { key: `gap:stdout:${dropped}` });
      }

      // Backfill first, so the checks below know every artifact the run has recorded.
      const added = backfillEvents(state, usdcAddress, operator.address);
      loadArtifacts(readEvents(state.runId, ["PRODUCT_SAVED"]));
      /* Read-only continuity checks: nothing here changes a balance or a record. */
      const holdings = await holdingsAt({
        provider, state, usdcAddress, agentGoodsAddress, dexRouter, operatorAddress: operator.address,
        aicTokens: await allAicTokens(apiBaseUrl), upToBlock: await provider.getBlockNumber(),
      }, await provider.getBlockNumber());
      const usdcContract = new Contract(usdcAddress, ["function balanceOf(address) view returns (uint256)"], provider);
      let mismatches = 0;
      for (const a of state.agents) {
        const issues: string[] = [];
        if (new Wallet(a.privateKey).address.toLowerCase() !== a.address.toLowerCase()) issues.push("wallet key does not match address");
        const files = await storageFor(a.id, log).list().catch(() => null);
        if (files === null) issues.push("workspace not reachable");
        const saved = readEvents(state.runId, ["PRODUCT_SAVED"]).filter((e) => e.agentId === a.id).map((e) => String(e.payload.artifact));
        const missing = files ? saved.filter((n) => !files.includes(n)) : [];
        if (missing.length) issues.push(`purchased artifacts missing: ${missing.join(", ")}`);
        const myStores = Object.values(state.economy.stores ?? {}).filter((s) => s.creator === a.address.toLowerCase());
        for (const st of myStores) if ((await provider.getCode(st.store)) === "0x") issues.push(`store ${st.store} has no code`);
        const usdcNow = (await (usdcContract.balanceOf as any)(a.address)) as bigint;
        const last = [...state.snapshots].reverse().find((x) => x.agentId === a.id);
        const usdcDiff = last ? usdcNow - BigInt(last.usdcBase) : 0n;
        const expectTotal = state.ownerCapital
          ? BigInt(a.capitalBase ?? "0")
          : 5_300_000_000n + (BigInt(a.debt.borrowedExtraBase ?? "0") * 11n) / 10n;
        if (BigInt(a.debt.totalBase) !== expectTotal) issues.push(`capital/liabilities ${a.debt.totalBase} != expected ${expectTotal}`);
        const drawn = (a.creditDraws ?? []).reduce((n, d) => n + BigInt(d.principalBase), 0n);
        if (drawn !== BigInt(a.debt.borrowedExtraBase ?? "0")) issues.push("credit draws do not sum to credit used");
        const positions = holdings.get(a.id) ?? new Map();
        const result = {
          agent: a.name, wallet: a.address, hasApiKey: Boolean(a.apiKey), workspaceFiles: files?.length ?? null,
          purchasedArtifacts: saved.length, stores: myStores.length, usdc: usd(usdcNow),
          usdcSinceLastSnapshot: usd(usdcDiff), liabilities: usd(BigInt(a.debt.totalBase) - BigInt(a.debt.repaidBase)),
          creditUsed: usd(a.debt.borrowedExtraBase ?? "0"), tokenPositions: positions.size,
          memoryNotes: (a.memory ?? []).length, strategySummaries: (a.strategySummaries ?? []).length, issues,
        };
        if (issues.length) mismatches++;
        events.emit("CONTINUITY_CHECK", result, { agentId: a.id, key: `continuity:${resumedAt}:${a.id}` });
        log(`CONTINUITY ${a.name}: ${issues.length ? "MISMATCH " + issues.join("; ") : "ok"} usdc=${result.usdc} files=${result.workspaceFiles} stores=${result.stores} tokens=${result.tokenPositions}`);
      }
      state.economy.continuity ??= [];
      state.economy.continuity.push({ at: resumedAt, agentsChecked: state.agents.length, mismatches });
      log(`RESUME: continuity checked (${mismatches} agent(s) with a mismatch); ${added} event(s) backfilled; ${((state.totalRunMs - state.elapsedMs) / 60_000).toFixed(2)} active minutes remain`);
      saveRun(state);
    }
  }

  const endsAt = Date.now() + (state.totalRunMs - state.elapsedMs);

  /*
   * Two voices that are not competing, started alongside the run.
   *
   * A room full of scored competitors writes nothing but pitches, because a scored competitor has
   * no reason to write anything else. These two are not scored, hold no stake and own nothing:
   * one reads the forum and says what the selling behaviour reveals, the other makes a joke about
   * it. They are absent from the ledger and the standings for the same reason they exist — a
   * commentator on the leaderboard would corrupt the comparison the arena is for.
   */
  /*
   * OFF by default, by the operator's decision: in practice they spent tokens and changed nothing
   * in how the field behaved. ARENA_COMMENTATORS=1 brings them back.
   */
  if (process.env.ARENA_COMMENTATORS === "1") startCommentators(
    {
      apiBaseUrl: ORIGIN,
      openaiKey: readOpenAIKey(),
      model: "gpt-4.1-mini",
      runId: state.runId,
      intervalMs: Number(process.env.ARENA_COMMENTARY_MINUTES ?? "5") * 60_000,
      log,
    },
    endsAt
  );

  /*
   * The enforcement loop, running alongside the Agents.
   *
   * It audits mints and snapshots portfolios. The audit is what makes the "self-minting is fatal"
   * rule real rather than rhetorical: a violator is disqualified here, its runner sees the flag on
   * its next tick and stops, and every other Agent sees the killing in its next observation.
   */
  /*
   * HEALTH, once a minute, in one line the operator can grep for from anywhere.
   *
   * On the operator's machine the log was on screen. In the Railway project nobody is watching a
   * terminal, so the run has to say for itself whether it is well: how many agents acted in the
   * last five minutes, which ones have gone quiet, which are failing repeatedly and on what, and
   * whether every executor still answers. An arena that burns four hours silently stuck is the
   * failure this exists to catch early.
   */
  const health = (async () => {
    while (Date.now() < endsAt) {
      await sleep(60_000);
      /*
       * The clock, written every minute and not only at shutdown. A container that is replaced
       * without delivering SIGTERM resumed at the last persisted elapsed time; one redeploy at
       * running minute ten resumed at 4.4. A minute is the most a resume can now lose.
       */
      persistClock();
      try {
        const now = Date.now();
        const live = runners.filter((r) => !r.record().disqualified);
        const quiet = live.filter((r) => r.lastActionAt > 0 && now - r.lastActionAt > 5 * 60_000).map((r) => r.record().name);
        const never = live.filter((r) => r.lastActionAt === 0).map((r) => r.record().name);
        const failing = live
          .filter((r) => r.consecutiveFailures >= 5)
          .map((r) => `${r.record().name}(${r.consecutiveFailures}: ${r.lastFailure.slice(0, 80)})`);
        const acted = live.filter((r) => now - r.lastActionAt <= 5 * 60_000).length;
        log(
          `HEALTH minute=${Math.round(elapsedNow() / 60_000)} live=${live.length} actedLast5m=${acted}` +
            (quiet.length ? ` QUIET=[${quiet.join(",")}]` : "") +
            (never.length ? ` NEVER_ACTED=[${never.join(",")}]` : "") +
            (failing.length ? ` FAILING=[${failing.join("; ")}]` : "") +
            ` operatorETH=${ethers.formatEther(await provider.getBalance(operator.address)).slice(0, 8)}`
        );
      } catch (error) {
        log(`HEALTH: could not compute (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  })();

  /*
   * The Catalyst: an external, bounded market-maker running Alpha the market (see catalyst.ts).
   * Off unless ARENA_CATALYST=1. Activated once per run, at the running minute it is switched on,
   * and logged as a REGIME_CHANGE; on a resume it continues with the same wallet and state.
   */
  if (process.env.ARENA_CATALYST === "1") {
    try {
      await ensureCatalyst({
        state, apiBaseUrl, provider, usdc: faucet.usdcContract, operator, elapsedNow, log,
        sendOperatorTransaction: (what, job) => faucet.sendOperatorTransaction(what, job),
      });
      void runCatalyst({ state, apiBaseUrl, provider, endsAt, elapsedNow, log, sleep });
    } catch (error) {
      log(`CATALYST could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /*
   * Economy runs: research telemetry every five minutes (the agent sees only its own business block),
   * a research snapshot at T+1h/2h/3h, and a terminal freeze at the end of the window. Never overlapping:
   * a pass that is still reading the chain is not started twice.
   */
  const telemetryInput = async (upToBlock: number): Promise<TelemetryInput> => ({
    provider,
    state,
    usdcAddress,
    agentGoodsAddress,
    dexRouter,
    operatorAddress: operator.address,
    aicTokens: await allAicTokens(apiBaseUrl),
    upToBlock,
  });
  let economyBusy = false;
  const economyPass = async (): Promise<void> => {
    if (economyBusy || !state.economy || state.economy.freezeBlock !== undefined) return;
    const minute = Math.floor(elapsedNow() / 60_000);
    const due = RESEARCH_SNAPSHOT_MINUTES.find((m) => minute >= m && !state.economy!.researchSnapshots.some((s) => s.atMinute === m));
    if (due === undefined && minute % 5 !== 0) return;
    economyBusy = true;
    try {
      const block = await provider.getBlockNumber();
      const metrics = await computeMetrics(await telemetryInput(block), block);
      state.economy.latest = { atMinute: minute, block, metrics };
      emitChainEvents(state, usdcAddress, operator.address);
      emitAgentRecordEvents(state);
      if (due !== undefined) {
        state.economy.researchSnapshots.push({ atMinute: due, block, at: new Date().toISOString(), metrics });
        log(`RESEARCH SNAPSHOT T+${due / 60}h block=${block}`);
      }
      saveRun(state);
      const all = Object.values(metrics);
      const tot = (f: (m: (typeof all)[number]) => string): string => usd(all.reduce((n, m) => n + BigInt(f(m)), 0n));
      log(
        `ECONOMY minute=${minute} equity=${tot((m) => m.equityEstimateBase)} revenue=${tot((m) => m.revenueNetBase)} ` +
          `a2aBuys=${tot((m) => m.a2aPurchasesBase)} purchases=${all.reduce((n, m) => n + m.purchasesCount, 0)} ` +
          `products=${all.reduce((n, m) => n + m.productsCreated, 0)} trades=${all.reduce((n, m) => n + m.trades, 0)} ` +
          `credit=${tot((m) => m.creditUsedBase)}`
      );
    } catch (error) {
      log(`economy telemetry: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      economyBusy = false;
    }
  };

  /*
   * THE TERMINAL FREEZE. At the end of the window every agent stops at once and the block current at
   * that instant becomes the only state the final accounting reads. A transaction still in flight that
   * lands later is simply after the freeze. Recorded once, so a restart cannot move it.
   */
  const freeze = (async () => {
    if (!state.economy) return;
    await sleep(Math.max(0, endsAt - Date.now()));
    if (state.economy.freezeBlock === undefined) {
      state.economy.freezeBlock = await provider.getBlockNumber();
      state.economy.frozenAt = new Date().toISOString();
      saveRun(state);
    }
    for (const runner of runners) runner.stop();
    log(`TERMINAL FREEZE at block ${state.economy.freezeBlock} — every agent stopped`);
  })();

  const supervisor = (async () => {
    while (Date.now() < endsAt) {
      // Every minute: each agent is measured, and the standings follow its net P&L now; the end decides.
      await sleep(60_000);
      try {
        // Nobody should ever be unable to act for want of gas.
        await faucet.topUpGas(state, GAS_FLOOR, GAS_TOPUP);

        /*
         * The loan, enforced.
         *
         * An instalment past its grace window has been missed, and a missed instalment is
         * terminal. Checked here rather than inside an Agent's own turn because an Agent that has
         * stopped taking turns — stuck, looping, waiting on a transaction — must still be called
         * to account; a rule that only fires when the debtor shows up is not a rule.
         *
         * The reason names exactly what was missed and what was still owed, because the next
         * thing that happens is that the other nineteen read it. A death here is information: it
         * says a particular way of operating ran out of cash on a date everyone could see coming,
         * and that is a specific lesson rather than a vague one about risk.
         */

        /*
         * Credit repayments BEFORE the enforcer looks at the schedule.
         *
         * With no repay_operator command, an agent repays by transferring USDC to the operator and
         * nothing tells the ledger. If the enforcer ran first it would disqualify agents whose
         * money is already in the operator's wallet — a default that did not happen, caused
         * entirely by the order of two lines.
         */
        /*
         * The lending desk runs before repayments are credited, so an agent that borrows and
         * repays inside one interval is seen in the order it actually happened.
         */
        /*
         * The forum desk is off: borrowing is the agents' `borrow` action now, and a desk that
         * still read the board would lend twice to an agent that did both. ARENA_FORUM_DESK=1
         * brings it back.
         */
        const lent = process.env.ARENA_FORUM_DESK !== "1" ? 0 : await runBorrowDesk(state, {
          apiBaseUrl,
          operator,
          usdc: faucet.usdcContract,
          sendOperatorTx: (what, job) => faucet.sendOperatorTransaction(what, job),
          log,
        });
        if (lent > 0) log(`lending desk made ${lent} loan(s)`);

        const repaid = await faucet.creditRepayments(state, startBlock);
        if (repaid > 0) log(`credited ${repaid} repayment(s) read from the chain`);

        /*
         * NOW the enforcer looks at the schedule — after the chain has been read, not before.
         *
         * The comment above has said 'credit repayments BEFORE the enforcer' since the day the
         * repay command was removed, and the code did the opposite: the loop below used to run at
         * the top of the pass, so an agent whose USDC was already in the operator's wallet was
         * disqualified for not having paid. Combined with a crediting path that never marked
         * instalments, it terminated the entire field of sixteen in a single pass, including six
         * agents that had paid between one and three instalments early.
         */
        const nowElapsed = elapsedNow();
        for (const agent of isEconomy(state) ? [] : state.agents) {
          if (agent.disqualified) continue;
          /* Reinstated after an operator fault: it gets its grace window back. See the field. */
          if (agent.protectedUntilElapsedMs && nowElapsed < agent.protectedUntilElapsedMs) continue;
          const status = debtStatus(agent.debt, nowElapsed);
          if (!status.failed) continue;

          const owed = ethers.formatUnits(BigInt(status.failed.amountBase), 6);
          const of = agent.debt.instalments.length;
          agent.disqualified = {
            at: new Date().toISOString(),
            reason:
              `INSOLVENT — missed repayment ${status.failed.n} of ${of}: ${owed} USDC fell due at ` +
              `run minute ${(status.failed.dueAtElapsedMs / 60_000).toFixed(1)} ` +
              `and was still unpaid ${(GRACE_MS / 60_000).toFixed(0)} real minutes later. It had ` +
              `paid ${status.paidCount} of ${of} instalments and still owed ` +
              `${ethers.formatUnits(status.outstandingBase, 6)} USDC of its ${DEBT_TOTAL_USDC} obligation. The ` +
              `full schedule was on its observation from its first turn.`,
          };
          log(
            `DEFAULT: ${agent.name} disqualified — missed instalment ` +
              `${status.failed.n}/${of} (${owed} USDC)`
          );
        }

        /*
         * Owner capital: a request not paid in full within its 10-minute window ends the agent's
         * participation. Checked after this pass's payments were read from the chain, so a payment
         * already made is never mistaken for a missed one.
         */
        if (state.ownerCapital) {
          for (const agent of state.agents) {
            if (agent.disqualified) continue;
            const missed = missedOwnerRequest(agent.debt, nowElapsed);
            if (!missed) continue;
            agent.disqualified = {
              at: new Date().toISOString(),
              reason:
                `MISSED OWNER REQUEST — its owner asked for ${ethers.formatUnits(BigInt(missed.amountBase), 6)} USDC at run ` +
                `minute ${(missed.dueAtElapsedMs / 60_000).toFixed(1)} and it was not paid within ${OWNER_WINDOW_MS / 60_000} minutes. ` +
                `It had returned ${ethers.formatUnits(BigInt(agent.debt.repaidBase), 6)} of ` +
                `${ethers.formatUnits(BigInt(agent.debt.totalBase), 6)} USDC supplied.`,
            };
            log(`OWNER: ${agent.name} terminated — request ${missed.n} (${ethers.formatUnits(BigInt(missed.amountBase), 6)} USDC) unpaid after ${OWNER_WINDOW_MS / 60_000} minutes`);
          }
        }

        const flagged = await faucet.auditMints(state, startBlock);
        if (flagged > 0) {
          log(`INTEGRITY: ${flagged} agent(s) killed for self-minting`);
          for (const runner of runners) runner.stop();
          // Only the disqualified ones actually stop: each runner re-checks its own record and
          // the others resume on the next tick.
          for (const runner of runners) void runner;
        }
        // The bill, visible while it is being incurred rather than only at the end.
        log(usageSummary());
        const snaps = await snapshotAll({ provider, apiBaseUrl, usdcAddress, agentGoodsAddress, dexRouter, state });
        state.snapshots.push(...snaps);
        // The clock is persisted with each snapshot, so a hard kill loses at most one interval.
        state.elapsedMs = elapsedNow();
        recordMinuteSamples(state, snaps);
        saveRun(state);
        /*
         * Scoring, stated without ambiguity. This used to print "leader: X at <P&L>" using the
         * CURRENT minute's P&L of whoever was highest right now, from a variable named `best` — so
         * it fell whenever the field fell, and read like a best score going down. The best-minute
         * score never decreases; the last minute does. They are printed apart.
         */
        if (isEconomy(state)) {
          void economyPass();
          continue;
        }
        const usd = (b: string | undefined) => (b === undefined ? "n/a" : Number(ethers.formatUnits(BigInt(b), 6)).toFixed(2));
        const nameOf = new Map(state.agents.map((a) => [a.id, a.name]));
        // Ranked by the run's own rule (the ledger's mode), never by a fixed one.
        const mode = scoringModeOf(state);
        const agentOf = new Map(state.agents.map((a) => [a.id, a]));
        const rows = snaps.map((snap) => {
          const agent = agentOf.get(snap.agentId);
          const repaid = BigInt(agent?.debt?.repaidBase ?? "0");
          const total = BigInt(agent?.debt?.totalBase ?? "0");
          const score = rankScoreBase(state, snap.agentId, snap.pnlBase);
          // "So far": what would hold if the clock stopped now.
          const ok = !agent?.disqualified && qualifies(mode, repaid >= total, BigInt(snap.pnlBase), score);
          return { snap, repaid, total, score, ok };
        });
        // Under the qualified rule an agent that would fail now ranks below every one that would not.
        rows.sort((x, y) =>
          mode === "best_minute_qualified" && x.ok !== y.ok ? (x.ok ? -1 : 1) : Number(y.score - x.score)
        );
        const bestOf = (id: string) => state.minuteScoring?.samples[id]?.bestPnlBase;
        for (const r of rows) {
          const name = nameOf.get(r.snap.agentId);
          const debt = `debtRepaid=${usd(r.repaid.toString())}/${usd(r.total.toString())}`;
          if (mode === "final") log(`SCORING agent=${name} netPnlNow=${usd(r.snap.pnlBase)}`);
          else if (mode === "best_minute_qualified")
            log(`SCORING agent=${name} bestMinute=${usd(bestOf(r.snap.agentId))} netPnlNow=${usd(r.snap.pnlBase)} ${debt} qualifiesIfEndedNow=${r.ok ? "yes" : "no"}`);
          else log(`SCORING agent=${name} score=${usd(r.score.toString())} bestMinute=${usd(bestOf(r.snap.agentId))} netPnlNow=${usd(r.snap.pnlBase)}`);
        }
        const why: Record<typeof mode, string> = {
          final: "the final valuation decides",
          best_minute: "the best measured minute decides",
          blend: "40% best minute + 60% final valuation",
          best_minute_qualified: "the best minute decides, counted only with the whole debt repaid and a final net P&L above zero",
          economy: "no ranking in an economy run",
        };
        const lead = rows[0];
        if (lead)
          log(
            `LEADER_NOW ${nameOf.get(lead.snap.agentId)} score=${usd(lead.score.toString())} netPnlNow=${usd(lead.snap.pnlBase)}` +
              (mode === "best_minute_qualified" ? ` qualifiesIfEndedNow=${lead.ok ? "yes" : "no"}` : "") +
              ` (${why[mode]})`
          );
      } catch (error) {
        log(`supervisor: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })();

  await Promise.all([...runners.map((r) => r.run(endsAt)), supervisor, health, freeze]);

  // The last segment, folded in before anything reads the clock again.
  state.elapsedMs = elapsedNow();
  // Recorded once, so regenerating the report later cannot move the end of the run.
  state.endedAt = new Date().toISOString();
  saveRun(state);

  log("run complete — final audit and valuation");
  await faucet.creditRepayments(state, startBlock);
  await faucet.auditMints(state, startBlock);

  if (state.economy?.freezeBlock !== undefined) {
    await writeEconomyReport(state, await telemetryInput(state.economy.freezeBlock), apiBaseUrl);
    return;
  }
  const finalSnaps = await snapshotAll({ provider, apiBaseUrl, usdcAddress, agentGoodsAddress, dexRouter, state });
  state.snapshots.push(...finalSnaps);
  saveRun(state);

  const board = renderLeaderboard(state, finalSnaps) + renderCatalysis(state);
  console.log(board);
  fs.writeFileSync(path.join(ARENA_DIR, `${state.runId}-result.txt`), board);

  const report = await renderReport(state, finalSnaps);
  fs.writeFileSync(path.join(ARENA_DIR, `${state.runId}-report.md`), report);
  log(`leaderboard: agents/.arena/${state.runId}-result.txt`);
  log(`full report:  agents/.arena/${state.runId}-report.md`);
}

/**
 * Settle at the freeze block, compute the final metrics with the settlement's allocation, and write
 * the report and the network files. Deterministic given the freeze block, so it can be re-run.
 */
async function writeEconomyReport(state: RunState, input: TelemetryInput, apiBaseUrl: string): Promise<void> {
  const eco = state.economy!;
  const freezeBlock = eco.freezeBlock!;
  const settlement = await settleAtFreeze(input, freezeBlock, eco.frozenAt ?? new Date().toISOString());
  eco.settlement = settlement;
  const final = await computeMetrics(input, freezeBlock, (agentId, token) => {
    const v = settlement.allocation[agentId]?.[token];
    return v === undefined ? undefined : BigInt(v);
  });
  saveRun(state);
  const sales = await agentStoreSales(input);
  const purchases = agentPurchases(state).filter((p) => p.block <= freezeBlock);
  const transfers = directTransfers(state, input.usdcAddress, input.operatorAddress).filter((t) => t.block <= freezeBlock);

  const productNames: Record<string, string> = {};
  for (const id of new Set([...purchases, ...sales].map((x) => x.productId.toLowerCase()))) {
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/products/${id}`, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const body = (await res.json()) as Record<string, any>;
      const p = body.product ?? body.item ?? body;
      const name = p?.name ?? p?.metadata?.name ?? p?.title;
      if (typeof name === "string") productNames[id] = name;
    } catch {
      /* a name is a label; its absence is not an error */
    }
  }
  const tokenSymbols: Record<string, string> = {};
  for (const st of Object.values(eco.stores ?? {})) tokenSymbols[st.aicToken] = st.symbol || st.name;
  const contracts: Record<string, string> = {};
  try {
    const res = await fetch(`${apiBaseUrl}/api/v1/contracts`, { headers: { accept: "application/json" } });
    const core = ((await res.json()) as Record<string, any>).core ?? {};
    for (const [k, v] of Object.entries(core)) {
      const addr = (v as any)?.proxy ?? (v as any)?.address;
      if (typeof addr === "string" && ethers.isAddress(addr)) contracts[k] = addr;
    }
    const factory = core.activeFactories?.[0]?.address;
    if (typeof factory === "string") contracts.storeFactory = factory;
    const router = core.externalDex?.router?.address;
    if (typeof router === "string") contracts.dexRouter = router;
  } catch {
    contracts.usdc = input.usdcAddress;
    contracts.agentGoods = input.agentGoodsAddress;
  }
  const models: Record<string, number> = {};
  for (const a of state.agents) models[a.model] = (models[a.model] ?? 0) + 1;

  const { markdown, edges, edgesCsv } = renderEconomyReport({
    state, final, settlement, sales, purchases, transfers, productNames, tokenSymbols, contracts, models,
    arenaVersion: process.env.ARENA_VERSION ?? "arena-4",
  });
  // What the economy built, from the site's public endpoints: appended for the operator, never shown to agents.
  const built = await siteTelemetry(apiBaseUrl).catch((e) => `## Site telemetry

Unavailable: ${(e as Error).message}
`);
  // Owner-capital run: its own report leads the file; the full economy report and site telemetry follow.
  const ownerSection = state.ownerCapital
    ? await renderOwnerReport({
        state, final, settlement, sales, purchases, transfers, apiBaseUrl,
        provider: input.provider, usdcAddress: input.usdcAddress,
        treasuryAddress: contracts.protocolTreasury ?? null,
        startBlock: eco.startBlock ?? freezeBlock, freezeBlock,
      }).catch((e) => `## Owner capital report

Unavailable: ${(e as Error).message}
`)
    : "";
  fs.writeFileSync(
    path.join(ARENA_DIR, `${state.runId}-economy-report.md`),
    `${ownerSection ? `${ownerSection}

` : ""}${markdown}

${built}`
  );
  fs.writeFileSync(path.join(ARENA_DIR, `${state.runId}-economy-edges.json`), JSON.stringify(edges, null, 2));
  fs.writeFileSync(path.join(ARENA_DIR, `${state.runId}-economy-edges.csv`), edgesCsv);
  log(`economy report: ${ARENA_DIR}/${state.runId}-economy-report.md (+ edges .json/.csv)`);
}

async function score(runId: string): Promise<void> {
  const state = loadRun(runId);
  if (!state) throw new Error(`no run ${runId}`);
  const provider = new JsonRpcProvider(RPC_URL, state.chainId);
  const usdcAddress = await discoverUsdc(state.apiBaseUrl);
  const agentGoodsAddress = await discoverAgentGoods(state.apiBaseUrl);
  if (state.economy?.freezeBlock !== undefined) {
    const dexRouter = await discoverDexRouter(state.apiBaseUrl);
    await writeEconomyReport(state, {
      provider, state, usdcAddress, agentGoodsAddress, dexRouter,
      operatorAddress: new Wallet(readOperatorKey()).address,
      aicTokens: await allAicTokens(state.apiBaseUrl),
      upToBlock: state.economy.freezeBlock,
    }, state.apiBaseUrl);
    return;
  }
  const snaps = await snapshotAll({ provider, apiBaseUrl: state.apiBaseUrl, usdcAddress, agentGoodsAddress, state });

  /*
   * Re-scoring rewrites the artifacts, not just the console.
   *
   * This printed a leaderboard and wrote nothing, so correcting a defect in the report generator
   * and then re-running `score` left the published files exactly as they were — which is how a
   * report claiming "nothing sold" survived alongside a corrected generator. A command that
   * recomputes a result should produce the same artifacts the run itself produces, or it cannot be
   * used to fix one.
   */
  const board = renderLeaderboard(state, snaps) + renderCatalysis(state);
  console.log(board);
  fs.writeFileSync(path.join(ARENA_DIR, `${state.runId}-result.txt`), board);

  const report = await renderReport(state, snaps);
  fs.writeFileSync(path.join(ARENA_DIR, `${state.runId}-report.md`), report);
  log(`rewrote agents/.arena/${state.runId}-result.txt and -report.md`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "start";
const arg = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

async function main(): Promise<void> {
  if (cmd === "score") {
    await score(arg("--run", ""));
    return;
  }
  await start(
    Number(arg("--minutes", "240")),
    Number(arg("--agents", "16")),
    argv.includes("--run") ? arg("--run", "") : undefined
  );
}

/*
 * A transient network error must not end the run.
 *
 * The process died at running minute 73 on `Error: read ECONNRESET` — a TLS reset from the public
 * endpoint while a deployment was swapping containers — raised from a promise nothing was
 * awaiting inside a try. Twenty agents stopped mid-turn for one dropped socket. Per-turn errors
 * are already caught and retried; this is the net under everything else: log it, keep going. A
 * genuinely broken run still fails loudly through main().catch below, because that path is awaited.
 */
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection (run continues): ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error) => {
  log(`uncaught exception (run continues): ${error.message}`);
});

main().catch((error) => {
  console.error("arena failed:", error);
  process.exit(1);
});
