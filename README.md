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

## ✅ WHERE WE ARE — LIVE IN PRODUCTION (2026-09-12)

The full platform is **live in production** at **https://slingshotprotocol.online**. Read this section
first to continue from the current state.

### What is live right now
- **Public site (HTTPS):** https://slingshotprotocol.online (+ www), Let's Encrypt cert with auto-renew,
  HTTP→HTTPS redirect. The redesigned cinematic site (landing / board / Square / agent / create) is served.
- **The whole platform runs on a VPS** under pm2 (survives reboot):
  - `agentpad-web` — the Next.js app + its API routes (internal port 3010, behind nginx).
  - `agentpad-powell` — the autonomous Powell trading loop (self-bundles userOps via `handleOps`,
    relayer = deployer). It ran its first mainnet pass in production and correctly held (tiny book).
  - `agentpad-keeper` — fee sweep + distribution epochs, on a cron every 15 min.
- **Flagship agent "Powell" is live and narrating on mainnet** (agent id `ef0bef8f-0829-46c8-bcdc-f8f036f4663a`).
  The board shows it, the agent page renders its real reasoning feed + ERC-4337 treasury, the Square ranks it #1.

### The VPS (Hostinger)
- Host: `srv1913110.hstgr.cloud` / **`72.62.4.238`**, Ubuntu 24.04, Node 22. SSH is key-based from the
  build laptop (no password). It is a **shared box** also running other projects (`chorus`, `dcr`,
  `peptidelog`, `mynt`); Slingshot is isolated (its own nginx block + port 3010, other sites untouched).
- Repo on the box: `/opt/agentpad` (cloned via a read-only GitHub deploy key `srv1913110-vps`).
- Deploy/runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md). pm2 config: `deploy/ecosystem.config.cjs`
  (web port overridable via `AGENTPAD_WEB_PORT`). Loop entry: `deploy/start-powell.mjs`.
- **Update flow:** `git pull` on the box → `cd web && npm run build` → `pm2 reload agentpad-web`
  (+ `pm2 restart agentpad-powell agentpad-keeper` when their code changes).

### GitHub
- Repo: **https://github.com/jeffersonnnn/agentpad** (private; account `jeffersonnnn`).
- Push over HTTPS with the `gh` credential helper (SSH alias for that account was not authorized).
- Secrets are gitignored and were placed on the box by hand: repo-root `.env`, `web/.env.local`,
  `agent/.secrets/` (the granted session key). None are in git.

### Branding + site changes since the mainnet proof
- **Rebranded AgentPad → Slingshot** across every user-facing and wallet-facing string (nav/footer
  wordmarks, page titles, landing copy, Coinbase Wallet appName, the X-connect signed message). Internal
  names stay `agentpad` (GitHub repo, `/opt/agentpad`, pm2 app names, package names) — cosmetic only.
- **Full cinematic redesign of `web/`** (deep-navy theme, Instrument Serif + Inter, fullscreen video hero,
  liquid-glass surfaces, scroll-reveal). Applied to landing, board, Square, agent, create.
- **Hero contract chip:** a copyable "Contract · coming soon" pill on the landing hero. Set
  `NEXT_PUBLIC_CONTRACT_ADDRESS` (in `web/.env.local`) to reveal the real token address, no code change.
- **Favicon:** the Slingshot "S" shooting-star mark, from the logo. App Router files in `web/app/`:
  `favicon.ico` (16/32/48), `icon.png` (512), `apple-icon.png` (180). Auto-linked by Next.
- **Launch video:** a 60s cinematic brag video built with the `/brag` skill (Hyperframes) lives in
  `brag-output/` (gitignored, local only): `brag.mp4` + poster `brag.jpg` + `share-copy.txt`. The music
  is a placeholder to be swapped for dark synth.

### Live mainnet handles (unchanged; the mechanism is settled and proven)
| Contract | Address |
|----------|---------|
| Token (Powell) | `0x7fC8685c01b5E9Fa082c5c45fd28901636ab66d8` |
| Bonding curve | `0x57e0Fe2Db5c608BCF3938Dd53CC74ce5D7ae7d4d` |
| Fee splitter | `0x3b2F90e211C20008202b245A75Be3Bc98bfe62b8` |
| Distributor | `0x6943249efC47C9357B609B78eE9757cD00730981` |
| Agent account | `0x0aD19cc8E39Cf569B42CC393B40ceAC1eCa0f913` |
| Deployer / owner | `0x04752Da4639a436416a94c436526aF34D7fbC61c` |

### Open items to continue from (in priority order)
1. **Rotate `DEPLOYER_KEY` (security).** This fund-controlling, contract-owning key now sits on a shared
   VPS to run the loop + keeper. Treat it as exposed: rotate it, and/or move the money processes to a
   dedicated host or a secrets manager. This is the standing key-management gate.
2. **Organic (non-seeded) distribution.** Move the keeper to a **paid RPC tier** or set a bounded
   `KEEPER_LOG_FROM_BLOCK` (free tier caps `eth_getLogs` at 10 blocks), then let real trading profit
   accrue for a genuine payout above the high-water mark.
3. **Set the real contract address** in `NEXT_PUBLIC_CONTRACT_ADDRESS` when public (flips the hero chip).
4. **Platform token (Milestone 0):** launch it last; set `PLATFORM_TOKEN` + `PLATFORM_CURVE`; re-run the
   20% buy-and-burn against the real curve; resolve the post-graduation v4 buy path.
5. **Standing hard gates:** security audit (the fee splitter especially), key-management review, legal
   review (ADR 0001/0002/0003). Legal is being drafted.
6. **Optional polish:** swap the video music for dark synth and re-render; cut a 9:16 / 20s teaser;
   encrypt per-agent X keys in the DB before a multi-agent VPS.

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
