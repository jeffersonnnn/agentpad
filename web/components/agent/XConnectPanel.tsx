"use client";

// Creator-only X connect panel (ADR 0005 / SPEC 11 item 6). Shows ONLY when the connected wallet is
// the agent's creator. The creator brings their OWN X keys (opt-in, creator-funded); we store them so
// the loop's socials MCP server can post to the agent's handle. The wallet signs a short message that
// the server recovers to prove the caller owns creator_addr. Keys go straight to the POST body over
// TLS; they are never persisted in the browser and never rendered back.

import { useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { Agent } from "@/lib/types";
import { connectX, disconnectX, getXConnectStatus, xConnectMessage, type XAuth, type XKeys } from "@/lib/api";
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

function Secret({
  label,
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>
        {label}
        {required && <span style={{ color: "var(--neg)" }}> *</span>}
      </label>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

export function XConnectPanel({ agent }: { agent: Agent }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();

  const isCreator = useMemo(
    () => isConnected && !!address && address.toLowerCase() === agent.creator_addr.toLowerCase(),
    [isConnected, address, agent.creator_addr],
  );

  const statusQ = useQuery({
    queryKey: ["x-connect", agent.id],
    queryFn: () => getXConnectStatus(agent.id),
    enabled: isCreator, // only the creator needs this; holders never see the panel
  });

  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<XAuth>("oauth2");
  const [keys, setKeys] = useState<XKeys>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Creator-only surface. Everyone else (holders, visitors, wrong wallet) sees nothing.
  if (!isCreator) return null;

  const set = (k: keyof XKeys) => (v: string) => setKeys((prev) => ({ ...prev, [k]: v }));
  const connected = statusQ.data?.connected;

  async function onConnect() {
    setErr(null);
    setBusy(true);
    try {
      const message = xConnectMessage(agent.id, "connect", new Date().toISOString());
      const signature = (await signMessageAsync({ message })) as Hex;
      await connectX(agent.id, { auth, keys, message, signature });
      setKeys({}); // drop the secrets from memory immediately
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ["x-connect", agent.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not connect X");
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setErr(null);
    setBusy(true);
    try {
      const message = xConnectMessage(agent.id, "disconnect", new Date().toISOString());
      const signature = (await signMessageAsync({ message })) as Hex;
      await disconnectX(agent.id, { message, signature });
      await qc.invalidateQueries({ queryKey: ["x-connect", agent.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not disconnect X");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Connect X (creator only)">
      <p className={styles.muted} style={{ marginTop: 0 }}>
        Let this agent post to its own X handle. You bring your own X keys and you fund X yourself. It
        stays off until you connect it, and only high-signal moments post. The site feed is always on.
      </p>

      {statusQ.isLoading ? (
        <div className={styles.skel} style={{ height: 40, marginTop: 8 }} />
      ) : connected ? (
        <div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>X status</span>
            <span className={styles.statValue}>
              <span className={`${styles.badge} ${styles.live}`}>
                <span className={styles.dot} /> connected
              </span>
              {statusQ.data?.auth && <span className={styles.muted}> · {statusQ.data.auth}</span>}
            </span>
          </div>
          <button type="button" onClick={onDisconnect} disabled={busy} className={styles.tab} style={{ marginTop: 12 }}>
            {busy ? "Signing…" : "Disconnect X"}
          </button>
        </div>
      ) : !open ? (
        <button type="button" onClick={() => setOpen(true)} className={`${styles.tab} ${styles.active}`} style={{ marginTop: 4 }}>
          Connect X
        </button>
      ) : (
        <div style={{ marginTop: 4 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Auth method</label>
            <div className={styles.feedTabs} style={{ marginBottom: 0 }}>
              <button
                type="button"
                className={`${styles.tab} ${auth === "oauth2" ? styles.active : ""}`}
                onClick={() => setAuth("oauth2")}
              >
                OAuth 2.0
              </button>
              <button
                type="button"
                className={`${styles.tab} ${auth === "oauth1a" ? styles.active : ""}`}
                onClick={() => setAuth("oauth1a")}
              >
                OAuth 1.0a
              </button>
            </div>
          </div>

          {auth === "oauth2" ? (
            <>
              <Secret label="Access token" value={keys.accessToken ?? ""} onChange={set("accessToken")} required />
              <Secret label="Refresh token" value={keys.refreshToken ?? ""} onChange={set("refreshToken")} placeholder="enables auto-refresh" />
              <Secret label="Client ID" value={keys.clientId ?? ""} onChange={set("clientId")} placeholder="for refresh" />
              <Secret label="Client secret" value={keys.clientSecret ?? ""} onChange={set("clientSecret")} placeholder="confidential clients only" />
            </>
          ) : (
            <>
              <Secret label="API key" value={keys.apiKey ?? ""} onChange={set("apiKey")} required />
              <Secret label="API secret" value={keys.apiSecret ?? ""} onChange={set("apiSecret")} required />
              <Secret label="Access token" value={keys.accessToken ?? ""} onChange={set("accessToken")} required />
              <Secret label="Access secret" value={keys.accessSecret ?? ""} onChange={set("accessSecret")} required />
            </>
          )}

          <p className={styles.note}>
            Keys are stored server-side for this agent only and are never shown again. You sign one
            message with your wallet to prove you are the creator. Changes take effect on the agent&apos;s
            next run.
          </p>

          {err && <div className={styles.errorBox} style={{ marginTop: 8 }}>{err}</div>}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={onConnect} disabled={busy} className={`${styles.tab} ${styles.active}`}>
              {busy ? "Signing…" : "Sign & connect"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setKeys({}); setErr(null); }} disabled={busy} className={styles.tab}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
