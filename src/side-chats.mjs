import { clampText, errorMessage, newId, nowIso } from "./utils.mjs";
import { publicRequest, responseFor } from "./agent-requests.mjs";
import { extractResponse, responsePrompt, ResponseStream } from "./response-protocol.mjs";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

// Temporary controller-owned state, never main-chat messages or a copied chat
// directory. A native ephemeral fork shares its parent's worker and workspace.
export class SideChats {
  #entries = new Map();
  #revision = 0;
  #epoch = newId("side_epoch");
  constructor({ fork, prepare, publish, activity, authorize = () => {} }) { Object.assign(this, { fork, prepare, publish, activity, authorize }); }
  busy(chatId) { const side = this.#entries.get(chatId); return Boolean(side && (side.busy || side.status === "starting")); }
  get(chatId) {
    const side = this.#entries.get(chatId);
    return { epoch: this.#epoch, revision: this.#revision, side: side && !side.closed ? {
      id: side.id, status: side.status, messages: side.messages, stream: side.stream || "", error: side.error,
      omittedMessages: side.omittedMessages, tools: [...side.tools.values()], pendingRequest: [...side.requests.values()][0] || null,
    } : null };
  }
  #emit(side) {
    if (this.#entries.get(side.chatId) !== side) return;
    clearTimeout(side.timer); side.timer = null;
    this.#revision++; this.publish(side.chatId, this.get(side.chatId));
  }
  #later(side) { side.timer ||= setTimeout(() => this.#emit(side), 50); }
  #require(chatId, id) {
    const side = this.#entries.get(chatId);
    if (!side || side.closed || side.id !== id) throw conflict("This side chat has closed; open a new side chat");
    return side;
  }
  #append(side, role, text) {
    side.messages.push({ id: newId("msg"), role, text: String(text).slice(0, 100000), createdAt: nowIso() });
    // Rendering is bounded; the native fork still has its earlier context.
    while (side.messages.length > 100 || side.messages.reduce((n, m) => n + m.text.length, 0) > 1000000) { side.messages.shift(); side.omittedMessages++; }
  }
  async open(chatId) {
    this.authorize(chatId);
    let side = this.#entries.get(chatId);
    if (side?.closed) throw conflict("Wait for the previous side chat to close");
    if (!side) {
      side = { id: newId("side"), chatId, status: "starting", messages: [], requests: new Map(), tools: new Map(), stream: "", error: null, omittedMessages: 0 };
      this.#entries.set(chatId, side); this.#emit(side);
      side.opening = this.#open(side);
    }
    await side.opening;
    this.#require(chatId, side.id);
    return this.get(chatId);
  }
  async #open(side) {
    try {
      side.adapter = await this.fork(side.chatId, {
        onEvent: event => {
          if (side.closed) return;
          if (event.type === "assistant_delta") side.filter?.delta(event.delta || "");
          if (event.type === "request_resolved") { side.requests.delete(event.requestId); this.#emit(side); }
          if (event.type === "tool") { side.tools.set(event.itemId, event); if (side.tools.size > 30) side.tools.delete(side.tools.keys().next().value); this.#later(side); }
          if (event.type === "notice") { this.#append(side, "system", event.text || ""); this.#emit(side); }
        },
        onRequest: request => { if (!side.closed) { side.requests.set(request.requestId, publicRequest(request)); this.#emit(side); } },
        onFatal: error => { if (!side.closed) { side.error = errorMessage(error); side.status = "error"; this.#emit(side); } },
      });
      if (side.closed) return; // close() owns cleanup, including delayed forks.
      side.status = "idle"; this.#emit(side);
    } catch (error) {
      if (!side.closed) { this.#entries.delete(side.chatId); this.#revision++; this.publish(side.chatId, this.get(side.chatId)); }
      throw error;
    } finally { await this.activity(side.chatId); }
  }
  async send(chatId, id, input) {
    this.authorize(chatId);
    const side = this.#require(chatId, id);
    if (side.busy || side.status === "starting") throw conflict("Wait for the current side reply or stop it first");
    const text = clampText(input.text, 100000, "side message");
    if (/^\/[\w:-]+(?:\s|$)/.test(text)) throw new Error("Run slash commands in the main composer; the side chat accepts questions and follow-up text");
    side.busy = true; side.status = "running"; side.error = null; side.interrupted = false;
    this.#emit(side);
    try {
      await this.activity(chatId);
      const prepared = await this.prepare(chatId, text, input.attachments || [], side.messages.length === 0);
      this.#require(chatId, id);
      this.authorize(chatId);
      if (side.interrupted) throw conflict("Side message cancelled before it started");
      this.#append(side, "user", text); side.tools.clear(); side.stream = "";
      side.filter = new ResponseStream(event => { side.stream = (side.stream + event.delta).slice(0, 100000); this.#later(side); }, false);
      side.completion = this.#run(side, prepared).catch(error => {
        if (!side.closed) { side.error = errorMessage(error); this.#emit(side); }
      });
      this.#emit(side);
      return this.get(chatId);
    } catch (error) { side.busy = false; side.status = "idle"; side.error = errorMessage(error); this.#emit(side); await this.activity(chatId); throw error; }
  }
  async #run(side, { prompt, settings }) {
    try {
      const result = await side.adapter.send(responsePrompt(prompt, false), settings);
      side.filter.flush();
      if (!side.closed) this.#append(side, "assistant", extractResponse(result.text || side.stream, false).text);
    } catch (error) {
      if (!side.closed) {
        if (side.stream) this.#append(side, "assistant", side.stream);
        if (side.interrupted) this.#append(side, "system", "Side reply stopped."); else side.error = errorMessage(error);
      }
    } finally {
      side.filter = null; side.stream = ""; side.requests.clear(); side.busy = false; side.status = "idle";
      this.#emit(side); await this.activity(side.chatId);
    }
  }
  async interrupt(chatId, id) {
    const side = this.#require(chatId, id); side.interrupted = true;
    await side.adapter?.interrupt(); await side.completion;
    return this.get(chatId);
  }
  async respond(chatId, id, requestId, input) {
    this.authorize(chatId);
    const side = this.#require(chatId, id), request = side.requests.get(requestId);
    if (!request) throw conflict("This side request is no longer active");
    await side.adapter.respond(requestId, responseFor(request, input));
    side.requests.delete(requestId); this.#emit(side);
    return this.get(chatId);
  }
  async close(chatId, id = null) {
    const side = id ? this.#require(chatId, id) : this.#entries.get(chatId);
    if (!side) return this.get(chatId);
    if (side.closing) { await side.closing; return this.get(chatId); }
    side.closed = true; this.#emit(side);
    side.closing = (async () => {
      await side.opening.catch(() => {});
      await side.adapter?.stop(); await side.completion;
    })().finally(async () => {
      clearTimeout(side.timer);
      if (this.#entries.get(chatId) === side) this.#entries.delete(chatId);
      this.#revision++; this.publish(chatId, this.get(chatId));
      await this.activity(chatId);
    });
    await side.closing; return this.get(chatId);
  }
}
