import { randomUUID } from "node:crypto";

const inactive = () => Object.assign(Error("Claude request is no longer active"), { statusCode: 409 });
const object = value => value && typeof value === "object" && !Array.isArray(value);

// The raw native input stays controller-side. The browser approves only an
// opaque, live request ID; it cannot replace arguments or widen permissions.
export class ClaudeRequests {
  constructor(child, hooks, cwd) {
    this.child = child; this.hooks = hooks; this.cwd = cwd;
    this.requests = new Map(); this.closed = false; this.displayed = null;
    child.once("close", () => this.close());
  }

  accept(event) {
    if (event.type === "control_cancel_request") {
      const entry = this.requests.get(event.request_id);
      if (entry) this.remove(entry);
      return true;
    }
    if (event.type !== "control_request") return false;
    if (this.closed) return true;
    const native = event.request, id = event.request_id;
    if (typeof id !== "string" || !id || this.requests.has(id)) return true;
    if (native?.subtype !== "can_use_tool" || typeof native.tool_name !== "string" || !object(native.input)) {
      void this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: "This native request is not supported by Relay. No permission was granted." } }).catch(() => {});
      return true;
    }
    const input = structuredClone(native.input);
    const requestId = `claude_request_${randomUUID()}`;
    const entry = { id, requestId, input, tool: native.tool_name };
    if (this.suspended) {
      void this.reply(entry, { behavior: "deny", message: "The conversation was interrupted; this request is no longer authorized." }).catch(() => {});
      return true;
    }
    const questions = native.tool_name === "AskUserQuestion" ? this.questions(input) : null;
    if (native.tool_name === "AskUserQuestion" && !questions) {
      void this.reply(entry, { behavior: "deny", message: "The question format could not be safely displayed. Ask again with valid questions." }).catch(() => {});
      return true;
    }
    entry.questions = questions;
    entry.public = { requestId, method: questions ? "claude/tool/requestUserInput" : "claude/tool/requestApproval", params: {
      reason: questions ? "Claude needs your answers" : `Claude requests permission to use ${native.tool_name}${native.description ? `: ${native.description}` : ""}`,
      command: questions ? null : JSON.stringify(input, null, 2), cwd: this.cwd,
      availableDecisions: ["accept", "decline"], questions,
    } };
    this.requests.set(id, entry);
    this.publish();
    return true;
  }

  questions(input) {
    if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4) return null;
    const seen = new Set();
    for (const question of input.questions) {
      if (!object(question) || typeof question.question !== "string" || !question.question || question.question.length > 10000 || seen.has(question.question)
        || !Array.isArray(question.options) || question.options.length > 8
        || question.options.some(option => !object(option) || typeof option.label !== "string" || !option.label || option.label.length > 10000 || option.description !== undefined && typeof option.description !== "string")) return null;
      seen.add(question.question);
    }
    return input.questions.map((question, index) => ({ id: `question_${index + 1}`, question: question.question,
      header: typeof question.header === "string" ? question.header : "Answer", multiSelect: question.multiSelect === true,
      options: question.options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })) }));
  }

  publish() {
    const entry = this.requests.values().next().value;
    if (!entry || this.displayed === entry.requestId || this.closed) return;
    this.displayed = entry.requestId;
    // Hooks are serialized by RuntimeManager, including replacement of the
    // visible request before an older HTTP response is allowed to clear it.
    entry.published = Promise.resolve().then(() => {
      if (!this.closed && this.requests.get(entry.id) === entry && this.displayed === entry.requestId) return this.hooks.onRequest(entry.public);
    }).catch(() => {
      void this.reply(entry, { behavior: "deny", message: "Relay could not display the approval request. No permission was granted." }).catch(() => {});
      this.remove(entry);
    });
  }

  remove(entry) {
    this.requests.delete(entry.id);
    if (this.displayed === entry.requestId) {
      this.displayed = null;
      this.hooks.onEvent?.({ type: "request_resolved", requestId: entry.requestId });
    }
    this.publish();
  }

  async respond(requestId, payload) {
    const entry = [...this.requests.values()].find(request => request.requestId === requestId);
    if (this.closed || !entry || this.displayed !== requestId || entry.responding) throw inactive();
    let result;
    if (entry.questions) {
      if (!object(payload.answers)) throw Error("Answers object required");
      const questions = new Map(entry.questions.map((question, index) => [question.id, { ...question, original: entry.input.questions[index].question }]));
      const answers = Object.fromEntries(Object.entries(payload.answers).map(([id, answer]) => {
        const question = questions.get(id), values = answer?.answers;
        if (!question || !Array.isArray(values) || values.length > (question.multiSelect ? 32 : 1) || values.some(value => typeof value !== "string" || value.length > 10000)) throw Error("Answer must match a requested question and contain text");
        return [question.original, values.join(", ")];
      }));
      result = Object.keys(answers).length ? { behavior: "allow", updatedInput: { ...entry.input, answers } }
        : { behavior: "deny", message: "The user skipped these questions. Do not invent answers." };
    } else {
      if (!["accept", "decline", "cancel"].includes(payload.decision)) throw Error("Claude supports approval once or denial, not a session-wide grant");
      result = payload.decision === "accept" ? { behavior: "allow", updatedInput: entry.input }
        : { behavior: "deny", message: "The user denied this tool action." };
    }
    entry.responding = true;
    try {
      await this.reply(entry, result);
      this.remove(entry);
      await this.requests.values().next().value?.published;
    } catch {
      // Delivery may be ambiguous. Never automatically repeat an approval.
      this.remove(entry);
      throw Error("The Claude response could not be confirmed. Inspect the task before retrying; no permission was replayed.");
    }
  }

  reply(entry, result) {
    return this.write({ type: "control_response", response: { subtype: "success", request_id: entry.id, response: result } });
  }

  write(packet) {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(inactive());
    return new Promise((resolve, reject) => this.child.stdin.write(`${JSON.stringify(packet)}\n`, error => error ? reject(inactive()) : resolve()));
  }

  cancel() {
    this.suspended = true;
    for (const entry of this.requests.values()) {
      void this.reply(entry, { behavior: "deny", message: "The conversation was interrupted; this request is no longer authorized." }).catch(() => {});
    }
    this.clear();
  }

  clear() {
    this.requests.clear();
    if (this.displayed) this.hooks.onEvent?.({ type: "request_resolved", requestId: this.displayed });
    this.displayed = null;
  }

  close() { this.closed = true; this.clear(); }
  resume() { if (!this.closed) this.suspended = false; }
}
