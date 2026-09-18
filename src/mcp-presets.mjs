// Official hosted endpoints, checked September 2026. Presets only fill the form;
// they never silently install tools or grant an account access.
export const MCP_PRESETS = [
  { id: "linear", name: "Linear", description: "Issues, projects and cycles · read-only by default", url: "https://mcp.linear.app/mcp", authMode: "oauth", oauthScopes: "read", docs: "https://linear.app/docs/mcp" },
  { id: "atlassian", name: "Atlassian", description: "Jira, Confluence and Bitbucket", url: "https://mcp.atlassian.com/v2/mcp", authMode: "oauth", docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/" },
  { id: "github", name: "GitHub", description: "Repositories, pull requests and issues · token required", url: "https://api.githubcopilot.com/mcp/", authMode: "headers", docs: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md" },
  { id: "sentry", name: "Sentry", description: "Errors, performance and debugging", url: "https://mcp.sentry.dev/mcp", authMode: "oauth", docs: "https://mcp.sentry.dev/" },
  { id: "figma", name: "Figma", description: "Design context and components", url: "https://mcp.figma.com/mcp", authMode: "oauth", docs: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/" },
  { id: "notion", name: "Notion", description: "Documentation and knowledge bases", url: "https://mcp.notion.com/mcp", authMode: "oauth", docs: "https://developers.notion.com/guides/mcp/get-started-with-mcp" },
  { id: "context7", name: "Context7", description: "Library documentation · anonymous access", url: "https://mcp.context7.com/mcp", authMode: "none", docs: "https://context7.com/docs/resources/all-clients" },
];
