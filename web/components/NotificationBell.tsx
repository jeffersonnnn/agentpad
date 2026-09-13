"use client";

// The alerts bell (Follow + Alerts / roadmap item 3). Shows the connected wallet's in-app notifications
// (its followed agents' trades and distributions), newest first, with an unread badge. Unread is a
// per-viewer, client-side "last seen" high-water mark in localStorage (the notification id), so opening
// the bell clears the badge without any mutate-by-address server call. Renders nothing until a wallet is
// connected. Polls the read-only /api/notifications endpoint.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { getNotifications, type NotificationItem } from "@/lib/api";

function seenKey(addr: string): string {
  return `slingshot_notif_seen_${addr.toLowerCase()}`;
}
function readSeen(addr: string): bigint {
  try {
    const v = localStorage.getItem(seenKey(addr));
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}
function writeSeen(addr: string, id: bigint) {
  try {
    localStorage.setItem(seenKey(addr), id.toString());
  } catch {
    /* private mode or blocked — the badge just will not persist; harmless */
  }
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function NotificationBell() {
  const { address, isConnected } = useAccount();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<bigint>(0n);
  const wrapRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ["notifications", address ?? "anon"],
    queryFn: () => getNotifications(address as `0x${string}`),
    enabled: isConnected && !!address,
    refetchInterval: 60_000,
  });

  const items: NotificationItem[] = useMemo(() => q.data ?? [], [q.data]);

  // Load the saved high-water mark once the wallet is known.
  useEffect(() => {
    if (address) setSeen(readSeen(address));
  }, [address]);

  const maxId = useMemo(() => items.reduce((m, n) => (BigInt(n.id) > m ? BigInt(n.id) : m), 0n), [items]);
  const unread = useMemo(() => items.filter((n) => BigInt(n.id) > seen).length, [items, seen]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!isConnected || !address) return null;

  function toggle() {
    const next = !open;
    setOpen(next);
    // Opening clears the badge: mark everything currently shown as seen.
    if (next && maxId > seen) {
      setSeen(maxId);
      writeSeen(address as string, maxId);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `${unread} unread alerts` : "Alerts"}
        title="Alerts"
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 38,
          height: 38,
          borderRadius: 10,
          border: "1px solid rgba(255,255,255,0.16)",
          background: "rgba(255,255,255,0.06)",
          color: "#fff",
          cursor: "pointer",
          fontSize: 17,
          lineHeight: 1,
        }}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: -5,
              right: -5,
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              borderRadius: 999,
              background: "#e5484d",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 46,
            width: 340,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: 440,
            overflowY: "auto",
            background: "hsl(201 60% 9%)",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 14,
            boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
            zIndex: 60,
            padding: 8,
          }}
        >
          <div style={{ padding: "8px 10px 10px", fontWeight: 700, fontSize: 14, color: "#fff", display: "flex", justifyContent: "space-between" }}>
            <span>Alerts</span>
            <Link href="/portfolio" style={{ color: "hsl(199 92% 74%)", textDecoration: "none", fontSize: 12.5, fontWeight: 600 }}>
              My agents →
            </Link>
          </div>
          {q.isLoading ? (
            <div style={{ padding: 16, color: "hsl(240 5% 66%)", fontSize: 13 }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 16, color: "hsl(240 5% 66%)", fontSize: 13 }}>
              No alerts yet. Follow an agent to get pinged on its trades and distributions.
            </div>
          ) : (
            items.map((n) => {
              const body = (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: BigInt(n.id) > seen ? "rgba(120,205,255,0.10)" : "transparent",
                    marginBottom: 2,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: n.kind === "distribution" ? "#35d07f" : "hsl(199 92% 74%)" }}>
                      {n.title}
                    </span>
                    <span style={{ fontSize: 11, color: "hsl(240 5% 56%)", flexShrink: 0 }}>{relTime(n.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "hsl(240 6% 82%)", marginTop: 3, lineHeight: 1.4 }}>{n.body}</div>
                </div>
              );
              return n.url ? (
                <Link key={n.id} href={n.url.replace(/^https?:\/\/[^/]+/, "")} style={{ textDecoration: "none", display: "block" }} onClick={() => setOpen(false)}>
                  {body}
                </Link>
              ) : (
                <div key={n.id}>{body}</div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
