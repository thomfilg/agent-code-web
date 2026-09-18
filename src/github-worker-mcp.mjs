import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const endpoint = "/gateway/github/mcp";
const fullName = z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => value.split("/").every(part => part !== "." && part !== ".."));
// A local refs/heads name only: no owner:branch fork notation or ref expressions.
const branch = z.string().min(1).max(250).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).refine(value =>
  !value.includes("..") && !value.includes("//") && !value.endsWith(".") && !value.endsWith("/") &&
  value.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock")) && !value.startsWith("refs/"));
const title = z.string().min(1).max(256).refine(value => Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value));
const body = z.string().max(20000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const selected = { repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), repository: fullName, head: branch };
const schemas = {
  github_create_pull_request: z.object({ ...selected, base: branch, title, body: body.default(""), draft: z.boolean().default(true) }).strict(),
  github_edit_pull_request: z.object({ ...selected, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), title: title.optional(), body: body.optional() }).strict()
    .refine(value => value.title !== undefined || value.body !== undefined),
};
const messages = {
  input: "Invalid pull request arguments. Use only the selected repository ID/name, local branch names, and the documented fields.",
  scope: "GitHub access is unavailable or changed. Check the selected connection and repository, then restart the agent if needed.",
  identity: "GitHub repository, branch, or pull request identity did not match the selected repository and expected head. No further operation was attempted. Check GitHub before retrying if a change was submitted.",
  failed: "The GitHub operation could not be confirmed. Check the pull request on GitHub before retrying; a submitted change may already have completed.",
};
class PrToolError extends Error { constructor(code) { super(messages[code] || messages.failed); this.code = code; } }
const deny = code => { throw new PrToolError(code); };
const safeError = error => error instanceof PrToolError ? new PrToolError(error.code).message : messages.failed;
const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorResult = message => ({ isError: true, content: [{ type: "text", text: message }] });
const sameRepository = (value, saved) => value?.id === saved.id && value?.full_name === saved.fullName;

function checkPull(pull, saved, input, { base, number } = {}) {
  if (!Number.isSafeInteger(pull?.number) || pull.number <= 0 || (number !== undefined && pull.number !== number) ||
      pull.state !== "open" || pull.merged === true || !sameRepository(pull.head?.repo, saved) || !sameRepository(pull.base?.repo, saved) ||
      pull.head.ref !== input.head || !branch.safeParse(pull.base.ref).success || (base !== undefined && pull.base.ref !== base)) deny("identity");
}

/** No token lookup or arbitrary API forwarding. The gateway owns every grant. */
export async function runGitHubPrTool(gateway, token, name, input, { signal } = {}) {
  const parsed = schemas[name]?.safeParse(input);
  if (!parsed?.success) return errorResult(messages.input);
  const value = parsed.data;
  try {
    return await gateway.withRepository(token, value.repositoryId, async context => {
      const { repository, github, connectionId, chatCompany } = context;
      if (repository?.id !== value.repositoryId || repository.fullName !== value.repository || !fullName.safeParse(repository.fullName).success ||
          !connectionId || connectionId !== repository.githubConnectionId) deny("scope");
      const signals = [signal, context.signal].filter(Boolean), requestSignal = signals.length ? AbortSignal.any(signals) : undefined;
      const current = async () => { requestSignal?.throwIfAborted(); await context.assertCurrent(); requestSignal?.throwIfAborted(); };
      const request = async (route, options = {}) => {
        await current();
        const result = await github.request(route, { connectionId, chatCompany, repository: repository.fullName, signal: requestSignal, ...options });
        await current(); return result;
      };
      const root = `/repos/${repository.fullName}`;
      if (name === "github_create_pull_request") {
        if (value.base === value.head) deny("input");
        for (const ref of [value.head, value.base]) {
          const result = await request(`${root}/branches/${encodeURIComponent(ref)}`);
          if (result?.name !== ref || !/^[a-f0-9]{40}$/.test(result.commit?.sha || "")) deny("identity");
        }
        const pull = await request(`${root}/pulls`, { method: "POST", body: {
          head: value.head, base: value.base, title: value.title, body: value.body, draft: value.draft, maintainer_can_modify: false,
        } });
        checkPull(pull, repository, value, { base: value.base });
        if (pull.title !== value.title || (pull.body ?? "") !== value.body || pull.draft !== value.draft) deny("failed");
        return textResult({ repositoryId: repository.id, repository: repository.fullName, number: pull.number,
          url: `https://github.com/${repository.fullName}/pull/${pull.number}`, head: value.head, base: value.base, operation: "created" });
      }
      const route = `${root}/pulls/${value.number}`;
      const before = await request(route);
      checkPull(before, repository, value, { number: value.number });
      const changes = { ...(value.title !== undefined ? { title: value.title } : {}), ...(value.body !== undefined ? { body: value.body } : {}) };
      const after = await request(route, { method: "PATCH", body: changes });
      checkPull(after, repository, value, { number: value.number, base: before.base.ref });
      if ((value.title !== undefined && after.title !== value.title) || (value.body !== undefined && (after.body ?? "") !== value.body)) deny("failed");
      return textResult({ repositoryId: repository.id, repository: repository.fullName, number: value.number,
        url: `https://github.com/${repository.fullName}/pull/${value.number}`, head: value.head, base: before.base.ref, operation: "edited" });
    });
  } catch (error) { return errorResult(safeError(error)); }
}

export function githubWorkerMcpConfig(origin, token) {
  const url = new URL(origin);
  if (!(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      typeof token !== "string" || !/^cap_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid GitHub gateway configuration");
  return { relay_github: { type: "http", url: `${url.origin}${endpoint}`, headers: { Authorization: `Bearer ${token}` } } };
}

export async function handleGitHubWorkerMcp(request, response, url, { gateway }) {
  if (url.pathname !== endpoint) return false;
  const finish = (code, value) => {
    if (response.destroyed || response.writableEnded) return true;
    response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
    response.end(JSON.stringify(value)); return true;
  };
  if (request.headers.origin !== undefined || url.search || request.url !== url.pathname + url.search) return finish(403, { error: "GitHub gateway accepts only agent capability requests" });
  const token = /^Bearer (cap_[A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization || "")?.[1];
  if (!token || request.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length !== 1) return finish(401, { error: messages.scope });
  const disconnected = new AbortController();
  const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
  response.once("close", onClose);
  try {
    return await gateway.withRequest(token, async lease => {
      if (request.method !== "POST") return finish(405, { error: "Use MCP POST requests" });
      const abortBody = () => request.destroy();
      lease.signal.addEventListener("abort", abortBody, { once: true });
      try {
        lease.signal.throwIfAborted();
        return await handleTrackedRequest(request, response, { token, lease, finish });
      } finally { lease.signal.removeEventListener("abort", abortBody); }
    }, { signal: disconnected.signal });
  } catch (error) { return finish(error?.statusCode === 429 ? 429 : 401, { error: messages.scope }); }
  finally { response.removeListener("close", onClose); }
}

async function handleTrackedRequest(request, response, { token, lease, finish }) {
  let repositories;
  let bytes = 0, input;
  const chunks = [];
  try {
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 100000) return finish(413, { error: "GitHub request too large" }); chunks.push(chunk); }
    input = JSON.parse(Buffer.concat(chunks));
  } catch { return finish(400, { error: "Invalid MCP request" }); }
  // One operation per reserved slot. A batch could bypass both the shared
  // concurrency limit and the fixed pre-SDK argument-validation boundary.
  if (!input || typeof input !== "object" || Array.isArray(input)) return finish(400, { error: "Invalid MCP request" });
  // A slow request body must not retain permissions captured before revocation.
  try { repositories = await lease.listRepositories(); }
  catch { return finish(401, { error: messages.scope }); }
  // SDK validation errors can include arbitrary argument names. Return a fixed
  // error for invalid tool arguments before passing anything to the SDK.
  if (input?.method === "tools/call" && !schemas[input.params?.name]?.safeParse(input.params?.arguments).success) {
    if (!(typeof input.id === "string" || Number.isSafeInteger(input.id))) return finish(400, { error: "Invalid MCP request" });
    return finish(200, { jsonrpc: "2.0", id: input.id, result: errorResult(messages.input) });
  }
  if (!Array.isArray(repositories) || repositories.length > 100 || repositories.some(repo => !Number.isSafeInteger(repo.id) || repo.id <= 0 || !fullName.safeParse(repo.fullName).success)) {
    return finish(401, { error: messages.scope });
  }
  const server = new McpServer({ name: "relay-github-pull-requests", version: "1.0.0" });
  const scopedGateway = { withRepository: (_token, repositoryId, callback) => lease.withRepository(repositoryId, callback) };
  const scope = repositories.map(repo => `${repo.id}: ${repo.fullName}`).join("; ");
  for (const [name, schema] of Object.entries(schemas)) server.registerTool(name, {
    description: `${name === "github_create_pull_request" ? "Create a pull request (draft by default) from an existing local branch in the selected repository; push that branch first." : "Edit only the title/body of an open pull request whose head belongs to the same selected repository and matches the expected head."} No forks, merge, state changes, review, admin, workflows or generic API. Selected repositories (repositoryId: repository): ${scope}. A failed result may follow an already-submitted write: inspect GitHub before retrying.`,
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: name === "github_edit_pull_request", idempotentHint: name === "github_edit_pull_request", openWorldHint: true },
  }, input => runGitHubPrTool(scopedGateway, token, name, input, { signal: lease.signal }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.setHeader("cache-control", "no-store");
  response.once("close", () => {
    void transport.close().catch(() => {}); void server.close().catch(() => {});
  });
  try { await server.connect(transport); await transport.handleRequest(request, response, input); }
  catch { if (!response.headersSent) finish(400, { error: "Invalid MCP request" }); else response.end(); }
  return true;
}
