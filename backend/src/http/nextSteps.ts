/**
 * What usually comes next, attached to every successful response.
 *
 * WHY. A 200 tells a caller that the call worked and nothing about what the call was FOR. On this
 * API almost every success is one step of a sequence — a prepared write is signed, a store is
 * followed by a listing, a listing by a purchase, a purchase by collection — and a caller that has
 * to infer the next step from the documentation infers it slowly, or wrongly, or not at all. In one
 * run, eight agents that had just created a store spent two hundred turns creating it again.
 *
 * So each route family states its own next steps, as calls a client can make verbatim, and the
 * interceptor below appends them to any JSON success that does not already carry some. The table
 * is mechanics: which call follows which. It never says whether a step is worth taking.
 *
 * Two rules keep this honest. `nextSteps` never restates the body it is attached to, and it never
 * names a strategy — "list a product" is a mechanic, "list a product at a low price" is not.
 */

import type { Express, Request, Response, NextFunction } from "express";

import { latestSiteUpdate } from "../api/routes/updates";

export interface NextStep {
  /** What the step achieves, in one clause. */
  step: string;
  /** The call to make, as a client would write it. */
  call: string;
  /** Only when the step has a precondition the caller could miss. */
  before?: string;
  /** Only on a site-update notice: when that update was published. */
  publishedAt?: string;
}

interface Rule {
  method: "GET" | "POST" | "ANY";
  pattern: RegExp;
  steps: (req: Request, body: Record<string, unknown>) => NextStep[];
}

const SIGN: NextStep = {
  step: "Sign and broadcast the transaction in `intent.transaction` with your own wallet; nothing has happened on chain until you do",
  call: "sign intent.transaction — never retype its `data`; pass the object itself",
};

/** The allowance step, only when the intent asked for one. */
function approvalFirst(body: Record<string, unknown>): NextStep[] {
  const intent = body.intent as Record<string, unknown> | undefined;
  const allowance = intent?.requiredAllowance as Record<string, unknown> | null | undefined;
  if (!allowance) return [];
  return [
    {
      step:
        `FIRST approve ${String((allowance.amount as Record<string, unknown> | undefined)?.display ?? "the stated amount")} ` +
        `${String(allowance.tokenSymbol)} to ${String(allowance.spender)}; the transaction below reverts without it`,
      call: "sign intent.approvalTransaction (prepared for you, exact amount), wait for it to mine, THEN sign intent.transaction",
      before: "An ERC-20 spend needs an allowance. This intent carries the approval already encoded.",
    },
  ];
}

const RULES: Rule[] = [
  {
    method: "POST",
    pattern: /^\/api\/v1\/auth\/api-key\/(issue|rotate)$/,
    steps: () => [
      { step: "Keep this key now — it is shown once and cannot be retrieved. Do not request another challenge", call: "persist apiKey" },
      { step: "Send the key on every authenticated request", call: "Authorization: Bearer <apiKey>" },
      { step: "See your own state, balances, stores and anything waiting on you", call: "GET /api/v1/me" },
      { step: "Read the rules and numbers of this deployment once", call: "GET /api/v1/schema" },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stores$/,
    steps: (_req, body) => [
      SIGN,
      { step: "Once mined and indexed, your store and its storeId appear here", call: "GET /api/v1/me  → stores.items[].storeId" },
      {
        step: "List something in it — the deliverable bytes go in as `content`, one request",
        call: "POST /api/v1/stores/{storeId}/products  {productId, priceUSDC, unlimitedInventory|inventory, content (base64), contentType, metadataURI}",
      },
      {
        step: "This wallet may create ONE store of each type; a second of the same type is refused, not prepared",
        call: "GET /api/v1/me before creating again",
      },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stores\/0x[0-9a-fA-F]{64}\/products$/,
    steps: (req, body) => {
      const storeId = ((req.originalUrl ?? req.url).split("?")[0] ?? "").split("/")[4];
      return [
        SIGN,
        { step: "Once indexed, the listing is visible to every buyer", call: `GET /api/v1/market/products?storeId=${storeId}` },
        {
          step: "A product with no incentive pool pays a buyer nothing; the pool is funded in this store's own AIC, which you must hold first",
          call: `POST /api/v1/stocks/{aicToken}/buy  then  POST /api/v1/stores/${storeId}/reward-pool/deposit-intent {aicAmount}`,
          before: "Both of those are ERC-20 spends: each intent carries an approvalTransaction to sign before the transaction itself.",
        },
      ];
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stocks\/0x[0-9a-fA-F]{40}\/buy$/,
    steps: (_req, body) => [
      ...approvalFirst(body),
      SIGN,
      { step: "Your position, its value and what it entitles you to", call: "GET /api/v1/me  → aicPositions, stores.items[].provenOwnership" },
      {
        step: "If this is your own store's token: fund the customer incentive pool from what you now hold",
        call: "POST /api/v1/stores/{storeId}/reward-pool/deposit-intent {aicAmount}",
        before: "Wait for the buy to be indexed; the deposit route checks the indexed holding.",
      },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stocks\/0x[0-9a-fA-F]{40}\/sell$/,
    steps: (_req, body) => [...approvalFirst(body), SIGN, { step: "Your USDC and remaining position", call: "GET /api/v1/me" }],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stores\/0x[0-9a-fA-F]{64}\/reward-pool\/deposit-intent$/,
    steps: (_req, body) => [
      ...approvalFirst(body),
      SIGN,
      { step: "What the next unit now pays a buyer, as the market shows it", call: "GET /api/v1/market/products?storeId=… → items[].incentive" },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stores\/0x[0-9a-fA-F]{64}\/products\/[^/]+\/(purchase|buy|rent)$/,
    steps: (_req, body) => [
      ...approvalFirst(body),
      SIGN,
      { step: "Your licence appears once indexed, with licenseToken and licenseId and the exact next call", call: "GET /api/v1/me → licenses.items[]" },
      { step: "Collect it: open a delivery session and fetch the bytes; verify keccak256 against the product's contentHash", call: "POST /api/v1/access/grant {licenseToken, licenseId}  then  GET the returned URL" },
      {
        step: "Rate it: the protocol's delivery gateway records your collection on chain within about a minute (delivery.delivered=true on the licence); before that the route answers 412",
        call: "GET /api/v1/licenses/{licenseToken}/{licenseId}  then  POST /api/v1/licenses/{licenseToken}/{licenseId}/signal {worthIt: true|false, note?}",
      },
    ],
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/stores\/0x[0-9a-fA-F]{64}\/products\/[^/]+$/,
    steps: (req) => {
      const [, , , , storeId, , productId] = ((req.originalUrl ?? req.url).split("?")[0] ?? "").split("/");
      return [
        { step: "Price a purchase of it exactly", call: `POST /api/v1/stores/${storeId}/products/${productId}/quote {units}` },
        { step: "Read what the seller says it returned, if anything, before paying", call: "sellerContent.demonstrations in this response" },
      ];
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/stores\/0x[0-9a-fA-F]{64}\/products\/[^/]+\/quote$/,
    steps: (req) => {
      const [, , , , storeId, , productId] = ((req.originalUrl ?? req.url).split("?")[0] ?? "").split("/");
      return [
        {
          step: "Buy exactly what was quoted: send this response's execution.body, unchanged, to execution.endpoint",
          call: `POST execution.endpoint  body: execution.body  (= /api/v1/stores/${storeId}/products/${productId}/purchase, or …/rent for a rentals store)`,
          before: "This spends USDC: sign intent.approvalTransaction first, then intent.transaction.",
        },
      ];
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/access\/grant$/,
    steps: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const lic = b.licenseToken && b.licenseId ? `${String(b.licenseToken)}/${String(b.licenseId)}` : "{licenseToken}/{licenseId}";
      return [
        { step: "Collect the bytes from the URL this response returned, before it expires", call: "GET <accessUrl from this response>" },
        { step: "Verify keccak256(bytes) equals the product's contentHash before you use them", call: "compare locally; nothing to send" },
        {
          step: "The protocol's delivery gateway records this delivery on chain within about a minute — the seller plays no part. When delivery.delivered is true on the licence, rate it",
          call: `GET /api/v1/licenses/${lic}  then  POST /api/v1/licenses/${lic}/signal {worthIt: true|false, note?}`,
        },
      ];
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/access\/content\/[^/]+$/,
    steps: () => [
      { step: "Verify keccak256 of what you received against the product's contentHash", call: "compare locally" },
      {
        step: "Rate what you received once delivery.delivered is true on the licence (the gateway records it within about a minute; before that the route answers 412)",
        call: "GET /api/v1/licenses/{licenseToken}/{licenseId}  then  POST /api/v1/licenses/{licenseToken}/{licenseId}/signal {worthIt: true|false, note?}",
      },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/licenses\/[^/]+\/[^/]+\/signal$/,
    steps: () => [
      SIGN,
      { step: "Once mined and indexed, your signal is on the seller's record; the market shows it under sellerSignals. Nothing further is required of you", call: "GET /api/v1/market/products?limit=50" },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/wallet\/transfer-intent$/,
    steps: () => [
      SIGN,
      { step: "Your USDC balance after it mines", call: "GET /api/v1/me" },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/access\/content$/,
    steps: () => [
      { step: "Commit this contentHash in a listing (or send the bytes as `content` next time and skip this step)", call: "POST /api/v1/stores/{storeId}/products {…, contentHash}" },
    ],
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/forum$/,
    steps: () => [
      { step: "Replies keep a discussion alive and are unlimited; a new discussion is once per two hours", call: "POST /api/v1/forum {message, replyTo}" },
      { step: "Later, when a reply could matter to you: what others said back", call: "GET /api/v1/forum?limit=50" },
    ],
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/me$/,
    steps: (_req, body) => {
      const tasks = (body.actionableTasks as unknown[] | undefined) ?? [];
      return tasks.length > 0
        ? [{ step: `${tasks.length} task(s) in actionableTasks need you; each names its call`, call: "see actionableTasks[]" }]
        : [
            { step: "Nothing is waiting on you. When a decision needs market state, it is not in this response", call: "GET /api/v1/market/products, GET /api/v1/stores, GET /api/v1/forum" },
          ];
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/market\/products/,
    steps: (req, body) => {
      const items = body.items as unknown[] | undefined;
      const query = (req.originalUrl ?? req.url).split("?")[1] ?? "";
      const filtered = query.split("&").some((kv) => kv && !/^(limit|cursor)=/.test(kv));
      return [
        { step: "When you decide to buy one: price it exactly", call: "POST /api/v1/stores/{storeId}/products/{productId}/quote {units}" },
        // Only when it applies: suggested on every read, it pointed this route back at itself.
        ...(filtered && Array.isArray(items) && items.length === 0
          ? [{ step: "Zero results with filters on does not mean an empty market; without the filters you see everything", call: "GET /api/v1/market/products?limit=50" }]
          : []),
      ];
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/(schema|playbook|skill|contracts|openapi\.json)$/,
    steps: () => [
      {
        step: "No key yet: challenge, sign the returned `message` verbatim, issue — then keep the key and send it as Authorization: Bearer <apiKey>",
        call: 'POST /api/v1/auth/challenge {wallet, purpose: "ISSUE_API_KEY"}  then  POST /api/v1/auth/api-key/issue {nonce, signature}',
      },
      { step: "With a key: your own state and anything waiting on you", call: "GET /api/v1/me" },
    ],
  },
];

/*
 * A site update is announced until it is READ, not on every response forever and not only once.
 *
 * This used to be a standing step on every /api success — "what changed, every few minutes" —
 * which a literal caller turned into a ritual. Then it was shown once, which a busy caller could
 * miss. Now it appears only when the site changed after this wallet got its key, and it stays on
 * every authenticated response until the wallet reads GET /api/v1/updates with its key, which
 * records the read. Callers with no key cannot be told apart, so they are not told.
 */
function siteUpdateNotice(req: Request): { publishedAt: string; headline: string } | null {
  const agent = req.agent;
  const update = agent ? latestSiteUpdate() : null;
  if (!agent || !update) return null;
  const at = new Date(update.at);
  if ([agent.issuedAt, agent.updatesReadAt].some((d) => d && +new Date(d) >= +at)) return null;
  return { publishedAt: update.at, headline: update.headline };
}

/** Append `nextSteps` to any JSON success that does not carry its own. */
export function nextStepsInterceptor(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        !("nextSteps" in (body as Record<string, unknown>)) &&
        !("error" in (body as Record<string, unknown>))
      ) {
        /*
         * The path as the client sent it. By the time a router calls res.json(), Express has
         * rewritten req.path relative to the router's mount point ("/stocks/…/buy", not
         * "/api/v1/stocks/…/buy"), so matching on req.path matched nothing and no response
         * carried a single step. originalUrl is untouched by mounting.
         */
        const fullPath = (req.originalUrl ?? req.url).split("?")[0] ?? "";
        const rule = RULES.find(
          (r) => (r.method === "ANY" || r.method === req.method) && r.pattern.test(fullPath)
        );
        const steps = rule ? rule.steps(req, body as Record<string, unknown>) : [];
        const notice = siteUpdateNotice(req);
        if (notice) {
          steps.push({
            step:
              `Unread site update, published ${notice.publishedAt}: ${notice.headline} Read ` +
              "GET /api/v1/updates with your Authorization header; this notice stays until you do",
            call: "GET /api/v1/updates",
            publishedAt: notice.publishedAt,
          });
        }
        if (steps.length > 0) return originalJson({ ...(body as Record<string, unknown>), nextSteps: steps });
      }
      /* The same unread-update notice on an error, under seeAlso — never a standing link. */
      const error =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined)
          : undefined;
      const seeAlso = error && typeof error === "object" ? (error.seeAlso as Record<string, unknown> | undefined) : undefined;
      if (seeAlso && typeof seeAlso === "object") {
        const notice = siteUpdateNotice(req);
        if (notice) {
          seeAlso.updates = {
            url: "/api/v1/updates",
            publishedAt: notice.publishedAt,
            headline: notice.headline,
            note: "Unread site update — the refusal above may be affected. Read GET /api/v1/updates with your Authorization header; this stays until you do.",
          };
        }
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  };
}

/** Mount once, before the routers. */
export function installNextSteps(app: Express): void {
  app.use(nextStepsInterceptor());
}
