// SERVER-ONLY. Bridge to the Milestone 2/5 keeper's Merkle helpers (api/keeper.mjs).
//
// Mirrors lib/server/launch.ts exactly. api/keeper.mjs is an ESM module in a SEPARATE workspace with
// its OWN node_modules (it resolves `pg`/`viem` from api/node_modules and lazily imports the account
// stack from agent/node_modules). If webpack bundled it into the web server chunk, those dependencies
// would have to resolve from web/node_modules and the build would break. So we load it as a NATIVE
// Node ESM module at runtime, from its real location on disk, with a `webpackIgnore` magic comment so
// webpack leaves the import untouched.
//
// We use ONLY its PURE, deterministic Merkle helpers (computeDistribution / buildMerkleTree /
// leafHash) so the claim API reproduces byte-identical proofs — never forking the algorithm (see the
// CROSS-BUILDER note in api/keeper.mjs). Importing the module runs its top-level env autoload and
// defines viem clients, but opens no connection; its CLI main() does not run under import.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Address, Hex } from "viem";
import { loadRepoRootEnv } from "./env";

export interface SnapshotHolder {
  holder: string;
  balance: bigint;
}

export interface DistributionLeaf {
  index: number;
  account: Address;
  amount: bigint;
}

interface KeeperModule {
  /** Deterministic pro-rata split of `totalUsdg` (base units) across holders. Matches the keeper. */
  computeDistribution(holders: SnapshotHolder[], totalUsdg: bigint): DistributionLeaf[];
  /** Sorted-pair Merkle tree over ordered leaf hashes; proofs[i] proves leaves[i]. */
  buildMerkleTree(leaves: Hex[]): { root: Hex; proofs: Hex[][] };
  /** keccak256(abi.encodePacked(uint256 epoch, uint256 index, address account, uint256 amount)). */
  leafHash(
    epoch: bigint | number | string,
    index: bigint | number | string,
    account: string,
    amount: bigint | number | string,
  ): Hex;
}

let cached: KeeperModule | null = null;

/** Load api/keeper.mjs as a native ESM module (not bundled). Cached after the first load. */
export async function getKeeperModule(): Promise<KeeperModule> {
  if (cached) return cached;
  loadRepoRootEnv(); // ensure DATABASE_URL / RPC are present for the module's top-level init
  // process.cwd() is the web/ project dir; api/keeper.mjs sits at ../api/keeper.mjs.
  const modPath = path.join(process.cwd(), "..", "api", "keeper.mjs");
  const mod = (await import(/* webpackIgnore: true */ pathToFileURL(modPath).href)) as unknown as KeeperModule;
  cached = mod;
  return mod;
}
