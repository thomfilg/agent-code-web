// Keep at most one frame being written and one newest waiting frame per viewer.
// Unlike dropping frames above a byte threshold, this also delivers the final
// idle refinement after a slow socket drains (even if the page never repaints).
const senders = new WeakMap();
export function sendBrowserFrame(socket, value) {
  if (socket.readyState !== 1) return;
  let state = senders.get(socket);
  if (!state) {
    state = { pending: null, writing: false }; senders.set(socket, state);
    socket.once("close", () => { state.pending = null; });
    state.flush = () => {
      if (state.writing || !state.pending || socket.readyState !== 1) return;
      const frame = state.pending; state.pending = null; state.writing = true;
      socket.send(JSON.stringify({ event: "frame", value: frame }), error => {
        state.writing = false;
        if (error) { state.pending = null; return; }
        state.flush();
      });
    };
  }
  state.pending = value; state.flush();
}
