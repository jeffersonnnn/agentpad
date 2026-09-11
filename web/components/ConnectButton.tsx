"use client";

// Wallet-connect button with a wallet PICKER. Connects an EXISTING wallet — no custody, no embedded
// wallet (ADR 0004/0001). Clicking "Connect wallet" opens a menu of the wallets available in this
// browser: every EIP-6963 injected wallet (MetaMask, Rabby, Brave, the Coinbase extension, ...), plus
// Coinbase Wallet and (when configured) WalletConnect for mobile — see lib/wagmi.ts. When connected on
// the wrong network it offers to switch to Robinhood Chain (4663).

import { useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { Connector } from "wagmi";
import { CHAIN_ID } from "@/lib/constants";
import styles from "./ConnectButton.module.css";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [open, setOpen] = useState(false);

  // Dedupe by wallet name; drop the generic "Injected" entry once named wallets are discovered.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: Connector[] = [];
    for (const c of connectors) {
      const key = c.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(c);
    }
    const named = list.filter((c) => c.name.trim().toLowerCase() !== "injected");
    return named.length ? named : list;
  }, [connectors]);

  if (!isConnected) {
    return (
      <span className={styles.wrap}>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => setOpen((o) => !o)}>
          Connect wallet
        </button>
        {open && (
          <>
            <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden />
            <div className={styles.menu} role="menu">
              <div className={styles.menuHead}>Choose a wallet</div>
              {options.map((c) => {
                const active = variables?.connector;
                const connecting =
                  isPending && !!active && typeof active === "object" && "uid" in active && active.uid === c.uid;
                return (
                  <button
                    key={c.uid}
                    type="button"
                    className={styles.item}
                    role="menuitem"
                    disabled={isPending}
                    onClick={() => {
                      connect({ connector: c });
                      setOpen(false);
                    }}
                  >
                    {c.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className={styles.icon} src={c.icon} alt="" />
                    ) : (
                      <span className={styles.iconFallback}>{c.name.slice(0, 1)}</span>
                    )}
                    {c.name}
                    {connecting && <span className={styles.itemSpin}>connecting…</span>}
                  </button>
                );
              })}
              {options.length === 0 && (
                <div className={styles.menuNote}>No wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.</div>
              )}
            </div>
          </>
        )}
      </span>
    );
  }

  const wrongChain = chainId !== CHAIN_ID;

  return (
    <span className={styles.row}>
      {wrongChain && (
        <button
          type="button"
          className={`${styles.btn} ${styles.warn}`}
          disabled={isSwitching}
          onClick={() => switchChain({ chainId: CHAIN_ID })}
        >
          {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
        </button>
      )}
      <button type="button" className={styles.pill} onClick={() => disconnect()} title={`${address} — click to disconnect`}>
        {!wrongChain && <span className={styles.dot} aria-hidden />}
        {address ? shortAddr(address) : "Disconnect"}
      </button>
    </span>
  );
}
