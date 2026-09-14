# Redeemable basket: holders burn the coin for a pro-rata share of the treasury

---
status: accepted (owner reports legal and SEC clearance 2026-09-14; supersedes ADR 0002's rejection of the redeemable model)
---

> Decision log: 2026-09-14, the owner reported that legal and the SEC cleared a redeemable
> NAV-backed claim. On that basis this ADR is accepted and it supersedes ADR 0002's rejection of
> the redeemable / NAV-backed option. This record reflects the owner's report of that clearance;
> it is not an independently verified regulatory document. Build proceeds testnet-first (see
> docs/REDEEMER-BUILD-PLAN.md).

A holder burns their agent coin and receives their pro-rata share of the agent's treasury
basket: the USDG plus the tokenized securities the agent bought (SGOV, SLV, GLD, and any other
allowed asset it holds). This makes the coin a direct claim on the assets, not only a claim on
distributed USDG profit. The goal is a "complete loop": holders end up owning the real assets.

## This reverses ADR 0002, on the highest-risk axis

ADR 0002 considered "Redeemable / NAV-backed" and rejected it as "also fund-like; not chosen."
ADR 0002 already calls the accepted USDG distribution "the strongest investment contract signal
in the whole design" and routes it to legal. A redeemable NAV claim is a step BEYOND that: a coin
that is redeemable for a pro-rata basket of assets is close to the textbook description of a
redeemable fund share or an ETF-like instrument. This ADR does not ship until:
1. The creator/owner accepts reversing ADR 0002.
2. Legal (see ADR 0001) clears a redeemable NAV claim specifically, not just the USDG distribution.
The lower-risk fallback ADR 0002 already names is buyback-and-burn (no cash, no assets, to holders).

## The core mechanism tension: bonding curve vs NAV

The agent coin trades on a PONS V2 bonding curve. Its price and liquidity come from the curve
reserve. The treasury (the ERC-4337 account) is a SEPARATE pool of USDG plus securities, funded by
fees. A redeemable-basket claim links the two, and the link is the whole design problem:

- NAV per coin = treasury basket value / circulating supply.
- If the curve price < NAV, it is profitable to buy the coin cheap on the curve and redeem it for
  more value. Rational holders drain the treasury until curve price rises to NAV or the treasury
  empties. So redemption sets a NAV price FLOOR on the coin (a feature) but also a DRAIN vector (a
  risk).
- If the curve price > NAV, no one redeems. Redemption is dormant.
- Burning the coin reduces supply. RESOLVED: the project's burn convention is "send to the dead
  address" (0x000...dEaD), never an ERC20 burn() (SPEC 3.8-3.9, the platform buy-and-burn). Tokens
  sitting at dead do not touch the curve reserve, so retiring redeemed coins to dead reduces
  circulating supply WITHOUT desyncing the PONS curve. Redemption therefore retires the redeemed
  coins to dead as the cost of the claim; the curve keeps working unchanged.

## Considered options for the mechanism

- **Continuous burn-to-redeem at live NAV.** Simplest to state, worst to secure: a live NAV read is
  gameable (price manipulation of a thin security pool right before redeeming), and the drain vector
  is unbounded. Rejected as the default.
- **Snapshot epoch redemption (recommended).** Reuse the proven distributor pattern: at a pinned
  block each epoch, snapshot balances and the treasury basket, compute each holder's pro-rata basket
  slice, and let them claim the ASSETS by Merkle proof from a per-agent, token-agnostic Redeemer that
  was pre-funded from the treasury via the owner-execute seam. No live-NAV gaming, bounded per epoch,
  same claim UX as the USDG distributor. This is the safe shape.
- **Redeem only the securities sleeve, never the curve reserve.** Cap what is redeemable to the
  treasury's asset holdings, explicitly excluding the curve reserve, so redemption can never drain the
  coin's own liquidity. Recommended as a constraint on top of the snapshot model.

## Recommended design (if it proceeds)

1. New `Redeemer` contract, per agent, token-agnostic (holds and pays an arbitrary set of ERC20s),
   mirroring `Distributor`: `setEpoch(epoch, root, tokens[], totals[])`, `redeem(epoch, index,
   account, tokens[], amounts[], proof)`, a full-funding invariant per token, owner/keeper roles.
2. The keeper, each redemption epoch: snapshot holders at a pinned block (reuse `holder_snapshots`),
   read the treasury basket, compute each holder's pro-rata slice per token, transfer the epoch's
   assets from the ERC-4337 account into the Redeemer via owner-execute (ADR 0004 seam), then set the
   root. Only the securities sleeve is eligible; the curve reserve is excluded.
3. Redemption RETIRES the claimed coin to the dead address (holder approves the Redeemer to move
   their claimed coin amount to 0x000...dEaD as a condition of the claim), so the claim and the supply
   reduction are atomic and the curve is never touched. This uses the established burn convention.
4. Creator control: a per-agent switch (off by default), the epoch cadence, and which sleeve is
   redeemable, all wallet-signed like the other control-panel writes. Off by default so no agent is
   redeemable until its creator opts in AND legal has cleared it.
5. UI: a "Redeem" card on the agent page showing NAV per coin, the holder's redeemable basket, and a
   claim button. Read-only until the contract exists.

## Consequences

- Highest securities-law exposure in the whole design. A redeemable pro-rata basket claim is the
  clearest "fund share" signal we could ship. Legal must clear it explicitly.
- New fund-moving Solidity that pulls real assets from the treasury. It needs forge fork tests, an
  external audit, and a testnet pass before mainnet. It cannot be "backtested with synthetic DB rows"
  the way the off-chain features were.
- It couples the coin price to a NAV floor and creates a treasury-drain vector that the snapshot +
  securities-sleeve-only constraints bound but do not remove.
- It is hard to reverse: once holders can redeem, removing redemption breaks a stronger promise than
  removing a distribution.
- If legal says no, buyback-and-burn (ADR 0002's stated fallback) delivers a value-return story with
  far less risk.

## Status and gate

Accepted 2026-09-14 on the owner's report of legal and SEC clearance. Build proceeds testnet-first
per docs/REDEEMER-BUILD-PLAN.md: no mainnet deployment until the contract passes forge fork tests, an
external audit, and a full testnet redemption cycle, and the owner gives an explicit mainnet go. The
redeemable switch is off by default per agent; each creator opts in. The proven USDG distribution
loop stays live in parallel; redemption is additive, not a replacement.
