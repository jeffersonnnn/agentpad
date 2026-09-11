# A platform token, bought and burned with a cut of every agent's creator fees

---
status: accepted
---

Every agent is a PONS token, so we capture value the PONS-native way. We set each agent's
`creatorFeeRecipient` to our own fee splitter. The splitter routes 80% of the 70% creator fee to
the agent's treasury and 20% to buy our platform token on PONS and burn it. The platform token is
itself a PONS token. This reverses the earlier decision to take no fee cut and issue no platform
token.

## Considered options

- **No platform token, revenue from a launch markup only** (the earlier decision). Rejected:
  the creator asked for a fee cut that feeds a platform token, which captures value proportional
  to all agent volume, not just launches.
- **Fee cut buys and HOLDS the platform token in a treasury.** Rejected in favour of burn.
- **Fee cut buys and BURNS the platform token (chosen).** Mirrors PONS's own buyback-and-burn,
  is deflationary, and accrues value to every holder without us managing a treasury.

## Consequences

- Our revenue tracks aggregate agent trading volume, via constant buy-and-burn pressure on the
  platform token. This is the PONS flywheel, one level up.
- The 20% cut comes out of the same 70% that fuels each agent, so it reduces each agent's
  self-funding. Keep the cut modest; 80/20 is the starting split and is tunable.
- The platform token is a new asset with its own legal profile. It joins the legal review
  (ADR 0001, ADR 0002).
- A fee splitter contract is now on the critical path: `creatorFeeRecipient` points at it, it
  claims from the PONS escrow, and it routes the two shares. It must be audited.
