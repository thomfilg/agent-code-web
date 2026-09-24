export const isAttachmentImage = file => /^image\/(png|jpeg|webp|gif|avif)$/.test(file.mime || "");
export function fileSize(size = 0) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
export function attachmentPreview(file) {
  if (isAttachmentImage(file)) return { format: "image", source: file.previewSource || `data:${file.mime};base64,${file.data}`, metadata: fileSize(file.size) };
  if (/^(?:text\/|application\/(?:json|xml|javascript))/.test(file.mime || "") || /\.(?:txt|md|json|csv|log|html?|svg|[cm]?js|jsx|tsx?|css|py|sh|ya?ml|toml|ini|xml|sql|rs|go|java|c|cpp|h)$/i.test(file.name)) {
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(file.data), char => char.charCodeAt(0)));
      if (/[\x00-\x08\x0b\x0e-\x1f]/.test(source)) throw Error("Binary file");
      const lines = source ? source.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(source) ? 1 : 0) : 0;
      return { format: "text", source, metadata: `${fileSize(file.size)} · ${lines} ${lines === 1 ? "line" : "lines"}` };
    } catch { /* Binary/unsupported encodings are never rendered as markup. */ }
  }
  return { format: "text", source: "A text preview is not available for this file. The original attachment is kept unchanged.", metadata: `${fileSize(file.size)} · ${file.mime || "Unknown file type"}` };
}

export function droppedFiles(transfer) {
  const items = [...(transfer?.items || [])].filter(item => item.kind === "file");
  if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) throw Error("Folders cannot be attached. Choose individual files.");
  const files = [...(transfer?.files || [])];
  if (!files.length) throw Error("Choose individual files or images to attach.");
  return files;
}

// Every image in the conversation, sent by the user or shown by an agent, in
// message order. The image viewer pages through this list.
export function chatImages(messages = []) {
  return messages.flatMap(message => (message.attachments || []).filter(file => file.id && isAttachmentImage(file)).map(file => ({ file, messageId: message.id })));
}
// The agent image a Markdown image source refers to, if it was captured.
export function agentImageFor(files = [], source = "") {
  let decoded = source; try { decoded = decodeURI(source); } catch { /* keep the raw source */ }
  const path = decoded.replace(/^(?:\.\/)+/, "");
  const images = files.filter(file => file.agentImage);
  const exact = images.find(file => file.agentImage.source === source || file.agentImage.source === decoded || file.agentImage.path === path);
  if (exact) return exact;
  // A workspace-absolute source ends with the captured relative path; the
  // longest match wins so "old/shots/x.png" never resolves to "shots/x.png".
  return images.filter(file => decoded.endsWith(`/${file.agentImage.path}`)).sort((a, b) => b.agentImage.path.length - a.agentImage.path.length)[0] || null;
}
