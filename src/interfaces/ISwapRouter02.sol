// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Uniswap v3 SwapRouter02 on Robinhood Chain. Note: exactInputSingle has NO deadline field
///         (confirmed in the $REBOUND work against the live router).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
