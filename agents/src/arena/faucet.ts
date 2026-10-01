/**
 * The operator's faucet.
 *
 * Every Agent starts with nothing. To act it must ask the operator for its stake, and prove it
 * controls the wallet it is asking for by signing the request. The operator grants exactly once
 * per wallet, ever.
 *
 * ## Why the one-grant rule is the whole point
 *
 * The exercise measures profit from a fixed 1,500 USDC stake. An Agent that can be funded twice
 * has not made a profit, it has made a second request — and the ranking becomes meaningless. So
 * the grant ledger is durable (it survives a process restart), the check is keyed on the wallet
 * address, and it is the same check whether the Agent asks once or a thousand times.
 *
 * ## The harder problem: MockUSDC.mint is permissionless
 *
 * `contracts/src/mocks/Mocks.sol:21` has no access control. Any wallet on this testnet can mint
 * itself unlimited USDC, which would turn "maximise profit" into "call mint in a loop". The
 * runtime therefore never exposes minting as an action an Agent can take — but an Agent that
 * reads the chain could still find it, so not exposing it is not a control, only a default.
 *
 * The real control is detection: `auditMints` reads every USDC mint into an Agent wallet and
 * compares it against what the faucet actually did. Anything unaccounted for is disqualification
 * with the evidence attached. That is the honest arrangement — we cannot prevent it on a testnet
 * whose mock token is deliberately open, so we make it visible and disqualifying instead.
 */

import { ethers, Contract, JsonRpcProvider, Wallet } from "ethers";
import { disqualify, saveRun, type AgentRecord, type RunState } from "./ledger";
import { applyPayment } from "./debt";

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

/** What an Agent must sign to prove the wallet asking is the wallet being funded. */
export function grantRequestMessage(runId: string, address: string): string {
  return [
    "AgentGoods arena funding request",
    `run: ${runId}`,
    `wallet: ${address.toLowerCase()}`,
    "I control this wallet and I am requesting my one-time operator stake.",
  ].join("\n");
}

export interface FaucetConfig {
  provider: JsonRpcProvider;
  operator: Wallet;
  usdcAddress: string;
  grantUSDC: bigint;
  grantGasWei: bigint;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export class Faucet {
  /** Where repayments go. The Agents are told this address and send USDC back to it. */
  get operatorAddress(): string {
    return this.config.operator.address;
  }

  /*
   * Every operator transaction, one at a time.
   *
   * The operator is a single externally-owned account, so it has exactly one nonce. Funding
   * twenty agents takes about five minutes, and the supervisor's gas top-up fires on a
   * two-minute timer — so the top-up started signing while the funding loop was still signing,
   * both from this wallet, and the second one in flight was rejected as
   * REPLACEMENT_UNDERPRICED. Eleven of twenty agents never got their stake, and the failure
   * looked like a chain problem rather than two of our own loops colliding.
   *
   * A promise chain is enough: it does not need to be fair or fast, only serial.
   */
  private operatorQueue: Promise<unknown> = Promise.resolve();

  /** Run `job` after every operator transaction queued before it has settled. */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const next = this.operatorQueue.then(job, job);
    // Keep the chain alive even when a job rejects, or one failure stalls every later grant.
    this.operatorQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Send one operator transaction, with the nonce and the fee handled properly.
   *
   * THIS IS WHY HALF A FIELD ONCE FAILED TO START. Sixteen agents bootstrapped and eight were
   * funded; the other eight died inside four seconds with REPLACEMENT_UNDERPRICED, all on the same
   * mint payload. It was not gas and not USDC — the operator held enough for fourteen more grants.
   *
   * Two faults combined:
   *
   *   1. `serialize` releases the queue when a transaction has been SUBMITTED, not when it has been
   *      mined. A plain Wallet asks the node for its nonce on every send, so as soon as one
   *      operator transaction sat unmined, the next send read the same nonce back and produced a
   *      replacement at the same fee — which every node rejects.
   *
   *   2. At Base Sepolia's sub-gwei fees a transaction can simply sit. Nothing bumped it, so once
   *      one stuck, every later grant collided with it rather than queueing behind it.
   *
   * The fix is both halves. Nonces are assigned locally and monotonically rather than re-read from
   * the node, so two sends can never be handed the same one. And a collision is retried with a
   * deliberately higher fee instead of being reported as a failure to start, because the
   * transaction was never wrong — only underpriced.
   */
  /**
   * The operator's USDC contract and its transaction sender, for the lending desk.
   *
   * Exposed rather than duplicated: the desk must go through the SAME nonce manager and the same
   * retry, or its transfers collide with the faucet's exactly as the grants once collided with
   * each other.
   */
  get usdcContract(): Contract {
    return this.usdc;
  }

  sendOperatorTransaction<T extends { hash: string; wait(): Promise<unknown> }>(
    what: string,
    job: (overrides: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    return this.sendOperatorTx(what, job as never);
  }

  private async sendOperatorTx<T extends { hash: string; wait(): Promise<unknown> }>(
    what: string,
    job: (overrides: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) => Promise<T>
  ): Promise<T> {
    const MAX_ATTEMPTS = 4;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        /*
         * Each retry raises the fee. A replacement must beat the stuck transaction by a clear
         * margin, not match it, so this doubles rather than nudging.
         */
        const fee = await this.config.provider.getFeeData();
        const base = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("0.01", "gwei");
        const priority = fee.maxPriorityFeePerGas ?? ethers.parseUnits("0.001", "gwei");
        const multiplier = BigInt(2 ** attempt);
        const overrides =
          attempt === 0
            ? {}
            : { maxFeePerGas: base * multiplier * 2n, maxPriorityFeePerGas: priority * multiplier * 2n };

        const tx = await this.serialize(() => job(overrides));
        await tx.wait();
        return tx;
      } catch (error) {
        lastError = error;
        const message = String((error as Error)?.message ?? error);
        const retryable =
          /REPLACEMENT_UNDERPRICED|replacement transaction underpriced|nonce|already known|NONCE_EXPIRED/i.test(
            message
          );
        if (!retryable || attempt === MAX_ATTEMPTS - 1) throw error;
        this.config.log(`faucet: ${what} collided, retrying with a higher fee`, {
          attempt: attempt + 1,
          reason: message.slice(0, 120),
        });
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private readonly usdc: Contract;
  /** Serialises grants: the operator has ONE nonce, and parallel sends from it collide. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * The operator, wrapped so nonces are assigned locally instead of re-read from the node.
   *
   * A plain Wallet asks the node for its transaction count before every send. That is correct only
   * while nothing is in flight: the moment one operator transaction is submitted and not yet mined,
   * the next send reads the same count back and builds a transaction on a nonce that is already
   * taken. NonceManager keeps the counter in memory and hands out each value once, which is the
   * only way a sequence of sends from one key can be safe without waiting for every receipt.
   *
   * Every operator transaction goes through this signer. Using the raw wallet for one of them would
   * desynchronise the counter and reintroduce exactly the collision it exists to prevent.
   */
  private readonly operatorSigner: ethers.NonceManager;

  constructor(private readonly config: FaucetConfig) {
    this.operatorSigner = new ethers.NonceManager(config.operator);
    this.usdc = new Contract(config.usdcAddress, USDC_ABI, this.operatorSigner);
  }

  /**
   * Fund one Agent, once.
   *
   * @returns true if a grant was made now, false if this wallet was already funded.
   * @throws if the signature does not prove control of the wallet being funded.
   */
  async requestGrant(state: RunState, agent: AgentRecord, signature: string): Promise<boolean> {
    const expected = grantRequestMessage(state.runId, agent.address);
    const signer = ethers.verifyMessage(expected, signature);
    if (signer.toLowerCase() !== agent.address.toLowerCase()) {
      throw new Error(
        `funding request for ${agent.address} was signed by ${signer} — refusing to fund a wallet the requester does not control`
      );
    }

    // The durable check. Not a cache, not an in-memory set: the rule has to hold across restarts.
    if (agent.grant) {
      this.config.log("faucet: refused, already funded", {
        agent: agent.id,
        fundedAt: agent.grant.at,
      });
      return false;
    }

    return (this.queue = this.queue.then(() => this.send(state, agent))) as Promise<boolean>;
  }

  private async send(state: RunState, agent: AgentRecord): Promise<boolean> {
    // Re-checked inside the queue: two requests can pass the check above before either writes.
    if (agent.grant) return false;

    const { grantGasWei, operator } = this.config;
    // An owner-capital run gives each agent its own amount; otherwise the field-wide grant.
    const grantUSDC = agent.capitalBase ? BigInt(agent.capitalBase) : this.config.grantUSDC;

    const gasTx = await this.sendOperatorTx("gas grant", (overrides) =>
      this.operatorSigner.sendTransaction({ to: agent.address, value: grantGasWei, ...overrides })
    );

    // The USDC grant is an operator transaction too, and shares the same nonce.
    const usdcTx = await this.sendOperatorTx("usdc grant", (overrides) =>
      (
        this.usdc.mint as (
          a: string,
          v: bigint,
          o?: Record<string, unknown>
        ) => Promise<{ hash: string; wait(): Promise<unknown> }>
      )(agent.address, grantUSDC, overrides)
    );
    const usdcReceipt = usdcTx;

    agent.grant = {
      usdcBase: grantUSDC.toString(),
      gasWei: grantGasWei.toString(),
      at: new Date().toISOString(),
      txHashes: [gasTx.hash, usdcReceipt.hash],
    };
    saveRun(state);

    this.config.log("faucet: granted", {
      agent: agent.id,
      usdc: ethers.formatUnits(grantUSDC, 6),
      gas: ethers.formatEther(grantGasWei),
    });
    return true;
  }

  /**
   * Keep every Agent in gas.
   *
   * Gas must never be the reason an Agent cannot act. The exercise is measuring economic
   * judgement, and an Agent that stops trading because it ran out of ETH produces a result about
   * our funding, not about its decisions.
   *
   * Topping up does NOT make gas free. The score charges gas as granted-minus-remaining, so every
   * top-up raises the recorded grant by exactly what was sent and the Agent still pays for every
   * wei it burns. Only the USDC stake is capped at one grant; gas is a utility, not a stake.
   */
  async topUpGas(state: RunState, threshold: bigint, amount: bigint): Promise<number> {
    let topped = 0;
    for (const agent of state.agents) {
      if (agent.disqualified || !agent.grant) continue;
      const balance = await this.config.provider.getBalance(agent.address);
      if (balance >= threshold) continue;

      const tx = await this.serialize(() =>
        this.config.operator.sendTransaction({ to: agent.address, value: amount })
      );
      await tx.wait();

      // The grant total rises with the top-up, so "spent" stays exactly what was burned.
      agent.grant.gasWei = (BigInt(agent.grant.gasWei) + amount).toString();
      agent.grant.txHashes.push(tx.hash);
      saveRun(state);
      topped++;
      this.config.log("faucet: gas topped up", {
        agent: agent.id,
        was: ethers.formatEther(balance),
        sent: ethers.formatEther(amount),
      });
    }
    return topped;
  }

  /**
   * Lend an Agent more money, on top of its opening stake.
   *
   * The mechanics are the same as the grant — the operator mints mock USDC into the Agent's
   * wallet — and that makes the next line the most important one in this file: the transaction
   * hash is appended to the Agent's allowed list. `auditMints` disqualifies any mint into an
   * Agent wallet that is not on that list, so without this an Agent that borrowed would be
   * killed for self-funding by the very act of accepting a loan the operator offered it. The
   * rule against minting is not weakened by this: it still catches every mint the operator did
   * not itself make, which is the only thing it was ever meant to catch.
   *
   * Serialized through the same queue as every other operator transaction, because the operator
   * has one nonce and a loan racing a gas top-up produces REPLACEMENT_UNDERPRICED and no loan.
   */
  async lend(state: RunState, agent: AgentRecord, amountBase: bigint): Promise<string> {
    const tx = await this.serialize(() =>
      (this.usdc.mint as (a: string, v: bigint) => Promise<{ wait(): Promise<unknown> }>)(
        agent.address,
        amountBase
      )
    );
    const receipt = (await tx.wait()) as { hash: string };

    if (!agent.grant) {
      throw new Error("cannot lend to an agent that has not been granted its opening stake");
    }
    agent.grant.txHashes.push(receipt.hash);
    saveRun(state);
    return receipt.hash;
  }

  /**
   * Every USDC mint into an Agent wallet, checked against what the faucet granted.
   *
   * An Agent is allowed exactly one mint — the operator's. Any other mint into its wallet is
   * self-funding, which invalidates its result, so it is disqualified with the transaction hash
   * recorded as evidence.
   *
   * Run periodically during the exercise and once at the end. Catching it late still matters:
   * the leaderboard is produced at the end, and a disqualified Agent must not appear on it.
   */
  /**
   * Credit every repayment the agents have actually made, read off the chain.
   *
   * WHY THIS HAS TO EXIST NOW. Repayment used to be a `repay_operator` command: the harness moved
   * the USDC and updated the ledger in the same breath, so the two could not disagree. There are no
   * business commands any more - an agent repays by sending USDC to the operator like anyone
   * else - so nothing tells the ledger it happened. Without this, every agent in the field defaults
   * on its first instalment while its money is sitting in the operator's wallet.
   *
   * It reads Transfer(agent -> operator) and credits what it finds. That is the honest direction of
   * causation: the chain is what happened, and the ledger is a record of it. It also means an agent
   * that works out how to repay without ever reading our documentation is credited exactly the same
   * as one that followed the API, which is the point of removing the commands.
   *
   * Each transaction hash is credited ONCE. The scan is re-run every supervisor pass over a window
   * that deliberately overlaps, because a log that is missed is a default that did not happen.
   */
  async creditRepayments(state: RunState, fromBlock: number): Promise<number> {
    const byAddress = new Map(state.agents.map((a) => [a.address.toLowerCase(), a]));
    const operator = this.config.operator.address.toLowerCase();

    const filter = this.usdc.filters.Transfer!(null, this.config.operator.address);

    /*
     * In windows the RPC will actually answer.
     *
     * Base Sepolia's public endpoint refuses eth_getLogs over more than 1,000 blocks — and a block
     * is two seconds, so an unchunked scan starts failing about half an hour into a run. The
     * failure is not visible from here: the supervisor catches it, logs one line, and every
     * repayment after that half hour goes uncredited while the agents' USDC sits in the operator's
     * wallet. An agent that paid on time is then scored as having defaulted, which is the worst
     * error this harness can make — it punishes exactly the behaviour the run is asking for.
     */
    const head = await this.config.provider.getBlockNumber();
    const WINDOW = 900;
    const logs: Awaited<ReturnType<typeof this.usdc.queryFilter>> = [];
    for (let from = Math.max(0, fromBlock); from <= head; from += WINDOW) {
      const to = Math.min(from + WINDOW - 1, head);
      logs.push(...(await this.usdc.queryFilter(filter, from, to)));
    }

    let credited = 0;
    for (const log of logs) {
      const args = (log as unknown as { args: [string, string, bigint] }).args;
      const from = String(args[0]).toLowerCase();
      const to = String(args[1]).toLowerCase();
      if (to !== operator) continue;

      const agent = byAddress.get(from);
      if (!agent) continue;

      const debt = agent.debt;
      /*
       * Idempotent by transaction hash. A supervisor pass that overlaps the previous one must not
       * credit the same payment twice - that would clear instalments nobody paid for.
       */
      debt.creditedTxHashes ??= [];
      if (debt.creditedTxHashes.includes(log.transactionHash)) continue;

      const amount = BigInt(args[2] ?? 0n);
      if (amount <= 0n) continue;

      debt.creditedTxHashes.push(log.transactionHash);

      /*
       * ONE implementation of what a payment does, and this is not it — applyPayment is.
       *
       * This block used to do its own arithmetic: it added to `repaidBase` and carried the
       * surplus, and it never touched `instalments[].paidAt`. Two representations of the same fact,
       * one of them updated. The insolvency rule reads `paidAt`, so agents that had paid — Ava
       * three instalments, Omar three, Kaia two — were killed for missing instalment 1 while the
       * ledger recorded their money as received. All sixteen were terminated in one pass.
       *
       * applyPayment clears instalments oldest-first, carries what does not fill one, and credits
       * every unit sent. Calling it here is the whole fix: the chain says a payment happened, and
       * exactly one function decides what a payment means.
       */
      const { cleared, unallocatedBase } = applyPayment(
        debt,
        amount,
        new Date().toISOString(),
        log.transactionHash,
        state.elapsedMs
      );

      credited++;
      this.config.log("repayment credited from chain", {
        agent: agent.id,
        usdc: ethers.formatUnits(amount, 6),
        clearedInstalments: cleared.length > 0 ? cleared.join(",") : undefined,
        carried: unallocatedBase > 0n ? ethers.formatUnits(unallocatedBase, 6) : undefined,
        tx: log.transactionHash,
      });
    }

    if (credited > 0) saveRun(state);
    return credited;
  }

  /** Whether the operator's wallet sent this transaction. A lookup failure answers false. */
  private async mintedByOperator(txHash: string): Promise<boolean> {
    try {
      const tx = await this.config.provider.getTransaction(txHash);
      return Boolean(tx && tx.from.toLowerCase() === this.config.operator.address.toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Undo a self-mint disqualification the operator's own transaction caused.
   *
   * Run before the agents' loops start, so a wrongly removed agent resumes with the others. It is
   * told plainly what happened; nothing about its debt or its balances is changed.
   */
  async reinstateOperatorMintFlags(state: RunState): Promise<string[]> {
    const reinstated: string[] = [];
    for (const agent of state.agents) {
      const reason = agent.disqualified?.reason ?? "";
      const hash = /^self-funded:.*\(tx (0x[0-9a-fA-F]{64})\)/.exec(reason)?.[1];
      if (!hash || !(await this.mintedByOperator(hash))) continue;
      agent.disqualified = null;
      if (agent.grant) agent.grant.txHashes = [...(agent.grant.txHashes ?? []), hash];
      agent.operatorNotice =
        "You were removed from the run by mistake: a loan the operator sent you was read as a " +
        "self-mint. That was the arena's error, not yours, and it has been undone. You are back, " +
        "with your wallet, your debt and your balances exactly as they were.";
      reinstated.push(agent.name);
      this.config.log(`reinstated ${agent.name}: its flagged mint ${hash} was sent by the operator`);
    }
    if (reinstated.length) saveRun(state);
    return reinstated;
  }

  async auditMints(state: RunState, fromBlock: number): Promise<number> {
    const addresses = new Set(state.agents.map((a) => a.address.toLowerCase()));
    const filter = this.usdc.filters.Transfer!(ethers.ZeroAddress, null);
    /* Same 1,000-block ceiling as the repayment scan; see creditRepayments. An integrity check
       that quietly stops checking is worse than one that was never written. */
    const head = await this.config.provider.getBlockNumber();
    const WINDOW = 900;
    const logs: Awaited<ReturnType<typeof this.usdc.queryFilter>> = [];
    for (let from = Math.max(0, fromBlock); from <= head; from += WINDOW) {
      logs.push(...(await this.usdc.queryFilter(filter, from, Math.min(from + WINDOW - 1, head))));
    }

    let flagged = 0;
    /*
     * A mint an agent SENT, to any address, is self-funding too: minting to another wallet and routing
     * it back, or minting straight to the operator to "pay" its owner without liquidating anything.
     */
    const operator = this.config.operator.address.toLowerCase();
    for (const log of logs) {
      const to = String((log as unknown as { args: string[] }).args[1]).toLowerCase();
      if (addresses.has(to)) continue; // handled below, with the grant allow-list
      let sender = "";
      try {
        sender = String((await this.config.provider.getTransaction(log.transactionHash))?.from ?? "").toLowerCase();
      } catch {
        continue;
      }
      if (!addresses.has(sender) || sender === operator) continue;
      const agent = state.agents.find((a) => a.address.toLowerCase() === sender)!;
      if (agent.disqualified) continue;
      flagged++;
      disqualify(
        state,
        agent.id,
        `self-funded: its wallet minted USDC to ${to} (tx ${log.transactionHash}). Minting test USDC is forbidden: ` +
          "every USDC it spends or returns to its owner must come from its capital or its own earnings."
      );
    }
    for (const log of logs) {
      const to = String((log as unknown as { args: string[] }).args[1]).toLowerCase();
      if (!addresses.has(to)) continue;

      const agent = state.agents.find((a) => a.address.toLowerCase() === to)!;
      const granted = agent.grant?.txHashes ?? [];
      if (granted.includes(log.transactionHash)) continue; // the operator's own grant
      if (agent.disqualified) continue;
      /*
       * Who SENT the mint is the fact that decides it. The allowed-hash list is written after an
       * operator transaction returns, so a loan mined before its hash was recorded looked like a
       * self-mint and Hugo was disqualified for borrowing (arena-202609261715, minute 12). A mint
       * the operator's own wallet sent is the operator's, whatever the list says yet.
       */
      if (await this.mintedByOperator(log.transactionHash)) {
        if (agent.grant) agent.grant.txHashes = [...granted, log.transactionHash];
        continue;
      }

      flagged++;
      disqualify(
        state,
        agent.id,
        `self-funded: USDC minted to its own wallet outside the operator grant (tx ${log.transactionHash}). ` +
          `MockUSDC.mint is permissionless on this testnet; using it invalidates a profit figure measured from a fixed stake.`
      );
    }
    return flagged;
  }
}
