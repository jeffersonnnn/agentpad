"use client";

// Take-profit / stop-loss rules (creator only). A self-contained block that drops INSIDE the "Agent
// controls (creator)" card. Two inputs (take-profit %, stop-loss %) and a wallet-signed Save. The rules
// drive the loop's auto-exit (agent/loop.mjs maybeAutoExit): the agent sells a full position into USDG
// when its unrealized PnL crosses the threshold, which realizes the gain the keeper pays holders with.
// Renders nothing unless the connected wallet is the agent's creator. Matches CreatorSettings styling.

import { useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { Agent, TradeRules } from "@/lib/types";
import { updateTradeRules, rulesMessage } from "@/lib/api";
import { styles } from "./ui";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", borderRadius: 9, border: "1px solid var(--border)",
  background: "var(--panel-2)", color: "var(--text)", font: "inherit", fontSize: 13.5,
};
const labelStyle: React.CSSProperties = { fontSize: 12.5, color: "var(--muted)", fontWeight: 600, marginBottom: 5, display: "block" };
const rowStyle: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 };

export function TradeRulesControl({ agent, rules }: { agent: Agent; rules: TradeRules | null }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const isCreator = useMemo(
    () => isConnected && !!address && address.toLowerCase() === agent.creator_addr.toLowerCase(),
    [isConnected, address, agent.creator_addr],
  );

  // form state, seeded from the current rules (bps -> percent). 0 means the rule is off.
  const [tp, setTp] = useState<string>(rules && rules.take_profit_bps > 0 ? String(rules.take_profit_bps / 100) : "0");
  const [sl, setSl] = useState<string>(rules && rules.stop_loss_bps > 0 ? String(rules.stop_loss_bps / 100) : "0");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (!isCreator) return null;

  const sign = (message: string) => signMessageAsync({ message }) as Promise<Hex>;

  async function save() {
    setErr(null);
    setOk(null);
    const tpPct = Number(tp);
    const slPct = Number(sl);
    if (!Number.isFinite(tpPct) || tpPct < 0 || tpPct > 1000) { setErr("Take-profit must be 0-1000%."); return; }
    if (!Number.isFinite(slPct) || slPct < 0 || slPct > 100) { setErr("Stop-loss must be 0-100%."); return; }
    const tpBps = Math.round(tpPct * 100);
    const slBps = Math.round(slPct * 100);
    setBusy(true);
    try {
      const message = rulesMessage(agent.id, tpBps, slBps, new Date().toISOString());
      await updateTradeRules(agent.id, {
        take_profit_pct: tpPct,
        stop_loss_pct: slPct,
        message,
        signature: await sign(message),
      });
      setOk("Rules saved.");
      qc.invalidateQueries({ queryKey: ["agent"] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
      <label style={labelStyle}>Take-profit / stop-loss</label>
      <div style={rowStyle}>
        <div style={{ flex: "1 1 120px" }}>
          <label style={labelStyle}>Take-profit %</label>
          <input
            type="number" min={0} max={1000} step={1} value={tp}
            onChange={(e) => setTp(e.target.value)} placeholder="0" style={inputStyle}
            title="gain percent that triggers an auto-sell"
          />
        </div>
        <div style={{ flex: "1 1 120px" }}>
          <label style={labelStyle}>Stop-loss %</label>
          <input
            type="number" min={0} max={100} step={1} value={sl}
            onChange={(e) => setSl(e.target.value)} placeholder="0" style={inputStyle}
            title="loss percent that triggers an auto-sell"
          />
        </div>
      </div>
      <p className={styles.note}>Auto-sell a position when its gain/loss crosses this. 0 = off.</p>
      <button type="button" onClick={save} disabled={busy} className={styles.tab} style={{ marginTop: 8 }}>
        {busy ? "Signing…" : "Save rules"}
      </button>
      {err && <div className={styles.errorBox} style={{ marginTop: 12 }}>{err}</div>}
      {ok && <div className={styles.note} style={{ marginTop: 12, color: "var(--pos)" }}>{ok}</div>}
    </div>
  );
}
