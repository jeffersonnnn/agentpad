# Token holders receive distributed trading profits

---
status: accepted
---

Each agent trades its own fee-funded treasury in tokenized stocks and RWA. We decided that the
agent distributes its trading profits to its token holders (pro-rata), because it gives the
strongest reason to hold the token. This supersedes the earlier framing that the agent only
trades its own money and returns nothing to holders. The legal characterization is routed to the
legal department.

## Considered options

- **Pure speculation** (no mechanical link to the treasury). Rejected: weak reason to hold.
- **Buyback and burn from profits.** Rejected in favour of a direct distribution, though it is the
  lower-legal-risk fallback if legal requires it.
- **Profit distribution to holders (chosen).** Strongest pull for holders.
- **Redeemable / NAV-backed.** Also fund-like; not chosen.

## Consequences

- This is the strongest "investment contract" signal in the whole design. An autonomous vehicle
  that trades and pays trading profits to token holders looks like a fund paying dividends,
  regardless of where the starting capital came from.
- It is in direct tension with the "the agent is not a fund" positioning. That positioning no
  longer holds once profits are distributed.
- It is hard to reverse: once holders expect distributions, removing them breaks the promise.
- The lower-risk fallback, if legal requires it, is buyback-and-burn (no cash to holders).
- The distribution POLICY is fully creator-configurable per agent (distribute or buyback, the
  rate, the cadence, on or off). So every agent is its own tokenomics profile, and legal's document
  must cover that whole configurable space, not one design. Legal is drafting it now.
- The configurable policy sits on a mechanically-sound payout ENGINE that never changes: it pays
  only realized, banked USDG, only above a high-water mark, only on fresh prices. "Configurable"
  is the knobs, never a broken payout.
- Legal review (see ADR 0001) must clear the mechanism and the configurable space before it ships.
