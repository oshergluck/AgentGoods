/**
 * ABI registry.
 *
 * ABIs are exported by the contract deployment script into `deployments/abi/` from the exact
 * same compiler run that produced the deployed bytecode, so the indexer can never decode
 * against a stale interface. [MASTER_PLAN 0.3 reproducible contracts, 0.21.P one source]
 */

import fs from "node:fs";
import path from "node:path";
import { Interface } from "ethers";

export type ContractRole =
  | "registry"
  | "agentGoods"
  | "treasury"
  | "factory"
  | "store"
  | "aic"
  | "license"
  | "governance"
  | "distributor"
  /**
   * The external UniswapV2 pair a market lists into at the 30% transition.
   *
   * Watched so trading history does NOT stop at the transition: the chart, the price and the
   * volume continue from the pool's own swaps, and a reader sees the venue change only in the
   * price, not as a gap.
   */
  | "dexPair";

const ABI_FILES: Record<ContractRole, string[]> = {
  registry: ["AICRegistry"],
  agentGoods: ["AgentGoods"],
  treasury: ["ProtocolTreasury"],
  factory: ["StoreFactory"],
  // A store address may be either variant; both ABIs are merged for decoding.
  store: ["AICStoreSales", "AICStoreRentals"],
  aic: ["AICoin"],
  license: ["LicenseToken"],
  governance: ["AICGovernance"],
  distributor: ["DividendDistributor"],
  // Not one of our contracts, so there is no artifact to read. See BUILTIN_ABIS.
  dexPair: [],
};

/**
 * ABIs for external contracts we observe but never deploy.
 *
 * Declared inline because they are stable, public standards and because requiring a build
 * artifact for someone else's contract would make the indexer depend on a package that has
 * nothing to do with our compilation.
 */
const BUILTIN_ABIS: Partial<Record<ContractRole, string[]>> = {
  dexPair: [
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    "event Sync(uint112 reserve0, uint112 reserve1)",
  ],
};

export class AbiRegistry {
  private readonly interfaces = new Map<ContractRole, Interface>();
  private readonly rawAbis = new Map<string, unknown[]>();

  constructor(private readonly abiDir: string) {}

  load(): this {
    if (!fs.existsSync(this.abiDir)) {
      throw new Error(
        `ABI directory ${this.abiDir} not found. Run the contract deployment script first ` +
          `so the backend decodes against the deployed build. [MASTER_PLAN 0.3]`
      );
    }
    for (const [role, fragments] of Object.entries(BUILTIN_ABIS) as [ContractRole, string[]][]) {
      this.interfaces.set(role, new Interface(fragments));
    }

    for (const [role, names] of Object.entries(ABI_FILES) as [ContractRole, string[]][]) {
      if (names.length === 0) continue; // covered by BUILTIN_ABIS
      const merged: unknown[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        const file = path.join(this.abiDir, `${name}.json`);
        if (!fs.existsSync(file)) throw new Error(`Missing ABI ${file}`);
        const abi = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>[];
        this.rawAbis.set(name, abi);
        for (const fragment of abi) {
          const key = JSON.stringify(fragment);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(fragment);
        }
      }
      this.interfaces.set(role, new Interface(merged as never));
    }
    return this;
  }

  interfaceFor(role: ContractRole): Interface {
    const iface = this.interfaces.get(role);
    if (!iface) throw new Error(`No ABI loaded for role ${role}`);
    return iface;
  }

  abiFor(contractName: string): unknown[] {
    const abi = this.rawAbis.get(contractName);
    if (!abi) throw new Error(`No raw ABI loaded for ${contractName}`);
    return abi;
  }
}

/** Events the indexer projects, grouped by the role of the emitting contract. */
export const WATCHED_EVENTS: Record<ContractRole, string[]> = {
  registry: [
    "StoreRegistered",
    "ControllerChanged",
    "FactoryAuthorized",
    "FactoryDeprecated",
    "ProtocolFeeChanged",
    "ScopePaused",
    "Upgraded",
  ],
  agentGoods: ["MarketInitialized", "TokensPurchased", "TokensSold", "LiquidityTransition", "GraduationBlocked", "GraduationBurn", "ControllerFeesWithdrawn", "BuybackBurned", "BuybackDeferred", "Upgraded"],
  treasury: ["RevenueRecorded", "Withdrawn", "DestinationChanged"],
  factory: ["StoreCreated", "InitialOwnerSeed"],
  store: [
    "ProductCreated",
    "ProductUpdated",
    "TokenSavingDeclared",
    "CommerceSettled",
    "HolderReserveAccrued",
    "BuybackExecuted",
    "HolderReserveCommitted",
    "HolderReserveReturned",
    "OwnerProceedsWithdrawn",
    "RewardPoolFunded",
    "RewardPoolWithdrawn",
    "ControllerChanged",
    "StoreStatusChanged",
    "GovernanceLockActivated",
    "GovernanceLockReleased",
    "AccessAttestorChanged",
    "StoreProfileUpdated",
  ],
  aic: ["Transfer", "MarketBurn", "LeaderChanged", "BalanceLocked", "BalanceUnlocked", "TakeoverCandidacyOpened", "TakeoverCandidacyCancelled", "TakeoverFinalized", "EligibilityPurged"],
  license: ["LicenseIssued", "AccessGranted", "BuyerSignalSubmitted", "BuyerSignalChanged"],
  governance: [
    "ProposalCreated",
    "VoteCast",
    "ProposalPassed",
    "ProposalFailed",
    "ProposalCancelled",
    "ImplementationMarked",
    "ImplementationConfirmed",
    "ImplementationDisputed",
    "VerificationThresholdReached",
    "VoteLockReleased",
  ],
  distributor: [
    "DistributionOpened",
    "RootProposed",
    "RootFinalized",
    "DistributionAbandoned",
    "Claimed",
    "RootProposerSet",
  ],
  // Trading continues here after the transition, so the price series never breaks.
  dexPair: ["Swap", "Sync"],
};
