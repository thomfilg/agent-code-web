// Claude may produce several main-agent messages in one print invocation
// (tool steps and native goal continuations). Keep their boundaries without
// copying subagent text, thinking blocks or duplicate complete-message events.
export class ClaudeTextStream {
  #current = null;
  #completed = new Set();
  #finalEvents = new Set();
  text = "";

  constructor(onDelta) { this.onDelta = onDelta; }

  #start(id = null) {
    this.#current = { id, text: "", blockText: "", streaming: false, complete: false, boundary: Boolean(this.text) };
  }

  #append(text) {
    if (!text) return;
    if (!this.#current) this.#start();
    const delta = (this.#current.boundary ? "\n\n" : "") + text;
    this.#current.boundary = false;
    this.#current.text += text;
    this.#current.blockText += text;
    this.text += delta;
    this.onDelta?.(delta);
  }

  accept(event) {
    if (event.parent_tool_use_id) return;
    if (event.type === "stream_event") {
      if (event.event?.type === "message_start") {
        const id = event.event.message?.id || null;
        if (!id || id !== this.#current?.id) this.#start(id);
        this.#current.streaming = true;
      } else if (event.event?.type === "content_block_start" && this.#current) this.#current.blockText = "";
      else if (event.event?.type === "content_block_delta" && [undefined, "text_delta"].includes(event.event.delta?.type) && typeof event.event.delta?.text === "string" && !this.#current?.complete && !this.#completed.has(this.#current?.id)) {
        if (!this.#current) this.#start();
        this.#current.streaming = true;
        this.#append(event.event.delta.text);
      } else if (event.event?.type === "message_stop" && this.#current) {
        this.#current.complete = true;
        if (this.#current.id) this.#completed.add(this.#current.id);
      }
      return;
    }
    if (event.type === "assistant") {
      const id = event.message?.id || null;
      const text = (event.message?.content || []).filter(block => block.type === "text").map(block => block.text || "").join("");
      if (!text) return;
      const key = event.uuid || (id ? `${id}\0${text}` : null);
      if (key && this.#finalEvents.has(key)) return;
      if (key) this.#finalEvents.add(key);
      if (!this.#current || id && this.#current.id && id !== this.#current.id) this.#start(id);
      if (!this.#current.id) this.#current.id = id;
      // The CLI emits an assistant event per content block, not necessarily per
      // whole message. Only message_stop closes streamed text. Non-streamed
      // blocks share their message ID but have distinct event UUIDs.
      if (!this.#current.streaming) this.#append(text);
      else if (text.startsWith(this.#current.text)) this.#append(text.slice(this.#current.text.length));
      else if (text.startsWith(this.#current.blockText)) this.#append(text.slice(this.#current.blockText.length));
    } else if (event.type === "result" && !event.is_error && (!event.subtype || event.subtype === "success") && !this.text && typeof event.result === "string") this.#append(event.result);
  }
}
