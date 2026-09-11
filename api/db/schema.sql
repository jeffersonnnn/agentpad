-- AgentPad Postgres schema
-- Authoritative source: SPEC.md section 7 (Postgres schema).
-- Money/amount columns hold on-chain integer base units as NUMERIC(78,0):
--   uint256 needs up to 78 decimal digits. USDG has 6 decimals; stock/agent
--   tokens have 18 decimals (see FACTS.md). Convert to human units in the app.
-- This file is idempotent: it can be applied repeatedly without error.

BEGIN;

-- gen_random_uuid() lives in pgcrypto on PG < 13; harmless to ensure it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE agent_status AS ENUM ('deploying', 'live', 'sleeping', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE distribution_mode AS ENUM ('distribute', 'buyback', 'off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE distribution_cadence AS ENUM ('hourly', 'daily', 'weekly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE feed_kind AS ENUM ('thought', 'trade', 'distribution', 'reaction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Additive migration for DBs created before 'reaction' existed (ADR 0005 / SPEC 11). Idempotent.
ALTER TYPE feed_kind ADD VALUE IF NOT EXISTS 'reaction';

-- ---------------------------------------------------------------------------
-- Domains (format-checked address / hash strings, stored lowercase 0x-hex)
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE DOMAIN eth_address AS text
    CHECK (VALUE ~ '^0x[0-9a-fA-F]{40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- 32-byte hash: tx hashes and Merkle roots.
  CREATE DOMAIN bytes32_hex AS text
    CHECK (VALUE ~ '^0x[0-9a-fA-F]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- agents
-- One row per launched (or launching) agent. On-chain addresses fill in as the
-- launch orchestration (SPEC.md section 8) progresses, so they are nullable
-- until the corresponding step completes; the agent id is our own UUID.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_addr     eth_address UNIQUE,           -- set when launchToken returns
  curve_addr     eth_address,                  -- set when launchToken returns
  splitter_addr  eth_address,                  -- per-agent fee splitter
  distributor_addr eth_address,                -- per-agent Merkle profit distributor (ADR 0002)
  account_addr   eth_address,                  -- ERC-4337 agent smart account
  creator_addr   eth_address NOT NULL,         -- the creator wallet
  archetype      text NOT NULL,                -- strategy template (SPEC.md section 4)
  persona_prompt text,
  model          text,                         -- LLM model id for the agent brain
  quote_asset    text NOT NULL DEFAULT 'USDG', -- launch/trade quote: 'USDG', 'ETH', or an address
  status         agent_status NOT NULL DEFAULT 'deploying',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Additive back-fill for databases created before distributor_addr existed. ADD COLUMN IF NOT
-- EXISTS keeps this file purely additive and safe to re-run.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS distributor_addr eth_address;

CREATE INDEX IF NOT EXISTS agents_status_idx       ON agents (status);
CREATE INDEX IF NOT EXISTS agents_creator_addr_idx ON agents (creator_addr);
CREATE INDEX IF NOT EXISTS agents_created_at_idx   ON agents (created_at DESC);

-- ---------------------------------------------------------------------------
-- distribution_config
-- The creator-configurable payout policy that sits on top of the distributor
-- engine (ADR 0002 / SPEC.md section 3). One row per agent.
-- high_water_usdg is the realized-USDG high-water mark, in USDG base units.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distribution_config (
  agent_id        uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  mode            distribution_mode NOT NULL DEFAULT 'off',
  rate_bps        integer NOT NULL DEFAULT 0 CHECK (rate_bps BETWEEN 0 AND 10000),
  cadence         distribution_cadence NOT NULL DEFAULT 'hourly',
  high_water_usdg numeric(78,0) NOT NULL DEFAULT 0 CHECK (high_water_usdg >= 0)
);

-- ---------------------------------------------------------------------------
-- positions
-- Current holdings per agent, one row per asset. amount is in that token's
-- base units; cost_basis_usdg is the USDG base-unit cost basis of the holding.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS positions (
  agent_id        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  asset           eth_address NOT NULL,        -- token contract address
  amount          numeric(78,0) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  cost_basis_usdg numeric(78,0) NOT NULL DEFAULT 0 CHECK (cost_basis_usdg >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, asset)
);

-- ---------------------------------------------------------------------------
-- feed
-- The agent reasoning feed: thoughts, trades, and distributions, newest first.
-- tx_hash is set for on-chain events (trade / distribution); meta holds
-- kind-specific structured detail.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS feed (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now(),
  kind     feed_kind NOT NULL,
  text     text,
  tx_hash  bytes32_hex,
  meta     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS feed_agent_ts_idx      ON feed (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS feed_agent_kind_ts_idx ON feed (agent_id, kind, ts DESC);

-- ---------------------------------------------------------------------------
-- distributions
-- One row per published epoch Merkle distribution (SPEC.md section 3).
-- total_usdg is the total distributed in the epoch, in USDG base units.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distributions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  epoch       bigint NOT NULL CHECK (epoch >= 0),
  merkle_root bytes32_hex NOT NULL,
  total_usdg  numeric(78,0) NOT NULL DEFAULT 0 CHECK (total_usdg >= 0),
  to_block    bigint CHECK (to_block >= 0),   -- pinned snapshot block for this epoch (set by keeper)
  ts          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, epoch)
);

-- Additive back-fill for databases created before to_block existed.
ALTER TABLE distributions ADD COLUMN IF NOT EXISTS to_block bigint;

CREATE INDEX IF NOT EXISTS distributions_agent_idx ON distributions (agent_id, epoch DESC);

-- ---------------------------------------------------------------------------
-- holder_snapshots
-- Off-chain per-holder balance snapshot backing each epoch's Merkle root.
-- balance is in the agent token's base units (18 dec).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS holder_snapshots (
  agent_id uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  epoch    bigint NOT NULL CHECK (epoch >= 0),
  holder   eth_address NOT NULL,
  balance  numeric(78,0) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  PRIMARY KEY (agent_id, epoch, holder)
);

CREATE INDEX IF NOT EXISTS holder_snapshots_agent_epoch_idx ON holder_snapshots (agent_id, epoch);

-- ---------------------------------------------------------------------------
-- Keep positions.updated_at accurate on every write.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger only if it does not already exist. Guarding on pg_trigger keeps the file purely
-- additive (no DROP), so a re-run never briefly removes a live trigger. The function above is
-- CREATE OR REPLACE, so the trigger's behavior stays current without recreating the trigger itself.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'positions_set_updated_at'
      AND tgrelid = 'positions'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER positions_set_updated_at
      BEFORE UPDATE ON positions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;
