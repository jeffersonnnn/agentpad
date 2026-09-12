"use client";

// Native trade widget — buy and sell the agent token against its PONS bonding curve, ON Slingshot, so
// holders never leave for PONS. The connected wallet signs every trade (we never custody). Buy sends
// the pair asset (ETH as msg.value, or USDG via approve+buy); sell approves the token then calls the
// curve. A minimum-out floor is derived from a live simulate quote with a slippage buffer; if the quote
// cannot be simulated (e.g. insufficient balance to preview), it falls back to 0 and relies on PONS's
// built-in 2-block guard + per-wallet cap, matching the launch dev-buy path.
//
// After graduation the curve stops trading and liquidity is on a Uniswap v4 pool; native v4 routing is
// out of scope here, so a graduated token shows a short note + the market link instead.

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from "viem";
import { CHAIN_ID, USDG, USDG_DECIMALS } from "@/lib/constants";
import { reportClient, describeError } from "@/lib/observatory-client";
import {
  fmtCurvePrice,
  useCurvePrice,
  useErc20Balance,
  useEthBalance,
  useReadyToGraduate,
  useTokenMeta,
  useUsdgBalance,
} from "./onchain";
import { Card, styles } from "./ui";
import type { Agent } from "@/lib/types";

const SLIPPAGE_BPS = 500n; // 5% floor buffer on the simulated quote

const CURVE_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokensIn", type: "uint256" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "quoteOut", type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

type Side = "buy" | "sell";

export function TradePanel({ agent }: { agent: Agent }) {
  const curve = agent.curve_addr as Address | null;
  const token = agent.token_addr as Address | null;
  const isEth = String(agent.quote_asset || "").toUpperCase() === "ETH";
  const pairSym = isEth ? "ETH" : "USDG";

  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const meta = useTokenMeta(token);
  const price = useCurvePrice(curve, agent.quote_asset);
  const graduated = useReadyToGraduate(curve);

  const eth = useEthBalance(address);
  const usdg = useUsdgBalance(address);
  const tokenBal = useErc20Balance(token, address);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const symbol = meta.symbol ? `$${meta.symbol}` : "the token";
  const wrongChain = isConnected && chainId !== CHAIN_ID;

  // Live estimate of what the user receives, from the marginal spot price (indicative, not the min-out).
  const estimate = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || price.pricePerToken === null || price.pricePerToken === 0) return null;
    if (side === "buy") return `${(n / price.pricePerToken).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${meta.symbol || "tokens"}`;
    return `${(n * price.pricePerToken).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${pairSym}`;
  }, [amount, price.pricePerToken, side, meta.symbol, pairSym]);

  const payBal =
    side === "buy"
      ? isEth
        ? eth.value !== null ? `${Number(formatEther(eth.value)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH` : "—"
        : usdg.value !== null ? `${Number(formatUnits(usdg.value, USDG_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDG` : "—"
      : tokenBal.value !== null ? `${Number(formatUnits(tokenBal.value, meta.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${meta.symbol || ""}` : "—";

  async function trade() {
    setErr(null);
    setMsg(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return setErr("Enter an amount greater than 0.");
    if (!walletClient || !publicClient || !address) return setErr("Connect your wallet first.");
    if (chainId !== CHAIN_ID) return setErr("Switch your wallet to Robinhood Chain (4663).");
    if (!curve) return setErr("This token has no curve.");

    setBusy(true);
    try {
      let hash: `0x${string}`;
      if (side === "buy") {
        const quoteIn = isEth ? parseEther(amount) : parseUnits(amount, USDG_DECIMALS);
        // USDG buys must approve the curve to pull the quote first.
        if (!isEth) await ensureAllowance(USDG, quoteIn);
        const minOut = await quoteMinOut("buy", quoteIn);
        hash = await walletClient.writeContract({
          address: curve,
          abi: CURVE_ABI,
          functionName: "buy",
          args: [quoteIn, minOut, address],
          value: isEth ? quoteIn : 0n,
        });
      } else {
        if (!token) return setErr("This token has no address.");
        const tokensIn = parseUnits(amount, meta.decimals);
        await ensureAllowance(token, tokensIn); // curve pulls the tokens to sell
        const minOut = await quoteMinOut("sell", tokensIn);
        hash = await walletClient.writeContract({
          address: curve,
          abi: CURVE_ABI,
          functionName: "sell",
          args: [tokensIn, minOut, address],
        });
      }
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`Trade reverted (${hash}).`);
      setMsg(side === "buy" ? `Bought ${symbol}.` : `Sold ${symbol}.`);
      setAmount("");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setErr(/user rejected|denied/i.test(raw) ? "You rejected the request in your wallet." : raw.split("\n")[0].slice(0, 220));
      const { message, detail } = describeError(e);
      void reportClient({ scope: "agent.trade.client", message, detail: { ...detail, side, agentId: agent.id } });
    } finally {
      setBusy(false);
    }
  }

  // Approve `spender` (the curve) to move `amount` of `erc20` if the current allowance is short.
  async function ensureAllowance(erc20: Address, amount: bigint) {
    if (!publicClient || !walletClient || !address || !curve) return;
    const current = (await publicClient.readContract({
      address: erc20,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address, curve],
    })) as bigint;
    if (current >= amount) return;
    const approveHash = await walletClient.writeContract({
      address: erc20,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [curve, amount],
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (rc.status !== "success") throw new Error("Token approval failed.");
  }

  // Derive a min-out floor from a live simulate; fall back to 0 (PONS guards) if it cannot be simulated.
  async function quoteMinOut(kind: Side, inAmount: bigint): Promise<bigint> {
    if (!publicClient || !address || !curve) return 0n;
    try {
      const sim =
        kind === "buy"
          ? await publicClient.simulateContract({
              address: curve,
              abi: CURVE_ABI,
              functionName: "buy",
              args: [inAmount, 0n, address],
              value: isEth ? inAmount : 0n,
              account: address,
            })
          : await publicClient.simulateContract({
              address: curve,
              abi: CURVE_ABI,
              functionName: "sell",
              args: [inAmount, 0n, address],
              account: address,
            });
      const out = sim.result as bigint;
      if (!out || out <= 0n) return 0n;
      return out - (out * SLIPPAGE_BPS) / 10000n;
    } catch {
      return 0n; // rely on the curve's 2-block guard + per-wallet cap
    }
  }

  if (graduated) {
    return (
      <Card title="Trade">
        <p className={styles.muted}>
          {symbol} has graduated to a Uniswap market. Curve trading is closed — see the Chart card to
          trade on the graduated market.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Trade">
      <div className={styles.tradeTabs}>
        <button type="button" className={side === "buy" ? styles.tradeTabActive : styles.tradeTab} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button type="button" className={side === "sell" ? styles.tradeTabActive : styles.tradeTab} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      <label className={styles.tradeLabel}>
        {side === "buy" ? `Pay (${pairSym})` : `Sell (${meta.symbol || "tokens"})`}
        <span className={styles.tradeBal}>Balance: {payBal}</span>
      </label>
      <input
        className={styles.tradeInput}
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0.0"
        inputMode="decimal"
        disabled={busy}
      />

      <div className={styles.tradeMeta}>
        <span className={styles.muted}>
          Spot {price.pricePerToken !== null ? fmtCurvePrice(price.pricePerToken, price.quoteSymbol) : "—"}
        </span>
        {estimate ? <span className={styles.muted}>≈ {estimate}</span> : null}
      </div>

      {!isConnected ? (
        <p className={styles.muted}>Connect a wallet to trade.</p>
      ) : (
        <button type="button" className={styles.tradeBtn} onClick={trade} disabled={busy || wrongChain}>
          {busy ? "Working…" : side === "buy" ? `Buy ${meta.symbol ? `$${meta.symbol}` : ""}` : `Sell ${meta.symbol ? `$${meta.symbol}` : ""}`}
        </button>
      )}
      {wrongChain ? <p className={styles.topupErr}>Switch to Robinhood Chain (4663).</p> : null}
      {msg ? <p className={styles.topupOk}>{msg}</p> : null}
      {err ? <p className={styles.topupErr}>{err}</p> : null}
      <p className={styles.muted} style={{ fontSize: 12 }}>
        Trades run on the PONS bonding curve. You sign in your wallet; Slingshot never holds your funds.
      </p>
    </Card>
  );
}
