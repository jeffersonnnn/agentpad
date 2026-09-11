// Test-only helpers for the session-key fork test (agent/test/sessionkey.fork.mjs).
//
// These are TEST INFRASTRUCTURE, not product code. They let us drive a ZeroDev Kernel v3 agent
// account against a LOCAL anvil fork with NO bundler and NO real ETH: we build + sign a userOp
// with the ZeroDev SDK (the SAME signer/validator the product uses), then submit it by calling
// EntryPoint.handleOps DIRECTLY from a funded relayer EOA.
//
// Nothing here touches src/, test/, or the product's stack seam beyond IMPORTING it read-only.

import { spawn } from "node:child_process";
import {
  createPublicClient, createWalletClient, createTestClient,
  http, defineChain, keccak256, encodeAbiParameters, encodeFunctionData,
  toHex, parseEther, formatEther,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  getUserOperationHash, toPackedUserOperation, entryPoint07Abi, entryPoint07Address,
} from "viem/account-abstraction";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { CHAIN_ID, ENTRYPOINT_V07, TOKENS } from "../lib/archetypes.mjs";

// ZeroDev's rate-limit policy singleton (CREATE2-deterministic; SAME address on every chain). It is
// NOT deployed on Robinhood Chain 4663 (confirmed: no code), which blocks enabling the product's
// session-key validator there. The runtime bytecode below was read from Base + Arbitrum mainnet
// (byte-identical on both — sha1 76df344c…), so porting it onto the LOCAL fork via anvil_setCode
// makes the fork match a properly-provisioned 4663 and lets us exercise the REAL, full policy set.
// The module is a stateless singleton (per-account usage lives in its storage, empty on a fresh
// deploy), so setting only the runtime code is faithful.
export const RATE_LIMIT_POLICY_ADDR = "0xf63d4139B25c836334edD76641356c6b74C86873";
export const RATE_LIMIT_POLICY_BYTECODE = "0x60806040908082526004908136101561001757600080fd5b600090813560e01c908163244d6cb2146104a857508063309bfb76146104235780636d61fe70146102ae5780637129edce1461026c5780638712147a1461020c5780638a91b0e314610149578063d60b347f14610110578063d8ed2b3c146100aa5763ecd059611461008857600080fd5b346100a75760203660031901126100a757506005602092519135148152f35b80fd5b50823461010c578060031936011261010c576100c46104f6565b8335835260016020528183209060018060a01b0316835260205260ff818320541690519160038210156100f957602083838152f35b634e487b7160e01b815260218452602490fd5b5080fd5b50823461010c57602036600319011261010c5760209181906001600160a01b036101386104db565b168152808452205415159051908152f35b509160208060031936011261020857823567ffffffffffffffff811161020457610176903690850161050c565b8211610204573580855260018252828520338652825260ff838620541660038110156101f157906001869392036101ed578252600181528282203383528152828220805460ff191660021790555282208054909181156101da575060001901905580f35b634e487b7160e01b845260119052602483fd5b8280fd5b634e487b7160e01b865260218552602486fd5b8480fd5b8380fd5b509190346101ed57816003193601126101ed57606092829161022c6104f6565b9035825260026020528282209060018060a01b0316825260205220549065ffffffffffff8151928181168452818160301c166020850152841c1690820152f35b508290600319828136011261010c5760243567ffffffffffffffff81116101ed579061012091360301126100a757506102a760209235610570565b9051908152f35b509160208060031936011261020857823567ffffffffffffffff8111610204576102db903690850161050c565b9081831161041f57803591601f190182875260018452848720338852845260ff8588205416600381101561040c5790879493929161020457806006116102045780600c1161020457601211610208576103d79061033661053a565b908481013560d01c825284820190602681013560d01c8252602c88840191013560d01c81528487526002865287872033885286526103b38888209365ffffffffffff93848092511665ffffffffffff198754161786555116849065ffffffffffff60301b82549160301b169065ffffffffffff60301b1916179055565b51825465ffffffffffff60601b1916911660601b65ffffffffffff60601b16179055565b8252600181528282203383528152828220600160ff198254161790555282209081549060001982146101da5750600101905580f35b634e487b7160e01b885260218752602488fd5b8580fd5b509190346101ed5760803660031901126101ed5761043f6104f6565b5060643567ffffffffffffffff81116102085761045f903690830161050c565b505080358352600160205281832033845260205260ff8284205416906003821015610495575060010361010c5751908152602090f35b634e487b7160e01b845260219052602483fd5b905083346101ed5760203660031901126101ed576020926001600160a01b036104cf6104db565b16815280845220548152f35b600435906001600160a01b03821682036104f157565b600080fd5b602435906001600160a01b03821682036104f157565b9181601f840112156104f15782359167ffffffffffffffff83116104f157602083818601950101116104f157565b604051906060820182811067ffffffffffffffff82111761055a57604052565b634e487b7160e01b600052604160045260246000fd5b906000828152602090600182526040808220338352835260ff818320541660038110156106b75760010361010c578482526002835280822033835283528082206105b861053a565b90549365ffffffffffff918286168152828660301c168083830152838583019760601c16875280156106aa576000190183811161069657610629908987526002845285872033885284528587209065ffffffffffff60301b82549160301b169065ffffffffffff60301b1916179055565b8280875116915116019082821161068257968452600287528284203385529096529120805465ffffffffffff60601b19169190941660601b65ffffffffffff60601b1617909255905160d01b6001600160d01b03191690565b634e487b7160e01b85526011600452602485fd5b634e487b7160e01b86526011600452602486fd5b5060019750505050505050565b634e487b7160e01b83526021600452602483fd";

const zdEntryPoint = getEntryPoint("0.7");

export const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];

// SwapRouter02.exactInputSingle — params tuple has NO deadline field (FACTS.md).
export const ROUTER_EXACTIN_ABI = [
  { type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] },
];

export function makeChain(rpcUrl) {
  return defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain (anvil fork)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

// ── anvil lifecycle ─────────────────────────────────────────────────────────────────────────────
export async function startAnvil({ forkUrl, port = 8599, chainId = CHAIN_ID }) {
  const url = `http://127.0.0.1:${port}`;
  const args = [
    "--fork-url", forkUrl,
    "--chain-id", String(chainId),
    "--port", String(port),
    "--silent",
    // auto-mine is the anvil default (one block per tx); no interval flag needed.
  ];
  const proc = spawn("anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.on("exit", (code) => { if (code && code !== 0 && !proc._intentionalKill) {
    process.stderr.write(`\n[anvil exited code=${code}]\n${stderr}\n`); } });

  const kill = () => { proc._intentionalKill = true; try { proc.kill("SIGKILL"); } catch {} };
  process.on("exit", kill);
  process.on("SIGINT", () => { kill(); process.exit(1); });
  process.on("SIGTERM", () => { kill(); process.exit(1); });

  // Poll for readiness.
  const probe = createPublicClient({ transport: http(url) });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const id = await probe.getChainId();
      if (id === chainId) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { kill(); throw new Error(`anvil did not become ready on ${url}\n${stderr}`); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url, proc, kill };
}

// ── clients ─────────────────────────────────────────────────────────────────────────────────────
export function makeClients(url, chain) {
  const publicClient = createPublicClient({ transport: http(url), chain });
  const testClient = createTestClient({ mode: "anvil", transport: http(url), chain });
  return { publicClient, testClient };
}

export function newEoa() {
  const pk = generatePrivateKey();
  return { pk, account: privateKeyToAccount(pk) };
}

// ── fork funding ────────────────────────────────────────────────────────────────────────────────
export async function setEth(testClient, address, ether) {
  await testClient.setBalance({ address, value: parseEther(String(ether)) });
}

// USDG balances live at storage slot 1 (FACTS.md). Set the account's USDG directly, then verify.
// Falls back to impersonating a large USDG holder (the NVDA/USDG v3 pool) and transferring.
export async function fundUsdg(testClient, publicClient, url, chain, holderCandidate, account, units) {
  const usdg = TOKENS.USDG;
  const slot = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [account, 1n],
  ));
  await testClient.setStorageAt({ address: usdg, index: slot, value: toHex(units, { size: 32 }) });
  let bal = await publicClient.readContract({ address: usdg, abi: ERC20_APPROVE_ABI, functionName: "balanceOf", args: [account] });
  if (bal === units) return { method: "setStorageAt(slot1)", balance: bal };

  // Fallback: impersonate a whale and transfer.
  await testClient.impersonateAccount({ address: holderCandidate });
  await testClient.setBalance({ address: holderCandidate, value: parseEther("10") });
  const whaleWallet = createWalletClient({ account: holderCandidate, transport: http(url), chain });
  const hash = await whaleWallet.writeContract({
    address: usdg, abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable",
      inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "transfer", args: [account, units],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  await testClient.stopImpersonatingAccount({ address: holderCandidate });
  bal = await publicClient.readContract({ address: usdg, abi: ERC20_APPROVE_ABI, functionName: "balanceOf", args: [account] });
  return { method: `impersonate(${holderCandidate})+transfer`, balance: bal };
}

// Ensure the ZeroDev rate-limit policy module has code on the fork. Returns whether it was missing
// on the forked 4663 state (a real finding) and whether we had to port the bytecode in.
export async function provisionRateLimitModule(testClient, publicClient) {
  const before = await publicClient.getCode({ address: RATE_LIMIT_POLICY_ADDR });
  const wasMissing = !before || before === "0x";
  if (wasMissing) {
    await testClient.setCode({ address: RATE_LIMIT_POLICY_ADDR, bytecode: RATE_LIMIT_POLICY_BYTECODE });
  }
  const after = await publicClient.getCode({ address: RATE_LIMIT_POLICY_ADDR });
  return { address: RATE_LIMIT_POLICY_ADDR, missing_on_4663_fork: wasMissing, code_present_now: !!(after && after !== "0x") };
}

// Deploy the (counterfactual) Kernel v3 account on the fork by sending ONE sudo-signed no-op userOp
// via EntryPoint.handleOps — no bundler. This mirrors the product's separate owner-driven deploy
// (grantSession deploy=true) so the runtime's first SESSION op only has to enable the validator.
export async function deployAccountViaSudo(url, chain, publicClient, ownerSigner, accountAddress, relayerAccount) {
  const sudo = await signerToEcdsaValidator(publicClient, { signer: ownerSigner, entryPoint: zdEntryPoint, kernelVersion: KERNEL_V3_1 });
  const sudoAccount = await createKernelAccount(publicClient, { entryPoint: zdEntryPoint, kernelVersion: KERNEL_V3_1, plugins: { sudo } });
  if (sudoAccount.address.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new Error(`sudo account ${sudoAccount.address} != grant account ${accountAddress}`);
  }
  const chainId = await publicClient.getChainId();
  const callData = await sudoAccount.encodeCalls([{ to: accountAddress, value: 0n, data: "0x" }]);
  const { packed } = await buildSignedPackedUserOp(publicClient, sudoAccount, chainId, callData);
  const sub = await submitHandleOps(url, chain, publicClient, relayerAccount, packed, relayerAccount.address);
  const code = await publicClient.getCode({ address: accountAddress });
  return { status: sub.status, sendError: sub.sendError, deployed: !!(code && code !== "0x") };
}

// ── userOp assembly (no bundler) ────────────────────────────────────────────────────────────────
// Build a PackedUserOperation for the given kernel account + callData, signed by whatever validator
// is active on that account object (sudo or the session/permission validator). We pin all gas fields
// so we never need a bundler for estimation; the SAME fields feed both the signature hash and the
// packing, so EntryPoint recomputes an identical hash.
export async function buildSignedPackedUserOp(publicClient, account, chainId, callData, gasOverrides = {}) {
  const nonce = await account.getNonce();

  // Include factory/factoryData only while the account is still counterfactual (not yet on-chain).
  const code = await publicClient.getCode({ address: account.address });
  let factory, factoryData;
  if (!code || code === "0x") {
    const fa = await account.getFactoryArgs();
    factory = fa.factory;
    factoryData = fa.factoryData;
  }

  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = 1_000_000_000n; // 1 gwei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  const unpacked = {
    sender: account.address,
    nonce,
    ...(factory ? { factory, factoryData } : {}),
    callData,
    callGasLimit: gasOverrides.callGasLimit ?? 2_000_000n,
    verificationGasLimit: gasOverrides.verificationGasLimit ?? 5_000_000n,
    preVerificationGas: gasOverrides.preVerificationGas ?? 500_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    // NO paymaster fields — the account pays its own gas.
  };

  const signature = await account.signUserOperation({ ...unpacked, chainId });
  const withSig = { ...unpacked, signature };

  // Sanity: the hash we signed must equal the hash EntryPoint will recompute from the packed op.
  const hash = getUserOperationHash({
    userOperation: { ...unpacked, signature: "0x" },
    entryPointAddress: ENTRYPOINT_V07,
    entryPointVersion: "0.7",
    chainId,
  });

  const packed = toPackedUserOperation(withSig);
  return { packed, unpacked: withSig, userOpHash: hash };
}

// Submit one PackedUserOperation via EntryPoint.handleOps from a funded relayer. We pass an explicit
// gas limit so viem does NOT pre-estimate (a rejected op would otherwise throw at estimateGas); this
// lets the tx actually mine so we can read receipt.status uniformly for accept vs reject.
export async function submitHandleOps(url, chain, publicClient, relayerAccount, packed, beneficiary) {
  const wallet = createWalletClient({ account: relayerAccount, transport: http(url), chain });
  let sent, receipt, sendError = null;
  try {
    sent = await wallet.writeContract({
      address: ENTRYPOINT_V07,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[packed], beneficiary],
      gas: 15_000_000n,
    });
    receipt = await publicClient.waitForTransactionReceipt({ hash: sent });
  } catch (e) {
    sendError = e.shortMessage || e.message;
  }
  return { txHash: sent ?? null, status: receipt?.status ?? null, sendError };
}

// eth_call the same handleOps to capture a decoded revert reason (or confirm it would succeed).
export async function simulateHandleOps(publicClient, relayerAddress, packed, beneficiary) {
  try {
    await publicClient.simulateContract({
      address: ENTRYPOINT_V07,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[packed], beneficiary],
      account: relayerAddress,
    });
    return { wouldRevert: false, reason: null };
  } catch (e) {
    const reason = e.shortMessage || e.message || String(e);
    // Try to surface EntryPoint FailedOp / cause detail.
    const detail = e.cause?.reason || e.metaMessages?.join(" | ") || e.details || "";
    return { wouldRevert: true, reason: [reason, detail].filter(Boolean).join(" :: ").slice(0, 400) };
  }
}

export { encodeFunctionData, toHex, formatEther, parseEther, privateKeyToAccount };
