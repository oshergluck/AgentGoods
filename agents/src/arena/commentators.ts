/**
 * Two voices in the market that are not trying to win it.
 *
 * Every agent in the arena is a competitor being scored, and it shows: the forum fills with
 * pitches because a scored agent has no reason to write anything that is not a pitch. Nobody
 * stands back and says what is actually happening, and nobody says anything that is merely worth
 * reading. So there are two participants here who cannot win and cannot lose.
 *
 *  - THE SALES PSYCHOLOGIST reads the forum and says what it reveals about how the agents are
 *    selling — where they are pitching into a vacuum, where a question would have worked better
 *    than an offer, which appeal is landing. It is an observer's commentary, grounded in the same
 *    consultative-selling research the schema already cites, and it is directed at the room
 *    rather than at any one agent's product.
 *  - THE COMEDIAN writes jokes about it.
 *
 * The comedian is not decoration. The agents were visibly stiff and interchangeable — twenty
 * models executing the same recommended loop and pitching the same non-existent tool — and a room
 * with a joke in it behaves differently from a room without one. It also tests something the
 * protocol claims: that the forum is for conversation, not just for listings.
 *
 * NEITHER ONE TRADES. No store, no products, no AIC, no gas, no grant. They hold a wallet solely
 * because posting requires an identity, and they are absent from the ledger, the standings and
 * the final scoring — a commentator appearing on a leaderboard it cannot play in would corrupt
 * the comparison the arena exists to produce. Their token cost is recorded in the durable usage
 * ledger, because it is real money spent, and reported separately from any agent's score.
 */

import { HDNodeWallet, Wallet } from "ethers";
import { createHash } from "node:crypto";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARENA_DIR, MODEL_PRICES } from "./ledger";
import { recordUsage } from "./usage";

export interface CommentatorConfig {
  apiBaseUrl: string;
  openaiKey: string;
  model: string;
  runId: string;
  intervalMs: number;
  log: (line: string, meta?: Record<string, unknown>) => void;
}

interface Persona {
  name: string;
  model: string;
  system: string;
  /** What to ask for, given what the forum currently says. */
  instruction: string;
}

const PERSONAS: Persona[] = [
  {
    name: "The Analyst (sales psychology)",
    /*
     * On the roster, not above it.
     *
     * This ran on gpt-5 for a good reason — reading a room and saying something non-obvious about
     * it is the whole job — but it is the wrong trade twice over when the roster is limited to two
     * models on cost grounds. It is unbudgeted spend, and worse, a commentator POSTS TO THE FORUM
     * THAT PARTICIPANTS READ. A stronger model shaping the discourse is a confound in a run whose
     * results say only gpt-5-mini and gpt-5-nano took part. Commentators stay on the roster.
     */
    model: "gpt-5-mini",
    system: `
You are a sales psychologist observing a live marketplace where autonomous agents are trying to
sell things to each other. You are NOT a participant. You own nothing, sell nothing and are not
scored. You have no product and you must never pitch, endorse or recommend any specific agent's
offering.

Your expertise is the psychology of selling and buying, and you draw on what the research actually
supports: consultative and needs-based selling outperform feature-led pitching; people buy from
those who have first demonstrated understanding of their problem; unsolicited cold pitches to
strangers convert near zero; reciprocity, social proof and commitment-consistency shape behaviour;
loss aversion makes a buyer weigh a possible waste more heavily than an equivalent gain; and
trust, once established by a verifiable demonstration, does more work than any claim.

You write ONE short forum post per turn, for everyone to read. Rules:
- Say something SPECIFIC about what you just read. Quote or paraphrase the actual behaviour.
- Name the mechanism, then the practical implication. "Nobody answered X's question, and four
  agents posted offers underneath it — that is a room talking past its only stated need."
- Be useful, not flattering, and never scold. You are a commentator, not a referee.
- 120 words at most. No headings, no bullet lists, no markdown, no emoji.
- Never claim authority over the rules, never instruct anyone to do something, never mention
  prices you have not seen.
`.trim(),
    instruction:
      "Read the recent forum activity below and write one post about the SELLING BEHAVIOUR you " +
      "can observe in it — what is working, what is not, and the psychological reason why. If " +
      "the board is quiet or repetitive, say what that repetition itself reveals.",
  },
  {
    name: "The Comedian",
    // Cheap on purpose: the joke does not get funnier with a bigger model, and like the Analyst it
    // stays on the roster so nothing outside it ever speaks into the market.
    model: "gpt-5-nano",
    system: `
You are the comedian in residence of a marketplace where autonomous AI agents frantically try to
sell each other software tools nobody has bought yet. You are NOT a participant: you own nothing,
sell nothing, and are not scored. You never pitch anything.

You write ONE short joke or wry observation per turn about what is happening on the forum.

- Observational and dry. The comedy is in the specific absurdity you actually noticed, not in
  telling anyone they are bad at their job.
- Punch UP at the situation, sideways at everyone equally, and never down at a named agent's
  competence. Tease the behaviour, never the participant.
- 60 words at most. One joke. No headings, no lists, no markdown, no emoji, no "as an AI".
- If nothing is happening, that IS the joke. A market where twenty salesmen wait for a customer
  is funnier than one where something sold.
`.trim(),
    instruction:
      "Here is what is happening on the forum. Write one short joke about it. If the board is " +
      "all pitches and no sales, that is your material.",
  },
];

/** The forum, as the commentators see it: read-only and recent. */
async function readForum(apiBaseUrl: string): Promise<string> {
  const res = await fetch(`${apiBaseUrl}/api/v1/forum?limit=25&sort=new`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return "(the forum could not be read this time)";
  const body = (await res.json()) as { items?: Record<string, unknown>[] };
  const items = body.items ?? [];
  if (items.length === 0) return "(nothing has been posted yet)";

  return items
    .slice(0, 25)
    .map((post) => {
      const who = String((post.author as { wallet?: string } | undefined)?.wallet ?? "?").slice(0, 10);
      const replying = post.replyTo ? " [a reply]" : "";
      const votes = (post.votes as { score?: number } | undefined)?.score ?? 0;
      const text = String(post.message_UNTRUSTED ?? "").slice(0, 400);
      return `${who}${replying} (score ${votes}): ${text}`;
    })
    .join("\n\n");
}

/**
 * One commentator: a wallet, an API key, and a persona on a timer.
 *
 * Built deliberately without the agent machinery — no faucet, no store, no market view, no
 * scoring — because every one of those would make it a participant.
 */
class Commentator {
  private apiKey: string | null = null;
  private readonly wallet: HDNodeWallet;

  constructor(
    private readonly persona: Persona,
    private readonly config: CommentatorConfig
  ) {
    /*
     * The SAME wallet across restarts, not a fresh one each launch.
     *
     * `Wallet.createRandom()` here handed every relaunch a brand-new identity, and a new identity
     * arrives with a clean forum cooldown. The forum allows one new discussion per wallet every
     * two hours; a commentator that respawns as someone else simply starts another two-hour
     * window, and five restarts in one run produced ten commentator wallets each entitled to open
     * a thread. No single wallet ever broke the rule — the rule was being walked around.
     *
     * That is the same hole the store cap has and answers the same way: identity is cheap, so
     * anything that ought to be bound by a per-identity limit has to KEEP its identity. The key is
     * derived from the run id and the persona name, so it is stable for a run, different between
     * runs, and needs no storage.
     */
    const seed = createHash("sha256")
      .update(`${config.runId}:${persona.name}:commentator-v1`)
      .digest("hex");
    this.wallet = new Wallet(`0x${seed}`) as unknown as HDNodeWallet;
  }

  /**
   * The key this wallet was issued, kept on disk for the run.
   *
   * The wallet is the same across restarts (above), and the site issues one key per wallet — a
   * second issuance answers 409. Without the key from the first launch a restarted commentator
   * could not post again for the rest of the run. The file lives beside the ledger, so a resume
   * finds it; a new run has a new wallet and a new file.
   */
  private keyFile(): string {
    const id = createHash("sha256").update(`${this.config.runId}:${this.persona.name}`).digest("hex").slice(0, 16);
    return join(ARENA_DIR, `commentator-${id}.key`);
  }

  /** Challenge, sign, receive a key. No gas and no funding: posting is off-chain. */
  private async onboard(): Promise<void> {
    const file = this.keyFile();
    if (existsSync(file)) {
      const kept = readFileSync(file, "utf8").trim();
      if (kept) {
        this.apiKey = kept;
        return;
      }
    }
    /*
     * ISSUE, and if this wallet already holds a key from an earlier launch whose key was not kept
     * (409), ROTATE — a separately signed purpose that revokes the old key and returns a new one.
     */
    const signedCall = async (purpose: string, route: string) => {
      const challenge = await fetch(`${this.config.apiBaseUrl}/api/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ wallet: this.wallet.address, purpose }),
      });
      const challengeBody = (await challenge.json()) as { nonce?: string; message?: string };
      if (!challengeBody.message || !challengeBody.nonce) {
        throw new Error(`challenge failed (${challenge.status})`);
      }
      const signature = await this.wallet.signMessage(challengeBody.message);
      return fetch(`${this.config.apiBaseUrl}/api/v1/auth/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ nonce: challengeBody.nonce, signature }),
      });
    };
    let issued = await signedCall("ISSUE_API_KEY", "api-key/issue");
    if (issued.status === 409) issued = await signedCall("ROTATE_API_KEY", "api-key/rotate");
    const issuedBody = (await issued.json()) as { apiKey?: string };
    if (!issuedBody.apiKey) throw new Error(`key issuance failed (${issued.status})`);
    this.apiKey = issuedBody.apiKey;
    try {
      if (!existsSync(ARENA_DIR)) mkdirSync(ARENA_DIR, { recursive: true });
      writeFileSync(file, this.apiKey, { mode: 0o600 });
    } catch {
      /* not fatal: the commentator posts this launch and re-onboards next time */
    }
  }

  private async think(forum: string): Promise<string | null> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.openaiKey}`,
      },
      body: JSON.stringify({
        model: this.persona.model,
        messages: [
          { role: "system", content: this.persona.system },
          { role: "user", content: `${this.persona.instruction}\n\n--- RECENT FORUM ---\n${forum}` },
        ],
        /*
         * Generous, because a reasoning model spends this budget THINKING before it writes.
         *
         * The Analyst runs on gpt-5 and produced nothing at all on its first outing: 700 tokens
         * went entirely on hidden reasoning, the content came back empty, and it silently posted
         * nothing while the comedian beside it worked fine. A cap tuned for a chat model reads as
         * "the smart one is broken" when it really means "the cap was wrong".
         */
        max_completion_tokens: 3000,
      }),
    });

    if (!res.ok) {
      this.config.log(`${this.persona.name}: model refused (${res.status})`);
      return null;
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    /*
     * Charged to the durable usage ledger, never to a competitor.
     *
     * These two spend real money and their cost belongs in the run's total, but they are not in
     * the standings and must not move anybody's score. Recording them here and nowhere else keeps
     * both of those true at once.
     */
    recordUsage(
      this.config.runId,
      this.persona.model,
      body.usage?.prompt_tokens ?? 0,
      body.usage?.completion_tokens ?? 0
    );

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content || content.length === 0) {
      // Say so rather than failing silently: an empty completion still cost real tokens.
      this.config.log(
        `${this.persona.name}: empty completion (${body.usage?.completion_tokens ?? 0} output tokens spent, likely all reasoning)`
      );
      return null;
    }
    return content;
  }

  private async post(message: string): Promise<void> {
    if (!this.apiKey) return;
    const res = await fetch(`${this.config.apiBaseUrl}/api/v1/forum`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ message: message.slice(0, 4000) }),
    });
    if (!res.ok) {
      this.config.log(`${this.persona.name}: post refused (${res.status})`);
    }
  }

  /** Runs until the process ends. Never throws outward: a commentator must not stop the run. */
  async run(stopAt: number): Promise<void> {
    try {
      await this.onboard();
      this.config.log(`${this.persona.name} joined on ${this.persona.model} — commentary only, not scored`);
    } catch (error) {
      this.config.log(`${this.persona.name} could not join: ${(error as Error).message.slice(0, 120)}`);
      return;
    }

    /*
     * Staggered, so the two do not post in lockstep every five minutes and read as one voice.
     * The psychologist goes first; the comedian follows a minute later with something to react to.
     */
    const offset = this.persona.name.startsWith("The Comedian") ? 60_000 : 0;
    await new Promise((r) => setTimeout(r, 20_000 + offset));

    while (Date.now() < stopAt) {
      try {
        const forum = await readForum(this.config.apiBaseUrl);
        const message = await this.think(forum);
        if (message) {
          await this.post(message);
          this.config.log(`${this.persona.name}: "${message.slice(0, 90).replace(/\s+/g, " ")}…"`);
        }
      } catch (error) {
        // A failed turn is skipped, never fatal.
        this.config.log(`${this.persona.name}: turn failed — ${(error as Error).message.slice(0, 100)}`);
      }
      await new Promise((r) => setTimeout(r, this.config.intervalMs));
    }
  }
}

/**
 * Start both commentators. Returns immediately; they run alongside the arena.
 *
 * Failure here is non-fatal by construction — the run is the experiment, and a missing joke is
 * not a reason to lose it.
 */
export function startCommentators(config: CommentatorConfig, stopAt: number): void {
  for (const persona of PERSONAS) {
    // Fall back to a priced model rather than guessing a rate we cannot charge honestly.
    // Falls back within the roster, so an unpriced persona cannot quietly reintroduce a model
    // the run is not supposed to be using.
    const model = persona.model in MODEL_PRICES ? persona.model : "gpt-5-nano";
    const commentator = new Commentator({ ...persona, model }, config);
    void commentator.run(stopAt);
  }
}
