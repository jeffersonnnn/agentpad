// Shared API client — the single place the frontend talks to the Milestone 3 backend
// (api/launch.mjs orchestration: prepare/finalize; and the Postgres-backed reads over db/schema.sql).
//
// The backend today is a set of ESM functions + a CLI, not an HTTP server. This client targets
// same-origin Next.js route handlers by default (NEXT_PUBLIC_API_BASE empty) — thin handlers under
// web/app/api/* import api/launch.mjs server-side and query Postgres, then return the JSON shapes in
// lib/types.ts. Set NEXT_PUBLIC_API_BASE to an absolute URL only if that backend is hosted separately.
//
// This file is SHARED (works in server components, client components, and route handlers). It holds
// NO secrets and does NO signing: prepareLaunch returns an UNSIGNED tx that the creator's wallet
// signs client-side (never the server — see api/launch.mjs "NEVER CUSTODY").

import type { Address, Hex } from "viem";
import type {
  Agent,
  Distribution,
  DistributionConfig,
  FeedEntry,
  FinalizeLaunchInput,
  FinalizeLaunchResult,
  LaunchTx,
  LeaderboardEntry,
  Position,
  PrepareLaunchInput,
  PrepareLaunchResult,
  SquareFeedEntry,
} from "./types";

// Empty base = same-origin Next.js route handlers (the default deployment).
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");

// Canonical endpoint paths. Kept here so the route handlers (web/app/api/*) and the client agree.
export const ENDPOINTS = {
  prepare: "/api/launch/prepare",
  finalize: "/api/launch/finalize",
  agents: "/api/agents",
  agent: (id: string) => `/api/agents/${encodeURIComponent(id)}`,
  agentFeed: (id: string) => `/api/agents/${encodeURIComponent(id)}/feed`,
  agentPositions: (id: string) => `/api/agents/${encodeURIComponent(id)}/positions`,
  agentDistributions: (id: string) => `/api/agents/${encodeURIComponent(id)}/distributions`,
  agentClaim: (id: string) => `/api/agents/${encodeURIComponent(id)}/claim`,
  agentXConnect: (id: string) => `/api/agents/${encodeURIComponent(id)}/x-connect`,
  squareLeaderboard: "/api/square/leaderboard",
  squareFeed: "/api/square/feed",
} as const;

// X connect (ADR 0005 / SPEC 11): creator-supplied X keys, opt-in, creator-funded.
export type XAuth = "oauth2" | "oauth1a";

export interface XConnectStatus {
  connected: boolean;
  auth?: XAuth | null;
}

// OAuth 2.0 needs accessToken (+ optional refresh); OAuth 1.0a needs all four. Never persisted client-side.
export interface XKeys {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  apiSecret?: string;
  accessSecret?: string;
}

/** The exact message the creator signs to authorize a connect/disconnect. Server validates its shape. */
export function xConnectMessage(agentId: string, action: "connect" | "disconnect", issuedIso: string): string {
  return `AgentPad X connect\nagent: ${agentId}\naction: ${action}\nissued: ${issuedIso}`;
}

// The Merkle proof for one holder in one published epoch. The holder feeds these straight into
// Distributor.claim(epoch, index, account, amount, proof) — the server never signs (ADR 0004).
export interface ClaimProof {
  epoch: string; // bigint as string
  index: number;
  account: Address;
  amount: string; // USDG base units (6 dec), decimal string
  proof: Hex[]; // sorted-pair Merkle proof (bytes32[])
  merkleRoot: Hex; // the committed on-chain root the proof reproduces
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);

  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body && String((body as { error: unknown }).error)) ||
      `${init?.method || "GET"} ${path} failed (${res.status})`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

// ── Orchestration (writes go through the backend; the creator signs launchTx, never the server) ────

/** Step 1-3: deploy the splitter, predict the account, and get the UNSIGNED creator launchToken tx. */
export function prepareLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult> {
  return request<PrepareLaunchResult>(ENDPOINTS.prepare, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Step 4: after the creator broadcasts launchTx, relay (token, curve, txHash) back to go live. */
export function finalizeLaunch(input: FinalizeLaunchInput): Promise<FinalizeLaunchResult> {
  return request<FinalizeLaunchResult>(ENDPOINTS.finalize, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ── Reads (Postgres-backed, over db/schema.sql) ───────────────────────────────────────────────────

export function listAgents(params?: { status?: string; creator?: Address; limit?: number }): Promise<Agent[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.creator) qs.set("creator", params.creator);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<Agent[]>(`${ENDPOINTS.agents}${suffix}`);
}

export function getAgent(id: string): Promise<{ agent: Agent; distribution: DistributionConfig | null }> {
  return request<{ agent: Agent; distribution: DistributionConfig | null }>(ENDPOINTS.agent(id));
}

export function getAgentFeed(id: string, params?: { kind?: string; limit?: number; before?: string }): Promise<FeedEntry[]> {
  const qs = new URLSearchParams();
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.before) qs.set("before", params.before);
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<FeedEntry[]>(`${ENDPOINTS.agentFeed(id)}${suffix}`);
}

export function getAgentPositions(id: string): Promise<Position[]> {
  return request<Position[]>(ENDPOINTS.agentPositions(id));
}

export function getAgentDistributions(id: string): Promise<Distribution[]> {
  return request<Distribution[]>(ENDPOINTS.agentDistributions(id));
}

/**
 * Rebuild one holder's Merkle proof for a published epoch (read-only; the server never signs). Throws
 * ApiError with status 404 when the address is not in that epoch (or the epoch is not published yet).
 */
export function getClaim(agentId: string, epoch: string, address: Address): Promise<ClaimProof> {
  const qs = new URLSearchParams({ epoch, address });
  return request<ClaimProof>(`${ENDPOINTS.agentClaim(agentId)}?${qs}`);
}

// ── The Square (ADR 0005 / SPEC 11): the global community surface ───────────────────────────────────

/** Agents ranked by realized profit paid to holders (sum of distributions), tiebreak by age. */
export function getSquareLeaderboard(params?: { status?: string; limit?: number }): Promise<LeaderboardEntry[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<LeaderboardEntry[]>(`${ENDPOINTS.squareLeaderboard}${suffix}`);
}

/** Recent activity across all agents: thoughts, trades, distributions, reactions. */
export function getSquareFeed(params?: { limit?: number; before?: string }): Promise<SquareFeedEntry[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.before) qs.set("before", params.before);
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<SquareFeedEntry[]>(`${ENDPOINTS.squareFeed}${suffix}`);
}

// ── X connect (creator-only; the signature proves the caller owns creator_addr) ─────────────────────

/** Whether the agent has X connected (no secrets returned). */
export function getXConnectStatus(id: string): Promise<XConnectStatus> {
  return request<XConnectStatus>(ENDPOINTS.agentXConnect(id));
}

/** Store the creator's X keys. `message`/`signature` come from the creator's wallet (see xConnectMessage). */
export function connectX(
  id: string,
  input: { auth: XAuth; keys: XKeys; message: string; signature: Hex },
): Promise<XConnectStatus> {
  return request<XConnectStatus>(ENDPOINTS.agentXConnect(id), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Remove the stored X keys (creator-signed). */
export function disconnectX(id: string, input: { message: string; signature: Hex }): Promise<XConnectStatus> {
  return request<XConnectStatus>(ENDPOINTS.agentXConnect(id), {
    method: "DELETE",
    body: JSON.stringify(input),
  });
}

// ── Helper: turn the JSON-safe LaunchTx into wagmi/viem sendTransaction args ───────────────────────
// The creator's wallet sends this (e.g. `useSendTransaction().sendTransaction(launchTxToSendParams(tx))`).
export function launchTxToSendParams(tx: LaunchTx): {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
} {
  return {
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    chainId: tx.chainId,
  };
}
