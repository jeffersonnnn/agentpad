// SERVER-ONLY. The Observatory: a lightweight error/event sink so caught failures reach the developer
// instead of dying in a server log the operator cannot see. Every route handler reports its caught
// errors here; the browser reports client errors through POST /api/observatory. The developer reads
// them back with GET /api/observatory?token=... (guarded by OBSERVATORY_TOKEN).
//
// It is best-effort by design: reporting must NEVER throw into the request path or mask the original
// error. If the database write fails, we fall back to console.error and still return an id, so the
// user-facing message can always quote a reference.
//
// Storage reuses the same Neon Postgres pool as the read endpoints. The table is created on first use
// (CREATE TABLE IF NOT EXISTS), so there is no separate migration step to run on the box.

import { getPool } from "./db";

export type ObservatoryLevel = "error" | "warn" | "info";
export type ObservatorySource = "server" | "client";

export interface ReportContext {
  level?: ObservatoryLevel;
  source?: ObservatorySource;
  detail?: Record<string, unknown>;
  url?: string;
  userAddr?: string;
  ua?: string;
}

export interface ObservatoryEvent {
  id: string;
  ts: string;
  source: ObservatorySource;
  scope: string;
  level: ObservatoryLevel;
  message: string;
  detail: Record<string, unknown> | null;
  url: string | null;
  user_addr: string | null;
  ua: string | null;
}

let ensured: Promise<void> | null = null;

// Create the table once per process. Cached so concurrent reports do not race the DDL.
function ensureTable(): Promise<void> {
  if (ensured) return ensured;
  ensured = getPool()
    .query(
      `create table if not exists observatory_events (
         id         text primary key,
         ts         timestamptz not null default now(),
         source     text not null default 'server',
         scope      text not null,
         level      text not null default 'error',
         message    text not null,
         detail     jsonb,
         url        text,
         user_addr  text,
         ua         text
       );
       create index if not exists observatory_events_ts_idx on observatory_events (ts desc);`,
    )
    .then(() => undefined)
    .catch((e) => {
      // If DDL fails (e.g. read-only role), do not wedge future reports — reset so a later call retries.
      ensured = null;
      throw e;
    });
  return ensured;
}

// A short, roughly time-ordered id the user can quote back ("ref evt_...").
function newId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Trim a value so a huge stack or input blob cannot bloat the row. Applied to detail leaves.
function clip(v: unknown, max = 4000): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…[clipped]" : v;
  return v;
}

/**
 * Record one event. Never throws: on any failure it logs to the server console and still returns the
 * generated id, so callers can safely `const ref = await reportError(...)` inside a catch block.
 */
export async function reportEvent(
  scope: string,
  message: string,
  ctx: ReportContext = {},
): Promise<string> {
  const id = newId();
  const level = ctx.level ?? "error";
  const source = ctx.source ?? "server";
  const detail = ctx.detail
    ? Object.fromEntries(Object.entries(ctx.detail).map(([k, v]) => [k, clip(v)]))
    : null;
  try {
    await ensureTable();
    await getPool().query(
      `insert into observatory_events (id, source, scope, level, message, detail, url, user_addr, ua)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        source,
        scope.slice(0, 120),
        level,
        String(message).slice(0, 2000),
        detail ? JSON.stringify(detail) : null,
        ctx.url?.slice(0, 500) ?? null,
        ctx.userAddr?.slice(0, 100) ?? null,
        ctx.ua?.slice(0, 400) ?? null,
      ],
    );
  } catch (e) {
    // Storage is down or unreachable — do not lose the signal; put it where the operator can grep it.
    console.error(`[observatory:${scope}] ${message}`, {
      ref: id,
      detail,
      writeError: e instanceof Error ? e.message : String(e),
    });
  }
  return id;
}

/**
 * Convenience wrapper for the common case: report a caught error object and return its reference id.
 * Captures the message, name, and (clipped) stack. Extra context can be merged via `ctx.detail`.
 */
export async function reportError(
  scope: string,
  error: unknown,
  ctx: ReportContext = {},
): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  const detail: Record<string, unknown> = { ...(ctx.detail ?? {}) };
  if (error instanceof Error) {
    detail.name = error.name;
    if (error.stack) detail.stack = error.stack;
    // viem/pg errors often carry a `cause`; keep its message.
    const cause = (error as { cause?: unknown }).cause;
    if (cause) detail.cause = cause instanceof Error ? cause.message : String(cause);
  }
  return reportEvent(scope, message, { ...ctx, detail, level: ctx.level ?? "error" });
}

/** Read recent events, newest first. Used by GET /api/observatory (token-guarded). */
export async function listEvents(opts: {
  limit?: number;
  scope?: string;
  level?: ObservatoryLevel;
  since?: string;
} = {}): Promise<ObservatoryEvent[]> {
  await ensureTable();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.scope) {
    params.push(`${opts.scope}%`);
    where.push(`scope like $${params.length}`);
  }
  if (opts.level) {
    params.push(opts.level);
    where.push(`level = $${params.length}`);
  }
  if (opts.since) {
    params.push(opts.since);
    where.push(`ts >= $${params.length}`);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
  params.push(limit);
  const sql =
    `select id, ts, source, scope, level, message, detail, url, user_addr, ua ` +
    `from observatory_events ${where.length ? `where ${where.join(" and ")}` : ""} ` +
    `order by ts desc limit $${params.length}`;
  const res = await getPool().query<ObservatoryEvent>(sql, params);
  return res.rows;
}
