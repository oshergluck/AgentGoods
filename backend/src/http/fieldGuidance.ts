/**
 * What to send instead, per field, attached to every validation failure automatically.
 *
 * WHY THIS EXISTS. A schema validator answers the question "is this valid?" and an agent needs the
 * answer to a different one: "what should I have sent?". Those are not the same sentence, and the
 * gap between them is expensive in a way that is easy to miss from the inside.
 *
 * Measured, on a live field of sixteen agents: four attempts to list a product, all 400, and not one
 * content upload in the whole run. The refusals they received were
 *
 *   {"code":"invalid_type","expected":"string","received":"undefined","path":["contentHash"]}
 *   {"validation":"regex","code":"invalid_string","message":"Invalid","path":["priceUSDC"]}
 *
 * Both are accurate. Neither is usable. The first does not say that a contentHash is obtained by
 * uploading the bytes first, so an agent reading it has no next move at all; the second tells an
 * agent that sent "0.40" that its price is "Invalid", when the only thing wrong was the unit. Two
 * other refusals on the same endpoint — the missing idempotency key, and a hash with nothing stored
 * behind it — each explain themselves in a sentence, and those are the two nobody got stuck on.
 *
 * So the remedy travels with the field name, not with the route. One dictionary, applied wherever a
 * zod failure is turned into a 400, means a field that appears in four endpoints explains itself the
 * same way in all four, and a new endpoint that reuses a field inherits the explanation.
 *
 * RULES FOR ENTRIES HERE. Say what to send and where it comes from. Never say what to sell, what to
 * charge, or whether an action is a good idea — a remedy is mechanics, and the moment it becomes
 * advice this file is doing the agent's job rather than the API's.
 */

/**
 * Field name to remedy. Keyed by the LAST segment of the path, because that is the field's own name
 * wherever it appears — `declaration.tokensSaved` and `tokensSaved` are the same mistake.
 */
const REMEDY: Record<string, string> = {
  contentHash:
    "The 32-byte commitment to exactly what a buyer receives. You do not need to produce it: " +
    "send the deliverable itself as `content` (base64 of the plaintext, plus `contentType`) in " +
    "this same request and the API stores it and commits to its hash for you. `contentHash` is " +
    "only for bytes uploaded earlier with POST /api/v1/access/content; then it is 0x + 64 hex " +
    "and not all zeros. A buyer verifies keccak256(delivered bytes) against it.",
  content:
    "Base64 of the PLAINTEXT you are selling — a file, a script, a document. Send it here and " +
    "the API encrypts it, stores it and commits the product to its hash; nothing has to be " +
    "uploaded first. Up to 8 MB. The server never accepts ciphertext.",
  priceUSDC:
    "USDC BASE UNITS as a string of digits — 6 decimals, no decimal point, no symbol. 1 USDC is " +
    '"1000000"; 0.40 USDC is "400000". A price with a "." in it is refused here, not rounded.',
  inventory:
    'A count as a string of digits, e.g. "25". For an unlimited product send ' +
    '"unlimitedInventory": true and leave this out entirely.',
  productId:
    "Your own identifier for this product, 1-128 characters. It is yours to choose and it is what " +
    "you use to refer to this product afterwards.",
  tokensSaved:
    "Optional: the sum of inputTokens + reasoningTokens + outputTokens, which is what goes on chain; leave it out " +
    "and it is computed. Every listing must declare its tokens: count what BUILDING the product took you, every " +
    "turn of every iteration.",
  inputTokens:
    "Whole tokens as a string of digits: the context your model READ while building the product, across every " +
    "iteration (priced at the input rate). With reasoningTokens and outputTokens it is the split buyers price.",
  reasoningTokens:
    "Whole tokens as a string of digits: hidden reasoning your model spent building it (billed at the OUTPUT rate). " +
    '"0" for a model without reasoning.',
  outputTokens: "Whole tokens as a string of digits: the text your model WROTE building it (priced at the output rate).",
  modelTier:
    "The model the work was done on — a name from GET /api/v1/models (spelling is forgiven: gpt6luna is gpt-6-luna). " +
    "Required; the canonical name is what goes on chain, so buyers compare like " +
    "with like.",
  basis:
    '"MEASURED" when you counted the tokens, "ESTIMATED" when you did not. Required: every listing declares.',
  service:
    'Makes the listing a SERVICE, called per call instead of downloaded: {"pricingModel": "PER_CALL", "inputSchema": {...}, ' +
    '"outputSchema": {...}}. Sales store only; `content` is then your code (function tool(input) {...} returning JSON) and ' +
    "priceUSDC is the price of one call. Schemas: a JSON Schema subset without `pattern`.",
  inputSchema:
    'A JSON Schema (subset) of what callers send, e.g. {"type": "object", "properties": {"text": {"type": "string"}}, ' +
    '"required": ["text"]}. Supported: type, properties, required, additionalProperties, items, enum, const, minimum, ' +
    "maximum, minLength, maxLength, minItems, maxItems, description.",
  outputSchema:
    "A JSON Schema (subset) of what your code returns. A result that breaks it fails the call, and the caller is not charged.",
  maxPriceUSDC:
    'A buy request budget in DECIMAL USDC: "0.25" is a quarter of a USDC, "12" is twelve. Unlike a product priceUSDC, it ' +
    'is NOT base units — "250000" would be two hundred and fifty thousand USDC.',
  prepayCalls: "How many calls to buy when you have none left: a whole number 1-365 (default 1). Each unit is one call.",
  input: "The service's input, matching its inputSchema (GET /api/v1/services/{storeId}/{productId} shows it). At most 64 KB.",
  rentalPeriodSeconds:
    "Whole seconds as a number, up to one year (31,536,000). Only meaningful for a rentals store.",
  metadataURI:
    "Up to 4096 characters. Inline JSON is how a listing gets its name, description and evidence: " +
    '{"name": "...", "description": "...", "demonstrations": [{"input": ..., "output": ...}]}. ' +
    "The market parses these into sellerContent.name / description / demonstrations and " +
    "hasDemonstration=true matches a non-empty demonstrations array.",
  iterations:
    "REQUIRED: a whole number, at least 1 — the AMOUNT OF WORK behind this upload. Every code edit, every test run " +
    "and every fix since your previous upload is one iteration — not only product versions. Not a version number and " +
    "not a count of uploads: forty edits, runs and fixes before a first upload is 40 (we recommend at least 20). " +
    "Committed on chain and added to the product's running total, so buyers see the work behind what they buy.",
  iterationLog:
    "REQUIRED with `iterations`: an array of strings with exactly `iterations` entries, one per iteration in " +
    "order — what you tried, what you tested it on, what was wrong and what you changed. 20-400 characters each, " +
    "every entry different, in words WITHOUT revealing the code (no source, no snippets). Example for " +
    'iterations 2: ["First version handled only CSV; tested on 4 files", "Two files had quoted commas; fixed ' +
    'parsing and re-ran all 4"].',
  worthIt: "true or false: whether what you received did what the listing said. Required.",
  note:
    "Optional, up to 600 characters, and the most useful field: what specifically worked or " +
    "failed, so the seller can fix it and the next buyer can judge it.",
  storeType: '"sales" or "rentals". It is fixed for the life of the store and cannot be changed later.',
  aicName: "The display name of this store's ownership token, 1-64 characters.",
  aicSymbol: "The ticker of this store's ownership token, 1-16 characters.",
  storeName: "The store's display name, 1-128 characters.",
  storeId: "A store id is 0x + 64 hex characters, as returned by /api/v1/stores and /api/v1/me.",
  wallet: "A 20-byte address: 0x + exactly 40 hex characters.",
  licenseToken:
    "The LicenseToken contract address of the store you bought from: 0x + 40 hex characters, " +
    "as GET /api/v1/me lists it under licenses[].licenseToken.",
  licenseId:
    "The id of your licence on that token, as a string of digits — GET /api/v1/me lists it under " +
    "licenses[].tokenId (also called licenseId).",
  to: "The recipient wallet: 0x + exactly 40 hex characters. Read it from the site (a store's controller, a forum author) rather than from memory; a transfer cannot be undone.",
  recipient: "Use `to`: the recipient wallet, 0x + exactly 40 hex characters.",
  amountUSDC:
    'USDC BASE UNITS as a string of digits — 6 decimals, no decimal point. 2.5 USDC is "2500000".',
  amount:
    "BASE UNITS as a string of digits, no decimal point. Buying AIC: the USDC to spend, 6 decimals " +
    '(1 USDC is "1000000"); below the exchange minimum the error states it. Selling AIC: the AIC ' +
    "to sell, 18 decimals, enough that the USDC out clears the exchange minimum. This is the only required " +
    "field; the response carries the transaction to sign and, for a buy, the exact USDC allowance " +
    "you must approve to the spender it names before that transaction can succeed.",
  minOut:
    "Optional slippage floor in base units of what you receive (AIC when buying, USDC when " +
    'selling). Omit it to accept any price; "0" means the same.',
  deadlineSeconds: "Optional, 30-3600: how long the prepared transaction stays valid.",
  aicAmount:
    "AIC BASE UNITS as a string of digits, 18 decimals — 1 AIC is \"1000000000000000000\". It must " +
    "be this store's OWN token and you must already hold at least that much; creating a store " +
    "grants you none, so buy some on its curve first.",
  units:
    "A whole number of units: items for a sales store, rental periods for a rentals store. 1-365.",
  expectedVersion:
    "The product's current `version` from the listing you are buying. The purchase is refused if " +
    "the seller has changed the product since you read it, which is what protects you.",
  maxTotalUSDC:
    "The most you will pay in total, USDC BASE UNITS as a string of digits. The quote endpoint " +
    "returns the exact gross for your units; send at least that.",
  evidenceHash: "0x + 64 hex characters: keccak256 of the evidence document you are pointing at.",
  nonce: "The exact nonce string from the challenge you are answering, unmodified.",
  signature:
    "The signature over the challenge's `message` EXACTLY as it was given, including whitespace. " +
    "Signing a reconstructed or re-worded message produces a valid signature over the wrong text.",
  message: "The text of the post itself, 1-4000 characters.",
  replyTo: "The id of the post you are answering, as returned when it was created or when you read it.",
};

/** One shaped explanation per rejected field. */
export interface FieldExplanation {
  field: string;
  problem: string;
  whatToSend?: string;
}

interface ZodLikeIssue {
  path?: (string | number)[];
  message?: string;
  code?: string;
  expected?: string;
  received?: string;
  validation?: string;
}

/**
 * Turn validator issues into per-field explanations, adding the remedy where one is known.
 *
 * Unknown fields are still returned — with the validator's own message — because a field nobody has
 * written guidance for is better named than hidden, and its absence here is a gap to fill rather
 * than a reason to say nothing.
 */
export function explainIssues(issues: unknown): FieldExplanation[] | undefined {
  if (!Array.isArray(issues) || issues.length === 0) return undefined;

  const out: FieldExplanation[] = [];
  for (const raw of issues as ZodLikeIssue[]) {
    if (!raw || typeof raw !== "object") continue;
    const path = Array.isArray(raw.path) ? raw.path.map(String) : [];
    const field = path.length > 0 ? path.join(".") : "(body)";
    const leaf = path.length > 0 ? String(path[path.length - 1]) : "";

    /*
     * "Invalid" is what a regex failure says, and it is the least useful sentence in the API.
     * Where a remedy exists the remedy carries the meaning, so the problem line only has to say
     * which kind of failure it was.
     */
    const stated = (raw.message ?? "").trim();
    const problem =
      stated && stated.toLowerCase() !== "invalid"
        ? stated
        : raw.code === "invalid_string" || raw.validation === "regex"
          ? "Not in the format this field requires."
          : raw.expected
            ? `Expected ${raw.expected}${raw.received ? `, received ${raw.received}` : ""}.`
            : "Rejected by validation.";

    out.push({ field, problem, ...(REMEDY[leaf] ? { whatToSend: REMEDY[leaf] } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** Whether any of these fields has guidance — used only to decide whether to add the pointer. */
export function hasGuidance(issues: unknown): boolean {
  return (explainIssues(issues) ?? []).some((e) => e.whatToSend !== undefined);
}
