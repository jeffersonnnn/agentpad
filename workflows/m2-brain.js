export const meta = {
  name: 'm2-brain',
  description: 'Milestone 2: build the agent brain - MCP servers (chain, market, socials), the OpenRouter loop, the Merkle profit distributor (+test), and the x402 endpoint, then verify and review',
  phases: [
    { title: 'Build', detail: 'six distinct components' },
    { title: 'Verify', detail: 'node --check + forge test for the distributor' },
    { title: 'Review', detail: 'adversarial read of the distributor' },
    { title: 'Real-world-test', detail: 'observe the loop, freshness gate, distributor, x402 live; regress M1' },
  ],
}

const READ = `Repo root is the working directory. Read these first, they are the whole context (no chat history):
README.md, PLAN.md (heed its AUTHORITATIVE ORDER banner), CONTEXT.md, FACTS.md, SPEC.md, BUILD.md, docs/adr/0001-0004.
SPEC.md wins over older PLAN.md prose. Milestone 1 output exists: src/FeeSplitter.sol and agent/account.mjs (the session-key account).
Existing: agent/agent.mjs (the lite loop to grow from), src/interfaces/*. Model default anthropic/claude-sonnet-5 via OpenRouter. Node v22, viem, @modelcontextprotocol/sdk.`

const BUILD_SCHEMA = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, needs_decision: { type: 'boolean' }, open_questions: { type: 'array', items: { type: 'string' } } }, required: ['files', 'summary', 'needs_decision', 'open_questions'] }
const VERIFY_SCHEMA = { type: 'object', properties: { passed: { type: 'boolean' }, summary: { type: 'string' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['passed', 'summary', 'failures'] }
const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'issue', 'fix'] } } }, required: ['findings'] }

const COMPONENTS = [
  { label: 'mcp-chain', file: 'agent/mcp/chain.mjs', task: 'a real MCP server (@modelcontextprotocol/sdk stdio) exposing on-chain tools: read treasury balances, execute a swap through the Milestone 1 session-key account, and read fee/splitter status. Reuse the swap approach proven in test/Phase0Stock.fork.t.sol (SwapRouter02 exactInputSingle, selector 0x04e45aaf, no deadline).' },
  { label: 'mcp-market', file: 'agent/mcp/market.mjs', task: 'a real MCP server exposing market data: read a Chainlink feed (AggregatorV3Interface.latestRoundData, 8 dec) for an asset AND enforce the freshness cutoffs in SPEC.md section 6 (equities 300s, SGOV/SLV 24h, GLD no-feed uses the GLD/USDG TWAP and is off-hours-blocked). Also read a v3 pool TWAP (observe) for the execution sanity check. Use the feed and pool addresses in FACTS.md.' },
  { label: 'mcp-socials', file: 'agent/mcp/socials.mjs', task: 'a real MCP server exposing a post-to-X tool via the creator-connected X account (OAuth, creator brings their own keys per ADR/PLAN section 6b). Scaffold the OAuth token use and the post call; the X keys are creator-supplied, so read them from a per-agent config. Also write to the site reasoning feed.' },
  { label: 'loop', file: 'agent/loop.mjs', task: 'the production agent loop, grown from agent/agent.mjs: OpenRouter model call with the MCP tools as function schemas, the archetype template + persona prompt as the system prompt, the risk guardrails from SPEC.md section 4 enforced IN CODE (max 40%/asset, 20%/trade, 1% slippage, 20% USDG floor, allowed-assets-only, freshness gate) so a misbehaving model cannot exceed them, per-agent memory (last N feed entries + positions), and writing each thought/decision to the reasoning feed.' },
  { label: 'distributor', file: 'src/Distributor.sol', task: 'the Merkle profit distributor per SPEC.md section 3: a contract that stores a per-epoch Merkle root of holder->USDG shares and lets holders claim USDG by proof. Also write test/Distributor.fork.t.sol proving set-root then claim, and that a wrong proof reverts. The off-chain snapshot excludes the curve/pool, splitter, treasury; realized gains above a USDG high-water mark; payout always USDG.' },
  { label: 'x402', file: 'agent/x402.mjs', task: 'the per-agent x402 pay-gate endpoint (grow from the demo in agent/agent.mjs). The facilitator for chain 4663 is OPEN (SPEC 10.2): implement the 402 challenge + settlement interface cleanly, pick the facilitator behind a small adapter, and set needs_decision=true noting the facilitator choice in open_questions.' },
]

phase('Build')
const built = (await parallel(
  COMPONENTS.map((c) => () => agent(
    `${READ}\n\nBUILD ${c.file}: ${c.task}\nWrite ONLY your assigned file(s) so you do not collide with the other builders. Do NOT edit agent/package.json (the other builders write it concurrently and would clobber it) - instead list every new dependency you need as "npm:<name>@<version>" entries in open_questions, and I will consolidate them after. Return the files and open questions.`,
    { label: c.label, phase: 'Build', agentType: 'general-purpose', schema: BUILD_SCHEMA }
  ))
)).filter(Boolean)

phase('Verify')
const verify = await agent(
  `${READ}\n\nVERIFY Milestone 2. Run \`node --check\` on every new .mjs under agent/ (agent/mcp/*.mjs, agent/loop.mjs, agent/x402.mjs). Run \`forge build\` and \`forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-path 'test/Distributor*'\` (retry once on a transient RPC error). Report passed=true only if all node --check pass and the distributor test is green. List concrete failures.`,
  { label: 'verify', phase: 'Verify', agentType: 'general-purpose', schema: VERIFY_SCHEMA }
)

phase('Review')
const review = await agent(
  `${READ}\n\nADVERSARIALLY REVIEW src/Distributor.sol as a security auditor. It pays out real USDG. Hunt for: double-claims across epochs, Merkle proof forgery, wrong share math, reentrancy on claim, and any way to drain more than the epoch total. Also check agent/loop.mjs: can a crafted model output bypass the in-code guardrails (position cap, slippage, freshness)? Report only real findings with a fix each.`,
  { label: 'distributor-audit', phase: 'Review', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
)

const RWT_SCHEMA = {
  type: 'object',
  properties: {
    observations: { type: 'array', items: { type: 'object', properties: { assumption: { type: 'string' }, how_observed: { type: 'string' }, result: { type: 'string' }, holds: { type: 'boolean' } }, required: ['assumption', 'how_observed', 'result', 'holds'] } },
    regressions: { type: 'array', items: { type: 'object', properties: { prior_milestone: { type: 'string' }, anchor: { type: 'string' }, still_holds: { type: 'boolean' }, note: { type: 'string' } }, required: ['prior_milestone', 'anchor', 'still_holds', 'note'] } },
    new_defects: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'issue', 'fix'] } },
    all_load_bearing_observed: { type: 'boolean' },
  },
  required: ['observations', 'regressions', 'new_defects', 'all_load_bearing_observed'],
}
const RWT_RULE = `Apply the real-world-test discipline (invoke the real-world-test skill if available). Core rule: an assumption is a claim you have NOT checked. Convert every LOAD-BEARING assumption into a DIRECT observation against reality - the live RPC, the Alchemy bundler, REAL OpenRouter, a real fork - never a mock, never "the test passes." State each assumption, how observed, the result, and whether it holds. If an OPEN item blocks observation, mark NOT observed and flag it. Recursively re-observe the prior-milestone anchors. Report new defects. all_load_bearing_observed=true ONLY if every load-bearing claim was observed to hold.`

phase('Real-world-test')
const rwt = await agent(
  `${READ}\n\n${RWT_RULE}\n\nMilestone 2 load-bearing assumptions to OBSERVE:\n` +
  `1. The agent loop (agent/loop.mjs) makes a REAL OpenRouter call that chooses an MCP tool, and agent/mcp/chain.mjs returns a REAL live read from chain 4663 (nonzero, matches cast).\n` +
  `2. agent/mcp/market.mjs REJECTS a stale Chainlink price: observe a real feed's updatedAt and confirm the freshness gate would block an off-hours/stale equity price and allow a fresh one.\n` +
  `3. On a fork, src/Distributor.sol: set a Merkle root, a holder CLAIMS the right USDG by proof, and a wrong proof reverts.\n` +
  `4. agent/x402.mjs actually settles a payment end to end. If the facilitator (SPEC 10.2) is unresolved, mark NOT observed and flag it.\n` +
  `Prior-milestone anchors to regress:\n- M1: claimAndRoute still routes 80/20 on a fork; the session key still blocks an over-cap/disallowed swap.`,
  { label: 'real-world-test', phase: 'Real-world-test', agentType: 'general-purpose', schema: RWT_SCHEMA }
)

log(`M2: built ${built.flatMap(b => b.files).length} files; verify=${verify?.passed}; ${review?.findings?.length || 0} review findings; RWT all-observed=${rwt?.all_load_bearing_observed}`)
return { built, verify, review, rwt }
