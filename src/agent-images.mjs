// Agents show an image to the user by saving it in the workspace and citing it
// as Markdown, ![caption](relative/path.png). When the message is published,
// each cited file is read from the live worker and kept as a chat attachment,
// so it still opens in the image viewer after the worker stops.
import path from "node:path";

export const AGENT_IMAGE_LIMIT = 10;
export const AGENT_IMAGE_BYTES = 5 * 1024 * 1024;
export const AGENT_IMAGE_PROMPT = "\n\nTo show the user an image (a screenshot, chart or mockup), save it as PNG, JPEG, WebP or GIF inside the workspace (copy it there if a tool saved it elsewhere) and put ![short caption](relative/path.png) in your reply. The user sees it in the conversation and can open it full screen. Up to 10 images per message, 5 MB each. Remote image URLs are not loaded.";
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)$/i;
const IMAGE_MIME = /^image\/(?:png|jpeg|webp|gif)$/;
const MARKDOWN_IMAGE = /!\[([^\]\n]{0,300})\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

// Workspace-relative image paths cited in a message, in order, without duplicates.
// Absolute paths are accepted only inside the workspace; URLs never are.
export function imageReferences(text, workspace = "") {
  const references = [], seen = new Set();
  for (const [, alt, raw] of String(text || "").matchAll(MARKDOWN_IMAGE)) {
    const source = raw.replace(/^<|>$/g, "");
    let target = source;
    try { target = decodeURI(source); } catch { continue; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const root = workspace.replace(/\/+$/, "");
    if (target.startsWith("/")) { if (!root || !target.startsWith(`${root}/`)) continue; target = target.slice(root.length + 1); }
    target = target.replace(/^(?:\.\/)+/, "");
    if (!target || target.split("/").some(part => !part || part === "." || part === "..") || !IMAGE_FILE.test(target) || seen.has(target)) continue;
    seen.add(target); references.push({ alt, path: target, source });
    if (references.length >= AGENT_IMAGE_LIMIT) break;
  }
  return references;
}

// Reads each cited image and stores it as a chat attachment. A missing, too
// large or non-image file is skipped: the message then shows the caption text.
export async function captureAgentImages({ text, workspace, read, upload }) {
  const images = [];
  for (const reference of imageReferences(text, workspace)) {
    try {
      const file = await read(reference.path);
      if (!file || file.kind !== "file" || file.referenceOnly || !file.binary || !IMAGE_MIME.test(file.mime || "")) continue;
      const attachment = await upload({ name: path.posix.basename(reference.path), mime: file.mime, data: file.data });
      images.push({ ...attachment, agentImage: { path: reference.path, source: reference.source, caption: reference.alt.slice(0, 300) } });
    } catch { /* One unreadable image never blocks the agent's message. */ }
  }
  return images;
}
