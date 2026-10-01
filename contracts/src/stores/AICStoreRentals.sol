// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {StoreBase} from "./StoreBase.sol";
import {StoreType} from "../interfaces/IAICoin.sol";
import {LicenseKind} from "../interfaces/ILicenseToken.sol";

/**
 * @title AICStoreRentals
 * @notice Canonical immutable Rentals store: timed access to digital products and services.
 *
 * @dev Reward model (MASTER_PLAN 15). Sales and Rentals deliberately do NOT share a decay
 *      rate. V0 Rentals pays 2/100000 (0.002%) of the PROGRESSIVELY REDUCED pool per rented
 *      period, behind a 500 base-unit per-step floor and an additional 100000 base-unit pool
 *      gate. V1 preserves all three parameters exactly; only the unreachable double
 *      pool reduction is removed. See docs/AIC_INCENTIVE_MODEL.md.
 *
 *      Rental time semantics (0.24.I): expiry is derived from `block.timestamp` at
 *      settlement plus `periods * rentalPeriodSeconds`. The end instant is exclusive: a
 *      license is valid while `block.timestamp < expiresAt`. Inventory models concurrent
 *      rental slots and is decremented by exactly one per rental, matching V0.
 */
contract AICStoreRentals is StoreBase {
    /// @notice Bounds on a single configurable rental period.
    uint32 public constant MIN_RENTAL_PERIOD_SECONDS = 60;
    uint32 public constant MAX_RENTAL_PERIOD_SECONDS = 365 days;

    error InvalidRentalPeriod();

    function storeType() public pure override returns (StoreType) {
        return StoreType.Rentals;
    }

    function rewardRateBps() public pure override returns (uint256) {
        return 2;
    }

    function rewardRateDenominator() public pure override returns (uint256) {
        return 100000;
    }

    function rewardMinimumPool() public pure override returns (uint256) {
        return 500;
    }

    function rewardPoolGate() public pure override returns (uint256) {
        return 100000;
    }

    function _validateRentalPeriod(uint32 rentalPeriodSeconds) internal pure override {
        if (rentalPeriodSeconds < MIN_RENTAL_PERIOD_SECONDS || rentalPeriodSeconds > MAX_RENTAL_PERIOD_SECONDS) {
            revert InvalidRentalPeriod();
        }
    }

    function quoteTotal(bytes32 productId, uint32 periods) public view returns (uint256) {
        Product memory p = _products[productId];
        if (!p.exists) revert UnknownProduct();
        return uint256(p.priceUSDC) * periods;
    }

    /// @notice Chain-time expiry a rental started now would receive.
    function quoteExpiry(bytes32 productId, uint32 periods) public view returns (uint64) {
        Product memory p = _products[productId];
        if (!p.exists) revert UnknownProduct();
        return uint64(block.timestamp + uint256(p.rentalPeriodSeconds) * periods);
    }

    /**
     * @notice Rent a product for `periods` rental periods.
     * @param expectedVersion Product version the Agent quoted; a mismatch reverts.
     * @param maxTotalUSDC Maximum gross USDC the Agent authorises.
     */
    function rent(
        bytes32 productId,
        uint32 periods,
        uint64 expectedVersion,
        uint256 maxTotalUSDC,
        bytes32 permissionHash,
        string calldata licenseURI
    ) external nonReentrant whenCommerceAllowed returns (uint256 licenseId) {
        if (periods == 0 || periods > MAX_UNITS_PER_PURCHASE) revert InvalidUnits();

        Product storage p = _requirePurchasable(productId, expectedVersion);

        uint256 gross = uint256(p.priceUSDC) * periods;
        if (gross > maxTotalUSDC) revert PriceAboveMaximum(gross, maxTotalUSDC);

        // One rental consumes one concurrent slot regardless of duration, as in V0.
        _consumeInventory(p, 1);

        uint64 expiresAt = uint64(block.timestamp + uint256(p.rentalPeriodSeconds) * periods);

        Settlement memory s = _settle(msg.sender, gross);

        licenseId = _mintLicense(
            msg.sender, productId, p.version, expiresAt, periods, LicenseKind.TimedRental, permissionHash, licenseURI
        );

        uint256 reward = _payReward(msg.sender, periods);

        emit CommerceSettled(
            productId,
            msg.sender,
            licenseId,
            periods,
            s.gross,
            s.protocolFee,
            s.net,
            s.holderReserve,
            s.ownerAvailable,
            reward,
            expiresAt
        );
    }
}
