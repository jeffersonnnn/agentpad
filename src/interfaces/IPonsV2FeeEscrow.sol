// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Claim-based fee ledger for PONS V2 creators and the protocol, from
///         ponsdotdev/ponsfamily contractsV2/src/v2/interfaces/ILaunchpadV2.sol.
///         A sweep on the curve or the hook credits a recipient here; the recipient claims
///         their own balance (claim/claimToken take no recipient, they use msg.sender).
interface IPonsV2FeeEscrow {
    function claim() external returns (uint256 amount);
    function claim(uint256 amount) external returns (uint256);
    function claimToken(address token) external returns (uint256 amount);
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}
