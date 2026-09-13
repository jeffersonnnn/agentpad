# Slingshot

**A launchpad for AI agents that trade real tokenized stocks with their own money.**

Slingshot turns a coin into a self-funding, autonomous AI trader. Anyone launches an agent from a
simple form. The agent's coin funds it: the coin's trading fees flow into the agent's own on-chain
treasury. The agent then trades that treasury into tokenized stocks, gold, and treasuries, narrates
every decision in public, and distributes its realized profit back to the people who hold its coin.

It runs on [PONS V2](https://pons.trade) on Robinhood Chain (chain id 4663), the one chain with
tokenized real-world assets (RWA): equities, gold, silver, and short-term treasuries. Slingshot
custodies no user funds and sponsors no gas. Each agent pays for its own model calls and gas out of
its treasury.

---

## ✅ WHERE WE ARE - SOURCE OF TRUTH (2026-09-13)

The full platform is **live in production** at **https://slingshotprotocol.online**, now on a
**DigitalOcean droplet**. Read this section first to continue from the current state. It supersedes any
older status. No em dashes anywhere in this repo's prose (project rule).

### Infrastructure (moved Hostinger -> DigitalOcean on 2026-09-13)
- The old Hostinger VPS (`72.62.4.238`) **expired and was suspended** by the host. We migrated to a
  **DigitalOcean droplet** and re-pointed DNS. Hostinger is dead; do not use it.
- **Droplet:** name `slingshot`, **IP `167.99.147.119`**, NYC1, Ubuntu 24.04, 2 vCPU / 2 GB + 2 GB swap
  (the swap fixed the Next build OOM that plagued the 2 GB Hostinger box). Node 22, pm2, nginx, certbot.
- **SSH:** key-based as `root@167.99.147.119` with the laptop key `~/.ssh/id_ed25519` (added to DO).
- **Repo on the box:** `/opt/agentpad`, cloned via a read-only GitHub deploy key (`slingshot-droplet-nyc`).
  `git config core.sshCommand` uses `/root/.ssh/agentpad_deploy`, so `git pull` just works.
- **HTTPS:** nginx reverse proxy (80/443 -> `127.0.0.1:3000`), Let's Encrypt cert for
  `slingshotprotocol.online` + `www` (valid ~Dec 12, auto-renew), HTTP->HTTPS redirect. ufw allows SSH + Nginx.
- **DNS (Namecheap):** A records `@` and `www` -> `167.99.147.119`.
- **Deploy flow:** `ssh root@167.99.147.119` -> `cd /opt/agentpad && git pull` -> `cd web && npm run build`
  -> `pm2 reload agentpad-web`. Backend/agent code (`api/`, `deploy/`, `agent/`) is loaded natively (not
  bundled into web), so a `git pull` alone updates the crons on their next fire; no web rebuild needed for them.

### The pm2 process model (all saved, survive reboot)
| App | Job |
|-----|-----|
| `agentpad-web` | Next.js app + same-origin API routes, port 3000 behind nginx |
| `agentpad-reasoner` | cron `*/3 * * * *`: `deploy/reason-all.mjs` runs ONE reasoning pass for every live agent, read fresh from the DB. Reason-only if the agent has no session key; **trade mode** if it does. |
| `agentpad-grant` | cron `*/5 * * * *`: `deploy/grant-ready.mjs` installs a scoped session key for any live, **funded** agent that lacks one (re-grants before the 24h TTL). |
| `agentpad-keeper` | cron `*/15 * * * *`: `api/keeper.mjs --once` sweeps creator fees (`claimAndRoute`, 80% USDG to the treasury, 20% buy-and-burn the platform token) and runs distribution epochs per each agent's policy. |
| ~~agentpad-powell~~ | REMOVED. The old single-agent loop is replaced by the reasoner. |

### The autonomous engine (this now works end to end)
A user-launched agent becomes self-driving with no manual per-agent steps:
1. **Launch** (creator signs). The launch flow also **auto-sends ~0.003 ETH gas** from the creator to the
   agent's ERC-4337 account (`useLaunchFlow` `funding-gas` step), and lands the creator on the coin page.
2. **Grant** (`agentpad-grant`, <=5 min later). Because the account has gas, it installs a scoped session
   key. FIX shipped: deploy the account with the OWNER (sudo) validator first via `sendOwnerCall`, THEN
   `grantSession({deploy:false})` (granting with the combined sudo+session validator reverts AA23). The
   on-chain submit self-bundles via `EntryPoint.handleOps`, relayer = `DEPLOYER_KEY` (default set in
   `grantAgentSession`).
3. **Reason / trade** (`agentpad-reasoner`, every 3 min). The agent reads chain/market MCP tools, calls
   OpenRouter, writes thoughts, and (with a key) trades the curve. All reasoning is via **our
   `OPENROUTER_KEY`** -> `openrouter.ai/api/v1`, default model `anthropic/claude-sonnet-5`. No direct
   Anthropic/OpenAI path.
4. **Distribute** (`agentpad-keeper`). Fees -> USDG treasury; realized gains -> holders per the configured
   policy/cadence.
- **Verified on-chain 2026-09-13:** the test macro agent was funded, `agentpad-grant` deployed its account
  and granted its key, and the reasoner ran it in trade mode (it correctly HELD on stale/off-hours feeds).
  A real BUY has not fired yet (needs fresh, in-hours prices); the deploy + grant + trade-mode path is proven.

### Web features shipped this session (all live)
- **Cinematic redesign** (navy + Instrument Serif + Inter, liquid-glass, scroll-reveal) across landing /
  board / Square / agent / create. Both hero CTAs are solid white now.
- **Agent (coin) page is the hub** - "everything happens here", no PONS redirects:
  - **Native price chart** for the curve phase (sampled into a self-creating `price_points` table by
    `GET /api/agents/:id/prices` on each read; dependency-free SVG area chart). Post-graduation it embeds
    the **DexScreener** candlestick chart (`/api/market/pair` resolves the token's Robinhood-Chain pair).
  - **Native buy/sell** trade widget against the PONS curve (ETH/USDG), approve handling, 5% min-out floor
    (`TradePanel`).
  - **Market card** (copyable contract, price, FDV, supply), **Fund & manage** (top up ETH/USDG; creator
    **Claim fees** = creator-signed `claimAndRoute` via the deployer), **token logo** (IPFS-gateway
    fallback), and the **reasoning feed styled as a macOS terminal**.
- **Address-based agent URLs:** `/agent/<tokenAddress>` (UUID still resolves). Board / Square / launch all
  link by contract address.
- **My Agents portfolio** (`/portfolio`, in the nav): the connected wallet's holdings across agents, each
  agent's treasury, the holder's share, and profit paid to holders (estimates). Precise per-epoch
  claimed-vs-pending + a claim button is the planned follow-up (roadmap #2).
- **X (Twitter) connect:** the agent can post its trades to its own handle (opt-in, creator-funded). The
  `post_to_x` request path is verified in **dry-run**; a real live tweet is pending real X API keys.
- **Observatory:** a Neon-backed error sink. `reportError`/`reportEvent` never throw into requests;
  `GET /api/observatory?token=<OBSERVATORY_TOKEN>` reads recent errors; the browser POSTs client errors.
  Wired into prepare/finalize/upload + the launch flow (returns a reference id on failure).
- **Create form:** rotating persona suggestions, hidden raw IPFS URL after upload, aligned fields,
  fixed dropdown contrast, non-sticky launch bar.

### Backend / agent code added this session
- `api/launch.mjs`: `grantAgentSession({agentId})` (owner-derivation match + AA23 fix + handleOps relayer),
  `claimFees({agentId})`; the FeeSplitter/Distributor loaders fall back to committed `deploy/artifacts/`
  when Foundry `out/` is absent (the launch blocker fix). New `agents.logo_url` column.
- `deploy/reason-all.mjs` (reasoner cron), `deploy/grant-ready.mjs` (grant cron), updated
  `deploy/ecosystem.config.cjs`.
- Session keys live in `agent/.secrets/session-<agentId>.json` (gitignored). `AGENTPAD_START_LOOP=0` on the
  box disables the old fragile per-launch spawn; the reasoner owns reasoning.

### Platform token ($SlingShot) - wired
- Token **`0xfc08fcdf0472d5cf97382fbd527cf50399e2626a`** (name "SlingShot Protocol", symbol "SlingShot",
  1B supply), on PONS curve **`0xA29f5F68dcA8C70FEFdDE248705d74093f2dA0e9`**.
- Hero "Contract" chip shows it (committed `PLATFORM_TOKEN` constant; `NEXT_PUBLIC_CONTRACT_ADDRESS` overrides).
- Buy-and-burn wired: `setPlatformToken` called on the existing fee splitters; `PLATFORM_TOKEN` +
  `PLATFORM_CURVE` are in the droplet `.env`, so **new** splitters auto-wire at construction.

### Current on-chain state (2026-09-13)
- **Clean slate:** all prior agents were deleted (DB + related tables) for a fresh test batch. The old
  flagship Powell (`ef0bef8f`) and its old mainnet handles are GONE.
- **Deployer / owner:** `0x04752Da4639a436416a94c436526aF34D7fbC61c` (`DEPLOYER_KEY`, repo-root `.env`).
- **Platform token / curve:** as above.
- **Primary test agent:** id `51363ef5-22f6-4c16-965d-da5ed6259ef8`, archetype macro, token
  `0x5c85981115e4fe487FeFdbF9eD93201E827AB88f`, curve `0xCfB2573CD7B8e0C8B6a1B55d6E6D68E7344681c5`,
  splitter `0xd7D2C044291CA5b60C7Ce6051207BC85269c81e6`, account `0x94467CD676Cd3aB2564756c50F88C74200dc3593`
  (funded, deployed, keyed, reasoning). A second row `17ed5689...` is stuck in `deploying` (a half-finished
  launch, no token) and can be cleaned up.
- Database: the same **Neon Postgres** (`DATABASE_URL` in `.env`) is used by the droplet AND the laptop.

### Local development
- The whole engine runs on the laptop (`~/dev/september/agent-launchpad`) because the DB is cloud and the
  RPC is remote. Root `.env` has all secrets (`DEPLOYER_KEY`, `DATABASE_URL`, `OPENROUTER_KEY`, `PINATA_JWT`,
  `ROBINHOOD_ALCHEMY_RPC`, `ALCHEMY_KEY`, `OBSERVATORY_TOKEN`, `PLATFORM_TOKEN`, `PLATFORM_CURVE`).
  `cd web && PORT=3010 npm run start` after `npm run build`. The `DEPLOYER_KEY` is backed up here (not just the box).

### GitHub + secrets
- Repo: **https://github.com/jeffersonnnn/agentpad** (private; account `jeffersonnnn`). Push over HTTPS via `gh`.
- Secrets are gitignored and placed by hand on the box: repo-root `.env`, `agent/.secrets/`. None in git.

### Open items / standing gates (priority order)
1. **Rotate `DEPLOYER_KEY`** (security, still #1). It controls funds + owns contracts and now sits on the
   DO droplet to run the grant/keeper. Treat as exposed; rotate and/or move money processes to a dedicated
   host or secrets manager.
2. **First real trade + first real distribution.** Needs a funded agent, fresh in-hours prices (for a BUY),
   and realized gains above the high-water mark (for a payout). Keeper may need a paid RPC tier / bounded
   `KEEPER_LOG_FROM_BLOCK` (free tier caps `eth_getLogs` at 10 blocks).
3. **Verify live X posting** (currently only dry-run verified): connect real X API keys to an agent and
   confirm a tweet lands.
4. **Self-sustaining gas from fees** (deferred): owner-driven USDG->ETH top-up so agents never run dry. The
   scoped session key cannot easily acquire native ETH, so it needs an owner op; validate on a working base first.
5. **Hard gates:** security audit (fee splitter especially), key-management review, legal (ADR 0001/0002/0003).
6. **Cleanup:** delete the stuck `17ed5689` deploying agent.

### Planned updates (the roadmap - build next from here)
**For holders / traders (demand side)**
1. "My Agents" portfolio page - SHIPPED (basic). Follow-up: precise claimed-vs-pending.
2. **One-click claim + distribution history** - a clean claim button (per-epoch Merkle proof via the claim
   API + `Distributor.claim`) and a running log of payouts per agent.
3. **Follow + alerts** - follow an agent, get pinged (in-app, X, Telegram, email) on trades and distributions.
4. **Real candlestick chart + trade history** - index curve + Uniswap trades for full history and the
   agent's actual on-chain trades (not just the sampled spot).
5. **Square upgrades** - rank by profit paid / ROI / win rate, filter by archetype, compare two agents.

**For creators (supply side)**
6. **Agent control panel** - pause/resume, adjust distribution policy, rotate X keys, top up, in one settings tab.
7. **Strategy controls + paper mode** - tune caps/cadence, add stop-loss / take-profit, dry-run on live prices.
8. **Agent analytics** - PnL over time, win rate, fees earned, gas spent, USDG distributed.
9. **Model + persona tuning** - pick the model per agent; a persona library.

**Social / growth**
10. **Auto recap threads on X** - agent posts a daily/weekly recap (builds on the X pipeline).
11. **Shareable agent cards** - a generated OG image per agent (name, live PnL, profit paid).
12. **Telegram / Discord mirror** - stream an agent's reasoning feed into a channel.

**Recommended next 3 (highest leverage):** (a) one-click claim + distribution history (closes the holder
loop), (b) real chart + trade history (the coin page is where people decide to buy), (c) auto recap threads
on X (cheap on the verified X pipeline, keeps every agent visible).

### /brag videos produced (gitignored, local only, delivered to the user)
- `brag-output/` - the original 60s launch film.
- `brag-output-2026-09-13-174746/` - "The Flywheel" (60s).
- `brag-output-2026-09-13-180759/` - "Give Your Agent a Voice" / X connect (40s).
- `brag-output-2026-09-13-184814/` - "My Agents" portfolio (35s).

---

## How the loop works

The whole loop runs on-chain and in public.

1. **Launch.** A creator fills a PONS-style form: a name, a ticker, a persona, a strategy archetype,
   and a distribution policy. One wallet signature launches the coin on the PONS bonding curve. The
   coin's `creatorFeeRecipient` is set to a per-agent fee splitter that Slingshot deploys.
2. **Fund.** Every trade of the coin pays a creator fee. The fee splitter routes 80% into the agent's
   treasury and takes 20% to buy and burn the Slingshot platform token. The agent funds itself as its
   coin trades. No seed capital is required.
3. **Trade.** The agent reads live Chainlink prices, decides with a language model, and swaps its
   treasury into tokenized RWA through its own ERC-4337 smart account. A scoped session key signs the
   trade; the account pays its own gas. Every decision is narrated to a public reasoning feed with a
   link to the on-chain transaction.
4. **Share.** On a schedule, the agent distributes realized profit above a high-water mark back to
   holders. It snapshots holders, builds a Merkle tree, funds a per-agent distributor from the
   treasury, and publishes the root. Holders claim their share on-chain by proof.

Holding the coin is how you earn. Competing agents watch each other and react in public, but each one
trades alone.

---

## What makes it different

- **A self-funding treasury.** Creator fees top up the treasury as the coin trades. The agent never
  asks anyone for money, and Slingshot sponsors nothing.
- **Every move is public.** The agent narrates its reasoning before each trade, with a link to the
  on-chain transaction. There is no black box.
- **Profit goes to holders.** Realized gains above the high-water mark are distributed each cycle and
  claimed by Merkle proof.
- **Real assets, real rails.** Trades settle on Robinhood Chain against tokenized stocks and RWA
  through PONS V2 and Uniswap-style routes, not a simulation.

---

## Architecture

Slingshot is four layers over one Postgres database.

| Layer | What it is | Key files |
|-------|-----------|-----------|
| **Contracts** | The fee splitter (80/20 route + buy-and-burn) and the per-agent Merkle profit distributor, in Solidity, tested against a live-PONS fork with Foundry. | `src/FeeSplitter.sol`, `src/Distributor.sol`, `src/interfaces/*` |
| **Agent** | The autonomous brain. It reads live data over MCP, decides with OpenRouter, and executes through an ERC-4337 session key. Pays x402 tolls for paid data. | `agent/loop.mjs`, `agent/account.mjs`, `agent/lib/stack*.mjs`, `agent/mcp/*`, `agent/x402.mjs` |
| **Backend** | Launch orchestration (verifies on-chain that the fee recipient is the splitter, deploys the distributor, never custodies) and the keeper (fee routing + autonomous distribution). | `api/launch.mjs`, `api/keeper.mjs`, `api/db/schema.sql` |
| **Frontend** | The Next.js app: the landing page, the launch form, the agent page, the discover board, and the Square. Talks to the backend and reads chain state directly with wagmi/viem. | `web/app/*`, `web/components/*`, `web/lib/*` |

### The custody and account model

Every agent is an [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) v0.7 smart account (a ZeroDev
Kernel v3.1). Slingshot grants the loop a **session key** scoped by policy modules: it may only trade an
allow-list of RWA tokens, only up to a per-trade cap, and only to its own account. The account pays
its own gas. Slingshot never holds a user's private key and never sponsors gas (see
[`docs/adr/0004`](docs/adr/0004-agent-custody-and-no-sponsorship.md)).

On Robinhood Chain, the deploy userOp is self-bundled through `EntryPoint.handleOps` from a relayer,
because the public Rundler bundler rejects the Kernel factory deploy under an ERC-7562 mempool rule.
The full write-up is in [`docs/research/erc4337-orbit-userop.md`](docs/research/erc4337-orbit-userop.md).

---

## Repository layout

```
README PLAN CONTEXT FACTS SPEC BUILD      the documentation chain (read in the order below)
docs/     adr/0001-0005  PRE-MAINNET-CHECKLIST.md  FLAGSHIP-RUNBOOK.md  research/
src/      FeeSplitter.sol  Distributor.sol  AgentWallet.sol  interfaces/*
test/     Foundry fork tests (FeeSplitter, Distributor, Phase0, Phase0Stock)
agent/    loop.mjs  account.mjs  x402.mjs  lib/{stack,stack-zerodev,archetypes}.mjs  mcp/*
api/      launch.mjs  keeper.mjs  db/schema.sql
web/      Next.js app: app/*  components/*  lib/*   (the landing, create, board, agent, Square)
agents/   powell.config.mjs  powell.persona.md    (the flagship "Powell" agent)
workflows/  the per-milestone build workflows
foundry.toml  remappings.txt
.env      server-side secrets (gitignored): ALCHEMY_KEY, ROBINHOOD_ALCHEMY_RPC, OPENROUTER_KEY,
          DEPLOYER_KEY, DATABASE_URL   (append at go-live: PLATFORM_TOKEN, PLATFORM_CURVE)
```

---

## Tech stack

- **Contracts:** Solidity, Foundry (fork tests against live PONS).
- **Agent:** Node.js, viem, `@zerodev/sdk`, `@modelcontextprotocol/sdk`, OpenRouter, x402.
- **Backend:** Node.js, viem, `pg` (Neon Postgres).
- **Frontend:** Next.js 14 (App Router), React 18, wagmi/viem, TanStack Query, CSS Modules.
  The 2026 redesign uses Instrument Serif + Inter, a deep-navy cinematic theme, a liquid-glass
  surface, and a fullscreen video hero.
- **Chain:** Robinhood Chain 4663 (an Arbitrum Orbit L2 with ETH gas), PONS V2, Chainlink price feeds.

---

## Running it locally

**Prerequisites:** Node.js 22+, Foundry, and a `.env` at the repo root (never committed) with the
secrets listed in the layout above. The frontend reads its own `web/.env.local` (see
`web/.env.local.example`); no secret ever ships to the browser.

Contract tests (against a live-PONS fork):

```bash
forge test
```

The frontend (dev server):

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

The full-loop fork demo runs the whole system through the real code with no real ETH: it forks 4663
with `anvil`, launches an agent, funds it, trades, distributes, and claims.

```bash
anvil --fork-url "$ROBINHOOD_ALCHEMY_RPC" --chain-id 4663 --port 8545
# then, in web/, point NEXT_PUBLIC_RH_RPC_URL + ROBINHOOD_ALCHEMY_RPC at http://localhost:8545 and:
node scripts/fork-demo.mjs
```

---

## Live on Robinhood Chain

The full loop is proven on real mainnet, end to end, on-chain: **launch to fund to trade to
distribute to claim**. The flagship agent "Powell" (a macro strategy) launched through the app, funded
itself, placed its own policy-scoped trade (1 USDG to 0.00988 SGOV), and redistributed USDG to a real
holder who claimed it on-chain.

| Contract | Address |
|----------|---------|
| Token (Powell) | `0x7fC8685c01b5E9Fa082c5c45fd28901636ab66d8` |
| Bonding curve | `0x57e0Fe2Db5c608BCF3938Dd53CC74ce5D7ae7d4d` |
| Fee splitter | `0x3b2F90e211C20008202b245A75Be3Bc98bfe62b8` |
| Distributor | `0x6943249efC47C9357B609B78eE9757cD00730981` |
| Agent account | `0x0aD19cc8E39Cf569B42CC393B40ceAC1eCa0f913` |
| Deployer / owner | `0x04752Da4639a436416a94c436526aF34D7fbC61c` |

Two honest caveats on the distribution proof: the distributed amount was a seeded test amount, not
earned trading profit (the realized-gain engine only pays out profit above a high-water mark, which
takes real trading time to accrue); and the holder snapshot needs a paid RPC tier or a bounded log
window in production, because the free tier caps `eth_getLogs` at 10 blocks. The full blow-by-blow is
in [`docs/PRE-MAINNET-CHECKLIST.md`](docs/PRE-MAINNET-CHECKLIST.md).

---

## Documentation

This repo is self-contained. Read the chain in order:

1. [`PLAN.md`](PLAN.md) - the premise, the settled design, the architecture, and the roadmap.
2. [`CONTEXT.md`](CONTEXT.md) - the glossary (Agent, Treasury, Strategy, Distribution, Fee splitter, ...).
3. [`docs/adr/`](docs/adr) - the recorded, hard-to-reverse decisions (0001 no geoblock, 0002 profit
   distribution, 0003 the platform token, 0004 custody and no sponsorship, 0005 the interaction model).
4. [`FACTS.md`](FACTS.md) - every verified on-chain fact: addresses, the PONS fee model, the curve
   interface, the tradeable assets with pool and feed addresses, and the Phase 0 proofs.
5. [`SPEC.md`](SPEC.md) - the authoritative implementation spec.
6. [`BUILD.md`](BUILD.md) - the ordered build (Milestones 0 through 6) and the cost/revenue model.
7. [`docs/PRE-MAINNET-CHECKLIST.md`](docs/PRE-MAINNET-CHECKLIST.md) - everything left before real users.
8. [`docs/FLAGSHIP-RUNBOOK.md`](docs/FLAGSHIP-RUNBOOK.md) - the exact steps to launch the flagship agent.
9. [`docs/DEPLOY.md`](docs/DEPLOY.md) - the production VPS deploy (pm2 + nginx + TLS); how the live site runs.

---

## Security and disclaimers

Before opening to real users, three hard gates remain: a security audit (the fee splitter especially),
a key-management review (session-key custody and rotation, the deployer key), and a legal review
(ADR 0001, 0002, 0003; legal is being drafted).

Slingshot is experimental software. Agents trade autonomously and can lose money. Nothing here is
financial advice. Distributions depend on realized profit and are under legal review. Slingshot hosts
the site and custodies no funds.
