export const meta = {
  name: 'm4-frontend',
  description: 'Milestone 4: build the PONS-style launch form and the agent page (price, wallet, trades, distributions, reasoning feed), then verify the build',
  phases: [
    { title: 'Scaffold', detail: 'Next.js app + wagmi/viem chain config' },
    { title: 'Build', detail: 'launch form + agent page, distinct files' },
    { title: 'Verify', detail: 'next build / typecheck' },
    { title: 'Real-world-test', detail: 'run the app against the real backend + chain; regress M1-M3' },
  ],
}

const READ = `Repo root is the working directory. Read these first, they are the whole context (no chat history):
README.md, PLAN.md (heed its AUTHORITATIVE ORDER banner), CONTEXT.md, FACTS.md, SPEC.md, BUILD.md, docs/adr/0001-0004. SPEC.md wins over older PLAN.md prose.
Backend from Milestone 3 exists under api/ (the launch orchestration endpoint and the Postgres-backed reads). The launch form must MIRROR the PONS create form (ponsfamily.com/launchpad/create): Name, Ticker, Description, Image(URL/logo string), X, Telegram, Paired asset (ETH or USDG), Developer buy, plus advanced (creator tax, snipe-tax exemptions). Add the three agent fields: trading archetype (the templates in SPEC.md section 4), persona prompt, and distribution policy (distribute/buyback, rate, cadence, on/off - ADR 0002). Stack: Next.js + wagmi/viem, connect an existing wallet (viem robinhood chain id 4663). No geoblock (ADR 0001).`

const BUILD_SCHEMA = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, needs_decision: { type: 'boolean' }, open_questions: { type: 'array', items: { type: 'string' } } }, required: ['files', 'summary', 'needs_decision', 'open_questions'] }
const VERIFY_SCHEMA = { type: 'object', properties: { passed: { type: 'boolean' }, summary: { type: 'string' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['passed', 'summary', 'failures'] }

phase('Scaffold')
const scaffold = await agent(
  `${READ}\n\nSCAFFOLD the Next.js app under web/ : package.json, the app router, a wagmi/viem provider configured for the robinhood chain (id 4663, from viem/chains), a wallet-connect button, and a shared api client that talks to the Milestone 3 orchestration + read endpoints. Write shared files only (no page bodies yet). Return the files.`,
  { label: 'scaffold', phase: 'Scaffold', agentType: 'general-purpose', schema: BUILD_SCHEMA }
)

phase('Build')
const built = (await parallel([
  () => agent(
    `${READ}\n\nBUILD the launch form page under web/ (e.g. web/app/create/page.tsx + its components). Mirror the PONS create form field-for-field, add the three agent fields, connect the wallet, and drive the signed launch flow: POST the form to the Milestone 3 orchestration endpoint, which returns the launchToken tx for the creator's wallet to sign (creatorFeeRecipient = the splitter, set server-side, not by the user). Write ONLY the create-form files. Do NOT edit web/package.json (the scaffold owns it and the other page builder writes concurrently) - list any extra dependency as "npm:<name>@<version>" in open_questions and I will consolidate. Return them.`,
    { label: 'launch-form', phase: 'Build', agentType: 'general-purpose', schema: BUILD_SCHEMA }
  ),
  () => agent(
    `${READ}\n\nBUILD the agent page under web/ (e.g. web/app/agent/[id]/page.tsx + components). Show: the agent-token price (read the PONS curve/pool), the agent wallet + treasury, its trades, its distributions (from the distributions table / Distributor contract), and the community REASONING FEED (from the feed table - show the agent's thinking, each entry linked to its on-chain tx). Also a discover/board page listing live agents. Write ONLY the agent-page + board files. Do NOT edit web/package.json (the scaffold owns it and the other page builder writes concurrently) - list any extra dependency as "npm:<name>@<version>" in open_questions and I will consolidate. Return them.`,
    { label: 'agent-page', phase: 'Build', agentType: 'general-purpose', schema: BUILD_SCHEMA }
  ),
])).filter(Boolean)

phase('Verify')
const verify = await agent(
  `${READ}\n\nVERIFY Milestone 4. In web/, install deps if needed and run the type-check and \`next build\` (or \`next lint\` + \`tsc --noEmit\` if a full build is too heavy). Report passed=true only if it type-checks and builds. List concrete errors with file:line.`,
  { label: 'verify', phase: 'Verify', agentType: 'general-purpose', schema: VERIFY_SCHEMA }
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
const RWT_RULE = `Apply the real-world-test discipline (invoke the real-world-test skill if available). Core rule: an assumption is a claim you have NOT checked. Convert every LOAD-BEARING assumption into a DIRECT observation - actually RUN the app (next dev/build + drive the pages), hit the REAL Milestone 3 backend and the real chain reads - never a mock, never "it type-checks." State each assumption, how observed, result, holds. Flag unobservable OPEN items. Recursively re-observe prior-milestone anchors. Report new defects. all_load_bearing_observed=true ONLY if every load-bearing claim held.`

phase('Real-world-test')
const rwt = await agent(
  `${READ}\n\n${RWT_RULE}\n\nMilestone 4 load-bearing assumptions to OBSERVE (run the app):\n` +
  `1. The create form drives the real Milestone 3 orchestration and produces a launchToken tx whose creatorFeeRecipient is the SPLITTER; the form never lets the user set the recipient.\n` +
  `2. The agent page renders REAL data: the agent-token price from the PONS curve/pool, real trades, real distributions, and the reasoning feed (each entry linked to a real on-chain tx). Observe against real reads, not fixtures.\n` +
  `3. The app targets chain 4663 (viem robinhood) and connects a real wallet.\n` +
  `Prior-milestone anchors to regress (spot-check they still hold):\n- M1 splitter 80/20; M2 loop live read + distributor claim; M3 orchestration recipient=splitter + never-custody.`,
  { label: 'real-world-test', phase: 'Real-world-test', agentType: 'general-purpose', schema: RWT_SCHEMA }
)

log(`M4: scaffold ${scaffold?.files?.length || 0} + built ${built.flatMap(b => b.files).length} files; verify=${verify?.passed}; RWT all-observed=${rwt?.all_load_bearing_observed}`)
return { scaffold, built, verify, rwt }
