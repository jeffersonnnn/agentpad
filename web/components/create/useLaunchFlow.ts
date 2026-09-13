"use client";

// The signed launch flow (PLAN.md section 9, SPEC.md section 8). This hook drives the whole
// orchestration from the browser, and the creator's own connected wallet signs every on-chain call.
// THE SERVER NEVER SIGNS the launch (api/launch.mjs "NEVER CUSTODY"): prepareLaunch returns an
// UNSIGNED launchToken tx, the creator signs and broadcasts it, then we relay (token, curve, txHash)
// back to finalizeLaunch.
//
// Steps:
//   1. prepare      POST the form to /api/launch/prepare -> deploys the per-agent splitter, predicts
//                   the ERC-4337 account, returns the UNSIGNED launchToken tx (creatorFeeRecipient =
//                   the splitter, set server-side, ADR 0003).
//   2. resolve      eth_call the unsigned tx (with a balance state-override) to read launchToken's
//                   (token, curve) return values. They are deterministic in (creator, salt) via the
//                   CREATE2 salt, so this pre-resolves the addresses finalize needs.
//   3. sign         the creator's wallet signs + broadcasts the launchToken tx (pays exactly the
//                   0.0005 ETH launch fee, no markup).
//   4. confirm      wait for the receipt.
//   5. finalize     POST (agentId, token, curve, txHash) to /api/launch/finalize -> the backend
//                   verifies the on-chain tx, wires the curve into the splitter, deploys the
//                   distributor, records the row, and starts the agent loop.
//   6. dev buy      OPTIONAL: if a developer buy was set, the creator's wallet buys the fresh token
//                   from its curve (SPEC.md section 9: a separate creator buy, NOT part of launchToken).

import { useCallback, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
  decodeFunctionResult,
  parseEther,
  parseUnits,
} from "viem";
import { prepareLaunch, finalizeLaunch, ApiError } from "@/lib/api";
import { reportClient, describeError } from "@/lib/observatory-client";
import type { PrepareLaunchInput, FinalizeLaunchResult } from "@/lib/types";
import { CHAIN_ID, USDG, USDG_DECIMALS, type QuoteAsset } from "@/lib/constants";

// Minimal ABI for launchToken's return decoding (byte-for-byte outputs from FACTS.md / api/launch.mjs).
const LAUNCH_TOKEN_RESULT_ABI = [
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      { name: "params", type: "tuple", components: [{ name: "name", type: "string" }] },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" },
    ],
  },
] as const;

// PonsV2BondingCurve.buy (FACTS.md "Curve interface"). Native: msg.value == quoteIn.
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
] as const;

// Minimal ERC-20 approve for a USDG-quoted developer buy.
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// The agent account launches empty; give it a small ETH gas buffer so it can grant its trading key and
// trade without a manual top-up (creator-funded, ADR 0004). ~0.003 ETH covers the grant + many trades.
const AGENT_GAS_WEI = parseEther("0.003");

export type LaunchPhase =
  | "idle"
  | "preparing"
  | "resolving"
  | "awaiting-signature"
  | "confirming"
  | "finalizing"
  | "funding-gas"
  | "dev-buy"
  | "done"
  | "error";

export interface LaunchProgress {
  phase: LaunchPhase;
  message: string;
}

export interface LaunchOutcome {
  agentId: string;
  tokenAddr: Address;
  curveAddr: Address;
  splitterAddr: Address;
  accountAddr: Address;
  launchTxHash: Hex;
  finalize: FinalizeLaunchResult;
  gasFundTxHash?: Hex;
  gasFundError?: string;
  devBuyTxHash?: Hex;
  devBuyError?: string;
}

export interface LaunchArgs {
  // The form, already shaped for prepareLaunch. `creator` is filled here from the connected wallet.
  input: Omit<PrepareLaunchInput, "creator">;
  developerBuy?: string; // human amount in the quote asset (e.g. "0.1"); empty/0 = skip
  quote: QuoteAsset;
}

const PHASE_LABELS: Record<LaunchPhase, string> = {
  idle: "",
  preparing: "Deploying the fee splitter and preparing the launch…",
  resolving: "Resolving the token address…",
  "awaiting-signature": "Confirm the launch in your wallet…",
  confirming: "Waiting for the launch to confirm on-chain…",
  finalizing: "Wiring the splitter and starting the agent…",
  "funding-gas": "Funding the agent's gas so it can trade…",
  "dev-buy": "Confirm the developer buy in your wallet…",
  done: "Your agent is live.",
  error: "Something went wrong.",
};

export function useLaunchFlow() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [progress, setProgress] = useState<LaunchProgress>({ phase: "idle", message: "" });
  const [outcome, setOutcome] = useState<LaunchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorRef, setErrorRef] = useState<string | null>(null);

  const set = useCallback((phase: LaunchPhase, message?: string) => {
    setProgress({ phase, message: message ?? PHASE_LABELS[phase] });
  }, []);

  const reset = useCallback(() => {
    setProgress({ phase: "idle", message: "" });
    setOutcome(null);
    setError(null);
    setErrorRef(null);
  }, []);

  const launch = useCallback(
    async ({ input, developerBuy, quote }: LaunchArgs): Promise<LaunchOutcome | null> => {
      setError(null);
      setErrorRef(null);
      setOutcome(null);

      // Track the phase we are in so a failure report says WHERE it broke. `set` alone updates React
      // state, which we cannot read back synchronously inside the catch, so mirror it here.
      let phaseAtFailure: LaunchPhase = "preparing";
      const go = (phase: LaunchPhase, message?: string) => {
        phaseAtFailure = phase;
        set(phase, message);
      };

      if (!publicClient) {
        setError("No RPC client. Reload the page and try again.");
        set("error");
        return null;
      }
      if (!walletClient) {
        setError("Connect your wallet first.");
        set("error");
        return null;
      }
      if (walletClient.chain?.id !== CHAIN_ID) {
        setError("Switch your wallet to Robinhood Chain (4663) before launching.");
        set("error");
        return null;
      }

      const creator = walletClient.account.address as Address;

      try {
        // Step 1 — prepare (server deploys the splitter, predicts the account, returns the unsigned tx).
        go("preparing");
        const prep = await prepareLaunch({ ...input, creator });

        if (prep.alreadyLaunched || !prep.launchTx) {
          setError(
            "This launch was already completed for its id. Reload to start a new agent.",
          );
          set("error");
          return null;
        }

        const to = prep.launchTx.to as Address;
        const data = prep.launchTx.data as Hex;
        const value = BigInt(prep.launchTx.value);

        // Step 2 — resolve (token, curve) by simulating the exact unsigned tx. A balance override
        // covers the value + gas so the call never reverts for a low balance; the addresses come from
        // the CREATE2 salt, so the simulated values match what the real tx will produce.
        go("resolving");
        const sim = await publicClient.call({
          account: creator,
          to,
          data,
          value,
          stateOverride: [{ address: creator, balance: value + parseEther("1") }],
        });
        if (!sim.data) throw new Error("Could not resolve the token address from the launch call.");
        const decoded = decodeFunctionResult({
          abi: LAUNCH_TOKEN_RESULT_ABI,
          functionName: "launchToken",
          data: sim.data,
        }) as unknown as readonly [Address, Address];
        const tokenAddr = decoded[0];
        const curveAddr = decoded[1];

        // Step 3 — the creator signs + broadcasts launchToken (pays exactly the launch fee).
        go("awaiting-signature");
        // The wallet client is already bound to Robinhood Chain (gated above), so viem uses its chain.
        const launchTxHash = await walletClient.sendTransaction({ to, data, value });

        // Step 4 — confirm.
        go("confirming");
        const receipt = await publicClient.waitForTransactionReceipt({ hash: launchTxHash });
        if (receipt.status !== "success") {
          throw new Error(`Launch transaction reverted (${launchTxHash}).`);
        }

        // Step 5 — finalize (server verifies the tx, wires the curve, deploys the distributor,
        // records the row, starts the loop).
        go("finalizing");
        const finalize = await finalizeLaunch({
          agentId: prep.agentId,
          tokenAddr,
          curveAddr,
          txHash: launchTxHash,
        });

        const result: LaunchOutcome = {
          agentId: prep.agentId,
          tokenAddr,
          curveAddr,
          splitterAddr: prep.splitterAddr,
          accountAddr: prep.accountAddr,
          launchTxHash,
          finalize,
        };

        // Step 5b — auto-fund the agent's gas (creator-funded; ADR 0004: the account pays its own gas).
        // A fresh agent account has 0 ETH, so it cannot grant its trading key or trade. Send a small ETH
        // buffer to it now so it comes alive on its own. Non-fatal: a declined/failed send just means the
        // agent reasons until the creator tops it up from the agent page.
        if (result.accountAddr) {
          try {
            go("funding-gas");
            const gasTxHash = await walletClient.sendTransaction({
              to: result.accountAddr,
              value: AGENT_GAS_WEI,
            });
            await publicClient.waitForTransactionReceipt({ hash: gasTxHash });
            result.gasFundTxHash = gasTxHash;
          } catch (e) {
            result.gasFundError = e instanceof Error ? e.message : String(e);
          }
        }

        // Step 6 — optional developer buy (a separate creator-signed curve.buy; SPEC.md section 9).
        // Non-fatal: the agent is already live, so a failed dev buy is recorded but not thrown.
        const buyAmount = (developerBuy ?? "").trim();
        if (buyAmount && Number(buyAmount) > 0) {
          try {
            go("dev-buy");
            const devBuyTxHash = await executeDeveloperBuy({
              walletClient,
              publicClient,
              curveAddr,
              creator,
              quote,
              amount: buyAmount,
            });
            result.devBuyTxHash = devBuyTxHash;
          } catch (e) {
            result.devBuyError = e instanceof Error ? e.message : String(e);
          }
        }

        setOutcome(result);
        go("done");
        return result;
      } catch (e) {
        const msg = normalizeError(e);
        setError(msg);
        set("error");
        // Surface a reference id so the failure reaches the developer (Observatory). A server error
        // (prepare/finalize) already carries a ref in its body; reuse it. Otherwise this broke in the
        // browser (wallet/RPC/resolve) — report it client-side to mint one.
        void (async () => {
          let ref: string | null = null;
          if (e instanceof ApiError && e.body && typeof e.body === "object" && "ref" in e.body) {
            ref = String((e.body as { ref?: unknown }).ref ?? "") || null;
          }
          if (!ref) {
            const { message, detail } = describeError(e);
            ref = await reportClient({
              scope: "launch.client",
              message,
              detail: { ...detail, phase: phaseAtFailure, creator },
            });
          }
          if (ref) setErrorRef(ref);
        })();
        return null;
      }
    },
    [publicClient, walletClient, set],
  );

  const busy =
    progress.phase !== "idle" && progress.phase !== "done" && progress.phase !== "error";

  return { launch, reset, progress, outcome, error, errorRef, busy };
}

// A developer buy right after launch: buy the fresh token from its bonding curve, recipient = creator.
// ETH-quoted: msg.value == quoteIn. USDG-quoted: approve the curve, then buy with value 0. minTokensOut
// is 0 (PONS's 2-block guard + 5.5% per-wallet cap bound a launch-time buy); slippage risk is noted in
// the form copy. Returns the buy tx hash.
async function executeDeveloperBuy({
  walletClient,
  publicClient,
  curveAddr,
  creator,
  quote,
  amount,
}: {
  // wagmi's useWalletClient wraps its client in a tanstack-query result, and pulling the type back
  // out via ReturnType collapses it to `{}` (losing writeContract). Annotate with viem's concrete
  // WalletClient instead — the connected wagmi client is assignable to it.
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>;
  curveAddr: Address;
  creator: Address;
  quote: QuoteAsset;
  amount: string;
}): Promise<Hex> {
  if (quote === "ETH") {
    const quoteIn = parseEther(amount);
    const hash = await walletClient.writeContract({
      address: curveAddr,
      abi: CURVE_ABI,
      functionName: "buy",
      args: [quoteIn, 0n, creator],
      value: quoteIn,
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`Developer buy reverted (${hash}).`);
    return hash;
  }

  // USDG-quoted: approve the curve to pull the USDG, then buy with no native value.
  const quoteIn = parseUnits(amount, USDG_DECIMALS);
  const approveHash = await walletClient.writeContract({
    address: USDG,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [curveAddr, quoteIn],
  });
  const approveRc = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (approveRc.status !== "success") throw new Error(`USDG approval reverted (${approveHash}).`);

  const hash = await walletClient.writeContract({
    address: curveAddr,
    abi: CURVE_ABI,
    functionName: "buy",
    args: [quoteIn, 0n, creator],
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`Developer buy reverted (${hash}).`);
  return hash;
}

// Turn wallet/RPC errors into a short, human line. Wallet rejections are the common case.
function normalizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied|rejected the request/i.test(raw)) {
    return "You rejected the request in your wallet.";
  }
  // viem errors carry a long body; keep the first line.
  return raw.split("\n")[0].slice(0, 300);
}
