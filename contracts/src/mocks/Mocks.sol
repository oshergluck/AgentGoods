// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Mocks
 * @notice Test-only contracts. Never deployed to a production network; the deployment
 *         scripts refuse to touch anything in src/mocks on a non-local chain.
 */

/// @notice Canonical-shaped USDC with 6 decimals.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A lookalike ERC-20 that an attacker might try to pass off as canonical AIC.
contract FakeAIC is ERC20 {
    constructor(uint256 supply) ERC20("Store AIC", "AIC") {
        _mint(msg.sender, supply);
    }

    function burnFromMarket(uint256) external pure {
        return;
    }
}

/// @notice Minimal UniswapV2-style pair used by the mock router.
contract MockUniswapV2Pair is ERC20 {
    address public token0;
    address public token1;
    uint112 public reserve0;
    uint112 public reserve1;

    constructor(address a, address b) ERC20("Mock LP", "MLP") {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function sync(uint112 r0, uint112 r1) external {
        reserve0 = r0;
        reserve1 = r1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }
}

contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public pairs;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair);

    function getPair(address a, address b) external view returns (address) {
        return pairs[a][b];
    }

    function createPair(address a, address b) external returns (address pair) {
        require(pairs[a][b] == address(0), "pair exists");
        pair = address(new MockUniswapV2Pair(a, b));
        pairs[a][b] = pair;
        pairs[b][a] = pair;
        allPairs.push(pair);
        emit PairCreated(a, b, pair);
    }
}

contract MockUniswapV2Router02 {
    address public immutable factoryAddress;
    /// @notice When nonzero, the router consumes only this share (bps) of the desired amounts,
    ///         which lets tests exercise the transition slippage guard.
    uint256 public consumeBps = 10_000;

    constructor(address factory_) {
        factoryAddress = factory_;
    }

    function factory() external view returns (address) {
        return factoryAddress;
    }

    function setConsumeBps(uint256 bps) external {
        consumeBps = bps;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(block.timestamp <= deadline, "EXPIRED");
        amountA = (amountADesired * consumeBps) / 10_000;
        amountB = (amountBDesired * consumeBps) / 10_000;
        require(amountA >= amountAMin, "INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "INSUFFICIENT_B_AMOUNT");

        address pair = MockUniswapV2Factory(factoryAddress).getPair(tokenA, tokenB);
        if (pair == address(0)) {
            pair = MockUniswapV2Factory(factoryAddress).createPair(tokenA, tokenB);
        }

        IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).transferFrom(msg.sender, pair, amountB);

        liquidity = amountA + amountB;
        MockUniswapV2Pair(pair).mintTo(to, liquidity);
    }
}

/// @notice A plain contract used to prove contract-held AIC is excluded from EOA rights.
contract ContractHolder {
    function transferToken(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function callTarget(address target, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
    }
}

/**
 * @notice Deploys itself to an address that already holds AIC, to exercise the
 *         "an address became a contract after it was ranked" edge case of 0.19.B.
 */
contract SelfDeployingHolder {
    address public immutable token;

    constructor(address token_) {
        token = token_;
    }
}

/// @notice Reentrancy probe: re-enters a target while receiving a token callback.
contract ReentrancyProbe {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
        reentered = false;
        reentrySucceeded = false;
    }

    function trigger() external {
        if (!armed) return;
        armed = false;
        reentered = true;
        (bool ok,) = target.call(payload);
        reentrySucceeded = ok;
    }
}

/// @notice ERC-20 whose transfer triggers a reentrancy probe, to test CEI ordering.
contract HostileToken is ERC20 {
    ReentrancyProbe public probe;

    constructor(address probe_) ERC20("Hostile", "HOST") {
        probe = ReentrancyProbe(probe_);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(probe) != address(0)) {
            probe.trigger();
        }
    }
}

/// @notice Fee-on-transfer token used to prove nonstandard ERC-20s are rejected.
contract FeeOnTransferToken is ERC20 {
    uint256 public feeBps = 100;

    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0xdEaD), fee);
        super._update(from, to, value - fee);
    }
}

/// @notice An authorized-but-hostile factory used to prove component reuse is impossible.
contract ReusingFactory {
    address public immutable registryAddress;

    constructor(address registry_) {
        registryAddress = registry_;
    }

    function tryReuse(bytes32 storeId, address existingComponent, address creator) external {
        (bool ok, bytes memory ret) = registryAddress.call(
            abi.encodeWithSignature(
                "registerStore((bytes32,address,address,address,address,address,address,address,uint64,uint64,uint8,bool))",
                storeId,
                address(this),
                existingComponent,
                address(this),
                address(this),
                address(this),
                address(this),
                creator,
                uint64(2),
                uint64(0),
                uint8(0),
                true
            )
        );
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
