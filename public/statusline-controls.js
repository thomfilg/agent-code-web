import { STATUS_ITEMS, DEFAULT_STATUS_ITEMS, validateStatusItems, visibleStatusItems, statusItemValue } from "./status-line.js";
import { OrderedFieldsControls } from "./ordered-fields-controls.js";
export class StatusLineControls extends OrderedFieldsControls {
  constructor(options) {
    super(options, { id: "statusline", title: "Status line", name: "status line", adjective: "status-line",
      defaults: DEFAULT_STATUS_ITEMS, items: STATUS_ITEMS, validate: validateStatusItems, hideLabel: "Hide status line", previewLabel: "Status line preview",
      about: "Optional extra fields for Relay's web footer, hidden by default. Model and reasoning stay in their controls, context in its indicator, and branches in the PR strip. Explicitly saved selections remain visible. This does not change native tui.status_line or config.toml, wake a worker or send a message. Values use saved worker reports; missing data stays Not reported. Closing without saving leaves the footer unchanged." });
    this.root = document.querySelector("#chat-statusline");
  }
  resetIdentity() { super.resetIdentity(); this.root.replaceChildren(); this.root.hidden = true; }
  draw(root, items) {
    root.replaceChildren();
    for (const id of items) {
      const item = statusItemValue(id, this.getChat() || {}), field = document.createElement("span"), label = document.createElement("span"), value = document.createElement("span");
      field.className = `statusline-item${item.unavailable ? " unavailable" : ""}`; field.dataset.item = id; field.title = item.title;
      label.className = "statusline-label"; label.textContent = `${item.label}: `; value.textContent = item.value; field.append(label, value); root.append(field);
    }
    if (!items.length) { const hidden = document.createElement("span"); hidden.className = "muted"; hidden.textContent = "Status line hidden"; root.append(hidden); }
  }
  render() {
    const items = visibleStatusItems(this.snapshot.items, this.snapshot.revision);
    this.root.hidden = !this.getChat() || !items.length; this.draw(this.root, items);
    if (this.getChat()?.status === "stopped" && items.length) { const saved = document.createElement("span"); saved.className = "statusline-snapshot"; saved.textContent = "Saved snapshot"; this.root.append(saved); }
    super.render();
  }
}
