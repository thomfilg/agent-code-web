import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser", testMatch: ["agent-accounts.spec.mjs", "google-login.spec.mjs"],
  workers: 1, fullyParallel: false, timeout: 30000,
  use: { headless: true, trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
});
