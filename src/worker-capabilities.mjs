// Accept only headers minted for this controller's fixed runtime gateways,
// never a user-selected upstream endpoint or an arbitrary credential header.
export function runtimeMcpSecrets(servers = {}, origin, initial = []) {
  const secrets = new Set(initial), expected = new URL(origin).origin;
  for (const server of Object.values(servers)) {
    if (server.type !== "http") continue;
    let url; try { url = new URL(server.url); } catch { continue; }
    const match = /^Bearer (cap_[A-Za-z0-9_-]{43})$/.exec(server.headers?.Authorization || "");
    if (match && url.origin === expected && !url.username && !url.password && !url.search && !url.hash
      && /^(?:\/gateway\/browser|\/gateway\/github\/mcp|\/gateway\/mcp\/mcp_[a-f0-9-]{36})$/.test(url.pathname)) secrets.add(match[1]);
  }
  return secrets;
}

// Native CLI configuration is visible in process argv. Reference a private
// process environment entry instead of serializing a capability into MCP args.
// No upstream credential is accepted here: only already-issued runtime grants.
export function capabilityMcpServers(servers = {}, secrets = new Set(), env, provider) {
  let index = 0;
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const authorization = server.headers?.Authorization;
    if (server.type !== "http" || typeof authorization !== "string" || !authorization.startsWith("Bearer ") || !secrets.has(authorization.slice(7))) return [name, server];
    const key = `RELAY_MCP_CAPABILITY_${index++}`;
    env[key] = authorization.slice(7);
    const { Authorization: _authorization, ...headers } = server.headers;
    return [name, provider === "codex"
      ? { ...server, headers, bearerTokenEnvVar: key }
      : { ...server, headers: { ...headers, Authorization: `Bearer \${${key}}` } }];
  }));
}

export function codexShellEnvironmentArgs(env, variables = {}, capabilitySecrets = new Set()) {
  const config = (name, value) => ["-c", `shell_environment_policy.${name}=${JSON.stringify(value)}`];
  if (capabilitySecrets.size) {
    // buildWorkerEnvironment has already removed controller environment state.
    // Enumerate exact permitted names from that sanitized object: inherit=all
    // must never mean inheriting a host process environment. GIT_CONFIG_KEY_n
    // must survive Codex's default *KEY* filter; values stay out of argv.
    const names = Object.keys(env).filter(name => /^[A-Z_][A-Z0-9_]*$/.test(name)
      && !/^(?:AGENT_|OPENAI_|ANTHROPIC_|RELAY_MCP_CAPABILITY_|CODEX_API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$)/.test(name));
    return [...config("inherit", "all"), ...config("ignore_default_excludes", true), ...config("include_only", names)];
  }
  return [...config("inherit", "core"), ...config("ignore_default_excludes", false),
    ...config("exclude", ["AGENT_SESSION_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
    ...Object.entries(variables).flatMap(([name, value]) => config(`set.${name}`, value))];
}
