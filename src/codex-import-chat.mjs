import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { newId, redact } from "./utils.mjs";
import { extractResponse } from "./response-protocol.mjs";
import { finalAnswerMeta } from "./message-search.mjs";

// Native history remains in the private session bundle. This is its visible
// transcript, never a reconstruction of private reasoning or system prompts.
export function importedTranscript(thread) {
  if (!Array.isArray(thread?.turns)) throw new Error("The imported conversation has no readable native history");
  const messages = []; let total = 0;
  const createdAt = Number.isFinite(thread.createdAt) ? new Date(thread.createdAt * 1000).toISOString() : new Date().toISOString();
  for (const turn of thread.turns) {
    if (!Array.isArray(turn.items)) throw new Error("The imported conversation history is incomplete");
    for (const item of turn.items) {
      let message;
      if (item.type === "userMessage") {
        if (!Array.isArray(item.content)) throw new Error("The imported message content is incomplete");
        const text = [], attachments = [];
        for (const part of item.content) {
          if (part.type === "text") text.push(String(part.text || ""));
          else if (part.type === "image" || part.type === "localImage") attachments.push({ nativeImage: true, ...(part.type === "image" ? { url: part.url } : { path: part.path }) });
          else if (part.type === "skill" || part.type === "mention") text.push(part.name || "[Imported reference]");
          else throw new Error("This imported message contains an unsupported content type; its native history was retained");
        }
        message = { role: "user", kind: "message", text: text.join("\n"), meta: { authorship: "user" }, ...(attachments.length ? { attachments } : {}) };
      } else if (["agentMessage", "plan", "exitedReviewMode"].includes(item.type)) message = { role: "assistant", agent: "codex", kind: "message", text: extractResponse(String(item.type === "exitedReviewMode" ? item.review || "" : item.text || ""), false).text,
        ...(item.type === "agentMessage" && item.phase === "final_answer" && turn.status === "completed" ? { meta: finalAnswerMeta({ source: "codex-final-answer", text: item.text }, "codex") } : {}) };
      else if (["reasoning", "contextCompaction", "enteredReviewMode"].includes(item.type)) continue;
      else {
        const title = item.type === "commandExecution" ? String(item.command || "Shell command") : item.type === "fileChange" ? `${item.changes?.length || 0} file changes` : String(item.tool || item.type || "Native tool");
        message = { role: "tool", agent: "codex", kind: "tool", text: title, meta: { type: "tool", tool: item.type, title: redact(title), state: "completed",
          output: item.type === "commandExecution" ? redact(String(item.aggregatedOutput || "")) : "", failed: item.status === "failed", exitCode: item.exitCode ?? null } };
      }
      message.text = redact(message.text);
      total += Buffer.byteLength(JSON.stringify(message));
      if (messages.length >= 50000 || total > 32 * 1024 * 1024) throw new Error("The imported transcript exceeds the 50,000-message / 32 MiB display limit; native history was retained");
      messages.push({ ...message, id: newId("msg"), createdAt, meta: { ...message.meta, imported: true } });
    }
  }
  return messages;
}

export function importedHistoryWarnings(messages) {
  return messages.some(message => /\[external unsupported block: [^\]\r\n]+\]/.test(message.text))
    ? ["The native importer replaced unsupported source content (such as images) with text markers. Those markers remain visible; the original source was not changed."] : [];
}

async function workspaceImage(root, relative) {
  if (!relative || relative.split(path.sep).some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f\\]/.test(relative)) throw new Error("Unsupported imported image path");
  const handles = [], parts = relative.split(path.sep);
  try {
    let current = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(current);
    for (let index = 0; index < parts.length; index++) {
      current = await open(`/proc/self/fd/${current.fd}/${parts[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (index < parts.length - 1 ? constants.O_DIRECTORY : 0)); handles.push(current);
    }
    const stat = await current.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 5n * 1024n * 1024n) throw new Error("Imported image is unavailable or too large");
    const bytes = Buffer.alloc(Number(stat.size) + 1); let read = 0;
    while (read < bytes.length) { const result = await current.read(bytes, read, bytes.length - read, read); if (!result.bytesRead) break; read += result.bytesRead; }
    const after = await current.stat({ bigint: true });
    if (read !== Number(stat.size) || ["ino", "dev", "size", "mtimeNs", "ctimeNs"].some(key => stat[key] !== after[key])) throw new Error("Imported image changed during copying");
    return bytes.subarray(0, read).toString("base64");
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

// Only inline images and ordinary images inside the copied workspace are read.
// Never fetch a historical URL or read another profile's absolute file path.
export async function copyImportedImages(messages, sourceWorkspace, targetWorkspace, check = () => {}) {
  let unavailable = 0, bytes = 0;
  const result = structuredClone(messages);
  for (const message of result) for (let index = 0; index < (message.attachments || []).length; index++) {
    check(); const image = message.attachments[index]; let copied;
    const inline = typeof image.url === "string" && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.url);
    if (inline && inline[2].length <= 7 * 1024 * 1024 && inline[2].length % 4 === 0 && Buffer.from(inline[2], "base64").length <= 5 * 1024 * 1024) copied = { name: `image-${index + 1}.${inline[1].split("/")[1]}`, mime: inline[1], data: inline[2] };
    else if (typeof image.path === "string" && image.path.startsWith(`${sourceWorkspace}/`) && path.normalize(image.path) === image.path) {
      const relative = path.relative(sourceWorkspace, image.path), extension = path.extname(relative).toLowerCase();
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[extension];
      if (mime) try { copied = { name: path.basename(relative), mime, data: await workspaceImage(targetWorkspace, relative), previousPath: image.path }; } catch { /* Missing/unsafe historical references remain explicit, inert markers. */ }
    }
    check();
    if (copied) { bytes += Buffer.from(copied.data, "base64").length; if (bytes > 64 * 1024 * 1024) throw new Error("Imported images exceed the 64 MiB conversation limit"); }
    else unavailable++;
    message.attachments[index] = copied || { copied: true, name: "Historical image — original bytes unavailable", mime: "image/unknown" };
  }
  return { messages: result, unavailable };
}
