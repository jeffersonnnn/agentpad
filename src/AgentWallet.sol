// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice A minimal stand-in for an agent's smart-account treasury. It holds tokens and executes
///         owner-authorized calls, the same shape an ERC-4337 account exposes via `execute`. Phase 0
///         uses it to prove a contract treasury can hold and swap a tokenized stock. The real product
///         replaces this with a 4337 account (session keys + spend caps), checked separately.
contract AgentWallet {
    address public owner;

    error NotOwner();
    error CallFailed();

    constructor(address owner_) {
        owner = owner_;
    }

    function execute(address to, uint256 value, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
        return ret;
    }

    receive() external payable {}
}
