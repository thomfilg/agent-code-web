const NEAR_BOTTOM = 48;
const metrics = element => ({ top: element.scrollTop, height: element.scrollHeight, view: element.clientHeight, width: element.clientWidth });
const resized = (before, after) => before.height !== after.height || before.view !== after.view || before.width !== after.width;

// Transcript attachment is user intent, not a consequence of a reflow. In
// particular, replacing a virtual window and resizing the composer both emit
// scroll events that must not silently turn "follow" into "reading history".
export class MessageFollow {
  constructor({ scroller, atLatest, reading, setReading, onScroll = () => {}, onChange = () => {},
    frame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id), Observer = ResizeObserver, now = Date.now,
    scrollable = element => ["auto", "scroll", "overlay"].includes(getComputedStyle(element).overflowY) }) {
    Object.assign(this, { scroller, atLatest, reading, setReading, onScroll, onChange, frame, cancelFrame, now, scrollable });
    this.previous = metrics(scroller); this.version = 0; this.adjusting = false; this.listeners = [];
    const listen = (target, name, handler) => { target.addEventListener(name, handler, { passive: true }); this.listeners.push(() => target.removeEventListener(name, handler)); };
    listen(scroller, "scroll", () => this.scrolled());
    listen(scroller, "wheel", event => {
      if (!event.ctrlKey && event.deltaY && this.consumesScroll(event.target, Math.sign(event.deltaY))) this.intent(Math.sign(event.deltaY));
    });
    listen(scroller, "touchstart", event => { this.touchY = event.touches?.[0]?.clientY; });
    listen(scroller, "touchmove", event => {
      const next = event.touches?.[0]?.clientY;
      if (Number.isFinite(next) && Number.isFinite(this.touchY) && Math.abs(next - this.touchY) > 2) {
        const direction = Math.sign(this.touchY - next);
        if (this.consumesScroll(event.target, direction)) this.intent(direction);
      }
      this.touchY = next;
    });
    listen(scroller, "keydown", event => {
      if (event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) this.intent(-1);
      else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) this.intent(1);
    });
    listen(scroller, "pointerdown", event => {
      // Scrollbar dragging need not produce wheel/touch events. Leave message
      // selection and clicks inside the transcript alone.
      const right = scroller.getBoundingClientRect().right;
      if (event.button === 0 && event.target === scroller && event.clientX >= right - 18) {
        this.dragging = true; this.pointerId = event.pointerId; this.setReading(true); this.intent(0);
      }
    });
    const pointerRoot = scroller.ownerDocument || scroller;
    const release = event => { if (this.dragging && event.pointerId === this.pointerId) { this.dragging = false; this.intentUntil = this.now() + 500; } };
    listen(pointerRoot, "pointerup", release); listen(pointerRoot, "pointercancel", release);
    if (pointerRoot.defaultView) listen(pointerRoot.defaultView, "blur", () => { this.dragging = false; this.intentUntil = 0; });
    this.observer = new Observer(() => {
      if (this.closed) return;
      if (this.following()) this.pin();
      else this.previous = metrics(scroller);
      this.onChange();
    });
    this.observe();
  }
  following() { return this.atLatest() && !this.reading(); }
  consumesScroll(target, direction) {
    for (let element = target; element && element !== this.scroller; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1 && this.scrollable(element) &&
        (direction < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1)) return false;
    }
    return true;
  }
  intent(direction) {
    if (direction < 0 && this.scroller.scrollHeight <= this.scroller.clientHeight + 1 && this.atLatest()) return;
    this.direction = direction; this.intentUntil = this.now() + 500;
    if (direction < 0) this.setReading(true);
    this.onChange();
  }
  scrolled() {
    if (this.closed) return;
    const next = metrics(this.scroller), near = next.height - next.top - next.view <= NEAR_BOTTOM;
    const manual = this.dragging || this.intentUntil > this.now(), direction = this.dragging ? 0 : this.direction;
    if (manual) {
      if (direction >= 0 && near && this.atLatest()) this.setReading(false);
      else if (direction <= 0 && !near) this.setReading(true);
    } else if (!this.adjusting) {
      if (this.following() && resized(this.previous, next)) { this.pin(); this.onChange(); return; }
      if (near && this.atLatest() && !resized(this.previous, next) && next.top > this.previous.top + 1) this.setReading(false);
      else if (!resized(this.previous, next) && next.top < this.previous.top - 1) this.setReading(true);
    }
    this.previous = next; this.onChange();
    if (!this.adjusting) this.onScroll({ nearBottom: near });
  }
  begin({ reset = false } = {}) {
    if (reset) { this.setReading(false); this.intentUntil = 0; this.dragging = false; }
    this.adjusting = true; this.cancelFrame(this.pending);
    return { version: ++this.version, follow: reset || this.following() };
  }
  end(render) {
    this.observe();
    if (render.follow && this.following()) this.pin();
    this.previous = metrics(this.scroller); this.onChange();
    // A sibling approval/PR/queue/composer may change height after messages were
    // rendered. Re-pin after that layout, but never over a newer user gesture.
    this.pending = this.frame(() => {
      this.pending = this.frame(() => {
        if (this.closed || render.version !== this.version) return;
        if (render.follow && this.following()) this.pin();
        this.adjusting = false; this.previous = metrics(this.scroller); this.onChange();
      });
    });
  }
  pin() {
    if (this.scroller.clientHeight > 0) this.scroller.scrollTop = this.scroller.scrollHeight;
    this.previous = metrics(this.scroller);
  }
  observe() {
    this.observer.disconnect(); this.observer.observe(this.scroller, { box: "border-box" });
    // At most the bounded virtual window plus its pager/live reply. This also
    // catches delayed image/font/code-layout changes, not just window resize.
    for (const element of this.scroller.children) this.observer.observe(element, { box: "border-box" });
  }
  resume() { this.intentUntil = 0; this.dragging = false; this.setReading(false); this.onChange(); }
  close() {
    this.closed = true; this.dragging = false; this.cancelFrame(this.pending); this.observer.disconnect();
    for (const remove of this.listeners.splice(0)) remove();
  }
}
