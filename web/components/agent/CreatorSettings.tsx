"use client";

// Agent control panel (creator only). One card with the controls a creator needs to run or wind down
// their agent: pause/resume, the payout policy, and withdraw (sweep the account back to their wallet).
// Renders nothing unless the connected wallet is the agent's creator. Every write is wallet-signed. The
// existing "Fund & manage" (top up + claim fees) and "Connect X" cards sit alongside this on the page.

import { useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { Agent, DistributionConfig } from "@/lib/types";
import {
  controlAgent, controlMessage,
  updateDistribution, distributionMessage,
  previewSweep, executeSweep, sweepMessage, type SweepPlan,
} from "@/lib/api";
import { Card, CopyAddress, styles } from "./ui";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", borderRadius: 9, border: "1px solid var(--border)",
  background: "var(--panel-2)", color: "var(--text)", font: "inherit", fontSize: 13.5,
};
const labelStyle: React.CSSProperties = { fontSize: 12.5, color: "var(--muted)", fontWeight: 600, marginBottom: 5, display: "block" };
const rowStyle: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 };

export function CreatorSettings({ agent, distribution }: { agent: Agent; distribution: DistributionConfig | null }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const isCreator = useMemo(
    () => isConnected && !!address && address.toLowerCase() === agent.creator_addr.toLowerCase(),
    [isConnected, address, agent.creator_addr],
  );

  // distribution form state (seeded from the current config)
  const [mode, setMode] = useState<string>(distribution?.mode ?? "off");
  const [pct, setPct] = useState<string>(distribution ? String((distribution.rate_bps ?? 0) / 100) : "20");
  const [cadence, setCadence] = useState<string>(distribution?.cadence ?? "daily");

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [sweep, setSweep] = useState<SweepPlan | null>(null);

  if (!isCreator) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ["agent"] });
  const sign = (message: string) => signMessageAsync({ message }) as Promise<Hex>;
  const run = async (tag: string, fn: () => Promise<void>) => {
    setErr(null); setOk(null); setBusy(tag);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : "failed"); } finally { setBusy(null); }
  };

  async function togglePause() {
    const action = agent.paused ? "resume" : "pause";
    await run("pause", async () => {
      const message = controlMessage(agent.id, action, new Date().toISOString());
      await controlAgent(agent.id, { action, message, signature: await sign(message) });
      setOk(action === "pause" ? "Agent paused." : "Agent resumed.");
      await refresh();
    });
  }

  async function saveDistribution() {
    const rateBps = Math.round(Number(pct) * 100);
    if (!Number.isFinite(rateBps) || rateBps < 0 || rateBps > 10000) { setErr("Rate must be 0-100%."); return; }
    await run("dist", async () => {
      const message = distributionMessage(agent.id, mode, rateBps, cadence, new Date().toISOString());
      await updateDistribution(agent.id, { mode, rate_bps: rateBps, cadence, message, signature: await sign(message) });
      setOk("Payout policy saved.");
      await refresh();
    });
  }

  async function doPreview() {
    await run("preview", async () => { setSweep(await previewSweep(agent.id)); });
  }
  async function doSweep() {
    if (!address) return;
    await run("sweep", async () => {
      const message = sweepMessage(agent.id, address, new Date().toISOString());
      const res = await executeSweep(agent.id, { to: address, message, signature: await sign(message) });
      setSweep(res);
      setOk(res.swept ? "Withdrawn to your wallet." : res.reason || "Nothing to withdraw.");
    });
  }

  return (
    <Card title="Agent controls (creator)">
      {/* Pause / resume */}
      <div className={styles.statRow}>
        <span className={styles.statLabel}>Status</span>
        <span className={styles.statValue}>
          <span className={`${styles.badge} ${agent.paused ? "" : styles.live}`}>
            <span className={styles.dot} /> {agent.paused ? "paused" : "running"}
          </span>
        </span>
      </div>
      <button type="button" onClick={togglePause} disabled={!!busy} className={`${styles.tab} ${agent.paused ? styles.active : ""}`} style={{ marginTop: 4 }}>
        {busy === "pause" ? "Signing…" : agent.paused ? "Resume agent" : "Pause agent"}
      </button>
      <p className={styles.note} style={{ marginTop: 6 }}>Pausing stops the agent reasoning and trading. Fees and payouts are unaffected.</p>

      {/* Distribution policy */}
      <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <label style={labelStyle}>Payout policy</label>
        <div style={rowStyle}>
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ ...inputStyle, flex: "1 1 120px" }}>
            <option value="off">Off</option>
            <option value="distribute">Distribute to holders</option>
            <option value="buyback">Buy back</option>
          </select>
          <select value={cadence} onChange={(e) => setCadence(e.target.value)} style={{ ...inputStyle, flex: "1 1 110px" }}>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <input type="number" min={0} max={100} step={1} value={pct} onChange={(e) => setPct(e.target.value)} placeholder="20" style={{ ...inputStyle, flex: "0 0 88px" }} title="percent of gains" />
        </div>
        <p className={styles.note}>Share of realized gains above the high-water mark paid each cadence (percent).</p>
        <button type="button" onClick={saveDistribution} disabled={!!busy} className={styles.tab} style={{ marginTop: 8 }}>
          {busy === "dist" ? "Signing…" : "Save policy"}
        </button>
      </div>

      {/* Withdraw / sweep */}
      <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <label style={labelStyle}>Withdraw (shut down)</label>
        <p className={styles.note} style={{ marginTop: 0 }}>Sweep this agent&apos;s USDG and positions back to your wallet. ETH gas is left in place.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={doPreview} disabled={!!busy} className={styles.tab}>
            {busy === "preview" ? "Checking…" : "Preview"}
          </button>
          <button type="button" onClick={doSweep} disabled={!!busy || (!!sweep && !sweep.canExecute && !sweep.swept)} className={styles.tab}>
            {busy === "sweep" ? "Signing…" : "Withdraw to my wallet"}
          </button>
        </div>
        {sweep && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--muted)" }}>
            <div>To: <CopyAddress addr={sweep.destination} /></div>
            {sweep.tokens?.length ? (
              sweep.tokens.map((t) => (
                <div key={t.token}>token {t.token.slice(0, 8)}… : {t.amount} base units</div>
              ))
            ) : (
              <div>Nothing to withdraw.</div>
            )}
            {!sweep.canExecute && !sweep.swept && <div style={{ color: "var(--neg)" }}>Needs a little ETH gas in the account to run the withdrawal.</div>}
            {sweep.transfers?.length ? <div style={{ color: "var(--pos)" }}>{sweep.transfers.length} transfer(s) sent.</div> : null}
          </div>
        )}
      </div>

      {err && <div className={styles.errorBox} style={{ marginTop: 12 }}>{err}</div>}
      {ok && <div className={styles.note} style={{ marginTop: 12, color: "var(--pos)" }}>{ok}</div>}
    </Card>
  );
}
