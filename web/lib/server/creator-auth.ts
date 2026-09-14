// SERVER-ONLY. Shared creator-signature check for the agent control panel routes (pause/resume,
// distribution policy, sweep). Mirrors the x-connect / claim-fees pattern: the creator signs a fresh,
// agent-scoped message; we recover the signer and require it to equal agents.creator_addr. The message
// is NEVER trusted for its address claim. Bind request parameters into the message via `requireIncludes`
// so a tampered value fails the check.

import { recoverMessageAddress, isHex } from "viem";
import type { Address, Hex } from "viem";
import { query } from "./db";

const MAX_MSG_AGE_MS = 10 * 60 * 1000; // anti-replay window

/** The agent's creator address, or null if the agent does not exist. */
export async function creatorOf(agentId: string): Promise<Address | null> {
  const rows = await query<{ creator_addr: Address }>("SELECT creator_addr FROM agents WHERE id = $1", [agentId]);
  return rows[0]?.creator_addr ?? null;
}

/**
 * Verify a creator-signed control message. Throws with a client-safe reason on any failure.
 * @param prefix the message must start with this (e.g. "Slingshot control")
 * @param requireIncludes substrings the message must contain (binds params, e.g. `action: pause`)
 */
export async function verifyCreator(opts: {
  agentId: string;
  prefix: string;
  creator: Address;
  message: unknown;
  signature: unknown;
  requireIncludes?: string[];
}): Promise<void> {
  const { agentId, prefix, creator, message, signature, requireIncludes = [] } = opts;
  if (typeof message !== "string" || !message.startsWith(prefix)) throw new Error("bad message");
  if (typeof signature !== "string" || !isHex(signature)) throw new Error("bad signature");
  if (!message.includes(`agent: ${agentId}`)) throw new Error("message is for a different agent");
  for (const s of requireIncludes) if (!message.includes(s)) throw new Error("message does not match this request");
  const m = message.match(/issued: (.+)$/m);
  const issued = m ? Date.parse(m[1].trim()) : NaN;
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_MSG_AGE_MS) {
    throw new Error("signature expired; please sign again");
  }
  const signer = await recoverMessageAddress({ message, signature: signature as Hex });
  if (signer.toLowerCase() !== creator.toLowerCase()) throw new Error("only the agent's creator can do this");
}
