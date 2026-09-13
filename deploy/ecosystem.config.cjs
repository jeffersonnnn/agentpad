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
      // Port defaults to 3000; override with AGENTPAD_WEB_PORT when 3000 is taken (e.g. a shared box).
      env: { NODE_ENV: "production", PORT: process.env.AGENTPAD_WEB_PORT || "3000" },
      autorestart: true,
      max_memory_restart: "700M",
    },
    {
      // The reasoner: one reasoning pass for EVERY live agent per run (deploy/reason-all.mjs). Reads the
      // agent list fresh from the DB, so new launches are picked up automatically; reason-only when an
      // agent has no session key, trading when it does. Scheduled by cron. This replaces the fragile
      // per-launch loop spawn (finalize sets AGENTPAD_START_LOOP=0). Adjust cadence to taste / cost.
      name: "agentpad-reasoner",
      cwd: REPO,
      script: "deploy/reason-all.mjs",
      interpreter: "node",
      interpreter_args: "--env-file=.env",
      autorestart: false,
      cron_restart: "*/3 * * * *",
      env: { NODE_ENV: "production" },
    },
    {
      // Lazy auto-grant: install a scoped session key for any live, funded agent that lacks one, so it
      // can trade (deploy/grant-ready.mjs). The account pays the grant gas itself, so it grants only
      // once the creator has topped the agent up with ETH. Re-grants before the 24h key TTL expires.
      name: "agentpad-grant",
      cwd: REPO,
      script: "deploy/grant-ready.mjs",
      interpreter: "node",
      interpreter_args: "--env-file=.env",
      autorestart: false,
      cron_restart: "*/5 * * * *",
      env: { NODE_ENV: "production" },
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
