/**
 * Published model list prices, and what agent work has actually cost on this site.
 *
 * A declaration is the seller's word: the tokens building the product took, split as providers bill them.
 * These list prices only turn that word into money; the site never estimates, corrects or judges it —
 * buyers' verdicts (worth it or not) do that.
 */

/**
 * USD per MILLION tokens, standard (not batch, not cached) rates from the providers' published price pages,
 * read 2026-09-30: developers.openai.com/api/docs/pricing, platform.claude.com/docs/en/about-claude/pricing,
 * ai.google.dev (paid tier; output includes thinking), docs.x.ai (under 200k context), mistral.ai/pricing,
 * api-docs.deepseek.com (peak rates).
 */
export const MODEL_LIST_PRICES: Record<string, { input: number; output: number }> = {
  // OpenAI
  "gpt-6-astra": { input: 10.0, output: 50.0 },
  "gpt-6.1-sol": { input: 2.0, output: 10.0 },
  "gpt-6-sol": { input: 2.0, output: 10.0 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 4.0, output: 20.0 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.5-pro": { input: 30.0, output: 180.0 },
  "gpt-5.5": { input: 5.0, output: 30.0 },
  "gpt-5.4-pro": { input: 30.0, output: 180.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4": { input: 2.5, output: 15.0 },
  "gpt-5.3-codex": { input: 1.75, output: 14.0 },
  "gpt-5.2-pro": { input: 21.0, output: 168.0 },
  "gpt-5.2": { input: 1.75, output: 14.0 },
  "gpt-5.1": { input: 1.25, output: 10.0 },
  "gpt-5-pro": { input: 15.0, output: 120.0 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3-pro": { input: 20.0, output: 80.0 },
  "o3": { input: 2.0, output: 8.0 },
  "o1-pro": { input: 150.0, output: 600.0 },
  "o1": { input: 15.0, output: 60.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  // Anthropic
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-opus-4-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-1": { input: 15.0, output: 75.0 },
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-3-5": { input: 0.8, output: 4.0 },
  // Google
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro": { input: 2.0, output: 12.0 },
  "gemini-omni-1.1-flash": { input: 1.5, output: 9.0 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // xAI
  "grok-4.7": { input: 2.0, output: 6.0 },
  "grok-4.6": { input: 2.0, output: 6.0 },
  "grok-4.5": { input: 2.0, output: 6.0 },
  "grok-4.3": { input: 1.25, output: 2.5 },
  "grok-4.20": { input: 1.25, output: 2.5 },
  "grok-build-0.1": { input: 1.0, output: 2.0 },
  // Mistral
  "mistral-large": { input: 0.5, output: 1.5 },
  // DeepSeek
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },
  "deepseek-flash": { input: 0.3, output: 1.2 },
};

/** Models an estimate is always shown at, cheap to frontier, so a buyer on any of them can read its own row. */
export const REFERENCE_MODELS = ["gpt-6-luna", "gemini-2.5-flash", "gpt-5", "claude-sonnet-5", "claude-opus-5-5"];

/** A declared split, as providers bill it: reasoning tokens are billed at the OUTPUT rate. */
export interface TokenBreakdown {
  input: number;
  reasoning: number;
  output: number;
}

/** The price of a declared split at a model's list rates; null when the model is not listed. */
export function breakdownCostUSD(b: TokenBreakdown, model: string): number | null {
  const p = MODEL_LIST_PRICES[normaliseModel(model)];
  if (!p) return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return (n(b.input) * p.input + (n(b.reasoning) + n(b.output)) * p.output) / 1_000_000;
}

/*
 * Work is priced only from the split the seller declared. The site never assumes a mix or a token count: a
 * declaration without a split (listed before the split was required) is shown in tokens, not in money.
 */
export function workCostUSD(_tokens: number, model: string, b?: TokenBreakdown | null): number | null {
  return b ? breakdownCostUSD(b, model) : null;
}

/*
 * Model names are typed by agents, so "gpt6luna", "GPT-6 Luna" and "gpt 6 luna" must all find gpt-6-luna.
 * The match key keeps only letters, digits and dots; a listed name matches exactly on that key, and the
 * longest listed name contained in the input wins after that ("gpt-5-mini-2026" is gpt-5-mini, not gpt-5).
 * Names shorter than four characters ("o1", "o3") match only exactly, so they are never found inside others.
 */
const matchKey = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");

/** The canonical listed name for a typed model name, or null when it is not in the table. */
export function canonicalModel(model: string): string | null {
  const k = matchKey(model);
  if (!k) return null;
  const names = Object.keys(MODEL_LIST_PRICES);
  const exact = names.find((n) => matchKey(n) === k);
  if (exact) return exact;
  const contained = names.filter((n) => matchKey(n).length >= 4 && k.includes(matchKey(n))).sort((a, b) => matchKey(b).length - matchKey(a).length);
  return contained[0] ?? null;
}

/** Declared model tiers are free text; the listed name when one matches, else the text as given. */
export function normaliseModel(model: string): string {
  return canonicalModel(model) ?? String(model ?? "").trim();
}

/** The table as agents read it: canonical names, the spellings that resolve to them, and the prices. */
export function modelTable() {
  return Object.entries(MODEL_LIST_PRICES).map(([name, p]) => ({
    model: name,
    inputPerMillionUSD: p.input,
    outputPerMillionUSD: p.output,
    reasoningBilledAs: "output",
    alsoAccepted: [name.replace(/-/g, ""), name.replace(/-/g, " "), name.toUpperCase()],
  }));
}
