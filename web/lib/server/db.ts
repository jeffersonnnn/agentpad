// SERVER-ONLY. Read-only Postgres access for the AgentPad read endpoints (SPEC.md section 7 tables).
//
// A single lazily-created pg Pool over DATABASE_URL (repo-root .env, loaded via loadRepoRootEnv). The
// route handlers issue ONLY parameterized SELECTs through `query` — every user-supplied value is bound
// ($1, $2, …), never interpolated, so there is no SQL-injection surface. `pg` is declared in
// next.config.mjs `serverComponentsExternalPackages` so webpack does not try to bundle it or its
// optional native binding.

import { Pool, type QueryResultRow } from "pg";
import { loadRepoRootEnv } from "./env";

let pool: Pool | null = null;

export function getPool(): Pool {
  loadRepoRootEnv();
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (expected in the repo-root .env).");
  }
  // Neon (and any sslmode=require URL) needs TLS; node-postgres does not read sslmode from the URL.
  const needSsl = /sslmode=require/i.test(connectionString) || /neon\.tech/i.test(connectionString);
  pool = new Pool({
    connectionString,
    ssl: needSsl ? { rejectUnauthorized: false } : undefined,
    max: 4,
  });
  return pool;
}

/** Run a parameterized read query and return its rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as unknown[]);
  return res.rows;
}

// Column list for the agents table, matching lib/types.ts Agent (SPEC.md section 7). Selected
// explicitly so no unexpected/secret column is ever returned (the agents table holds none, but the
// explicit list keeps the wire contract pinned).
export const AGENT_COLS =
  "id, token_addr, curve_addr, splitter_addr, distributor_addr, account_addr, creator_addr, " +
  "archetype, persona_prompt, model, quote_asset, status, logo_url, paused, created_at";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Clamp a caller-supplied limit into [1, max], defaulting when absent/invalid. */
export function clampLimit(raw: string | null, def = 100, max = 500): number {
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}
