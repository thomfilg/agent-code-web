import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "app-preview.spec.mjs", workers: 1, fullyParallel: false, timeout: 20000,
  use: { headless: true, trace: "retain-on-failure", launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} } });
