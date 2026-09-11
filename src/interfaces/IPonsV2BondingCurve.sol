// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal interface for the PONS V2 bonding curve (curve-phase trading contract),
///         from ponsdotdev/ponsfamily contractsV2/src/v2/PonsV2BondingCurve.sol.
///         Fees ACCRUE on the curve, a SWEEP credits the shared fee escrow, and the creator
///         then CLAIMS from the escrow. Nothing is pushed to the creator per trade.
interface IPonsV2BondingCurve {
    /// @notice Buy the launched token with the quote asset. For a native ETH launch, msg.value
    ///         must equal quoteIn. Returns the tokens sent to `recipient`.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);

    /// @notice Sell the launched token back to the curve. Caller must approve the curve first.
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        returns (uint256 quoteOut);

    /// @notice Distributes accrued fees: protocol + creator to the escrow, buyback if enabled.
    ///         Callable by the fee-sweep operator, or by the creator when no buyback swap is needed.
    function sweepFees(uint256 minBuybackTokensOut) external;

    /// @notice Pending base fee accrued on the quote leg, before a sweep.
    function quoteFeeBalance() external view returns (uint256);

    /// @notice Pending creator tax accrued, before a sweep.
    function creatorTaxBalance() external view returns (uint256);

    /// @notice Earmarked buyback slice accrued, before a sweep.
    function buybackQuoteBalance() external view returns (uint256);

    /// @notice True once the real quote reserve reaches the graduation threshold.
    function readyToGraduate() external view returns (bool);
}
