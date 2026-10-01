// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

// Pulls the canonical ERC-1967 proxy into the build so deployment scripts and the
// verification pipeline use the exact audited OpenZeppelin implementation.
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
