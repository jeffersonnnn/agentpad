# ERC-4337 userOp on Robinhood Chain 4663 (Arbitrum Orbit) — root cause and fix

Date: 2026-09-11. Status: root cause proven read-only; fix applied in code; paid proof pending.

## Question

The flagship agent's account-deploy userOp would not land on real Robinhood Chain 4663
(Arbitrum Orbit L2, EntryPoint v0.7). Self-bundled via `EntryPoint.handleOps` from a funded relayer,
the tx mined as `reverted` (a FailedOp). It worked on an anvil fork. Why, and how do we fix it?

## Method (no ETH spent)

We simulated the exact `handleOps` call read-only via `eth_call` and decoded the revert, and we probed
the Alchemy bundler read-only (`eth_supportedEntryPoints`, `eth_estimateUserOperationGas`). Scripts:
`scratchpad/diagnose_userop.mjs`, `scratchpad/probe_bundler.mjs`, `scratchpad/probe_kernelclient.mjs`.

## Root cause: `FailedOp(0, "AA21 didn't pay prefund")`

EntryPoint v0.7 with no paymaster requires the account to prefund, from its OWN balance:

    requiredPrefund = (callGasLimit + verificationGasLimit + preVerificationGas) * maxFeePerGas

Our `submitViaHandleOps` pinned deliberately generous gas: `verificationGasLimit 5_000_000`,
`callGasLimit 2_000_000`, `preVerificationGas 500_000`, `maxPriorityFeePerGas 1 gwei`. At the live
base fee that is a required prefund of ~**0.0091 ETH**, but the agent account holds **0.005 ETH** →
AA21. The anvil fork never caught it because fork accounts hold unlimited ETH.

**Correction of the earlier theory.** The blocker was NOT "preVerificationGas too low for the Orbit
L1 data fee." In EntryPoint v0.7, preVerificationGas is only summed into the prefund and later credited
to the beneficiary; it is never independently checked against the true L1 poster cost. A too-low PVG is
an economic, bundler-side / mempool rejection (ERC-7562), never a hard on-chain FailedOp. Self-submitted
`handleOps` bypasses that check, so PVG did not cause the revert.

## Why the bundler cannot be the submit path here: banned opcode CREATE2

The obvious fix would be "let the live Alchemy bundler size the gas." Robinhood Chain 4663 does run a
working Alchemy Rundler bundler at the same base URL (`eth_supportedEntryPoints` returns the v0.7
EntryPoint live; docs <https://docs.robinhood.com/chain/account-abstraction/>), and its
`eth_estimateUserOperationGas` right-sizes the SAME deploy op:

| field | pinned self-bundle (old) | live bundler estimate |
|---|---|---|
| verificationGasLimit | 5,000,000 | 306,831 |
| callGasLimit | 2,000,000 | 9,100 |
| preVerificationGas | 500,000 | 52,128 (includes Orbit L1 component) |
| maxPriorityFeePerGas | 1 gwei | 0 (but see below) |

BUT submitting the deploy through the bundler (`eth_sendUserOperation`) is REJECTED:
`account uses banned opcode: CREATE2` (code -32502). That is an ERC-7562 mempool validation rule:
bundlers ban CREATE2 during validation (except the factory's single sender deploy) to protect the shared
mempool. The ZeroDev Kernel v3.1 factory deploy trips it on this bundler. Two smaller bundler frictions
were also found and handled: (1) the ZeroDev-only `zd_getUserOperationGasPrice` RPC is unimplemented
(fixed by our `feeEstimator`); (2) the bundler enforces a **minimum** `maxPriorityFeePerGas` and rejects
0 — the standard `eth_maxPriorityFeePerGas` returns 0 on this Orbit chain, so the fee must come from
Rundler's `rundler_maxPriorityFeePerGas` extension.

## The fix: self-bundle via handleOps with RIGHT-SIZED gas

Direct `EntryPoint.handleOps` submission from our own funded relayer does NOT run the ERC-7562 mempool
opcode rules (the EntryPoint contract has no such restriction), so it accepts the Kernel CREATE2 deploy.
The self-bundle path was correct all along; ONLY its oversized pinned gas was wrong. Fix: shrink the
pinned limits to right-sized values that keep the prefund a small fraction of a funded account:

| field | old pinned | new pinned |
|---|---|---|
| callGasLimit | 2,000,000 | 1,500,000 |
| verificationGasLimit | 5,000,000 | 2,000,000 |
| preVerificationGas | 500,000 | 200,000 |
| maxPriorityFeePerGas | 1 gwei | 0.1 gwei |
| **required prefund** | **~0.0091 ETH (> 0.005 balance → AA21)** | **~0.0012 ETH (fits 0.005)** |

(On the handleOps path preVerificationGas is only credited to the relayer; the relayer's own tx pays the
Orbit L1 data fee, so PVG need not cover the L1 component.) This is the mainnet submit path for 4663:
`AGENT_SUBMIT=handleops` + `AGENT_RELAYER_KEY` = the deployer, which the production loop/keeper already
support. The `feeEstimator` fix (Rundler priority floor) still matters for any bundler-path use such as
read-only `eth_estimateUserOperationGas`.

PROVEN on real 4663 (2026-09-11): account deploy tx `0x17f778d5…`, then the first autonomous trade
1 USDG → 0.00988 SGOV, tx `0xead6bdf1…` (status 0x1), session-key signed, submitted via handleOps.

## Code changes applied (all in `agent/lib/stack-zerodev.mjs`)

1. **Right-sized the pinned gas** in `submitViaHandleOps` (table above) so the account prefund fits a
   small funded balance — the actual AA21 fix.
2. Added a **prefund preflight guard** to `submitViaHandleOps`: if the account balance < requiredPrefund,
   throw a clear "AA21 shortfall" error before spending relayer gas, instead of the opaque on-chain revert.
3. Rewrote `feeEstimator` to read Rundler's `rundler_maxPriorityFeePerGas` (with a +20% margin) for the
   priority-fee floor, falling back to the node estimate on a fork. Needed for the bundler-path (reads /
   gas estimation); `eth_maxPriorityFeePerGas` returns 0 here and the bundler rejects 0.
4. Grant flow: verify address → build grant → SAVE approval + session key to
   `agent/.secrets/session-<id>.json` (0600) FIRST → deploy via handleOps (relayer = deployer).

## EntryPoint v0.7 FailedOp codes (reference)

`AA21` didn't pay prefund (account balance/deposit too low); `AA23` validateUserOp reverted/OOG;
`AA24` signature error; `AA25` bad nonce; `AA31` paymaster deposit too low; `AA40` over
verificationGasLimit; `AA41` verificationGas too little; `AA51` prefund below actual cost; `AA95` inner
out of gas (a real Orbit trap when the outer tx gas is starved by the L1 poster component — mitigated
here by using the bundler, which sizes the outer submit).

## Sources

- Robinhood Chain AA docs: <https://docs.robinhood.com/chain/account-abstraction/>
- EntryPoint v0.7 revert codes: <https://www.alchemy.com/docs/wallets/reference/entrypoint-v07-revert-codes>
- eth-infinitism EntryPoint.sol: <https://github.com/eth-infinitism/account-abstraction/blob/develop/contracts/core/EntryPoint.sol>
- Arbitrum L1 gas pricing (poster fee): <https://docs.arbitrum.io/how-arbitrum-works/l1-gas-pricing>
- Alchemy L2 gas + PVG surcharge: <https://www.alchemy.com/blog/l2-gas-and-signature-aggregators>
- Alchemy Rundler: <https://github.com/alchemyplatform/rundler>
