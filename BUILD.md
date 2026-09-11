# Build Plan

The ordered, ready-to-execute plan to turn the Phase 0 proofs into the product. Read `PLAN.md`
for the design and the premise, `CONTEXT.md` for the glossary, and `docs/adr/` for the recorded
calls. This file is the "how we build it" track.

Phase 0 proved every core mechanism on-chain. This plan builds the product on top.

---

## Cost model: we are a thin wrapper, we do NOT sponsor agents

| Cost | Who pays |
|---|---|
| Gas for agent actions | The agent's own treasury (RH Chain gas is ~a fraction of a cent). No paymaster |
| Model / inference | The agent's treasury (fee-funded), or the creator's own OpenRouter key |
| X posting | The creator's own X account and keys (opt-in) |
| Wallet to sign the launch | The creator's existing wallet |
| The website + light coordination | Us. The one real platform cost, and it is small |

## Revenue: a fee cut that buys and burns the platform token (ADR 0003)

Every agent token's `creatorFeeRecipient` is OUR fee splitter. It splits the 70% creator fee:
80% to the agent's treasury, 20% to buy our platform token on PONS and burn it. The platform
token is itself a PONS token, so our revenue tracks total agent trading volume.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js + wagmi/viem. The creator connects an existing wallet (embedded wallet optional) |
| Backend | Node + TypeScript: the keeper, the fee splitter routing, launch orchestration |
| Chain access | viem (native `robinhood` chain) + Alchemy RPC. Confirmed live in Phase 0 |
| Fee splitter | A contract set as every agent's `creatorFeeRecipient`; routes 80/20 (agent / platform buyback) |
| Platform token | A PONS token; the splitter's 20% cut buys and burns it |
| Agent wallet | An ERC-4337 account with a session-key spend cap. Every agent trades, so every agent gets one |
| Gas | The agent pays its own, from its treasury. No sponsorship |
| Model | OpenRouter, default `anthropic/claude-sonnet-5`, pluggable per agent |
| Tools | MCP servers (on-chain actions, market data, socials) |
| Trading | Chainlink decision price (gated on freshness) + Uniswap v3 execution. Universe = the ~17 deep+fed assets |
| Payout | Fee splitter for our cut; a separate claim-based distributor for the agent's profit payouts to holders |
| Speaking (default) | A community reasoning feed on our site: the agent's thinking + each trade. Free to us |
| Speaking (X, opt-in) | The creator brings their own X keys and pays X. We build the wiring |
| Data | Postgres (agents, wallets, personas, strategy config, status) |
| Geoblock | None, worldwide (ADR 0001) |

Secrets in `.env`: `ALCHEMY_KEY`, `ROBINHOOD_ALCHEMY_RPC`, `OPENROUTER_KEY` (all set). Add for the
build: `DEPLOYER_KEY` (a dedicated, funded platform key that deploys each agent's splitter + 4337
account; never signs creator/holder funds), `DATABASE_URL` (Postgres, M3). Append LAST: `PLATFORM_TOKEN`
(the platform-token address, set near go-live). Not platform secrets: X keys (per-agent, creator-supplied)
and the x402 facilitator config (added when the facilitator is chosen at M2).

---

## Milestone 0 — Platform token (deploy-time config, done LAST)

The platform token is a deploy-time `.env` value, not a build prerequisite. Build everything against
`PLATFORM_TOKEN` (`.env`). Launch the actual token on PONS near go-live (a one-time, ETH-spending,
creator-signed step) and append its address to `.env`. Until then, the splitter holds its 20% cut and
flips to buy-and-burn once `PLATFORM_TOKEN` is set. Set it before the first mainnet agent launch.

Acceptance: the code reads `PLATFORM_TOKEN` from config; the token is launched and the env set before mainnet.

## Milestone 1 — The fee splitter and the money loop (finish the deferred Phase 0 items)

Goal: prove the money loop with live transactions. The agent pays its own gas. No sponsorship.

1. Build the fee splitter contract: it is the `creatorFeeRecipient`, it claims the creator fee
   from the PONS escrow, and it routes 80% to the agent treasury and 20% to buy-and-burn the
   platform token. Audit target.
2. Build the keeper: for each agent, call `sweepFees` on the curve (or `sweepPoolFees` after
   graduation), then trigger the splitter's claim-and-route. This is the self-funding loop.
3. Deploy an agent ERC-4337 account and scope a session key with a max spend, an allowed-token
   list, and an expiry. It pays its own gas from its balance.
4. Execute a real swap through the session key: USDG to a stock, within the cap.

Acceptance: a keeper run moves a live token's creator fee through the splitter, the agent gets
80% and the platform token is bought and burned with 20%, and an agent account swaps under a
session-key cap paying its own gas. All on-chain.
Needs: nothing new. The Alchemy RPC we have is enough.

## Milestone 2 — The brain service

Goal: a production agent loop, not the lite script.

1. Real MCP servers (`@modelcontextprotocol/sdk`): on-chain actions (swaps via the session key,
   balances, fee status), market data (Chainlink feeds with freshness checks, v3 TWAP), socials.
2. The agent loop: OpenRouter model calls, MCP tool orchestration, memory, the archetype template
   plus the persona prompt, and the risk guardrails enforced in code.
3. The reasoning feed: the loop writes its thinking and each decision to the community feed.
4. The profit distributor: the claim-based payout of realized gains above a high-water mark, per
   the creator's configured policy.
5. The x402 endpoint per agent (earn), and treasury-metered hosting: an agent runs while its
   treasury can pay; a dry agent sleeps.

Acceptance: an agent trades on fresh prices within its guardrails, writes its reasoning to the
feed, distributes a payout, and pays for its own inference. A drained agent sleeps.
Needs: an x402 facilitator choice.

## Milestone 3 — Launch backend and orchestration

Goal: one flow creates an agent end to end.

1. Postgres schema: agents, wallets, splitters, personas, strategy config, distribution config,
   status, x402 endpoint.
2. Launch orchestration: deploy the agent account and its fee splitter, then call PONS
   `launchToken` with `creatorFeeRecipient` set to the splitter, then store the record and start
   the loop.
3. The launch is signed by the creator's wallet (we never custody). We orchestrate the calls.

Acceptance: one flow takes a form plus a signed launch and returns a live token, a splitter
routing fees, and a running agent.

## Milestone 4 — Frontend

Goal: the PONS-familiar launch form and the agent page.

1. Launch form mirroring the PONS create form: Name, Ticker, Description, Image, X, Telegram,
   Paired asset (ETH or USDG), Developer buy, plus the agent fields: trading archetype, persona
   prompt, and distribution policy. Advanced keeps creator tax and snipe-tax exemptions.
2. Wallet connect and the signed launch flow.
3. Agent page: price, the agent wallet, its trades, its distributions, and the community reasoning
   feed where holders watch it think.

Acceptance: a creator launches an agent from the browser and watches it think and trade on its page.

## Milestone 5 — One flagship agent (the Phase 1 finish line)

1. Launch one flagship agent by hand through the full stack.
2. Let real trades flow. Confirm the splitter routes 80/20, the agent trades within guardrails,
   the reasoning feed fills, a payout distributes, and the platform token gets bought and burned.
3. Publish its page as the reference and demo.

Acceptance: the whole loop runs unattended on one live agent for a sustained period.

## Milestone 6 — Open the launchpad

1. Open public launches (permissionless, the launch fee is the only gate).
2. Scale the keeper, the splitter routing, and the hosting metering across many agents.
3. Add the X connect wiring for creators who bring their own keys.

Hard gates before mainnet product: a security audit (the splitter especially), a key-management
review, and the legal review (ADR 0001, 0002, 0003).

---

## Inputs still needed from you

1. A hosting target for the website and the light backend. The one real platform cost.
2. Later, an x402 facilitator choice (Milestone 2) and, if a creator wants X, their own X keys.

The only launch-critical input is hosting. Everything core is in hand: the model key, the chain
access, the RPC, and the proven fee loop.
