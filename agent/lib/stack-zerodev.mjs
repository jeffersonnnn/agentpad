// ZeroDev Kernel v3 adapter — the recommended default stack (SPEC.md section 2, ADR 0004).
//
// Kernel v3 is an ERC-7579 modular smart account. We use two validators:
//   - sudo   : an ECDSA validator owned by the creator/platform owner key (full control).
//   - regular: a permission validator holding the runtime SESSION KEY, scoped by three policies:
//       * call policy    — may only approve the archetype's allowed tokens TO the SwapRouter02 and
//                          call the Uniswap v3 SwapRouter02 swap selectors, with the swap `recipient`
//                          constrained to EQUAL the agent account. Everything else reverts on-chain.
//       * rate limit     — at most `dailyTradeLimit` userOps per interval; the interval is pinned to
//                          the key TTL, so `perTradeCap x dailyTradeLimit` is an honest per-key-life
//                          ceiling (this is NOT a true rolling cumulative cap — see buildSessionPolicy).
//       * timestamp      — validUntil (the expiry) / validAfter.
//
// The owner serializes the grant (serializePermissionAccount); the runtime rebuilds a signer-capable
// account from that blob + the session key (deserializePermissionAccount). No paymaster is wired, so
// the account pays its own gas from its own ETH balance.
//
// Pinned: EntryPoint v0.7, Kernel v3.1. Verified package versions at authoring: @zerodev/sdk 5.5.10,
// @zerodev/permissions 5.6.3, @zerodev/ecdsa-validator 5.4.9, viem 2.56.3.

import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getUserOperationHash,
  toPackedUserOperation,
  entryPoint07Abi,
} from "viem/account-abstraction";
import {
  createKernelAccount,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  toPermissionValidator,
  serializePermissionAccount,
  deserializePermissionAccount,
} from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  toCallPolicy,
  toRateLimitPolicy,
  toTimestampPolicy,
  CallPolicyVersion,
  ParamCondition,
} from "@zerodev/permissions/policies";

const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

// EntryPoint v0.7 (FACTS.md). Used only by the FORK-EXECUTION submit path below.
const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// ── FORK-EXECUTION submit mode (SPEC.md section 10.1 open item; no live bundler on a fork) ────────
// The production submit path routes userOps through the Alchemy bundler (createKernelAccountClient
// .sendUserOperation). A local anvil fork of RH Chain 4663 has NO bundler, so — ONLY when the env
// AGENT_SUBMIT=handleops is set — we build + sign the SAME userOp with the SAME ZeroDev validator and
// submit it by calling EntryPoint.handleOps DIRECTLY from a funded relayer EOA (AGENT_RELAYER_KEY).
// This is the exact technique proven in agent/test/fork-helpers.mjs / sessionkey.fork.mjs. It changes
// ONLY the final submit; the real loop -> chain.execute_swap -> stack.sendCall / sendOwnerCall path,
// the policy set, and the signature are untouched. When AGENT_SUBMIT is unset, the bundler path
// (default, mainnet behavior) is used unchanged.
function forkSubmitConfig() {
  if (String(process.env.AGENT_SUBMIT || "").toLowerCase() !== "handleops") return null;
  const rk = process.env.AGENT_RELAYER_KEY;
  if (!rk) {
    throw new Error(
      "AGENT_SUBMIT=handleops requires AGENT_RELAYER_KEY — a funded relayer EOA private key on the fork " +
      "that submits the userOp via EntryPoint.handleOps (no bundler exists on a fork).",
    );
  }
  return { relayer: privateKeyToAccount(rk.startsWith("0x") ? rk : "0x" + rk) };
}

// Build + sign a PackedUserOperation for `account` + `callData` (using whatever validator is active on
// the account object — sudo or the scoped session/permission validator) and submit it via
// EntryPoint.handleOps from the funded relayer. Gas fields are pinned so no bundler estimation is
// needed; the SAME fields feed the signature hash and the packing, so EntryPoint recomputes the same
// hash. Returns a shape compatible with both chain.mjs (r.receipt.transactionHash / r.success) and
// keeper.mjs (r.receipt.receipt.transactionHash / r.userOpHash).
async function submitViaHandleOps({ publicClient, chain, rpcUrl, relayer, account, callData }) {
  const nonce = await account.getNonce();

  // factory/factoryData only while the account is still counterfactual (self-deploys on first op).
  const code = await publicClient.getCode({ address: account.address });
  let factory, factoryData;
  if (!code || code === "0x") {
    const fa = await account.getFactoryArgs();
    factory = fa.factory;
    factoryData = fa.factoryData;
  }

  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
  // Small priority tip. On this Orbit chain the node reports 0 priority; a modest tip keeps the relayer
  // tx mineable without bloating the prefund. (This path is NOT the public mempool, so no bundler floor.)
  const maxPriorityFeePerGas = 100_000_000n; // 0.1 gwei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  const chainId = await publicClient.getChainId();

  // Gas limits are RIGHT-SIZED (not the old 5M/2M/500k). EntryPoint v0.7 with no paymaster makes the
  // account prefund (callGasLimit + verificationGasLimit + preVerificationGas) * maxFeePerGas from its
  // OWN balance, so oversized limits inflate the prefund past a small self-funded account's balance and
  // revert with FailedOp "AA21 didn't pay prefund" (the real-4663 blocker — the anvil fork hid it
  // because fork accounts hold unlimited ETH). The live bundler estimated this account's deploy at
  // vgl≈307k / cgl≈9k / pvg≈52k; these limits sit generously above the heaviest real op (a session-key
  // swap: permission-validator verification + a Uniswap v3 exactInputSingle) while keeping the prefund a
  // small fraction of a funded account. preVerificationGas here is only credited to the relayer (the
  // relayer's own tx pays the Orbit L1 data fee), so it need not cover the L1 component.
  const unpacked = {
    sender: account.address,
    nonce,
    ...(factory ? { factory, factoryData } : {}),
    callData,
    callGasLimit: 1_500_000n,
    verificationGasLimit: 2_000_000n,
    preVerificationGas: 200_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    // NO paymaster fields — the account pays its own gas (ADR 0004).
  };

  // PREFUND PREFLIGHT. EntryPoint v0.7 requires the account to cover
  //   requiredPrefund = (callGasLimit + verificationGasLimit + preVerificationGas) * maxFeePerGas
  // from its OWN balance (no paymaster). If it cannot, the whole handleOps tx reverts with the opaque
  // FailedOp "AA21 didn't pay prefund". On an anvil fork the account is auto-funded so this never
  // trips; on a real chain a small self-funded account plus these pinned (deliberately generous) gas
  // limits can exceed the balance. Turn that into a clear, actionable error BEFORE spending relayer
  // gas on a doomed submit. NOTE: on a real bundler-backed chain (e.g. RH 4663) prefer the default
  // bundler submit path (AGENT_SUBMIT unset) — the bundler right-sizes these limits, so the prefund
  // is a tiny fraction of this pinned worst case. This handleOps path is the no-bundler (fork) mode.
  const requiredPrefund = (unpacked.callGasLimit + unpacked.verificationGasLimit + unpacked.preVerificationGas) * maxFeePerGas;
  const senderBalance = await publicClient.getBalance({ address: account.address });
  if (senderBalance < requiredPrefund) {
    throw new Error(
      `handleOps prefund shortfall (would revert AA21): account ${account.address} holds ` +
      `${senderBalance} wei but this userOp needs ${requiredPrefund} wei prefund ` +
      `((callGasLimit+verificationGasLimit+preVerificationGas) * maxFeePerGas). ` +
      `Fund the account, or submit via the bundler (leave AGENT_SUBMIT unset) so gas is right-sized.`,
    );
  }

  const signature = await account.signUserOperation({ ...unpacked, chainId });
  const packed = toPackedUserOperation({ ...unpacked, signature });
  const userOpHash = getUserOperationHash({
    userOperation: { ...unpacked, signature: "0x" },
    entryPointAddress: ENTRYPOINT_V07,
    entryPointVersion: "0.7",
    chainId,
  });

  const wallet = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });
  // Explicit gas so viem does not pre-estimate (a rejected op would otherwise throw at estimateGas);
  // this lets the tx mine so we can read receipt.status. A userOp REJECTED at validation reverts the
  // whole handleOps tx (FailedOp) -> status "reverted" -> we throw. Inner-execution reverts still mine
  // as "success" (EntryPoint emits UserOperationRevertReason); callers verify real effects (e.g. the
  // token_out balance delta in chain.mjs) so a no-op is never mistaken for a successful trade.
  const txHash = await wallet.writeContract({
    address: ENTRYPOINT_V07,
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[packed], relayer.address],
    gas: 15_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(
      `handleOps tx ${txHash} reverted — the userOp was rejected at validation ` +
      `(session policy / signature / gas). No execution occurred.`,
    );
  }
  return {
    userOpHash,
    success: true,
    receipt: {
      transactionHash: txHash,
      status: receipt.status,
      receipt: { transactionHash: txHash, status: receipt.status },
    },
  };
}

// Minimal ABIs the call policy whitelists (function shape only; args are wildcarded).
const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

// SwapRouter02.exactInputSingle — params tuple has NO deadline field on this router (FACTS.md).
const ROUTER_ABI = [
  { type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "exactOutputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
      { name: "amountOut", type: "uint256" }, { name: "amountInMaximum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountIn", type: "uint256" }] },
];

/**
 * Translate the neutral policy into ZeroDev policy objects.
 *
 * The session key may ONLY:
 *   - approve the SwapRouter02 (never any other spender) — USDG approvals capped at perTradeCap,
 *     non-USDG (stock/WETH) approvals uncapped (so it can sell / route);
 *   - call SwapRouter02 exactInput/exactOutputSingle with the swap `recipient` field constrained to
 *     EQUAL the agent account, so proceeds land in the account and a leaked key cannot route swap
 *     output to an attacker (the router only pulls what was approved, and USDG approvals are capped,
 *     so USDG spent per userOp <= perTradeCap).
 * There is NO ERC-20 `transfer` permission: swaps use approve+router (the router pulls via allowance),
 * so the key never needs a raw transfer. Dropping it removes the free-`to` outflow path entirely.
 * A rate-limit policy caps userOps per interval (interval pinned to the key TTL) and a timestamp
 * policy sets the expiry. Enforced bound over the key's life: perTradeCap x dailyTradeLimit
 * (= spendBudget). This is NOT a rolling cumulative sum (see buildSessionPolicy note).
 *
 * NOTE on the recipient constraint (ZeroDev CallPolicy V0_0_4): the call policy matches calldata by
 * flat 32-byte word (offset = argIndex * 32), it does NOT flatten ABI tuples. exactInput/OutputSingle
 * take a single fully-static `params` tuple encoded inline, so its fields occupy consecutive words:
 *   [0] tokenIn  [1] tokenOut  [2] fee  [3] recipient  [4] amount*  [5] amount*  [6] sqrtPriceLimitX96
 * `recipient` is word index 3, so we pass args = [null, null, null, recipientEq] to pin offset 96.
 *
 * @param {object} policy         neutral policy from buildSessionPolicy()
 * @param {`0x${string}`} accountAddress the agent smart-account address; swap recipient must equal it
 */
async function buildPolicies(policy, accountAddress) {
  const routerEq = { condition: ParamCondition.EQUAL, value: policy.router };
  const capLte = { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: policy.perTradeCap };
  const recipientEq = { condition: ParamCondition.EQUAL, value: accountAddress };
  const spendToken = policy.spendToken.toLowerCase();

  const permissions = [];
  for (const token of policy.allowedTokens) {
    const isUsdg = token.toLowerCase() === spendToken;
    // approve(spender, amount): spender must be the router; USDG amount is capped.
    permissions.push({
      target: token, valueLimit: 0n, abi: ERC20_ABI, functionName: "approve",
      args: [routerEq, isUsdg ? capLte : null],
    });
    // No transfer(to, amount) permission — see the doc note above. The key trades via approve+router
    // only, so it has no path to move any token to an arbitrary `to`.
  }
  // Swap selectors: recipient (word index 3 of the inline params tuple) is pinned to the account.
  permissions.push(
    { target: policy.router, valueLimit: 0n, abi: ROUTER_ABI, functionName: "exactInputSingle",
      args: [null, null, null, recipientEq] },
    { target: policy.router, valueLimit: 0n, abi: ROUTER_ABI, functionName: "exactOutputSingle",
      args: [null, null, null, recipientEq] },
  );

  const callPolicy = await toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions,
  });

  // Op ceiling per interval. The interval is PINNED to the key TTL (buildSessionPolicy sets
  // rateLimitInterval = ttl) so the rate-limit window closes exactly when the key expires: one
  // window, one `perTradeCap x dailyTradeLimit` budget, per key life. Assert it is present + honest.
  if (!Number.isInteger(policy.rateLimitInterval) || policy.rateLimitInterval <= 0) {
    throw new Error(`policy.rateLimitInterval must be a positive integer (got ${policy.rateLimitInterval})`);
  }
  if (policy.ttl !== undefined && policy.rateLimitInterval !== policy.ttl) {
    throw new Error(
      `rate-limit interval (${policy.rateLimitInterval}s) must equal the key TTL (${policy.ttl}s) so the ` +
      `perTradeCap x dailyTradeLimit bound is honest across the key's life.`
    );
  }
  const rateLimitPolicy = await toRateLimitPolicy({
    count: policy.dailyTradeLimit,
    interval: policy.rateLimitInterval,
  });

  const timestampPolicy = await toTimestampPolicy({
    validUntil: policy.validUntil,
    validAfter: policy.validAfter || 0,
  });

  return [callPolicy, rateLimitPolicy, timestampPolicy];
}

export function createStack({ rpcUrl, chain }) {
  const publicClient = createPublicClient({ transport: http(rpcUrl), chain });

  // The default ZeroDev kernel client fetches gas via `zd_getUserOperationGasPrice`, a ZeroDev-bundler
  // RPC extension the Robinhood Alchemy bundler does NOT implement. So we supply the fees ourselves.
  // Alchemy's bundler (Rundler) enforces a MINIMUM maxPriorityFeePerGas and rejects a userOp at precheck
  // if it is below that floor ("maxPriorityFeePerGas is 0 but must be at least ..."). The standard
  // `eth_maxPriorityFeePerGas` returns 0 on this Orbit chain, so we read Rundler's own
  // `rundler_maxPriorityFeePerGas` extension for the floor and add a margin for fee drift. maxFee =
  // baseFee*2 + priority. On a fork (no bundler) that method is unsupported, so we fall back to the
  // node's EIP-1559 estimate, then legacy gasPrice. Passed to every createKernelAccountClient.
  async function feeEstimator() {
    try {
      const priorityHex = await publicClient.request({ method: "rundler_maxPriorityFeePerGas", params: [] });
      const priority = (BigInt(priorityHex) * 12n) / 10n; // +20% margin over the bundler's floor
      const block = await publicClient.getBlock();
      const baseFee = block.baseFeePerGas ?? 0n;
      return { maxFeePerGas: baseFee * 2n + priority, maxPriorityFeePerGas: priority };
    } catch { /* no bundler (fork) or method unsupported — fall through */ }
    try {
      const f = await publicClient.estimateFeesPerGas();
      if (f?.maxFeePerGas) return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
    } catch { /* fall through to legacy gas price */ }
    const gp = await publicClient.getGasPrice();
    return { maxFeePerGas: gp, maxPriorityFeePerGas: 0n };
  }

  async function ownerValidator(ownerSigner) {
    return signerToEcdsaValidator(publicClient, { signer: ownerSigner, entryPoint, kernelVersion });
  }

  return {
    name: "zerodev",
    entryPointVersion: "0.7",

    // Counterfactual address for the owner-only (sudo) account. Pure read.
    async predictAddress({ ownerSigner }) {
      const sudo = await ownerValidator(ownerSigner);
      const account = await createKernelAccount(publicClient, {
        entryPoint, kernelVersion, plugins: { sudo },
      });
      return account.address;
    },

    // OWNER SIDE: scope the session key, optionally deploy, return the serialized grant.
    async grantSession({ ownerSigner, sessionSigner, policy, deploy = false }) {
      const sudo = await ownerValidator(ownerSigner);
      const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });

      // The Kernel v3 account address is derived from the sudo (root) validator only; the regular
      // (session) validator does not enter the CREATE2 salt. So we can compute the address from a
      // sudo-only account FIRST, then pin the swap `recipient` policy to it, then build the full
      // account. This is the same invariant predictAddress() relies on.
      const addressProbe = await createKernelAccount(publicClient, {
        entryPoint, kernelVersion, plugins: { sudo },
      });
      const accountAddress = addressProbe.address;

      const policies = await buildPolicies(policy, accountAddress);

      const permissionPlugin = await toPermissionValidator(publicClient, {
        entryPoint, kernelVersion, signer: sessionKeySigner, policies,
      });

      const account = await createKernelAccount(publicClient, {
        entryPoint, kernelVersion,
        plugins: { sudo, regular: permissionPlugin },
      });

      // Sanity: the recipient constraint is only correct if the full account address matches the
      // sudo-only probe. If ZeroDev ever changes address derivation to include the regular plugin,
      // this guard fails loudly instead of silently pinning swaps to the wrong address.
      if (account.address.toLowerCase() !== accountAddress.toLowerCase()) {
        throw new Error(
          `account address mismatch: sudo-only probe ${accountAddress} != sudo+regular ${account.address}. ` +
          `The swap recipient constraint would be pinned to the wrong address; aborting.`
        );
      }

      let deployed = false;
      if (deploy) {
        // Deploy by sending one no-op userOp from the owner (sudo). The account pays its own gas;
        // no paymaster middleware is attached. The regular (session) validator is enabled lazily on
        // the runtime's first op via the serialized approval below.
        const code = await publicClient.getCode({ address: account.address });
        if (!code || code === "0x") {
          const kernelClient = createKernelAccountClient({
            account, chain, bundlerTransport: http(rpcUrl), client: publicClient,
        userOperation: { estimateFeesPerGas: feeEstimator },
          });
          const hash = await kernelClient.sendUserOperation({
            callData: await account.encodeCalls([
              { to: account.address, value: 0n, data: "0x" },
            ]),
          });
          await kernelClient.waitForUserOperationReceipt({ hash });
          deployed = true;
        }
      }

      // The grant blob the runtime persists. It encodes the account + the scoped session validator.
      const approval = await serializePermissionAccount(account);

      return {
        accountAddress: account.address,
        sessionKeyAddress: sessionSigner.address,
        approval,
        deployed,
      };
    },

    // OWNER SIDE: send ONE arbitrary call from the agent account under its sudo (ECDSA owner)
    // validator — NOT the scoped session key. The keeper uses this to move the agent's own treasury
    // USDG into its per-agent Distributor before setRoot (SPEC 3, ADR 0002). The account is built
    // sudo-only (identical to predictAddress / the grantSession deploy probe), so its address is the
    // same counterfactual account and the sudo validator has full control. No paymaster: the account
    // pays its own gas from its own ETH.
    async sendOwnerCall({ ownerSigner, accountAddress, to, data = "0x", value = 0n }) {
      const sudo = await ownerValidator(ownerSigner);
      const account = await createKernelAccount(publicClient, {
        entryPoint, kernelVersion, plugins: { sudo },
      });
      // Guard: if the caller passed the expected account address (e.g. the treasury from the DB),
      // it MUST match the owner-derived account, or we would fund/act on the wrong account.
      if (accountAddress && account.address.toLowerCase() !== accountAddress.toLowerCase()) {
        throw new Error(
          `sendOwnerCall account mismatch: owner-derived ${account.address} != expected ${accountAddress}. ` +
          `The owner signer does not control the expected account; aborting.`
        );
      }
      const callData = await account.encodeCalls([{ to, value, data }]);

      // FORK-EXECUTION: submit the owner userOp via EntryPoint.handleOps (no bundler on a fork).
      const fork = forkSubmitConfig();
      if (fork) {
        return submitViaHandleOps({ publicClient, chain, rpcUrl, relayer: fork.relayer, account, callData });
      }

      const kernelClient = createKernelAccountClient({
        account, chain, bundlerTransport: http(rpcUrl), client: publicClient,
        userOperation: { estimateFeesPerGas: feeEstimator },
      });
      const userOpHash = await kernelClient.sendUserOperation({ callData });
      const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
      return { userOpHash, receipt };
    },

    // RUNTIME SIDE: rebuild a signer-capable account from the grant + the session key.
    async resumeSession({ approval, sessionSigner }) {
      const sessionKeySigner = await toECDSASigner({ signer: sessionSigner });
      const account = await deserializePermissionAccount(
        publicClient, entryPoint, kernelVersion, approval, sessionKeySigner,
      );
      const client = createKernelAccountClient({
        account, chain, bundlerTransport: http(rpcUrl), client: publicClient,
        userOperation: { estimateFeesPerGas: feeEstimator },
      });
      return {
        accountAddress: account.address,
        client,
        // Send one scoped call (e.g. a swap). Account pays its own gas.
        async sendCall({ to, data = "0x", value = 0n }) {
          const callData = await account.encodeCalls([{ to, value, data }]);

          // FORK-EXECUTION: submit the scoped session-key userOp via EntryPoint.handleOps (no
          // bundler on a fork). Same signer/validator/policy; only the final submit differs.
          const fork = forkSubmitConfig();
          if (fork) {
            return submitViaHandleOps({ publicClient, chain, rpcUrl, relayer: fork.relayer, account, callData });
          }

          const hash = await client.sendUserOperation({ callData });
          return client.waitForUserOperationReceipt({ hash });
        },
      };
    },
  };
}

// Re-export for callers that want to build router calldata for sendCall().
export { encodeFunctionData, ROUTER_ABI, ERC20_ABI };
