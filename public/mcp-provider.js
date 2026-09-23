// Identify the provider by its exact canonical endpoint, never a user-entered
// name. Two connections called “linear” can authenticate different workspaces.
export function isLinearMcp(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://mcp.linear.app" && ["/mcp", "/mcp/readonly"].includes(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
