/** @type {import('next').NextConfig} */
// Next 14 config MUST be .mjs or .js (NOT .ts) on this Next line. App Router.
const nextConfig = {
  reactStrictMode: true,
  // Node.js API route handlers (/api/*) query Postgres with `pg` and load the ESM api/launch.mjs
  // orchestration. Keep `pg` (and its optional native binding `pg-native`) OUT of the webpack bundle
  // so it is required at runtime from node_modules — bundling pg breaks its dynamic/native requires.
  // (Next 14 spelling; renamed to `serverExternalPackages` in Next 15.) api/launch.mjs itself is NOT
  // an npm package but a sibling-workspace ESM file, so it is loaded via a `webpackIgnore` dynamic
  // import in lib/server/launch.ts rather than listed here — that keeps its own pg + @zerodev deps
  // resolving from api/node_modules and agent/node_modules, never web/node_modules.
  experimental: {
    serverComponentsExternalPackages: ["pg", "pg-native"],
  },
  // wagmi/viem pull in optional peer deps (pino-pretty, etc.) that are safe to leave unresolved
  // in the browser bundle. Silence the webpack warnings for them.
  webpack: (config, { webpack }) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // The `wagmi/connectors` barrel statically pulls in Coinbase's baseAccount connector, which
    // transitively imports optional `@x402/evm/*` subpaths that are not installed. We only use the
    // `injected` connector, so that code path is dead — ignore the whole @x402 scope so its missing
    // subpaths do not fail the build.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    return config;
  },
};

export default nextConfig;
