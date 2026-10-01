/**
 * Protocol manifest loader.
 *
 * MASTER_PLAN 0.21.P: one source of truth for constants. Addresses, chain id, fee rates and
 * factory versions come from `deployments/<chainId>.json`, which the contract deployment
 * script generates. Nothing here is hardcoded and nothing is duplicated in another app.
 *
 * MASTER_PLAN 0.21.R: production startup fails CLOSED. If the manifest is missing, if its
 * chain id disagrees with the configured chain, or if it is a mock/local manifest while the
 * environment claims PRODUCTION, the process refuses to start rather than falling back to a
 * localhost, test, zero or V0 address.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address")
  .transform((v) => v.toLowerCase());

const HashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const BaseUnitsSchema = z.string().regex(/^\d+$/);

const UpgradeableContractSchema = z.object({
  proxy: AddressSchema,
  implementation: AddressSchema,
  implementationVersion: z.string(),
  upgradeable: z.literal(true),
  proxyStandard: z.string(),
});

const ImmutableContractSchema = z.object({
  address: AddressSchema,
  upgradeable: z.literal(false),
  runtimeCodeHash: HashSchema.optional(),
});

const FactorySchema = z.object({
  address: AddressSchema,
  version: z.number().int().positive(),
  status: z.enum(["CANONICAL_ACTIVE", "CANONICAL_DEPRECATED"]),
  runtimeCodeHash: HashSchema.optional(),
});

const ImplementationSchema = z.object({
  contract: z.string(),
  address: AddressSchema,
  runtimeCodeHash: HashSchema.optional(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.string(),
  protocolVersion: z.string(),
  environment: z.enum(["LOCAL", "PROVING", "CUTOVER", "PRODUCTION"]),
  chainId: z.number().int().positive(),
  networkName: z.string(),
  generatedAt: z.string(),
  deployer: AddressSchema,
  deploymentBlock: z.number().int().nonnegative(),
  compiler: z.object({
    version: z.string(),
    optimizer: z.object({ enabled: z.boolean(), runs: z.number() }),
    evmVersion: z.string(),
    viaIR: z.boolean(),
    metadataBytecodeHash: z.string(),
  }),
  roles: z.object({
    bootstrapAdmin: AddressSchema,
    guardian: AddressSchema,
    treasuryDestination: AddressSchema,
    dividendRootProposer: AddressSchema,
    timelock: AddressSchema.nullable(),
  }),
  external: z.object({
    canonicalUSDC: AddressSchema,
    usdcDecimals: z.literal(6),
    dexRouter: AddressSchema,
    dexFactory: AddressSchema,
    lpBurnAddress: AddressSchema,
    isMockExternal: z.boolean(),
  }),
  contracts: z.object({
    registry: UpgradeableContractSchema,
    agentGoods: UpgradeableContractSchema,
    protocolTreasury: ImmutableContractSchema,
    activeFactories: z.array(FactorySchema).min(1),
    deprecatedFactories: z.array(FactorySchema),
    componentImplementations: z.record(ImplementationSchema),
  }),
  economics: z.object({
    aicGenesisSupply: BaseUnitsSchema,
    aicDecimals: z.literal(18),
    virtualUSDCReserve: BaseUnitsSchema,
    transitionThresholdAIC: BaseUnitsSchema,
    /** Per deployment since AgentGoods.configureCurve (30 by default). */
    transitionThresholdPercent: z.number().gt(0).lt(100),
    lpPremiumBps: z.number().int(),
    commerceFeeBps: z.number().int(),
    /** Minimum owner-funded initial market capital for a new store, read from the deployed factory. */
    minInitialOwnerSeedUSDC: BaseUnitsSchema,
    /** Smallest trade on the curve (base units); pays at least one unit of each trading fee. */
    minTradeUSDC: BaseUnitsSchema.default("100"),
    /** Smallest product price (base units); keeps the holders' buyback at 100 base units or more. */
    minProductPriceUSDC: BaseUnitsSchema.default("523"),
    holderReserveBps: z.number().int(),
    dividendProcessingFeeBps: z.number().int(),
    dividendProcessingFeeBasis: z.literal("committed_holder_reserve"),
    agentGoodsProtocolFeeBps: z.number().int(),
    agentGoodsControllerFeeBps: z.number().int(),
    postTransitionProtocolFeeBps: z.literal(0),
    storeCreationFeeUSDC: z.literal("0"),
    takeoverObservationPeriodSeconds: z.number().int(),
    minDistributionUSDC: BaseUnitsSchema,
    rootChallengePeriodSeconds: z.number().int(),
    rootLivenessTimeoutSeconds: z.number().int(),
    signalWindowSeconds: z.number().int(),
    minSignalsForRate: z.number().int().positive(),
    /** MASTER_PLAN 29C: dividend entitlement weight is the minimum balance over this window. */
    holdingWindowSeconds: z.number().int().nonnegative(),
    /**
     * StoreBase.WITHDRAWAL_COOLDOWN: the minimum gap between a controller's proceeds withdrawals.
     *
     * Required, not optional. A missing value would have to be defaulted, and the only safe
     * default is 0 - which would publish "withdraw whenever you like" for a protocol that reverts
     * with WithdrawalTooSoon. Failing at boot is the correct outcome for a record that does not
     * know a rule the chain enforces.
     */
    ownerWithdrawalCooldownSeconds: z.number().int().nonnegative(),
    nominalBlockTimeSeconds: z.number().int().positive(),
    salesRewardRate: z.object({
      numerator: z.number().int(),
      denominator: z.number().int(),
      minimumPool: BaseUnitsSchema,
      poolGate: BaseUnitsSchema,
    }),
    rentalsRewardRate: z.object({
      numerator: z.number().int(),
      denominator: z.number().int(),
      minimumPool: BaseUnitsSchema,
      poolGate: BaseUnitsSchema,
    }),
  }),
});

export type ProtocolManifest = z.infer<typeof ManifestSchema>;

export class ManifestError extends Error {
  constructor(message: string) {
    super(`Protocol manifest refused: ${message}`);
    this.name = "ManifestError";
  }
}

export interface LoadManifestOptions {
  deploymentsDir: string;
  chainId: number;
  environment: string;
}

/**
 * Loads and validates the manifest for `chainId`, failing closed on every mismatch.
 */
export function loadManifest(options: LoadManifestOptions): ProtocolManifest {
  const file = path.join(options.deploymentsDir, `${options.chainId}.json`);
  if (!fs.existsSync(file)) {
    throw new ManifestError(
      `no manifest at ${file}. Deploy the contracts first (contracts/script/deploy.js). ` +
        `The backend never falls back to default or V0 addresses. [MASTER_PLAN 0.21.R]`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ManifestError(`${file} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestError(`${file} failed validation:\n${parsed.error.toString()}`);
  }
  const manifest = parsed.data;

  if (manifest.chainId !== options.chainId) {
    throw new ManifestError(
      `${file} declares chainId ${manifest.chainId} but the backend is configured for ${options.chainId}`
    );
  }

  if (options.environment === "PRODUCTION") {
    if (manifest.environment !== "PRODUCTION") {
      throw new ManifestError(
        `backend environment is PRODUCTION but the manifest says ${manifest.environment}`
      );
    }
    if (manifest.external.isMockExternal) {
      throw new ManifestError("a PRODUCTION backend cannot use a manifest built with mock USDC/router");
    }
    if (manifest.roles.timelock === null) {
      throw new ManifestError(
        "a PRODUCTION manifest must record the timelock address after the multisig handoff"
      );
    }
  }

  return manifest;
}

/** Every canonical protocol address, for the fail-closed address guard used by services. */
export function coreAddresses(manifest: ProtocolManifest): Record<string, string> {
  return {
    registry: manifest.contracts.registry.proxy,
    registryImplementation: manifest.contracts.registry.implementation,
    agentGoods: manifest.contracts.agentGoods.proxy,
    agentGoodsImplementation: manifest.contracts.agentGoods.implementation,
    protocolTreasury: manifest.contracts.protocolTreasury.address,
    canonicalUSDC: manifest.external.canonicalUSDC,
    dexRouter: manifest.external.dexRouter,
    dexFactory: manifest.external.dexFactory,
  };
}
