import { TITLE_ITEMS, DEFAULT_TITLE_ITEMS, validateTitleItems, formatTabTitle, titleBusy } from "./tab-title.js";
import { OrderedFieldsControls } from "./ordered-fields-controls.js";
export class TabTitleControls extends OrderedFieldsControls {
  constructor(options) {
    super(options, { id: "tab-title", title: "Browser tab title", name: "tab title", adjective: "tab-title",
      defaults: DEFAULT_TITLE_ITEMS, items: TITLE_ITEMS, validate: validateTitleItems, hideLabel: "Use app title only", previewLabel: "Browser tab title preview",
      about: "This configures this Relay browser tab, not the chat name or native tui.terminal_title/config.toml. No worker is woken and no prompt is sent. Fields use saved, permitted chat metadata; missing progress is not guessed. Selected chat/project/branch names are visible in your browser tab. Use app title only for a neutral title. Closing cancels unsaved edits." });
    this.frame = 0; this.ready = false; this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", () => this.render());
    this.motion.addEventListener("change", () => this.render());
    window.addEventListener("pagehide", () => { clearInterval(this.timer); this.timer = null; });
    window.addEventListener("pageshow", () => this.render());
  }
  resetIdentity() { this.ready = false; super.resetIdentity(); this.render(); }
  async load() { const result = await super.load(); if (result) { this.ready = true; this.render(); } return result; }
  permittedChat() {
    const chat = this.getChat();
    // A cookie can change in another tab before this page's chat list catches
    // up. Never project a cached private chat under a different account.
    return chat && (!chat.ownerId || chat.ownerId === this.snapshot.account?.id) ? chat : null;
  }
  draw(root, items) { root.textContent = formatTabTitle(items, this.permittedChat(), this.motion.matches ? null : this.frame); }
  render() {
    const chat = this.ready ? this.permittedChat() : null;
    const title = formatTabTitle(this.snapshot.items, chat, this.motion.matches ? null : this.frame);
    if (document.title !== title) document.title = title;
    const animate = titleBusy(chat) && this.snapshot.items.includes("spinner") && !document.hidden && !this.motion.matches;
    if (animate && !this.timer) this.timer = setInterval(() => { this.frame++; this.render(); }, 300);
    if (!animate && this.timer) { clearInterval(this.timer); this.timer = null; }
    super.render();
  }
}
