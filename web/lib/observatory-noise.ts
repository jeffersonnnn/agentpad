// Shared Observatory noise classifier (imported by BOTH the client reporter and the server POST route,
// so a plain module with no "use client"/server directive).
//
// Browser wallet/crypto extensions (TronLink and friends) inject provider proxies that throw storms of
// unhandled rejections we can neither fix nor act on: "'set' on proxy: trap returned falsish for
// property 'tronlinkParams'", recursive "Maximum call stack size exceeded", and provider-redefine races
// on window.ethereum/solana/tron. One bad tab produced ~12k rows and buried the real errors. This
// classifier drops that noise. It is deliberately conservative: it targets extension-injection
// signatures, not our own app scopes (launch.*, agent.*, api.*), which always report.

const NOISE_MESSAGE = [
  /tronlink/i,
  /tronweb/i,
  /trap returned falsish/i, // proxy set-trap from an injected wallet (e.g. tronlinkParams)
  /maximum call stack size exceeded/i, // extension provider recursion loops
  /cannot (redefine|assign to|set) [^]*\b(ethereum|solana|tron|web3|phantom)\b/i, // provider-inject races
  /which has only a getter/i,
  /cannot read propert(y|ies) of undefined \(reading '(tron|ethereum|solana)/i,
  /evmask/i,
];

const EXT_ORIGIN = /\b(chrome|moz|safari|ms-browser|edge)-extension:\/\//i;

/**
 * True when an event looks like browser-extension noise (a wallet injection storm), not an app error.
 * Checks the message text and any extension:// origin in the detail (stack, source filename, etc.).
 */
export function isExtensionNoise(scope: string, message: string, detail?: unknown): boolean {
  const msg = String(message || "");
  if (NOISE_MESSAGE.some((re) => re.test(msg))) return true;
  if (detail && typeof detail === "object") {
    try {
      if (EXT_ORIGIN.test(JSON.stringify(detail))) return true;
    } catch {
      /* circular/huge detail — fall through, not noise on this signal */
    }
  }
  return false;
}
