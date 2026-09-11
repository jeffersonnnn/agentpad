// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice PHASE 0, check 4. Proves an agent's contract treasury can HOLD and SWAP a tokenized
///         stock on the LIVE Uniswap v3 pool on Robinhood Chain 4663. This is the "trade" verb and
///         the differentiator: an agent funded in ETH/USDG converts its treasury into real equity
///         exposure (NVDA) and holds it, then can convert back.
///
///         Run: forge test --match-contract Phase0Stock --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract Phase0StockForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dec
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // 18 dec
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2; // SwapRouter02
    uint24 constant FEE = 500; // the live NVDA/USDG 5bps pool

    AgentWallet wallet;

    function setUp() public {
        try vm.activeFork() returns (uint256) {}
        catch {
            vm.skip(true);
            return;
        }
        wallet = new AgentWallet(address(this));
        // Fund the treasury with real USDG (ERC-20 balances mapping at storage slot 1).
        uint256 usdgAmt = 5_000e6;
        vm.store(USDG, keccak256(abi.encode(address(wallet), uint256(1))), bytes32(usdgAmt));
        assertEq(IERC20(USDG).balanceOf(address(wallet)), usdgAmt, "USDG funded into the treasury");
    }

    function _walletSwap(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        // approve the router, then swap, both executed BY the treasury (like a smart-account call).
        wallet.execute(tokenIn, 0, abi.encodeCall(IERC20.approve, (ROUTER, amountIn)));
        ISwapRouter02.ExactInputSingleParams memory p = ISwapRouter02.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: FEE,
            recipient: address(wallet),
            amountIn: amountIn,
            amountOutMinimum: 1,
            sqrtPriceLimitX96: 0
        });
        bytes memory ret = wallet.execute(ROUTER, 0, abi.encodeCall(ISwapRouter02.exactInputSingle, (p)));
        out = abi.decode(ret, (uint256));
    }

    function test_agent_treasury_holds_and_swaps_a_tokenized_stock() public {
        uint256 usdgIn = 2_260e6; // ~10 NVDA at ~226 USDG/share

        // BUY: USDG -> NVDA, executed by the treasury contract.
        uint256 nvdaOut = _walletSwap(USDG, NVDA, usdgIn);
        console2.log("NVDA received (1e18):", nvdaOut);
        assertGt(nvdaOut, 0, "treasury received NVDA");
        assertEq(IERC20(NVDA).balanceOf(address(wallet)), nvdaOut, "treasury physically holds the NVDA");
        assertGt(nvdaOut, 8e18, "plausible NVDA out (lower band)");
        assertLt(nvdaOut, 12e18, "plausible NVDA out (upper band)");

        // SELL: NVDA -> USDG, round-tripping back to the stable leg.
        uint256 usdgBack = _walletSwap(NVDA, USDG, nvdaOut);
        console2.log("USDG back (1e6):", usdgBack);
        assertGt(usdgBack, 0, "treasury received USDG back");
        assertEq(IERC20(NVDA).balanceOf(address(wallet)), 0, "NVDA fully sold");
        // Two 5bps swaps plus slippage should recover most of the 2260 USDG.
        assertGt(usdgBack, usdgIn * 97 / 100, "round trip within ~3%");
    }
}
