const loopback = hostname => ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".localhost");

// Local aliases give each chat a distinct browser origin. They do not provide
// port forwarding or network isolation; remote worker URLs need a real tunnel.
export function directBrowserLink({ address, chatId, backend, relayOrigin, mode = "guest" }) {
  let url, relay;
  try { url = new URL(address); relay = new URL(relayOrigin); } catch { return { reason: "Enter a website address first" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { reason: "Use an HTTP or HTTPS address without embedded credentials" };
  if (!loopback(url.hostname)) return { url: url.href, note: "Opens the website normally in your browser; no Chrome profile is shared." };
  if (mode === "personal") return { url: url.href, note: "Localhost is your own computer in personal Chrome mode." };
  if (backend !== "local" || !loopback(relay.hostname)) return { reason: "This is the worker's localhost. Direct access requires a port-forwarding URL; use Shared Chrome for now." };
  if (!/^chat_[a-f0-9]{32}$/.test(chatId || "")) return { reason: "Select a chat first" };
  if (url.protocol === "https:") return { url: url.href, note: "Uses the original HTTPS hostname so its certificate remains valid." };
  url.hostname = `${chatId}.localhost`;
  return { url: url.href, note: "Local preview · separate browser origin per chat. Local workers still share this computer's ports; the hostname is not an access control." };
}
