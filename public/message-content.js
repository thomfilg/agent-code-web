import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const renderer = new marked.Renderer();
renderer.html = ({ text }) => `<pre class="html-source"><code>${escape(text)}</code></pre>`;
export function renderContent(root, text) {
  root.classList.add("markdown");
  root.innerHTML = DOMPurify.sanitize(marked.parse(text, { renderer, gfm: true }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button", "iframe", "video", "audio"],
    FORBID_ATTR: ["style", "id", "name"],
  });
  for (const link of root.querySelectorAll("a")) {
    if (!/^https?:\/\//i.test(link.getAttribute("href") || "")) link.removeAttribute("href");
    else { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }
  // Remote images may track readers. Do not load them automatically.
  for (const img of root.querySelectorAll("img")) {
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(img.getAttribute("src") || "")) img.replaceWith(document.createTextNode(img.alt || "[Image]"));
  }
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code"); if (!code) continue;
    const source = code.textContent;
    const toolbar = document.createElement("div"); toolbar.className = "code-toolbar";
    const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy";
    copy.onclick = async () => { try { await navigator.clipboard.writeText(source); copy.textContent = "Copied"; } catch { copy.textContent = "Copy unavailable"; } };
    toolbar.append(copy); pre.before(toolbar);
    if (code.classList.contains("language-html") || pre.classList.contains("html-source")) {
      const details = document.createElement("details"); details.className = "html-preview";
      const summary = document.createElement("summary"); summary.textContent = "HTML preview · isolated, scripts and network disabled";
      details.append(summary); pre.after(details);
      details.addEventListener("toggle", () => {
        if (!details.open || details.querySelector("iframe")) return;
        const frame = document.createElement("iframe"); frame.title = "Isolated HTML preview";
        frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
        frame.src = `/preview.html#${encodeURIComponent(source.slice(0, 300000))}`;
        details.append(frame);
      });
    }
  }
}
