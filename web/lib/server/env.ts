// SERVER-ONLY. Loads the repo-root `.env` into process.env for the API route handlers.
//
// Next.js only auto-loads `.env*` files from the Next project root (web/), but the AgentPad secrets
// (DEPLOYER_KEY, DATABASE_URL, ROBINHOOD_ALCHEMY_RPC, …) live in the REPO-ROOT .env — the same file
// api/launch.mjs and api/keeper.mjs read. So the route handlers load it themselves here. This is a
// tiny, dependency-free loader (mirrors api/launch.mjs autoloadEnv): it NEVER overrides an already-set
// variable, so a real env var or a web/.env.local value always wins. Secrets stay server-side; nothing
// here is ever sent to the client.

import fs from "node:fs";
import path from "node:path";

let loaded = false;

export function loadRepoRootEnv(): void {
  if (loaded) return;
  loaded = true;
  // During `next dev` / `next build` / `next start`, process.cwd() is the web/ project dir, so the
  // repo root is one level up. Fall back to cwd/.env for a co-located run.
  const candidates = [path.join(process.cwd(), "..", ".env"), path.join(process.cwd(), ".env")];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
      return; // first existing file wins
    } catch {
      /* ignore and try the next candidate */
    }
  }
}
