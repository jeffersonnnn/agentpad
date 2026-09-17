// Unit smoke test for the alert payload builder (deploy/alerts-dispatch.mjs buildNotification).
// Pure, no DB, no network. Run:  node deploy/test/alerts.test.mjs
//
// This guards the text/url/tx shape a follower actually receives, from the canonical trade and
// distribution feed meta shapes (agent/loop.mjs:988 and api/keeper.mjs:617).

import assert from "node:assert/strict";
import { buildNotification } from "../alerts-dispatch.mjs";

const BASE = "https://sling.bagspay.fun";
const AGENT = {
  id: "51363ef5-22f6-4c16-965d-da5ed6259ef8",
  token_addr: "0x5c85981115e4fe487FeFdbF9eD93201E827AB88f",
  archetype: "macro",
};

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// 1. A trade event → "New trade", agent label + feed text, address deep link, tx passed through.
{
  const feed = {
    kind: "trade",
    text: "Swapped 50 USDG -> 49.8 SGOV (min_out 47.3, ~50.00 USDG notional, price 1.004 USDG/SGOV).",
    tx_hash: "0xabc",
  };
  const n = buildNotification(AGENT, feed, BASE);
  assert.equal(n.kind, "trade");
  assert.equal(n.title, "New trade");
  assert.ok(n.body.startsWith("Macro agent (0x5c85…B88f):"), `label prefix, got: ${n.body}`);
  assert.ok(n.body.includes("Swapped 50 USDG"), "keeps the feed text");
  assert.equal(n.url, `${BASE}/agent/${AGENT.token_addr}`);
  assert.equal(n.tx_hash, "0xabc");
  ok("trade payload");
}

// 2. A distribution event → "Profit distributed".
{
  const feed = { kind: "distribution", text: "Distributed 12.50 USDG to 3 holders (epoch 1).", tx_hash: "0xdef" };
  const n = buildNotification(AGENT, feed, BASE);
  assert.equal(n.kind, "distribution");
  assert.equal(n.title, "Profit distributed");
  assert.ok(n.body.includes("Distributed 12.50 USDG"), "keeps the feed text");
  assert.equal(n.tx_hash, "0xdef");
  ok("distribution payload");
}

// 3. Em dashes are normalized to hyphens (house style; no em dashes in any user-facing text).
{
  const n = buildNotification(AGENT, { kind: "trade", text: "Bought SGOV — a treasury proxy — at open." }, BASE);
  assert.ok(!/[—–]/.test(n.body), `no em/en dashes, got: ${n.body}`);
  ok("em-dash normalization");
}

// 4. No token address yet → the deep link falls back to the agent UUID.
{
  const n = buildNotification({ id: "uuid-1", token_addr: null, archetype: "tech-bull" }, { kind: "trade", text: "x" }, BASE);
  assert.equal(n.url, `${BASE}/agent/uuid-1`);
  assert.ok(n.body.startsWith("Tech Bull agent:"), `titlecased label, got: ${n.body}`);
  ok("no-token fallback + label titlecase");
}

// 5. Empty feed text → a sensible default body, no dangling colon.
{
  const n = buildNotification(AGENT, { kind: "distribution", text: "", tx_hash: null }, BASE);
  assert.ok(n.body.endsWith("distributed profit."), `default body, got: ${n.body}`);
  assert.equal(n.tx_hash, null);
  ok("empty-text default body");
}

console.log(`\nalerts unit smoke: ${passed} checks passed`);
