// pm2 process definitions for the AgentPad VPS deploy.
// Start from the repo root:  pm2 start deploy/ecosystem.config.cjs
// Then persist:              pm2 save && pm2 startup
//
// Secrets are NEVER in this file. They come from the gitignored repo-root .env (backend + agent) and
// web/.env.local (the browser NEXT_PUBLIC_* config). See docs/DEPLOY.md.

const path = require("node:path");
const REPO = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      // The Next.js app: the site AND its same-origin API route handlers (prepare/finalize, reads, claim).
      name: "agentpad-web",
      cwd: path.join(REPO, "web"),
      script: "npm",
      args: "run start",
      env: { NODE_ENV: "production", PORT: "3000" },
      autorestart: true,
      max_memory_restart: "700M",
    },
    {
      // The autonomous Powell trading loop (self-bundles via handleOps). Loops on AGENT_LOOP_INTERVAL.
      // Comment this app out to deploy the site WITHOUT the live money loop.
      name: "agentpad-powell",
      cwd: REPO,
      script: path.join(REPO, "deploy", "start-powell.mjs"),
      interpreter: "node",
      interpreter_args: "--env-file=.env",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
    },
    {
      // The keeper: sweeps creator fees (80/20 route) and runs distribution epochs. One pass per run,
      // scheduled by cron. Processes all live agents.
      name: "agentpad-keeper",
      cwd: REPO,
      script: "api/keeper.mjs",
      interpreter: "node",
      interpreter_args: "--env-file=.env",
      args: "--once",
      autorestart: false,
      cron_restart: "*/15 * * * *",
      env: { NODE_ENV: "production" },
    },
  ],
};
