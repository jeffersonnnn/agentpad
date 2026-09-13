"use client";

// Follow + Alerts (roadmap item 3). Any connected wallet can follow an agent to get pinged on its
// trades and distributions. In-app alerts (the bell) are always on for a follow; email and Telegram are
// optional contact channels the follower adds here. Following is wallet-signed: the follower signs a
// short, agent- and action-scoped message the server recovers, so no one can register another wallet
// (or its email) as a follower. This turns a launch into a following.

import { useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { Agent } from "@/lib/types";
import { followAgent, followMessage, getFollowState, unfollowAgent, type FollowChannels } from "@/lib/api";
import { Card, styles } from "./ui";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13.5,
};
const labelStyle: React.CSSProperties = { fontSize: 12.5, color: "var(--muted)", fontWeight: 600, marginBottom: 5, display: "block" };

export function FollowCard({ agent }: { agent: Agent }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();

  const stateQ = useQuery({
    queryKey: ["follow", agent.id, address ?? "anon"],
    queryFn: () => getFollowState(agent.id, address),
    refetchInterval: 60_000,
  });

  const following = stateQ.data?.following ?? false;
  const followers = stateQ.data?.followers ?? 0;
  const current: FollowChannels | null = stateQ.data?.follow ?? null;

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [telegram, setTelegram] = useState("");
  const [onTrade, setOnTrade] = useState(true);
  const [onDistribution, setOnDistribution] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the editable fields from the saved follow when the settings panel opens.
  const seed = useMemo(() => current, [current]);
  function openSettings() {
    setEmail(seed?.email ?? "");
    setTelegram(seed?.telegram ?? "");
    setOnTrade(seed?.onTrade ?? true);
    setOnDistribution(seed?.onDistribution ?? true);
    setErr(null);
    setOpen(true);
  }

  async function sign(action: "follow" | "unfollow"): Promise<{ message: string; signature: Hex }> {
    const message = followMessage(agent.id, action, address as string, new Date().toISOString());
    const signature = (await signMessageAsync({ message })) as Hex;
    return { message, signature };
  }

  async function doFollow(withChannels: boolean) {
    if (!address) return;
    setErr(null);
    setBusy(true);
    try {
      const { message, signature } = await sign("follow");
      await followAgent(agent.id, {
        address,
        email: withChannels ? email || null : current?.email ?? null,
        telegram: withChannels ? telegram || null : current?.telegram ?? null,
        onTrade: withChannels ? onTrade : current?.onTrade ?? true,
        onDistribution: withChannels ? onDistribution : current?.onDistribution ?? true,
        message,
        signature,
      });
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ["follow", agent.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not follow");
    } finally {
      setBusy(false);
    }
  }

  async function doUnfollow() {
    if (!address) return;
    setErr(null);
    setBusy(true);
    try {
      const { message, signature } = await sign("unfollow");
      await unfollowAgent(agent.id, { address, message, signature });
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ["follow", agent.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not unfollow");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Follow this agent">
      <p className={styles.muted} style={{ marginTop: 0 }}>
        Get pinged when this agent trades or pays its holders. Alerts show in your bell; add an email or a
        Telegram chat to also be reached there.
      </p>

      <div className={styles.statRow}>
        <span className={styles.statLabel}>Followers</span>
        <span className={styles.statValue}>{stateQ.isLoading ? "…" : followers}</span>
      </div>

      {!isConnected ? (
        <p className={styles.note} style={{ marginTop: 10 }}>Connect your wallet to follow this agent.</p>
      ) : !following ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={() => doFollow(false)} disabled={busy} className={`${styles.tab} ${styles.active}`}>
            {busy ? "Signing…" : "Follow"}
          </button>
          <button type="button" onClick={openSettings} disabled={busy} className={styles.tab}>
            Follow with alerts…
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>Status</span>
            <span className={styles.statValue}>
              <span className={`${styles.badge} ${styles.live}`}>
                <span className={styles.dot} /> following
              </span>
            </span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>Channels</span>
            <span className={styles.statValue}>
              in-app
              {current?.email ? " · email" : ""}
              {current?.telegram ? " · telegram" : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" onClick={openSettings} disabled={busy} className={styles.tab}>
              Edit alerts
            </button>
            <button type="button" onClick={doUnfollow} disabled={busy} className={styles.tab}>
              {busy ? "Signing…" : "Unfollow"}
            </button>
          </div>
        </div>
      )}

      {open && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Email (optional)</label>
            <input
              type="email"
              autoComplete="email"
              spellCheck={false}
              value={email}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Telegram chat id (optional)</label>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={telegram}
              placeholder="e.g. 123456789 (start the Slingshot bot first)"
              onChange={(e) => setTelegram(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, color: "var(--text)" }}>
              <input type="checkbox" checked={onTrade} onChange={(e) => setOnTrade(e.target.checked)} /> Trades
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, color: "var(--text)" }}>
              <input type="checkbox" checked={onDistribution} onChange={(e) => setOnDistribution(e.target.checked)} /> Distributions
            </label>
          </div>
          <p className={styles.note}>
            You sign one message to save this. Email needs a configured mail sender; Telegram needs the
            Slingshot bot and your chat id. In-app alerts always work.
          </p>
          {err && <div className={styles.errorBox} style={{ marginTop: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={() => doFollow(true)} disabled={busy} className={`${styles.tab} ${styles.active}`}>
              {busy ? "Signing…" : following ? "Save alerts" : "Sign & follow"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setErr(null); }} disabled={busy} className={styles.tab}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {err && !open && <div className={styles.errorBox} style={{ marginTop: 10 }}>{err}</div>}
    </Card>
  );
}
