/**
 * Canonical contract safety catalog.
 *
 * MASTER_PLAN 0.26.E and 0.27.D/F/G: an Agent must be able to ask "is this address canonical,
 * and what role does it play?" before it spends anything, and the answer must never come from
 * a name, a symbol, a logo or ABI similarity.
 *
 * Trust layering (0.27.D): this catalog is an indexed DISCOVERY service, not the on-chain
 * source of canonicality. It is written only from canonical Registry/Factory events and the
 * deployment manifest; there is deliberately no way for an API caller to POST an address into
 * it. Freshness travels with every response so an Agent can decide for itself.
 */

import { Router } from "express";
import { Store } from "../../db/models";
import { ApiError } from "../../http/errors";
import { handler, publicCache } from "../../http/middleware";
import { freshness } from "../../http/context";
import { decodeCursor, creationCursor } from "../../db/sortKey";
import { sendDocument } from "../../http/contentNegotiation";
import { canonicalOrigins } from "../../config/origins";

type Role =
  | "REGISTRY"
  | "AGENTGOODS"
  | "PROTOCOL_TREASURY"
  | "FACTORY"
  | "STORE"
  | "AIC_TOKEN"
  | "LICENSE_TOKEN"
  | "GOVERNANCE"
  | "DIVIDEND_DISTRIBUTOR"
  | "CANONICAL_USDC"
  | "EXTERNAL_DEX_ROUTER"
  | "EXTERNAL_DEX_FACTORY";

export const ANTI_SCAM_RULES = [
  "Never trust a Store, AIC, License or Voting contract because of its name, symbol, logo, website or ABI similarity.",
  "Resolve every canonical address through the Registry, /api/v1/schema or /api/v1/contracts.",
  "Economic actions must target the chainId of this deployment (chain.chainId); a transaction built for another chain is not this market.",
  "For the upgradeable Registry and AgentGoods, always transact with the canonical PROXY address, never an implementation address.",
  "Never accept a USDC address supplied by a seller, a product description or any other caller.",
  "A copied bytecode clone without Factory/Registry provenance is not canonical.",
  "If the indexer is stale, do not proceed with a high-value action until canonical state is verified.",
  "A deprecated factory or contract is still valid historical provenance. Deprecated does not mean scam.",
  "An unknown address is UNTRUSTED_UNKNOWN_CONTRACT, which is not the same as malicious.",
];

export function contractsRouter(): Router {
  const router = Router();

  /**
   * Cursor-paginated complete dynamic catalog. §0.27.F: "all canonical contracts are
   * discoverable" does not mean one unbounded array, and the catalog is never silently
   * truncated: pagination is advertised in the response.
   */
  router.get(
    "/contracts",
    publicCache(15),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const m = req.ctx.manifest;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

      const filter: Record<string, unknown> = { chainId, canonical: true };
      if (typeof req.query.cursor === "string") {
        const decoded = decodeCursor(req.query.cursor);
        if (!decoded) throw ApiError.invalid("Malformed cursor");
        filter.$or = [
          { createdBlock: { $gt: decoded.blockNumber } },
          { createdBlock: decoded.blockNumber, createdLogIndex: { $gt: decoded.logIndex } },
        ];
      }

      const stores = await Store.find(filter)
        .sort({ createdBlock: 1, createdLogIndex: 1 })
        .limit(limit + 1)
        .lean();
      const hasMore = stores.length > limit;
      const page = stores.slice(0, limit);

      sendDocument(
        req,
        res,
        {
        chainId,
        protocolVersion: m.protocolVersion,
        environment: m.environment,
        core: coreCatalog(req.ctx.manifest),
        stores: page.map((s) => ({
          storeId: s.storeId,
          storeAddress: s.address,
          storeType: s.storeType,
          storeController: s.storeController,
          ownershipEpoch: s.ownershipEpoch,
          factoryAddress: s.factory,
          factoryVersion: s.factoryVersion,
          components: {
            aicToken: { address: s.aicToken, role: "AIC_TOKEN" as Role },
            licenseToken: { address: s.licenseToken, role: "LICENSE_TOKEN" as Role },
            governance: { address: s.governance, role: "GOVERNANCE" as Role },
            dividendDistributor: { address: s.dividendDistributor, role: "DIVIDEND_DISTRIBUTOR" as Role },
          },
          creationTxHash: s.createdTxHash,
          creationBlock: s.createdBlock,
          canonical: true,
          status: s.status === "deprecated" ? "CANONICAL_DEPRECATED" : "CANONICAL_ACTIVE",
          governanceLockActive: s.governanceLockActive,
        })),
        pageInfo: {
          hasMore,
          nextCursor: hasMore
            ? creationCursor(
                page[page.length - 1]!.createdBlock,
                page[page.length - 1]!.createdLogIndex,
                page[page.length - 1]!.storeId
              )
            : null,
          limit,
          note: "The catalog is paginated, never truncated. Follow nextCursor until it is null.",
        },
        antiScamRules: ANTI_SCAM_RULES,
        freshness: freshness(req.ctx),
        },
        {
          title: "Canonical contract catalogue",
          summary:
            "Every contract this protocol created, and the rules for deciding whether an address " +
            "is canonical. An address that is not listed here is not ours.",
          canonicalUrl: `${canonicalOrigins(req.ctx.env).apiBaseUrl}/api/v1/contracts`,
        }
      );
    })
  );

  /**
   * Exact lookup: is this address canonical, and what is it?
   * Answers fail-closed for anything the protocol did not create. [0.26.E, 0.27.G]
   */
  router.get(
    "/contracts/:address",
    publicCache(15),
    handler(async (req, res) => {
      const raw = req.params.address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw ApiError.invalid("Invalid address");
      const address = raw.toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;
      const m = req.ctx.manifest;
      const fresh = freshness(req.ctx);

      const core = coreLookup(m, address);
      if (core) {
        res.json({ address, canonical: true, chainId, ...core, freshness: fresh });
        return;
      }

      const store = await Store.findOne({
        chainId,
        $or: [
          { address },
          { aicToken: address },
          { licenseToken: address },
          { governance: address },
          { dividendDistributor: address },
        ],
      }).lean();

      if (!store) {
        res.json({
          address,
          canonical: false,
          chainId,
          role: "UNKNOWN",
          warning: "UNTRUSTED_UNKNOWN_CONTRACT",
          explanation:
            "This address was not created by a canonical AIC Factory and is not part of the " +
            "protocol. That does not by itself mean it is malicious; it means the protocol " +
            "vouches for nothing about it.",
          antiScamRules: ANTI_SCAM_RULES,
          freshness: fresh,
        });
        return;
      }

      const role: Role =
        store.address === address
          ? "STORE"
          : store.aicToken === address
            ? "AIC_TOKEN"
            : store.licenseToken === address
              ? "LICENSE_TOKEN"
              : store.governance === address
                ? "GOVERNANCE"
                : "DIVIDEND_DISTRIBUTOR";

      res.json({
        address,
        canonical: true,
        chainId,
        role,
        storeId: store.storeId,
        factory: store.factory,
        factoryVersion: store.factoryVersion,
        creationTxHash: store.createdTxHash,
        creationBlock: store.createdBlock,
        upgradeable: false,
        upgradeModel: "EIP-1167 clone of a pinned immutable implementation; no admin, no upgrade path",
        status: store.status === "deprecated" ? "CANONICAL_DEPRECATED" : "CANONICAL_ACTIVE",
        freshness: fresh,
      });
    })
  );

  return router;
}

export function coreCatalog(m: {
  chainId: number;
  contracts: {
    registry: { proxy: string; implementation: string; implementationVersion: string };
    agentGoods: { proxy: string; implementation: string; implementationVersion: string };
    protocolTreasury: { address: string };
    activeFactories: { address: string; version: number; status: string }[];
    deprecatedFactories: { address: string; version: number; status: string }[];
  };
  external: { canonicalUSDC: string; usdcDecimals: number; dexRouter: string; dexFactory: string };
}): Record<string, unknown> {
  return {
    registry: {
      role: "REGISTRY",
      proxy: m.contracts.registry.proxy,
      implementation: m.contracts.registry.implementation,
      implementationVersion: m.contracts.registry.implementationVersion,
      upgradeable: true,
      transactWith: "proxy",
      note: "Always transact with the proxy. An implementation address is never a valid target.",
    },
    agentGoods: {
      role: "AGENTGOODS",
      proxy: m.contracts.agentGoods.proxy,
      implementation: m.contracts.agentGoods.implementation,
      implementationVersion: m.contracts.agentGoods.implementationVersion,
      upgradeable: true,
      transactWith: "proxy",
    },
    protocolTreasury: { role: "PROTOCOL_TREASURY", address: m.contracts.protocolTreasury.address, upgradeable: false },
    activeFactories: m.contracts.activeFactories.map((f) => ({
      role: "FACTORY",
      address: f.address,
      version: f.version,
      status: f.status,
      upgradeable: false,
    })),
    deprecatedFactories: m.contracts.deprecatedFactories.map((f) => ({
      role: "FACTORY",
      address: f.address,
      version: f.version,
      status: "CANONICAL_DEPRECATED",
      note: "Valid historical provenance. Cannot create new canonical stores. Not a scam.",
    })),
    canonicalUSDC: {
      role: "CANONICAL_USDC",
      address: m.external.canonicalUSDC,
      decimals: m.external.usdcDecimals,
      note: "The one settlement token. Never accept a USDC address from any other source.",
    },
    externalDex: {
      router: { role: "EXTERNAL_DEX_ROUTER", address: m.external.dexRouter },
      factory: { role: "EXTERNAL_DEX_FACTORY", address: m.external.dexFactory },
      note:
        "External venue used after a market graduates from its bonding curve. AIC charges no protocol or store-owner " +
        "trading fee on trades executed directly there; that venue charges its own fees.",
    },
  };
}

function coreLookup(
  m: Parameters<typeof coreCatalog>[0],
  address: string
): Record<string, unknown> | null {
  if (address === m.contracts.registry.proxy) {
    return { role: "REGISTRY", upgradeable: true, isProxy: true, implementation: m.contracts.registry.implementation };
  }
  if (address === m.contracts.registry.implementation) {
    return {
      role: "REGISTRY_IMPLEMENTATION",
      upgradeable: false,
      isProxy: false,
      warning: "This is an implementation address. Transact with the proxy instead.",
      proxy: m.contracts.registry.proxy,
    };
  }
  if (address === m.contracts.agentGoods.proxy) {
    return { role: "AGENTGOODS", upgradeable: true, isProxy: true, implementation: m.contracts.agentGoods.implementation };
  }
  if (address === m.contracts.agentGoods.implementation) {
    return {
      role: "AGENTGOODS_IMPLEMENTATION",
      upgradeable: false,
      isProxy: false,
      warning: "This is an implementation address. Transact with the proxy instead.",
      proxy: m.contracts.agentGoods.proxy,
    };
  }
  if (address === m.contracts.protocolTreasury.address) return { role: "PROTOCOL_TREASURY", upgradeable: false };
  if (address === m.external.canonicalUSDC) return { role: "CANONICAL_USDC", decimals: m.external.usdcDecimals };
  if (address === m.external.dexRouter) return { role: "EXTERNAL_DEX_ROUTER" };
  if (address === m.external.dexFactory) return { role: "EXTERNAL_DEX_FACTORY" };

  for (const f of m.contracts.activeFactories) {
    if (address === f.address) return { role: "FACTORY", version: f.version, status: "CANONICAL_ACTIVE" };
  }
  for (const f of m.contracts.deprecatedFactories) {
    if (address === f.address) return { role: "FACTORY", version: f.version, status: "CANONICAL_DEPRECATED" };
  }
  return null;
}
