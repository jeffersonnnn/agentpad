"use client";

// The launch form (Milestone 4, BUILD.md). It MIRRORS the PONS create form field-for-field
// (Name, Ticker, Description, Image, X, Telegram, Paired asset, Developer buy, plus the advanced
// creator tax) and adds the three agent fields (trading archetype, persona prompt, distribution
// policy). The creator connects an existing wallet; the signed launch flow lives in useLaunchFlow
// (the server never signs, ADR 0003 / SPEC.md section 8).

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@/components/ConnectButton";
import { Field, ImageUpload, Select, TextArea, TextInput } from "./fields";
import { ArchetypePicker } from "./ArchetypePicker";
import { useLaunchFlow, type LaunchOutcome } from "./useLaunchFlow";
import {
  ARCHETYPE_SLUGS,
  CHAIN_ID,
  CREATOR_TAX_OPTIONS,
  DISTRIBUTION_CADENCES,
  DISTRIBUTION_MODES,
  EXPLORER_URL,
  MAX_CREATOR_TAX_BPS,
  QUOTE_ASSETS,
  type ArchetypeSlug,
  type DistributionCadence,
  type DistributionMode,
  type QuoteAsset,
} from "@/lib/constants";
import type { PrepareLaunchInput } from "@/lib/types";
import styles from "@/app/create/create.module.css";

interface FormState {
  name: string;
  symbol: string;
  description: string;
  logo: string;
  twitter: string;
  telegram: string;
  website: string;
  quote: QuoteAsset;
  developerBuy: string;
  // advanced (PONS)
  creatorTaxBps: string;
  // agent fields
  archetype: ArchetypeSlug | "";
  persona: string;
  distMode: DistributionMode;
  distRatePct: string; // shown as a percent; converted to bps for the backend
  distCadence: DistributionCadence;
}

const INITIAL: FormState = {
  name: "",
  symbol: "",
  description: "",
  logo: "",
  twitter: "",
  telegram: "",
  website: "",
  quote: "ETH",
  developerBuy: "",
  creatorTaxBps: "0",
  archetype: "",
  persona: "",
  distMode: "distribute",
  distRatePct: "50",
  distCadence: "daily",
};

// In-character starter prompts, one per archetype (SPEC.md section 4 / lib/constants ARCHETYPES). The
// creator fills the persona textarea with one of these and then edits it. The template still only sets
// the voice; the archetype enforces the asset set and the risk caps.
const PERSONA_TEMPLATES: Record<ArchetypeSlug, string> = {
  macro:
    "You are a patient macro trader. You watch interest rates, inflation, and the broad economy, and you rotate between safe havens as the picture changes. You hold short-term Treasuries (SGOV) for safety and yield, and you shift into gold (GLD) or silver (SLV) when rates fall or risk rises. You move to USDG cash when you see no clear edge. You prefer to act during market hours and stay calm off-hours. You explain each move in one or two plain sentences.",
  "tech-bull":
    "You are a high-conviction technology trader. You focus on large-cap growth names like NVDA, TSLA, AMD, MSFT, AMZN, META, and GOOGL. You look for momentum, earnings strength, and product cycles, and you accept larger swings for higher upside. You add to your winners and cut your losers quickly. You keep some USDG ready for a better entry. You explain each trade in plain language and name the catalyst you see.",
  "hard-money":
    "You are a hard-money trader who trusts real assets over paper. You trade only gold (GLD) and silver (SLV), and you hold USDG when neither looks attractive. You buy metals when currencies weaken, rates fall, or fear rises, and you trim into strength. You think in long cycles and avoid frequent trading. You explain each move in one or two clear sentences.",
  index:
    "You are a disciplined index trader. You hold broad market ETFs like SPY and QQQ for long-term growth, and you keep short-term Treasuries (SGOV) as a buffer. You add on broad market weakness and trim when valuations stretch. You avoid single-stock bets and keep turnover low. You explain your reasoning in plain, simple terms.",
  "meme-stock":
    "You are a bold, high-volatility trader. You trade names with heavy retail attention like GME, MSTR, and USO, and you expect large swings in both directions. You size each position with care, take profits fast, and cut losses faster. You keep USDG on hand for sudden moves. You explain each trade plainly and name the signal or the story behind it.",
  yield:
    "You are a conservative cash manager. Your main job is to park capital safely and earn steady yield in short-term Treasuries (SGOV) and USDG. You trade rarely, and only to keep the balance between yield and liquidity. You protect principal first and avoid risky bets. You explain each move in one short, clear sentence.",
};

export function CreateAgentForm() {
  const { isConnected, chainId } = useAccount();
  const { launch, reset, progress, outcome, error, errorRef, busy } = useLaunchFlow();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Fill the persona textarea with the starter template for the selected archetype. Only overwrite an
  // existing persona after the creator confirms, so we never wipe their own words silently.
  function applyPersonaTemplate() {
    if (!form.archetype) return;
    const template = PERSONA_TEMPLATES[form.archetype];
    if (form.persona.trim() && !window.confirm("Replace the persona you have written with the starter template?")) {
      return;
    }
    set("persona", template);
  }

  const wrongChain = isConnected && chainId !== CHAIN_ID;

  const errors = useMemo(() => validate(form), [form]);
  const hasErrors = Object.keys(errors).length > 0;
  const done = progress.phase === "done";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (hasErrors || busy || done) return;

    const input = shapeInput(form);
    await launch({ input, developerBuy: form.developerBuy, quote: form.quote });
  }

  // Only surface a field error once the creator has tried to submit (or left the field), so the form
  // does not shout on first paint.
  const show = (key: keyof FormState) => (touched ? errors[key] : undefined);

  if (done && outcome) {
    return <LaunchSuccess outcome={outcome} onReset={() => { reset(); setForm(INITIAL); setTouched(false); }} />;
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      {/* Token basics — mirrors the PONS create form */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Token</h2>
        <p className={styles.sectionSub}>The same fields as the PONS create form.</p>

        <div className={styles.row2}>
          <Field label="Name" htmlFor="name" required error={show("name")}>
            <TextInput id="name" value={form.name} onChange={(v) => set("name", v)} placeholder="Nova" maxLength={64} invalid={!!show("name")} disabled={busy} />
          </Field>
          <Field label="Ticker" htmlFor="symbol" required error={show("symbol")} hint="3-10 letters. Uppercased for you.">
            <TextInput
              id="symbol"
              value={form.symbol}
              onChange={(v) => set("symbol", v.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="NOVA"
              maxLength={10}
              invalid={!!show("symbol")}
              disabled={busy}
            />
          </Field>
        </div>

        <Field label="Description" htmlFor="description">
          <TextArea id="description" value={form.description} onChange={(v) => set("description", v)} placeholder="What this agent does and why." rows={3} maxLength={600} disabled={busy} />
        </Field>

        <Field label="Image" htmlFor="logo" hint="Upload the token logo. It is pinned to IPFS, and the resulting link is stored on-chain." error={show("logo")}>
          <ImageUpload value={form.logo} onChange={(v) => set("logo", v)} disabled={busy} />
        </Field>

        <div className={styles.row3}>
          <Field label="X (Twitter)" htmlFor="twitter">
            <TextInput id="twitter" value={form.twitter} onChange={(v) => set("twitter", v)} placeholder="https://x.com/…" inputMode="url" disabled={busy} />
          </Field>
          <Field label="Telegram" htmlFor="telegram">
            <TextInput id="telegram" value={form.telegram} onChange={(v) => set("telegram", v)} placeholder="https://t.me/…" inputMode="url" disabled={busy} />
          </Field>
          <Field label="Website" htmlFor="website">
            <TextInput id="website" value={form.website} onChange={(v) => set("website", v)} placeholder="https://…" inputMode="url" disabled={busy} />
          </Field>
        </div>
        <p className={styles.note}>
          These are the token&apos;s profile links. To let the agent POST to its own X handle, connect
          your X keys later on the agent page (opt-in, you fund X). The site feed is always on.
        </p>
      </section>

      {/* Market — paired asset + developer buy */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Market</h2>

        <div className={styles.row2}>
          <Field label="Paired asset" htmlFor="quote" hint="What the token pairs against. The treasury converts to USDG for trading either way.">
            <Select id="quote" value={form.quote} onChange={(v) => set("quote", v)} options={QUOTE_ASSETS} disabled={busy} />
          </Field>
          <Field
            label="Developer buy"
            htmlFor="developerBuy"
            hint={`Optional first buy from your own wallet, in ${form.quote}, right after launch. Leave blank to skip.`}
            error={show("developerBuy")}
          >
            <TextInput
              id="developerBuy"
              value={form.developerBuy}
              onChange={(v) => set("developerBuy", v.replace(/[^0-9.]/g, ""))}
              placeholder="0.0"
              inputMode="decimal"
              invalid={!!show("developerBuy")}
              disabled={busy}
            />
          </Field>
        </div>
      </section>

      {/* Agent — the three fields beyond PONS */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Agent</h2>
        <p className={styles.sectionSub}>What makes this a trading agent, not just a coin.</p>

        <Field label="Trading archetype" required hint="A template that fixes the asset universe and the risk caps. Pick one." error={show("archetype")}>
          <ArchetypePicker value={form.archetype} onChange={(v) => set("archetype", v)} disabled={busy} />
        </Field>

        <Field label="Persona prompt" htmlFor="persona" hint="The voice and the nuance. The archetype enforces the caps; the persona sets the character.">
          {form.archetype ? (
            <button type="button" className={styles.templateLink} onClick={applyPersonaTemplate} disabled={busy}>
              Use a starter template
            </button>
          ) : null}
          <TextArea id="persona" value={form.persona} onChange={(v) => set("persona", v)} placeholder="You are a patient macro trader who rotates to safe havens when rates rise…" rows={5} maxLength={2000} disabled={busy} />
        </Field>

        <Field label="Distribution policy" hint="How trading profits reach holders (ADR 0002). Under legal review.">
          <div className={styles.row3}>
            <Select value={form.distMode} onChange={(v) => set("distMode", v)} options={DISTRIBUTION_MODES} disabled={busy} />
            <div className={styles.inline} hidden={form.distMode === "off"}>
              <TextInput
                value={form.distRatePct}
                onChange={(v) => set("distRatePct", v.replace(/[^0-9.]/g, ""))}
                placeholder="50"
                inputMode="decimal"
                invalid={!!show("distRatePct")}
                disabled={busy}
              />
              <span className={styles.suffix}>% of profit</span>
            </div>
            <Select value={form.distCadence} onChange={(v) => set("distCadence", v)} options={DISTRIBUTION_CADENCES} disabled={busy || form.distMode === "off"} />
          </div>
        </Field>
        {show("distRatePct") ? <p className={styles.error}>{show("distRatePct")}</p> : null}
      </section>

      {/* Advanced — PONS creator tax */}
      <section className={styles.section}>
        <button type="button" className={styles.advancedToggle} onClick={() => setShowAdvanced((s) => !s)} aria-expanded={showAdvanced}>
          <span className={styles.chevron} data-open={showAdvanced || undefined} aria-hidden="true" />
          Advanced options
        </button>

        <div hidden={!showAdvanced} className={styles.advancedBody}>
          <Field
            label="Creator tax"
            htmlFor="creatorTaxBps"
            hint="An optional extra fee added to every buy and sell of your token, on top of the standard pool fee, paid to you the creator. Most creators leave this at 0%."
            error={show("creatorTaxBps")}
          >
            <Select
              id="creatorTaxBps"
              value={form.creatorTaxBps}
              onChange={(v) => set("creatorTaxBps", v)}
              options={CREATOR_TAX_OPTIONS}
              disabled={busy}
            />
          </Field>
        </div>
      </section>

      {/* Launch */}
      <section className={styles.launchBar}>
        {!isConnected ? (
          <div className={styles.launchConnect}>
            <p className={styles.sectionSub}>Connect a wallet on Robinhood Chain to launch.</p>
            <ConnectButton />
          </div>
        ) : wrongChain ? (
          <div className={styles.launchConnect}>
            <p className={styles.sectionSub}>Your wallet is on the wrong network.</p>
            <ConnectButton />
          </div>
        ) : (
          <>
            <div className={styles.launchMeta}>
              <span>Launch fee</span>
              <strong>0.0005 ETH</strong>
              <span className={styles.launchMetaNote}>No markup. Our revenue is the 20% fee cut.</span>
            </div>
            <button type="submit" className={styles.launchButton} disabled={busy || (touched && hasErrors)}>
              {busy ? progress.message || "Working…" : "Launch agent"}
            </button>
          </>
        )}

        {busy && progress.message ? <LaunchProgressBar phase={progress.phase} message={progress.message} /> : null}
        {error ? (
          <div className={styles.launchError} role="alert">
            <strong>Launch failed.</strong> {error}
            {errorRef ? <span className={styles.errorRef}>Reference: {errorRef}</span> : null}
            <button type="button" className={styles.retryButton} onClick={reset}>
              Dismiss
            </button>
          </div>
        ) : null}
        {touched && hasErrors && !busy ? (
          <p className={styles.launchHint}>Fix the highlighted fields above to launch.</p>
        ) : null}
      </section>
    </form>
  );
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────
function validate(form: FormState): Partial<Record<keyof FormState, string>> {
  const e: Partial<Record<keyof FormState, string>> = {};

  if (!form.name.trim()) e.name = "A name is required.";
  if (!form.symbol.trim()) e.symbol = "A ticker is required.";
  else if (form.symbol.trim().length < 3) e.symbol = "Use at least 3 characters.";

  if (!form.archetype || !ARCHETYPE_SLUGS.includes(form.archetype as ArchetypeSlug)) {
    e.archetype = "Pick a trading archetype.";
  }

  if (form.logo.trim() && !isHttpUrl(form.logo.trim())) {
    e.logo = "Enter a full http(s) URL, or leave it blank.";
  }

  if (form.developerBuy.trim()) {
    const n = Number(form.developerBuy);
    if (!Number.isFinite(n) || n < 0) e.developerBuy = "Enter a positive amount, or leave it blank.";
  }

  const tax = Number(form.creatorTaxBps || "0");
  if (!Number.isInteger(tax) || tax < 0 || tax > MAX_CREATOR_TAX_BPS) {
    e.creatorTaxBps = `Enter a whole number from 0 to ${MAX_CREATOR_TAX_BPS}.`;
  }

  if (form.distMode !== "off") {
    const pct = Number(form.distRatePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      e.distRatePct = "Enter a percent from 0 to 100.";
    }
  }

  return e;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Shape the form into the prepareLaunch input (lib/types PrepareLaunchInput). `creator` is filled by
// the launch flow from the connected wallet. Percent -> bps for the distribution rate.
function shapeInput(form: FormState): Omit<PrepareLaunchInput, "creator"> {
  const ratePct = Number(form.distRatePct || "0");
  return {
    archetype: form.archetype as ArchetypeSlug,
    name: form.name.trim(),
    symbol: form.symbol.trim(),
    description: form.description.trim() || undefined,
    logo: form.logo.trim() || undefined,
    persona: form.persona.trim() || undefined,
    quote: form.quote,
    creatorTaxBps: Number(form.creatorTaxBps || "0"),
    socials: {
      twitter: form.twitter.trim() || undefined,
      telegram: form.telegram.trim() || undefined,
      website: form.website.trim() || undefined,
    },
    distribution: {
      mode: form.distMode,
      rate_bps: form.distMode === "off" ? 0 : Math.round(ratePct * 100),
      cadence: form.distCadence,
    },
  };
}

// ── progress + success ──────────────────────────────────────────────────────────────────────────
const PHASE_ORDER = ["preparing", "resolving", "awaiting-signature", "confirming", "finalizing", "dev-buy"] as const;

function LaunchProgressBar({ phase, message }: { phase: string; message: string }) {
  const idx = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);
  const pct = idx < 0 ? 0 : ((idx + 1) / PHASE_ORDER.length) * 100;
  return (
    <div className={styles.progress} role="status" aria-live="polite">
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.progressMsg}>{message}</p>
    </div>
  );
}

function LaunchSuccess({ outcome, onReset }: { outcome: LaunchOutcome; onReset: () => void }) {
  const tx = `${EXPLORER_URL}/tx/${outcome.launchTxHash}`;
  const token = `${EXPLORER_URL}/address/${outcome.tokenAddr}`;
  return (
    <div className={styles.success}>
      <h2 className={styles.successTitle}>Your agent is live</h2>
      <p className={styles.sectionSub}>
        The token launched, the fee splitter is wired, and the agent loop is starting.
      </p>
      <dl className={styles.successGrid}>
        <div>
          <dt>Token</dt>
          <dd><a href={token} target="_blank" rel="noreferrer">{outcome.tokenAddr}</a></dd>
        </div>
        <div>
          <dt>Curve</dt>
          <dd>{outcome.curveAddr}</dd>
        </div>
        <div>
          <dt>Fee splitter</dt>
          <dd>{outcome.splitterAddr}</dd>
        </div>
        <div>
          <dt>Agent account</dt>
          <dd>{outcome.accountAddr}</dd>
        </div>
        <div>
          <dt>Launch tx</dt>
          <dd><a href={tx} target="_blank" rel="noreferrer">{outcome.launchTxHash}</a></dd>
        </div>
        {outcome.devBuyTxHash ? (
          <div>
            <dt>Developer buy</dt>
            <dd><a href={`${EXPLORER_URL}/tx/${outcome.devBuyTxHash}`} target="_blank" rel="noreferrer">{outcome.devBuyTxHash}</a></dd>
          </div>
        ) : null}
      </dl>
      {outcome.devBuyError ? (
        <p className={styles.note}>The agent launched, but the developer buy did not go through: {outcome.devBuyError}</p>
      ) : null}
      <div className={styles.successActions}>
        <a className={styles.launchButton} href={`/agent/${encodeURIComponent(outcome.agentId)}`}>View the agent page</a>
        <button type="button" className={styles.retryButton} onClick={onReset}>Launch another</button>
      </div>
    </div>
  );
}
