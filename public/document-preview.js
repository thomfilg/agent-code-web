import { marked } from "/vendor/marked.js";
import { openSidePanel, closeSidePanel } from "./side-panels.js";

const $ = selector => document.querySelector(selector);
const MAX_PREVIEW_LENGTH = 300000;

export class DocumentPreview {
  constructor() {
    this.panel = $("#preview-panel"); this.content = $("#preview-content");
    this.imageSize = document.createElement("button"); this.imageSize.type = "button"; this.imageSize.className = "secondary-button"; this.imageSize.hidden = true;
    this.imageSize.textContent = "Actual size"; this.imageSize.setAttribute("aria-pressed", "false");
    this.imageSize.onclick = () => { const actual = this.content.classList.toggle("image-actual-size"); this.imageSize.textContent = actual ? "Fit image" : "Actual size"; this.imageSize.setAttribute("aria-pressed", String(actual)); };
    $("#copy-preview").after(this.imageSize);
    $("#close-preview").onclick = () => this.close();
    $("#expand-preview").onclick = () => {
      const expanded = this.panel.classList.toggle("expanded");
      $("#expand-preview").setAttribute("aria-pressed", String(expanded));
      $("#expand-preview").setAttribute("aria-label", expanded ? "Restore preview size" : "Expand preview");
    };
    $("#copy-preview").onclick = async () => {
      const current = this.current; if (!current) return;
      try { await navigator.clipboard.writeText(current.source); if (this.current === current) $("#copy-preview").textContent = "Copied"; }
      catch { if (this.current === current) $("#preview-note").textContent = "Clipboard unavailable. Select and copy the source from the chat."; }
    };
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.panel.hidden && !document.querySelector("dialog[open]")) { event.preventDefault(); this.close(); }
    });
    document.addEventListener("relay-panel-changed", () => { if (this.panel.hidden) this.clear(); });
    window.addEventListener("message", event => {
      if (event.origin === "null" && event.source === this.content.querySelector("iframe")?.contentWindow && event.data?.type === "relay-preview-close") this.close();
    });
  }
  setChat(chatId) { if (this.chatId !== chatId) { this.close(false); this.chatId = chatId; } }
  clear() { this.content.replaceChildren(); this.content.classList.remove("image-actual-size"); this.current = null; }
  open({ source, format = "text", title = "Document preview", metadata = "", trigger = document.activeElement, messageId, index }) {
    document.querySelectorAll(".control-menu[open]").forEach(menu => { menu.open = false; });
    openSidePanel("preview"); this.panel.classList.remove("expanded");
    this.current = { source, format, trigger, messageId, index };
    $("#preview-title").textContent = title;
    $("#copy-preview").textContent = "Copy source";
    $("#copy-preview").hidden = format === "image"; this.imageSize.hidden = format !== "image";
    this.imageSize.textContent = "Actual size"; this.imageSize.setAttribute("aria-pressed", "false"); this.content.classList.remove("image-actual-size");
    $("#expand-preview").setAttribute("aria-pressed", "false"); $("#expand-preview").setAttribute("aria-label", "Expand preview");
    this.content.replaceChildren();
    if (format === "image") {
      if (!/^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]*={0,2}$/.test(source)) { $("#preview-note").textContent = "Unsupported image format"; return; }
      const img = document.createElement("img"); img.className = "attachment-image-preview"; img.alt = title; img.decoding = "async";
      const current = this.current;
      img.onload = () => { if (this.current === current) $("#preview-note").textContent = `${metadata ? metadata + " · " : ""}${img.naturalWidth} × ${img.naturalHeight} pixels · image preview`; };
      img.onerror = () => { if (this.current === current) $("#preview-note").textContent = "This image could not be decoded. The attachment has been kept."; };
      $("#preview-note").textContent = "Loading image…"; img.src = source; this.content.append(img); $("#close-preview").focus({ preventScroll: true }); return;
    }
    const limited = source.slice(0, MAX_PREVIEW_LENGTH).toWellFormed();
    const clipped = source.length > MAX_PREVIEW_LENGTH ? " Preview truncated to 300,000 characters; Copy source keeps the full document." : "";
    if (["html", "markdown", "svg"].includes(format)) {
      const frame = document.createElement("iframe"); frame.title = `Isolated ${format === "markdown" ? "Markdown" : format === "svg" ? "SVG" : "HTML"} preview`;
      frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
      // A fragment never reaches the server. The opaque-origin preview page
      // sanitizes the entire document, including rendered Markdown, under CSP.
      const html = format === "markdown" ? marked.parse(limited, { gfm: true }) : limited;
      frame.src = `/preview.html#${encodeURIComponent(html)}`;
      this.content.append(frame);
      $("#preview-note").textContent = `Isolated preview · scripts and network disabled.${clipped}`;
    } else {
      const pre = document.createElement("pre"); pre.className = "document-source"; pre.textContent = limited;
      pre.tabIndex = 0; pre.setAttribute("aria-label", `${title} file content`);
      this.content.append(pre); $("#preview-note").textContent = `${metadata ? metadata + " · " : ""}Plain-text preview · content is not executed.${clipped}`;
    }
    $("#close-preview").focus({ preventScroll: true });
  }
  close(restoreFocus = true) {
    const current = this.current;
    if (!closeSidePanel("preview")) return;
    if (!restoreFocus) return;
    const trigger = current?.trigger?.isConnected ? current.trigger : current?.messageId ? document.querySelector(`[data-message-id="${CSS.escape(current.messageId)}"] [data-preview-index="${current.index}"]`) : null;
    (trigger || $("#message-input"))?.focus({ preventScroll: true });
  }
}
