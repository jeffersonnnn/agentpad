# Build workflows (run in order, post-compact)

Each script is a self-contained Workflow. Its agents read the repo docs
(`README → PLAN → CONTEXT → FACTS → SPEC → BUILD` + `docs/adr/`) with no conversation context, build
distinct files (so they never clobber each other), then a verify stage compiles/tests. Money-touching
contracts also get an adversarial review pass.

Every milestone ends with a **recursive real-world-test** phase (the `real-world-test` skill's
discipline). "Verify" only proves the code compiles and the tests pass. Real-world-test proves the
milestone's LOAD-BEARING ASSUMPTIONS are directly OBSERVED against reality: the live RPC, the Alchemy
bundler, real OpenRouter, a real fork, the real backend, the running app. A claim that cannot be
observed (because an OPEN item is unresolved) is flagged NOT observed, never asserted as done.
"Recursive" means each milestone also re-observes the anchor claims of every prior milestone, so an
integration change that breaks an earlier proof is caught. A milestone is only "done" when its
real-world-test reports `all_load_bearing_observed=true`; otherwise fix what it flags and re-run.

Run each with: `Workflow({scriptPath: "workflows/<file>.js"})`. Read the result, fix anything the
verify/review stage flags, then run the next. You stay in the loop between milestones — the parts
have hard dependencies (addresses, ABIs, schema), so do NOT run them all at once.

| Order | File | Builds | Depends on |
|---|---|---|---|
| M0 | (deploy-time config, done LAST) | Launch the platform token on PONS and append its address to `.env` as `PLATFORM_TOKEN`. Spends ETH, creator-signed. NOT a build blocker. | — |
| M1 | `m1-contracts.js` | The per-agent fee splitter (+fork test) and the agent ERC-4337 account + session-key setup | the proven Phase 0 harness (uses a mock platform token; reads `PLATFORM_TOKEN` at deploy) |
| M2 | `m2-brain.js` | MCP servers (chain, market, socials), the OpenRouter loop, the Merkle profit distributor (+test), the x402 endpoint | M1 |
| M3 | `m3-backend.js` | Postgres schema, launch orchestration (creatorFeeRecipient=splitter), the fee-sweep keeper | M1 |
| M4 | `m4-frontend.js` | The PONS-style launch form and the agent page (price, wallet, trades, distributions, reasoning feed) | M3 |
| M5 | `m5-flagship.js` | Wire one flagship agent end to end and review the whole loop | M1-M4 |

Open items the scripts will surface (SPEC.md section 10), resolve when hit:
1. Account stack (ZeroDev Kernel vs Alchemy Modular Account) — M1.
2. x402 facilitator for chain 4663 — M2.
3. Post-graduation v4 buy path for the platform token — M1 (curve.buy to a dead address works pre-graduation).

Secrets expected in `.env`: `ALCHEMY_KEY`, `ROBINHOOD_ALCHEMY_RPC`, `OPENROUTER_KEY`, and (add for M3) a
platform `DEPLOYER_KEY`. Hard gates before mainnet: security audit (the splitter especially),
key-management review, legal review (ADR 0001, 0002, 0003).
