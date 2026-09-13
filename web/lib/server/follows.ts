// SERVER-ONLY. Follow + Alerts data layer (roadmap item 3). A follow ties a wallet to an agent and its
// opt-in alert channels; the in-app inbox (notifications) is filled by the outbox dispatcher
// (deploy/alerts-dispatch.mjs), which reads the durable `feed` table. This module is the READ/WRITE
// surface the Next.js route handlers use: follow state, follow upsert/remove, and the notification list.
//
// Tables are created on first use (CREATE TABLE IF NOT EXISTS), identical to api/db/schema.sql and the
// dispatcher's DDL, so there is no separate migration step on the box. Addresses are stored lowercase;
// the route validates the format (viem isAddress) before calling in.

import { getPool } from "./db";

export interface FollowRow {
  agent_id: string;
  follower: string;
  email: string | null;
  telegram: string | null;
  on_trade: boolean;
  on_distribution: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  recipient: string;
  agent_id: string;
  feed_id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  tx_hash: string | null;
  created_at: string;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS follows (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    follower        text NOT NULL,
    email           text,
    telegram        text,
    on_trade        boolean NOT NULL DEFAULT true,
    on_distribution boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, follower)
  );
  CREATE INDEX IF NOT EXISTS follows_agent_idx    ON follows (agent_id);
  CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows (follower);
  CREATE TABLE IF NOT EXISTS notifications (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient   text NOT NULL,
    agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    feed_id     bigint NOT NULL,
    kind        text NOT NULL,
    title       text NOT NULL,
    body        text NOT NULL,
    url         text,
    tx_hash     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recipient, feed_id)
  );
  CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient, id DESC);
  CREATE TABLE IF NOT EXISTS alert_cursor (
    id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_feed_id bigint NOT NULL DEFAULT 0
  );
`;

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (ensured) return ensured;
  ensured = getPool()
    .query(DDL)
    .then(() => undefined)
    .catch((e) => {
      ensured = null; // let a later call retry if the DDL failed (e.g. transient)
      throw e;
    });
  return ensured;
}

/** The follow row for (agent, follower), or null when the wallet does not follow the agent. */
export async function getFollow(agentId: string, follower: string): Promise<FollowRow | null> {
  await ensureTables();
  const res = await getPool().query<FollowRow>(
    `SELECT agent_id, follower, email, telegram, on_trade, on_distribution, created_at, updated_at
       FROM follows WHERE agent_id = $1 AND follower = $2`,
    [agentId, follower.toLowerCase()],
  );
  return res.rows[0] ?? null;
}

/** Follower count for an agent (shown on the agent page). */
export async function countFollowers(agentId: string): Promise<number> {
  await ensureTables();
  const res = await getPool().query<{ n: string }>("SELECT count(*)::text AS n FROM follows WHERE agent_id = $1", [agentId]);
  return Number(res.rows[0]?.n ?? 0);
}

/** Create or update a follow (idempotent on (agent, follower)). Empty email/telegram clear the channel. */
export async function upsertFollow(input: {
  agentId: string;
  follower: string;
  email?: string | null;
  telegram?: string | null;
  onTrade?: boolean;
  onDistribution?: boolean;
}): Promise<FollowRow> {
  await ensureTables();
  const res = await getPool().query<FollowRow>(
    `INSERT INTO follows (agent_id, follower, email, telegram, on_trade, on_distribution)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (agent_id, follower) DO UPDATE
       SET email           = EXCLUDED.email,
           telegram        = EXCLUDED.telegram,
           on_trade        = EXCLUDED.on_trade,
           on_distribution = EXCLUDED.on_distribution,
           updated_at      = now()
     RETURNING agent_id, follower, email, telegram, on_trade, on_distribution, created_at, updated_at`,
    [
      input.agentId,
      input.follower.toLowerCase(),
      input.email?.trim() || null,
      input.telegram?.trim() || null,
      input.onTrade ?? true,
      input.onDistribution ?? true,
    ],
  );
  return res.rows[0];
}

/** Remove a follow. Returns true when a row was deleted. */
export async function deleteFollow(agentId: string, follower: string): Promise<boolean> {
  await ensureTables();
  const res = await getPool().query("DELETE FROM follows WHERE agent_id = $1 AND follower = $2", [agentId, follower.toLowerCase()]);
  return (res.rowCount ?? 0) > 0;
}

/** Recent in-app notifications for a wallet, newest first. Content is public on-chain events. */
export async function listNotifications(recipient: string, limit = 50): Promise<NotificationRow[]> {
  await ensureTables();
  const capped = Math.min(200, Math.max(1, Math.floor(limit)));
  const res = await getPool().query<NotificationRow>(
    `SELECT id, recipient, agent_id, feed_id, kind, title, body, url, tx_hash, created_at
       FROM notifications WHERE recipient = $1 ORDER BY id DESC LIMIT $2`,
    [recipient.toLowerCase(), capped],
  );
  return res.rows;
}
