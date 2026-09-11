"use client";

// The agent wallet + treasury. Shows the ERC-4337 account address, its live native-ETH balance
// (pays its own gas — ADR 0004), its USDG base-currency balance (SPEC.md section 5), the fee
// splitter and distributor addresses, and the current stock/RWA holdings from the positions table.

import type { Address } from "viem";
import type { Agent, Position } from "@/lib/types";
import { assetInfo, fmtAmount, fmtUsdg, useEthBalance, useUsdgBalance } from "./onchain";
import { AddressPill, Card, Empty, StatRow, styles } from "./ui";
import { formatEther } from "viem";

export function TreasuryPanel({ agent, positions }: { agent: Agent; positions: Position[] }) {
  const account = agent.account_addr;
  const eth = useEthBalance(account);
  const usdg = useUsdgBalance(account);

  return (
    <Card title="Wallet & Treasury">
      <StatRow label="Agent account (ERC-4337)">
        <AddressPill addr={account} />
      </StatRow>
      <StatRow label="ETH (gas)">
        <span className={styles.statValueMono}>
          {eth.value === null ? "—" : `${Number(formatEther(eth.value)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`}
        </span>
      </StatRow>
      <StatRow label="USDG (base currency)">
        <span className={styles.statValueMono}>{usdg.value === null ? "—" : fmtUsdg(usdg.value)}</span>
      </StatRow>
      <StatRow label="Fee splitter">
        <AddressPill addr={agent.splitter_addr} />
      </StatRow>
      <StatRow label="Profit distributor">
        <AddressPill addr={agent.distributor_addr} />
      </StatRow>
      <StatRow label="Creator">
        <AddressPill addr={agent.creator_addr} />
      </StatRow>

      <h3 className={styles.cardTitle} style={{ marginTop: 20 }}>
        Positions
      </h3>
      {positions.length === 0 ? (
        <Empty>No open positions yet.</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Asset</th>
                <th className={styles.num}>Amount</th>
                <th className={styles.num}>Cost basis</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const info = assetInfo(p.asset);
                return (
                  <tr key={p.asset}>
                    <td>
                      <AddressPill addr={p.asset} kind="token" label={info.ticker} />
                    </td>
                    <td className={styles.num}>{fmtAmount(p.amount, info.decimals)}</td>
                    <td className={styles.num}>{fmtUsdg(p.cost_basis_usdg)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>
        Balances are read live on Robinhood Chain (4663). The account pays its own gas from its ETH
        balance; no sponsorship (ADR 0004).
      </p>
    </Card>
  );
}

export type { Address };
