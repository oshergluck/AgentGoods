// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {StoreBase} from "./StoreBase.sol";
import {StoreType} from "../interfaces/IAICoin.sol";
import {LicenseKind} from "../interfaces/ILicenseToken.sol";

/**
 * @title AICStoreSales
 * @notice Canonical immutable Sales store: permanent, defined-license digital products.
 *
 * @dev Reward model (MASTER_PLAN 15). The V0 Sales contract intended a geometric
 *      pool-decay incentive at 2/1000 (0.2%) of the remaining pool per purchased unit,
 *      with a 500 base-unit floor. V0 computed the decayed local pool but then read the
 *      undecayed storage value inside the loop, so every unit of a multi-unit purchase
 *      received the same reward. V1 preserves the intended economics (progressive decay,
 *      identical rate and floor) and fixes that defect; see docs/AIC_INCENTIVE_MODEL.md
 *      and docs/DECISIONS.md.
 *
 *      There is no server-signed purchase authorisation. V0 required a `serverSigner`
 *      ECDSA payload over `abi.encodePacked(...)` with no domain separator, no verifying
 *      contract and no nonce, which was replayable across stores and chains. In an
 *      Agent-first marketplace purchases are simply permissionless, so the entire
 *      signature-replay surface is removed rather than patched. Quote integrity is instead
 *      bound on-chain by `expectedVersion` and `maxTotalUSDC`. [5.6, 0.24.G, 0.24.H]
 */
contract AICStoreSales is StoreBase {
    error RentalPeriodNotSupported();

    function storeType() public pure override returns (StoreType) {
        return StoreType.Sales;
    }

    function rewardRateBps() public pure override returns (uint256) {
        return 2;
    }

    function rewardRateDenominator() public pure override returns (uint256) {
        return 1000;
    }

    function rewardMinimumPool() public pure override returns (uint256) {
        return 500;
    }

    function rewardPoolGate() public pure override returns (uint256) {
        return 0;
    }

    function _validateRentalPeriod(uint32 rentalPeriodSeconds) internal pure override {
        if (rentalPeriodSeconds != 0) revert RentalPeriodNotSupported();
    }

    /// @notice Total gross USDC for `units` of a product at its current price.
    function quoteTotal(bytes32 productId, uint32 units) public view returns (uint256) {
        Product memory p = _products[productId];
        if (!p.exists) revert UnknownProduct();
        return uint256(p.priceUSDC) * units;
    }

    /**
     * @notice Buy `units` of a product and receive a permanent, non-transferable license.
     * @param expectedVersion Product version the Agent quoted. A mismatch reverts, so a
     *        concurrent price or terms edit can never silently execute against a stale quote.
     * @param maxTotalUSDC Maximum gross USDC the Agent authorises for this purchase.
     */
    function purchase(
        bytes32 productId,
        uint32 units,
        uint64 expectedVersion,
        uint256 maxTotalUSDC,
        bytes32 permissionHash,
        string calldata licenseURI
    ) external nonReentrant whenCommerceAllowed returns (uint256 licenseId) {
        if (units == 0 || units > MAX_UNITS_PER_PURCHASE) revert InvalidUnits();

        Product storage p = _requirePurchasable(productId, expectedVersion);

        uint256 gross = uint256(p.priceUSDC) * units;
        if (gross > maxTotalUSDC) revert PriceAboveMaximum(gross, maxTotalUSDC);

        _consumeInventory(p, uint64(units));

        Settlement memory s = _settle(msg.sender, gross);

        licenseId = _mintLicense(
            msg.sender, productId, p.version, 0, units, LicenseKind.PermanentPurchase, permissionHash, licenseURI
        );

        uint256 reward = _payReward(msg.sender, units);

        emit CommerceSettled(
            productId,
            msg.sender,
            licenseId,
            units,
            s.gross,
            s.protocolFee,
            s.net,
            s.holderReserve,
            s.ownerAvailable,
            reward,
            0
        );
    }
}
