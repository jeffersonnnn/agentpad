"use client";

// Client wrapper that applies the staggered scroll-reveal to the single grid it wraps.
// Keeps the landing page a server component: only this small island is client-side.

import type { ReactNode } from "react";
import { useScrollReveal } from "@/lib/useScrollReveal";

export function RevealGroup({ children }: { children: ReactNode }) {
  const ref = useScrollReveal<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
}
