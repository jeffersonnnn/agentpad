# Production deploy (VPS: Node + pm2 + nginx)

This runs the whole platform on one VPS: the Next.js app (site + API routes), the autonomous Powell
loop, and the keeper. Secrets never enter git; you place them on the box by hand.

## What runs

| pm2 app | Command | Role |
|---------|---------|------|
| `agentpad-web` | `npm run start` in `web/` (port 3000) | The site and its same-origin API routes (launch prepare/finalize, reads, claim) |
| `agentpad-powell` | `node --env-file=.env deploy/start-powell.mjs` | The autonomous trading loop for Powell (self-bundles via `handleOps`) |
| `agentpad-keeper` | `node --env-file=.env api/keeper.mjs --once` on cron (every 15 min) | Fee sweep (80/20 route) + distribution epochs |

nginx reverse-proxies `:80/:443` to `agentpad-web` on `127.0.0.1:3000`.

## 0. Prerequisites on the VPS

- Ubuntu 22.04+ (or similar), a sudo user, and a domain A-record pointing at the VPS (optional for a
  first smoke test; you can use the raw IP).
- Node.js 22+, git, nginx, and pm2.

```bash
sudo apt update && sudo apt install -y git nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2
```

Foundry is only needed if you want to run contract tests on the box; the deploy does not need it.

## 1. Clone

The repo is private. Use a deploy key or a `gh` token / PAT for the clone.

```bash
cd /opt && sudo mkdir -p agentpad && sudo chown "$USER" agentpad
git clone https://github.com/jeffersonnnn/agentpad.git /opt/agentpad
cd /opt/agentpad
```

## 2. Place the secrets (never committed)

Copy these from your laptop over SSH (encrypted in transit). From the laptop repo root:

```bash
scp .env               USER@VPS:/opt/agentpad/.env
scp web/.env.local     USER@VPS:/opt/agentpad/web/.env.local        # NEXT_PUBLIC_* only
scp -r agent/.secrets  USER@VPS:/opt/agentpad/agent/.secrets        # the granted session key(s)
```

On the box, lock them down:

```bash
chmod 600 /opt/agentpad/.env /opt/agentpad/web/.env.local
chmod 700 /opt/agentpad/agent/.secrets && chmod 600 /opt/agentpad/agent/.secrets/*
```

`web/.env.local` for production (public values only):

```
NEXT_PUBLIC_API_BASE=
NEXT_PUBLIC_RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
```

Note: the keeper's holder snapshot needs a paid RPC tier or a bounded `KEEPER_LOG_FROM_BLOCK` in
`.env` (the free tier caps `eth_getLogs` at 10 blocks). See `docs/PRE-MAINNET-CHECKLIST.md`.

## 3. Install and build

```bash
cd /opt/agentpad
( cd web   && npm ci && npm run build )
( cd api   && npm ci )
( cd agent && npm ci )
```

The DB schema is already applied to Neon. If you ever need to re-apply: `cd api && npm run migrate`.

## 4. Start with pm2

```bash
cd /opt/agentpad
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup            # run the command it prints, so pm2 resurrects on reboot
pm2 status
pm2 logs agentpad-web  # confirm the site is up on :3000
```

To deploy the SITE ONLY (no live money loop), comment out the `agentpad-powell` app in
`deploy/ecosystem.config.cjs` before `pm2 start`.

## 5. nginx + TLS

```bash
sudo cp deploy/nginx/agentpad.conf.example /etc/nginx/sites-available/agentpad
sudo sed -i 's/YOUR_DOMAIN/your.domain.here/' /etc/nginx/sites-available/agentpad
sudo ln -s /etc/nginx/sites-available/agentpad /etc/nginx/sites-enabled/agentpad
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.here
```

## 6. Verify

- Open the domain: the landing, `/board`, `/square`, `/create` render.
- `pm2 logs agentpad-powell`: the loop connects its MCP servers, reads prices, and narrates. A trade
  row carries an on-chain `tx_hash` you can open on `robinhoodchain.blockscout.com`.
- `pm2 logs agentpad-keeper`: a run every 15 min sweeps fees and (when profit clears the high-water
  mark) publishes a distribution epoch.

## 7. Updating

```bash
cd /opt/agentpad && git pull
( cd web && npm ci && npm run build )
pm2 reload agentpad-web
pm2 restart agentpad-powell agentpad-keeper
```

## Guard rails (read before enabling the money loop)

`agentpad-powell` trades real assets with real value. Its trades are bounded in code by the session
key (RWA allow-list, per-trade cap, own-account-only) and the freshness gate, but the open hard gates
from `docs/PRE-MAINNET-CHECKLIST.md` still apply: a security audit, a key-management review, and the
legal review. Deploy the site first; enable `agentpad-powell` only when you have decided those gates
are cleared for your risk tolerance.
