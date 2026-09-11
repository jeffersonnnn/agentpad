// SERVER-ONLY. Resolves repo-relative paths shared between the web route handlers and the agent
// runtime (api/launch.mjs). The per-agent X-connect secrets file lives here; both this file and
// api/launch.mjs `defaultStartLoop` must agree on the exact path so the loop reads what the creator
// connected. The `.secrets/` dir is gitignored (see repo-root .gitignore).

import path from "node:path";

/**
 * Repo root. During `next dev`/`build`/`start`, process.cwd() is the web/ project dir, so the repo
 * root is one level up. Mirrors lib/server/env.ts and api/launch.mjs REPO_ROOT (= api/..).
 */
export function repoRoot(): string {
  return path.join(process.cwd(), "..");
}

/** The per-agent socials config file that agent/mcp/socials.mjs reads via SOCIALS_CONFIG. */
export function socialsConfigPath(agentId: string): string {
  return path.join(repoRoot(), "agent", ".secrets", `socials-${agentId}.json`);
}
