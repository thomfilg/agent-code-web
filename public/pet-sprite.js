import { petAnimation, PET_IMAGE_LIMIT } from "./pets.js";

export class PetSprite {
  constructor(root) {
    this.root = root; this.canvas = document.createElement("canvas"); this.canvas.width = 192; this.canvas.height = 208; this.canvas.setAttribute("aria-hidden", "true");
    this.error = document.createElement("span"); this.error.className = "pet-art-error"; this.error.hidden = true;
    root.append(this.canvas, this.error); this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.sync = () => this.draw(); document.addEventListener("visibilitychange", this.sync); this.motion.addEventListener("change", this.sync);
    this.sleep = () => { this.asleep = true; this.draw(); }; this.wake = () => { this.asleep = false; this.draw(); };
    window.addEventListener("pagehide", this.sleep); window.addEventListener("pageshow", this.wake);
    this.sequence = 0;
  }
  async show(pet, scope, activity, { retry = false } = {}) {
    this.activity = activity;
    const key = pet ? `${scope}:${pet.id}:${pet.version}` : null;
    if (key === this.key && !retry) { this.draw(); return; }
    this.clear(); this.key = key; this.pet = pet;
    if (!pet) return;
    const sequence = this.sequence; this.root.dataset.art = "loading"; this.abort = new AbortController();
    try {
      const response = await fetch(`/api/pets/assets/${encodeURIComponent(pet.id)}?scope=${encodeURIComponent(scope)}&v=${encodeURIComponent(pet.version)}`, { credentials: "same-origin", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "Pet artwork unavailable. Use Retry artwork."); }
      const blob = await response.blob(); if (blob.size > PET_IMAGE_LIMIT) throw new Error("Pet artwork is too large.");
      // At most one decode per view (one companion and one picker). Rapid
      // selections may cancel fetches, but image decoding itself is not
      // abortable: skip superseded queued decodes and close late bitmaps.
      const task = (this.decoding || Promise.resolve()).catch(() => {}).then(() => sequence === this.sequence ? createImageBitmap(blob) : null);
      this.decoding = task;
      const bitmap = await task;
      if (this.decoding === task) this.decoding = null;
      if (!bitmap) return;
      if (sequence !== this.sequence) { bitmap.close(); return; }
      if (bitmap.width !== pet.frame.width * pet.frame.columns || bitmap.height !== pet.frame.height * pet.frame.rows) { bitmap.close(); throw new Error("Pet artwork does not match its frame grid."); }
      this.bitmap = bitmap; this.root.dataset.art = "ready"; this.draw();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.root.dataset.art = "error"; this.error.textContent = error.name === "TimeoutError" ? "Pet artwork timed out. Use Retry artwork." : error.message; this.error.hidden = false;
    }
  }
  draw() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.bitmap || !this.pet) return;
    const animation = petAnimation(this.pet, this.activity?.animation || "idle"), moving = this.activity?.animate && !this.motion.matches && !document.hidden && !this.asleep && this.root.isConnected && animation.frames.length > 1 && animation.fps > 0;
    const index = moving ? Math.floor(performance.now() * animation.fps / 1000) % animation.frames.length : 0, frame = animation.frames[index];
    const { width, height, columns } = this.pet.frame, context = this.canvas.getContext("2d");
    // Preserve the frame aspect ratio; canvas pixels are not CSS-scaled to the
    // size of the entire sprite sheet, and old decoded images are released.
    const scale = Math.min(192 / width, 208 / height);
    this.canvas.width = Math.max(1, Math.round(width * scale)); this.canvas.height = Math.max(1, Math.round(height * scale));
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(this.bitmap, (frame % columns) * width, Math.floor(frame / columns) * height, width, height, 0, 0, this.canvas.width, this.canvas.height);
    this.root.dataset.frame = String(frame); this.root.dataset.animating = String(Boolean(moving));
    if (moving) this.timer = setTimeout(() => this.draw(), 1000 / animation.fps);
  }
  clear() {
    this.sequence++; this.abort?.abort(); clearTimeout(this.timer); this.timer = null; this.bitmap?.close(); this.bitmap = null;
    this.canvas.getContext("2d").clearRect(0, 0, this.canvas.width, this.canvas.height); this.error.hidden = true;
    this.root.dataset.art = "off"; this.root.dataset.animating = "false"; delete this.root.dataset.frame; this.key = null;
  }
  destroy() {
    this.clear(); document.removeEventListener("visibilitychange", this.sync); this.motion.removeEventListener("change", this.sync);
    window.removeEventListener("pagehide", this.sleep); window.removeEventListener("pageshow", this.wake);
  }
}
