import { defineConfig } from "@playwright/test";

/*
 * Browser tests against a running app (default http://localhost:3000; start it with
 * `npm run build && npm run start` and a database with the demo accounts). They use the
 * installed Microsoft Edge, so no Playwright browser download is needed.
 *
 * One worker: the local PGlite database serves one connection, and tests share demo data.
 * Everything the tests create is labeled "[E2E]".
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI provides the environment directly.
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The dev machine is memory-constrained; first page loads and the first upload (which loads
  // the embedding model) can take a while.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel: "msedge",
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "./tests/e2e/.results",
});
