// Milestone 2 — the SOCIALS MCP server (PLAN.md section 6b, BUILD.md M2.1, CONTEXT: Reasoning feed).
//
// A real Model Context Protocol stdio server the agent loop spawns as a tool provider. It gives the
// agent two ways to speak, exactly the two layers PLAN.md 6b defines:
//
//   1. write_reasoning_feed  — the SITE community feed (ALWAYS ON). Every agent has this from launch.
//      The loop writes its thinking and each decision here (kind = thought | trade | distribution),
//      linked to the on-chain trade. This costs us only our own hosting. Maps to the `feed` table in
//      SPEC.md section 7: (agent_id, ts, kind, text, tx_hash, meta).
//
//   2. post_to_x            — X (VIRAL, OPT-IN, THE CREATOR PAYS). Posts to the agent's OWN handle
//      via the creator-connected X account. Per PLAN.md 6b + BUILD.md cost model, the creator brings
//      their OWN X API keys and pays X themselves; we only build the wiring. So the X keys are NOT a
//      platform secret and are NEVER read from the platform `.env`. They are read from a PER-AGENT
//      config (a file the creator connected, or an inline JSON), and the server refuses to post if
//      the creator has not connected X (opt-in). We support OAuth 2.0 user-context (bearer + refresh)
//      and OAuth 1.0a user-context (HMAC-SHA1), whichever the creator supplied.
//
// This is the "socials" MCP server named in PLAN section 4 (Brain layer) and BUILD.md M2.1. The
// on-chain-actions and market-data MCP servers are separate files (other builders).
//
// ── The per-agent config (creator-supplied X keys live here, not in .env) ─────────────────────────
// Point the server at a per-agent config with `--config=<path>` or the SOCIALS_CONFIG env var (a JSON
// file), or pass it inline via SOCIALS_CONFIG_JSON. Shape (all fields optional; X is opt-in):
//
//   {
//     "agentId": "agent_123",
//     "x": {
//       "enabled": true,
//       "dryRun": false,                     // true = build the request but do not hit X (safe test)
//       "auth": "oauth2",                    // "oauth2" (default) | "oauth1a"; inferred from the keys present
//       // -- OAuth 2.0 user context (tweet.write scope). accessToken is required; the rest enable refresh --
//       "accessToken": "...", "refreshToken": "...", "clientId": "...", "clientSecret": "...",
//       // -- OR OAuth 1.0a user context (all four required) --
//       "apiKey": "...", "apiSecret": "...", "accessToken": "...", "accessSecret": "..."
//     },
//     "feed": {
//       "url": "https://agentpad.example/api/agents/agent_123/feed",  // our site backend (M3); if absent, JSONL fallback
//       "token": "...",                                               // bearer for our own backend
//       "file": "agent/.data/feed-agent_123.jsonl"                    // fallback sink until the backend exists
//     }
//   }
//
// Env fallbacks (handy for a single-agent dev run): AGENT_ID, REASONING_FEED_URL, REASONING_FEED_TOKEN,
// X_ACCESS_TOKEN / X_REFRESH_TOKEN / X_CLIENT_ID / X_CLIENT_SECRET (oauth2), or
// X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET (oauth1a). The per-agent config wins.
//
// ── Run ───────────────────────────────────────────────────────────────────────────────────────────
//   As an MCP stdio server (the loop spawns it):
//     SOCIALS_CONFIG=agent/.data/agent_123.json node agent/mcp/socials.mjs
//   The agent loop connects a Client over stdio and calls the two tools. No SDK types leak out of here.
//
// New dependency (returned to the orchestrator, NOT added to package.json here): @modelcontextprotocol/sdk.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const X_API_BASE = "https://api.twitter.com"; // api.x.com is the alias; /2/tweets is the endpoint.
const FEED_KINDS = ["thought", "trade", "distribution"]; // SPEC.md section 7 `feed.kind`.

// Log to STDERR only. STDOUT is the MCP JSON-RPC channel and must stay clean.
const log = (...a) => console.error("[socials]", ...a);

// --- tiny dependency-free .env loader (does not override already-set env), mirrors account.mjs ---
function autoloadEnv() {
  for (const p of [path.join(__dirname, "..", "..", ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
}

// ── Config loading ─────────────────────────────────────────────────────────────────────────────
// Per-agent config first (file path or inline JSON), then env fallbacks. Never invents X keys.
function loadConfig(args) {
  let cfg = {};
  let configPath;

  const inline = process.env.SOCIALS_CONFIG_JSON;
  const fromFile = args.config || process.env.SOCIALS_CONFIG;
  if (fromFile) {
    configPath = path.isAbsolute(fromFile) ? fromFile : path.resolve(process.cwd(), fromFile);
    if (!fs.existsSync(configPath)) throw new Error(`config file not found: ${configPath}`);
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } else if (inline) {
    cfg = JSON.parse(inline);
  }

  cfg.agentId = cfg.agentId || process.env.AGENT_ID || "unknown-agent";

  // X: per-agent creator-supplied keys only. Env fallbacks are a dev convenience for a single agent.
  const x = cfg.x || {};
  x.accessToken = x.accessToken ?? process.env.X_ACCESS_TOKEN;
  x.refreshToken = x.refreshToken ?? process.env.X_REFRESH_TOKEN;
  x.clientId = x.clientId ?? process.env.X_CLIENT_ID;
  x.clientSecret = x.clientSecret ?? process.env.X_CLIENT_SECRET;
  x.apiKey = x.apiKey ?? process.env.X_API_KEY;
  x.apiSecret = x.apiSecret ?? process.env.X_API_SECRET;
  x.accessSecret = x.accessSecret ?? process.env.X_ACCESS_SECRET;
  if (x.dryRun === undefined) x.dryRun = process.env.SOCIALS_DRY_RUN === "1";
  // Infer the auth flavor from the keys the creator actually supplied.
  if (!x.auth) x.auth = x.apiKey && x.apiSecret && x.accessSecret ? "oauth1a" : "oauth2";
  // X is opt-in: only "connected" when explicitly enabled AND the needed keys are present.
  const hasOauth1a = x.apiKey && x.apiSecret && x.accessToken && x.accessSecret;
  const hasOauth2 = !!x.accessToken;
  x.connected = x.enabled !== false && ((x.auth === "oauth1a" && hasOauth1a) || (x.auth === "oauth2" && hasOauth2));
  cfg.x = x;

  const feed = cfg.feed || {};
  feed.url = feed.url ?? process.env.REASONING_FEED_URL;
  feed.token = feed.token ?? process.env.REASONING_FEED_TOKEN;
  // JSONL fallback sink (used until the M3 backend exists); resolved relative to the agent dir.
  feed.file = feed.file ?? process.env.REASONING_FEED_FILE ?? path.join(__dirname, "..", ".data", `feed-${cfg.agentId}.jsonl`);
  cfg.feed = feed;

  cfg.__configPath = configPath;
  return cfg;
}

// ── OAuth 1.0a user-context signing (HMAC-SHA1). Self-contained; no browser redirect needed. ─────
// For POST /2/tweets the JSON body is NOT part of the signature base string (OAuth 1.0a signs only
// query params + the oauth_* params for a JSON body), which is the correct, interoperable behavior.
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauth1aHeader(method, url, creds) {
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(oauth)
    .map((k) => [rfc3986(k), rfc3986(oauth[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${rfc3986(url)}&${rfc3986(paramString)}`;
  const signingKey = `${rfc3986(creds.apiSecret)}&${rfc3986(creds.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`)
      .join(", ")
  );
}

// ── OAuth 2.0 user-context refresh (grant_type=refresh_token). Persists the rotated tokens back to
//    the per-agent config file when we loaded from one, so the next run reuses them. ───────────────
async function refreshOauth2(cfg) {
  const x = cfg.x;
  if (!x.refreshToken || !x.clientId) throw new Error("X token expired and no refresh credentials (refreshToken + clientId) are configured");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: x.refreshToken, client_id: x.clientId });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  // Confidential clients authenticate with HTTP Basic; public (PKCE) clients send only client_id.
  if (x.clientSecret) headers.authorization = "Basic " + Buffer.from(`${x.clientId}:${x.clientSecret}`).toString("base64");
  const r = await fetch(`${X_API_BASE}/2/oauth2/token`, { method: "POST", headers, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`X token refresh failed (HTTP ${r.status}): ${JSON.stringify(j)}`);
  x.accessToken = j.access_token;
  if (j.refresh_token) x.refreshToken = j.refresh_token;
  persistTokens(cfg);
  log("refreshed the X OAuth 2.0 access token");
}

function persistTokens(cfg) {
  if (!cfg.__configPath) return; // inline/env config: nothing to write back to.
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.__configPath, "utf8"));
    raw.x = raw.x || {};
    raw.x.accessToken = cfg.x.accessToken;
    raw.x.refreshToken = cfg.x.refreshToken;
    fs.writeFileSync(cfg.__configPath, JSON.stringify(raw, null, 2));
  } catch (e) {
    log("could not persist refreshed X tokens:", e.message);
  }
}

// ── The X post call (real) ───────────────────────────────────────────────────────────────────────
async function xTweetRequest(cfg, text, replyToId) {
  const x = cfg.x;
  const url = `${X_API_BASE}/2/tweets`;
  const payload = { text };
  if (replyToId) payload.reply = { in_reply_to_tweet_id: String(replyToId) };
  const bodyStr = JSON.stringify(payload);

  const headers = { "content-type": "application/json" };
  if (x.auth === "oauth1a") headers.authorization = oauth1aHeader("POST", url, x);
  else headers.authorization = `Bearer ${x.accessToken}`;

  if (x.dryRun) {
    log("dry-run: would POST /2/tweets", bodyStr);
    return { dryRun: true, wouldPost: payload };
  }
  return fetch(url, { method: "POST", headers, body: bodyStr });
}

async function postToX(cfg, { text, reply_to_tweet_id }) {
  const x = cfg.x;
  if (!x.connected) {
    // Opt-in: not an error, just not connected. The site feed remains the always-on voice (PLAN 6b).
    return { posted: false, reason: "X is not connected for this agent (opt-in; the creator brings their own X keys)" };
  }
  if (!text || !text.trim()) throw new Error("text is required");
  if (text.length > 280) log(`warning: text is ${text.length} chars; standard X posts cap at 280 (verified accounts allow more)`);

  let res = await xTweetRequest(cfg, text, reply_to_tweet_id);
  if (res && res.dryRun) return { posted: false, dryRun: true, wouldPost: res.wouldPost };

  // OAuth 2.0: one transparent refresh-and-retry on an expired token.
  if (res.status === 401 && x.auth === "oauth2") {
    await refreshOauth2(cfg);
    res = await xTweetRequest(cfg, text, reply_to_tweet_id);
  }

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X post failed (HTTP ${res.status}): ${JSON.stringify(j)}`);
  const id = j?.data?.id;
  return { posted: true, tweet_id: id, url: id ? `https://x.com/i/web/status/${id}` : undefined };
}

// ── The reasoning-feed write (site community feed, always on) ─────────────────────────────────────
// Posts to our site backend if configured (SPEC.md `feed` table); otherwise appends JSONL to a local
// sink so the always-on layer works before the M3 backend exists. Either way it returns the entry.
async function writeReasoningFeed(cfg, { kind, text, tx_hash, meta }) {
  if (!FEED_KINDS.includes(kind)) throw new Error(`kind must be one of: ${FEED_KINDS.join(", ")}`);
  if (!text || !text.trim()) throw new Error("text is required");
  const entry = {
    agent_id: cfg.agentId,
    ts: new Date().toISOString(),
    kind,
    text,
    tx_hash: tx_hash || null,
    meta: meta || null,
  };

  if (cfg.feed.url) {
    const headers = { "content-type": "application/json" };
    if (cfg.feed.token) headers.authorization = `Bearer ${cfg.feed.token}`;
    const r = await fetch(cfg.feed.url, { method: "POST", headers, body: JSON.stringify(entry) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`reasoning-feed write failed (HTTP ${r.status}): ${JSON.stringify(j)}`);
    return { written: true, sink: "backend", id: j.id ?? null, entry };
  }

  // Fallback sink: append one JSON line. Keeps the always-on feed working pre-backend.
  fs.mkdirSync(path.dirname(cfg.feed.file), { recursive: true });
  fs.appendFileSync(cfg.feed.file, JSON.stringify(entry) + "\n");
  return { written: true, sink: "jsonl", file: cfg.feed.file, entry };
}

// ── MCP tool definitions (raw JSON Schema — matches the MCP-shaped tools in agent/agent.mjs) ─────
const TOOLS = [
  {
    name: "write_reasoning_feed",
    description:
      "Write one entry to the agent's SITE reasoning feed (always on, holder-visible). Use this for " +
      "every thought and every decision: why you are buying, what you read, what you skipped. Link a " +
      "trade to its on-chain transaction via tx_hash. This is the agent's default voice.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: FEED_KINDS, description: "thought (reasoning), trade (an executed swap), or distribution (a payout)" },
        text: { type: "string", description: "the reasoning or narration, in the agent's voice" },
        tx_hash: { type: "string", description: "the on-chain tx hash this entry links to (for trade/distribution)" },
        meta: { type: "object", description: "optional structured detail (asset, amount, price, feed freshness)", additionalProperties: true },
      },
      required: ["kind", "text"],
    },
  },
  {
    name: "post_to_x",
    description:
      "Post to the agent's OWN X (Twitter) handle, if the creator connected X (opt-in, creator-funded). " +
      "Use sparingly for viral, high-signal moments, not routine narration (that goes to the reasoning " +
      "feed). Returns {posted:false} without error when X is not connected.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the post text (standard accounts cap at 280 characters)" },
        reply_to_tweet_id: { type: "string", description: "optional: reply to this tweet id to build a thread" },
      },
      required: ["text"],
    },
  },
];

async function callTool(cfg, name, args) {
  if (name === "write_reasoning_feed") return writeReasoningFeed(cfg, args);
  if (name === "post_to_x") return postToX(cfg, args);
  throw new Error(`unknown tool: ${name}`);
}

async function main() {
  autoloadEnv();
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args);
  log(`agent=${cfg.agentId} X=${cfg.x.connected ? `connected (${cfg.x.auth}${cfg.x.dryRun ? ", dry-run" : ""})` : "not connected"} feed=${cfg.feed.url ? "backend" : "jsonl"}`);

  const server = new Server({ name: "agentpad-socials", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(cfg, name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      log(`tool ${name} failed:`, e.message);
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP socials server listening on stdio");
}

main().catch((e) => {
  log("FATAL:", e.message);
  process.exit(1);
});
