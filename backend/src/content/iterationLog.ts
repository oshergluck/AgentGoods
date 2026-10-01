/*
 * The iteration log: one explanation per development iteration a seller declares.
 *
 * A count alone is cheap to type. Ten explanations — what was built, tested, found wrong and changed in
 * each cycle — are not, and they let a buyer judge the work behind a product before paying without the
 * seller giving the product away. The log is kept on the site (it does not fit in the on-chain listing);
 * the listing commits to it by `iterationLogHash`, keccak256 of the JSON array, so what a buyer reads is
 * exactly what the seller committed to on chain.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { ApiError } from "../http/errors";
import { IterationLog } from "../db/models";

export const MAX_ITERATIONS_PER_UPLOAD = 1000;
export const ITERATION_ENTRY_MIN = 20;
export const ITERATION_ENTRY_MAX = 400;

export const IterationLogInput = z.array(z.string().trim().min(ITERATION_ENTRY_MIN).max(ITERATION_ENTRY_MAX)).min(1).max(MAX_ITERATIONS_PER_UPLOAD);

export const WHAT_AN_ITERATION_IS =
  "Every code edit, every test run and every fix is one iteration — not only a new version of the product. Writing " +
  "it, running it, changing a function, fixing a bug a test found: each one counts. `iterations` counts all of them " +
  "since your previous upload (for a first upload, since you started) — the amount of work behind the product, NOT a " +
  "version number and NOT a count of uploads. Forty edits, runs and fixes before a first upload means 40.";

export const RECOMMENDED_ITERATIONS = 20;

/** Said back with every upload, so a seller sees how its listing reads to a buyer before it signs. */
export function iterationsFeedback(iterations: number, total: number) {
  return {
    iterations,
    iterationsTotal: total,
    whatAnIterationIs: WHAT_AN_ITERATION_IS,
    ...(total < RECOMMENDED_ITERATIONS
      ? {
          belowRecommendation:
            `This product will show ${total} iteration${total === 1 ? "" : "s"} of work. We recommend at least ` +
            `${RECOMMENDED_ITERATIONS} before listing: a product with ${total} reads to a buyer as a first draft it could ` +
            "write itself. Nothing is refused — but more cycles of running it on real inputs and fixing what fails, " +
            "counted honestly, are what make it worth buying. Work you do later is added with POST " +
            "/api/v1/stores/{storeId}/products/{productId}/update {iterations, iterationLog} — with new code or without.",
        }
      : {}),
  };
}

export const ITERATION_LOG_RULE =
  "`iterationLog` is an array with exactly one explanation per iteration (its length must equal `iterations`): " +
  "for each edit, test run or fix, in order, what you changed, what you ran it on, what was wrong and what you " +
  `fixed — in words, ${ITERATION_ENTRY_MIN}-${ITERATION_ENTRY_MAX} characters each, every entry different. ` +
  "Explain the work WITHOUT revealing the code: no source, no snippets; buyers pay for the code, the log shows " +
  "them the work behind it.";

/** Heuristic only: prose explains, code reveals. Refuses fenced blocks and entries dense in code syntax. */
function looksLikeCode(entry: string): boolean {
  if (/```|=>|\bfunction\s*\(|\bdef\s+\w+\s*\(|\bimport\s+[\w{*]+\s+from\b|\brequire\s*\(/.test(entry)) return true;
  const syntax = (entry.match(/[{};=<>$[\]]/g) ?? []).length;
  return syntax / entry.length > 0.06;
}

/** Validates the log against the declared count; returns the canonical entries. Throws a guided 400. */
export function checkIterationLog(iterations: number, log: string[]): string[] {
  const entries = log.map((e) => e.trim());
  const problems: { path: (string | number)[]; message: string }[] = [];
  if (entries.length !== iterations) {
    problems.push({
      path: ["iterationLog"],
      message: `iterations is ${iterations} but iterationLog has ${entries.length} entries; send exactly one explanation per iteration`,
    });
  }
  const seen = new Map<string, number>();
  entries.forEach((e, i) => {
    const key = e.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) problems.push({ path: ["iterationLog", i], message: `repeats entry ${seen.get(key)}; each iteration needs its own explanation` });
    else seen.set(key, i);
    if (looksLikeCode(e)) problems.push({ path: ["iterationLog", i], message: "reads as code; explain the iteration in words without revealing the code" });
  });
  if (problems.length) {
    throw ApiError.invalid("The iteration log does not explain the declared iterations.", { issues: problems.slice(0, 20), rule: ITERATION_LOG_RULE });
  }
  return entries;
}

export function iterationLogHash(entries: string[]): string {
  return keccak256(toUtf8Bytes(JSON.stringify(entries)));
}

/** Stores the log under its hash (idempotent) and returns the hash the listing commits to. */
export async function saveIterationLog(chainId: number, storeId: string, entries: string[]): Promise<string> {
  const logHash = iterationLogHash(entries);
  await IterationLog.updateOne(
    { chainId, logHash },
    { $setOnInsert: { chainId, logHash, storeId, iterations: entries.length, entries, createdAt: new Date() } },
    { upsert: true }
  );
  return logHash;
}
