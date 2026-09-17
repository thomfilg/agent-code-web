const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
const button = (label, action) => { const item = node("button", label); item.type = "button"; item.addEventListener("click", action); return item; };
const types = { bug: "Bug", bad: "Poor result", good: "Good result", other: "Other feedback" };
const states = { prepared: "Reviewed — not sent", uploading: "Sending — do not repeat", sent: "Sent to OpenAI", uncertain: "Delivery uncertain — not repeated", cancelled: "Cancelled before sending" };
const resultMessage = item => item.state === "sent" ? `Codex confirmed the upload. Native session reference: ${item.reference}.`
  : item.state === "uploading" ? "The report is being sent. Refresh its status; do not submit it again."
    : item.state === "uncertain" ? "Delivery could not be confirmed. Some or all of the report may have reached OpenAI. It will not be sent again automatically."
      : "The report was cancelled before sending. Prepare a new review if you still want to send feedback.";

export class NativeFeedbackControls {
  constructor({ state, api, controls, notify }) { Object.assign(this, { state, api, controls, notify }); }
  async open() {
    const chat = this.state.active;
    if (chat?.agent !== "codex") throw new Error("Native feedback requires Codex");
    const status = node("p", "Loading saved report status…", "muted"); status.setAttribute("role", "status");
    const type = node("select"); type.id = "native-feedback-type";
    for (const [value, label] of Object.entries(types)) { const option = node("option", label); option.value = value; type.append(option); }
    const typeLabel = node("label", "Feedback type"); typeLabel.htmlFor = type.id;
    const reason = node("textarea"); reason.id = "native-feedback-reason"; reason.rows = 5; reason.maxLength = 6000;
    const reasonLabel = node("label", "Your report"); reasonLabel.htmlFor = reason.id;
    reason.placeholder = "Describe the issue or result. Do not include passwords, tokens or private data you do not want to share.";
    const logs = node("input"); logs.type = "checkbox"; logs.id = "native-feedback-logs";
    const logLabel = node("label", undefined, "native-feedback-checkbox"); logLabel.append(logs, node("span", "Include native diagnostic logs and conversation history"));
    const policyText = node("p", "Check feedback options to connect this chat's worker and verify its policy. This may wake the worker but does not send a report or start an agent turn.", "muted");
    const checkPolicy = button("Check feedback options", () => void connect());
    const reviewButton = button("Review report", () => void prepare());
    const newReport = button("Write another report", () => { submissionLocked = false; review = null; reason.value = ""; logs.checked = false; status.textContent = "Write a new report, then review it before sending."; render(); reason.focus(); }); newReport.hidden = true;
    const form = node("section", undefined, "native-app-card native-feedback-form");
    form.append(typeLabel, type, reasonLabel, reason, logLabel,
      node("p", "With logs enabled, Codex may upload conversation/code, tool activity, file paths, native logs and diagnostic/account metadata from this worker. Contents are collected at send time and are not previewed or redacted by Relay. Never include logs you are not authorized to share.", "muted"), policyText, checkPolicy, reviewButton, newReport);
    const confirmation = node("section", undefined, "native-plugin-confirm native-feedback-confirm"); confirmation.hidden = true;
    const history = node("div", undefined, "native-feedback-history"), refresh = button("Refresh report status", () => void load());
    this.controls.dialog("Send feedback to OpenAI",
      node("p", "Opening this panel sends nothing. Your chat draft and attached files are not included. Even with logs off, Codex includes native session, version and diagnostic/authentication metadata with your report.", "muted"),
      status, form, confirmation, node("h3", "Recent reports for this session"), history, refresh);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && this.state.active?.id === chat.id && this.state.active.agent === "codex";
    let pending = false, policy = null, review = null, submissionLocked = false, reports = [];
    const render = () => {
      if (!current()) return;
      checkPolicy.disabled = pending; refresh.disabled = pending;
      type.disabled = reason.disabled = pending || submissionLocked;
      logs.disabled = pending || submissionLocked || !policy?.logsAllowed;
      reviewButton.disabled = pending || submissionLocked || !policy?.enabled || !reason.value.trim();
      newReport.hidden = !submissionLocked; newReport.disabled = pending;
      history.replaceChildren(...reports.map(item => {
        const row = node("p", `${states[item.state] || "Unknown status"} · ${types[item.classification] || "Feedback"} · ${item.includeLogs ? "With diagnostics" : "Logs off"} · ${new Date(item.createdAt).toLocaleString()}`);
        if (item.state === "uncertain") row.append(node("small", " Some or all data may already have reached OpenAI. There is no automatic retry.", "muted"));
        return row;
      }));
      if (!reports.length) history.append(node("p", "No retained reports for this native session.", "muted"));
      confirmation.hidden = !review; confirmation.replaceChildren();
      if (review) {
        confirmation.append(node("h3", "Confirm external submission"), node("p", `Recipient: OpenAI's Codex feedback service · ${types[review.classification]} · ${review.includeLogs ? "Native diagnostics and history included" : "No diagnostic files or conversation history"}`), node("pre", review.reason),
          node("p", "This sends the reviewed report to OpenAI, not to your agent. Native metadata is included. The review expires after five minutes or a worker/policy change."));
        const send = button("Send feedback to OpenAI", () => void submit()), cancel = button("Back to editing", () => { review = null; render(); reason.focus(); });
        send.disabled = pending || submissionLocked; cancel.disabled = pending; confirmation.append(send, cancel);
      }
    };
    for (const field of [type, reason, logs]) field.addEventListener("input", () => { review = null; render(); });
    const fail = (error, uncertain = false) => {
      const text = uncertain ? `${error.message} The upload outcome may be unknown. Refresh report status before creating another report; this submission will not be automatically repeated.` : error.message;
      if (current()) status.textContent = text; else this.notify?.(`${chat.title}: ${text}`);
    };
    const connect = async () => {
      if (!current() || pending) return;
      pending = true; review = null; status.textContent = "Checking native feedback policy…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/feedback/policy`, { method: "POST", body: "{}" });
        if (!current()) return;
        policy = result; if (!policy.logsAllowed) logs.checked = false;
        policyText.textContent = policy.logsReason || "Optional diagnostic logs are available for this private worker profile. Logs stay off unless you select them.";
        status.textContent = policy.enabled ? "Ready to review a report. Nothing has been sent." : "Feedback is disabled by native configuration or admin policy.";
      } catch (error) { policy = null; fail(error); }
      finally { pending = false; render(); }
    };
    const prepare = async () => {
      if (!current() || pending || submissionLocked || !policy?.enabled) return;
      pending = true; status.textContent = "Preparing the report for your review. Nothing is being sent to OpenAI…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/feedback/prepare`, { method: "POST", body: JSON.stringify({ classification: type.value, reason: reason.value, includeLogs: logs.checked }) });
        if (!current()) return;
        review = result; reports = [result, ...reports.filter(item => item.id !== result.id)]; status.textContent = "Review the report below. Only the final Send button uploads it.";
      } catch (error) { review = null; fail(error); }
      finally { pending = false; if (current()) { render(); confirmation.querySelector("button")?.focus(); } }
    };
    const submit = async () => {
      if (!current() || pending || submissionLocked || !review) return;
      const selected = review; pending = true; submissionLocked = true; status.textContent = "Sending the confirmed report…"; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/feedback/send`, { method: "POST", body: JSON.stringify({ id: selected.id, revision: selected.revision, threadId: selected.threadId, confirm: true }) });
        if (!current()) { this.notify?.(`${chat.title}: ${resultMessage(result)}`); return; }
        reports = [result, ...reports.filter(item => item.id !== result.id)]; status.textContent = resultMessage(result);
      } catch (error) { fail(error, true); }
      finally { pending = false; review = null; if (current()) { render(); refresh.focus(); } }
    };
    const load = async () => {
      if (!current() || pending) return;
      pending = true; render();
      try {
        const result = await this.api(`/api/chats/${chat.id}/feedback`);
        if (!current()) return;
        reports = result.reports; status.textContent = "Saved status refreshed. No report was sent and no worker was started.";
      } catch (error) { fail(error); }
      finally { pending = false; render(); }
    };
    render(); checkPolicy.focus(); await load(); return current();
  }
}
