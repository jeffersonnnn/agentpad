"use client";

// CLIENT half of the Observatory. Sends browser-side errors (uncaught exceptions, unhandled promise
// rejections, and caught flow failures like a launch error) to POST /api/observatory so they reach the
// developer alongside the server-reported ones. Best-effort and silent: reporting a failure must never
// throw into the UI, and a failed report is swallowed.

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

/** Install global handlers so uncaught client errors also reach the Observatory. Idempotent. */
export function installGlobalObservatory(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (ev) => {
    const msg = ev.message || (ev.error instanceof Error ? ev.error.message : "window.onerror");
    void reportClient({
      scope: "client.window.error",
      message: msg,
      detail: {
        source: ev.filename,
        line: ev.lineno,
        col: ev.colno,
        stack: ev.error instanceof Error ? ev.error.stack : undefined,
      },
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const { message, detail } = describeError(ev.reason);
    void reportClient({ scope: "client.unhandledrejection", message, detail });
  });
}
