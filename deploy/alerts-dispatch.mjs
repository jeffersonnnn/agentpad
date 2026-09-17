// deploy/alerts-dispatch.mjs — Follow + Alerts dispatcher (pm2 cron).
//
// The OUTBOX pattern. Trades and distributions are ALREADY written to the durable `feed` table
// (agent/loop.mjs writes kind='trade'; api/keeper.mjs writes kind='distribution'). Rather than couple
// alert delivery into the trading loop or the keeper (a failing webhook must NEVER touch a trade), this
// cron polls `feed` past a watermark (alert_cursor) and fans out one alert per (follower, event):
//   1. an in-app notification row (durable, idempotent via UNIQUE(recipient, feed_id)), and
//   2. best-effort external channels the follower opted into (email via Resend, Telegram via Bot API).
//
// Semantics: forward-only. On the very first run the cursor is seeded to the current MAX(feed.id), so a
// follow added later is alerted on FUTURE events only (no backfill of history). Safe to re-run: the
// unique key dedupes in-app rows, and external sends fire only for a NEWLY inserted notification, so a
// re-run never double-emails. Never throws into the schedule; failures are logged and the cursor still
// advances past drained events.
//
// pm2:  agentpad-alerts (cron_restart every couple of minutes).  Manual: node deploy/alerts-dispatch.mjs
// Test: node deploy/alerts-dispatch.mjs --once   (identical; --once is accepted for symmetry with keeper)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const require = createRequire(path.join(REPO, "api", "package.json")); // resolve pg from api/node_modules
const { Pool } = require("pg");

const DEFAULT_BASE_URL = process.env.PUBLIC_BASE_URL || "https://sling.bagspay.fun";

// tiny .env loader (does not override already-set env), mirrors reason-all.mjs / api/launch.mjs
function autoloadEnv() {
  for (const p of [path.join(REPO, ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

// ── table DDL (identical to api/db/schema.sql; self-creating so there is no migration step on the box) ─
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

export async function ensureTables(pool) {
  await pool.query(DDL);
}

// ── notification text (pure; unit-tested) ──────────────────────────────────────────────────────────
function shortAddr(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "";
}
function titleCase(s) {
  return String(s || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function agentLabel(agentRow) {
  const arch = titleCase(agentRow.archetype);
  const base = arch ? `${arch} agent` : "Agent";
  return agentRow.token_addr ? `${base} (${shortAddr(agentRow.token_addr)})` : base;
}

/**
 * Build the alert payload for one feed event. agentRow: { id, token_addr, archetype }. feedRow:
 * { kind, text, tx_hash }. Returns { kind, title, body, url, tx_hash }. Pure — no I/O.
 */
export function buildNotification(agentRow, feedRow, baseUrl = DEFAULT_BASE_URL) {
  const label = agentLabel(agentRow);
  const title = feedRow.kind === "trade" ? "New trade" : "Profit distributed";
  const detail = String(feedRow.text || "").replace(/[—–]/g, "-").trim();
  const body = detail ? `${label}: ${detail}` : `${label} ${feedRow.kind === "trade" ? "made a trade" : "distributed profit"}.`;
  const target = agentRow.token_addr || agentRow.id;
  const base = String(baseUrl).replace(/\/$/, "");
  return {
    kind: feedRow.kind,
    title,
    body,
    url: target ? `${base}/agent/${target}` : null,
    tx_hash: feedRow.tx_hash || null,
  };
}

// ── external channels (best-effort; never throw; dry-run when unconfigured) ─────────────────────────
async function sendEmail(to, notif, { send, log }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM || "Slingshot <alerts@slingshotprotocol.online>";
  if (!send || !key) {
    log(`    email[dry-run]-> ${to}: ${notif.title}`);
    return { channel: "email", to, sent: false, dryRun: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Slingshot: ${notif.title}`,
        text: `${notif.body}\n\n${notif.url || ""}`.trim(),
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { channel: "email", to, sent: true };
  } catch (e) {
    log(`    email FAILED -> ${to}: ${e.message}`);
    return { channel: "email", to, sent: false, error: e.message };
  }
}

async function sendTelegram(chatId, notif, { send, log }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!send || !token) {
    log(`    telegram[dry-run]-> ${chatId}: ${notif.title}`);
    return { channel: "telegram", to: chatId, sent: false, dryRun: true };
  }
  try {
    const text = `*${notif.title}*\n${notif.body}${notif.url ? `\n${notif.url}` : ""}`;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: false }),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { channel: "telegram", to: chatId, sent: true };
  } catch (e) {
    log(`    telegram FAILED -> ${chatId}: ${e.message}`);
    return { channel: "telegram", to: chatId, sent: false, error: e.message };
  }
}

// ── one dispatch pass ────────────────────────────────────────────────────────────────────────────
export async function dispatchOnce(pool, opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const send = opts.send !== false; // default: attempt real sends (still dry-run when a channel is unconfigured)
  const log = opts.log || console.log;
  const BATCH = Number(process.env.ALERT_BATCH || 1000);

  await ensureTables(pool);

  // First run: seed the cursor to the current tip so we never backfill history. Do nothing else.
  const cur = await pool.query("SELECT last_feed_id FROM alert_cursor WHERE id = 1");
  if (!cur.rows.length) {
    const mx = await pool.query("SELECT COALESCE(MAX(id), 0)::bigint AS m FROM feed");
    const seed = String(mx.rows[0].m);
    await pool.query("INSERT INTO alert_cursor (id, last_feed_id) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [seed]);
    log(`alerts: seeded cursor to feed.id=${seed} (first run; no backfill)`);
    return { seeded: true, processed: 0, notifications: 0, cursor: seed };
  }
  const cursor = String(cur.rows[0].last_feed_id);

  // Candidate events since the cursor: trades and distributions, with their agent context.
  const events = (
    await pool.query(
      `SELECT f.id AS feed_id, f.agent_id, f.kind, f.text, f.tx_hash, a.token_addr, a.archetype
         FROM feed f JOIN agents a ON a.id = f.agent_id
        WHERE f.id > $1 AND f.kind IN ('trade','distribution')
        ORDER BY f.id ASC
        LIMIT $2`,
      [cursor, BATCH],
    )
  ).rows;

  let notifCount = 0;
  const deliveries = [];
  for (const ev of events) {
    const followers = (
      await pool.query(
        `SELECT follower, email, telegram FROM follows
          WHERE agent_id = $1 AND ${ev.kind === "trade" ? "on_trade" : "on_distribution"} = true`,
        [ev.agent_id],
      )
    ).rows;
    if (!followers.length) continue;

    const notif = buildNotification({ id: ev.agent_id, token_addr: ev.token_addr, archetype: ev.archetype }, ev, baseUrl);
    for (const f of followers) {
      // Insert the in-app row first (durable). RETURNING id is empty when it already existed, so we
      // only fire external channels for a genuinely NEW notification (re-runs never double-send).
      const ins = await pool.query(
        `INSERT INTO notifications (recipient, agent_id, feed_id, kind, title, body, url, tx_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (recipient, feed_id) DO NOTHING
         RETURNING id`,
        [f.follower, ev.agent_id, ev.feed_id, notif.kind, notif.title, notif.body, notif.url, notif.tx_hash],
      );
      if (!ins.rows.length) continue; // already delivered on an earlier run
      notifCount++;
      if (f.email) deliveries.push(await sendEmail(f.email, notif, { send, log }));
      if (f.telegram) deliveries.push(await sendTelegram(f.telegram, notif, { send, log }));
    }
  }

  // Advance the cursor. If we saturated the batch there may be more trade/distribution rows pending, so
  // only advance to the last event we processed; otherwise jump to the current tip (thoughts are never
  // alerted, so skipping past them is correct and keeps the next scan window small).
  let newCursor = cursor;
  if (events.length === BATCH) {
    newCursor = String(events[events.length - 1].feed_id);
  } else {
    const tip = await pool.query("SELECT COALESCE(MAX(id), $1)::bigint AS m FROM feed WHERE id > $1", [cursor]);
    newCursor = String(tip.rows[0].m);
  }
  if (BigInt(newCursor) > BigInt(cursor)) {
    await pool.query("UPDATE alert_cursor SET last_feed_id = $1 WHERE id = 1", [newCursor]);
  }

  return { seeded: false, processed: events.length, notifications: notifCount, deliveries, cursor: newCursor };
}

// ── CLI entry ───────────────────────────────────────────────────────────────────────────────────
async function main() {
  autoloadEnv();
  const conn = process.env.DATABASE_URL;
  if (!conn) { console.error("alerts-dispatch: DATABASE_URL not set"); process.exit(1); }
  const pool = new Pool({
    connectionString: conn,
    ssl: /neon\.tech|sslmode=require/i.test(conn) ? { rejectUnauthorized: false } : undefined,
    max: 2,
  });
  const stamp = new Date().toISOString();
  try {
    const r = await dispatchOnce(pool, { baseUrl: DEFAULT_BASE_URL });
    if (r.seeded) console.log(`[${stamp}] alerts: ${r.cursor} seeded`);
    else console.log(`[${stamp}] alerts: scanned ${r.processed} event(s), delivered ${r.notifications} notification(s), cursor=${r.cursor}`);
  } catch (e) {
    console.error(`[${stamp}] alerts-dispatch FAILED:`, e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

// Run as a script, but stay importable for tests (buildNotification / dispatchOnce / ensureTables).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
