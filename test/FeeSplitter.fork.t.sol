// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPonsV2LaunchFactory.sol";
import {IPonsV2BondingCurve} from "../src/interfaces/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "../src/interfaces/IPonsV2FeeEscrow.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @dev USDG's transferFrom, used by the mock platform curve to pull the splitter's buy amount.
///      (The repo IERC20 omits transferFrom.)
interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice A minimal mock of the PLATFORM token (SPEC: "use a MOCK platform token in the fork test").
///         The real platform token is a PONS token whose address comes from PLATFORM_TOKEN (.env),
///         launched LAST; the splitter is built against that address (SPEC 0).
contract MockPlatformToken {
    string public constant name = "MockPlatform";
    string public constant symbol = "MPLAT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}

/// @notice A minimal mock of the PLATFORM token's bonding curve, matching PonsV2BondingCurve.buy for a
///         USDG-quoted token: pull `quoteIn` USDG from the caller, then mint the bought tokens to the
///         recipient. The splitter buys to the dead address, so the mint-to-dead == the burn.
contract MockPlatformCurve {
    IERC20TransferFrom public immutable usdg;
    MockPlatformToken public immutable token;

    constructor(address _usdg, address _token) {
        usdg = IERC20TransferFrom(_usdg);
        token = MockPlatformToken(_token);
    }

    /// 1:1 USDG->token so the assertions are exact (dead balance == USDG spent).
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 out)
    {
        require(usdg.transferFrom(msg.sender, address(this), quoteIn), "usdg pull failed");
        out = quoteIn;
        require(out >= minTokensOut, "slippage");
        token.mint(recipient, out);
    }
}

/// @notice MILESTONE 1. The per-agent fee splitter, against the LIVE PONS V2 factory and the LIVE
///         Uniswap v3 WETH/USDG pool on Robinhood Chain 4663. It launches an agent token with
///         `creatorFeeRecipient = the splitter`, generates real buys, runs `claimAndRoute`, and
///         asserts the 80/20 routing (80% USDG to the agent treasury) and the 20% platform
///         buy-and-burn to the dead address. A second test proves the "hold the 20% until the
///         platform token is set, then flip to buy-and-burn" path (SPEC 0/1).
///
///         Run: forge test --match-contract FeeSplitter --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract FeeSplitterForkTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dec, base currency
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address constant AGENT_TREASURY = address(0xA6E17); // the agent's 4337 treasury, in production
    address constant TRADER = address(0x7EADE5); // generates volume
    address constant KEEPER = address(0xCEE9E5); // the allowlisted keeper that pokes claimAndRoute
    address constant STRANGER = address(0x57A9E5); // an unauthorized caller

    uint16 constant AGENT_BPS = 8000; // 80/20

    IPonsV2LaunchFactory pons = IPonsV2LaunchFactory(FACTORY);
    IPonsV2FeeEscrow escrow;

    function setUp() public {
        try vm.activeFork() returns (uint256) {}
        catch {
            vm.skip(true);
            return;
        }
        escrow = IPonsV2FeeEscrow(pons.feeEscrow());
    }

    // --- helpers ---------------------------------------------------------

    function _params(address recipient, bytes32 salt)
        internal
        pure
        returns (IPonsV2LaunchFactory.TokenParams memory)
    {
        return IPonsV2LaunchFactory.TokenParams({
            name: "AgentCoin",
            symbol: "AGENT",
            logo: "",
            description: "fee splitter fork test",
            socials: IPonsV2LaunchFactory.Socials({
                twitter: "",
                telegram: "",
                discord: "",
                website: "",
                farcaster: ""
            }),
            creatorFeeRecipient: recipient, // <-- OUR per-agent splitter (ADR 0003)
            creatorTaxBps: 0,
            buybackEnabled: false, // off, so the splitter (the fee recipient) may sweep itself
            expectedEconomics: bytes32(0),
            salt: salt
        });
    }

    /// Launch an agent token with `splitter` as the creator fee recipient, wire the curve into the
    /// splitter, then generate real buy volume so the creator fee accrues.
    function _launchAndGenerateFees(FeeSplitter splitter, bytes32 salt)
        internal
        returns (IPonsV2BondingCurve curve)
    {
        uint256 fee = pons.launchFee();
        vm.deal(address(this), fee);
        (address token, address curveAddr) = pons.launchToken{value: fee}(_params(address(splitter), salt), 0, address(0));
        assertTrue(token != address(0) && curveAddr != address(0), "launch returned token + curve");

        // The splitter did not exist as a curve at launch (circular: it must be the recipient first),
        // so wire the curve into it now. Mirrors the real orchestration (SPEC 8).
        splitter.setAgentCurve(curveAddr);
        curve = IPonsV2BondingCurve(curveAddr);

        // Clear the 2-block launch guard / snipe-tax window.
        vm.roll(block.number + 10);
        vm.warp(block.timestamp + 120);

        // Real trades accrue the creator fee on the curve.
        vm.deal(TRADER, 5 ether);
        for (uint256 i = 0; i < 8; i++) {
            vm.prank(TRADER);
            curve.buy{value: 0.05 ether}(0.05 ether, 0, TRADER);
            vm.roll(block.number + 1);
            require(!curve.readyToGraduate(), "should not graduate in this small test");
        }
        assertGt(curve.quoteFeeBalance(), 0, "creator fee accrued from real trades");
    }

    // --- tests -----------------------------------------------------------

    /// Platform token IS set: 80% USDG lands in the agent treasury, 20% buys the platform token and
    /// burns it (minted to the dead address). The fee arrives in ETH and is converted to USDG.
    function test_claimAndRoute_splits_80_20_and_burns_to_dead() public {
        MockPlatformToken plat = new MockPlatformToken();
        MockPlatformCurve platCurve = new MockPlatformCurve(USDG, address(plat));

        FeeSplitter splitter = new FeeSplitter(
            AGENT_TREASURY,
            address(plat),
            USDG,
            address(escrow),
            address(0), // agent curve unknown until after launch
            address(platCurve),
            AGENT_BPS
        );

        // Authorize a keeper (the test contract is the owner; a keeper mirrors the production caller).
        splitter.setKeeper(KEEPER, true);

        _launchAndGenerateFees(splitter, keccak256("splitter-full-route"));

        // Pre-conditions: nothing routed yet.
        assertEq(IERC20(USDG).balanceOf(AGENT_TREASURY), 0, "treasury empty before");
        assertEq(plat.balanceOf(DEAD), 0, "no burn before");

        // A stranger cannot poke the money path.
        vm.prank(STRANGER);
        vm.expectRevert(FeeSplitter.NotAuthorized.selector);
        splitter.claimAndRoute();

        // ROUTE via the keeper, parameterized overload. minUsdgOut = 0 here is still safe: the ETH->USDG
        // swap enforces the on-chain QuoterV2 floor. A production keeper passes a tighter off-chain min.
        vm.prank(KEEPER);
        (uint256 agentAmount, uint256 platformAmount) = splitter.claimAndRoute(0, 0);
        uint256 round = agentAmount + platformAmount;
        console2.log("round USDG (6dec):", round);
        console2.log("agent 80% (6dec):", agentAmount);
        console2.log("platform 20% (6dec):", platformAmount);

        // The fee was real and non-trivial.
        assertGt(round, 0, "some USDG routed");
        assertGt(platformAmount, 0, "platform slice non-zero");

        // 80/20 split, exact.
        assertEq(agentAmount, (round * AGENT_BPS) / 10_000, "agent share is 80% of the round");
        assertEq(platformAmount, round - agentAmount, "platform share is the remainder (20%)");

        // 80% USDG physically in the agent treasury.
        assertEq(IERC20(USDG).balanceOf(AGENT_TREASURY), agentAmount, "treasury holds the 80% in USDG");

        // 20% spent buying the platform token, which was minted to the DEAD address == burned.
        assertEq(IERC20(USDG).balanceOf(address(platCurve)), platformAmount, "platform curve took the 20% USDG");
        assertEq(plat.balanceOf(DEAD), platformAmount, "platform tokens minted to dead == burned");
        assertGt(plat.balanceOf(DEAD), 0, "burn happened");

        // Splitter fully drained: no leftover USDG, no leftover ETH, nothing held.
        assertEq(IERC20(USDG).balanceOf(address(splitter)), 0, "no USDG dust left in splitter");
        assertEq(address(splitter).balance, 0, "all ETH converted");
        assertEq(splitter.heldPlatformUsdg(), 0, "nothing held when platform token is set");
    }

    /// Platform token is UNSET at launch: the splitter routes 80% to the treasury and HOLDS the 20%
    /// as USDG. After `setPlatformToken`, the next `claimAndRoute` buys and burns the held amount.
    function test_holds_20pct_until_platform_set_then_burns() public {
        // Splitter deployed with NO platform token / curve (PLATFORM_TOKEN unset, SPEC 0).
        FeeSplitter splitter = new FeeSplitter(
            AGENT_TREASURY,
            address(0),
            USDG,
            address(escrow),
            address(0),
            address(0),
            AGENT_BPS
        );

        _launchAndGenerateFees(splitter, keccak256("splitter-hold-then-flip"));

        // ROUTE #1: platform unset -> hold the 20%.
        (uint256 agentAmount, uint256 platformAmount) = splitter.claimAndRoute();
        uint256 round = agentAmount + platformAmount;
        assertGt(round, 0, "some USDG routed");
        assertGt(platformAmount, 0, "platform slice non-zero");

        assertEq(agentAmount, (round * AGENT_BPS) / 10_000, "agent share is 80%");
        assertEq(IERC20(USDG).balanceOf(AGENT_TREASURY), agentAmount, "treasury still gets its 80%");

        // The 20% is HELD as USDG inside the splitter, not burned.
        assertEq(splitter.heldPlatformUsdg(), platformAmount, "20% held for later burn");
        assertEq(IERC20(USDG).balanceOf(address(splitter)), platformAmount, "held USDG sits in the splitter");

        // Now the platform token goes live (SPEC 0: launched LAST, PLATFORM_TOKEN then set).
        MockPlatformToken plat = new MockPlatformToken();
        MockPlatformCurve platCurve = new MockPlatformCurve(USDG, address(plat));
        assertEq(plat.balanceOf(DEAD), 0, "no burn yet");

        splitter.setPlatformToken(address(plat), address(platCurve));

        uint256 held = splitter.heldPlatformUsdg();
        assertGt(held, 0, "there is held USDG to flush");

        // ROUTE #2: no new fees; the flip buys and burns the previously-held 20%.
        splitter.claimAndRoute();

        assertEq(splitter.heldPlatformUsdg(), 0, "held flushed");
        assertEq(IERC20(USDG).balanceOf(address(splitter)), 0, "splitter USDG fully spent");
        assertEq(IERC20(USDG).balanceOf(address(platCurve)), held, "held USDG spent on the platform buy");
        assertEq(plat.balanceOf(DEAD), held, "held amount bought and burned to dead");
        assertGt(plat.balanceOf(DEAD), 0, "burn happened after the flip");
    }
}
