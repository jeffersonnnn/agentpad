// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2LaunchFactory.sol";
import {IPonsV2BondingCurve} from "../src/interfaces/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "../src/interfaces/IPonsV2FeeEscrow.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice PHASE 0, checks 1 and 2. Against the LIVE PONS V2 factory on Robinhood Chain 4663.
///         Check 1: launch a token whose creator fee recipient is an arbitrary "agent" wallet,
///                  and prove the fees route to THAT wallet, not to the launcher.
///         Check 2: real trades accrue fees, a sweep credits the escrow, and a claim lands ETH
///                  in the agent wallet. This is the self-funding loop, proven on-chain.
///
///         Run: forge test --match-contract Phase0 --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract Phase0ForkTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    IPonsV2LaunchFactory pons = IPonsV2LaunchFactory(FACTORY);
    IPonsV2FeeEscrow escrow;

    // The agent's treasury wallet. In production this is the agent's ERC-4337 smart account.
    address constant AGENT = address(0xA6E17); // "agent"
    address constant TRADER = address(0x7EADE5); // a trader generating volume

    function setUp() public {
        try vm.activeFork() returns (uint256) {}
        catch {
            vm.skip(true);
            return;
        }
        escrow = IPonsV2FeeEscrow(pons.feeEscrow());
    }

    function _params() internal pure returns (IPonsV2LaunchFactory.TokenParams memory) {
        return IPonsV2LaunchFactory.TokenParams({
            name: "AgentCoin",
            symbol: "AGENT",
            logo: "",
            description: "phase 0 self-funding proof",
            socials: IPonsV2LaunchFactory.Socials({
                twitter: "",
                telegram: "",
                discord: "",
                website: "",
                farcaster: ""
            }),
            creatorFeeRecipient: AGENT, // <-- the whole point: fees go to the agent wallet
            creatorTaxBps: 0,
            buybackEnabled: false, // off, so the creator itself may sweep (no buyback swap needed)
            expectedEconomics: bytes32(0),
            salt: keccak256("agentpad-phase0-native")
        });
    }

    function test_launch_recipient_sticks_and_fees_self_fund_the_agent() public {
        uint256 fee = pons.launchFee();
        assertEq(fee, 0.0005 ether, "launch fee");

        // --- CHECK 1: launch a native-ETH token with the agent wallet as the fee recipient ---
        vm.deal(address(this), fee);
        (address token, address curveAddr) = pons.launchToken{value: fee}(_params(), 0, address(0));
        assertTrue(token != address(0) && curveAddr != address(0), "launch returned token + curve");
        assertTrue(AGENT != address(this), "agent wallet is not the launcher");
        console2.log("launched token:", token);
        console2.log("curve:", curveAddr);
        console2.log("symbol:", IERC20(token).symbol());

        IPonsV2BondingCurve curve = IPonsV2BondingCurve(curveAddr);

        // Clear the 2-block launch guard / snipe-tax window before trading.
        vm.roll(block.number + 10);
        vm.warp(block.timestamp + 120);

        // --- CHECK 2a: real trades accrue fees on the curve ---
        vm.deal(TRADER, 5 ether);
        uint256 totalBought;
        for (uint256 i = 0; i < 8; i++) {
            vm.prank(TRADER);
            uint256 out = curve.buy{value: 0.05 ether}(0.05 ether, 0, TRADER);
            totalBought += out;
            vm.roll(block.number + 1);
            require(!curve.readyToGraduate(), "should not graduate in this small test");
        }
        assertGt(totalBought, 0, "trader received tokens");

        uint256 pendingFee = curve.quoteFeeBalance();
        console2.log("accrued curve fee (wei):", pendingFee);
        assertGt(pendingFee, 0, "fees accrued from real trades");

        // --- CHECK 2b: nothing is claimable until a sweep; then it credits the AGENT, not the launcher ---
        assertEq(escrow.balanceOf(AGENT), 0, "no escrow credit before sweep");

        vm.prank(AGENT); // the creator (fee recipient) sweeps; buyback is off so this is allowed
        curve.sweepFees(0);

        uint256 agentCredit = escrow.balanceOf(AGENT);
        uint256 launcherCredit = escrow.balanceOf(address(this));
        console2.log("escrow credit to AGENT (wei):", agentCredit);
        console2.log("escrow credit to launcher (wei):", launcherCredit);
        assertGt(agentCredit, 0, "creator fees credited to the AGENT wallet");
        assertEq(launcherCredit, 0, "launcher got nothing: the recipient stuck to the agent");

        // --- CHECK 2c: the agent claims, and the ETH lands in the agent wallet ---
        uint256 agentBalBefore = AGENT.balance;
        vm.prank(AGENT);
        uint256 claimed = escrow.claim();
        console2.log("claimed to agent (wei):", claimed);
        assertGt(claimed, 0, "claimed a nonzero amount");
        assertEq(AGENT.balance, agentBalBefore + claimed, "ETH landed in the agent wallet");
        assertEq(escrow.balanceOf(AGENT), 0, "escrow balance drained after claim");
    }
}
