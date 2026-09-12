// SERVER-ONLY. Bridge to the Milestone 3 launch orchestration (api/launch.mjs).
//
// api/launch.mjs is an ESM module in a SEPARATE workspace with its OWN node_modules (it resolves `pg`
// from api/node_modules and lazily imports the ZeroDev account stack from agent/node_modules). If
// webpack bundled it into the web server chunk, those dependencies would have to resolve from
// web/node_modules and the build would break. So we load it as a NATIVE Node ESM module at runtime,
// from its real location on disk, with a `webpackIgnore` magic comment so webpack leaves the import
// untouched. Node then resolves launch.mjs's own dependencies from its own node_modules, exactly as
// the CLI does.
//
// NEVER CUSTODY (ADR 0004 / SPEC 2): prepareLaunch returns an UNSIGNED launchToken tx; the server
// never signs it. DEPLOYER_KEY (repo-root .env) is used only for infra prepareLaunch/finalizeLaunch
// deploy — never exposed to the client and never used to sign the creator's launch.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRepoRootEnv } from "./env";
import type {
  FinalizeLaunchInput,
  FinalizeLaunchResult,
  PrepareLaunchInput,
  PrepareLaunchResult,
} from "@/lib/types";

export interface ClaimFeesResult {
  txHash: string;
  splitter: string;
  agentAmount: string | null; // USDG base units routed to the agent treasury (80%)
  platformAmount: string | null; // USDG base units used to buy-and-burn the platform token (20%)
  treasury: string | null;
}

interface LaunchModule {
  prepareLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult>;
  finalizeLaunch(input: FinalizeLaunchInput): Promise<FinalizeLaunchResult>;
  claimFees(input: { agentId: string }): Promise<ClaimFeesResult>;
}

let cached: LaunchModule | null = null;

/** Load api/launch.mjs as a native ESM module (not bundled). Cached after the first load. */
export async function getLaunchModule(): Promise<LaunchModule> {
  if (cached) return cached;
  loadRepoRootEnv(); // ensure DEPLOYER_KEY / DATABASE_URL / ROBINHOOD_ALCHEMY_RPC are present
  // process.cwd() is the web/ project dir; api/launch.mjs sits at ../api/launch.mjs.
  const modPath = path.join(process.cwd(), "..", "api", "launch.mjs");
  const mod = (await import(/* webpackIgnore: true */ pathToFileURL(modPath).href)) as unknown as LaunchModule;
  cached = mod;
  return mod;
}
