"use client";

// Copyable contract-address chip for the hero. Shows "Contract: coming soon" until the token address
// is live; clicking copies the value (the address once set, "coming soon" until then) and flashes
// "Copied". Set NEXT_PUBLIC_CONTRACT_ADDRESS to reveal the real address without a code change.

import { useState } from "react";
import styles from "@/app/landing.module.css";
import { PLATFORM_TOKEN } from "@/lib/constants";

const CONTRACT = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS?.trim() || PLATFORM_TOKEN || "").trim();
const DISPLAY = CONTRACT || "coming soon";

export function ContractChip() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(DISPLAY);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked (insecure context / permissions) — ignore, the value is still visible
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={styles.contractChip}
      title="Copy contract address"
      aria-label={`Contract address: ${DISPLAY}. Click to copy.`}
    >
      <span className={styles.contractLabel}>Contract</span>
      <span className={styles.contractValue}>{DISPLAY}</span>
      <span className={styles.contractCopy} aria-hidden>
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
