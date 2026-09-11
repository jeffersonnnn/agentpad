// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPonsV2BondingCurve} from "./interfaces/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "./interfaces/IPonsV2FeeEscrow.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IQuoterV2} from "./interfaces/IQuoterV2.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IWETH} from "./interfaces/IWETH.sol";

/// @title FeeSplitter — per-agent creator-fee router (SPEC.md section 1, ADR 0003).
/// @notice One splitter is deployed PER agent and set as that agent token's `creatorFeeRecipient`
///         on PONS. The PONS escrow credits by (recipient, asset) and does not track which token
///         earned a fee, so a shared splitter could not attribute per-agent fees — hence one each.
///
///         `claimAndRoute()`:
///           1. sweep the agent curve's accrued creator fee into the PONS escrow,
///           2. claim the splitter's credited balance out of the escrow (native ETH for an
///              ETH-paired launch; USDG for a USDG-paired launch),
///           3. convert any claimed ETH to USDG on Uniswap v3 (base currency is USDG, SPEC 5),
///           4. send `agentBps` (80%) of the round's USDG to the agent treasury, and
///           5. use the remaining 20% to BUY the platform token and BURN it by buying to the dead
///              address via the platform curve.
///
///         Agent tokens launch with `buybackEnabled = false`, so the splitter — being the
///         `creatorFeeRecipient`, which PONS treats as the fee "creator" — may call
///         `agentCurve.sweepFees(0)` itself.
///
///         Until the platform token is set (its address comes from `PLATFORM_TOKEN` in .env, and
///         the platform token launches LAST — SPEC 0), the splitter HOLDS the 20% as USDG in
///         `heldPlatformUsdg` and flips to buy-and-burn once `setPlatformToken` is called.
///
/// @dev SECURITY / AUDIT NOTES:
///      - `claimAndRoute()` is OWNER/KEEPER-ONLY (not permissionless): only the platform owner or an
///        allowlisted keeper may trigger a round, so no one can force a sandwichable money path. The
///        no-arg overload still derives an ON-CHAIN minimum-out floor for the ETH->USDG swap from the
///        Uniswap QuoterV2 (never 0): the realized out must be at least `quote * (1 - maxDeviationBps)`.
///        A production keeper SHOULD call the parameterized overload with a tighter off-chain minimum;
///        the passed minimum is used when it is higher than the on-chain floor.
///      - Post-graduation platform buy path is OPEN (SPEC 10.3): once the platform token graduates
///        (4.2 ETH, LP locks into Uniswap v4), `platformCurve.buy` no longer works and the burn must
///        route through PonsV2MemeHook / a v4 swap. See the TODO in `_buyAndBurn`.
contract FeeSplitter {
    // --- Chain infra (RH Chain 4663), see FACTS.md ---
    address public constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    ISwapRouter02 public constant SWAP_ROUTER = ISwapRouter02(0xCaf681a66D020601342297493863E78C959E5cb2);
    /// @notice Uniswap v3 QuoterV2 on RH Chain 4663, used to derive the on-chain slippage floor for
    ///         the ETH->USDG swap. Verified to have code + a working WETH/USDG quote on-chain 2026-09-10.
    IQuoterV2 public constant QUOTER = IQuoterV2(0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7);
    /// @notice The WETH/USDG v3 fee tier used for the ETH->USDG conversion. The 0.01% (100) pool is
    ///         the deepest on chain (~$13.5M USDG). Verified on-chain 2026-09-10.
    uint24 public constant ETH_USDG_FEE = 100;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint16 public constant BPS_DENOM = 10_000;

    // --- Immutable config ---
    address public immutable agentTreasury; // receives 80% of each round, in USDG
    address public immutable platformQuote; // USDG: base currency + the platform token's quote asset
    IPonsV2FeeEscrow public immutable ponsEscrow;
    uint16 public immutable agentBps; // 8000

    // --- Mutable config (resolved after launch / at platform-token go-live) ---
    /// @notice The agent token's bonding curve. May be set at construction, or address(0) then set
    ///         once via `setAgentCurve` — because the curve address is only known AFTER `launchToken`,
    ///         yet the splitter must already exist to be the `creatorFeeRecipient` (SPEC 8 order).
    IPonsV2BondingCurve public agentCurve;
    /// @notice The platform token and its curve. address(0) until `PLATFORM_TOKEN` is set (SPEC 0).
    address public platformToken;
    IPonsV2BondingCurve public platformCurve;

    /// @notice USDG held back for the platform buy-and-burn while the platform token is unset.
    uint256 public heldPlatformUsdg;

    address public owner;

    /// @notice Keepers allowed to call `claimAndRoute` alongside the owner (SPEC 1: keeper-callable).
    mapping(address => bool) public isKeeper;

    /// @notice Maximum allowed downward deviation (in bps) of the realized ETH->USDG swap out versus
    ///         the QuoterV2 quote taken in the same call. Default 100 = 1%. Owner-settable.
    uint16 public maxDeviationBps = 100;

    /// @dev Reentrancy mutex state (1 = unlocked, 2 = locked). No OpenZeppelin dependency.
    uint256 private _locked = 1;

    // --- Events ---
    event Routed(uint256 roundUsdg, uint256 agentAmount, uint256 platformAmount, bool burned);
    event PlatformBurned(uint256 usdgSpent, uint256 platformTokensToDead);
    event PlatformHeld(uint256 usdgHeld, uint256 totalHeld);
    event PlatformTokenSet(address indexed token, address indexed curve);
    event AgentCurveSet(address indexed curve);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper, bool allowed);
    event MaxDeviationBpsSet(uint16 previousBps, uint16 newBps);
    event SweepSkipped(bytes reason);
    event Rescued(address indexed token, uint256 amount);
    event RescuedETH(uint256 amount);

    error NotOwner();
    error NotAuthorized();
    error AlreadySet();
    error ZeroAddress();
    error BadBps();
    error Reentrancy();
    error EthTransferFailed();
    error TransferFailed();
    error ApproveFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner && !isKeeper[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @param _agentTreasury  the agent's ERC-4337 treasury; receives 80% in USDG.
    /// @param _platformToken  the platform token address, or address(0) if not yet launched (holds).
    /// @param _platformQuote  USDG. The base/payout currency and the platform token's quote asset.
    /// @param _ponsEscrow     the PONS V2 fee escrow (0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e).
    /// @param _agentCurve     the agent token's curve, or address(0) if set later via setAgentCurve.
    /// @param _platformCurve  the platform token's curve, or address(0) if not yet launched (holds).
    /// @param _agentBps       the agent share in bps (8000 = 80%).
    constructor(
        address _agentTreasury,
        address _platformToken,
        address _platformQuote,
        address _ponsEscrow,
        address _agentCurve,
        address _platformCurve,
        uint16 _agentBps
    ) {
        if (_agentTreasury == address(0) || _platformQuote == address(0) || _ponsEscrow == address(0)) {
            revert ZeroAddress();
        }
        if (_agentBps == 0 || _agentBps > BPS_DENOM) revert BadBps();
        agentTreasury = _agentTreasury;
        platformToken = _platformToken;
        platformQuote = _platformQuote;
        ponsEscrow = IPonsV2FeeEscrow(_ponsEscrow);
        agentCurve = IPonsV2BondingCurve(_agentCurve);
        platformCurve = IPonsV2BondingCurve(_platformCurve);
        agentBps = _agentBps;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    // --- Admin (platform deployer key, SPEC 2/8) ---

    /// @notice Set the agent curve once, if it was not known at construction (deployed before launch).
    function setAgentCurve(address _agentCurve) external onlyOwner {
        if (_agentCurve == address(0)) revert ZeroAddress();
        if (address(agentCurve) != address(0)) revert AlreadySet();
        agentCurve = IPonsV2BondingCurve(_agentCurve);
        emit AgentCurveSet(_agentCurve);
    }

    /// @notice Set the platform token + curve once it exists (PLATFORM_TOKEN go-live, SPEC 0).
    ///         One-time only: reverts if the platform token was already set (at construction or here).
    ///         Any USDG already held for the platform is burned on the next `claimAndRoute`.
    function setPlatformToken(address _platformToken, address _platformCurve) external onlyOwner {
        if (_platformToken == address(0) || _platformCurve == address(0)) revert ZeroAddress();
        if (platformToken != address(0)) revert AlreadySet();
        // Reset any stale USDG allowance on the previous platform curve before repointing.
        if (address(platformCurve) != address(0)) {
            _safeApprove(IERC20(platformQuote), address(platformCurve), 0);
        }
        platformToken = _platformToken;
        platformCurve = IPonsV2BondingCurve(_platformCurve);
        emit PlatformTokenSet(_platformToken, _platformCurve);
    }

    /// @notice Add or remove a keeper allowed to call `claimAndRoute`.
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice Set the on-chain slippage floor band (bps) for the ETH->USDG swap. Max 10000.
    function setMaxDeviationBps(uint16 newBps) external onlyOwner {
        if (newBps > BPS_DENOM) revert BadBps();
        emit MaxDeviationBpsSet(maxDeviationBps, newBps);
        maxDeviationBps = newBps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    // --- Rescue (onlyOwner): recover stranded tokens / ETH ---

    /// @notice Rescue ERC-20 tokens accidentally stranded in the splitter.
    function rescue(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        _safeTransfer(IERC20(token), owner, amount);
        emit Rescued(token, amount);
    }

    /// @notice Rescue native ETH stranded in the splitter.
    function rescueETH(uint256 amount) external onlyOwner {
        (bool ok,) = owner.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit RescuedETH(amount);
    }

    // --- Core: claim + route ---

    /// @notice SPEC signature (owner/keeper-only). The ETH->USDG swap uses the on-chain QuoterV2 floor,
    ///         never 0; the platform buy uses minOut = 0, which is safe as the call is not permissionless.
    function claimAndRoute()
        external
        onlyOwnerOrKeeper
        nonReentrant
        returns (uint256 agentAmount, uint256 platformAmount)
    {
        return _claimAndRoute(0, 0);
    }

    /// @notice Slippage-safe overload (owner/keeper-only). A production keeper passes tighter minimums.
    ///         The ETH->USDG swap enforces `max(minUsdgOut, on-chain QuoterV2 floor)`.
    /// @param minUsdgOut       minimum USDG out of the ETH->USDG conversion.
    /// @param minPlatformOut   minimum platform tokens out of the buy-and-burn.
    function claimAndRoute(uint256 minUsdgOut, uint256 minPlatformOut)
        external
        onlyOwnerOrKeeper
        nonReentrant
        returns (uint256 agentAmount, uint256 platformAmount)
    {
        return _claimAndRoute(minUsdgOut, minPlatformOut);
    }

    function _claimAndRoute(uint256 minUsdgOut, uint256 minPlatformOut)
        internal
        returns (uint256 agentAmount, uint256 platformAmount)
    {
        IERC20 usdg = IERC20(platformQuote);

        // usdgBefore includes any heldPlatformUsdg already sitting here; the delta below isolates
        // only the NEW USDG earned this round, so held is never double-counted.
        uint256 usdgBefore = usdg.balanceOf(address(this));

        // 1. Sweep the agent curve's accrued creator fee into the escrow. Best-effort: reverts when
        //    there is nothing to sweep, which must not brick a routing that still has held/escrow funds.
        if (address(agentCurve) != address(0)) {
            try agentCurve.sweepFees(0) {}
            catch (bytes memory reason) {
                emit SweepSkipped(reason);
            }
        }

        // 2. Claim the splitter's credited balance out of the escrow.
        //    Native ETH (ETH-paired launch)...
        if (ponsEscrow.balanceOf(address(this)) > 0) {
            uint256 ethClaimed = ponsEscrow.claim();
            // 3. ...converted to USDG (base currency, SPEC 5).
            if (ethClaimed > 0) {
                _swapEthToUsdg(ethClaimed, minUsdgOut);
            }
        }
        //    ...or USDG directly (USDG-paired launch), no conversion needed.
        if (ponsEscrow.balanceOfToken(address(this), platformQuote) > 0) {
            ponsEscrow.claimToken(platformQuote);
        }

        // The USDG that arrived THIS round (conversion + direct claim).
        uint256 roundUsdg = usdg.balanceOf(address(this)) - usdgBefore;

        // 4. 80% to the agent treasury.
        agentAmount = (roundUsdg * agentBps) / BPS_DENOM;
        platformAmount = roundUsdg - agentAmount;
        if (agentAmount > 0) {
            _safeTransfer(usdg, agentTreasury, agentAmount);
        }

        // 5. 20% buys and burns the platform token — or is held until the platform token is set.
        bool burned;
        if (_platformConfigured()) {
            uint256 toBurn = platformAmount + heldPlatformUsdg;
            heldPlatformUsdg = 0;
            if (toBurn > 0) {
                _buyAndBurn(toBurn, minPlatformOut);
                burned = true;
            }
        } else if (platformAmount > 0) {
            // Hold the 20% as USDG in this contract; flip to buy-and-burn once the token is set.
            heldPlatformUsdg += platformAmount;
            emit PlatformHeld(platformAmount, heldPlatformUsdg);
        }

        emit Routed(roundUsdg, agentAmount, platformAmount, burned);
    }

    // --- Internals ---

    function _platformConfigured() internal view returns (bool) {
        return platformToken != address(0) && address(platformCurve) != address(0);
    }

    /// @notice Wrap the claimed native ETH and swap it to USDG on the deepest v3 pool.
    /// @dev The effective minimum is `max(minUsdgOut, on-chain QuoterV2 floor)`, so the no-arg keeper
    ///      path (minUsdgOut = 0) still enforces a real, non-zero slippage bound.
    function _swapEthToUsdg(uint256 ethAmount, uint256 minUsdgOut) internal returns (uint256 usdgOut) {
        // On-chain quote of the same swap, then a bounded-deviation floor derived from it.
        (uint256 quoted,,,) = QUOTER.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: platformQuote,
                amountIn: ethAmount,
                fee: ETH_USDG_FEE,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 floorMin = (quoted * (BPS_DENOM - maxDeviationBps)) / BPS_DENOM;
        uint256 effectiveMin = minUsdgOut > floorMin ? minUsdgOut : floorMin;

        IWETH(WETH).deposit{value: ethAmount}();
        _safeApprove(IERC20(WETH), address(SWAP_ROUTER), ethAmount);
        ISwapRouter02.ExactInputSingleParams memory p = ISwapRouter02.ExactInputSingleParams({
            tokenIn: WETH,
            tokenOut: platformQuote,
            fee: ETH_USDG_FEE,
            recipient: address(this),
            amountIn: ethAmount,
            amountOutMinimum: effectiveMin,
            sqrtPriceLimitX96: 0
        });
        usdgOut = SWAP_ROUTER.exactInputSingle(p);
    }

    /// @notice Buy the platform token with USDG and burn it by directing the buy to the dead address.
    ///         No ERC-20 burn() call is needed: the tokens are minted straight to 0x…dEaD.
    function _buyAndBurn(uint256 usdgAmount, uint256 minPlatformOut) internal {
        // Pre-graduation curve buy. USDG-quoted platform token: approve the curve to pull USDG, then
        // buy with recipient = dead address. (Native-quoted would send msg.value instead; the
        // platform token's quote asset is USDG per SPEC 5, so this is the USDG path.)
        //
        // TODO(SPEC 10.3, post-graduation): once the platform token graduates (4.2 ETH, LP locks in
        // Uniswap v4) `platformCurve.buy` reverts. Route the burn through PonsV2MemeHook / a v4 swap
        // (resolve the hook address, poolKey derivation, and v4 router at Milestone 1). Until then,
        // curve.buy to the dead address is the burn.
        IERC20 usdg = IERC20(platformQuote);
        // Reset to 0 before setting the new amount (defends against non-standard approve semantics).
        _safeApprove(usdg, address(platformCurve), 0);
        _safeApprove(usdg, address(platformCurve), usdgAmount);
        uint256 out = platformCurve.buy(usdgAmount, minPlatformOut, DEAD);
        emit PlatformBurned(usdgAmount, out);
    }

    /// @notice Require a non-reverting ERC-20 transfer that also returns true (or no data).
    function _safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @notice Require a non-reverting ERC-20 approve that also returns true (or no data).
    function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    /// @notice Receive native ETH from the escrow claim (and any stray ETH).
    receive() external payable {}
}
