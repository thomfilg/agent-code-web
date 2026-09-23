const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };

export class MessageSearch {
  constructor({ api, context, select, toast }) {
    Object.assign(this, { api, context, select, toast }); this.version = 0;
    this.dialog = $("#message-search-dialog"); this.input = $("#message-search-query"); this.list = $("#message-search-results");
    this.dialog.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.dialog.close(); } });
    $("#message-search-button").onclick = () => this.open(); $("#message-search-close").onclick = () => this.dialog.close();
    $("#message-search-form").onsubmit = event => { event.preventDefault(); void this.search(); };
    $("#message-search-role").onchange = () => { if (this.input.value.trim()) void this.search(); };
    this.input.oninput = () => { this.version++; clearTimeout(this.timer); this.clear(); if (this.input.value.trim()) this.timer = setTimeout(() => this.search(), 250); };
    $("#message-search-more").onclick = () => this.search(this.nextOffset);
    this.dialog.addEventListener("close", () => {
      this.version++; clearTimeout(this.timer);
      const trigger = $("#message-search-button"), bounds = trigger.getBoundingClientRect();
      (bounds.left >= 0 && bounds.right <= innerWidth ? trigger : $("#open-sidebar")).focus({ preventScroll: true });
    });
  }
  clear() { this.list.replaceChildren(); this.nextOffset = null; $("#message-search-more").hidden = true; $("#message-search-status").textContent = ""; }
  invalidate() { this.version++; clearTimeout(this.timer); this.dialog.close(); this.input.value = ""; this.clear(); }
  open() { this.clear(); this.input.value = ""; this.dialog.showModal(); this.input.focus(); }
  async search(offset = 0) {
    clearTimeout(this.timer); if (!this.dialog.open || !this.input.value.trim()) return;
    const query = this.input.value, role = $("#message-search-role").value, context = this.context(), version = ++this.version;
    const current = () => this.dialog.open && version === this.version && context === this.context();
    $("#message-search-status").textContent = "Searching saved messages…"; $("#message-search-more").disabled = true;
    if (!offset) this.list.replaceChildren();
    try {
      const result = await this.api("/api/message-search", { method: "POST", body: JSON.stringify({ query, role, offset }) });
      if (!current()) return;
      for (const match of result.results) {
        const row = node("li"), open = node("button", undefined, "message-search-result"); open.type = "button";
        open.append(node("strong", match.title || "Conversation"), node("small", `${match.role === "user" ? "You" : "Final answer"} · ${match.repository || "No repository"}${match.companyId ? ` · ${match.companyId}` : ""} · ${new Date(match.createdAt).toLocaleString()}`));
        const excerpt = node("span", undefined, "message-search-excerpt");
        const at = match.excerpt.toLowerCase().indexOf(query.trim().toLowerCase());
        if (match.leading) excerpt.append(document.createTextNode("…"));
        if (at >= 0) excerpt.append(document.createTextNode(match.excerpt.slice(0, at)), node("mark", match.excerpt.slice(at, at + query.trim().length)), document.createTextNode(match.excerpt.slice(at + query.trim().length)));
        else excerpt.append(document.createTextNode(match.excerpt));
        if (match.trailing) excerpt.append(document.createTextNode("…")); open.append(excerpt);
        open.onclick = async () => {
          if (!this.dialog.open || context !== this.context() || query !== this.input.value || role !== $("#message-search-role").value) return;
          this.dialog.close();
          try { await this.select(match.chatId, match.messageId); } catch (error) { this.toast(error.message); }
        };
        row.append(open); this.list.append(row);
      }
      this.nextOffset = result.nextOffset; $("#message-search-more").hidden = result.nextOffset === null;
      $("#message-search-coverage").textContent = result.coverage;
      $("#message-search-status").textContent = `${this.list.children.length} result${this.list.children.length === 1 ? "" : "s"}${result.truncated ? " shown · search is bounded" : ""}.`;
    } catch (error) { if (current()) $("#message-search-status").textContent = error.message; }
    finally { if (current()) $("#message-search-more").disabled = false; }
  }
}
