// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title AICTimelock
 * @notice Production upgrade authority for the two upgradeable contracts (Registry, AgentGoods).
 *
 * @dev MASTER_PLAN 0.17. The timelock is deployed, configured and smoke-tested BEFORE public
 *      production, but enforcement is activated only after the proving gates pass:
 *
 *        bootstrap phase  : Bootstrap Admin holds UPGRADER_ROLE, timelock enforcement OFF
 *        after handoff    : this timelock holds UPGRADER_ROLE, Bootstrap Admin revoked
 *
 *      "Enforcement off" never means "no access control": during bootstrap only the explicitly
 *      authorized Bootstrap Admin can upgrade, and every upgrade emits an event that the
 *      indexer records. Guardian keeps only the enumerated emergency pause powers; it can
 *      never mint, seize a store, forge a claim or make an external contract canonical.
 */
contract AICTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
