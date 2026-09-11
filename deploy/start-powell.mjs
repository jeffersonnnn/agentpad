// Production entry for the Powell agent loop under pm2.
// Run it with the repo-root .env loaded, e.g.:  node --env-file=.env deploy/start-powell.mjs
// (the pm2 ecosystem does this for you). It mirrors api/launch.mjs `defaultStartLoop`: it loads the
// granted session key, assembles the loop env, and spawns agent/loop.mjs. It self-bundles userOps via
// EntryPoint.handleOps (the mainnet submit path), relayer = the deployer.
//
// Prerequisites on the box (NEVER committed):
//   - repo-root .env with DEPLOYER_KEY, DATABASE_URL, ROBINHOOD_ALCHEMY_RPC, ALCHEMY_KEY, OPENROUTER_KEY
//   - agent/.secrets/session-<AGENT_ID>.json (the granted session; see docs/FLAGSHIP-RUNBOOK.md)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ID = process.env.AGENT_ID || "ef0bef8f-0829-46c8-bcdc-f8f036f4663a"; // Powell
const POWELL_SPLITTER = "0x3b2F90e211C20008202b245A75Be3Bc98bfe62b8";

for (const k of ["DEPLOYER_KEY", "DATABASE_URL", "ROBINHOOD_ALCHEMY_RPC", "OPENROUTER_KEY"]) {
  if (!process.env[k]) {
    console.error(`[start-powell] missing ${k}. Run with: node --env-file=.env deploy/start-powell.mjs`);
    process.exit(1);
  }
}

const sessionPath = path.join(REPO, "agent", ".secrets", `session-${AGENT_ID}.json`);
if (!fs.existsSync(sessionPath)) {
  console.error(`[start-powell] no session at ${sessionPath}. Grant the session key first (docs/FLAGSHIP-RUNBOOK.md).`);
  process.exit(1);
}
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));

const cfg = (await import(path.join(REPO, "agents", "powell.config.mjs"))).default;

const mcpDir = path.join(REPO, "agent", "mcp");
const mcpServers = [
  { name: "chain", command: process.execPath, args: [path.join(mcpDir, "chain.mjs")] },
  { name: "market", command: process.execPath, args: [path.join(mcpDir, "market.mjs")] },
  { name: "socials", command: process.execPath, args: [path.join(mcpDir, "socials.mjs")] },
];

const env = {
  ...process.env,
  ...cfg.loopEnv(),
  AGENT_ID,
  AGENT_ACCOUNT: session.accountAddress,
  AGENT_SESSION_APPROVAL: session.approval,
  AGENT_SESSION_KEY: session.sessionKey,
  AGENT_MCP_SERVERS: JSON.stringify(mcpServers),
  AGENT_SUBMIT: "handleops",
  AGENT_RELAYER_KEY: process.env.DEPLOYER_KEY,
  FEE_SPLITTER: process.env.FEE_SPLITTER || POWELL_SPLITTER,
};
const socialsConfig = path.join(REPO, "agent", ".secrets", `socials-${AGENT_ID}.json`);
if (fs.existsSync(socialsConfig)) env.SOCIALS_CONFIG = socialsConfig;

console.log(
  `[start-powell] loop for ${AGENT_ID} account=${session.accountAddress} interval=${env.AGENT_LOOP_INTERVAL || "3600"}s submit=handleops`
);
const child = spawn(process.execPath, [path.join(REPO, "agent", "loop.mjs")], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
