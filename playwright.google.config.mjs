import { defineConfig } from "@playwright/test";

// No shared fixture server or native CLI workers: each test owns its in-memory
// Relay and offline OIDC provider. Keep one worker on the user's busy machine.
export default defineConfig({
  testDir: "./test/browser", testMatch: "google-login.spec.mjs",
  workers: 1, fullyParallel: false, timeout: 30000,
  use: { headless: true, trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
});
