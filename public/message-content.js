import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import { highlightCode } from "./syntax-highlight.js";
import { stripRelayProtocol } from "./relay-protocol.js";
export { stripRelayProtocol };
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const renderer = new marked.Renderer();
renderer.html = ({ text }) => `<pre class="html-source"><code>${escape(text)}</code></pre>`;
export function renderContent(root, text, { onPreview, imageFor } = {}) {
  root.classList.add("markdown");
  root.innerHTML = DOMPurify.sanitize(marked.parse(stripRelayProtocol(text), { renderer, gfm: true }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button", "iframe", "video", "audio"],
    FORBID_ATTR: ["style", "id", "name"],
  });
  for (const link of root.querySelectorAll("a")) {
    if (!/^https?:\/\//i.test(link.getAttribute("href") || "")) link.removeAttribute("href");
    else { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }
  // Remote images may track readers. Do not load them automatically.
  for (const img of root.querySelectorAll("img")) {
    // Images an agent saved in its workspace were captured as attachments.
    const captured = imageFor?.(img.getAttribute("src") || "");
    if (captured) { img.replaceWith(captured); continue; }
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(img.getAttribute("src") || "")) img.replaceWith(document.createTextNode(img.alt || "[Image]"));
  }
  for (const [index, pre] of [...root.querySelectorAll("pre")].entries()) {
    const code = pre.querySelector("code"); if (!code) continue;
    const source = code.textContent;
    const language = pre.classList.contains("html-source") ? "html" : [...code.classList].find(name => name.startsWith("language-"))?.slice(9).toLowerCase();
    const toolbar = document.createElement("div"); toolbar.className = "code-toolbar";
    const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(source); copy.textContent = "Copied"; } catch { copy.textContent = "Copy unavailable"; } };
    toolbar.append(copy); pre.before(toolbar);
    if (onPreview) {
      const format = pre.classList.contains("html-source") || ["html", "htm"].includes(language) ? "html" : ["md", "markdown"].includes(language) ? "markdown" : language === "svg" ? "svg" : "text";
      const title = { html: "HTML preview", markdown: "Markdown preview", svg: "SVG preview", text: "Text preview" }[format];
      const preview = document.createElement("button"); preview.type = "button"; preview.className = "document-preview-button";
      preview.textContent = `Open ${title} ↗`; preview.setAttribute("aria-controls", "preview-panel"); preview.dataset.previewIndex = index;
      preview.onclick = () => onPreview({ source, format, title, trigger: preview, index });
      pre.after(preview);
    }
    highlightCode(code, language);
  }
}
