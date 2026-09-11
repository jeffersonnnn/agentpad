// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "./interfaces/IERC20.sol";

/// @title Distributor — per-epoch Merkle profit distributor (SPEC.md section 3, ADR 0002).
/// @notice The claim-based profit payout for one agent, following the proven $REBOUND Merkle pattern
///         (`ReboundAirdrop.sol`, itself the canonical Uniswap `MerkleDistributor`). PONS ERC-20s have
///         no checkpoints and holders change every block, so the keeper snapshots holder balances
///         OFF-chain each epoch, computes each holder's USDG share, builds a Merkle tree, and commits
///         only the root + the epoch total here. Holders then claim their USDG by proof.
///
///         Payout asset is ALWAYS USDG (SPEC 3/5). An ETH-quoted agent converts to USDG before it
///         funds an epoch; this contract only ever holds and pays USDG.
///
/// @dev OFF-CHAIN SNAPSHOT RULES (enforced by the keeper that builds the tree, NOT by this contract):
///      - Exclude the curve/pool address, this agent's fee splitter, the agent treasury, and known
///        infra from the holder set — they are not profit recipients (SPEC 3).
///      - `totalUsdg` for an epoch is the REALIZED gain ABOVE the USDG high-water mark: only the excess
///        over the highest cumulative realized-USDG level already distributed is paid out (SPEC 3). The
///        high-water mark itself lives in the off-chain `distribution_config` (SPEC 7); this contract
///        is a pure distributor and does not compute it. `totalCommittedUsdg` below mirrors the running
///        distributed total on-chain for transparency.
///      - The distribute-vs-buyback policy, rate, and cadence (ADR 0002) sit ABOVE this engine and
///        decide whether/when to call `setRoot` and with what total. The engine's rules never change.
///
///      LEAF FORMAT (both sides MUST match): `keccak256(abi.encodePacked(epoch, index, account, amount))`
///      with standard sorted-pair proof hashing (OpenZeppelin `MerkleProof.verify` semantics). `epoch`
///      is bound into the leaf so a proof for one epoch can never be replayed against another.
///
///      FUNDING INVARIANT: `setRoot` requires the contract already holds USDG covering ALL outstanding
///      (committed-but-unclaimed) liabilities across every epoch. So the orchestration is: transfer the
///      epoch's USDG in, THEN `setRoot`. This guarantees a committed epoch can never starve — every set
///      root is fully funded, and one epoch's claimers cannot drain another's payout.
///
///      KEEPER OFF-CHAIN ASSERTION (belt-and-suspenders with on-chain `reconcile`): the M3 keeper that
///      builds the tree MUST assert `totalUsdg == the EXACT sum of every leaf amount` at tree-build time
///      (a HARD assertion that aborts the commit on any mismatch). This contract cannot recompute the
///      leaf sum on-chain (it only holds the root), so a wrong `totalUsdg` is an off-chain mistake:
///        - `totalUsdg` GREATER than the leaf sum permanently locks the surplus (nothing can claim it,
///          and `rescue` reverts `WouldStarveClaims` because `outstandingUsdg` never falls to it);
///        - `totalUsdg` LESS than the leaf sum DoS-reverts the last honest claimers (`ExceedsEpochTotal`).
///      The keeper's exact-sum assertion prevents both. The `reconcile` path below is the on-chain
///      recovery for the surplus/lock case when that assertion is somehow bypassed.
///
///      CLAIM WINDOW + RECONCILIATION: each epoch gets an expiry (`epochExpiry[epoch] = commit time +
///      `claimWindow`). Claims are open only DURING the window; after expiry a claim reverts `EpochExpired`
///      (unclaimed shares are forfeit, the standard Merkle-airdrop claim-deadline pattern). Because no
///      share is still claimable after expiry, the owner may then `reconcile(epoch)` to floor that epoch's
///      `totalUsdg`/`outstandingUsdg` down to its already-`claimedUsdg` amount — NEVER below claimed, and
///      only after expiry — so a provably-unclaimable remainder (a keeper `totalUsdg` overshoot, or shares
///      that lapsed unclaimed) is freed from `outstandingUsdg` and becomes `rescue`-able. Reconciliation
///      can never reduce a still-claimable liability: while shares are claimable (before expiry) it reverts.
contract Distributor {
    /// @notice The USDG token being distributed. Immutable; payout is always USDG (SPEC 3/5).
    address public immutable usdg;

    address public owner;

    /// @notice Keepers allowed to call `setRoot` alongside the owner (the snapshot/distribution keeper).
    mapping(address => bool) public isKeeper;

    struct Epoch {
        bytes32 merkleRoot; // the committed root; nonzero once set (one-time, immutable per epoch)
        uint256 totalUsdg; // the epoch's total distributable USDG (already the post-high-water excess)
        uint256 claimedUsdg; // running sum claimed from this epoch
    }

    /// @notice Per-epoch distribution data. `epoch` is the off-chain epoch id (e.g. the hourly index).
    mapping(uint256 => Epoch) public epochs;

    /// @dev Packed bitmap of claimed leaf indices, per epoch: epoch => (index/256) => 256-bit word.
    mapping(uint256 => mapping(uint256 => uint256)) private claimedBitMap;

    /// @notice USDG committed to set epochs but not yet claimed. The full-funding invariant keeps the
    ///         contract balance >= this at all times, so every committed claim is always payable.
    uint256 public outstandingUsdg;

    /// @notice Lifetime sum of every epoch total ever committed. On-chain mirror of the distributed
    ///         base the off-chain high-water mark tracks (SPEC 3); for transparency only. A `reconcile`
    ///         decrements this by the freed (never-distributed) remainder so it stays a truthful
    ///         distributed-base mirror.
    uint256 public totalCommittedUsdg;

    /// @notice The claim window applied to each new epoch at `setRoot`: an epoch is claimable for
    ///         `claimWindow` seconds after its commit, then unclaimed shares are forfeit and the surplus
    ///         becomes reconcilable/rescuable. Owner-settable within [MIN_CLAIM_WINDOW, MAX_CLAIM_WINDOW].
    uint256 public claimWindow = 90 days;

    /// @dev Bounds on `claimWindow` so a careless owner cannot set a 0 window (which would expire every
    ///      epoch on commit and revert all claims) or an effectively-infinite one.
    uint256 public constant MIN_CLAIM_WINDOW = 1 hours;
    uint256 public constant MAX_CLAIM_WINDOW = 365 days;

    /// @notice Unix timestamp at which `epoch`'s claim window closes (commit time + `claimWindow`).
    ///         Claims after this revert `EpochExpired`; `reconcile` is allowed only at/after this.
    mapping(uint256 => uint256) public epochExpiry;

    /// @dev Reentrancy mutex (1 = unlocked, 2 = locked). No external dependency.
    uint256 private _locked = 1;

    // --- Events ---
    event RootSet(uint256 indexed epoch, bytes32 merkleRoot, uint256 totalUsdg);
    event Claimed(uint256 indexed epoch, uint256 index, address indexed account, uint256 amount);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event KeeperSet(address indexed keeper, bool allowed);
    event Rescued(address indexed token, uint256 amount);
    event ClaimWindowSet(uint256 window);
    /// @param freedUsdg the never-distributable remainder removed from `outstandingUsdg`.
    /// @param remainingTotal the epoch's post-reconcile total (== its `claimedUsdg`).
    event Reconciled(uint256 indexed epoch, uint256 freedUsdg, uint256 remainingTotal);

    // --- Errors ---
    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error ZeroRoot();
    error ZeroTotal();
    error EpochAlreadySet();
    error UnknownEpoch();
    error AlreadyClaimed();
    error InvalidProof();
    error ExceedsEpochTotal();
    error NotFunded();
    error WouldStarveClaims();
    error TransferFailed();
    error Reentrancy();
    error EpochExpired();
    error NotExpired();
    error NothingToReconcile();
    error BadClaimWindow();

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

    /// @param _usdg  the USDG token (payout asset). RH Chain 4663: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168.
    constructor(address _usdg) {
        if (_usdg == address(0)) revert ZeroAddress();
        usdg = _usdg;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    // --- Admin ---

    /// @notice Add or remove a keeper allowed to call `setRoot` (the distribution keeper).
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Set the claim window applied to epochs committed AFTER this call. Bounded to
    ///         [MIN_CLAIM_WINDOW, MAX_CLAIM_WINDOW]. Already-committed epochs keep their fixed expiry.
    function setClaimWindow(uint256 newWindow) external onlyOwner {
        if (newWindow < MIN_CLAIM_WINDOW || newWindow > MAX_CLAIM_WINDOW) revert BadClaimWindow();
        claimWindow = newWindow;
        emit ClaimWindowSet(newWindow);
    }

    /// @notice Recover stranded tokens. For USDG, only the SURPLUS above `outstandingUsdg` may be pulled,
    ///         so a rescue can never take USDG owed to holders of an already-committed epoch. Other
    ///         tokens (accidentally sent) may be swept in full.
    function rescue(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == usdg) {
            uint256 bal = IERC20(usdg).balanceOf(address(this));
            // The post-rescue balance must still cover every outstanding claim.
            if (bal < amount || bal - amount < outstandingUsdg) revert WouldStarveClaims();
        }
        _safeTransfer(token, owner, amount);
        emit Rescued(token, amount);
    }

    // --- Commit a distribution ---

    /// @notice Commit one epoch's Merkle root and total. Keeper/owner only, one-time per epoch (a set
    ///         root is immutable, so committed holders can never be re-diluted). Requires the contract
    ///         is already funded to cover ALL outstanding liabilities including this epoch (fund first,
    ///         then set the root).
    /// @dev The keeper MUST assert off-chain that `totalUsdg` equals the EXACT sum of every leaf amount
    ///      before calling this (a hard assertion). This contract holds only the root and cannot recompute
    ///      the leaf sum, so a wrong `totalUsdg` locks a surplus or DoS-reverts the last claimers; the
    ///      exact-sum assertion prevents both, and `reconcile` is the on-chain recovery of last resort.
    /// @param epoch      the off-chain epoch id.
    /// @param root       the Merkle root over leaves `keccak256(abi.encodePacked(epoch,index,account,amount))`.
    /// @param totalUsdg  the epoch's total distributable USDG (already the post-high-water excess).
    function setRoot(uint256 epoch, bytes32 root, uint256 totalUsdg) external onlyOwnerOrKeeper {
        if (root == bytes32(0)) revert ZeroRoot();
        if (totalUsdg == 0) revert ZeroTotal();
        if (epochs[epoch].merkleRoot != bytes32(0)) revert EpochAlreadySet();

        epochs[epoch] = Epoch({merkleRoot: root, totalUsdg: totalUsdg, claimedUsdg: 0});
        epochExpiry[epoch] = block.timestamp + claimWindow;
        outstandingUsdg += totalUsdg;
        totalCommittedUsdg += totalUsdg;

        // Full-funding invariant: the contract must already hold enough USDG to pay every committed
        // (unclaimed) share across all epochs. Transfer the epoch's USDG in BEFORE calling setRoot.
        if (IERC20(usdg).balanceOf(address(this)) < outstandingUsdg) revert NotFunded();

        emit RootSet(epoch, root, totalUsdg);
    }

    // --- Claim ---

    /// @notice Claim `amount` USDG for `account` from `epoch` if the proof is valid and unclaimed.
    /// @dev Anyone may submit the proof, but USDG always goes to the leaf's `account`, so a third party
    ///      cannot redirect a claim. Reverts on a re-used index or a bad proof.
    function claim(uint256 epoch, uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof)
        public
        nonReentrant
    {
        _claim(epoch, index, account, amount, merkleProof);
    }

    struct ClaimData {
        uint256 epoch;
        uint256 index;
        address account;
        uint256 amount;
        bytes32[] merkleProof;
    }

    /// @notice Claim across many epochs in one transaction. With hourly epochs (SPEC 7) a holder
    ///         accumulates many small shares, so batching keeps claiming cheap.
    function claimMany(ClaimData[] calldata claims) external nonReentrant {
        for (uint256 i = 0; i < claims.length; i++) {
            ClaimData calldata c = claims[i];
            _claim(c.epoch, c.index, c.account, c.amount, c.merkleProof);
        }
    }

    function _claim(uint256 epoch, uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof)
        internal
    {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == bytes32(0)) revert UnknownEpoch();
        // Claims are open only during the window; after expiry the share is forfeit (and reconcilable).
        if (block.timestamp >= epochExpiry[epoch]) revert EpochExpired();
        if (isClaimed(epoch, index)) revert AlreadyClaimed();

        bytes32 node = keccak256(abi.encodePacked(epoch, index, account, amount));
        if (!_verify(merkleProof, e.merkleRoot, node)) revert InvalidProof();

        // Effects before interaction (checks-effects-interactions), plus the reentrancy guard.
        _setClaimed(epoch, index);
        uint256 newClaimed = e.claimedUsdg + amount;
        // Guards a malformed tree whose leaves sum past the committed total from over-paying.
        if (newClaimed > e.totalUsdg) revert ExceedsEpochTotal();
        e.claimedUsdg = newClaimed;
        outstandingUsdg -= amount;

        _safeTransfer(usdg, account, amount);

        emit Claimed(epoch, index, account, amount);
    }

    // --- Reconcile (post-expiry recovery of an unclaimable remainder) ---

    /// @notice After an epoch's claim window has closed, floor its `totalUsdg` down to the amount already
    ///         claimed, freeing the provably-unclaimable remainder (a keeper `totalUsdg` overshoot and/or
    ///         shares that lapsed unclaimed) from `outstandingUsdg` so it becomes `rescue`-able.
    /// @dev    Owner-only. Reverts before expiry (`NotExpired`) — while any share is still claimable the
    ///         remainder is NOT provably unclaimable, so it can never touch a still-claimable liability.
    ///         Never reduces `totalUsdg` below `claimedUsdg`, so it can never claw back a paid claim.
    ///         Only ever LOWERS `outstandingUsdg`, so the full-funding invariant is preserved.
    function reconcile(uint256 epoch) external onlyOwner nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == bytes32(0)) revert UnknownEpoch();
        if (block.timestamp < epochExpiry[epoch]) revert NotExpired();

        uint256 freed = e.totalUsdg - e.claimedUsdg; // the unclaimable remainder (>= 0)
        if (freed == 0) revert NothingToReconcile();

        e.totalUsdg = e.claimedUsdg; // floor at claimed; never below
        outstandingUsdg -= freed; // release the remainder; balance is unchanged so funding still holds
        totalCommittedUsdg -= freed; // keep the distributed-base mirror truthful (freed was never paid)

        emit Reconciled(epoch, freed, e.claimedUsdg);
    }

    // --- Views ---

    /// @notice Whether the leaf at `index` in `epoch` has already been claimed.
    function isClaimed(uint256 epoch, uint256 index) public view returns (bool) {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;
        uint256 word = claimedBitMap[epoch][wordIndex];
        uint256 mask = (uint256(1) << bitIndex);
        return word & mask == mask;
    }

    /// @notice USDG still claimable from `epoch` (its total minus what has been claimed).
    function unclaimedOf(uint256 epoch) external view returns (uint256) {
        Epoch storage e = epochs[epoch];
        return e.totalUsdg - e.claimedUsdg;
    }

    /// @notice True if the contract holds enough USDG to cover every outstanding claim.
    function isFullyFunded() external view returns (bool) {
        return IERC20(usdg).balanceOf(address(this)) >= outstandingUsdg;
    }

    // --- Internals ---

    function _setClaimed(uint256 epoch, uint256 index) private {
        uint256 wordIndex = index / 256;
        uint256 bitIndex = index % 256;
        claimedBitMap[epoch][wordIndex] = claimedBitMap[epoch][wordIndex] | (uint256(1) << bitIndex);
    }

    /// @dev Standard sorted-pair Merkle proof verification (OpenZeppelin `MerkleProof.verify` semantics):
    ///      each step hashes the concatenation of the two siblings in ascending order.
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            if (computed <= p) {
                computed = keccak256(abi.encodePacked(computed, p));
            } else {
                computed = keccak256(abi.encodePacked(p, computed));
            }
        }
        return computed == root;
    }

    /// @notice Require a non-reverting ERC-20 transfer that also returns true (or no data). USDG returns
    ///         a bool; this handles both the standard and no-return-data token conventions.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
