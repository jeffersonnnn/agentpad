// Phase 0, check 5 (zero-dependency): a 2026-native agent loop.
//   - model via OpenRouter (tool calling), model-pluggable
//   - tools in MCP shape (name/description/inputSchema), executed as function calls
//   - REAL on-chain reads on Robinhood Chain 4663 via raw JSON-RPC
//   - a prepared USDG->NVDA swap (calldata), and an x402 pay-gate for the "earn" verb
//
// Deferred until disk space frees an npm install: a real MCP stdio server/client, real tx
// signing/broadcast (viem), and real x402 settlement (facilitator). This proves the loop.
//
// Run: set -a; . ./.env; set +a; node agent/agent.mjs

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const RPC = process.env.ROBINHOOD_ALCHEMY_RPC || "https://rpc.mainnet.chain.robinhood.com";
const MODEL = process.env.AGENT_MODEL || "anthropic/claude-sonnet-5";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // 6 dec
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // 18 dec
const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2"; // SwapRouter02
// A live address that actually holds USDG (the NVDA/USDG pool), so the read returns nonzero.
const DEMO_TREASURY = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";

let rpcId = 1;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const pad32 = (hexNo0x) => hexNo0x.padStart(64, "0");
const addrWord = (a) => pad32(a.toLowerCase().replace(/^0x/, ""));
const uintWord = (n) => pad32(BigInt(n).toString(16));
const fmt = (wei, dec) => {
  const b = BigInt(wei), d = 10n ** BigInt(dec);
  return `${b / d}.${(b % d).toString().padStart(dec, "0").slice(0, 4)}`;
};

// ---- the tools (MCP-shaped) ----
const TOOLS = [
  {
    name: "get_treasury_balance",
    description: "Read the agent treasury's native ETH and USDG balances on Robinhood Chain 4663.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "the treasury address (0x...)" } },
      required: ["address"],
    },
  },
  {
    name: "prepare_swap_usdg_to_nvda",
    description: "Prepare (encode) a Uniswap v3 swap of USDG into NVDA on the live 5bps pool. Returns the router calldata. Does not sign or broadcast.",
    inputSchema: {
      type: "object",
      properties: { amount_usdg: { type: "number", description: "USDG amount to swap (whole USDG)" } },
      required: ["amount_usdg"],
    },
  },
];

async function runTool(name, args) {
  if (name === "get_treasury_balance") {
    const addr = args.address;
    const ethWei = await rpc("eth_getBalance", [addr, "latest"]);
    const usdgHex = await rpc("eth_call", [{ to: USDG, data: "0x70a08231" + addrWord(addr) }, "latest"]);
    return {
      address: addr,
      eth: fmt(ethWei, 18),
      usdg: fmt(usdgHex, 6),
    };
  }
  if (name === "prepare_swap_usdg_to_nvda") {
    const amountIn = BigInt(Math.round(args.amount_usdg * 1e6)); // USDG 6 dec
    // SwapRouter02.exactInputSingle((tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,sqrtPriceLimitX96))
    // selector 0x04e45aaf; the tuple is all static, so it encodes inline as 7 words.
    const data =
      "0x04e45aaf" +
      addrWord(USDG) + addrWord(NVDA) + uintWord(500) + addrWord(DEMO_TREASURY) +
      uintWord(amountIn) + uintWord(1) + uintWord(0);
    return {
      to: ROUTER,
      calldata_preview: data.slice(0, 74) + "...",
      calldata_len_bytes: (data.length - 2) / 2,
      note: "prepared only; signing/broadcast needs viem (deferred, disk full)",
    };
  }
  throw new Error("unknown tool " + name);
}

// ---- the OpenRouter agent loop ----
const orTools = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

async function callModel(messages) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${OPENROUTER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: orTools, tool_choice: "auto", max_tokens: Number(process.env.AGENT_MAX_TOKENS || 8000) }),
  });
  const j = await r.json();
  if (j.error) throw new Error("OpenRouter: " + JSON.stringify(j.error));
  return j.choices[0].message;
}

async function agentLoop() {
  console.log(`\n=== AGENT LOOP (model: ${MODEL} via OpenRouter) ===`);
  const messages = [
    {
      role: "system",
      content:
        "You are AgentCoin, an autonomous agent living on Robinhood Chain (4663). You control a " +
        "treasury and can trade tokenized stocks. Use your tools to act. Be concise.",
    },
    {
      role: "user",
      content:
        `Check your treasury balance at ${DEMO_TREASURY}. Then prepare a swap of 100 USDG into ` +
        `NVDA as a dry run. Finally, in one sentence, report what you did.`,
    },
  ];

  for (let step = 1; step <= 5; step++) {
    const msg = await callModel(messages);
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments || "{}");
        console.log(`  [step ${step}] tool call -> ${tc.function.name}(${JSON.stringify(args)})`);
        const result = await runTool(tc.function.name, args);
        console.log(`             result -> ${JSON.stringify(result)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    console.log(`\n  AGENT SAYS: ${msg.content}\n`);
    return msg.content;
  }
  throw new Error("loop did not converge");
}

// ---- x402 pay-gate: the "earn" verb (mechanism proof) ----
import http from "node:http";
async function x402Demo(agentAnswer) {
  console.log("=== x402 PAY-GATE (the earn verb) ===");
  const PRICE = "100000"; // 0.1 USDG (6 dec)
  const server = http.createServer((req, res) => {
    if (!req.headers["x-payment"]) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        x402Version: 1,
        error: "payment required",
        accepts: [{
          scheme: "exact", network: "robinhood-4663",
          maxAmountRequired: PRICE, asset: USDG,
          payTo: DEMO_TREASURY, resource: "/ask",
          description: "one call to AgentCoin",
        }],
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ paid: true, answer: agentAnswer }));
  });
  await new Promise((ok) => server.listen(0, ok));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/ask`;

  const r1 = await fetch(base);
  const b1 = await r1.json();
  console.log(`  unpaid  -> HTTP ${r1.status}; challenge asset=${b1.accepts?.[0]?.asset} price=${b1.accepts?.[0]?.maxAmountRequired} payTo=${b1.accepts?.[0]?.payTo}`);

  const r2 = await fetch(base, { headers: { "x-payment": "demo-settled-usdg-0.1" } });
  const b2 = await r2.json();
  console.log(`  paid    -> HTTP ${r2.status}; served=${b2.paid} (settlement mocked; real x402 needs a facilitator)\n`);
  server.close();
}

// ---- run ----
if (!OPENROUTER_KEY) {
  console.error("OPENROUTER_KEY not set. Run: set -a; . ./.env; set +a; node agent/agent.mjs");
  process.exit(1);
}
try {
  const answer = await agentLoop();
  await x402Demo(answer);
  console.log("=== CHECK 5: one full round complete (think -> MCP-shaped tool -> on-chain act -> get paid) ===");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exit(1);
}
