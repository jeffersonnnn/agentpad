# Flagship Runbook - "Powell" (Macro)

The exact, ordered steps to launch the flagship agent end to end and watch the whole loop run.
This is Milestone 5 (BUILD.md M5): one hand-built agent through the full stack.

- Config: `agents/powell.config.mjs` (the launch orchestration and the runtime consume it directly).
- Persona: `agents/powell.persona.md` (single source; the config reads it in).
- Archetype: Macro (safe-haven). Allowed assets: SGOV, GLD, SLV, and USDG base (SPEC.md section 4).
- Distribution: distribute 50% of realized USDG gain above the high-water mark, weekly (ADR 0002).

Authoritative sources: SPEC.md wins over older PLAN.md prose. Re-verify every address before a
mainnet write (FACTS.md). This runbook targets a fork or testnet first, then mainnet.

---

## 0. What spends ETH (read this first)

Every step that broadcasts a transaction spends ETH. Robinhood Chain gas is a fraction of a cent,
so the only material ETH costs are the two 0.0005 ETH PONS launch fees and the treasury seed.

| # | Step | Who signs | ETH spent |
|---|------|-----------|-----------|
| P1 | Deploy the ZeroDev rate-limit policy module on 4663 (one-time platform prereq) | A funded platform key | gas only |
| P2 | Launch the PLATFORM token on PONS (Milestone 0) | The platform creator wallet | 0.0005 ETH fee + gas |
| 1 | Deploy the per-agent FeeSplitter (`prepare`) | `DEPLOYER_KEY` | gas only |
| 3 | Sign PONS `launchToken` for Powell | The CREATOR wallet | 0.0005 ETH fee + gas |
| 4 | Wire the curve + deploy the Distributor (`finalize`) | `DEPLOYER_KEY` | gas only |
| 5 | Fund the treasury seed (ETH for gas + USDG to trade) | The seed sender | ETH transfer + gas |
| 6 | Grant the session key + deploy the agent account | The agent account (self-paying) | gas only |
| 8 | First trade (userOp) | The agent account (self-paying) | gas only |
| 9 | Keeper `claimAndRoute` and `setRoot` | `DEPLOYER_KEY` | gas only |
| 9 | Distributor funding userOp (owner-execute) | The agent account (self-paying) | gas only |
| 10 | Holder claim of USDG | The holder | gas only |

The server NEVER signs `launchToken` and NEVER custodies creator or holder funds (ADR 0004). The
creator signs the launch client-side. The agent account pays its own gas; there is no paymaster.

---

## 1. Prerequisites (one-time platform setup)

1. `.env` at the repo root holds these keys (all present except confirm P0 items):
   - `ALCHEMY_KEY`, `ROBINHOOD_ALCHEMY_RPC` (node + bundler), `OPENROUTER_KEY` - set.
   - `DEPLOYER_KEY` - a dedicated, FUNDED platform key. It deploys the splitter and the Distributor,
     runs the keeper, and derives each agent account's platform-managed owner. It never signs creator
     or holder funds. Fund it with a little ETH for gas.
   - `DATABASE_URL` - Postgres (Neon). Apply the schema: `psql "$DATABASE_URL" -f api/db/schema.sql`.
2. Build the contracts so `prepare`/`finalize` can read the artifacts:
   `forge build` (produces `out/FeeSplitter.sol/FeeSplitter.json` and `out/Distributor.sol/Distributor.json`).
3. Install runtime deps (each workspace has its own `node_modules`): `cd agent && npm install`, then
   `cd api && npm install`.
4. **P1 - Deploy the ZeroDev rate-limit policy module on 4663.** FACTS.md: the rate-limit singleton
   `0xf63d4139B25c836334edD76641356c6b74C86873` has NO code on 4663, and the session-key validator
   installs it on enable. A session key CANNOT be enabled until this module is deployed. Deploy the
   byte-identical singleton from a funded key, then re-verify all four ZeroDev permission modules have
   code. This spends gas. (Step 6 below fails without it.)

## 2. Milestone 0 - the platform token (do this before the first agent)

The splitter's 20% cut buys and burns the PLATFORM token. Until the token exists, the splitter HOLDS
the 20% (SPEC.md section 0/1). Launch it once, near go-live:

1. **P2 - Launch the platform token on PONS.** A platform creator wallet signs `launchToken` and pays
   the 0.0005 ETH launch fee plus gas. Record the returned token and curve addresses.
2. Append BOTH to `.env` (the splitter needs the curve to buy-and-burn, not just the token):
   ```
   PLATFORM_TOKEN=0x...   # the platform token address
   PLATFORM_CURVE=0x...   # the platform token's bonding curve
   ```
   Set these BEFORE the first mainnet agent launch. On a fork you may leave them unset; the splitter
   then holds the 20% and you observe money-in as an 80% send plus a 20% balance held.

---

## 3. Launch Powell end to end

### Step 1-3 - prepare: deploy the splitter, predict the account, get the unsigned launch tx

The launch orchestration consumes the flagship config directly. Run a small script that imports
`agents/powell.config.mjs` and calls `prepareLaunch` with the creator address. This carries the
persona, the distribution policy, and the archetype that the plain CLI `prepare` does not pass.

```bash
CREATOR=0xYOUR_CREATOR_WALLET   # the wallet that will sign the launch (never the server)

node --env-file=.env --input-type=module -e '
import { launchInput } from "./agents/powell.config.mjs";
import { prepareLaunch } from "./api/launch.mjs";
const res = await prepareLaunch(launchInput(process.env.CREATOR));
console.log(JSON.stringify(res, null, 2));
' CREATOR=$CREATOR
```

This does three things (SPEC.md section 8), all idempotent and resumable by the returned `agentId`:
1. Deploys the per-agent FeeSplitter with `DEPLOYER_KEY` (gas only). The splitter is Powell's
   `creatorFeeRecipient`.
2. Predicts the ERC-4337 account address counterfactually (a pure read; no deploy, no gas).
3. Returns the UNSIGNED `launchToken` tx with `creatorFeeRecipient = the splitter`,
   `buybackEnabled = false`, and `value` exactly 0.0005 ETH (no markup).

Record from the output: `agentId`, `splitterAddr`, `accountAddr`, and the `launchTx`.

> Web alternative: POST the `launchInput()` JSON to `POST /api/launch/prepare`. The create form in
> `web/app/create` collects the same fields. The node script above is the faithful hand-launch path.

### Step 3 - the CREATOR signs and broadcasts launchToken (spends 0.0005 ETH)

The creator sends the returned `launchTx` from their own wallet (client-side; the server never signs
it). On a fork, sign it with the creator key using `cast send` or viem. Record the resulting `token`
address, `curve` address, and the launch `txHash`.

### Step 4 - finalize: verify the launch, wire the curve, deploy the Distributor

```bash
node --env-file=.env api/launch.mjs finalize \
  --id=<agentId> --token=0x<token> --curve=0x<curve> --tx=0x<launchTxHash>
```

`finalize` fetches the real launch tx and ASSERTS: `creatorFeeRecipient == this splitter`,
`buybackEnabled == false`, `value == 0.0005 ETH`, the salt matches this agent, and the sender is the
creator. Any mismatch aborts before wiring anything. Then it wires the curve into the splitter,
deploys the per-agent Distributor (both `DEPLOYER_KEY`, gas only), and flips the row to `live`.

> Loop start: `finalize` auto-spawns `agent/loop.mjs`, but its default spawn sets only
> `AGENT_ID/ARCHETYPE/MODEL/PERSONA` - NOT `AGENT_MCP_SERVERS`, so that auto-loop would exit. For a
> clean, observable flagship launch, disable the auto-start and start the loop by hand in Step 7:
> prefix `finalize` with `AGENTPAD_START_LOOP=0`.

---

## 4. Fund the treasury and enable trading

### Step 5 - fund the treasury seed (spends ETH)

The treasury IS the ERC-4337 account (`accountAddr` from Step 1). Send it:
- A little ETH so the account can pay its own gas (it self-deploys on its first userOp; no paymaster).
- The USDG trading seed (the optional Seed, CONTEXT.md). Size it to the session cap: the config caps
  spend at 2000 USDG (perTradeCap 250 USDG x 8 trades). Seed at least the cap you intend to trade.

Once Powell's token trades, the fee stream tops the treasury up automatically (Step 9).

### Step 6 - grant the session key and deploy the account (account pays its own gas)

CRITICAL: the account owner MUST be the per-agent owner the orchestration derived, not the raw
`DEPLOYER_KEY`. `account.mjs grant` defaults `--owner` to `DEPLOYER_KEY`, which would produce a
DIFFERENT account address than the one recorded and funded. Derive the correct owner from the agent
id, then grant:

```bash
AGENT_ID=<agentId>
OWNER_KEY=$(node --env-file=.env --input-type=module -e '
  import { deriveSalt, deriveAccountOwnerKey } from "./api/launch.mjs";
  console.log(deriveAccountOwnerKey(process.env.DEPLOYER_KEY, deriveSalt(process.env.AGENT_ID)));
' AGENT_ID=$AGENT_ID)

node --env-file=.env agent/account.mjs grant \
  --owner=$OWNER_KEY --archetype=macro --cap=2000 --max-trades=8 --ttl=86400 --stack=zerodev
```

CONFIRM (observe, do not assume): the account address `grant` prints MUST equal `accountAddr` from
Step 1. If it differs, the owner key is wrong; stop and fix it. The session policy scopes the key to
SGOV/GLD/SLV/USDG, the SwapRouter02 as the only swap target, a 250-USDG per-trade cap, 8 ops per 24h,
and a 24h expiry. Store the printed session PRIVATE key in the runtime secret store. Rotate it daily.

> Session flags come straight from the config: `node -e 'import("./agents/powell.config.mjs").then(m
> => console.log(m.default.grantFlags().join(" ")))'`.

---

## 5. Start the brain and watch the loop

### Step 7 - start the agent loop

Start `agent/loop.mjs` with the config's loop env plus the deployment-specific pieces. The config's
`loopEnv()` supplies the archetype, model, persona file, goal, and interval; you supply `AGENT_ID`
and the MCP server specs (on-chain actions via the session key, market data, socials).

```bash
node --env-file=.env --input-type=module -e '
import cfg from "./agents/powell.config.mjs";
import { spawn } from "node:child_process";
const env = { ...process.env, ...cfg.loopEnv(),
  AGENT_ID: process.env.AGENT_ID,
  AGENT_MCP_SERVERS: process.env.AGENT_MCP_SERVERS,  // set this to your on-chain/market/socials specs
};
spawn(process.execPath, ["agent/loop.mjs"], { env, stdio: "inherit" });
' AGENT_ID=<agentId>
```

The loop reads its portfolio and prices itself (ground truth), enforces the SPEC.md section 4
guardrails and the freshness gate IN CODE before any trade, injects its own 1% slippage floor, and
writes every thought and trade to the reasoning feed.

### Step 8 - watch the first trade + the first feed entry

- Watch stdout and the reasoning feed. The first entries are `thought` rows (Powell states the macro
  regime), then a `trade` row when it rotates, for example USDG into SGOV.
- The `trade` row carries the on-chain `tx_hash`. Open it on `robinhoodchain.blockscout.com` and
  confirm the swap executed through the session key, within the 250-USDG per-trade cap.
- Expect the freshness gate to BLOCK any GLD trade off-hours (GLD is feedless and off-hours-unsafe)
  and any equity-style stale price. A blocked trade is recorded as a `thought` with the reason. SGOV
  and SLV stay tradeable off-hours.

---

## 6. Money-in and the first distribution

### Step 9 - run the keeper (fees in, then a distribution epoch)

Once Powell's token has real trades, the 1% pool fee accrues on the curve. Run the keeper:

```bash
node --env-file=.env api/keeper.mjs --once --agent=<agentId>
```

The keeper (SPEC.md sections 1/3):
1. Fee routing: calls the splitter's `claimAndRoute` (sweep the curve fee to the PONS escrow, claim
   it, convert ETH to USDG, send 80% to the treasury, buy-and-burn the 20% platform token; if
   `PLATFORM_TOKEN`/`PLATFORM_CURVE` are unset, the splitter HOLDS the 20%). Observe the treasury USDG
   balance rise by 80% of the claimed fee.
2. Treasury metering: marks Powell `sleeping` if the treasury cannot cover one more inference plus gas
   cycle, and wakes it once refunded (hysteresis).
3. Distribution epoch: per the config policy (distribute, 50%, weekly), once the cadence elapses it
   snapshots holders off-chain (EXCLUDING the curve/pool, the splitter, the treasury, the distributor,
   and dead/zero), computes the realized USDG gain ABOVE the high-water mark, takes 50% of it, funds
   the Distributor from the treasury by an owner-execute userOp, publishes the Merkle root with
   `setRoot`, and advances the high-water mark. Observe a `distribution` feed row and a `distributions`
   table row.

Note: the first epoch distributes only if realized gains exceed the high-water mark. To see a payout
promptly on a fork, let Powell close at least one profitable round trip first, or shorten the cadence.

### Step 10 - a holder claims USDG

A holder claims their pro-rata USDG from the per-agent Distributor by Merkle proof (they pay their own
gas). Observe the holder's USDG balance rise and the claim recorded on-chain.

---

## 7. The frontend (watch it live)

Run the web app (`cd web && npm run dev`) and open Powell's agent page at `/agent/<agentId>`. It reads
the live price, the trades, the distributions, and the reasoning feed from the same Postgres the loop
and keeper write. This is the public proof surface: holders watch Powell think and trade.

---

## 8. Open items still unobserved (flag before mainnet)

These are settled in the docs but NOT yet observed live for the flagship (SPEC.md section 10,
docs/PRE-MAINNET-CHECKLIST.md). Confirm each on a fork or testnet before mainnet:

1. Account stack live-bundler userOp: session-key enforcement is proven by a fork test calling
   `EntryPoint.handleOps` directly. A real userOp through the live Alchemy bundler is still pending.
2. The ZeroDev rate-limit module on 4663 (prereq P1): deploy it and re-verify all four permission
   modules have code, or the session key cannot be enabled.
3. x402 facilitator: the self-hosted facilitator must sign against the real USDG EIP-712 domain
   (`name = "Global Dollar"`, `version()` reverts) - a pending M2 code fix - before it settles.
4. Post-graduation platform-token buy path (v4): `curve.buy` to the dead address works only until the
   platform token graduates (4.2 ETH, LP locks). Resolve the v4 buy route before graduation.
5. Non-empty PONS socials launch: only an EMPTY-socials launch is proven. Re-verify a non-empty
   socials launch against live PONS source before mainnet.
