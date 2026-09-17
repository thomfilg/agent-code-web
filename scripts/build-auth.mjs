import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// @12-apps/auth publishes framework-neutral TypeScript. Compile its server
// boundary for this plain Node ESM host; no React or framework adapter needed.
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/shared-auth-entry.mjs"],
  outfile: ".generated/shared-auth.mjs",
  bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@auth/core", "@auth/core/*", "zod"],
  logLevel: "warning",
});
