// Full-screen image viewer with a carousel over every image in the chat.
// Items load lazily: { key, name, caption, load: () => Promise<data URI> }.
const IMAGE_SOURCE = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]*={0,2}$/;
export const wrapIndex = (index, length) => length ? ((index % length) + length) % length : 0;

const make = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const iconButton = (label, text, className) => { const button = make("button", `lightbox-button ${className}`, text); button.type = "button"; button.setAttribute("aria-label", label); button.title = label; return button; };

export class ImageLightbox {
  constructor() {
    this.dialog = make("dialog", "image-lightbox"); this.dialog.setAttribute("aria-label", "Image viewer");
    const header = make("div", "lightbox-header");
    this.counter = make("span", "lightbox-counter"); this.title = make("strong", "lightbox-title"); this.caption = make("span", "lightbox-caption");
    const heading = make("div", "lightbox-heading"); heading.append(this.title, this.caption);
    this.zoom = iconButton("Actual size", "1:1", "lightbox-zoom"); this.zoom.setAttribute("aria-pressed", "false");
    this.closeButton = iconButton("Close image viewer", "×", "lightbox-close");
    header.append(this.counter, heading, this.zoom, this.closeButton);
    this.stage = make("div", "lightbox-stage");
    this.image = make("img", "lightbox-image"); this.image.decoding = "async"; this.image.alt = "";
    this.status = make("p", "lightbox-status"); this.status.setAttribute("role", "status");
    this.previous = iconButton("Previous image", "‹", "lightbox-previous"); this.next = iconButton("Next image", "›", "lightbox-next");
    this.stage.append(this.image, this.status);
    // The arrows stay put while a zoomed image scrolls underneath them.
    const frame = make("div", "lightbox-frame"); frame.append(this.stage, this.previous, this.next);
    this.strip = make("div", "lightbox-strip"); this.strip.setAttribute("role", "tablist"); this.strip.setAttribute("aria-label", "Images in this chat");
    this.dialog.append(header, frame, this.strip);
    document.body.append(this.dialog);

    this.closeButton.onclick = () => this.close();
    this.previous.onclick = () => this.show(this.index - 1);
    this.next.onclick = () => this.show(this.index + 1);
    this.zoom.onclick = () => this.toggleZoom();
    this.image.onclick = () => this.toggleZoom();
    // A click on the dark area around the image closes, like any lightbox.
    this.stage.addEventListener("click", event => { if (event.target === this.stage) this.close(); });
    this.dialog.addEventListener("close", () => this.closed());
    this.dialog.addEventListener("keydown", event => {
      const moves = { ArrowLeft: -1, ArrowRight: 1 };
      if (event.key in moves) { event.preventDefault(); this.show(this.index + moves[event.key]); }
      else if (event.key === "Home") { event.preventDefault(); this.show(0); }
      else if (event.key === "End") { event.preventDefault(); this.show(this.items.length - 1); }
    });
    let start = null;
    this.stage.addEventListener("pointerdown", event => { if (event.pointerType !== "mouse") start = { x: event.clientX, y: event.clientY }; });
    this.stage.addEventListener("pointercancel", () => { start = null; });
    this.stage.addEventListener("pointerup", event => {
      if (!start || event.pointerType === "mouse") { start = null; return; }
      const dx = event.clientX - start.x, dy = event.clientY - start.y; start = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && !this.stage.classList.contains("actual-size")) this.show(this.index + (dx < 0 ? 1 : -1));
    });
    this.sources = new Map();
    // Thumbnails load only once they scroll into the strip.
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { this.observer.unobserve(entry.target); this.thumbnail([...this.strip.children].indexOf(entry.target)); }
    }, { root: this.strip, rootMargin: "0px 200px" });
  }
  open(items, index = 0, trigger = document.activeElement) {
    if (!items.length) return;
    this.items = items; this.trigger = trigger; this.sources.clear();
    this.strip.replaceChildren(...items.map((item, position) => {
      const thumb = make("button", "lightbox-thumb"); thumb.type = "button"; thumb.setAttribute("role", "tab");
      thumb.setAttribute("aria-label", `${item.name} (${position + 1} of ${items.length})`); thumb.title = item.name;
      thumb.onclick = () => this.show(position);
      return thumb;
    }));
    for (const thumb of this.strip.children) this.observer.observe(thumb);
    this.strip.hidden = items.length < 2; this.previous.hidden = this.next.hidden = items.length < 2;
    if (!this.dialog.open) this.dialog.showModal();
    this.show(index);
  }
  load(position) {
    const item = this.items[position];
    if (!this.sources.has(item.key)) {
      const request = Promise.resolve().then(item.load).then(source => { if (!IMAGE_SOURCE.test(source || "")) throw Error("Unsupported image format"); return source; });
      request.catch(() => this.sources.delete(item.key));
      this.sources.set(item.key, request);
    }
    return this.sources.get(item.key);
  }
  async show(position) {
    if (!this.items?.length) return;
    this.index = wrapIndex(position, this.items.length);
    const item = this.items[this.index], version = this.version = (this.version || 0) + 1;
    this.counter.textContent = `${this.index + 1} / ${this.items.length}`;
    this.title.textContent = item.name; this.caption.textContent = item.caption || ""; this.caption.hidden = !item.caption;
    this.stage.classList.remove("actual-size"); this.zoom.setAttribute("aria-pressed", "false");
    this.image.removeAttribute("src"); this.image.alt = item.caption || item.name; this.image.hidden = true;
    this.status.textContent = "Loading image…"; this.status.hidden = false;
    [...this.strip.children].forEach((thumb, position) => {
      const selected = position === this.index;
      thumb.setAttribute("aria-selected", String(selected)); thumb.tabIndex = selected ? 0 : -1;
      if (selected) thumb.scrollIntoView({ block: "nearest", inline: "center" });
    });
    this.thumbnail(this.index);
    try {
      const source = await this.load(this.index);
      if (version !== this.version) return;
      this.image.onload = () => { if (version === this.version) { this.status.hidden = true; this.image.hidden = false; } };
      this.image.onerror = () => { if (version === this.version) this.status.textContent = "This image could not be decoded."; };
      this.image.src = source;
    } catch (error) { if (version === this.version) this.status.textContent = error.message || "This image could not be loaded."; }
    // Neighbours load in the background so paging feels instant.
    for (const offset of [1, -1]) if (this.items.length > 1) { const neighbour = wrapIndex(this.index + offset, this.items.length); this.load(neighbour).then(() => this.thumbnail(neighbour), () => {}); }
  }
  async thumbnail(position) {
    const thumb = this.strip.children[position]; if (!thumb || thumb.querySelector("img")) return;
    try { const source = await this.load(position); if (thumb.isConnected && !thumb.querySelector("img")) { const img = make("img"); img.alt = ""; img.decoding = "async"; img.src = source; thumb.append(img); } }
    catch { thumb.classList.add("failed"); }
  }
  toggleZoom() {
    if (this.image.hidden) return;
    const actual = this.stage.classList.toggle("actual-size");
    this.zoom.setAttribute("aria-pressed", String(actual)); this.zoom.setAttribute("aria-label", actual ? "Fit to screen" : "Actual size"); this.zoom.title = this.zoom.getAttribute("aria-label");
  }
  close() { if (this.dialog.open) this.dialog.close(); }
  closed() {
    this.observer.disconnect(); this.version = (this.version || 0) + 1; this.items = []; this.sources.clear(); this.image.removeAttribute("src"); this.strip.replaceChildren();
    if (this.trigger?.isConnected) this.trigger.focus({ preventScroll: true });
  }
}
