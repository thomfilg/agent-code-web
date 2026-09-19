const make = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
export class MessageNavigator {
  constructor({ state, scroller, root, ensureVisible }) {
    Object.assign(this, { state, scroller, root, ensureVisible }); this.key = ""; this.readingHistory = false;
    this.toggle = root.querySelector("button"); this.list = root.querySelector(".message-nav-list"); this.ticks = root.querySelector(".message-nav-ticks");
    this.toggle.onclick = () => { this.open = !this.open; this.root.dataset.open = String(this.open); this.toggle.setAttribute("aria-expanded", String(this.open)); };
    root.onkeydown = event => { if (event.key === "Escape") { this.close(); this.toggle.focus(); event.preventDefault(); this.root.dataset.dismissed = "true"; } };
    root.onpointerenter = () => { delete this.root.dataset.dismissed; this.toggle.setAttribute("aria-expanded", "true"); };
    root.onpointerleave = () => { delete this.root.dataset.dismissed; if (!this.open) this.toggle.setAttribute("aria-expanded", "false"); };
    root.onfocusin = () => { delete this.root.dataset.dismissed; this.toggle.setAttribute("aria-expanded", "true"); };
    root.onfocusout = event => { if (!root.contains(event.relatedTarget)) this.close(); };
    document.addEventListener("pointerdown", event => { if (!root.contains(event.target)) this.close(); });
    // MessageFollow owns attachment intent, including render/resize scrolls.
    scroller.addEventListener("scroll", () => this.mark(), { passive: true });
  }
  close() { this.open = false; this.root.dataset.open = "false"; this.toggle.setAttribute("aria-expanded", "false"); }
  update() {
    const chat = this.state.active, messages = (chat?.messages || []).filter(m => m.role === "user" && !m.meta?.renderingSample);
    this.root.hidden = !messages.length;
    const key = `${chat?.id}:${messages.map(m => m.id).join(",")}`;
    if (key !== this.key) {
      if (this.chatId !== chat?.id) { this.readingHistory = false; this.close(); }
      this.chatId = chat?.id; this.key = key; this.list.replaceChildren(); this.ticks.replaceChildren();
      for (const [index, message] of messages.entries()) {
        const preview = (message.text || message.attachments?.map(a => a.name).join(", ") || "Attachment").replace(/\s+/g, " ");
        const button = make("button", "message-nav-item", preview); button.type = "button"; button.dataset.target = message.id; button.title = preview; button.setAttribute("aria-label", `Jump to message ${index + 1}: ${preview.slice(0, 150)}`);
        button.onclick = () => this.jump(message.id); this.list.append(button);
        const tick = make("span", "message-nav-tick"); tick.dataset.target = message.id; this.ticks.append(tick);
      }
    }
    this.mark();
  }
  jump(id) {
    this.readingHistory = true;
    this.ensureVisible?.(id);
    const target = [...this.scroller.querySelectorAll(".message.user")].find(n => n.dataset.messageId === id); if (!target) return;
    this.readingHistory = true; this.close(); this.root.dataset.dismissed = "true";
    target.tabIndex = -1; target.focus({ preventScroll: true });
    this.scroller.scrollTo({ top: target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop - 16, behavior: "instant" });
    target.classList.add("message-jump-target"); this.mark();
  }
  mark() {
    const top = this.scroller.getBoundingClientRect().top + 24;
    const messages = [...this.scroller.querySelectorAll(".message.user")]; let current = messages[0];
    for (const message of messages) { if (message.getBoundingClientRect().top <= top) current = message; else break; }
    for (const item of this.list.children) { const selected = item.dataset.target === current?.dataset.messageId; item.setAttribute("aria-current", String(selected)); }
    for (const tick of this.ticks.children) tick.classList.toggle("active", tick.dataset.target === current?.dataset.messageId);
  }
}
