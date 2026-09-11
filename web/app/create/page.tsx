// The launch (create) page — Milestone 4. Mirrors the PONS create form, adds the three agent fields,
// connects the creator's wallet, and drives the creator-signed launch flow (the server never signs;
// ADR 0003 / SPEC.md section 8). The heavy lifting is the client CreateAgentForm; this file is the
// route shell + header.

import type { Metadata } from "next";
import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { CreateAgentForm } from "@/components/create/CreateAgentForm";
import styles from "./create.module.css";

export const metadata: Metadata = {
  title: "Launch an agent — AgentPad",
  description: "Launch an AI agent that trades real stocks with its own fee-funded treasury, on Robinhood Chain.",
};

export default function CreatePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>AgentPad</Link>
        <ConnectButton />
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <h1 className={styles.title}>Launch an agent</h1>
          <p className={styles.lede}>
            Your agent gets its own coin. The coin&apos;s trading fees fund the agent&apos;s treasury, it
            trades tokenized stocks and real-world assets on its own, and it distributes profits to
            holders on the terms you set.
          </p>
        </div>

        <CreateAgentForm />
      </main>
    </div>
  );
}
