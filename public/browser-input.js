// Bound outstanding remote commands without slowing every key to one network
// round trip. Coalesce only adjacent, unsent motion; clicks/keys are barriers.
export class BrowserInputQueue {
  constructor(request, { limit = 12, schedule = callback => requestAnimationFrame(callback), cancel = id => cancelAnimationFrame(id) } = {}) {
    Object.assign(this, { request, limit, schedule, cancel }); this.queue = []; this.active = 0; this.epoch = 0;
  }
  push(action, params = {}) {
    const ticket = Promise.withResolvers(), last = this.queue.at(-1);
    const motion = action === "mouse" && ["mouseMoved", "mouseWheel"].includes(params.type);
    const merge = motion && last?.action === action && last.params.type === params.type
      && last.params.modifiers === params.modifiers && last.params.buttons === params.buttons && last.params.button === params.button
      && (params.type !== "mouseWheel" || ["deltaX", "deltaY"].every(key => Math.abs((last.params[key] || 0) + (params[key] || 0)) <= 3000));
    if (merge) {
      const previous = last.params; last.params = { ...params };
      if (params.type === "mouseWheel") for (const key of ["deltaX", "deltaY"]) last.params[key] = (previous[key] || 0) + (params[key] || 0);
      last.tickets.push(ticket);
    } else this.queue.push({ action, params, tickets: [ticket] });
    if (!motion) this.pump();
    else if (this.frame == null) this.frame = this.schedule(() => { this.frame = null; this.pump(); });
    return ticket.promise;
  }
  pump() {
    const epoch = this.epoch;
    while (!this.barrier && this.active < this.limit && this.queue.length) {
      const barrier = !["mouse", "key", "text"].includes(this.queue[0].action);
      if (barrier && this.active) return;
      const item = this.queue.shift(); this.active++;
      if (barrier) this.barrier = true;
      // Invoke synchronously so ordered WebSocket writes cannot overtake keys.
      let result; try { result = this.request(item.action, item.params); } catch (error) { result = Promise.reject(error); }
      Promise.resolve(result).then(value => {
        if (epoch !== this.epoch) throw Error("Browser connection changed");
        for (const ticket of item.tickets) ticket.resolve(value);
      }).catch(error => { for (const ticket of item.tickets) ticket.reject(error); }).finally(() => {
        if (epoch === this.epoch) { this.active--; if (barrier) this.barrier = false; this.pump(); }
      });
    }
  }
  reset() {
    this.epoch++; this.active = 0; this.barrier = false;
    if (this.frame != null) this.cancel(this.frame); this.frame = null;
    for (const item of this.queue.splice(0)) for (const ticket of item.tickets) ticket.reject(Error("Browser connection changed"));
  }
}
