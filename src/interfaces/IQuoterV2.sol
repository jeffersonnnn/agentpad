// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Uniswap v3 QuoterV2 on Robinhood Chain (0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7).
///         `quoteExactInputSingle` is NON-view: it executes the swap against live pool state and
///         reverts internally to return the result, so it must be called (not staticcall-typed as
///         view). The FeeSplitter uses it to derive an on-chain minimum-out floor for the
///         ETH->USDG conversion, so the no-arg keeper path can never swap at amountOutMinimum = 0.
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}
