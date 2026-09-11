// GET /api/agents/:id/claim?epoch=&address= — the Merkle proof for one holder in one published epoch
// (SPEC.md section 3, ADR 0002). Read-only. Returns { epoch, index, account, amount, proof, merkleRoot }.
//
// The server NEVER signs: it only reproduces the proof from persisted state. The holder signs the
// Distributor.claim(epoch, index, account, amount, proof) call client-side (see DistributionsPanel).
//
// HOW THE PROOF IS REBUILT (must reproduce the committed root, byte-for-byte):
//   - Read the distributions row (total_usdg, to_block, merkle_root) and the persisted
//     holder_snapshots balances for (agent, epoch) from Postgres. The snapshot balances are ALREADY
//     the excluded/eligible holder set the keeper committed — we rebuild from them, NOT by re-scanning
//     chain, so the tree is identical to the one the keeper published.
//   - Rebuild the leaves with the SAME algorithm as the keeper + the contract, by importing
//     computeDistribution / buildMerkleTree / leafHash from api/keeper.mjs (never forking it):
//       leaf = keccak256(abi.encodePacked(uint256 epoch, uint256 index, address account, uint256 amount))
//       tree = sorted-pair hashing (OpenZeppelin MerkleProof semantics; matches Distributor._verify).
//   - VERIFY the rebuilt root equals distributions.merkle_root before returning. A mismatch is a
//     server-side bug (stale snapshot / algorithm drift) and returns 500 rather than a bad proof.

import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { query, UUID_RE, ADDR_RE } from "@/lib/server/db";
import { getKeeperModule, type SnapshotHolder } from "@/lib/server/keeper";

export const runtime = "nodejs"; // never edge: pg + the ESM api/keeper.mjs module
export const dynamic = "force-dynamic";

interface DistRow {
  merkle_root: string;
  total_usdg: string;
  to_block: string | null;
}
interface SnapRow {
  holder: string;
  balance: string;
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const epochRaw = (url.searchParams.get("epoch") || "").trim();
  const addressRaw = (url.searchParams.get("address") || "").trim();

  if (!/^\d+$/.test(epochRaw)) {
    return NextResponse.json({ error: "epoch must be a non-negative integer" }, { status: 400 });
  }
  if (!ADDR_RE.test(addressRaw)) {
    return NextResponse.json({ error: "address must be a 0x-prefixed 20-byte address" }, { status: 400 });
  }
  const wanted = addressRaw.toLowerCase();

  try {
    // 1) The published epoch (root + total we must reproduce).
    const distRows = await query<DistRow>(
      `SELECT merkle_root, total_usdg, to_block FROM distributions WHERE agent_id = $1 AND epoch = $2`,
      [id, epochRaw],
    );
    if (distRows.length === 0) {
      return NextResponse.json({ error: `no distribution for epoch ${epochRaw}` }, { status: 404 });
    }
    const dist = distRows[0];

    // 2) The persisted, already-excluded holder balances backing that epoch's root.
    const snapRows = await query<SnapRow>(
      `SELECT holder, balance FROM holder_snapshots WHERE agent_id = $1 AND epoch = $2`,
      [id, epochRaw],
    );
    if (snapRows.length === 0) {
      return NextResponse.json({ error: `no holder snapshot for epoch ${epochRaw}` }, { status: 404 });
    }

    const holders: SnapshotHolder[] = snapRows.map((r) => ({ holder: r.holder, balance: BigInt(r.balance) }));

    // 3) Rebuild the exact leaf set + tree with the keeper's own helpers (no fork).
    const { computeDistribution, buildMerkleTree, leafHash } = await getKeeperModule();
    const totalUsdg = BigInt(dist.total_usdg);
    const leaves = computeDistribution(holders, totalUsdg);
    if (leaves.length === 0) {
      return NextResponse.json({ error: "epoch has no payable leaves" }, { status: 404 });
    }

    const leafHashes = leaves.map((l) => leafHash(epochRaw, l.index, l.account, l.amount));
    const { root, proofs } = buildMerkleTree(leafHashes);

    // 4) The rebuilt root MUST match the committed on-chain root, or the proof would not verify.
    if (root.toLowerCase() !== dist.merkle_root.toLowerCase()) {
      return NextResponse.json(
        {
          error: `rebuilt Merkle root ${root} does not match committed root ${dist.merkle_root} for epoch ${epochRaw}`,
        },
        { status: 500 },
      );
    }

    // 5) Locate this address's leaf (accounts are checksummed by computeDistribution).
    const leafIndex = leaves.findIndex((l) => l.account.toLowerCase() === wanted);
    if (leafIndex === -1) {
      return NextResponse.json({ error: "address is not in this epoch" }, { status: 404 });
    }
    const leaf = leaves[leafIndex];

    return NextResponse.json({
      epoch: epochRaw,
      index: leaf.index,
      account: getAddress(leaf.account),
      amount: leaf.amount.toString(), // USDG base units (6 dec), decimal string
      proof: proofs[leafIndex],
      merkleRoot: dist.merkle_root,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
