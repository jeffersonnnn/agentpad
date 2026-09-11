export const meta = {
  name: 'm5-flagship',
  description: 'Milestone 5: wire one flagship agent end to end and trace every integration path across the built system to catch pieces that do not connect',
  phases: [
    { title: 'Wire', detail: 'flagship agent config + end-to-end runbook' },
    { title: 'Trace', detail: 'four path-tracers over the built code' },
    { title: 'Real-world-test', detail: 'run the flagship end to end and regress every anchor M1-M4' },
  ],
}

const READ = `Repo root is the working directory. Read these first, they are the whole context (no chat history):
README.md, PLAN.md (AUTHORITATIVE ORDER banner), CONTEXT.md, FACTS.md, SPEC.md, BUILD.md, docs/adr/0001-0004. SPEC.md wins over older PLAN.md prose.
Milestones 1-4 are built: src/FeeSplitter.sol, src/Distributor.sol, agent/account.mjs, agent/loop.mjs, agent/mcp/*, agent/x402.mjs, api/launch.mjs, api/keeper.mjs, api/db/schema.sql, web/*. This milestone proves they actually connect into one working loop.`

const BUILD_SCHEMA = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, open_questions: { type: 'array', items: { type: 'string' } } }, required: ['files', 'summary', 'open_questions'] }
const TRACE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    connects: { type: 'boolean' },
    breaks: {
      type: 'array',
      items: { type: 'object', properties: { where: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['where', 'issue', 'fix'] },
    },
  },
  required: ['path', 'connects', 'breaks'],
}

phase('Wire')
const wire = await agent(
  `${READ}\n\nWIRE one flagship agent. Pick a concrete archetype (e.g. "Powell", Macro) and write its config: the archetype, the persona prompt, the distribution policy, and the allowed assets. Write it as a config file the launch orchestration can consume, and write docs/FLAGSHIP-RUNBOOK.md: the exact ordered steps to launch this agent end to end (platform-token address from M0, deploy splitter + account, creator-signed launchToken, start the loop, fund the treasury seed, watch the first trade + feed entry + a distribution). Note every human/on-chain step that spends ETH. Return the files.`,
  { label: 'flagship-config', phase: 'Wire', agentType: 'general-purpose', schema: BUILD_SCHEMA }
)

phase('Trace')
const PATHS = [
  { label: 'money-in', path: 'Agent-token trade -> 1% curve fee -> PONS escrow -> FeeSplitter.claimAndRoute -> 80% agent treasury / 20% buy-and-burn platform token. Trace the actual function names, addresses, and calls across src/FeeSplitter.sol and api/keeper.mjs. Do they connect?' },
  { label: 'trade-loop', path: 'Keeper wake -> agent/loop.mjs -> OpenRouter -> agent/mcp/chain.mjs swap through the agent/account.mjs session key -> reasoning-feed write. Trace tool names, the session-key call shape, and the feed write. Do they connect, and are the SPEC section 4 guardrails + freshness gate actually enforced in code?' },
  { label: 'payout', path: 'Keeper epoch -> off-chain holder snapshot (excluding curve/pool/splitter/treasury) -> src/Distributor.sol setRoot -> holder claim of USDG by proof. Trace it across api/keeper.mjs and src/Distributor.sol. Do they connect, and is the high-water mark applied?' },
  { label: 'frontend', path: 'web/ create form -> api/launch.mjs orchestration -> creator-signed launchToken with creatorFeeRecipient = the splitter -> web/ agent page reads price/trades/distributions/feed. Trace the request/response shapes. Do they connect, and is the recipient the splitter (never the agent wallet)?' },
]
const traces = (await parallel(
  PATHS.map((p) => () => agent(
    `${READ}\n\nTRACE this end-to-end path across the ACTUAL built code and report whether it connects, with concrete breaks (mismatched names, missing wiring, unplumbed addresses) and a fix each.\n\nPATH: ${p.path}`,
    { label: p.label, phase: 'Trace', agentType: 'general-purpose', schema: TRACE_SCHEMA }
  ))
)).filter(Boolean)

const broken = traces.filter((t) => !t.connects)

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

phase('Real-world-test')
const rwt = await agent(
  `${READ}\n\nApply the real-world-test discipline (invoke the real-world-test skill if available). Core rule: an assumption is a claim you have NOT checked. This is the FINAL, whole-system real-world-test: run the flagship agent end to end on a fork (or testnet) and OBSERVE each path actually working, not just that the code connects. Never a mock, never "the trace says it connects."\n\n` +
  `OBSERVE, for the flagship agent:\n` +
  `1. Money-in: a real trade on the agent token -> the fee reaches the splitter -> claimAndRoute sends 80% USDG to the treasury and burns/holds the 20%. Observe the balances move.\n` +
  `2. Trade-loop: the keeper wakes the loop -> the loop makes a real OpenRouter decision -> a real session-key swap executes on 4663 within the guardrails -> a reasoning-feed entry is written and linked to the tx.\n` +
  `3. Payout: a distribution epoch runs -> a holder claims real USDG by Merkle proof.\n` +
  `4. Frontend: the app shows the flagship's real price, trades, distributions, and reasoning feed.\n\n` +
  `Then RECURSIVELY confirm every prior anchor still holds in the ASSEMBLED system: M1 (splitter 80/20, session-key caps), M2 (loop live read, freshness gate blocks stale, distributor claim), M3 (orchestration recipient=splitter, never-custody, keeper). Flag any OPEN item (account stack, x402 facilitator, v4 buy path) that is still unobserved. Set all_load_bearing_observed=true ONLY if the whole loop was observed working live.`,
  { label: 'real-world-test', phase: 'Real-world-test', agentType: 'general-purpose', schema: RWT_SCHEMA }
)

log(`M5: flagship wired (${wire?.files?.length || 0} files); ${traces.length - broken.length}/${traces.length} paths connect; ${broken.length} broken; RWT all-observed=${rwt?.all_load_bearing_observed}`)
return { wire, traces, broken, rwt }
