import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy. Everything is served from this origin (fonts are self-hosted by
 * next/font). 'unsafe-inline' scripts are needed for Next's inline bootstrap without per-request
 * nonces (which would make every page dynamic); the dev server also needs eval and websockets.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Clickjacking: also covered by frame-ancestors, kept for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Browsers ignore HSTS over plain http (localhost), so it is safe to always send.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Copies only the traced runtime files into .next/standalone, so the Docker image needs no
  // node_modules install of its own.
  output: "standalone",
  outputFileTracingIncludes: {
    // transformers.js loads onnxruntime-node through a computed require, which tracing cannot
    // see. Only the native binary for the build machine's platform is copied (~45 MB on linux).
    "/*": [
      "node_modules/onnxruntime-node/package.json",
      "node_modules/onnxruntime-node/dist/**",
      `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/**`,
      // Tracing keeps only the ESM build, but onnxruntime-node requires the CommonJS one.
      "node_modules/onnxruntime-common/dist/cjs/**",
      // transformers.js also loads sharp at import time, and tracing drops its libvips binaries.
      // npm installs only the build platform's @img packages, so this stays small.
      "node_modules/@img/**",
    ],
  },
  outputFileTracingExcludes: {
    // The embedding model cache is resolved from process.cwd(), so tracing would bake the local
    // download into the image. Containers mount it as a volume instead.
    "/*": [".cache/**"],
  },
  experimental: {
    // Enables forbidden() / unauthorized() for role-based page access.
    authInterrupts: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
