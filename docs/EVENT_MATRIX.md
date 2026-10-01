# Event matrix

> **Generated file.** Produced by `node infra/scripts/generate-docs.mjs` from `deployments/abi/*.json` and `backend/src/indexer/abis.ts`.
> Do not edit by hand: the next regeneration will overwrite it, and a hand-edited matrix that
> disagrees with the code is worse than no matrix at all.


Every event the contracts emit, and whether the indexer watches it. An unwatched event is not a bug by itself — plenty of events exist for on-chain consumers or for explorers — but an event that a projection depends on and that nobody watches is exactly the failure that produces a silently stale read model.

## DividendDistributor

| Event | Indexed by | Signature |
|---|---|---|
| `Claimed` | **yes** | `(uint256 indexed epochId, uint256 indexed index, address indexed account, uint256 amountUSDC, uint256 epochClaimedTotal)` |
| `DistributionAbandoned` | **yes** | `(uint256 indexed epochId, uint256 returnedUSDC, address indexed by)` |
| `DistributionOpened` | **yes** | `(uint256 indexed epochId, uint256 snapshotBlock, uint256 committedReserveUSDC, uint256 eligibleSupplyAtSnapshot, address indexed openedBy, uint32 holdingWindowSeconds, uint256 windowStartBlock)` |
| `RootFinalized` | **yes** | `(uint256 indexed epochId, bytes32 merkleRoot, bytes32 datasetHash, uint256 claimableUSDC, uint256 rootTotalUSDC, uint256 processingFeeUSDC, uint256 dustReturnedUSDC)` |
| `RootProposed` | **yes** | `(uint256 indexed epochId, uint32 indexed revision, bytes32 merkleRoot, bytes32 datasetHash, uint256 rootTotalUSDC, address indexed proposer, uint256 challengeEndsAt, uint256 eligibleMinSupply)` |
| `RootProposerSet` | **yes** | `(address indexed proposer, bool allowed)` |

## AICoin

| Event | Indexed by | Signature |
|---|---|---|
| `Approval` | no | `(address indexed owner, address indexed spender, uint256 value)` |
| `BalanceLocked` | **yes** | `(address indexed account, bytes32 indexed lockId, address indexed locker, uint256 amount)` |
| `BalanceUnlocked` | **yes** | `(address indexed account, bytes32 indexed lockId, address indexed locker, uint256 amount)` |
| `EligibilityPurged` | **yes** | `(address indexed account, uint256 removedBalance)` |
| `LeaderChanged` | **yes** | `(address indexed previousLeader, address indexed newLeader, uint256 newLeaderBalance, uint256 since)` |
| `MarketBurn` | **yes** | `(address indexed market, uint256 amount)` |
| `TakeoverCandidacyCancelled` | **yes** | `(address indexed candidate)` |
| `TakeoverCandidacyOpened` | **yes** | `(address indexed candidate, uint256 lockedBalance, uint256 openedAt)` |
| `TakeoverFinalized` | **yes** | `(address indexed newController, uint256 balance, uint256 candidacyOpenedAt, uint256 finalizedAt)` |
| `Transfer` | **yes** | `(address indexed from, address indexed to, uint256 value)` |
| `Wired` | no | `(address indexed store, address indexed governance)` |

## AICGovernance

| Event | Indexed by | Signature |
|---|---|---|
| `ImplementationConfirmed` | **yes** | `(uint256 indexed proposalId, uint32 indexed round, address indexed voter, uint256 weight, uint256 confirmedYesPower, uint256 requiredYesPower)` |
| `ImplementationDisputed` | **yes** | `(uint256 indexed proposalId, uint32 indexed round, address indexed voter, string reason)` |
| `ImplementationMarked` | **yes** | `(uint256 indexed proposalId, uint32 indexed round, bytes32 evidenceHash, string evidenceURI, uint256 markedAt)` |
| `ProposalCancelled` | **yes** | `(uint256 indexed proposalId)` |
| `ProposalCreated` | **yes** | `(uint256 indexed proposalId, address indexed proposer, bytes32 indexed contentHash, uint256 snapshotBlock, uint256 eligibleSupplyAtSnapshot, uint256 votingDeadline, string descriptionURI)` |
| `ProposalFailed` | **yes** | `(uint256 indexed proposalId, uint256 yesPower, uint256 noPower)` |
| `ProposalPassed` | **yes** | `(uint256 indexed proposalId, uint256 totalOriginalYesPower, uint256 eligibleSupplyAtSnapshot, uint256 passedAtBlock, uint256 passedAtTimestamp)` |
| `VerificationThresholdReached` | **yes** | `(uint256 indexed proposalId, uint256 confirmedYesPower, uint256 totalOriginalYesPower)` |
| `VoteCast` | **yes** | `(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)` |
| `VoteLockReleased` | **yes** | `(uint256 indexed proposalId, address indexed voter, uint256 amount)` |

## AICRegistry

| Event | Indexed by | Signature |
|---|---|---|
| `ControllerChanged` | **yes** | `(bytes32 indexed storeId, address indexed previousController, address indexed newController, uint64 ownershipEpoch, uint8 reason)` |
| `FactoryAuthorized` | **yes** | `(address indexed factory, uint64 version, uint256 atBlock)` |
| `FactoryDeprecated` | **yes** | `(address indexed factory, uint64 version, uint256 atBlock)` |
| `HoldingWindowChanged` | no | `(uint32 previousSeconds, uint32 newSeconds)` |
| `Initialized` | no | `(uint64 version)` |
| `ProtocolFeeChanged` | **yes** | `(bytes32 indexed feeType, uint16 oldFeeBps, uint16 newFeeBps)` |
| `RegistryInitialized` | no | `(uint256 chainId, address usdc, address agentGoods, address treasury)` |
| `RoleAdminChanged` | no | `(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)` |
| `RoleGranted` | no | `(bytes32 indexed role, address indexed account, address indexed sender)` |
| `RoleRevoked` | no | `(bytes32 indexed role, address indexed account, address indexed sender)` |
| `ScopePaused` | **yes** | `(bytes32 indexed scope, bool paused)` |
| `StoreRegistered` | **yes** | `(bytes32 indexed storeId, address indexed store, address indexed aicToken, address licenseToken, address governance, address dividendDistributor, address factory, uint64 factoryVersion, address storeCreator, uint8 storeType)` |
| `TreasurySet` | no | `(address indexed previousTreasury, address indexed newTreasury)` |
| `AgentGoodsSet` | no | `(address indexed previousAgentGoods, address indexed newAgentGoods)` |
| `Upgraded` | **yes** | `(address indexed implementation)` |

## AICStoreRentals

| Event | Indexed by | Signature |
|---|---|---|
| `AccessAttestorChanged` | **yes** | `(address indexed previousAttestor, address indexed newAttestor)` |
| `CommerceSettled` | **yes** | `(bytes32 indexed productId, address indexed buyer, uint256 indexed licenseId, uint32 units, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 netUSDC, uint256 holderReserveUSDC, uint256 ownerAvailableUSDC, uint256 rewardAIC, uint64 expiresAt)` |
| `ControllerChanged` | **yes** | `(address indexed previousController, address indexed newController, uint64 ownershipEpoch, uint8 reason)` |
| `GovernanceLockActivated` | **yes** | `(uint256 indexed proposalId, uint256 unresolvedCount)` |
| `GovernanceLockReleased` | **yes** | `(uint256 indexed proposalId, uint256 unresolvedCount)` |
| `HolderReserveAccrued` | **yes** | `(uint256 amount, uint256 newUnfinalizedReserve, uint256 lifetimeAccrued)` |
| `HolderReserveCommitted` | **yes** | `(address indexed distributor, uint256 amount, uint256 newUnfinalizedReserve)` |
| `HolderReserveReturned` | **yes** | `(address indexed distributor, uint256 amount, uint256 newUnfinalizedReserve)` |
| `OwnerProceedsWithdrawn` | **yes** | `(address indexed to, uint256 amount, uint256 remainingOwnerAvailable)` |
| `ProductCreated` | **yes** | `(bytes32 indexed productId, uint64 version, uint128 priceUSDC, uint64 inventory, uint32 rentalPeriodSeconds, bytes32 contentHash, string metadataURI)` |
| `ProductUpdated` | **yes** | `(bytes32 indexed productId, uint64 version, uint128 priceUSDC, uint64 inventory, uint32 rentalPeriodSeconds, bool active, bytes32 contentHash, string metadataURI)` |
| `RewardPoolFunded` | **yes** | `(address indexed from, uint256 amount, uint256 newPool)` |
| `RewardPoolWithdrawn` | **yes** | `(address indexed to, uint256 amount, uint256 newPool)` |
| `StoreProfileUpdated` | **yes** | `(string profile)` |
| `StoreStatusChanged` | **yes** | `(uint8 previousStatus, uint8 newStatus)` |
| `StoreWired` | no | `(address licenseToken, address governance, address dividendDistributor)` |
| `TokenRescued` | no | `(address indexed token, address indexed to, uint256 amount)` |
| `TokenSavingDeclared` | **yes** | `(bytes32 indexed productId, uint64 version, uint64 declaredTokensSaved, bytes32 declaredModelTier, uint8 basis, uint64 declaredAt)` |

## AICStoreSales

| Event | Indexed by | Signature |
|---|---|---|
| `AccessAttestorChanged` | **yes** | `(address indexed previousAttestor, address indexed newAttestor)` |
| `CommerceSettled` | **yes** | `(bytes32 indexed productId, address indexed buyer, uint256 indexed licenseId, uint32 units, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 netUSDC, uint256 holderReserveUSDC, uint256 ownerAvailableUSDC, uint256 rewardAIC, uint64 expiresAt)` |
| `ControllerChanged` | **yes** | `(address indexed previousController, address indexed newController, uint64 ownershipEpoch, uint8 reason)` |
| `GovernanceLockActivated` | **yes** | `(uint256 indexed proposalId, uint256 unresolvedCount)` |
| `GovernanceLockReleased` | **yes** | `(uint256 indexed proposalId, uint256 unresolvedCount)` |
| `HolderReserveAccrued` | **yes** | `(uint256 amount, uint256 newUnfinalizedReserve, uint256 lifetimeAccrued)` |
| `HolderReserveCommitted` | **yes** | `(address indexed distributor, uint256 amount, uint256 newUnfinalizedReserve)` |
| `HolderReserveReturned` | **yes** | `(address indexed distributor, uint256 amount, uint256 newUnfinalizedReserve)` |
| `OwnerProceedsWithdrawn` | **yes** | `(address indexed to, uint256 amount, uint256 remainingOwnerAvailable)` |
| `ProductCreated` | **yes** | `(bytes32 indexed productId, uint64 version, uint128 priceUSDC, uint64 inventory, uint32 rentalPeriodSeconds, bytes32 contentHash, string metadataURI)` |
| `ProductUpdated` | **yes** | `(bytes32 indexed productId, uint64 version, uint128 priceUSDC, uint64 inventory, uint32 rentalPeriodSeconds, bool active, bytes32 contentHash, string metadataURI)` |
| `RewardPoolFunded` | **yes** | `(address indexed from, uint256 amount, uint256 newPool)` |
| `RewardPoolWithdrawn` | **yes** | `(address indexed to, uint256 amount, uint256 newPool)` |
| `StoreProfileUpdated` | **yes** | `(string profile)` |
| `StoreStatusChanged` | **yes** | `(uint8 previousStatus, uint8 newStatus)` |
| `StoreWired` | no | `(address licenseToken, address governance, address dividendDistributor)` |
| `TokenRescued` | no | `(address indexed token, address indexed to, uint256 amount)` |
| `TokenSavingDeclared` | **yes** | `(bytes32 indexed productId, uint64 version, uint64 declaredTokensSaved, bytes32 declaredModelTier, uint8 basis, uint64 declaredAt)` |

## LicenseToken

| Event | Indexed by | Signature |
|---|---|---|
| `AccessGranted` | **yes** | `(uint256 indexed licenseId, address indexed holder, uint64 grantedAt, uint32 grantCount)` |
| `Approval` | no | `(address indexed owner, address indexed approved, uint256 indexed tokenId)` |
| `ApprovalForAll` | no | `(address indexed owner, address indexed operator, bool approved)` |
| `BuyerSignalChanged` | **yes** | `(uint256 indexed licenseId, address indexed signaller, bytes32 indexed productId, bool previousWorthIt, bool worthIt, uint64 changedAt)` |
| `BuyerSignalSubmitted` | **yes** | `(uint256 indexed licenseId, address indexed signaller, bytes32 indexed productId, bool worthIt, bool selfSignal, uint64 signalledAt)` |
| `LicenseIssued` | **yes** | `(uint256 indexed tokenId, address indexed to, bytes32 indexed productId, uint64 productVersion, uint64 expiresAt, uint32 quantity, uint8 kind, bytes32 permissionHash)` |
| `Transfer` | **yes** | `(address indexed from, address indexed to, uint256 indexed tokenId)` |

## ProtocolTreasury

| Event | Indexed by | Signature |
|---|---|---|
| `DestinationChanged` | **yes** | `(address indexed previousDestination, address indexed newDestination)` |
| `Rescued` | no | `(address indexed token, address indexed to, uint256 amount)` |
| `RevenueRecorded` | **yes** | `(bytes32 indexed feeType, address indexed token, address indexed source, uint256 amount, uint256 newTotal)` |
| `RoleAdminChanged` | no | `(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)` |
| `RoleGranted` | no | `(bytes32 indexed role, address indexed account, address indexed sender)` |
| `RoleRevoked` | no | `(bytes32 indexed role, address indexed account, address indexed sender)` |
| `Withdrawn` | **yes** | `(address indexed token, address indexed to, uint256 amount)` |

## StoreFactory

| Event | Indexed by | Signature |
|---|---|---|
| `StoreCreated` | **yes** | `(bytes32 indexed storeId, address indexed store, address indexed creator, address aicToken, address licenseToken, address governance, address dividendDistributor, uint8 storeType, uint64 factoryVersion, string storeName, string aicName, string aicSymbol)` |

## AgentGoods

| Event | Indexed by | Signature |
|---|---|---|
| `ControllerFeesWithdrawn` | **yes** | `(address indexed aicToken, address indexed controller, uint256 amount)` |
| `DexConfigured` | no | `(address router, address dexFactory, address lpBurnAddress)` |
| `Initialized` | no | `(uint64 version)` |
| `LiquidityTransition` | **yes** | `(address indexed aicToken, address indexed pair, uint256 usdcToLP, uint256 tokensToLP, uint256 lpTokens, uint256 tokensBurned)` |
| `MarketInitialized` | **yes** | `(address indexed aicToken, address indexed store, bytes32 indexed storeId, uint256 genesisInventory, uint256 virtualUSDCReserve, uint256 virtualTokenReserve, uint256 createdBlock)` |
| `RoleAdminChanged` | no | `(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)` |
| `RoleGranted` | no | `(bytes32 indexed role, address indexed account, address indexed sender)` |
| `RoleRevoked` | no | `(bytes32 indexed role, address indexed account, address indexed sender)` |
| `TokensPurchased` | **yes** | `(address indexed aicToken, address indexed buyer, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 controllerFeeUSDC, uint256 netCurveUSDC, uint256 tokensOut, uint256 netSoldFromCurve, uint256 virtualUSDCReserve, uint256 virtualTokenReserve)` |
| `TokensSold` | **yes** | `(address indexed aicToken, address indexed seller, uint256 tokensIn, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 controllerFeeUSDC, uint256 netUSDCOut, uint256 netSoldFromCurve, uint256 virtualUSDCReserve, uint256 virtualTokenReserve)` |
| `Upgraded` | **yes** | `(address indexed implementation)` |

---

79 of 104 events are watched by the indexer.

Event identity is `(chainId, txHash, logIndex)` everywhere: that tuple is what makes projection exactly-once, what makes webhook delivery deduplicate, and what makes a reorg rollback exact rather than approximate.

