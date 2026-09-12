"use client";

// Small presentational primitives shared by the agent page + board. Styling comes from the shared
// agent.module.css. No data fetching here.

import { useState, type ReactNode } from "react";
import { ARCHETYPES } from "@/lib/constants";
import type { AgentStatus } from "@/lib/types";
import { addrUrl, shortAddr } from "./onchain";
import styles from "./agent.module.css";

const ARCHETYPE_LABEL = new Map(ARCHETYPES.map((a) => [a.slug, a.label]));

export function archetypeLabel(slug: string): string {
  return ARCHETYPE_LABEL.get(slug as never) ?? slug;
}

export function StatusBadge({ status }: { status: AgentStatus | string }) {
  const cls = [styles.badge, styles[status as keyof typeof styles] as string].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      <span className={styles.dot} />
      {status}
    </span>
  );
}

export function ArchetypeChip({ slug }: { slug: string }) {
  return <span className={styles.chip}>{archetypeLabel(slug)}</span>;
}

/** Monospace explorer link for an address. `kind` picks the explorer path. */
export function AddressPill({
  addr,
  kind = "address",
  label,
}: {
  addr?: string | null;
  kind?: "address" | "token";
  label?: string;
}) {
  if (!addr) return <span className={styles.muted}>—</span>;
  const href = kind === "token" ? `${addrUrl(addr)}` : addrUrl(addr);
  return (
    <a className={styles.addr} href={href} target="_blank" rel="noreferrer" title={addr}>
      {label ?? shortAddr(addr)}
    </a>
  );
}

// The public Pinata gateway is rate-limited and often fails; retry the same CID on other public
// gateways, then fall back to a monogram tile, so a logo never renders as a broken image.
function ipfsFallbacks(url: string): string[] {
  const m = url.match(/\/ipfs\/([A-Za-z0-9]+.*)$/);
  if (!m) return [url];
  const cid = m[1];
  return Array.from(new Set([url, `https://ipfs.io/ipfs/${cid}`, `https://dweb.link/ipfs/${cid}`]));
}

/** Token logo with graceful gateway fallback, then a lettered monogram tile. */
export function TokenLogo({
  src,
  symbol,
  size = 44,
}: {
  src?: string | null;
  symbol?: string | null;
  size?: number;
}) {
  const chain = src ? ipfsFallbacks(src) : [];
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const dim = { width: size, height: size } as const;
  const letter = (symbol || "?").replace(/^\$/, "").charAt(0).toUpperCase() || "?";

  if (!src || failed || idx >= chain.length) {
    return (
      <span className={styles.logoFallback} style={dim} aria-hidden>
        {letter}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={chain[idx]}
      alt={symbol ? `${symbol} logo` : "token logo"}
      className={styles.logoImg}
      style={dim}
      referrerPolicy="no-referrer"
      loading="eager"
      onError={() => (idx < chain.length - 1 ? setIdx((i) => i + 1) : setFailed(true))}
    />
  );
}

/** Shortened address chip with a one-click copy (copies the FULL address; flashes "Copied") + Explorer. */
export function CopyAddress({ addr, label }: { addr?: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!addr) return <span className={styles.muted}>—</span>;
  async function copy() {
    try {
      await navigator.clipboard.writeText(addr as string);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked (insecure context) — the value is still visible to select manually
    }
  }
  return (
    <span className={styles.copyRow}>
      {label ? <span className={styles.copyLabel}>{label}</span> : null}
      <code className={styles.copyValue} title={addr}>
        {shortAddr(addr)}
      </code>
      <button type="button" className={styles.copyBtn} onClick={copy} aria-label="Copy full address">
        {copied ? "Copied" : "Copy"}
      </button>
      <a className={styles.copyBtn} href={addrUrl(addr)} target="_blank" rel="noreferrer">
        Explorer
      </a>
    </span>
  );
}

export function StatRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.statRow}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{children}</span>
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={styles.card}>
      {title && <h2 className={styles.cardTitle}>{title}</h2>}
      {children}
    </section>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <div className={styles.skel} style={{ height, width }} />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className={styles.errorBox}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

/** Human "3m ago" style relative time; falls back to a locale date for older items. */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export { styles };
