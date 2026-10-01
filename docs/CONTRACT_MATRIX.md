# Contract matrix

> **Generated file.** Produced by `node infra/scripts/generate-docs.mjs` from `deployments/<chainId>.json` and `deployments/abi/`.
> Do not edit by hand: the next regeneration will overwrite it, and a hand-edited matrix that
> disagrees with the code is worse than no matrix at all.


Every contract the protocol deploys, how it is deployed, whether it can be upgraded, and what that means for anyone holding value in it.

Generated from the `31337` manifest (LOCAL), protocol version 1.0.0.

## Upgradeable core

| Contract | Proxy | Implementation | Standard | Upgradeable |
|---|---|---|---|---|
| registry | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` | `0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154` | ERC1967/UUPS | yes |
| agentGoods | `0x82e01223d51Eb87e16A03E24687EDF0F294da6f1` | `0xCD8a1C3ba11CF5ECfa6267617243239504a98d90` | ERC1967/UUPS | yes |

An upgradeable contract can change behaviour under existing holders. Only the Registry and AgentGoods are upgradeable, and both are behind a timelock in production. Everything a store owns is immutable — see below.

## Immutable singletons

| Contract | Address | Runtime code hash |
|---|---|---|
| protocolTreasury | `0x7969c5eD335650692Bc04293B07F5BF2e7A673C0` | `0xdf66f8a8e6cb4ea751402d1aa71737408e022ed6b9c637f98ef59ce92d70f8d3` |
| StoreFactory v1 (CANONICAL_ACTIVE) | `0x922D6956C99E12DFeB3224DEA977D0939758A1Fe` | `0xeaf03d217612cd45174aac2315e0d95ea4658e1ed8e9116845650ba3cdaa0319` |

## Per-store components (EIP-1167 clones)

Each store gets its own instance of every one of these, created atomically by the Factory in a single transaction. They are minimal-proxy clones of a fixed implementation, so they are cheap to create and **cannot be upgraded**: what a store owner deploys is what they keep.

| Component | Contract | Implementation | Runtime code hash |
|---|---|---|---|
| aiCoin | AICoin | `0xc351628EB244ec633d5f21fBD6621e1a683B1181` | `0x8bc029736b4b02bbecef4c6b657c0d7a2b5b8f6f1e52993eb2c68a3eea1a1dde` |
| salesStore | AICStoreSales | `0xFD471836031dc5108809D173A067e8486B9047A3` | `0x8c0f27e46aafc5183a21c80191fc0318388886a9dfbdb9050b603f4d28a84f60` |
| rentalsStore | AICStoreRentals | `0xcbEAF3BDe82155F56486Fb5a1072cb8baAf547cc` | `0xaf757a86b57e1be8e31fdb7521b31f06a2aca58db2dd078ec55faedea7705746` |
| licenseToken | LicenseToken | `0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f` | `0x7b393e239cc867b04cee70eb9ca9316d1c5b8ff52c7f3ea79ce38e4ab972f6b2` |
| governance | AICGovernance | `0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07` | `0x368d11c520f27b17af47946f8685cfdd755ff317aa5f53332b7a2048954f65bd` |
| distributor | DividendDistributor | `0x162A433068F51e18b7d13932F27e66a3f99E6890` | `0x7283c438a909715f896ec87ba7efb11fe6400863fbce86ae654bce13d9fa077d` |

The runtime code hash is what makes provenance checkable: an Agent can confirm that a store component is a clone of the exact implementation listed here, rather than a contract that merely presents the same interface.

## External dependencies

| Role | Address | Notes |
|---|---|---|
| canonical USDC | `0x36C02dA8a0983159322a80FFE9F24b1acfF8B570` | 6 decimals |
| DEX router | `0x1291Be112d480055DaFd8a610b7d1e203891C274` | UniswapV2-compatible |
| DEX factory | `0x4c5859f0F772848b2D91F1D83E2Fe57935348029` | |
| LP burn address | `0x000000000000000000000000000000000000dEaD` | LP tokens are sent here at the transition and locked forever |
| mock external infrastructure | **YES — LOCAL ONLY** | the deployment gate refuses a true value off LOCAL |

