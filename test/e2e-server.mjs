import { mkdtemp, rm } from "node:fs/promises";
import { createAgentWebServer } from "../src/server.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { testConfig } from "./helpers.mjs";
import { ModelCatalog } from "../src/models.mjs";
const root = await mkdtemp("/tmp/relay-browser-");
const config = testConfig(root, { AGENT_WEB_PORT: "8879" });
const records = new MemoryRecords();
const repos = ["Acme/api", "Acme/web", "Other/library"].map((full_name, index) => ({ id: index + 1, full_name, name: full_name.split("/")[1], default_branch: "main", private: true, size: 1 }));
const github = new GitHubConnection({ records, config: config.github, localToken: async () => "test-github-credential",
  fetchImpl: async url => {
    const path = new URL(url).pathname;
    if (path === "/user") return Response.json({ login: "browser-fixture", id: 1 });
    if (path === "/user/repos") return Response.json(repos);
    if (path.endsWith("/branches")) return Response.json([{ name: "main" }, { name: "develop" }]);
    if (path.includes("/branches/")) return Response.json({ name: "main" });
    const repo = repos.find(repo => path === `/repos/${repo.full_name}`);
    return repo ? Response.json(repo) : Response.json({ message: "Not found" }, { status: 404 });
  },
});
const models = new ModelCatalog(config);
models.codex = async () => ({ models: [{ id: "fixture-gpt", label: "Fixture GPT", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" }], source: "fixture" });
models.claude = async () => ({ models: [{ id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" }, { id: "haiku", label: "Haiku", efforts: [] }], source: "fixture" });
const app = await createAgentWebServer({ config, records, github, models }); await app.start();
for (const title of ["Existing alpha", "Existing beta"]) await app.manager.createChat({ agent: "mock", title });
const close = async () => { await app.stop(); await rm(root, { recursive: true, force: true }); process.exit(); };
process.on("SIGTERM", close); process.on("SIGINT", close);
console.log("Browser fixture ready");
