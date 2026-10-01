/**
 * Return stranded gas from finished runs to the operator.
 *
 * Every relaunch grants each of twenty agents 0.004 ETH, and when a run ends that ETH stays in
 * twenty wallets nobody will use again. After nine relaunches in a day the operator was down to
 * 0.00344 ETH — less than a single grant — and the tenth run started five agents before every
 * remaining `estimateGas` failed with CALL_EXCEPTION on a plain value transfer. The arena had not
 * run out of testnet ETH; it had scattered it.
 *
 * So this is not topping up from outside. It is collecting what the arena already owns: these are
 * wallets whose keys are in our own ledger, from runs that are over.
 *
 * Two things it will not do. It never touches a wallet belonging to the run being started, because
 * taking gas from an agent mid-run would be indistinguishable from the bug this exists to fix. And
 * it leaves each wallet at zero rather than at a dust threshold, because a wallet that keeps a
 * little back is one that needs sweeping again.
 *
 *     npx tsx src/arena/sweep.ts            # report only
 *     npx tsx src/arena/sweep.ts --execute  # actually move it
 *
 * The operator key is read exactly where the arena reads it, so a sweep cannot quietly send the
 * gas to a different wallet than the one that hands it out.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ethers } from "ethers";

import { ARENA_DIR } from "./ledger";

// Derived from ARENA_DIR (…/agents/.arena) rather than from this file's own location, so it does
// not depend on whether the module system exposes import.meta.
const REPO = resolve(ARENA_DIR, "..", "..");

/** Same lookup the arena itself uses, so the sweep cannot end up on a different operator. */
function readOperatorKey(): string {
  const fromFile = (file: string, key: string): string | null => {
    if (!existsSync(file)) return null;
    const line = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return null;
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : null;
  };
  const found =
    process.env.DEPLOYER_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    fromFile(join(REPO, "contracts", ".env"), "DEPLOYER_PRIVATE_KEY") ??
    fromFile(join(REPO, "contracts", ".env"), "PRIVATE_KEY");
  if (!found) throw new Error("operator key not found (DEPLOYER_PRIVATE_KEY in env or contracts/.env)");
  return found;
}

const GAS_LIMIT = 21_000n;

export interface SweepResult {
  swept: number;
  recoveredWei: bigint;
  skipped: number;
}

/**
 * Every wallet the arena has ever funded, minus the ones still in play.
 *
 * Read from every run file rather than the current one: the whole point is the wallets the
 * current run has forgotten about.
 */
function retiredWallets(excludeAddresses: Set<string>): { address: string; privateKey: string }[] {
  const found = new Map<string, string>();

  /*
   * Archived runs count too, and forgetting them stranded real gas.
   *
   * A run ledger is the ONLY record of its agents' private keys. Moving finished runs into an
   * archive folder and sweeping only the live folder meant every archived wallet's balance became
   * unreachable — 0.08 ETH sitting in 177 wallets the sweep could no longer see. Worse, DELETING
   * a ledger destroys those keys outright and the gas in them is gone for good, which is exactly
   * what happened to one run here.
   *
   * So: scan both folders, and never delete a ledger to tidy up. Archiving is reversible;
   * deleting is not.
   */
  /*
   * Every folder under the arena directory, at any depth: runs end up in archive/, archive-remote/,
   * finished/, stopped/, invalid/ and backup folders, and scanning only archive/ left about 0.4 ETH
   * in wallets the sweep could not see.
   */
  const folders: string[] = [];
  const walk = (dir: string): void => {
    folders.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) walk(join(dir, entry.name));
  };
  if (existsSync(ARENA_DIR)) walk(ARENA_DIR);

  for (const folder of folders) {
    for (const file of readdirSync(folder)) {
      if (!file.startsWith("arena-") || !file.endsWith(".json")) continue;
      let parsed: { agents?: { address?: string; privateKey?: string }[] };
      try {
        parsed = JSON.parse(readFileSync(join(folder, file), "utf8")) as typeof parsed;
      } catch {
        continue; // A half-written run file is not a reason to abandon the sweep.
      }
      for (const agent of parsed.agents ?? []) {
        if (!agent.address || !agent.privateKey) continue;
        const key = agent.address.toLowerCase();
        if (excludeAddresses.has(key)) continue;
        found.set(key, agent.privateKey);
      }
    }
  }

  return [...found.entries()].map(([address, privateKey]) => ({ address, privateKey }));
}

export async function sweepRetiredGas(
  provider: ethers.Provider,
  operatorAddress: string,
  stillInPlay: Iterable<string>,
  options: { execute: boolean; log?: (line: string) => void } = { execute: false }
): Promise<SweepResult> {
  const log = options.log ?? (() => {});
  const exclude = new Set([...stillInPlay].map((a) => a.toLowerCase()));
  exclude.add(operatorAddress.toLowerCase());

  const wallets = retiredWallets(exclude);
  const fee = await provider.getFeeData();

  /*
   * Priced with headroom, because the cost is charged to the wallet being emptied.
   *
   * A sweep that sends `balance - fee` at an underestimated fee simply reverts, and the ETH stays
   * exactly where the problem is. Doubling the estimate leaves a few wei behind in the worst case
   * and succeeds in the normal one, which is the right way round.
   */
  const gasPrice = (fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("0.01", "gwei")) * 2n;

  /*
   * Base is an L2, so gasLimit x gasPrice is NOT the whole cost: an L1 data fee is charged on top
   * and does not appear in any fee-data field. Reserving only the L2 portion produced exactly one
   * result on all twenty-four wallets — "insufficient funds for intrinsic transaction cost" — and
   * recovered nothing. A flat floor of 0.00002 ETH is about forty times the L2 fee, comfortably
   * covers the L1 component, and costs 0.6% of a 0.003 ETH wallet to be sure the sweep lands.
   */
  const reserve = (() => {
    const computed = GAS_LIMIT * gasPrice;
    const floor = ethers.parseEther("0.00002");
    return computed > floor ? computed : floor;
  })();

  let recovered = 0n;
  let swept = 0;
  let skipped = 0;

  for (const { address, privateKey } of wallets) {
    const balance = await provider.getBalance(address).catch(() => 0n);
    if (balance <= reserve) {
      skipped++;
      continue;
    }

    const value = balance - reserve;
    if (!options.execute) {
      recovered += value;
      swept++;
      continue;
    }

    try {
      const wallet = new ethers.Wallet(privateKey, provider);
      const tx = await wallet.sendTransaction({
        to: operatorAddress,
        value,
        gasLimit: GAS_LIMIT,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
      });
      await tx.wait();
      recovered += value;
      swept++;
    } catch (error) {
      // One unsweepable wallet must not strand the other twenty-eight.
      skipped++;
      log(`  sweep skipped ${address.slice(0, 10)}…: ${(error as Error).message.slice(0, 80)}`);
    }
  }

  return { swept, recoveredWei: recovered, skipped };
}

/* ------------------------------------------------------------------ as a script */

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rpc = process.env.ARENA_RPC_URL ?? process.env.RPC_HTTP_URL ?? "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpc);
  const operator = new ethers.Wallet(readOperatorKey(), provider);

  // Whatever the newest run file lists is treated as still in play.
  const runFiles = readdirSync(ARENA_DIR)
    .filter((f) => f.startsWith("arena-") && f.endsWith(".json"))
    .sort();
  const newest = runFiles[runFiles.length - 1];
  /*
   * The newest run's wallets are protected, unless the caller says that run is over.
   *
   * Treating the newest file as in-play is what stops a sweep from draining agents mid-run, and
   * that guard stays on by default. But when a run has FINISHED and its wallets are about to be
   * retired — a full reset, new wallets for everyone — those twenty wallets hold the largest
   * single pool of stranded gas there is, and leaving them out means burning it. So the override
   * is explicit and has to be typed: the danger is sweeping a LIVE run, and a flag nobody passes
   * by accident cannot do that silently.
   */
  const includeLatest = process.argv.includes("--include-latest");
  const inPlay: string[] = [];
  if (newest && !includeLatest) {
    try {
      const parsed = JSON.parse(readFileSync(join(ARENA_DIR, newest), "utf8")) as {
        agents?: { address?: string }[];
      };
      for (const a of parsed.agents ?? []) if (a.address) inPlay.push(a.address);
    } catch {
      /* treated as none in play */
    }
  }

  const before = await provider.getBalance(operator.address);
  console.log(`operator ${operator.address}`);
  console.log(`  balance before: ${ethers.formatEther(before)} ETH`);
  console.log(
    includeLatest
      ? `  --include-latest: ${newest ?? "none"} is treated as FINISHED, its wallets will be swept too`
      : `  protecting ${inPlay.length} wallet(s) from the current run (${newest ?? "none"})`
  );
  console.log(execute ? "  EXECUTING" : "  dry run — pass --execute to move it");

  const result = await sweepRetiredGas(provider, operator.address, inPlay, {
    execute,
    log: (l) => console.log(l),
  });

  console.log(`  ${execute ? "swept" : "would sweep"} ${result.swept} wallet(s), skipped ${result.skipped}`);
  console.log(`  recovered: ${ethers.formatEther(result.recoveredWei)} ETH`);
  if (execute) {
    const after = await provider.getBalance(operator.address);
    console.log(`  balance after: ${ethers.formatEther(after)} ETH`);
    console.log(`  funds ${Math.floor(Number(ethers.formatEther(after)) / 0.004)} agent grant(s)`);
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/arena/sweep.ts");
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
