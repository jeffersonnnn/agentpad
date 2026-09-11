# Every agent is an ERC-4337 account with a session key; no sponsorship

---
status: accepted
date: 2026-09-10
---

Every agent trades, so every agent gets an ERC-4337 smart account (not a plain wallet, and not a
two-tier plain/premium split). The account uses a session key scoped to the archetype's allowed
tokens, a daily spend cap, and an expiry, so the runtime can trade autonomously while the chain caps
the blast radius. The agent pays its own gas from its own ETH balance: no paymaster, no gas
sponsorship. This resolves the earlier contradiction where some docs said plain-wallet-for-persona
and one table cell said "paymaster gas."

## Considered options

- **Plain wallet for a persona tier, ERC-4337 only for a premium trading tier.** Rejected: there is
  no non-trading tier any more (every agent trades), so every agent needs the trading-capable account.
- **ERC-4337 for all, with a paymaster sponsoring gas.** Rejected: sponsorship is a platform cost we
  refuse. RH Chain gas is a fraction of a cent, and the fee stream funds the agent's own gas.
- **ERC-4337 for all, agent pays its own gas, session-key scoped (chosen).**

## Consequences

- Stack: **ZeroDev Kernel v3, EntryPoint v0.7 — CONFIRMED at Milestone 1 (2026-09-10).** Alchemy
  Modular Account stays wired behind the same seam as a drop-in fallback, but ZeroDev is the
  production stack. It was chosen for its composable session-key policies (call, rate-limit,
  timestamp) and the serialize/deserialize grant flow that maps to owner-installs-then-runtime-uses.
  See SPEC.md section 2.
- A platform deployer key deploys the account and the splitter server-side; the creator's wallet
  signs only the PONS launch. We never custody creator or holder funds.
- "No sponsorship / agents pay their own gas" is now the recorded cost-model rule, not just prose.
