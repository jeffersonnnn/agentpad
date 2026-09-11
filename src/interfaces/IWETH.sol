// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal WETH9 interface. The fee splitter wraps its claimed native ETH into WETH before
///         swapping ETH -> USDG on Uniswap v3, so it never relies on the router's implicit native
///         wrapping. WETH9 on RH Chain 4663: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73.
interface IWETH {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}
