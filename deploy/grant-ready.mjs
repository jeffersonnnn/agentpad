// deploy/grant-ready.mjs — lazy auto-grant (pm2 cron).
//
// For every live agent that (a) has no valid session key yet and (b) has enough ETH in its account to
// pay the grant's own gas, install a scoped session key so the agent can trade. Gas for the account
// comes from the creator (the Fund & manage top-up box) or, later, from its own fees — never the
// platform. Once granted, the reasoner (reason-all) runs the agent in TRADE mode instead of reason-only.
//
// Re-grants before the 24h key TTL expires. Idempotent + safe to re-run: it grants only funded agents
// whose key is missing or near expiry, and grantAgentSession verifies the derived account matches the
// recorded one before spending anything.
//
// pm2: agentpad-grant (cron). Manual: node deploy/grant-ready.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const require = createRequire(path.join(REPO, "api", "package.json"));
const { Pool } = require("pg");

const REGRANT_BUFFER_S = 3600; // re-grant when < 1h of key life remains

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

// Does the agent already hold a session key with comfortable life left?
function hasValidKey(agentId) {
  const f = path.join(REPO, "agent", ".secrets", `session-${agentId}.json`);
  if (!fs.existsSync(f)) return false;
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!s.approval || !s.sessionKey) return false;
    const now = Math.floor(Date.now() / 1000);
    return typeof s.validUntil === "number" ? s.validUntil - now > REGRANT_BUFFER_S : true;
  } catch {
    return false;
  }
}

async function main() {
  autoloadEnv();
  const conn = process.env.DATABASE_URL;
  if (!conn) { console.error("grant-ready: DATABASE_URL not set"); process.exit(1); }
  if (!process.env.DEPLOYER_KEY) { console.error("grant-ready: DEPLOYER_KEY not set"); process.exit(1); }

  const pool = new Pool({
    connectionString: conn,
    ssl: /neon\.tech|sslmode=require/i.test(conn) ? { rejectUnauthorized: false } : undefined,
    max: 2,
  });
  let rows;
  try {
    const res = await pool.query(
      `SELECT id, archetype FROM agents
        WHERE status IN ('live','sleeping') AND account_addr IS NOT NULL AND paused IS NOT TRUE
        ORDER BY created_at ASC`,
    );
    rows = res.rows;
  } finally {
    await pool.end().catch(() => {});
  }

  const stamp = new Date().toISOString();
  const pending = rows.filter((r) => !hasValidKey(r.id));
  if (!pending.length) { console.log(`[${stamp}] grant-ready: ${rows.length} live, all keyed — nothing to do`); return; }

  // Load the grant from api/launch.mjs as a native ESM module (its own node_modules resolve its deps).
  const mod = await import(pathToFileURL(path.join(REPO, "api", "launch.mjs")).href);
  console.log(`[${stamp}] grant-ready: ${pending.length} agent(s) need a key`);
  for (const row of pending) {
    try {
      const r = await mod.grantAgentSession({ agentId: row.id });
      if (r.granted) console.log(`  ${row.id} (${row.archetype}) GRANTED key=${r.sessionKeyAddress} deployed=${r.deployed}`);
      else console.log(`  ${row.id} (${row.archetype}) skip: ${r.reason}${r.balanceWei ? ` (bal=${r.balanceWei} wei)` : ""}`);
    } catch (e) {
      console.log(`  ${row.id} ERROR ${e.message}`);
    }
  }
  console.log(`[${new Date().toISOString()}] grant-ready: done`);
}

main().catch((e) => { console.error("grant-ready FAILED:", e.message); process.exit(1); });
