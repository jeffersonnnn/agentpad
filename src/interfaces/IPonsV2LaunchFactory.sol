// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Interface for the live PONS V2 launch factory on Robinhood Chain 4663.
///         Address: 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e.
///         Field names, types, and order reproduce ponsdotdev/ponsfamily contractsV2/src/v2 exactly,
///         so ABI encoding of TokenParams matches the deployed factory byte-for-byte.
interface IPonsV2LaunchFactory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps; // <= 1000 (10%)
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchConfig {
        uint256 supply;
        uint256 curveFeeBps;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        bool enabled;
    }

    struct PairTokenEconomics {
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint8 decimals;
    }

    function launchFee() external view returns (uint256);
    function feeEscrow() external view returns (address);
    function launchConfigCount() external view returns (uint256);
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function pairTokenEconomics(address pairToken) external view returns (PairTokenEconomics memory);

    /// @notice The current on-chain creator fee recipient for a launched token.
    function transferCreatorFeeRecipient(address token, address newRecipient) external;

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);

    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);
}
