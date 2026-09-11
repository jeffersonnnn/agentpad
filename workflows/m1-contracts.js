export const meta = {
  name: 'm1-contracts',
  description: 'Milestone 1: build the per-agent fee splitter (+fork test) and the ERC-4337 agent account + session-key setup, then verify and adversarially review',
  phases: [
    { title: 'Build', detail: 'splitter + account setup, distinct files' },
    { title: 'Verify', detail: 'forge build + fork tests' },
    { title: 'Review', detail: 'adversarial read of the money contract' },
    { title: 'Real-world-test', detail: 'observe every load-bearing claim on the live chain' },
  ],
}

const READ = `Repo root is the working directory. Read these first, they are the whole context (there is no chat history):
README.md, PLAN.md (heed its AUTHORITATIVE ORDER banner), CONTEXT.md, FACTS.md, SPEC.md, BUILD.md, and docs/adr/0001-0004.
SPEC.md wins over any older PLAN.md prose. Existing code: src/interfaces/*, src/AgentWallet.sol, test/Phase0*.fork.t.sol.
Toolchain: foundry 0.2.0, solc 0.8.30, evm cancun, via_ir=false, forge-std symlinked in lib/. Fork RPC: https://rpc.mainnet.chain.robinhood.com .`

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    needs_decision: { type: 'boolean' },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'summary', 'needs_decision', 'open_questions'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['passed', 'summary', 'failures'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: { type: 'string' }, file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } },
        required: ['severity', 'issue', 'fix'],
      },
    },
  },
  required: ['findings'],
}

phase('Build')
const built = await parallel([
  () => agent(
    `${READ}\n\nBUILD the per-agent fee splitter per SPEC.md section 1. Write src/FeeSplitter.sol and test/FeeSplitter.fork.t.sol.\n` +
    `Requirements: constructor(agentTreasury, platformToken, platformQuote=USDG, ponsEscrow, agentCurve, platformCurve, agentBps=8000). ` +
    `claimAndRoute(): agentCurve.sweepFees(0) -> ponsEscrow.claim() -> if the fee came in ETH convert to USDG (v3 SwapRouter02) -> send 80% to agentTreasury, use 20% to buy the platform token and BURN it by buying to 0x000000000000000000000000000000000000dEaD via platformCurve.buy. ` +
    `Agent tokens launch buybackEnabled=false so the splitter (the creatorFeeRecipient) may sweep. The platform token/curve come from PLATFORM_TOKEN (.env), set at deploy (the token launches last); use a MOCK platform token in the fork test, and if PLATFORM_TOKEN is unset the splitter HOLDS its 20% and flips to buy-and-burn once set. Post-graduation v4 buy path is OPEN (SPEC 10.3) - leave a clear TODO and handle only the pre-graduation curve.buy path now. ` +
    `Write a fork test that launches a token through the LIVE PONS factory with creatorFeeRecipient = the splitter, generates buys, runs claimAndRoute, and asserts the 80/20 routing and the dead-address burn. Reuse the Phase 0 harness patterns. Return the files and any open questions.`,
    { label: 'fee-splitter', phase: 'Build', agentType: 'general-purpose', schema: BUILD_SCHEMA }
  ),
  () => agent(
    `${READ}\n\nBUILD the ERC-4337 agent account + session-key setup per SPEC.md section 2 and ADR 0004. Write agent/account.mjs (Node ESM, viem-based).\n` +
    `It must: deploy an ERC-4337 account for an agent on chain 4663, and scope a session key with an allowed-token list (the archetype assets + USDG), a daily cumulative spend cap, and an expiry. Owner = the creator/platform key; the runtime holds the session key. No paymaster: the account pays its own gas. Bundler = the Alchemy URL in .env (ROBINHOOD_ALCHEMY_RPC). ` +
    `The account STACK is OPEN (SPEC 10.1): implement against ZeroDev Kernel v3 as the recommended default, EntryPoint v0.7, but isolate the stack behind a small interface so Alchemy Modular Account is a drop-in swap. If the SDK is not installed, add it to a agent/package.json and note the install. Set needs_decision=true and explain the stack choice in open_questions. Return the files.`,
    { label: 'agent-account', phase: 'Build', agentType: 'general-purpose', schema: BUILD_SCHEMA }
  ),
])

phase('Verify')
const verify = await agent(
  `${READ}\n\nVERIFY Milestone 1. Run \`forge build\` and \`forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-path 'test/FeeSplitter*'\` (retry once on a transient RPC error). ` +
  `For agent/account.mjs, run \`node --check agent/account.mjs\` and confirm it imports cleanly. Report passed=true only if the splitter fork test is green. List concrete failures with the error text.`,
  { label: 'verify', phase: 'Verify', agentType: 'general-purpose', schema: VERIFY_SCHEMA }
)

phase('Review')
const review = await agent(
  `${READ}\n\nADVERSARIALLY REVIEW src/FeeSplitter.sol as a security auditor. It routes real money. Hunt for: reentrancy on claim/route/buy, wrong split math, unconverted-asset edge cases, a burn that does not actually remove tokens, missing access control on claimAndRoute, and any path that strands funds. Report only real, concrete findings with a fix each.`,
  { label: 'splitter-audit', phase: 'Review', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
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
const RWT_RULE = `Apply the real-world-test discipline (invoke the real-world-test skill if available). Core rule: an assumption is a claim you have NOT checked. Convert every LOAD-BEARING assumption this milestone depends on into a DIRECT observation against reality - the live RPC https://rpc.mainnet.chain.robinhood.com, the Alchemy bundler in .env, real OpenRouter, a real fork - NEVER a mock and never "the unit test passes." For each: state the assumption, how you observed it, the actual result, and whether it holds. If a claim CANNOT be observed because an OPEN item is unresolved (account stack, x402 facilitator, v4 buy path), mark it NOT observed and flag it - do NOT assert it works. Then recursively re-observe the prior-milestone anchors listed. Report new defects. Set all_load_bearing_observed=true ONLY if every load-bearing claim was directly observed to hold.`

phase('Real-world-test')
const rwt = await agent(
  `${READ}\n\n${RWT_RULE}\n\nMilestone 1 load-bearing assumptions to OBSERVE:\n` +
  `1. On a fork against LIVE PONS, launching a token with creatorFeeRecipient=the splitter, trading it, then claimAndRoute actually moves the creator fee: 80% USDG to the agent treasury, and 20% either held (PLATFORM_TOKEN unset) or used to buy the platform token and send it to the dead address.\n` +
  `2. The ERC-4337 agent account submits a REAL userop through the Alchemy bundler on 4663 and pays its OWN gas (no paymaster). If the account stack (SPEC 10.1) is not resolved, mark this NOT observed.\n` +
  `3. The session key BLOCKS a swap that exceeds the daily cap or touches a disallowed token, and allows an in-scope swap.\n` +
  `Prior-milestone anchors to regress: none (M1 is first).`,
  { label: 'real-world-test', phase: 'Real-world-test', agentType: 'general-purpose', schema: RWT_SCHEMA }
)

const built2 = built.filter(Boolean)
log(`M1: built ${built2.flatMap(b => b.files).length} files; verify=${verify?.passed}; ${review?.findings?.length || 0} review findings; RWT all-observed=${rwt?.all_load_bearing_observed}`)
return { built: built2, verify, review, rwt }
