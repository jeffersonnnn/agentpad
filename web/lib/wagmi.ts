// wagmi/viem config for Robinhood Chain (id 4663), taken from viem/chains (`robinhood`). The creator
// connects an EXISTING wallet — no embedded/managed wallet, no custody. No geoblock (ADR 0001).
//
// Wallet choice: EIP-6963 discovery (on by default) surfaces every installed browser wallet (MetaMask,
// Rabby, Brave, the Coinbase extension, ...) as its own connector, and we add Coinbase Wallet and
// (when a project id is set) WalletConnect for mobile. The ConnectButton renders a picker over these.
//
// SSR-safe app-router setup: cookieStorage + ssr:true here, and cookieToInitialState in app/layout.tsx
// so the server render and the client hydrate to the same connection state.

import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { robinhood } from "viem/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { PUBLIC_RPC } from "./constants";

// Browser-facing, read-only RPC. NEVER point this at the Alchemy URL (it embeds a secret key). Instead
// the browser reads through our same-origin proxy (/api/rpc), which forwards to the reliable paid node
// server-side. This is what stops launches stalling on the flaky public node (the "resolving" eth_call
// and receipt waits used to time out there). Order: an explicit NEXT_PUBLIC_RH_RPC_URL override wins;
// otherwise the same-origin proxy (absolute on the client via window.origin, or NEXT_PUBLIC_SITE_URL on
// the server); the public node is only the last-resort fallback for a server render with no site URL.
const PROXY_PATH = "/api/rpc";
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
const rpcUrl =
  process.env.NEXT_PUBLIC_RH_RPC_URL ||
  (typeof window !== "undefined"
    ? `${window.location.origin}${PROXY_PATH}`
    : siteUrl
      ? `${siteUrl}${PROXY_PATH}`
      : PUBLIC_RPC);
// Optional: a WalletConnect Cloud project id enables the mobile-wallet QR flow. Without it we simply
// omit WalletConnect (browser-extension wallets still work through injected + Coinbase).
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export function getConfig() {
  const connectors = [
    injected(), // EIP-6963: MetaMask, Rabby, Brave, Coinbase extension, ... each as its own option
    coinbaseWallet({ appName: "Slingshot" }),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
  ];
  return createConfig({
    chains: [robinhood],
    connectors,
    // cookie storage keeps the connection consistent across SSR + hydration.
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
    transports: {
      // Bound the wait and retry a couple of times: a single slow read must not strand a launch.
      [robinhood.id]: http(rpcUrl, { timeout: 15_000, retryCount: 2, retryDelay: 700 }),
    },
  });
}

// wagmi's module augmentation so `useConfig()` etc. are typed against this exact config.
declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof getConfig>;
  }
}

export { robinhood as chain };
