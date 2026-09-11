// Milestone 2 — the per-agent x402 pay-gate endpoint (CONTEXT.md "Service endpoint", BUILD.md M2.5).
//
// Every Agent earns by exposing its OWN x402-priced HTTP endpoint: a caller (a human or another
// agent) pays USDG per call to reach the agent's brain. This file grows the lite `x402Demo` in
// `agent/agent.mjs` into a real, reusable pay-gate:
//
//   - the 402 challenge (HTTP 402 + the x402 `accepts` PaymentRequirements),
//   - decode of the caller's `X-PAYMENT` header,
//   - verify + settle through a FACILITATOR chosen behind a small adapter (SPEC.md 10.2 is OPEN),
//   - serve the resource on success with an `X-PAYMENT-RESPONSE` receipt,
//   - treasury metering: a dry agent sleeps (BUILD.md M2.5) via a `canServe()` gate.
//
// ── The facilitator is OPEN (SPEC.md 10.2) ────────────────────────────────────────────────────────
// x402 verify/settle is delegated to a "facilitator". No PUBLIC facilitator supports Robinhood Chain
// 4663 today (Coinbase CDP / x402.org cover Base + a fixed set; thirdweb covers arbitrary EVM chains
// but needs their infra + secret). So the DEFAULT here is a SELF-HOSTED facilitator: we verify the
// EIP-3009 signature locally and settle by broadcasting `transferWithAuthorization` on 4663 through
// our own RPC with a relay key. A `remote` adapter is wired for the day a hosted 4663 facilitator
// exists. Both sit behind `createFacilitator(name)`, so the choice is a one-line/env change.
// See the file footer + the builder's open_questions for the recorded decision.
//
// ── Usage ─────────────────────────────────────────────────────────────────────────────────────────
//   Demo (zero funds, mock facilitator — proves the loop like agent.mjs did):
//     node --env-file=.env agent/x402.mjs                 # or: node agent/x402.mjs
//   Real self-hosted settlement on 4663 (needs a relay key that pays gas, and an EIP-3009 token):
//     X402_FACILITATOR=self X402_SETTLER_KEY=0x.. node --env-file=.env agent/x402.mjs --serve
//   Embed in the brain service:
//     import { createPayGate } from "./x402.mjs";
//     const gate = createPayGate({ payTo, priceUsdg: 0.1, resource: "/ask", serve: askHandler });
//     http.createServer(gate.handler).listen(8402);
//
// Env: X402_FACILITATOR (self|remote|mock, default mock), X402_FACILITATOR_URL (remote),
//      X402_SETTLER_KEY (self settle relay; falls back to DEPLOYER_KEY), X402_PAYER_KEY (demo client),
//      X402_NETWORK (default "eip155:4663"), ROBINHOOD_ALCHEMY_RPC.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config (FACTS.md / SPEC.md) ────────────────────────────────────────────────────────────────────
export const CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // 6 dec — base payment asset
export const USDG_DECIMALS = 6;
export const X402_VERSION = 1;
// Canonical network id. x402 is moving to CAIP-2; we default to eip155:<chainId>. Older demo prose
// used "robinhood-4663" — keep it configurable so a chosen facilitator's expected id can be matched.
export const DEFAULT_NETWORK = process.env.X402_NETWORK || `eip155:${CHAIN_ID}`;

// USDG EIP-712 domain for the EIP-3009 "exact" scheme. name/version are what the token's DOMAIN uses.
// VERIFIED on 4663 (2026-09-10, FACTS.md / SPEC.md 10.2): the live USDG token reports name()="Global
// Dollar" (NOT "USDG") and version() REVERTS (0x800ab12c). The true version was recovered as "1" by
// reconstructing the EIP-712 domain separator and matching the on-chain DOMAIN_SEPARATOR():
//   keccak256(abi.encode(EIP712Domain_typehash, keccak256("Global Dollar"), keccak256("1"), 4663, USDG))
//   == 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036  (the on-chain value).
// authorizationState(address,bytes32) responds, so EIP-3009 transferWithAuthorization is present.
// These MUST be the defaults or the self facilitator's locally-signed EIP-3009 authorizations will
// not match the token's real DOMAIN_SEPARATOR and a real self-settle fails signature verification.
// Override via X402_ASSET_NAME / X402_ASSET_VERSION only if the token is redeployed with a new domain.
export const USDG_EIP712 = {
  name: process.env.X402_ASSET_NAME || "Global Dollar",
  version: process.env.X402_ASSET_VERSION || "1",
};

// --- tiny dependency-free .env loader (mirrors account.mjs; does not override already-set env) ---
function autoloadEnv() {
  for (const p of [path.join(__dirname, "..", ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

// USDG whole -> smallest units (6 dec), no float error.
export function usdgToUnits(whole) {
  const [i, f = ""] = String(whole).split(".");
  const frac = (f + "0".repeat(USDG_DECIMALS)).slice(0, USDG_DECIMALS);
  return (BigInt(i || "0") * 10n ** BigInt(USDG_DECIMALS) + BigInt(frac || "0")).toString();
}
export function unitsToUsdg(units) {
  const b = BigInt(units), d = 10n ** BigInt(USDG_DECIMALS);
  return `${b / d}.${(b % d).toString().padStart(USDG_DECIMALS, "0")}`;
}
function chainIdOf(network) {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : CHAIN_ID;
}
const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const b64decode = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));

// ── The x402 challenge (PaymentRequirements) ────────────────────────────────────────────────────────
/**
 * Build one PaymentRequirements entry (the x402 "accepts" element) for the "exact" EVM scheme.
 * @param {object} o
 * @param {string} o.payTo        recipient address (the agent treasury) — where USDG lands.
 * @param {number|string} [o.priceUsdg=0.1]  price in whole USDG.
 * @param {string} [o.resource]   the resource path/URL the price buys.
 * @param {string} [o.description]
 * @param {string} [o.asset=USDG]
 * @param {string} [o.network]
 * @param {number} [o.maxTimeoutSeconds=120]
 */
export function buildPaymentRequirements(o) {
  const network = o.network || DEFAULT_NETWORK;
  const asset = o.asset || USDG;
  return {
    scheme: "exact",
    network,
    maxAmountRequired: usdgToUnits(o.priceUsdg ?? 0.1),
    resource: o.resource || "/",
    description: o.description || "one call to this agent",
    mimeType: o.mimeType || "application/json",
    payTo: o.payTo,
    maxTimeoutSeconds: o.maxTimeoutSeconds ?? 120,
    asset,
    // `extra` carries the EIP-712 domain the client must sign against (EIP-3009).
    extra: asset.toLowerCase() === USDG.toLowerCase() ? { ...USDG_EIP712 } : (o.extra || {}),
  };
}

/** Serialize an X-PAYMENT-RESPONSE receipt header value (base64 JSON). */
export function encodeSettlementReceipt(receipt) {
  return b64encode(receipt);
}
/** Decode a caller's X-PAYMENT header (base64 JSON PaymentPayload). Throws on malformed input. */
export function decodePaymentHeader(header) {
  if (!header) throw new Error("missing X-PAYMENT header");
  const p = b64decode(header);
  if (!p || typeof p !== "object") throw new Error("X-PAYMENT is not a JSON object");
  return p;
}

// ── Facilitator adapter seam (mirrors agent/lib/stack.mjs) ──────────────────────────────────────────
// Every facilitator implements: async supported(), async verify({paymentPayload, requirements}),
// async settle({paymentPayload, requirements}). verify -> {isValid, invalidReason?, payer?}.
// settle -> {success, transaction?, network, payer?, errorReason?}.

const FACILITATOR_ADAPTERS = {
  self: makeSelfFacilitator,
  remote: makeRemoteFacilitator,
  mock: makeMockFacilitator,
};
export const AVAILABLE_FACILITATORS = Object.keys(FACILITATOR_ADAPTERS);

/**
 * @param {"self"|"remote"|"mock"} [name]  default: X402_FACILITATOR or "mock".
 * @param {object} [deps] { rpcUrl, settlerKey, url }
 */
export function createFacilitator(name = process.env.X402_FACILITATOR || "mock", deps = {}) {
  const make = FACILITATOR_ADAPTERS[name];
  if (!make) throw new Error(`unknown facilitator "${name}". Valid: ${AVAILABLE_FACILITATORS.join(", ")}`);
  return make(deps);
}

// --- MOCK: no chain, no keys. Proves the request/response loop only (like the old x402Demo). ---
function makeMockFacilitator() {
  return {
    name: "mock",
    async supported() {
      return { kinds: [{ x402Version: X402_VERSION, scheme: "exact", network: DEFAULT_NETWORK }] };
    },
    async verify({ paymentPayload }) {
      const ok = paymentPayload?.payload?.mock === true;
      return ok
        ? { isValid: true, payer: paymentPayload?.payload?.from || "0xMOCK" }
        : { isValid: false, invalidReason: "mock facilitator requires payload.mock === true" };
    },
    async settle({ paymentPayload }) {
      return {
        success: true,
        transaction: "0x" + "de".repeat(32), // sentinel; NOT a real tx
        network: paymentPayload?.network || DEFAULT_NETWORK,
        payer: paymentPayload?.payload?.from || "0xMOCK",
        mock: true,
      };
    },
  };
}

// --- REMOTE: POST to a hosted facilitator's /verify and /settle (for a future 4663 facilitator). ---
function makeRemoteFacilitator({ url } = {}) {
  const base = (url || process.env.X402_FACILITATOR_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("remote facilitator needs X402_FACILITATOR_URL (or deps.url)");
  }
  const post = async (route, body) => {
    const r = await fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`facilitator ${route} HTTP ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
  return {
    name: "remote",
    baseUrl: base,
    async supported() {
      const r = await fetch(base + "/supported");
      return r.ok ? r.json() : { kinds: [] };
    },
    async verify({ paymentPayload, requirements }) {
      return post("/verify", { x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirements });
    },
    async settle({ paymentPayload, requirements }) {
      return post("/settle", { x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirements });
    },
  };
}

// --- SELF: we ARE the facilitator. Verify EIP-3009 signature locally; settle by broadcasting
//     transferWithAuthorization on 4663 with a relay key. Works on ANY chain incl. 4663.
//     Requires: the payment asset implements EIP-3009 (transferWithAuthorization). viem is lazily
//     imported so the challenge side of this file runs with no SDK installed. ---
const EIP3009_ABI = [
  // v2 (bytes signature) variant — matches USDC and the x402 "exact" scheme.
  {
    type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }, { name: "signature", type: "bytes" },
    ], outputs: [],
  },
  {
    type: "function", name: "authorizationState", stateMutability: "view",
    inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }],
  },
];

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

async function loadViem() {
  try {
    const viem = await import("viem");
    const accounts = await import("viem/accounts");
    return { ...viem, ...accounts };
  } catch (e) {
    throw new Error(`the "self" facilitator needs viem installed. Run: cd agent && npm install (${e.message})`);
  }
}

function makeSelfFacilitator({ rpcUrl, settlerKey } = {}) {
  const RPC = rpcUrl || process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
  const relayPk = settlerKey || process.env.X402_SETTLER_KEY || process.env.DEPLOYER_KEY;

  let _viem, _chain, _pub;
  const ensure = async () => {
    if (_viem) return;
    _viem = await loadViem();
    _chain = _viem.defineChain({
      id: CHAIN_ID, name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    });
    _pub = _viem.createPublicClient({ chain: _chain, transport: _viem.http(RPC) });
  };

  const readAuth = (paymentPayload) => {
    const a = paymentPayload?.payload?.authorization;
    const sig = paymentPayload?.payload?.signature;
    if (!a || !sig) throw new Error("payload must carry { authorization, signature } (exact scheme)");
    return { a, sig };
  };

  return {
    name: "self",
    rpcUrl: RPC,
    async supported() {
      return { kinds: [{ x402Version: X402_VERSION, scheme: "exact", network: DEFAULT_NETWORK }] };
    },
    async verify({ paymentPayload, requirements }) {
      await ensure();
      try {
        if (paymentPayload?.scheme !== "exact") return bad("unsupported scheme (need 'exact')");
        const { a, sig } = readAuth(paymentPayload);
        const asset = requirements.asset;
        const domain = { ...requirements.extra, chainId: chainIdOf(requirements.network), verifyingContract: asset };
        const message = {
          from: a.from, to: a.to, value: BigInt(a.value),
          validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce,
        };
        const recovered = await _viem.recoverTypedDataAddress({
          domain, types: TRANSFER_WITH_AUTH_TYPES, primaryType: "TransferWithAuthorization", message, signature: sig,
        });
        if (recovered.toLowerCase() !== String(a.from).toLowerCase()) return bad("signature does not match `from`");
        if (String(a.to).toLowerCase() !== String(requirements.payTo).toLowerCase()) return bad("payTo mismatch");
        if (BigInt(a.value) < BigInt(requirements.maxAmountRequired)) return bad("value below price");
        const now = Math.floor(Date.now() / 1000);
        if (now < Number(a.validAfter)) return bad("authorization not yet valid");
        if (now >= Number(a.validBefore)) return bad("authorization expired");

        // Best-effort on-chain checks (skip silently if the RPC read fails).
        try {
          const used = await _pub.readContract({ address: asset, abi: EIP3009_ABI, functionName: "authorizationState", args: [a.from, a.nonce] });
          if (used) return bad("authorization nonce already used");
          const bal = await _pub.readContract({ address: asset, abi: EIP3009_ABI, functionName: "balanceOf", args: [a.from] });
          if (bal < BigInt(a.value)) return bad("payer balance below value");
        } catch { /* RPC read optional at verify time */ }

        return { isValid: true, payer: a.from };
      } catch (e) {
        return bad(e.message);
      }
    },
    async settle({ paymentPayload, requirements }) {
      await ensure();
      if (!relayPk) {
        return { success: false, network: requirements.network, errorReason: "no settle relay key (X402_SETTLER_KEY / DEPLOYER_KEY)" };
      }
      try {
        const { a, sig } = readAuth(paymentPayload);
        const relay = _viem.privateKeyToAccount(relayPk.startsWith("0x") ? relayPk : "0x" + relayPk);
        const wallet = _viem.createWalletClient({ account: relay, chain: _chain, transport: _viem.http(RPC) });
        const hash = await wallet.writeContract({
          address: requirements.asset, abi: EIP3009_ABI, functionName: "transferWithAuthorization",
          args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sig],
        });
        const receipt = await _pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") return { success: false, network: requirements.network, transaction: hash, payer: a.from, errorReason: "settle tx reverted" };
        return { success: true, transaction: hash, network: requirements.network, payer: a.from };
      } catch (e) {
        return { success: false, network: requirements.network, errorReason: e.message };
      }
    },
  };
  function bad(reason) { return { isValid: false, invalidReason: reason }; }
}

// ── The pay-gate ────────────────────────────────────────────────────────────────────────────────────
/**
 * Build a per-agent x402 pay-gate as a Node http request handler.
 *
 * @param {object} o
 * @param {string} o.payTo                recipient (agent treasury) — REQUIRED for a live gate.
 * @param {number|string} [o.priceUsdg=0.1]
 * @param {string} [o.resource="/"]
 * @param {string} [o.description]
 * @param {string} [o.asset=USDG]
 * @param {string} [o.network]
 * @param {object|string} [o.facilitator]  a facilitator object, or a name for createFacilitator().
 * @param {(ctx)=>any} [o.serve]           produces the paid response body. ctx = { req, payer, settlement }.
 * @param {()=>boolean|Promise<boolean>} [o.canServe]  treasury meter — false ⇒ 503, the agent sleeps.
 * @returns {{ handler: Function, requirements: object, facilitator: object }}
 */
export function createPayGate(o) {
  const requirements = buildPaymentRequirements(o);
  const facilitator = typeof o.facilitator === "object" && o.facilitator
    ? o.facilitator
    : createFacilitator(o.facilitator);
  const serve = o.serve || (({ payer }) => ({ ok: true, payer, servedAt: new Date().toISOString() }));

  const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const challenge = (res, extra = {}) =>
    sendJson(res, 402, { x402Version: X402_VERSION, accepts: [requirements], ...extra });

  const handler = async (req, res) => {
    try {
      // Treasury meter: a dry agent sleeps (BUILD.md M2.5).
      if (o.canServe && !(await o.canServe())) {
        return sendJson(res, 503, { error: "agent sleeping (treasury cannot pay for inference)" });
      }
      const header = req.headers["x-payment"];
      if (!header) return challenge(res, { error: "payment required" });

      let paymentPayload;
      try { paymentPayload = decodePaymentHeader(header); }
      catch (e) { return challenge(res, { error: `malformed X-PAYMENT: ${e.message}` }); }

      const v = await facilitator.verify({ paymentPayload, requirements });
      if (!v.isValid) return challenge(res, { error: "payment invalid", reason: v.invalidReason });

      const settlement = await facilitator.settle({ paymentPayload, requirements });
      if (!settlement.success) {
        return sendJson(res, 402, { x402Version: X402_VERSION, accepts: [requirements], error: "settlement failed", reason: settlement.errorReason });
      }

      const body = await serve({ req, payer: v.payer || settlement.payer, settlement });
      sendJson(res, 200, body, { "X-PAYMENT-RESPONSE": encodeSettlementReceipt(settlement) });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  };

  return { handler, requirements, facilitator };
}

// ── Client helper (used by the demo, and by an agent that PAYS another agent) ──────────────────────────
/**
 * Fetch an x402 resource, paying on the 402 challenge, then re-requesting with X-PAYMENT.
 * @param {string} url
 * @param {object} [o] { signerKey } for the "exact" scheme, or { mock:true } for the mock facilitator.
 * @returns {Promise<{status:number, body:any, settlement?:object}>}
 */
export async function payAndFetch(url, o = {}) {
  const r1 = await fetch(url);
  if (r1.status !== 402) return { status: r1.status, body: await r1.json().catch(() => null) };
  const chal = await r1.json();
  const req = chal.accepts?.[0];
  if (!req) throw new Error("402 without accepts[]");

  let paymentHeader;
  if (o.mock) {
    paymentHeader = b64encode({ x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { mock: true, from: o.from || "0xMOCK" } });
  } else {
    if (!o.signerKey) throw new Error("payAndFetch needs { signerKey } for the exact scheme (or { mock:true })");
    const viem = await loadViem();
    const payer = viem.privateKeyToAccount(o.signerKey.startsWith("0x") ? o.signerKey : "0x" + o.signerKey);
    const now = Math.floor(Date.now() / 1000);
    const nonce = viem.keccak256(viem.toHex(`${payer.address}:${Date.now()}:${Math.random()}`));
    const authorization = {
      from: payer.address, to: req.payTo, value: req.maxAmountRequired,
      validAfter: String(now - 5), validBefore: String(now + (req.maxTimeoutSeconds || 120)), nonce,
    };
    const signature = await payer.signTypedData({
      domain: { ...req.extra, chainId: chainIdOf(req.network), verifyingContract: req.asset },
      types: TRANSFER_WITH_AUTH_TYPES, primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce,
      },
    });
    paymentHeader = b64encode({ x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { signature, authorization } });
  }

  const r2 = await fetch(url, { headers: { "X-PAYMENT": paymentHeader } });
  const body = await r2.json().catch(() => null);
  const receiptHeader = r2.headers.get("x-payment-response");
  return { status: r2.status, body, settlement: receiptHeader ? b64decode(receiptHeader) : undefined };
}

// ── CLI: the demo (grows from agent.mjs x402Demo) + a real --serve mode ────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); out[k] = v === undefined ? true : v; }
    else out._.push(a);
  }
  return out;
}

async function main() {
  autoloadEnv();
  const args = parseArgs(process.argv.slice(2));
  const facilitatorName = args.facilitator || process.env.X402_FACILITATOR || "mock";
  const priceUsdg = args.price ?? 0.1;
  const payTo = args.payTo || process.env.AGENT_TREASURY || "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";

  const gate = createPayGate({
    payTo, priceUsdg, resource: "/ask",
    description: "one call to this agent's brain",
    facilitator: facilitatorName,
    serve: ({ payer }) => ({ paid: true, payer, answer: "hello from the agent — you paid, so here is your answer." }),
  });

  const server = http.createServer(gate.handler);
  await new Promise((ok) => server.listen(args.port ? Number(args.port) : 0, ok));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/ask`;

  console.log(`\n=== x402 PAY-GATE (the "earn" verb) ===`);
  console.log(`  facilitator : ${facilitatorName}${facilitatorName === "mock" ? "  (settlement is SIMULATED — proves the loop only)" : ""}`);
  console.log(`  price       : ${priceUsdg} USDG (${gate.requirements.maxAmountRequired} units)  asset=${gate.requirements.asset}`);
  console.log(`  network     : ${gate.requirements.network}   payTo=${payTo}`);
  console.log(`  listening   : ${base}`);

  if (args.serve) {
    console.log(`\n  --serve: staying up. POST/GET ${base} with an X-PAYMENT header. Ctrl-C to stop.\n`);
    return; // keep the server open
  }

  // Exercise the loop: unpaid -> 402 challenge, then paid -> 200.
  const r1 = await fetch(base);
  const b1 = await r1.json();
  console.log(`\n  unpaid  -> HTTP ${r1.status}; challenge: price=${b1.accepts?.[0]?.maxAmountRequired} payTo=${b1.accepts?.[0]?.payTo} scheme=${b1.accepts?.[0]?.scheme}`);

  const useMock = facilitatorName === "mock";
  const payerKey = args.payerKey || process.env.X402_PAYER_KEY;
  if (!useMock && !payerKey) {
    console.log(`\n  (paid leg skipped: facilitator "${facilitatorName}" needs a real EIP-3009 signature — set X402_PAYER_KEY to run it)\n`);
    server.close();
    return;
  }
  const paid = await payAndFetch(base, useMock ? { mock: true } : { signerKey: payerKey });
  console.log(`  paid    -> HTTP ${paid.status}; served=${paid.body?.paid ?? paid.body?.ok}; payer=${paid.body?.payer}`);
  console.log(`  settle  -> tx=${paid.settlement?.transaction} success=${paid.settlement?.success}${paid.settlement?.mock ? " (SIMULATED)" : ""}`);
  console.log(`\n=== pay-gate loop complete (challenge -> verify -> settle -> serve) ===\n`);
  server.close();
}

// Run only when executed directly (not when imported by the brain service).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
}
