import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser", testIgnore: "linear-mcp.spec.mjs", workers: 1, fullyParallel: false, timeout: 30000,
  use: { baseURL: "http://127.0.0.1:8879", headless: true, trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
  webServer: { command: "node test/e2e-server.mjs", url: "http://127.0.0.1:8879/api/health", reuseExistingServer: false },
});
