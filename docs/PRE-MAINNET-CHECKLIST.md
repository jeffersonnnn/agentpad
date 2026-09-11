# Pre-mainnet checklist

On-chain steps and gates that spend real ETH or need a human, deferred out of the staged build.
Nothing here blocks building M1-M5; each item MUST be done before the first mainnet agent launch.
Everything below was flagged by a real-world-test, not silently assumed.

## On-chain provisioning (spends ETH, needs a funded key)

- [x] **Fund the deployer key** `0x04752Da4639a436416a94c436526aF34D7fbC61c` with ETH on 4663.
      DONE 2026-09-11: funded ~0.0172 ETH.
- [x] **Deploy the ZeroDev rate-limit policy module** `0xf63d4139B25c836334edD76641356c6b74C86873`
      on 4663. DONE 2026-09-11 via the standard CREATE2 factory `0x4e59b448…` (salt 0, ZeroDev's exact
      init code recovered from the Arbitrum deployment and verified to reproduce the canonical address).
      Deploy tx `0xbe7d9eaf9916f5cc4ab1ae0c163485c849ac40fd43abaffb63634229b03f63b2` (block 60278968,
      gasUsed 430212, cost ~0.0000485 ETH). Runtime is byte-identical to Base (1739 bytes).
      All FOUR permission modules verified present on 4663 (2026-09-11): ECDSA signer
      `0x6A6F069E…D4FF` (1609B), call-policy v0.0.4 `0x9a522832…eaf2` (6539B), rate-limit
      `0xf63d4139…` (1739B), timestamp `0xB9f8f524…E20F` (1441B). Session keys can now be enabled.
- [x] **Live userop on real 4663 — SOLVED + PROVEN end to end (2026-09-11).** Diagnosed read-only
      (simulated `EntryPoint.handleOps` via `eth_call`, no ETH spent): the revert was
      `FailedOp(0, "AA21 didn't pay prefund")`. Root cause: `submitViaHandleOps` pinned oversized gas
      (`verificationGasLimit 5_000_000`, `callGasLimit 2_000_000`, `preVerificationGas 500_000`,
      `maxPriorityFeePerGas 1 gwei`). With no paymaster, EntryPoint v0.7 makes the account prefund
      `(cgl+vgl+pvg) * maxFeePerGas` ≈ **0.0091 ETH** from its OWN balance, but the account holds
      **0.005 ETH** → AA21. The anvil fork hid it (fork accounts hold unlimited ETH). It was NOT
      preVerificationGas being too low for the Orbit L1 fee — a low PVG is only a bundler-side economic
      check, never a hard EntryPoint revert.
      Why not just use the live bundler (it right-sizes gas): Robinhood 4663 DOES run an Alchemy Rundler
      bundler, but `eth_sendUserOperation` REJECTS the ZeroDev Kernel deploy with `account uses banned
      opcode: CREATE2` (an ERC-7562 mempool rule). Direct `handleOps` from our own relayer does not run
      those mempool rules, so it accepts the deploy. **Mainnet submit path = `AGENT_SUBMIT=handleops` +
      `AGENT_RELAYER_KEY`=deployer with right-sized gas** (production loop/keeper already support this).
      FIX applied in `agent/lib/stack-zerodev.mjs`: right-sized the pinned gas (cgl 1.5M / vgl 2M / pvg
      200k / priority 0.1 gwei → prefund ≈ 0.0012 ETH, fits); added a prefund preflight guard (clear
      "AA21 shortfall" error, not a silent revert); rewrote `feeEstimator` to use Rundler's
      `rundler_maxPriorityFeePerGas` (the bundler rejects a 0 priority fee). Grant flow now SAVES the
      approval + session key to `agent/.secrets/session-ef0bef8f-…json` (0600) FIRST, then deploys.
      PROVEN on real 4663: account deploy tx `0x17f778d53f851b4a140c7e602dec076b883da8ec7185e204dee6248ec9c7c265`,
      then the first autonomous trade **1 USDG → 0.00988 SGOV**, tx
      `0xead6bdf12eb7478e4814e58171858fd9455c0afb1df4db91477247834fd4e4c3` (status 0x1, block 60438029),
      session-key signed + policy-scoped, verified on-chain. See `docs/research/erc4337-orbit-userop.md`.
- [x] **Redistribution to holders — PROVEN on real 4663 (2026-09-11).** Full payout path with real USDG:
      the deployer bought Powell tokens on the curve (real holder + real creator fee; buy tx `0xe1cbd14e…`),
      the keeper's exact snapshot/Merkle helpers (`snapshotHolders`/`computeDistribution`/`leafHash`/
      `buildMerkleTree`) selected that holder, 1 USDG moved from the treasury into the per-agent Distributor
      via owner-execute (fund tx `0xc287751a…`, same mechanism as `fundDistributorFromTreasury`), the root
      was published (`setRoot` tx `0xa2389050…`), and the holder claimed on-chain (claim tx `0xdca48408…`).
      Verified: holder +1 USDG, treasury 4→3, Distributor drained to 0; a `distribution` feed row renders on
      the agent page + Square. TWO honest caveats:
      1. The 1 USDG was a **seeded test amount**, not earned trading profit. The realized-gain engine
         (SPEC 3) pays out only `(cumulativeRealized − high-water) × rate_bps`, and real trading profit
         takes time (a quick round-trip realizes a small loss after fees). The on-chain PLUMBING is what
         this proved; the engine's realized-gain gate is fork-proven.
      2. The proof snapshotted at the CURRENT block; the cron pins the snapshot to the epoch boundary. And
         the holder snapshot scans Transfer logs — the **free Alchemy tier caps `eth_getLogs` at 10 blocks**,
         so the production keeper needs a paid RPC tier OR a bounded `KEEPER_LOG_FROM_BLOCK` window (default
         is block 0, which is infeasible on the free tier for a mature token).

## Platform token (Milestone 0, launched LAST)

- [ ] **Launch the platform token** on PONS near go-live (creator-signed, spends ETH) and append
      BOTH its token address as `PLATFORM_TOKEN` and its curve address as `PLATFORM_CURVE` to `.env`
      (the splitter needs the curve to buy-and-burn, not just the token). Until then the splitter
      holds its 20% as USDG and flips to buy-and-burn once set (proven at M1).
- [ ] **Re-run a fork test of the 20% buy-and-burn against the REAL platform curve** (M1 proved it
      only against a mock curve, since the token launches last).
- [ ] **Resolve the post-graduation v4 buy path** (SPEC 10.3): once the platform token graduates
      (4.2 ETH, LP locks in v4), `curve.buy` reverts; wire the PonsV2MemeHook / v4 swap route for
      the burn. `curve.buy` to the dead address works until graduation.

## Milestone 2 (x402 settlement)

- x402 facilitator RESOLVED (2026-09-10): SELF-HOSTED default, `remote` adapter wired for later (SPEC 10.2).
- [ ] **Correct the x402 EIP-712 domain** in `agent/x402.mjs` to the real live USDG values (name
      `"Global Dollar"`, version recovered from `DOMAIN_SEPARATOR()`); confirm EIP-3009 on USDG; then
      observe one real self-facilitator settle on a 4663 fork. (Pending M2 code fix.)
- [ ] **Fund the settle relay key** (`X402_SETTLER_KEY`, falls back to `DEPLOYER_KEY`) so the
      self facilitator can broadcast settlements (a small per-call gas cost).

## Milestone 4 refinements (frontend; not blockers)

- [x] Agent-page price read now probes the token's ACTUAL pair (USDG 6dp or ETH 18dp), not ETH only
      (`web/components/agent/onchain.ts` `useCurvePrice`). REMAINING GAP: a holdings-free USDG `curve.buy`
      simulation reverts without a state override, so a LIVE USDG spot price still degrades to
      "unavailable". To finish it, add an `eth_call` state override using the USDG allowance storage
      slot (FACTS gives only balance slot 1), OR read the graduated Uniswap v4 pool (no v4 quoter
      address/ABI in the repo yet). Not a blocker; the page renders correctly without the number.
- [x] Snipe-tax exemptions field DROPPED from the create form (3-arg `launchToken` overload kept; the
      splitter is auto-exempt as recipient != deployer). Decided in ADR 0005 phase (2026-09-11). Re-add
      the 4-arg overload only if a creator ever needs manual exemptions.
- [ ] Developer buy uses `minTokensOut=0` (relies on the PONS 2-block guard + 5.5% cap). Add a
      QuoterV2 min-out if tighter launch slippage protection is wanted.
- [ ] X connect stores the creator's X keys in a gitignored per-agent file
      `agent/.secrets/socials-<id>.json` (mode 0600). Fine for the laptop-to-mainnet path. BEFORE a
      multi-agent VPS: move to an encrypted DB column (KMS/managed key), materialized to the file only
      at loop start, so host disk access alone does not expose creator X keys. (ADR 0005 / SPEC 11.6.)

## Milestone 5 keeper refinements (tied to platform token / graduation)

- [ ] Keeper fee-route feed message says "bought and burned" even when the 20% is only HELD
      (PLATFORM_TOKEN unset). Read `splitter.platformToken() != 0` or the `Routed` event and log
      "held for buy-and-burn" vs "bought and burned" accordingly.
- [ ] Keeper calls only the no-arg `claimAndRoute()`. Once the platform token is set, call the
      parameterized `claimAndRoute(minUsdgOut, minPlatformOut)` overload with off-chain quotes so the
      platform buy is not left at `minPlatformOut = 0` (the ETH->USDG leg has the QuoterV2 floor).
- [ ] Post-graduation, the agent's Uniswap v4 pool is NOT excluded from the holder snapshot, so it
      would receive a distribution share. Add `agents.pool_addr`, set it at graduation, and add it to
      the keeper's exclude set (alongside `curve_addr`). Graduation-gated.
- [ ] Clarify keeper signing: `setRoot`/`claimAndRoute` work because the keeper signs as
      `DEPLOYER_KEY` (= Distributor/splitter owner). If a separate `KEEPER_ADDRESS` is used, wire a
      `KEEPER_KEY` and document the split; otherwise document that the keeper acts as the deployer.

## Hard gates (already in README / BUILD)

- [ ] Security audit, the FeeSplitter especially (M1 audit fixed 6 findings; a formal audit is still required).
- [ ] Key-management review: session-key custody, daily rotation (the TTL == rate-limit-interval
      assumption depends on rotation), and the deployer key.
- [ ] Legal review (ADR 0001 no geoblock, ADR 0002 profit distribution, ADR 0003 platform token).
