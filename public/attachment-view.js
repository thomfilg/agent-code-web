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
