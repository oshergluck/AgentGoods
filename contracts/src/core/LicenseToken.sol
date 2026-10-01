// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ILicenseToken, LicenseData, LicenseKind} from "../interfaces/ILicenseToken.sol";
import {IStore} from "../interfaces/IStore.sol";
import {IAICRegistry} from "../interfaces/IAICRegistry.sol";

/// @notice Current verdict recorded against one license. [MASTER_PLAN 14A.2]
struct BuyerSignal {
    bool exists;
    bool worthIt;
    bool changed;
    bool selfSignal;
    uint64 signalledAt;
    uint64 changedAt;
    address signaller;
}

/**
 * @title LicenseToken
 * @notice Canonical per-store programmable proof of purchase / rental / access rights,
 *         plus the on-chain delivery record and post-purchase buyer signal of Phase 10.1.
 *
 * @dev Non-transferable by default. MASTER_PLAN 0.13 "Digital LicenseToken transferability":
 *      a permanent downloadable digital asset cannot have its previous access revoked once
 *      plaintext has been delivered, so pretending the license is tradeable would be a DRM
 *      claim the architecture cannot honour. Rentals are likewise non-transferable because
 *      the access gateway authorises on current ownership and cannot retroactively revoke a
 *      cached download. A transferable class may be added in a future version only together
 *      with a documented access-revocation/key-rotation mechanism.
 *
 *      Licenses are never burned for a commerce reason: V1 has no refund path. [0.13]
 *
 *      Phase 10.1 additions, all deliberately inert economically:
 *        - `recordAccessGrant` is the on-chain delivery record, written by the store
 *          `accessAttestor`. It makes "access was granted at least once" chain state rather
 *          than a backend assertion, and it gives the indexer the `delivered` denominator.
 *        - `submitSignal` records a binary buyer verdict bound to the LICENSE, gated on
 *          current ownership and on a recorded delivery, writable once and changeable at
 *          most once inside SIGNAL_WINDOW.
 *        - NOTHING in this contract, or in any other protocol contract, reads signal state
 *          to compute a payout, a fee, a reward, an entitlement or an ordering. The moment a
 *          signal pays, manufacturing signals becomes the optimisation. [14A.2]
 */
contract LicenseToken is ERC721, ILicenseToken {
    /// @notice A signal may be changed only within this window of chain time. [14A.2]
    uint64 public constant SIGNAL_WINDOW = 7 days;
    /// @notice Bound on a batched delivery attestation.
    uint256 public constant MAX_ACCESS_GRANT_BATCH = 200;

    string private _tokenName;
    string private _tokenSymbol;
    address private _store;
    bytes32 private _storeId;
    bool private _initialized;

    uint256 private _nextTokenId;
    uint256 private _totalIssued;

    mapping(uint256 => LicenseData) private _licenses;
    mapping(uint256 => string) private _tokenURIs;

    /// @dev licenseId => number of access grants recorded by the store attestor.
    mapping(uint256 => uint32) private _accessGrantCount;
    /// @dev licenseId => chain timestamp of the first recorded access grant (0 = never).
    mapping(uint256 => uint64) private _firstAccessAt;
    mapping(uint256 => BuyerSignal) private _signals;

    /// @notice Lifetime counters, a cheap cross-check against the indexed projection.
    uint256 public deliveredCount;
    uint256 public signalledCount;

    event LicenseIssued(
        uint256 indexed tokenId,
        address indexed to,
        bytes32 indexed productId,
        uint64 productVersion,
        uint64 expiresAt,
        uint32 quantity,
        LicenseKind kind,
        bytes32 permissionHash
    );
    event AccessGranted(uint256 indexed licenseId, address indexed holder, uint64 grantedAt, uint32 grantCount);
    event BuyerSignalSubmitted(
        uint256 indexed licenseId,
        address indexed signaller,
        bytes32 indexed productId,
        bool worthIt,
        bool selfSignal,
        uint64 signalledAt
    );
    event BuyerSignalChanged(
        uint256 indexed licenseId,
        address indexed signaller,
        bytes32 indexed productId,
        bool previousWorthIt,
        bool worthIt,
        uint64 changedAt
    );

    error NotStore();
    error NonTransferable();
    error UnknownLicense();
    error AlreadyInitialized();
    error NotAttestor();
    error NotLicenseHolder();
    error NoAccessGranted();
    error SignalWindowClosed();
    error SignalAlreadyChanged();
    error SignalUnchanged();
    error BatchTooLarge();

    /// @dev Deployed once as an implementation and cloned per store (EIP-1167). [0.25.P]
    constructor() ERC721("License Implementation", "LIC-IMPL") {
        _initialized = true;
    }

    function initialize(string calldata name_, string calldata symbol_, bytes32 storeId_, address store_) external {
        if (_initialized) revert AlreadyInitialized();
        require(store_ != address(0), "License: zero store");
        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        _storeId = storeId_;
        _store = store_;
        _nextTokenId = 1;
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    function store() external view returns (address) {
        return _store;
    }

    function storeId() external view returns (bytes32) {
        return _storeId;
    }

    function totalIssued() external view returns (uint256) {
        return _totalIssued;
    }

    function licenseData(uint256 tokenId) external view returns (LicenseData memory) {
        LicenseData memory data = _licenses[tokenId];
        if (data.issuedAt == 0) revert UnknownLicense();
        return data;
    }

    /// @notice A license is valid while it exists and, for rentals, has not expired on chain time.
    function isValid(uint256 tokenId) external view returns (bool) {
        LicenseData memory data = _licenses[tokenId];
        if (data.issuedAt == 0) return false;
        if (_ownerOf(tokenId) == address(0)) return false;
        if (data.expiresAt == 0) return true;
        return block.timestamp < data.expiresAt;
    }

    function ownerOf(uint256 tokenId) public view override(ERC721, ILicenseToken) returns (address) {
        return ERC721.ownerOf(tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }

    /**
     * @notice Mint a license. Only the canonical store of this token may call.
     * @param expiresAt Chain timestamp at which a rental ends; zero means never expires.
     */
    function mint(
        address to,
        bytes32 productId,
        uint64 productVersion,
        uint64 expiresAt,
        uint32 quantity,
        LicenseKind kind,
        bytes32 permissionHash,
        string calldata uri
    ) external returns (uint256 tokenId) {
        if (msg.sender != _store) revert NotStore();

        tokenId = _nextTokenId++;
        _totalIssued++;

        _licenses[tokenId] = LicenseData({
            productId: productId,
            productVersion: productVersion,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            quantity: quantity,
            kind: kind,
            permissionHash: permissionHash
        });
        if (bytes(uri).length != 0) {
            _tokenURIs[tokenId] = uri;
        }

        _safeMint(to, tokenId);

        emit LicenseIssued(tokenId, to, productId, productVersion, expiresAt, quantity, kind, permissionHash);
    }

    // ====================================================== delivery record ==

    function accessGrantCount(uint256 licenseId) external view returns (uint32) {
        return _accessGrantCount[licenseId];
    }

    function firstAccessAt(uint256 licenseId) external view returns (uint64) {
        return _firstAccessAt[licenseId];
    }

    function wasDelivered(uint256 licenseId) public view returns (bool) {
        return _accessGrantCount[licenseId] != 0;
    }

    /**
     * @notice Record that the access gateway authorised a delivery for this license.
     * @dev Callable by the protocol's delivery gateway (registry DELIVERY_GATEWAY_ROLE) — the
     *      party that served the bytes — or by the store's own `accessAttestor`. The gateway is
     *      what makes rating independent of the seller: a seller that never sets an attestor,
     *      or removes it, can no longer stop its buyers from being able to rate it. Either
     *      witness can only witness: it cannot signal, change a signal, mint or move value.
     *      Making this chain state is what lets `submitSignal` enforce "delivered at least
     *      once". [14A.2]
     */
    function recordAccessGrant(uint256 licenseId) public {
        address attestor = IStore(_store).accessAttestor();
        bool isStoreAttestor = attestor != address(0) && msg.sender == attestor;
        if (!isStoreAttestor && !IAICRegistry(IStore(_store).registry()).isDeliveryGateway(msg.sender)) {
            revert NotAttestor();
        }
        address holder = _ownerOf(licenseId);
        if (holder == address(0)) revert UnknownLicense();

        uint32 count = _accessGrantCount[licenseId] + 1;
        _accessGrantCount[licenseId] = count;
        if (count == 1) {
            _firstAccessAt[licenseId] = uint64(block.timestamp);
            deliveredCount += 1;
        }
        emit AccessGranted(licenseId, holder, uint64(block.timestamp), count);
    }

    function recordAccessGrants(uint256[] calldata licenseIds) external {
        uint256 len = licenseIds.length;
        if (len > MAX_ACCESS_GRANT_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < len; i++) {
            recordAccessGrant(licenseIds[i]);
        }
    }

    // ======================================================== buyer signal ==

    function signalOf(uint256 licenseId) external view returns (BuyerSignal memory) {
        return _signals[licenseId];
    }

    /// @notice Whether a signal for `licenseId` can still be changed right now.
    function canChangeSignal(uint256 licenseId) external view returns (bool) {
        BuyerSignal storage sig = _signals[licenseId];
        if (!sig.exists || sig.changed) return false;
        return block.timestamp <= uint256(sig.signalledAt) + SIGNAL_WINDOW;
    }

    /**
     * @notice Record, or change once, the binary buyer verdict for a license.
     *
     * @dev Rules, all enforced here because the LicenseToken is where the license lives:
     *        - only the CURRENT holder may signal, which also means a previous holder cannot
     *          signal after a transfer (V1 licenses are non-transferable, so the situation
     *          cannot arise today, but the check is ownership-based and stays correct if a
     *          transferable license class is ever introduced);
     *        - the license must have at least one recorded access grant;
     *        - the first call creates the signal, a second call inside SIGNAL_WINDOW changes
     *          it exactly once, and any later call reverts.
     *
     *      `selfSignal` is computed on chain at signal time by comparing the signaller with
     *      the current storeController and the historical storeCreator. Self signals stay
     *      visible in raw counts and are excluded from aggregate rates. [14A.2]
     */
    function submitSignal(uint256 licenseId, bool worthIt) external {
        address holder = _ownerOf(licenseId);
        if (holder == address(0)) revert UnknownLicense();
        if (holder != msg.sender) revert NotLicenseHolder();
        if (!wasDelivered(licenseId)) revert NoAccessGranted();

        bytes32 productId = _licenses[licenseId].productId;
        BuyerSignal storage sig = _signals[licenseId];

        if (!sig.exists) {
            bool self = msg.sender == IStore(_store).storeController()
                || msg.sender == IStore(_store).storeCreator();
            sig.exists = true;
            sig.worthIt = worthIt;
            sig.selfSignal = self;
            sig.signalledAt = uint64(block.timestamp);
            sig.signaller = msg.sender;
            signalledCount += 1;
            emit BuyerSignalSubmitted(licenseId, msg.sender, productId, worthIt, self, uint64(block.timestamp));
            return;
        }

        if (sig.changed) revert SignalAlreadyChanged();
        if (block.timestamp > uint256(sig.signalledAt) + SIGNAL_WINDOW) revert SignalWindowClosed();
        if (sig.worthIt == worthIt) revert SignalUnchanged();

        bool previous = sig.worthIt;
        sig.worthIt = worthIt;
        sig.changed = true;
        sig.changedAt = uint64(block.timestamp);
        emit BuyerSignalChanged(licenseId, msg.sender, productId, previous, worthIt, uint64(block.timestamp));
    }

    // ------------------------------------------------------- non-transferable

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        // Allow mint (from == 0). Forbid every transfer and burn.
        if (from != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert NonTransferable();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert NonTransferable();
    }
}
