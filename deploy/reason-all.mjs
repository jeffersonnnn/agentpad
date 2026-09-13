// deploy/reason-all.mjs — the reliable reasoner (pm2 cron).
//
// One pass per run: read every live agent from the database and run a SINGLE reasoning pass for each by
// spawning agent/loop.mjs with that agent's env. Reasoning needs only OPENROUTER_KEY + AGENT_ID + the
// MCP servers (loop.mjs main), so an agent reasons even with NO session key — it just cannot trade
// ("reason-only") until a key is granted. If agent/.secrets/session-<id>.json exists, its approval +
// sessionKey are passed so that agent can also trade.
//
// Why this instead of the per-launch spawn: finalize's defaultStartLoop threw when the session key was
// absent, so freshly launched agents never reasoned. This cron reads the DB fresh each cycle, so it
// picks up new agents automatically, restarts cleanly under pm2, and survives reboots. Runs the agents
// sequentially to bound memory on a small box.
//
// pm2:  agentpad-reasoner (cron_restart every few minutes). Manual: node deploy/reason-all.mjs

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const require = createRequire(path.join(REPO, "api", "package.json")); // resolve pg from api/node_modules
const { Pool } = require("pg");

const LOOP = path.join(REPO, "agent", "loop.mjs");
const MCP_DIR = path.join(REPO, "agent", "mcp");
const PER_AGENT_TIMEOUT_MS = Number(process.env.REASONER_TIMEOUT_MS || 150000); // kill a stuck pass

// tiny .env loader (does not override already-set env), mirrors api/launch.mjs autoloadEnv
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

function mcpServers() {
  return [
    { name: "chain", command: process.execPath, args: [path.join(MCP_DIR, "chain.mjs")] },
    { name: "market", command: process.execPath, args: [path.join(MCP_DIR, "market.mjs")] },
    { name: "socials", command: process.execPath, args: [path.join(MCP_DIR, "socials.mjs")] },
  ];
}

function envForAgent(row) {
  const env = {
    ...process.env,
    AGENT_ID: row.id,
    AGENT_ARCHETYPE: row.archetype || "tech-bull",
    AGENT_MCP_SERVERS: JSON.stringify(mcpServers()),
    AGENT_LOOP_INTERVAL: "0", // single pass; the cron cadence controls frequency
  };
  if (row.model) env.AGENT_MODEL = row.model;
  if (row.persona_prompt) env.AGENT_PERSONA = row.persona_prompt;
  if (row.account_addr) env.AGENT_ACCOUNT = row.account_addr;
  if (row.splitter_addr) env.FEE_SPLITTER = row.splitter_addr;

  // Optional per-agent session key (enables trading; absent = reason-only).
  const sf = path.join(REPO, "agent", ".secrets", `session-${row.id}.json`);
  if (fs.existsSync(sf)) {
    try {
      const s = JSON.parse(fs.readFileSync(sf, "utf8"));
      if (s.approval) env.AGENT_SESSION_APPROVAL = s.approval;
      if (s.sessionKey) env.AGENT_SESSION_KEY = s.sessionKey;
    } catch { /* ignore a malformed session file — fall back to reason-only */ }
  }

  // Optional per-agent X keys (socials MCP), same path the web X-connect flow writes.
  const socials = path.join(REPO, "agent", ".secrets", `socials-${row.id}.json`);
  if (fs.existsSync(socials)) env.SOCIALS_CONFIG = socials;
  return env;
}

function runOnce(row) {
  return new Promise((resolve) => {
    const env = envForAgent(row);
    const canTrade = Boolean(env.AGENT_SESSION_KEY);
    const child = spawn(process.execPath, [LOOP], { env, stdio: "ignore" });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, PER_AGENT_TIMEOUT_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ id: row.id, archetype: row.archetype, canTrade, code, signal });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ id: row.id, error: e.message });
    });
  });
}

async function main() {
  autoloadEnv();
  if (!process.env.OPENROUTER_KEY) { console.error("reason-all: OPENROUTER_KEY not set"); process.exit(1); }
  const conn = process.env.DATABASE_URL;
  if (!conn) { console.error("reason-all: DATABASE_URL not set"); process.exit(1); }

  const pool = new Pool({
    connectionString: conn,
    ssl: /neon\.tech|sslmode=require/i.test(conn) ? { rejectUnauthorized: false } : undefined,
    max: 2,
  });

  let rows;
  try {
    const res = await pool.query(
      `SELECT id, archetype, persona_prompt, model, account_addr, splitter_addr
         FROM agents
        WHERE status IN ('live','sleeping') AND account_addr IS NOT NULL
        ORDER BY created_at ASC`,
    );
    rows = res.rows;
  } finally {
    await pool.end().catch(() => {});
  }

  const stamp = new Date().toISOString();
  if (!rows.length) { console.log(`[${stamp}] reason-all: no live agents — nothing to do`); return; }

  console.log(`[${stamp}] reason-all: ${rows.length} live agent(s)`);
  for (const row of rows) {
    const t0 = Date.now();
    const r = await runOnce(row); // sequential to bound memory
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.error) console.log(`  ${row.id} ERROR ${r.error}`);
    else console.log(`  ${row.id} (${r.archetype}) ${r.canTrade ? "trade" : "reason-only"} exit=${r.signal || r.code} ${secs}s`);
  }
  console.log(`[${new Date().toISOString()}] reason-all: done`);
}

main().catch((e) => { console.error("reason-all FAILED:", e.message); process.exit(1); });
