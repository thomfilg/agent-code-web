import { STATUS_ITEMS, DEFAULT_STATUS_ITEMS, validateStatusItems, statusItemValue } from "./status-line.js";
import { OrderedFieldsControls } from "./ordered-fields-controls.js";
export class StatusLineControls extends OrderedFieldsControls {
  constructor(options) {
    super(options, { id: "statusline", title: "Status line", name: "status line", adjective: "status-line",
      defaults: DEFAULT_STATUS_ITEMS, items: STATUS_ITEMS, validate: validateStatusItems, hideLabel: "Hide status line", previewLabel: "Status line preview",
      about: "This configures Relay's web footer, not native tui.status_line or config.toml. It never wakes a worker or sends a message. Values use saved worker reports; missing data stays Not reported, and stopped workers show a saved snapshot. Closing without saving leaves the footer unchanged." });
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
    this.root.hidden = !this.getChat() || !this.snapshot.items.length; this.draw(this.root, this.snapshot.items);
    if (this.getChat()?.status === "stopped" && this.snapshot.items.length) { const saved = document.createElement("span"); saved.className = "statusline-snapshot"; saved.textContent = "Saved snapshot"; this.root.append(saved); }
    super.render();
  }
}
