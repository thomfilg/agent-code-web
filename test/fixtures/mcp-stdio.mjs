import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line); if (request.id === undefined) continue;
    const result = request.method === "initialize" ? { protocolVersion: request.params.protocolVersion, serverInfo: { name: "stdio-fixture", version: "1" }, capabilities: { tools: {} } }
      : request.method === "tools/list" ? { tools: [{ name: "stdio_echo", description: "Echo test", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
        : request.method === "tools/call" ? { content: [{ type: "text", text: request.params.arguments.text }] } : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch { /* The fixture only accepts MCP JSON-RPC. */ }
}
