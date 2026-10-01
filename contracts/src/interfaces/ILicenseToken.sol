// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

/// @notice Seller-declared basis for a token-saving claim. [MASTER_PLAN 14A.1]
enum DeclarationBasis {
    Undeclared,
    Estimated,
    Measured
}

/**
 * @notice Seller-declared inference cost this product is meant to replace.
 * @dev UNVERIFIED SELLER CLAIM. The protocol cannot check how many model tokens a workload
 *      would have cost, so nothing in the protocol ever reads these fields for an economic
 *      decision. They exist so an Agent can compare buying against producing. [14A.1]
 */
struct TokenSavingDeclaration {
    uint64 tokensSaved;
    bytes32 modelTier;
    DeclarationBasis basis;
    uint64 declaredAt;
}

/// @notice What a license entitles its holder to.
enum LicenseKind {
    PermanentPurchase,
    TimedRental
}

struct LicenseData {
    bytes32 productId;
    uint64 productVersion;
    uint64 issuedAt;
    uint64 expiresAt; // 0 == never expires
    uint32 quantity;
    LicenseKind kind;
    bytes32 permissionHash;
}

interface ILicenseToken {
    function store() external view returns (address);
    function storeId() external view returns (bytes32);
    function licenseData(uint256 tokenId) external view returns (LicenseData memory);
    function isValid(uint256 tokenId) external view returns (bool);
    function ownerOf(uint256 tokenId) external view returns (address);
    function totalIssued() external view returns (uint256);

    function mint(
        address to,
        bytes32 productId,
        uint64 productVersion,
        uint64 expiresAt,
        uint32 quantity,
        LicenseKind kind,
        bytes32 permissionHash,
        string calldata uri
    ) external returns (uint256 tokenId);
}
