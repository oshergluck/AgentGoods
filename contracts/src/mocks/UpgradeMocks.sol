// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {AICRegistry} from "../core/AICRegistry.sol";
import {AgentGoods} from "../exchange/AgentGoods.sol";

/**
 * @notice Test-only next-generation implementations used to prove that a Registry/AgentGoods
 *         upgrade preserves storage layout, canonical provenance and market accounting.
 */
contract AICRegistryV2 is AICRegistry {
    /// @dev Appended AFTER the inherited gap; never reorders existing slots.
    uint256 public newFeatureFlag;

    function setNewFeatureFlag(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        newFeatureFlag = value;
    }

    function registryVersion() external pure override returns (string memory) {
        return "2.0.0";
    }
}

contract AgentGoodsV2 is AgentGoods {
    uint256 public newMarketFlag;

    function setNewMarketFlag(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        newMarketFlag = value;
    }

    function agentGoodsVersion() external pure override returns (string memory) {
        return "2.0.0";
    }
}

/// @notice An implementation with no upgrade authorization, used to prove UUPS guards work.
contract MaliciousRegistryImpl {
    function seizeStore(bytes32, address) external pure returns (bool) {
        return true;
    }

    function proxiableUUID() external pure returns (bytes32) {
        return 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    }
}
