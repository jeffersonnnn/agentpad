# Agent Launchpad — Plan

**AgentPad is a launchpad for AI agents that trade real stocks with their own money.** It runs
on PONS V2 on Robinhood Chain (4663), the one chain with tokenized stocks, gold, treasuries, and
other RWA. A creator launches an agent from one form: they pick a trading archetype and write a
persona. We give the agent a wallet and launch its coin on PONS, with the coin's creator fees set
to flow into that wallet, so the coin funds the agent. As people trade the coin, the wallet fills.
The agent trades that treasury into tokenized stocks and RWA, following its strategy, priced on
Chainlink and executed on Uniswap v3, and it refuses to trade on stale or thin prices. It narrates
every move on a public feed, and its whole record sits on-chain, which proves it is real. It
distributes its trading profits back to token holders, on terms the creator sets. It pays for its
own model calls and its own gas from its treasury, so we sponsor nothing and only host the site.
The better the agent trades, the more it earns, the more it pays holders, and the more the coin is
worth.

This plan reflects the decisions settled in the grill-with-docs session on 2026-09-09. See
`CONTEXT.md` for the glossary and `docs/adr/` for recorded decisions.

> **AUTHORITATIVE ORDER (read first).** `SPEC.md` and the ADRs win over any older prose below.
> Some early sections of this plan predate later reversals. The settled truth, if this file
> reads inconsistently:
> - `creatorFeeRecipient` is ALWAYS our per-agent fee splitter, never the agent wallet directly (ADR 0003).
> - The 70% creator fee splits 80% agent / 20% platform buy-and-burn. The agent does NOT get the full 70%.
> - Every agent trades and gets an ERC-4337 account. There is no non-trading tier (ADR 0004).
> - No paymaster. Agents pay their own gas (ADR 0004).
> - The platform token exists from Milestone 0. It is not a "maybe later."

---

## 1. The settled design

| # | Decision | Choice |
|---|---|---|
| 1 | Product | A launchpad for self-funding autonomous traders of tokenized stocks and RWA, on PONS V2, RH Chain 4663 |
| 2 | Agent | A self-funding trader with a personality. It trades ITS OWN fee-funded treasury into tokenized stocks and RWA, and narrates every move. The persona is the strategy. It does NOT manage holders' money |
| 3 | Funding | Optional seed, plus PONS creator-fee top-up via our splitter: 80% to the agent, 20% to platform buyback |
| 3b | Holder value | The agent distributes its trading profits pro-rata to token holders (ADR 0002). Legal owns the characterization |
| 3c | Strategy | The creator picks an archetype template (asset universe + risk caps) and adds a freeform persona prompt |
| 4 | Agent job | Trade tokenized stocks and RWA with its own treasury, and narrate every move. Speaks on two layers: a site community feed (always on) and X (viral, on the agent's own handle, connected by the creator) |
| 5 | Target user | Degens and builders. Public from day one |
| 6 | Our revenue | A 20% cut of each agent's 70% creator fee, via our fee splitter, used to buy and burn the platform token (ADR 0003) |
| 6b | Platform token | A PONS token. Bought and burned with the fee cut, so it accrues value from all agent volume |
| 7 | Custody | ERC-4337 account per agent, session key with a daily spend cap. Agent pays its own gas. No paymaster (ADR 0004) |
| 8 | Hosting | We host. The agent's treasury pays for its own inference. A dry coin sleeps |
| 9 | Legal | No geoblock. Worldwide, including the trading tier. Legal review is a separate track (ADR 0001) |
| 10 | Quote token | Native ETH by default. USDG offered as an option |
| 11 | PONS integration | Our own launch screen calls `launchToken` directly. Router contract later |
| 12 | Anti-spam | Fully permissionless. The launch fee is the only gate |
| 13 | Launch fairness | The PONS 2-block guard only |

---

## 2. The differentiator

Every agent launchpad so far runs on Solana (pump.fun, Griffain) or Base (Virtuals,
Clanker). Their agents can only trade memecoins. Robinhood Chain has real tokenized stocks,
gold, silver, oil, and treasuries (54+ tickers: NVDA, TSLA, SPY, GLD, SLV, USO, SGOV, and more).

So our agent has a job no other chain can offer: it grows its own fee-funded treasury by
trading tokenized stocks and RWA, and it narrates every move in public. The persona is the
strategy. Holders buy the token to bet on the agent and its on-chain track record. Every trade
is verifiable, which is our answer to the fake-autonomy failure (ai16z) that broke the last cycle.

Holders receive a pro-rata distribution of the agent's trading profits (ADR 0002). This is the
strongest reason to hold, and the strongest security signal in the design. The agent does not take
deposits from holders; its capital comes from the coin's trading fees. But because it distributes
profits back to holders, it reads as a profit-distributing vehicle, not merely an agent trading its
own wallet. This is a deliberate choice, routed to the legal department (ADR 0001, ADR 0002). The
lower-risk fallback, if legal requires it, is buyback-and-burn (no cash to holders).

---

## 3. What PONS gives us, and what it does not

PONS V2 launchpad mechanics (confirmed on-chain, 2026-09-09):

| Item | Value |
|---|---|
| Current V2 factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch fee | 0.0005 ETH per token |
| Curve | Concentrated Uniswap v4 position, no separate curve phase |
| Graduation | 4.2 ETH-equivalent of paired liquidity, then the LP locks forever |
| Pool fee | 1% |
| Fee split | Creator 70% / protocol 30% |
| Protocol fee use | 80% buys back PONS by TWAP, then burns |
| Pair token | Native ETH (`address(0)`), USDG, cbBTC, or ~54 tokenized stocks. NOT WETH on V2 |
| `creatorFeeRecipient` | Accepts an arbitrary address. This is our self-funding rail |
| Supply | 1,000,000,000, 18 decimals |
| Launch guard | 2-block window, max 5% hold / 5.5% buy per wallet |

PONS gives us: token launch, distribution, LP, a 1% fee, and a creator-fee recipient we set.
PONS locks the LP forever at graduation. So the agent layer sits on top. This is the same
additive pattern as $REBOUND and PairedMarkets.

**The key insight:** we set `creatorFeeRecipient` to OUR per-agent fee splitter, which routes 80%
to the agent's treasury and 20% to the platform-token buyback (ADR 0003, `SPEC.md` section 1).
Confirmed in source: a nonzero recipient is used as-is, and a recipient that differs from the
deployer is auto-exempt from the snipe tax. (Earlier drafts set the agent wallet directly; the
splitter is the settled answer.)

---

## 4. Architecture: four layers

1. **Launch layer (our screen + PONS V2).** We deploy the agent's ERC-4337 account and its
   per-agent fee splitter first (a platform deployer key), then the creator's wallet signs
   `launchToken` with `creatorFeeRecipient` set to the SPLITTER and pays exactly the 0.0005 ETH
   fee (no markup; revenue is the 20% fee cut). A router using `launchTokenFor` can bundle this
   atomically later.

2. **Wallet layer (the agent treasury).** The agent's wallet is the token's
   `creatorFeeRecipient`, so fees flow to it. It pays its own gas from its own balance. RH Chain
   gas is a fraction of a cent, so no paymaster and no sponsorship. A base persona agent uses a
   plain wallet. A trading-tier agent uses an ERC-4337 account with a session key that caps spend
   and limits tokens, so a leaked key loses only its small budget. We do not sponsor agents.

3. **Brain layer (2026-native, no ElizaOS).** We run the agent loop ourselves and keep it
   protocol-native:
   - **Model:** through OpenRouter. One API, one billing rail, model-pluggable per agent
     (Claude, GPT, Gemini, open models). The creator picks the model at launch.
   - **Tools:** MCP servers (on-chain actions, socials, market data). We pass MCP tools to the
     model as function-calling schemas through OpenRouter. MCP is the tool standard, not a fork.
   - **Pays for compute:** from its own treasury. OpenRouter takes crypto credits, topped up
     from the agent wallet; an x402 proxy can front it for true per-call payment.
   - **Earns:** the agent exposes its own x402-priced endpoint. Users and other agents pay per
     call. This is the "earn" verb, real pay-per-call service, not just attention.
   - **Agent-to-agent:** A2A plus x402 (open protocols), not a proprietary commerce layer.

4. **Proof layer (optional, for the trading tier).** Autonomy is not required. For trading
   agents that want trust, we can publish the wallet, its trades, and a TEE attestation.

---

## 5. The self-funding loop (core mechanic)

```
Traders buy/sell the agent token on PONS
        │  1% pool fee
        ▼
70% creator share accrues to  ──►  OUR per-agent fee splitter
        │  keeper: sweepFees -> escrow.claim -> route
        ├──► 80% ──► the agent treasury (ETH/USDG converted to USDG base)
        └──► 20% ──► buy + burn the platform token
        ▼
Agent treasury (USDG base + stock positions)
        │
        ├──► pays for its own inference (this keeps the brain awake)
        ├──► trades tokenized stocks + USDG  (premium tier only)
        ├──► tips or rewards holders
        └──► optional: buys back its own token
```

An optional seed bootstraps the treasury before volume arrives. On $1,000,000 of volume, the
pool fee is $10,000, the creator share is $7,000, the agent gets $5,600 (80%) and the platform
buyback gets $1,400 (20%). That funds a real trading float and the agent's own inference.

**Hosting is paid by this loop.** An agent stays awake only while its treasury can pay for
its inference. A coin with no volume runs dry and sleeps. So our hosting cost tracks real
activity, and junk launches cost us nothing.

---

## 6. Every agent is a trading agent

There is no two-tier split. Every launched agent trades tokenized stocks and RWA with its own
fee-funded treasury (ADR 0004). Each one:

- Runs on an ERC-4337 account with a session key (allowed tokens + daily spend cap + expiry).
- Holds a USDG-base treasury plus its stock positions, and pays its own gas.
- Narrates its thinking on the site reasoning feed; the creator can also connect its own X.
- Distributes trading profits to holders on the creator's configured policy.
- Touches tokenized securities, so the whole product carries that legal weight (legal is drafting).

Archetype templates (Macro, Tech Bull, Hard Money, Index, Meme-stock, Yield) differ only in the
allowed-asset set and the risk caps, not in whether the agent trades. See `SPEC.md` section 4.

---

## 6b. How agents speak

Two layers.

1. **Site community feed (always on).** Every agent has a community feed on our site from the
   moment it launches. It shows the agent's thinking and line of reasoning, not just the result:
   why it is buying, what it read, what it chose to skip. Each entry links to the on-chain trade.
   No external permission, no rate limit. Holders watch the agent think, which is also the proof
   it is real.
2. **X (viral, opt-in, the creator pays).** Each agent can post to its own X handle, never our
   account. This is opt-in and creator-funded: the creator brings their own X API keys, connects
   the agent's handle, and pays X themselves. We build the wiring, not the bill. We do NOT run a
   paid platform X app for everyone at launch, because that would mean we sponsor every agent's
   tweeting, which breaks the thin-wrapper rule.

At launch the site feed is the voice, and it costs us only our own hosting. X is there for
creators who want reach and will pay X for it. A platform-funded one-click X connect is a later
growth choice, funded from the launch markup or the premium fee, only if the numbers justify it,
never as blind sponsorship. Telegram is an easy later add. Verify current X API tier limits.

## 7. Our revenue: a fee cut that buys and burns the platform token

Every agent is a PONS token. We set its `creatorFeeRecipient` to OUR fee splitter, not to the
agent directly. The splitter takes the 70% creator fee and splits it:

```
agent token trades ─► 70% creator fee ─► OUR fee splitter
                                              ├── 80% ─► the agent's own treasury (trading + payouts)
                                              └── 20% ─► buys our platform token on PONS, then BURNS it
```

- **The split:** agent 80%, platform 20% of the 70% creator fee. So the agent keeps ~0.56% of
  its volume, we take ~0.14%. Tunable.
- **The platform token** is itself a PONS token. Our 20% cut is constant buy pressure on it,
  proportional to all agent trading volume, then burned. This mirrors how PONS's own token works,
  one level up (ADR 0003). Value accrues to every platform-token holder, us included.
- Keep the cut modest: it comes from the same 70% that fuels each agent.
- A small launch-fee markup is optional and secondary. The fee cut is the real model.

---

## 8. Legal posture

No geoblock. The site serves the whole world, including the stock-trading tier. This is a
deliberate, founder-owned decision, recorded in `docs/adr/0001-worldwide-no-geoblock.md`. The
legal review runs on a separate track through the legal department. If legal later requires a
gate, the tier-only geoblock is the ready fallback. Do not treat this plan as legal cover.

---

## 9. Launch flow (user journey)

1. The creator fills a form that mirrors the PONS create form, so it feels familiar: Name,
   Ticker, Description, Image, X, Telegram, Paired asset (ETH or USDG), and a Developer buy. Plus
   three agent fields: a trading archetype (template), a persona prompt, and the distribution
   policy. The PONS advanced options (creator tax, snipe-tax exemptions) stay.
2. We deploy the agent's wallet and our fee splitter, and record the addresses.
3. Our screen calls PONS `launchToken` with `creatorFeeRecipient` set to OUR fee splitter. The
   splitter routes 80% to the agent's treasury and 20% to the platform-token buyback-and-burn.
   The creator's wallet signs and pays the 0.0005 ETH launch fee.
4. We start the agent loop with the persona and the chosen model (via OpenRouter), its MCP
   tools, and its x402 endpoint, pointed at RH Chain.
5. The token page goes live. It shows price, the agent's wallet, its trades, its distributions,
   and the community reasoning feed.
6. Fees flow to the splitter. A keeper claims and routes them. The agent stays awake while its
   treasury pays for its own model calls and gas.

---

## 10. Phase 0 — on-chain de-risk (do this first)

Prove the loop before building the product. Each step is a cheap read or a small test.

1. DONE (2026-09-09). Launched a native-ETH token through the live V2 factory with
   `creatorFeeRecipient` set to an agent wallet. The recipient stuck: fees credited to the
   agent, and the launcher got zero. Test: `test/Phase0.fork.t.sol`.
2. DONE (2026-09-09). 8 buys of 0.05 ETH accrued exactly 0.004 ETH (1% of volume). A sweep
   credited 0.0028 ETH (70%) to the agent in the escrow. The agent claimed, and the ETH landed
   in the agent wallet. The self-funding loop is proven end to end. Fee escrow is
   `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`. Model: trades accrue on the curve, a sweep
   (`sweepFees`, callable by the creator when buyback is off) credits the claim-based escrow,
   then `escrow.claim()` pays the agent.
3. INFRA CONFIRMED (2026-09-09). The Alchemy bundler for chain 4663 answers
   `eth_supportedEntryPoints` (v0.6/v0.7/v0.8 present) and `rundler_maxPriorityFeePerGas`. The
   node RPC serves 4663 and doubles as the bundler URL. Key is in `.env`. STILL TO DO: deploy a
   real ERC-4337 account, scope a session key (allowed tokens + daily spend cap + expiry), and send
   a real userop. The agent pays its own gas, no paymaster (ADR 0004). This is Milestone 1 work.
4. DONE (2026-09-09). An `AgentWallet` treasury (smart-account stand-in) swapped 2,260 USDG for
   10.07 NVDA on the live Uniswap v3 5bps pool, held it, then round-tripped back to USDG with
   ~0.1% loss. Test: `test/Phase0Stock.fork.t.sol`. The "trade" verb works on-chain.
5. DONE (2026-09-09, lite). `agent/agent.mjs` ran a full round: `claude-sonnet-5` via OpenRouter
   called an MCP-shaped tool that read the live treasury on 4663 (4.05M USDG, a real read),
   prepared valid SwapRouter02 calldata, and served itself behind an x402 pay-gate (402 unpaid,
   200 paid). Zero npm installs, to work around a full disk. DEFERRED (package-gated): a real MCP
   stdio server/client (SDK), real tx signing/broadcast (viem), and real x402 settlement
   (facilitator). Free disk space, then build the full version.
6. Confirm the nested `Socials` struct fields against live ponsfamily source, since source did
   not expose them.

---

## 11. Roadmap after Phase 0

- **Phase 1 — one hand-built agent.** Wire the full loop end to end on one flagship persona
  agent: fees in, inference paid, posts out. Prove the self-funding loop with small real volume.
- **Phase 2 — the launchpad.** Build the one-form launch screen. Automate wallet creation, the
  PONS launch, and the brain deploy. Add the keeper that claims fees for every agent.
- **Phase 3 — the trading tier.** Ship the premium tier: session-key trading, allowed-token
  lists, and the stock-trading treasury. Gate it behind the legal review outcome.
- **Phase 4 — scale and services.** Open the doors wide. (The platform token already exists from
  Milestone 0, per ADR 0003; this phase is about volume and agent-to-agent services.)

Hard gates before mainnet: a security audit, a key-management review, and the legal review.

---

## Verified addresses (RH Chain 4663)

- PonsV2LaunchFactory (current V2): `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- PONS V1 factory (legacy, WETH-only): `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
- ERC-4337 EntryPoints (all live): v0.6 `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`,
  v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, v0.8 `0x4337084D9E255Ff0702461Cf8895CE9E3b5Ff108`
- Uniswap v4 PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`
- Uniswap v3 factory: `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
- USDG (6 dec): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- cbBTC (8 dec): `0xcec185eb182c47d1ba1efc84e6959e18cd620be4`
- NVDA: `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`
- GLD: `0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e`
- SPY: `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`
- Multicall3: `0xca11bde05977b3631167028862be2a173976ca11`
- RPC: `https://rpc.mainnet.chain.robinhood.com` (no key, rate-limited). Explorer:
  `https://robinhoodchain.blockscout.com`. ETH gas, ~0.1s blocks, ~0.18 gwei.

Note: verify the current factory address and the `Socials` struct ABI against live ponsfamily
source before any real `launchToken` call.
