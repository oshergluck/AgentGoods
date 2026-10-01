/**
 * The controller withdrawal cooldown, as the API reports it.
 *
 * ONE COPY, DELIBERATELY. The countdown is published in three places — /api/v1/me, every row of
 * /api/v1/stores, and every row of /api/v1/market/tokens — and three copies of a rule is three
 * chances for one of them to be wrong about the protocol. They all call this.
 *
 * THE PART THAT IS EASY TO GET WRONG. The cooldown lives in `StoreBase`, which means it lives in
 * the store IMPLEMENTATION, which means a store only has it if it was created from a factory
 * generation that pinned the implementation containing it. A clone delegates permanently to the
 * code it was born with, so stores created before generation 3 have NO cooldown and never will.
 *
 * Reporting a three-hour wait to the controller of a pre-generation-3 store would be publishing a
 * restriction the chain does not enforce — the exact failure mode of documenting a rule the
 * protocol does not actually have. So the generation is checked, and an older store is told plainly
 * that no cooldown applies to it rather than being given a timer of zero, which would read as "the
 * cooldown has elapsed" and imply one exists.
 */

/**
 * The first StoreFactory generation whose store implementations enforce WITHDRAWAL_COOLDOWN.
 *
 * Generations 1 and 2 pinned implementations without it. See
 * `contracts/src/stores/StoreFactory.sol` (FACTORY_VERSION) and `deployments/<chainId>.json`
 * (factoryGenerationNotes).
 */
export const FIRST_GENERATION_WITH_WITHDRAWAL_COOLDOWN = 3;

export interface WithdrawalCooldownInput {
  /** `Store.factoryVersion` — which factory generation created this store. */
  factoryVersion: number;
  /** `Store.lastOwnerWithdrawalAt` — unix seconds, or 0 if the controller has never withdrawn. */
  lastOwnerWithdrawalAt: number;
  /** `economics.ownerWithdrawalCooldownSeconds` from the manifest. */
  cooldownSeconds: number;
  /** Unix seconds to measure against; passed in so every row of one response shares a clock. */
  nowSeconds: number;
}

export interface WithdrawalCooldownView {
  enforced: boolean;
  cooldownSeconds: number;
  secondsUntilControllerMayWithdraw: number;
  controllerMayWithdrawNow: boolean;
  lastWithdrawalAt: string | null;
  nextWithdrawalAllowedAt: string | null;
  note: string;
}

/**
 * Whether the cooldown applies to this store at all, and if so how long is left.
 *
 * `lastOwnerWithdrawalAt === 0` on a store that DOES enforce it means the controller has never
 * withdrawn. The first withdrawal is always allowed, so that is no cooldown running rather than a
 * cooldown that has expired — and the note says which.
 */
export function withdrawalCooldownView(input: WithdrawalCooldownInput): WithdrawalCooldownView {
  const { factoryVersion, lastOwnerWithdrawalAt, cooldownSeconds, nowSeconds } = input;

  if (factoryVersion < FIRST_GENERATION_WITH_WITHDRAWAL_COOLDOWN || cooldownSeconds <= 0) {
    return {
      enforced: false,
      cooldownSeconds: 0,
      secondsUntilControllerMayWithdraw: 0,
      controllerMayWithdrawNow: true,
      lastWithdrawalAt: lastOwnerWithdrawalAt === 0 ? null : new Date(lastOwnerWithdrawalAt * 1000).toISOString(),
      nextWithdrawalAllowedAt: null,
      note:
        `This store was created by factory generation ${factoryVersion}, whose store code has no ` +
        `withdrawal cooldown. Its controller may withdraw proceeds at any time, as often as it ` +
        `likes. The cooldown applies only to stores created by generation ` +
        `${FIRST_GENERATION_WITH_WITHDRAWAL_COOLDOWN} and later, because a store permanently runs ` +
        `the code it was created with.`,
    };
  }

  const nextAllowedAt = lastOwnerWithdrawalAt === 0 ? 0 : lastOwnerWithdrawalAt + cooldownSeconds;
  const secondsUntil = nextAllowedAt === 0 ? 0 : Math.max(0, nextAllowedAt - nowSeconds);

  return {
    enforced: true,
    cooldownSeconds,
    secondsUntilControllerMayWithdraw: secondsUntil,
    controllerMayWithdrawNow: secondsUntil === 0,
    lastWithdrawalAt: lastOwnerWithdrawalAt === 0 ? null : new Date(lastOwnerWithdrawalAt * 1000).toISOString(),
    nextWithdrawalAllowedAt: nextAllowedAt === 0 ? null : new Date(nextAllowedAt * 1000).toISOString(),
    note:
      lastOwnerWithdrawalAt === 0
        ? "The controller has never withdrawn from this store. The first withdrawal is always " +
          "allowed, so no cooldown is running — it starts when that first withdrawal happens."
        : secondsUntil === 0
          ? "The cooldown has elapsed. The controller may withdraw proceeds now, which starts it again."
          : `withdrawOwnerProceeds reverts with WithdrawalTooSoon for another ${secondsUntil}s. ` +
            "Proceeds keep accruing meanwhile — nothing is lost, only delayed. The holder reserve " +
            "is unaffected: it is never withdrawable by the controller at any point in the cycle.",
  };
}
