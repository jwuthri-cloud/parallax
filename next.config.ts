import type { NextConfig } from "next";
import path from "node:path";
const privateStore = path.relative(
  process.cwd(),
  path.resolve(process.env.PARALLAX_DATA_DIR || "data"),
);
// File tracing only reads inside the project, so a store outside it (a devbox
// with PARALLAX_DATA_DIR=~/parallax-data) needs no exclude, and Turbopack
// rejects globs that leave the project root.
const storeInsideProject =
  !privateStore.startsWith("..") && !path.isAbsolute(privateStore);
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["node:sqlite"],
  outputFileTracingExcludes: {
    "/*": [
      "./data/**/*",
      ...(storeInsideProject ? [`${privateStore}/**/*`] : []),
      "./.env*",
      "./docs/screenshots/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // Keep page policy off artifact routes: production config headers
        // override Route Handler headers, including the preview sandbox.
        source: "/",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-src 'self'" },
        ],
      },
    ];
  },
};
export default config;
