import { canHighlight, syntaxLanguage, MAX_SYNTAX_TOKENS } from "./syntax-theme.js";

let worker, active, timer, scheduled, nextId = 0, failed = false;
const pending = new Map(), versions = new WeakMap();
function state(element, value) {
  element.dataset.highlight = value;
  element.dispatchEvent(new CustomEvent("relay-syntax-highlight", { bubbles: true, detail: value }));
}
function finish(tokens, error = false) {
  clearTimeout(timer); const job = active; active = null;
  if (job && job.element.isConnected && versions.get(job.element) === job.id && job.element.textContent === job.source) {
    const element = job.element;
    if (Array.isArray(tokens) && tokens.length <= MAX_SYNTAX_TOKENS) {
      const fragment = document.createDocumentFragment(); let offset = 0;
      for (const [start, end, className] of tokens) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end < start || end > job.source.length || !/^syntax-[\w-]+(?: syntax-[\w-]+)*$/.test(className)) { error = true; break; }
        fragment.append(document.createTextNode(job.source.slice(offset, start)));
        const span = document.createElement("span"); span.className = className; span.textContent = job.source.slice(start, end); fragment.append(span); offset = end;
      }
      fragment.append(document.createTextNode(job.source.slice(offset)));
      if (!error && fragment.textContent === job.source) { element.replaceChildren(fragment); state(element, "ready"); }
      else state(element, "unavailable");
    } else state(element, error ? "unavailable" : "plain");
  }
  scheduled = setTimeout(pump, 0);
}
function fail() { failed = true; worker?.terminate(); worker = null; finish(null, true); }
function pump() {
  scheduled = null; if (active) return;
  for (const [element, job] of pending) {
    pending.delete(element);
    if (!element.isConnected || versions.get(element) !== job.id || element.textContent !== job.source) continue;
    if (failed) { state(element, "unavailable"); continue; }
    active = job;
    try {
      if (!worker) {
        const instance = worker = new Worker(new URL("./syntax-worker.js", import.meta.url), { type: "module" });
        instance.onmessage = ({ data }) => { if (worker === instance && active?.id === data.id) finish(data.tokens, Boolean(data.error)); };
        instance.onerror = event => { event.preventDefault(); if (worker === instance) fail(); };
      }
      timer = setTimeout(fail, 5000);
      worker.postMessage({ id: job.id, source: job.source, language: job.language });
    } catch { fail(); }
    return;
  }
  for (const element of document.querySelectorAll('.syntax-code[data-highlight="deferred"]')) {
    if (pending.size >= 40) break;
    highlightCode(element, element.dataset.syntaxLanguage);
  }
}
export function highlightCode(element, language) {
  const source = element.textContent, id = ++nextId; versions.set(element, id); element.classList.add("syntax-code");
  if (!syntaxLanguage(language)) { state(element, "plain"); return; }
  element.dataset.syntaxLanguage = language;
  if ((element.closest("[data-syntax-theme]")?.dataset.syntaxTheme || document.documentElement.dataset.syntaxTheme) === "plain") { state(element, "plain"); return; }
  if (!canHighlight(source)) { state(element, "size-limit"); return; }
  // Streaming renders and unmounted history must not retain unlimited sources.
  if (pending.size >= 40) { state(element, "deferred"); return; }
  pending.set(element, { id, element, source, language }); state(element, "pending");
  if (!scheduled) scheduled = setTimeout(pump, 0);
}
export function retryHighlighting() {
  failed = false; worker?.terminate(); worker = null;
  if (active) { clearTimeout(timer); state(active.element, "plain"); active = null; }
}
export function refreshHighlighting() {
  for (const element of document.querySelectorAll(".syntax-code[data-syntax-language]")) {
    if (!["ready", "pending", "size-limit"].includes(element.dataset.highlight)) highlightCode(element, element.dataset.syntaxLanguage);
  }
}
window.addEventListener("pagehide", () => {
  clearTimeout(timer); clearTimeout(scheduled); worker?.terminate(); worker = null;
  if (active) state(active.element, "plain"); for (const element of pending.keys()) state(element, "plain");
  active = null; scheduled = null; pending.clear();
});
window.addEventListener("pageshow", refreshHighlighting);
