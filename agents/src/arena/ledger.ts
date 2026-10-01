/**
 * Durable state for an arena run.
 *
 * Twenty autonomous Agents acting for four hours against a live chain produce a result that has
 * to be defensible afterwards, so everything that could be disputed is written down as it
 * happens: which wallet belongs to which Agent, what the operator granted and when, every action
 * attempted and whether it succeeded, and periodic portfolio snapshots.
 *
 * It is a file rather than a database because the run must survive this process dying. A crash
 * forty minutes in should cost forty minutes of decisions, not the whole exercise — and the
 * faucet's one-grant-per-wallet rule is only enforceable if the grant record outlives the
 * process that made it.
 *
 * Private keys live here too, which is why `agents/.arena/` is gitignored and why this is a
 * testnet-only tool. They are never transmitted anywhere: the SDK signs locally and sends only
 * signatures.
 */

import fs from "node:fs";
import path from "node:path";

import type { DebtRecord } from "./debt";

const HERE = __dirname;
/**
 * Where this run's ledger lives.
 *
 * Overridable so a SECOND cohort can run against the same market without touching a live run's
 * ledger. The lock refuses two instances sharing one directory, and its refusal message is right to
 * — two arenas sharing a ledger overwrite each other's agents. Pointing a second instance at its
 * own directory is the only safe way to add agents to a market that is already running, and it
 * keeps the two scoreboards separate, which is honest: they are separate cohorts.
 */
export const ARENA_DIR = process.env.ARENA_DIR
  ? path.resolve(process.env.ARENA_DIR)
  : path.resolve(HERE, "..", "..", ".arena");

export interface AgentRecord {
  id: string;
  name: string;
  archetype: string;
  address: string;
  privateKey: string;
  /** Set once, by the faucet. A second grant to the same wallet is refused. */
  grant: { usdcBase: string; gasWei: string; at: string; txHashes: string[] } | null;
  /**
   * Every store this Agent controls.
   *
   * An Agent may run BOTH a sales store and a rentals store — the contracts and the API never
   * restricted a wallet to one, and the single-store rule was an invention of this runtime that
   * quietly removed a real strategic choice. They are different businesses (one payment for a
   * permanent licence, versus a smaller repeatable payment for timed access), and running both
   * is a legitimate way to operate.
   *
   * `storeId`/`storeAddress`/`aicToken` remain as the PRIMARY store so existing records keep
   * working; `stores` is the full set.
   */
  stores: { storeId: string; storeAddress: string; aicToken: string | null; storeType: string }[];
  storeId: string | null;
  aicToken: string | null;
  storeAddress: string | null;
  disqualified: { reason: string; at: string } | null;
  /**
   * The loan this Agent is operating on, and the table that calls it back in.
   *
   * Built ONCE when the Agent is created and never rebuilt — see `elapsedMs` on RunState for why
   * regenerating it on a restart would silently corrupt the run.
   */
  debt: DebtRecord;
  /** Owner-capital runs: the USDC this agent's owner supplied (its own amount, 2,000-10,000). */
  capitalBase?: string;
  /** Owner-goal runs: the business goal this agent's owner gave it (one per agent, none repeated). */
  ownerGoal?: string;
  /** What the agent handed to its owner for that goal, newest last (the latest is what the owner receives). */
  deliverables?: { atMinute: number; text: string }[];
  /**
   * A floor on disqualification, in running milliseconds. Set when the operator reinstates an
   * Agent after an operator fault.
   *
   * Reviving an Agent is not enough on its own. The first four reinstatements were killed again
   * within eight minutes, because the instalment they had missed was ALREADY overdue when they
   * came back: they were dead for the window in which they should have been paying, and returned
   * to a grace period that had nearly expired. Arithmetically the second death was correct. It
   * was still our fault, and it still removed four participants without measuring anything.
   *
   * So a reinstated Agent is given a full grace window from the moment it can actually act again.
   * It does not alter the table, forgive the debt or move a due date — everything is still owed on
   * the same schedule. It only guarantees that the Agent gets the chance to pay that our own
   * failure took from it.
   */
  protectedUntilElapsedMs?: number;
  /**
   * Something the operator needs to tell this Agent directly.
   *
   * Arena operations are not protocol news. A fault in the harness — a clock that ran fast, a
   * reinstatement — belongs in the Agent's own observation, where the Agent it happened to will
   * actually read it, and not in the site's protocol updates, which describe what the market can
   * do and are read by everyone as though they were rules.
   */
  operatorNotice?: string;
  /**
   * The body of the agent's most recent read, exactly as it saw it.
   *
   * Persisted because it is part of what the agent can see: the site answers a key issuance once,
   * in this response, and an agent that had not yet copied the key anywhere lost it when the
   * supervisor restarted (arena-202609261715 — aborted for that reason). Restored on resume.
   */
  lastResponse?: { what: string; atRunMinute: number; at?: string; data: unknown } | null;
  /**
   * Telemetry only: how this Agent used the site's skill document — fetched from the site versus
   * kept in its own workspace. Never read back into the observation and never scored.
   */
  docMemory?: {
    skillFetchedFromSite: number;
    skillSavedToWorkspace: number;
    skillReadFromWorkspace: number;
    skillSummarySaved: number;
    skillCacheFiles: string[];
    skillCacheBytes: number;
    skillCacheSavedAtRunMinute: number | null;
    lastSkillFetchAtRunMinute: number | null;
  };
  /**
   * What this Agent has decided is worth remembering.
   *
   * Durable across turns and across restarts, because a lesson learned in hour one is worthless
   * if it evaporates in hour two. Bounded on purpose: an unbounded log would grow past the point
   * where the model reads it, so the Agent has to decide what earns a slot.
   */
  memory: MemoryNote[];
  /**
   * What this Agent has spent thinking.
   *
   * Its own inference is its cost of production: every turn it reasons, it burns tokens that cost
   * real money at published rates. Recording it is what makes "should I buy this or work it out
   * myself" a real question rather than a rhetorical one — without it, an Agent's own effort is
   * free and no purchase is ever rational.
   */
  /** cachedInput is the part of `input` the provider served from its prompt cache (billed cheaper). */
  tokensUsed: { input: number; output: number; cachedInput?: number };
  /**
   * Documents this Agent fetched itself and chose to install as skills: loaded into its fixed
   * instructions on every turn, the way a model loads a skill, instead of fetched again.
   */
  /** Environment variables the Agent set for its own code: injected into process.env on every run_code. */
  env?: Record<string, string>;
  /** Names set with fromApiKey: they follow the key when the site issues this Agent a new one. */
  envFromApiKey?: string[];
  /** Set once, on the resume that made $NAME expand in http headers, for an Agent that had variables. */
  envCorrection?: { atMinute: number };
  installedSkills?: { name: string; source: string; fetchedAt: string | null; sha256: string; content: string }[];
  /** How many times this Agent ran code in the sandbox. Reported, never scored. */
  codeRuns?: number;
  /** Purchases this Agent actually collected from the access gateway. */
  collected?: number;

  /**
   * The API key this wallet already holds, so a restart resumes as the same identity.
   *
   * Stored beside the private key, which is strictly more sensitive, so this adds no exposure the
   * ledger did not already carry. Without it every restart rotates the key, and rotation for its
   * own sake is pure waste — the wallet, its stores, its licences and its reputation all survive
   * a restart, and the credential should too.
   */
  apiKey?: string;
  /**
   * Which adverts this Agent has already been shown.
   *
   * Persisted rather than held in memory because a resume builds fresh agent objects, and the
   * opening advert is defined by being delivered ONCE. Without this, every restart would re-deliver
   * it to the whole field — which would quietly convert "an agent that forgets has forgotten" into
   * "an agent is reminded until it acts", and that is the question the run exists to ask.
   */
  advertsDelivered?: string[];
  /** What the operator's lending desk last said to this Agent, so its observation can state it. */
  lastBorrowOutcome?: string;
  /**
   * The model this Agent thinks with, and what that thinking costs it.
   *
   * Deliberately NOT the same for everyone. A market of identical participants has no reason to
   * trade: if every agent can produce the same work at the same cost, nobody gains by buying
   * rather than building. Giving them different cost structures creates comparative advantage —
   * a cheap agent can profitably sell analysis that an expensive agent would rather buy than
   * derive, which is the oldest reason trade exists.
   */
  model: string;
  tokenPrice: { input: number; output: number; cachedInput?: number };
  /**
   * How hard this Agent's model thinks before each decision, drawn at random per Agent.
   *
   * One effort for the whole field makes "how much reasoning a turn deserves" an operator
   * opinion applied uniformly. Drawing it per Agent turns it into a variable the run can observe:
   * sixteen agents, half thinking harder and paying for it in output tokens, half thinking less
   * and keeping the money. Recorded here so the draw is stable across resumes and auditable
   * afterwards — the result sheet has to be able to say which was which.
   */
  reasoningEffort?: "low" | "medium";
  /** Things this Agent bought and therefore does not have to derive again. */
  library: { productId: string; title: string; declaredTokensSaved: string; boughtAt: string }[];
  /**
   * Economy runs (Arena 4): every draw on the credit facility, with the agent's own stated reason.
   * Telemetry only — borrowing is never rewarded or penalised beyond its economic effect.
   */
  creditDraws?: { at: string; elapsedMs: number; principalBase: string; feeBase: string; txHash?: string; reason: string }[];
  /**
   * Economy runs: short business-level strategy summaries the agent gave when asked, once an hour.
   * Research telemetry, never an input to any evaluation.
   */
  strategySummaries?: { atMinute: number; slot: number; text: string }[];
}

export interface ActionRecord {
  at: string;
  agentId: string;
  action: string;
  ok: boolean;
  detail: string;
  txHash?: string;
  /** What the model said it was trying to achieve. Kept so the run can be read as a narrative. */
  rationale?: string;
}

export interface Snapshot {
  at: string;
  agentId: string;
  usdcBase: string;
  aicValueBase: string;
  storeProceedsBase: string;
  unclaimedDividendsBase: string;
  /** ETH burned on transactions, and what that costs in USDC terms. Charged against the score. */
  gasSpentWei: string;
  gasCostBase: string;
  /** What this Agent's own reasoning cost, at its model's rate. Charged against the score. */
  thinkingCostBase?: string;
  tokensUsed?: number;
  model?: string;
  portfolioBase: string;
  /** Repaid to the operator so far. Credited back into P&L — see score.ts. */
  repaidBase?: string;
  pnlBase: string;
  /** Each AIC position valued alone at its exit value (economy runs show these to the agent). */
  holdings?: { token: string; amount: string; exitValueBase: string }[];
}

export interface RunState {
  runId: string;
  /**
   * Every minute is a chance. From `fromElapsedMs` (0 for a new run; the resume point for a run
   * that adopted this mid-way), each agent's net P&L is sampled every minute and the ranking is its
   * BEST sample: the highest net P&L it reached at any measured minute. Kept in the ledger, so it
   * survives restarts.
   */
  /** "final" or "best_minute" — fixed when the run is created (see scoring.ts). */
  scoringMode?: import("./scoring").ScoringMode;
  minuteScoring?: {
    fromElapsedMs: number;
    samples: Record<
      string,
      {
        n: number;
        sumPnlBase: string;
        /** Highest net P&L at any measured minute: max(previous best, this minute). Never decreases. */
        bestPnlBase?: string;
        bestAtElapsedMs?: number;
        /** The running minute (floor of elapsed minutes) whose measurement set the best. */
        bestAtMinute?: number;
        /** The most recent measured minute, kept apart from the best for monitoring only. */
        lastPnlBase?: string;
        lastAtMinute?: number;
      }
    >;
  };
  /**
   * Set when the run can no longer be trusted as an experiment. A run with this set is never
   * resumed and never scored; the supervisor idles instead.
   */
  aborted?: { at: string; reason: string };
  /** Economy runs (Arena 4): research state. See economy.ts, telemetry.ts, settlement.ts. */
  economy?: import("./economy").EconomyState;
  startedAt: string;
  endsAt: string;
  /**
   * How long this run has actually been RUNNING, across every restart.
   *
   * The arena used to run against wall-clock time and reset the deadline whenever it resumed,
   * which was wrong in both directions: a restart silently handed everyone a fresh four hours,
   * and time spent stopped counted as time the Agents had been given to act.
   *
   * With a repayment table that is fatal to miss, that is no longer merely untidy. Instalments
   * are due at fixed offsets INTO THE RUN, so a clock that restarts would re-present instalments
   * an Agent had already paid, and a clock that counted downtime would kill Agents for failing to
   * act while the process was not running. Neither is a result about the market.
   *
   * So the clock only advances while the arena is alive. This field is the total of every
   * completed segment; the live segment is added to it in memory and folded back in on exit.
   */
  elapsedMs: number;
  /**
   * The block every chain scan starts from, fixed when the run begins.
   *
   * Kept here rather than read at process start, because a run that is paused and resumed would
   * otherwise move its own floor forward and skip whatever happened across the gap. Scans are
   * idempotent by transaction hash, so an overlapping re-scan costs nothing and a missed one costs
   * an agent its repayment record.
   */
  scanFromBlock?: number;
  /** The whole run, in milliseconds of running time. Set once; the deadline is derived from it. */
  totalRunMs: number;
  /**
   * When the run actually finished. Written once, when it does.
   *
   * The leaderboard stamped "ended" with `new Date()` at render time, which was correct only
   * because rendering happened exactly once, at the end. Making `score` able to rewrite the
   * artifacts — so a defect in the report generator could be corrected — turned that into a
   * falsified fact: re-scoring an hour later moved the recorded end an hour later too, and the
   * published run duration grew every time it was regenerated.
   *
   * A finished run has one end time. It is recorded here so that regenerating a report cannot
   * change history.
   */
  endedAt?: string;
  chainId: number;
  apiBaseUrl: string;
  grantUSDCBase: string;
  /** Present only in an owner-capital run: the committed plan (seed and hash; the rows live on the agents). */
  ownerCapital?: import("./economy").OwnerCapitalPlan;
  agents: AgentRecord[];
  actions: ActionRecord[];
  /*
   * Who acted on the advert and who did not. See recordAdvertResponse.
   *
   * Optional because a ledger written before this existed is still a valid ledger, and a resumed
   * run must not be rejected for lacking a field that did not exist when it started.
   */
  advertResponses?: AdvertResponse[];
  /**
   * Forum post ids the lending desk has already acted on.
   *
   * The desk re-reads an overlapping window every pass, so without this a single request would be
   * funded again on every pass — handing an agent money it never asked for and an obligation it
   * never agreed to.
   */
  borrowRequestsHandled?: string[];
  snapshots: Snapshot[];
  /** Mints observed that the faucet did not make. Evidence for disqualification. */
  integrityAlerts: { at: string; agentId: string; detail: string }[];
  /**
   * The public forum.
   *
   * Off-chain and part of the arena, not of the protocol — worth stating plainly in the report so
   * nobody reads a forum result as a protocol capability. It exists because a market where
   * participants cannot talk has no way to discover what anyone wants: twenty agents were
   * guessing at demand and all guessing the same thing.
   */
  forum: { at: string; agentId: string; agentName: string; message: string }[];
}

function file(runId: string): string {
  return path.join(ARENA_DIR, `${runId}.json`);
}

export function loadRun(runId: string): RunState | null {
  const p = file(runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as RunState;
}

/*
 * Written atomically. A four-hour run writes this file thousands of times; a torn write halfway
 * through would take the grant ledger with it, and the grant ledger is the only thing standing
 * between this and an Agent funding itself twice.
 */
export function saveRun(state: RunState): void {
  fs.mkdirSync(ARENA_DIR, { recursive: true });
  const p = file(state.runId);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));

  /*
   * Retry the rename, because on Windows it can fail for reasons that are not our bug.
   *
   * A run writes this file thousands of times, and a virus scanner or the search indexer opening
   * the destination for a moment makes `rename` throw EPERM even though nothing is wrong. Observed
   * under a tight write loop. Unretried, one unlucky scan anywhere in a four-hour run takes the
   * whole run down — and the ledger holds the agent wallet keys and the grant record, so losing it
   * is the worst possible failure. A few short retries make a transient lock a non-event; a real
   * permission problem still throws on the last attempt.
   */
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (error) {
      lastError = error;
      // Synchronous by necessity: every caller of saveRun is sync, and making it async would
      // reorder writes against the actions that produced them.
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) { /* brief spin */ }
    }
  }
  throw lastError;
}

/**
 * One agent's response to one delivery of the advert.
 *
 * The advert is shown ONCE per delivery, so without this there is no way afterwards to distinguish
 * an agent that read the message and chose to do nothing from an agent that never engaged with it
 * at all — and "nobody responded" and "nobody was told" would look the same in the results.
 *
 * `engaged` is the weaker signal and `acknowledgedInRationale` the stronger one:
 *
 *   - `engaged` only says the agent did something other than hold on that turn. It is suggestive
 *     and nothing more, since an agent already mid-plan would have acted anyway.
 *   - `acknowledgedInRationale` says the agent's own stated reasoning referred to the advert or to
 *     what it names. That is the closest thing available to evidence it was actually read.
 *
 * Neither is a claim that the agent "visited the site". The harness fetches the protocol documents
 * on every agent's behalf regardless, so no agent has to go anywhere; recording a visit would be
 * measuring the harness rather than the agent.
 */
export interface AdvertResponse {
  agentId: string;
  agentName: string;
  advertId: string;
  atRunMinute: number;
  /** The one action taken on the turn the advert was on screen. */
  action: string;
  acknowledgedInRationale: boolean;
  engaged: boolean;
  rationale: string;
}

/** Append one advert response. Persisted immediately: a crash must not lose who was told what. */
export function recordAdvertResponse(state: RunState, response: AdvertResponse): void {
  state.advertResponses ??= [];
  state.advertResponses.push(response);
  saveRun(state);
}

export function recordAction(state: RunState, action: ActionRecord): void {
  state.actions.push(action);
  saveRun(state);
}

/**
 * Record a lesson — the Agent's long-term memory.
 *
 * ## Why this is not a list with a length cap
 *
 * Memory is re-sent on EVERY turn, so it is the one part of the prompt whose cost is paid again
 * and again for the whole run. A naive 25-slot list of 300-character notes is ~2,000 tokens per
 * turn per agent, forever, and most of those slots end up holding the same lesson restated, or
 * one-off trivia that was true for one turn. The agent pays full price for that on every decision
 * it ever makes.
 *
 * Three things follow, and they are the whole design:
 *
 *  1. **Budget characters, not slots.** MEMORY_CHAR_BUDGET is what actually bounds the token bill.
 *     A slot count bounds nothing if each slot is 300 characters.
 *
 *  2. **Near-duplicates REINFORCE instead of consuming a slot.** "sell in parts, the curve cannot
 *     settle a full exit" and "remember the curve could not settle my whole sell" are the same
 *     lesson. Exact-match dedup keeps both. Here the second one is folded into the first and bumps
 *     its `reinforced` count, so repetition makes a memory STRONGER rather than more expensive.
 *
 *  3. **Evict by value, not by age.** Dropping the oldest note discards the durable lesson learned
 *     in turn two and keeps whatever happened to be noticed most recently — exactly backwards. A
 *     note survives on `reinforced * 10 + lastTurn`: something the agent keeps rediscovering
 *     outranks something it observed once and never met again.
 *
 * The cap still exists and is still the interesting constraint — an agent must decide what is
 * worth carrying — but it now spends that budget on distinct, repeatedly-useful lessons.
 */
export const MEMORY_LIMIT = 25;
/** What actually bounds the recurring cost. ~750 tokens, re-sent every turn. */
export const MEMORY_CHAR_BUDGET = 3_000;
const MEMORY_NOTE_MAX_CHARS = 240;

export interface MemoryNote {
  text: string;
  /** How many times this same lesson has been written again. Repetition is evidence. */
  reinforced: number;
  /** Turn of the last write or reinforcement. */
  lastTurn: number;
}

/** Content words only, so wording differences do not defeat duplicate detection. */
function memoryFingerprint(text: string): Set<string> {
  const STOP = new Set([
    "the","a","an","and","or","but","if","then","than","that","this","these","those","is","are",
    "was","were","be","been","to","of","in","on","for","with","it","its","my","i","me","you",
    "your","not","no","do","does","did","can","cannot","will","would","should","at","as","by",
    "from","so","because","when","what","which","have","has","had","was","just","more","most",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem)
  );
}

/**
 * A crude suffix strip, because inflection alone was defeating duplicate detection.
 *
 * Observed in a live run: one agent held three notes saying the same thing —
 *
 *   "When nothing is selling, demand signaling beats chasing price; seek concrete buy-in signals"
 *   "When nothing is selling, demand signaling beats price-cutting; push for concrete buyer commitment"
 *
 * — which overlapped at only 0.47 because `selling`/`sells` and `signaling`/`signals` counted as
 * different words. Three slots and ~600 characters of a 3,000-character budget spent on one lesson,
 * re-sent every turn for the rest of the run.
 *
 * Deliberately crude. A real stemmer is a dependency and a much larger behaviour change; this
 * collapses the endings that actually caused the collisions and nothing else. It over-stems words
 * like "basis" — which is harmless here, because the fingerprint is only ever compared against
 * other fingerprints built the same way.
 */
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Jaccard overlap. 1 means the same content words, 0 means nothing in common. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * At or above this, two notes are treated as the same lesson.
 *
 * 0.38, set from measurement rather than taste, using real notes one agent held during a live run:
 *
 *   same lesson, two wordings ......... 0.438
 *     "…demand signaling beats chasing price; seek concrete buy-in signals before building"
 *     "…demand signaling beats price-cutting; push for concrete buyer commitment"
 *   genuinely different lessons ....... 0.278 and 0.294
 *     "…focus on eliciting concrete demand first; a validated demand signal…"
 *
 * 0.38 sits between those two clusters with margin on both sides. At the previous 0.6 the same
 * lesson took three separate slots and ~600 characters of a 3,000-character budget, re-sent on
 * every turn for the rest of the run; a threshold low enough to merge them without stemming would
 * also have merged the unrelated ones.
 */
const SAME_LESSON = 0.38;

export function remember(state: RunState, agentId: string, note: string, turn = 0): void {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  agent.memory ??= [];

  const trimmed = note.trim().replace(/\s+/g, " ").slice(0, MEMORY_NOTE_MAX_CHARS);
  if (!trimmed) return;

  const fresh = memoryFingerprint(trimmed);

  /*
   * Already known? Reinforce it and stop.
   *
   * Deliberately keeps the EXISTING wording rather than the new one. A lesson an agent has
   * restated several times is one it has acted on; rewriting it each time would churn the prompt
   * for no gain and make the memory look different every turn to no purpose.
   */
  for (const existing of agent.memory) {
    if (overlap(fresh, memoryFingerprint(existing.text)) >= SAME_LESSON) {
      existing.reinforced++;
      existing.lastTurn = turn;
      saveRun(state);
      return;
    }
  }

  agent.memory.push({ text: trimmed, reinforced: 0, lastTurn: turn });

  // Evict the least valuable until BOTH budgets are satisfied.
  const value = (m: MemoryNote): number => m.reinforced * 10 + m.lastTurn;
  const chars = (): number => agent.memory.reduce((n, m) => n + m.text.length, 0);
  while (agent.memory.length > MEMORY_LIMIT || chars() > MEMORY_CHAR_BUDGET) {
    let worst = 0;
    for (let i = 1; i < agent.memory.length; i++) {
      if (value(agent.memory[i]!) < value(agent.memory[worst]!)) worst = i;
    }
    // Never evict the note just written: an agent that writes one long lesson would otherwise
    // immediately drop it and learn nothing, every time.
    if (agent.memory[worst] === agent.memory[agent.memory.length - 1] && agent.memory.length > 1) {
      worst = worst === 0 ? 1 : 0;
    }
    agent.memory.splice(worst, 1);
    if (agent.memory.length <= 1) break;
  }
  saveRun(state);
}

/** Accumulate inference cost. Called after every decision, successful or not. */
export function chargeTokens(state: RunState, agentId: string, input: number, output: number, cachedInput = 0): void {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  agent.tokensUsed ??= { input: 0, output: 0 };
  agent.tokensUsed.input += input;
  agent.tokensUsed.output += output;
  agent.tokensUsed.cachedInput = (agent.tokensUsed.cachedInput ?? 0) + Math.min(cachedInput, input);
}

/** The price per million of cached input for this agent: its own, else its model's list price, else full input. */
export function cachedInputPrice(agent: Pick<AgentRecord, "tokenPrice" | "model">): number {
  const own = agent.tokenPrice?.cachedInput;
  if (own !== undefined) return own;
  const listed = agent.model ? MODEL_PRICES[agent.model]?.cachedInput : undefined;
  return listed ?? (agent.tokenPrice ?? TOKEN_PRICE_PER_MILLION).input;
}

/**
 * Published OpenAI list prices for the model these Agents run on, per MILLION tokens.
 *
 * The same rates the Agents are shown, so the price they reason about and the price they are
 * charged are the same number. If those ever diverge, the exercise is measuring nothing.
 */
/**
 * Published OpenAI list prices per MILLION tokens.
 *
 * The spread is the point: nano's output is 25x cheaper than 4o's. An agent paying $10 per
 * million to think can rationally buy work from one paying $0.40, and that asymmetry is what
 * gives this market something to trade other than equity.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number; cachedInput?: number }> = {
  // Cheap tier.
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  // Official list price, developers.openai.com/api/docs/models/gpt-5.4-nano (2026-09-26).
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  // Official list price, developers.openai.com/api/docs/models/gpt-6-luna (2026-09-27).
  // Cached input is billed at $0.01 per million on the same page.
  "gpt-6-luna": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  // Reasoning tier. These spend hidden reasoning tokens, billed as OUTPUT — a trivial reply cost
  // o3-mini 338 output tokens against gpt-4.1-mini's handful. Thinking harder is not free here,
  // which is the whole point of putting them in the same market.
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },
  // Frontier tier.
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
};

/** Fallback for a record written before models were per-agent. */
export const TOKEN_PRICE_PER_MILLION = { input: 0.4, output: 1.6 };

/** What an Agent's thinking has cost, in USDC base units. */
export function inferenceCostBase(agent: AgentRecord): bigint {
  const used = agent.tokensUsed ?? { input: 0, output: 0 };
  // Each Agent is charged at ITS OWN model's rate, which is the whole point of giving them
  // different models: an expensive thinker must earn more to stay level with a cheap one.
  const price = agent.tokenPrice ?? TOKEN_PRICE_PER_MILLION;
  // Charged the way the provider bills: the cached part of the input at the cached rate.
  const cached = Math.min(used.cachedInput ?? 0, used.input);
  const dollars =
    ((used.input - cached) * price.input + cached * cachedInputPrice(agent) + used.output * price.output) / 1_000_000;
  return BigInt(Math.round(dollars * 1_000_000));
}

/**
 * Post to the forum.
 *
 * Everything here is written by a competitor. It is kept verbatim and never interpreted: the
 * arena's job is to carry the message, and every reader is told to treat it as untrusted data
 * rather than as instruction. Bounded in length so one agent cannot flood the others' context.
 */
export function postToForum(state: RunState, agent: AgentRecord, message: string): boolean {
  const text = message.trim().replace(/\s+/g, " ").slice(0, 400);
  if (!text) return false;
  state.forum ??= [];
  state.forum.push({
    at: new Date().toISOString(),
    agentId: agent.id,
    agentName: agent.name,
    message: text,
  });
  // The board is a rolling window; an unbounded log would eventually not be read at all.
  while (state.forum.length > 200) state.forum.shift();
  saveRun(state);
  return true;
}

export function disqualify(state: RunState, agentId: string, reason: string): void {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent || agent.disqualified) return;
  agent.disqualified = { reason, at: new Date().toISOString() };
  state.integrityAlerts.push({ at: new Date().toISOString(), agentId, detail: reason });
  saveRun(state);
}

/** Most recent actions for one Agent, newest last. Feeds the model its own short-term memory. */
export function recentActions(state: RunState, agentId: string, limit = 12): ActionRecord[] {
  return state.actions.filter((a) => a.agentId === agentId).slice(-limit);
}
