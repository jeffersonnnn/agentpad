"use client";

// Client-side provider tree: wagmi (Robinhood Chain 4663) + TanStack Query. Wraps the whole app.
// `initialState` comes from cookies in app/layout.tsx (cookieToInitialState) so SSR and hydration
// agree on the connection state.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { getConfig } from "@/lib/wagmi";

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  // One config + one QueryClient per browser session (stable across re-renders).
  const [config] = useState(() => getConfig());
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
