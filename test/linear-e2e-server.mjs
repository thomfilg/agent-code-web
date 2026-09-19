import { mkdtemp, rm } from "node:fs/promises";
import { createAgentWebServer } from "../src/server.mjs";
import { startMcpFixture } from "./fixtures/mcp-server.mjs";
import { testConfig } from "./helpers.mjs";
const root = await mkdtemp("/tmp/relay-linear-browser-");
const fixture = await startMcpFixture({ port: 8895, advertisedOrigin: "https://mcp.linear.app", linear: true });
const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_PORT: "8894" }) });
await app.start();
await (await app.resources.forOwner(null)).companies.save({ id: "12-apps", name: "12 Apps" });
const originalFetch = app.manager.mcps.fetch;
app.manager.mcps.fetch = (url, options) => {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || !["https://mcp.linear.app", fixture.origin].includes(parsed.origin)) throw new Error("Linear browser fixture blocks endpoints outside its isolated MCP service");
  return originalFetch(new URL(parsed.pathname + parsed.search, fixture.origin), { ...options, redirect: "manual" });
};
const close = async () => { await app.stop(); await fixture.close(); await rm(root, { recursive: true, force: true }); process.exit(); };
process.on("SIGTERM", close); process.on("SIGINT", close);
console.log("Isolated Linear OAuth browser fixture ready");
