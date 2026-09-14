# Redeemable basket - build plan (testnet to mainnet)

Implements ADR 0006. A holder burns (retires to dead) their agent coin and receives a pro-rata
share of the agent's treasury basket. Redemption is ADDITIVE to the live USDG distribution, off by
default per agent, and it ships testnet-first. No mainnet deployment until the audit, the forge fork
tests, and a full testnet redemption cycle all pass and the owner gives an explicit go.

## Ground rules
- Do NOT change the settled Distributor, FeeSplitter, or AgentWallet. The Redeemer is a NEW contract
  that sits beside them.
- Redemption retires the redeemed coin to 0x000...dEaD (the established burn convention). It never
  touches the PONS curve reserve.
- Redemption is capped to the SECURITIES sleeve of the treasury plus its free USDG. It excludes the
  curve reserve and excludes USDG already committed to the Distributor's outstanding liabilities.
- Every fund-moving path is snapshot-based and bounded per epoch (no live-NAV redemption).
- Same house rules as the rest of the repo: no em dashes, secrets only in gitignored .env, verify
  with /real-world-test, additive DB migrations applied to Neon directly.

## Phase 0 - Design lock and fact-find  (0.5 day)
Gate: a one-page interface spec agreed, no open unknowns.
1. Confirm PONS V2 read paths: circulating supply = total supply minus (dead, curve, pool, splitter,
   treasury/account, distributor, redeemer). Reuse the keeper's existing `snapshotHolders` exclude set.
2. Confirm the treasury basket read: the ERC-4337 account's balances of USDG plus each allowed
   security (positions table plus a live on-chain read). Define "free USDG" = account USDG minus the
   Distributor's outstanding committed-but-unclaimed liabilities.
3. Lock the Redeemer ABI (Phase 1) and the leaf hashing that binds the basket to the holder.
4. Decide cadence and sleeve knobs for the creator switch (default off).

## Phase 1 - Contract: src/Redeemer.sol  (2 days)
Gate: compiles, NatSpec complete, mirrors Distributor's safety shape.
- Per agent, token-agnostic. Roles: owner + keeper (same pattern as Distributor).
- `setEpoch(epoch, root, address[] tokens, uint256[] totals)`: one-time per epoch; requires the
  contract already holds `totals[i]` of each `tokens[i]` (full-funding invariant per token) before the
  root is set. Records the epoch's token list and totals.
- `redeem(epoch, index, account, coinAmount, address[] tokens, uint256[] amounts, bytes32[] proof)`:
  verify the Merkle leaf; pull `coinAmount` of the agent coin from `account` (prior ERC20 approve) to
  0x000...dEaD; transfer each `tokens[i] amounts[i]` to `account`; mark the leaf claimed (bitmap).
  Leaf = keccak256(abi.encodePacked(epoch, index, account, coinAmount, keccak256(abi.encode(tokens, amounts)))).
- Guards: reentrancy guard, pause, exact-sum-per-token invariant, zero-address checks, `rescue` for
  stuck tokens (owner), events for every state change.
- Deploy is per agent at finalizeLaunch (or a factory), like the Distributor.

## Phase 2 - Tests: test/Redeemer.fork.t.sol  (2 days)
Gate: forge test green, coverage matches Distributor.fork.t.sol.
- Happy path: fund, setEpoch, a holder redeems, coin lands at dead, basket received, claimed flips.
- Full-funding invariant: setEpoch reverts if any token is under-funded.
- Rejections: double-claim, wrong proof, wrong basket, wrong coinAmount, paused.
- Accounting: per-token totals equal the sum of leaves (exact-sum), circulating supply drops by the
  retired coin, curve reserve unchanged.
- Fork against RH Chain 4663 state with the real USDG and a real security token.

## Phase 3 - Keeper integration (off-chain)  (2 days)
Gate: a dry-run epoch computes a correct, exact-sum basket split against real agent state.
- `redeem_config` table (agent_id PK, mode off|on, cadence, sleeve, updated_at), additive on Neon.
- `runRedemptionEpoch(agent)` in the keeper: snapshot holders at a pinned block (reuse
  `holder_snapshots`), read the securities sleeve plus free USDG, compute each holder's pro-rata slice
  per token (deterministic, remainder to the largest holder, exact-sum), move the epoch's assets from
  the ERC-4337 account into the Redeemer via the owner-execute seam (ADR 0004), then `setEpoch`.
- Persist a `redemptions` table (agent_id, epoch, tokens, totals, root, to_block, ts).
- Creator switch is read here; off by default so nothing redeems until a creator opts in.

## Phase 4 - Frontend: Redeem card + control  (1.5 days)
Gate: read-only card renders against testnet data; approve+redeem builds correct calldata.
- `GET /api/agents/:id/redeem` (proof per holder per epoch, mirrors the claim route) and a redemptions
  list route.
- `RedeemCard`: NAV per coin, the holder's redeemable basket for the open epoch, an approve-then-redeem
  flow (holder wallet only; the server never signs). Show "nothing to redeem" and a disabled state when
  the switch is off.
- Control panel: a creator-signed redeem switch (off by default), cadence, sleeve.

## Phase 5 - Testnet cycle (the real on-chain /real-world-test)  (1 day)
Gate: one full redemption observed end-to-end on testnet, on the explorer.
- Deploy Redeemer to testnet (or an anvil fork of RH Chain). Fund a test agent, snapshot, setEpoch,
  redeem from a real test holder wallet. Observe: coin at dead, basket received, claimed set, supply
  dropped, curve untouched. This is the honest depth test the contract path needs (synthetic DB rows
  cannot verify a fund-moving contract).

## Phase 6 - Audit and review  (external, parallel from Phase 2)
Gate: audit report clean, owner-execute seam reviewed, legal confirms the shipped shape matches.
- External audit of Redeemer.sol and the keeper transfer path.
- Re-confirm the shipped mechanism equals what legal and the SEC reviewed (per ADR 0006).

## Phase 7 - Mainnet rollout (staged, gated)  (1 day + watch)
Gate: owner's explicit mainnet go.
- Deploy the Redeemer (per agent or factory) on mainnet.
- Enable ONE pilot agent (creator opt-in), a small basket, run one real epoch, verify on the explorer.
- Then open the creator switch generally.
- Monitoring: treasury-drain alerts, NAV vs curve price, redemption volume, per-epoch exact-sum checks.

## Rough timeline
Phases 0-4 are about 8 working days of build. Phases 2 and 6 (tests and audit) overlap. The critical
path to a mainnet pilot is: contract -> fork tests -> keeper -> testnet cycle -> audit -> pilot. Call
it 2 to 3 weeks to a gated mainnet pilot, audit turnaround dependent.

## What I will NOT do without an explicit go
- Deploy any Redeemer to mainnet.
- Move any real treasury assets into a Redeemer on mainnet.
- Enable the creator switch on a live agent before the pilot passes.
