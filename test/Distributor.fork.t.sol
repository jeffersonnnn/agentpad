// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {Distributor} from "../src/Distributor.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice MILESTONE 2. The per-agent Merkle profit distributor (SPEC.md section 3), against LIVE USDG
///         on Robinhood Chain 4663. It funds the distributor with real USDG, commits a per-epoch Merkle
///         root, and proves: holders claim their USDG share by proof (set-root -> claim), a WRONG proof
///         reverts, a double claim reverts, the full-funding invariant holds, and only the owner/keeper
///         may commit a root.
///
///         The Merkle tree is built in-Solidity here (leaf = keccak256(abi.encodePacked(epoch, index,
///         account, amount)), sorted-pair hashing) so both sides of the proof match the contract exactly.
///
///         Run: forge test --match-contract Distributor --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract DistributorForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dec, base/payout currency
    uint256 constant USDG_BALANCE_SLOT = 1; // FACTS.md: USDG balances live at storage slot 1

    // Three holders in the snapshot (curve/pool, splitter, treasury already excluded off-chain).
    address constant HOLDER_A = address(0xA11CE);
    address constant HOLDER_B = address(0xB0B);
    address constant HOLDER_C = address(0xCA401);
    address constant KEEPER = address(0xCEE9E5); // the distribution keeper
    address constant STRANGER = address(0x57A9E5); // an unauthorized caller

    uint256 constant EPOCH = 42;

    // Per-holder USDG shares for the epoch (6 dec). Sum = the epoch total.
    uint256 constant AMT_A = 500_000_000; // 500 USDG
    uint256 constant AMT_B = 300_000_000; // 300 USDG
    uint256 constant AMT_C = 200_000_000; // 200 USDG
    uint256 constant TOTAL = AMT_A + AMT_B + AMT_C; // 1000 USDG

    Distributor dist;

    // The built tree: leaves and the root.
    bytes32 leafA;
    bytes32 leafB;
    bytes32 leafC;
    bytes32 root;

    function setUp() public {
        try vm.activeFork() returns (uint256) {}
        catch {
            vm.skip(true);
            return;
        }

        dist = new Distributor(USDG); // test contract is the owner
        dist.setKeeper(KEEPER, true);

        // Build a 3-leaf Merkle tree. Layout: node = hashPair(leafA, leafB); root = hashPair(node, leafC).
        leafA = _leaf(EPOCH, 0, HOLDER_A, AMT_A);
        leafB = _leaf(EPOCH, 1, HOLDER_B, AMT_B);
        leafC = _leaf(EPOCH, 2, HOLDER_C, AMT_C);
        bytes32 nodeAB = _hashPair(leafA, leafB);
        root = _hashPair(nodeAB, leafC);
    }

    // --- helpers ---------------------------------------------------------

    function _leaf(uint256 epoch, uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(epoch, index, account, amount));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Proof for A: sibling leafB, then sibling leafC (up to the root).
    function _proofA() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leafB;
        p[1] = leafC;
    }

    /// Proof for B: sibling leafA, then sibling leafC.
    function _proofB() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leafA;
        p[1] = leafC;
    }

    /// Proof for C: sibling nodeAB (one level up).
    function _proofC() internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = _hashPair(leafA, leafB);
    }

    /// Write a USDG balance at the known slot (FACTS.md: slot 1), avoiding stdstore auto-probing.
    function _dealUsdg(address to, uint256 amount) internal {
        vm.store(USDG, keccak256(abi.encode(to, USDG_BALANCE_SLOT)), bytes32(amount));
    }

    // --- tests -----------------------------------------------------------

    /// setRoot must revert if the contract is not yet funded for the committed total (fund-first invariant).
    function test_setRoot_reverts_when_underfunded() public {
        // No USDG in the distributor yet.
        assertEq(IERC20(USDG).balanceOf(address(dist)), 0, "starts empty");
        vm.prank(KEEPER);
        vm.expectRevert(Distributor.NotFunded.selector);
        dist.setRoot(EPOCH, root, TOTAL);
    }

    /// Only the owner or an allowlisted keeper may commit a root.
    function test_setRoot_only_owner_or_keeper() public {
        _dealUsdg(address(dist), TOTAL);
        vm.prank(STRANGER);
        vm.expectRevert(Distributor.NotAuthorized.selector);
        dist.setRoot(EPOCH, root, TOTAL);
    }

    /// The core path: fund, keeper sets the root, every holder claims their exact USDG share by proof.
    function test_setRoot_then_claim_pays_each_holder() public {
        // 1. Fund the distributor with the epoch total in real USDG, THEN commit the root (SPEC funding order).
        _dealUsdg(address(dist), TOTAL);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        (bytes32 storedRoot, uint256 total, uint256 claimed) = dist.epochs(EPOCH);
        assertEq(storedRoot, root, "root committed");
        assertEq(total, TOTAL, "epoch total committed");
        assertEq(claimed, 0, "nothing claimed yet");
        assertEq(dist.outstandingUsdg(), TOTAL, "full total outstanding");
        assertTrue(dist.isFullyFunded(), "fully funded");

        // 2. Holder A claims (anyone may submit; USDG goes to the leaf's account).
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), 0, "A empty before");
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofA());
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), AMT_A, "A received its 500 USDG");
        assertTrue(dist.isClaimed(EPOCH, 0), "A marked claimed");

        // 3. Holder B claims, submitted by a third party -> still lands on B.
        vm.prank(STRANGER);
        dist.claim(EPOCH, 1, HOLDER_B, AMT_B, _proofB());
        assertEq(IERC20(USDG).balanceOf(HOLDER_B), AMT_B, "B received its 300 USDG");

        // 4. Holder C claims.
        dist.claim(EPOCH, 2, HOLDER_C, AMT_C, _proofC());
        assertEq(IERC20(USDG).balanceOf(HOLDER_C), AMT_C, "C received its 200 USDG");

        // The epoch is fully drained and accounting is consistent.
        (,, uint256 claimedAfter) = dist.epochs(EPOCH);
        assertEq(claimedAfter, TOTAL, "epoch fully claimed");
        assertEq(dist.outstandingUsdg(), 0, "nothing outstanding");
        assertEq(dist.unclaimedOf(EPOCH), 0, "no unclaimed left");
        assertEq(IERC20(USDG).balanceOf(address(dist)), 0, "distributor USDG fully paid out");
    }

    /// A WRONG proof reverts: right account+amount but another holder's proof; and a tampered amount.
    function test_wrong_proof_reverts() public {
        _dealUsdg(address(dist), TOTAL);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        // A's leaf (index 0, A, AMT_A) verified against B's proof -> InvalidProof.
        vm.expectRevert(Distributor.InvalidProof.selector);
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofB());

        // A claims a tampered (larger) amount with A's own proof -> the leaf no longer matches.
        vm.expectRevert(Distributor.InvalidProof.selector);
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A + 1, _proofA());

        // An entirely fabricated account with an empty proof -> InvalidProof.
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(Distributor.InvalidProof.selector);
        dist.claim(EPOCH, 3, STRANGER, 1_000_000, empty);

        // No USDG moved on any failed attempt.
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), 0, "A unpaid after bad proofs");
        assertEq(dist.outstandingUsdg(), TOTAL, "outstanding untouched");
    }

    /// A second claim of the same leaf reverts (double-claim protection).
    function test_double_claim_reverts() public {
        _dealUsdg(address(dist), TOTAL);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofA());
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), AMT_A, "A paid once");

        vm.expectRevert(Distributor.AlreadyClaimed.selector);
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofA());
    }

    /// A root may be committed only once per epoch (a set root is immutable).
    function test_setRoot_epoch_is_one_time() public {
        _dealUsdg(address(dist), TOTAL * 2);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        vm.prank(KEEPER);
        vm.expectRevert(Distributor.EpochAlreadySet.selector);
        dist.setRoot(EPOCH, root, TOTAL);
    }

    /// Claiming an epoch whose root was never set reverts.
    function test_claim_unknown_epoch_reverts() public {
        vm.expectRevert(Distributor.UnknownEpoch.selector);
        dist.claim(999, 0, HOLDER_A, AMT_A, _proofA());
    }

    /// rescue can pull only the USDG surplus above outstanding liabilities, never a holder's owed share.
    function test_rescue_cannot_starve_committed_claims() public {
        // Fund with the total plus a 100 USDG surplus, then commit.
        uint256 surplus = 100_000_000;
        _dealUsdg(address(dist), TOTAL + surplus);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        // Trying to rescue more than the surplus reverts.
        vm.expectRevert(Distributor.WouldStarveClaims.selector);
        dist.rescue(USDG, surplus + 1);

        // Rescuing exactly the surplus succeeds and leaves every committed claim funded.
        dist.rescue(USDG, surplus);
        assertEq(IERC20(USDG).balanceOf(address(dist)), TOTAL, "only the total remains");
        assertTrue(dist.isFullyFunded(), "still fully funded for claims");

        // And holders can still claim in full.
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofA());
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), AMT_A, "A still paid after rescue");
    }

    /// claimMany pays several epochs' shares for a holder in one call.
    function test_claimMany_across_epochs() public {
        // Epoch 1: a single-leaf tree for HOLDER_A (root == leaf, empty proof).
        uint256 e1 = 1;
        uint256 amt1 = 250_000_000;
        bytes32 root1 = _leaf(e1, 0, HOLDER_A, amt1);
        // Epoch 2: a single-leaf tree for HOLDER_A.
        uint256 e2 = 2;
        uint256 amt2 = 750_000_000;
        bytes32 root2 = _leaf(e2, 0, HOLDER_A, amt2);

        _dealUsdg(address(dist), amt1 + amt2);
        vm.startPrank(KEEPER);
        dist.setRoot(e1, root1, amt1);
        dist.setRoot(e2, root2, amt2);
        vm.stopPrank();

        bytes32[] memory empty = new bytes32[](0);
        Distributor.ClaimData[] memory claims = new Distributor.ClaimData[](2);
        claims[0] = Distributor.ClaimData({epoch: e1, index: 0, account: HOLDER_A, amount: amt1, merkleProof: empty});
        claims[1] = Distributor.ClaimData({epoch: e2, index: 0, account: HOLDER_A, amount: amt2, merkleProof: empty});

        dist.claimMany(claims);
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), amt1 + amt2, "A got both epochs in one call");
        assertEq(dist.outstandingUsdg(), 0, "all outstanding cleared");
    }

    // --- reconciliation (LOW fix): post-expiry recovery of an unclaimable remainder ----------------

    /// reconcile is gated on the claim window: while any share is still claimable it must revert.
    function test_reconcile_reverts_before_expiry() public {
        _dealUsdg(address(dist), TOTAL);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        // Right after the commit the window is open, so reconcile is forbidden.
        vm.expectRevert(Distributor.NotExpired.selector);
        dist.reconcile(EPOCH);

        // One second before expiry it is still forbidden.
        vm.warp(dist.epochExpiry(EPOCH) - 1);
        vm.expectRevert(Distributor.NotExpired.selector);
        dist.reconcile(EPOCH);
    }

    /// reconcile can never touch a still-claimable share: while the window is open it reverts, and a
    /// holder who has not yet claimed can still claim its full share (nothing was clawed back).
    function test_reconcile_cannot_touch_still_claimable_share() public {
        _dealUsdg(address(dist), TOTAL);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);

        // A claims; B and C have NOT yet claimed — their shares are still claimable.
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofA());
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), AMT_A, "A paid");

        // The owner cannot reconcile away B's and C's still-claimable shares before expiry.
        vm.expectRevert(Distributor.NotExpired.selector);
        dist.reconcile(EPOCH);

        // Proof the share was untouched: B claims its full amount while the window is still open.
        dist.claim(EPOCH, 1, HOLDER_B, AMT_B, _proofB());
        assertEq(IERC20(USDG).balanceOf(HOLDER_B), AMT_B, "B still claimed its full share");

        // C never claims. After expiry C's share is forfeit (window closed) and reconcile floors the
        // epoch total to what was claimed (A+B), freeing exactly C's share — never A's or B's paid amount.
        vm.warp(dist.epochExpiry(EPOCH));
        vm.expectRevert(Distributor.EpochExpired.selector);
        dist.claim(EPOCH, 2, HOLDER_C, AMT_C, _proofC());

        uint256 outstandingBefore = dist.outstandingUsdg();
        dist.reconcile(EPOCH);
        (, uint256 total, uint256 claimed) = dist.epochs(EPOCH);
        assertEq(claimed, AMT_A + AMT_B, "claimed = A+B");
        assertEq(total, AMT_A + AMT_B, "total floored to claimed, never below");
        assertEq(dist.outstandingUsdg(), outstandingBefore - AMT_C, "only C's forfeited share freed");
        // A's and B's already-received USDG is untouched.
        assertEq(IERC20(USDG).balanceOf(HOLDER_A), AMT_A, "A still holds its share");
        assertEq(IERC20(USDG).balanceOf(HOLDER_B), AMT_B, "B still holds its share");
    }

    /// A keeper `totalUsdg` overshoot locks a surplus (rescue reverts); after expiry reconcile frees it
    /// and the surplus becomes rescuable — the core LOW-fix recovery path.
    function test_reconcile_frees_locked_surplus_and_allows_rescue() public {
        // The keeper mistakenly commits MORE than the leaves sum to: leaves sum to TOTAL, total = TOTAL+surplus.
        uint256 surplus = 250_000_000; // 250 USDG that no leaf can ever claim
        _dealUsdg(address(dist), TOTAL + surplus);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL + surplus);

        // Every real holder claims their full share; the surplus is now provably unclaimable but locked.
        dist.claim(EPOCH, 0, HOLDER_A, AMT_A, _proofA());
        dist.claim(EPOCH, 1, HOLDER_B, AMT_B, _proofB());
        dist.claim(EPOCH, 2, HOLDER_C, AMT_C, _proofC());
        (, uint256 totalBefore, uint256 claimedBefore) = dist.epochs(EPOCH);
        assertEq(claimedBefore, TOTAL, "all real leaves claimed");
        assertEq(totalBefore, TOTAL + surplus, "committed total still carries the surplus");
        assertEq(dist.outstandingUsdg(), surplus, "surplus stuck as outstanding");

        // Before reconcile the surplus is unrescuable — rescue would starve the (phantom) outstanding.
        vm.expectRevert(Distributor.WouldStarveClaims.selector);
        dist.rescue(USDG, surplus);

        // Before expiry reconcile is forbidden.
        vm.expectRevert(Distributor.NotExpired.selector);
        dist.reconcile(EPOCH);

        // After expiry the owner reconciles: total floors to claimed, freeing the surplus from outstanding.
        vm.warp(dist.epochExpiry(EPOCH));
        dist.reconcile(EPOCH);
        (, uint256 totalAfter,) = dist.epochs(EPOCH);
        assertEq(totalAfter, TOTAL, "total floored to claimed");
        assertEq(dist.outstandingUsdg(), 0, "surplus released");

        // A second reconcile is a no-op guard.
        vm.expectRevert(Distributor.NothingToReconcile.selector);
        dist.reconcile(EPOCH);

        // The freed surplus is now rescuable to the owner.
        uint256 ownerBalBefore = IERC20(USDG).balanceOf(address(this));
        dist.rescue(USDG, surplus);
        assertEq(IERC20(USDG).balanceOf(address(this)), ownerBalBefore + surplus, "owner recovered the surplus");
        assertEq(IERC20(USDG).balanceOf(address(dist)), 0, "distributor fully drained");
    }

    /// reconcile is owner-only, and a keeper (allowed to setRoot) cannot call it.
    function test_reconcile_only_owner() public {
        _dealUsdg(address(dist), TOTAL);
        vm.prank(KEEPER);
        dist.setRoot(EPOCH, root, TOTAL);
        vm.warp(dist.epochExpiry(EPOCH));

        vm.prank(KEEPER);
        vm.expectRevert(Distributor.NotOwner.selector);
        dist.reconcile(EPOCH);

        vm.prank(STRANGER);
        vm.expectRevert(Distributor.NotOwner.selector);
        dist.reconcile(EPOCH);
    }
}
