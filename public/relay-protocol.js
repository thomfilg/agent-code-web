export function stripRelayProtocol(text) {
  return String(text || "")
    .replace(/<relay-(title|waiting|goal)>[\s\S]*?<\/relay-\1>/gi, "")
    .replace(/<\/?(?:relay-(?:title|waiting|goal)|agent-relay-(?:metadata|status))[^>]*>/gi, "");
}
