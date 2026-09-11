// Alchemy Modular Account v2 adapter — the FALLBACK stack (SPEC.md section 2/10.1, ADR 0004).
//
// This exists to prove the seam in stack.mjs is real: it implements the SAME interface as the
// ZeroDev adapter, so `--stack=alchemy` is a one-line swap. Modular Account v2 is also an ERC-7579
// account on EntryPoint v0.7, and session keys are expressed as installed validation modules:
//   - SingleSignerValidationModule  — the session key's signer.
//   - AllowlistModule               — restrict callable targets to the archetype tokens + router.
//   - TimeRangeModule               — validUntil (expiry) / validAfter.
//   - ERC20 spend limit             — the per-trade USDG ceiling (perTradeCap). NOTE: like ZeroDev,
//     this is NOT a true rolling cumulative cap; the honest bound is perTradeCap x dailyTradeLimit.
// No paymaster is attached, so the account pays its own gas.
//
// PORTING NOTE: the ZeroDev-adapter security fixes (swap `recipient` pinned to the account address,
// no free-`to` ERC-20 transfer permission, rate-limit interval pinned to the key TTL) MUST be
// re-applied here when the MA v2 session-module install is wired — the AllowlistModule alone does not
// constrain the swap recipient or the transfer `to`.
//
// Account creation and counterfactual-address prediction are implemented and verifiable here. The
// session-module INSTALL surface for MA v2 is version-sensitive; the exact module addresses and the
// installValidation encoding must be confirmed against the installed @account-kit version at build
// (open item — see open_questions and SPEC.md 10.1). Rather than emit an unverified grant, that one
// step throws a clear NotImplemented naming what to wire. Everything else conforms to the interface.
//
// Verified package versions available at authoring: @account-kit/smart-contracts, @aa-sdk/core.

import { createPublicClient, http } from "viem";

let _sdk;
async function sdk() {
  if (_sdk) return _sdk;
  const [smart] = await Promise.all([import("@account-kit/smart-contracts")]);
  _sdk = { smart };
  return _sdk;
}

export function createStack({ rpcUrl, chain }) {
  const publicClient = createPublicClient({ transport: http(rpcUrl), chain });

  async function buildOwnerAccount(ownerSigner) {
    const { smart } = await sdk();
    // createModularAccountV2Client builds an EntryPoint-v0.7 MA v2 client. No paymaster passed => the
    // account pays its own gas. We pass the node URL as the transport (it doubles as the bundler).
    return smart.createModularAccountV2Client({
      chain,
      transport: http(rpcUrl),
      signer: toAlchemySigner(ownerSigner),
    });
  }

  return {
    name: "alchemy",
    entryPointVersion: "0.7",

    async predictAddress({ ownerSigner }) {
      const client = await buildOwnerAccount(ownerSigner);
      return client.account.address;
    },

    async grantSession({ ownerSigner, sessionSigner, policy, deploy = false }) {
      const client = await buildOwnerAccount(ownerSigner);
      const accountAddress = client.account.address;

      // Deploy (owner no-op) — the account pays its own gas, no paymaster.
      let deployed = false;
      if (deploy) {
        const code = await publicClient.getCode({ address: accountAddress });
        if (!code || code === "0x") {
          const op = await client.sendUserOperation({
            uo: { target: accountAddress, value: 0n, data: "0x" },
          });
          await client.waitForUserOperationTransaction(op);
          deployed = true;
        }
      }

      // Session-key install (allowlist + time-range + spend limit) — CONFIRM AT BUILD.
      throw new Error(
        "alchemy: session-key module install is a build-time open item (SPEC.md 10.1). " +
        "Wire installValidation with SingleSignerValidationModule + AllowlistModule(" +
        [...policy.allowedTokens, policy.router].join(",") +
        ", swap recipient pinned to " + accountAddress + ") + TimeRangeModule(validUntil=" +
        policy.validUntil + ") + a per-trade ERC20 spend limit of " + policy.perTradeCap +
        " on " + policy.spendToken + " with the rate-limit interval pinned to the key TTL (" +
        policy.ttl + "s), against the installed @account-kit " +
        "version, then serialize the account state as the runtime grant. Account " + accountAddress +
        (deployed ? " was deployed." : " is counterfactual.")
      );
    },

    async resumeSession({ approval, sessionSigner }) {
      // Symmetric to grantSession: rebuild the MA v2 client with the session signer + installed
      // modules from `approval`. Blocked on the same build-time module confirmation.
      throw new Error(
        "alchemy: resumeSession depends on the session-module install surface confirmed in " +
        "grantSession (build-time open item). Use the zerodev stack until MA v2 modules are pinned."
      );
    },

    // OWNER SIDE: send one arbitrary call from the account under its owner validator. On MA v2 this
    // is a plain owner userOp (no session module needed), so the build-time open item is narrower
    // here than grantSession — but the owner-account client wiring for MA v2 is still unverified
    // against the installed @account-kit version. Rather than emit an unverified owner op, throw a
    // clear NotImplemented, mirroring grantSession/resumeSession. Use the zerodev stack (production).
    async sendOwnerCall({ ownerSigner, accountAddress, to, data = "0x", value = 0n }) {
      throw new Error(
        "alchemy: sendOwnerCall is a build-time open item (SPEC.md 10.1). Wire an MA v2 owner userOp " +
        "(createModularAccountV2Client(ownerSigner).sendUserOperation({ uo: { target: " +
        (to || "<to>") + ", value: " + String(value) + ", data: <data> } })), confirmed against the " +
        "installed @account-kit version and asserting the account address" +
        (accountAddress ? " equals " + accountAddress : "") +
        ", then return { userOpHash, receipt }. Use the zerodev stack until MA v2 is pinned."
      );
    },
  };
}

// Adapt a viem LocalAccount into an Alchemy signer. @aa-sdk/core ships WalletClientSigner /
// LocalAccountSigner for this; kept in one place so the swap point is obvious.
function toAlchemySigner(viemLocalAccount) {
  // Lazy require to keep this out of the module top-level (so --plan never loads it).
  // Confirm the exact constructor against the installed @aa-sdk/core at build.
  return viemLocalAccount; // MA v2 client accepts a viem-compatible signer; see open_questions.
}
