"use client";

// CLIENT half of the Observatory. Sends browser-side errors (uncaught exceptions, unhandled promise
// rejections, and caught flow failures like a launch error) to POST /api/observatory so they reach the
// developer alongside the server-reported ones. Best-effort and silent: reporting a failure must never
// throw into the UI, and a failed report is swallowed.

import { isExtensionNoise } from "./observatory-noise";

export interface ClientReport {
  scope: string;
  message: string;
  detail?: Record<string, unknown>;
  level?: "error" | "warn" | "info";
}

/** POST one client event. Returns the server ref id, or null if the report could not be sent. */
export async function reportClient(r: ClientReport): Promise<string | null> {
  try {
    const res = await fetch("/api/observatory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keepalive lets the report survive a navigation away from the page.
      keepalive: true,
      body: JSON.stringify({
        scope: r.scope,
        message: r.message,
        level: r.level ?? "error",
        url: typeof window !== "undefined" ? window.location.href : undefined,
        detail: r.detail,
      }),
    });
    const body = (await res.json().catch(() => null)) as { ref?: string } | null;
    return body?.ref ?? null;
  } catch {
    return null;
  }
}

/** Turn an unknown thrown value into a { message, detail } pair for reporting. */
export function describeError(e: unknown): { message: string; detail: Record<string, unknown> } {
  if (e instanceof Error) {
    const detail: Record<string, unknown> = { name: e.name };
    if (e.stack) detail.stack = e.stack;
    const cause = (e as { cause?: unknown }).cause;
    if (cause) detail.cause = cause instanceof Error ? cause.message : String(cause);
    return { message: e.message, detail };
  }
  return { message: String(e), detail: {} };
}

let installed = false;

// Guard the GLOBAL uncaught-error handlers (not the explicit launch/agent reports, which always send)
// against the flood a bad browser-extension tab can produce: drop extension noise, dedupe identical
// signatures, and hard-cap the total per page session. Without this one wallet-injection loop wrote
// ~12k rows and buried the real errors.
const SEEN = new Set<string>();
let sentCount = 0;
const SESSION_CAP = 25;

function reportUncaught(scope: string, message: string, detail: Record<string, unknown>): void {
  if (isExtensionNoise(scope, message, detail)) return; // wallet-extension noise, not our bug
  const sig = `${scope}|${message.slice(0, 200)}`;
  if (SEEN.has(sig)) return; // already reported this exact error this session
  if (sentCount >= SESSION_CAP) return; // a storm past the cap is dropped; the first 25 tell the story
  SEEN.add(sig);
  sentCount++;
  void reportClient({ scope, message, detail });
}

/** Install global handlers so uncaught client errors also reach the Observatory. Idempotent. */
export function installGlobalObservatory(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (ev) => {
    const msg = ev.message || (ev.error instanceof Error ? ev.error.message : "window.onerror");
    reportUncaught("client.window.error", msg, {
      source: ev.filename,
      line: ev.lineno,
      col: ev.colno,
      stack: ev.error instanceof Error ? ev.error.stack : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const { message, detail } = describeError(ev.reason);
    reportUncaught("client.unhandledrejection", message, detail);
  });
}
