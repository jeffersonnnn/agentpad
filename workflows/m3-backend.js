export const meta = {
  name: 'm3-backend',
  description: 'Milestone 3: build the Postgres schema, the launch orchestration (creatorFeeRecipient=splitter, creator-signed), and the fee-sweep + distribution keeper, then verify and review',
  phases: [
    { title: 'Build', detail: 'schema, orchestration, keeper - distinct files' },
    { title: 'Verify', detail: 'node --check + SQL parse' },
    { title: 'Review', detail: 'never-custody + correct recipient' },
    { title: 'Real-world-test', detail: 'observe launch + keeper on a fork; regress M1/M2' },
  ],
}

const READ = `Repo root is the working directory. Read these first, they are the whole context (no chat history):
README.md, PLAN.md (heed its AUTHORITATIVE ORDER banner), CONTEXT.md, FACTS.md, SPEC.md (sections 7 and 8 are the schema and orchestration), BUILD.md, docs/adr/0001-0004. SPEC.md wins over older PLAN.md prose.
Milestone 1-2 output exists: src/FeeSplitter.sol, agent/account.mjs, agent/loop.mjs, src/Distributor.sol, agent/mcp/*.
Stack: Node + TypeScript/ESM, Postgres, viem, Alchemy RPC/bundler. A platform DEPLOYER_KEY is expected in .env (add it to the secrets list). Never custody creator or holder funds.`

const BUILD_SCHEMA = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, needs_decision: { type: 'boolean' }, open_questions: { type: 'array', items: { type: 'string' } } }, required: ['files', 'summary', 'needs_decision', 'open_questions'] }
const VERIFY_SCHEMA = { type: 'object', properties: { passed: { type: 'boolean' }, summary: { type: 'string' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['passed', 'summary', 'failures'] }
const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'issue', 'fix'] } } }, required: ['findings'] }

const COMPONENTS = [
  { label: 'db-schema', file: 'api/db/schema.sql', task: 'the Postgres schema exactly per SPEC.md section 7: tables agents, distribution_config, positions, feed, distributions, holder_snapshots, with the listed columns, types, keys, and relations. Add sensible indexes and the status enum {deploying, live, sleeping, dead}.' },
  { label: 'launch-orchestration', file: 'api/launch.mjs', task: 'the launch orchestration per SPEC.md section 8: (1) the platform DEPLOYER_KEY deploys the per-agent FeeSplitter, (2) it counterfactually deploys the agent ERC-4337 account (via agent/account.mjs), (3) the CREATOR wallet signs PONS launchToken with creatorFeeRecipient = the splitter, buybackEnabled=false, exactly 0.0005 ETH, (4) store the agents row and start the loop. No launch markup. Idempotent/retryable from the last completed step; never call launchToken twice for one salt. The creator signature is relayed from the frontend; expose the tx for the creator to sign, do not sign it server-side.' },
  { label: 'keeper', file: 'api/keeper.mjs', task: 'the keeper service: on a schedule, for each live agent call splitter.claimAndRoute (routes 80/20 + buy-and-burn), and run the distribution epoch (off-chain holder snapshot excluding curve/pool/splitter/treasury -> compute pro-rata USDG shares of realized gains above the high-water mark -> publish the Merkle root to src/Distributor.sol). Also implement treasury-metered sleep: mark an agent sleeping when its treasury cannot cover inference+gas, wake it when refunded.' },
]

phase('Build')
const built = (await parallel(
  COMPONENTS.map((c) => () => agent(
    `${READ}\n\nBUILD ${c.file}: ${c.task}\nWrite ONLY your assigned file(s). Do NOT edit or create api/package.json (the other builders write it concurrently and would clobber it) - instead list every new dependency you need as "npm:<name>@<version>" entries in open_questions, and I will consolidate them after. Return files + open questions.`,
    { label: c.label, phase: 'Build', agentType: 'general-purpose', schema: BUILD_SCHEMA }
  ))
)).filter(Boolean)

phase('Verify')
const verify = await agent(
  `${READ}\n\nVERIFY Milestone 3. Run \`node --check\` on api/launch.mjs and api/keeper.mjs. Sanity-parse api/db/schema.sql (e.g. via a Postgres parser or a dry \`psql --version\` + syntax read; if no DB, at least confirm every table in SPEC.md section 7 is present with its columns). Report passed and concrete failures.`,
  { label: 'verify', phase: 'Verify', agentType: 'general-purpose', schema: VERIFY_SCHEMA }
)

phase('Review')
const review = await agent(
  `${READ}\n\nREVIEW api/launch.mjs and api/keeper.mjs for two correctness properties that must hold: (1) NEVER custody - the server never signs a transaction that spends the creator's or a holder's funds; only the platform DEPLOYER_KEY signs infra deploys, and the creator signs launchToken client-side. (2) creatorFeeRecipient is set to the SPLITTER, never the agent wallet. Also check idempotency/rollback on partial failure. Report only real findings with a fix each.`,
  { label: 'orchestration-review', phase: 'Review', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
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
const RWT_RULE = `Apply the real-world-test discipline (invoke the real-world-test skill if available). Core rule: an assumption is a claim you have NOT checked. Convert every LOAD-BEARING assumption into a DIRECT observation against reality (live RPC, real fork, real DB if available) - never a mock, never "the test passes." State each assumption, how observed, result, holds. Flag unobservable OPEN items. Recursively re-observe prior-milestone anchors. Report new defects. all_load_bearing_observed=true ONLY if every load-bearing claim held.`

phase('Real-world-test')
const rwt = await agent(
  `${READ}\n\n${RWT_RULE}\n\nMilestone 3 load-bearing assumptions to OBSERVE:\n` +
  `1. On a fork, the orchestration (api/launch.mjs) deploys the splitter + agent account and produces a launchToken tx whose creatorFeeRecipient is the SPLITTER (not the agent wallet), and the server NEVER signs a tx that spends creator/holder funds (only the platform DEPLOYER_KEY signs infra; the creator signs launchToken client-side).\n` +
  `2. api/keeper.mjs actually runs claimAndRoute for a live agent and publishes a distribution Merkle root against real state (fork).\n` +
  `3. api/db/schema.sql applies cleanly to the real Postgres at DATABASE_URL in .env (the user's Neon agentpad project). SAFETY: this is the user's own dev DB - use CREATE ... IF NOT EXISTS only, NEVER DROP or TRUNCATE any table or delete any row, and first confirm you are on the intended empty agentpad DB. Applying the greenfield schema (creating the app tables) is the intended M3 result. If DATABASE_URL is unreachable, fall back to a local/ephemeral Postgres or a rolled-back transaction; otherwise confirm every SPEC section 7 table+column is present.\n` +
  `Prior-milestone anchors to regress:\n- M1: claimAndRoute routes 80/20; session key enforces caps.\n- M2: the loop makes a real live read; the distributor claim pays USDG on a fork.`,
  { label: 'real-world-test', phase: 'Real-world-test', agentType: 'general-purpose', schema: RWT_SCHEMA }
)

log(`M3: built ${built.flatMap(b => b.files).length} files; verify=${verify?.passed}; ${review?.findings?.length || 0} review findings; RWT all-observed=${rwt?.all_load_bearing_observed}`)
return { built, verify, review, rwt }
