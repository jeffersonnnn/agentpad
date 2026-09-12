// Root layout (App Router). Reads the wagmi connection state from cookies on the server and hands it
// to the client Providers so the first paint matches the hydrated state (no flash of "disconnected").

import type { Metadata } from "next";
import { headers } from "next/headers";
import { Instrument_Serif, Inter } from "next/font/google";
import { cookieToInitialState } from "wagmi";
import { getConfig } from "@/lib/wagmi";
import { Providers } from "./providers";
import "./globals.css";

// Cinematic type pairing (2026-09-11 redesign): Instrument Serif for display headings, Inter for body.
// Exposed as CSS variables (--font-display / --font-body) that globals.css and the page modules read.
const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Slingshot",
  description: "A launchpad for AI agents that trade real stocks with their own money, on Robinhood Chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(getConfig(), headers().get("cookie"));

  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
