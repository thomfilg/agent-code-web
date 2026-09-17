import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { ClaudeControlChannel } from "./claude-mcp.mjs";
import { terminateWorker } from "./worker-process.mjs";

const conflict = message => Object.assign(Error(message), { statusCode: 409 });
const visiblePath = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && path.posix.isAbsolute(value)
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?!\u0020)\p{Zs}/u.test(value);
const unavailable = "Cannot verify native workspace trust. Inspect again and check this worker's Claude version; no automatic consent was granted.";

// A separate, control-only CLI. Never send a user turn, move the conversation's
// owner, write its trust latch ourselves, or grant startup tool requests.
export function claudeTrustProbe(child, signal, timeoutMs = 15000) {
  const control = new ClaudeControlChannel(child, timeoutMs), lines = readline.createInterface({ input: child.stdout });
  let bytes = 0, ended = false, closing;
  const close = () => {
    if (closing) return closing;
    ended = true; control.close(); lines.close(); signal?.removeEventListener("abort", abort);
    closing = terminateWorker(child); return closing;
  };
  const abort = () => { void close(); };
  child.on("error", abort); child.once("close", abort);
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) abort(); });
  child.stderr.resume();
  lines.on("line", line => {
    if (ended) return;
    let event; try { event = JSON.parse(line); } catch { abort(); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { abort(); return; }
    if (event.type === "control_request") {
      // No prompt was sent. An unexpected tool or question cannot confer trust.
      abort(); return;
    }
    control.accept(event);
  });
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  return {
    async request(subtype, fields = {}) {
      if (ended) throw conflict(unavailable);
      try { return await control.request(subtype, fields); }
      catch { throw conflict(unavailable); }
    },
    close,
  };
}

export class ClaudeWorkspaceTrust {
  constructor({ workspace, open, now = Date.now, ttlMs = 300000 }) {
    Object.assign(this, { workspace, open, now, ttlMs });
    this.review = null; this.pending = null; this.closed = false;
  }

  #snapshot(value) {
    if (value?.status === "rejected") {
      const reasons = { blocked_by_rule: "Native Cd permission rules block workspace trust inspection.", busy: "The native consent session is busy. Inspect again.",
        not_found: "The workspace no longer exists.", not_a_directory: "The workspace is not a directory.", unsafe_path: "The workspace path cannot be displayed safely for consent." };
      throw conflict(reasons[value.reason] || unavailable);
    }
    if (value?.status === "ok" && value.cwd === this.workspace && value.changed === true && value.transcript_relocated === true) return { state: "trusted", directory: this.workspace, trustRoot: null };
    if (value?.status !== "needs_trust" || value.directory !== this.workspace || !visiblePath(value.directory)
      || value.trust_root != null && (!visiblePath(value.trust_root) || value.trust_root !== this.workspace)) {
      throw conflict("Cannot limit this native trust grant to the chat's exact workspace. Linked paths and trust roots outside it must be reviewed separately.");
    }
    return { state: "needs_trust", directory: value.directory, trustRoot: value.trust_root || null };
  }

  async run(action, input, binding, guard = () => {}) {
    if (this.closed || this.pending) throw conflict("The workspace trust session stopped or another inspection is running. Reopen it.");
    if (!["inspect", "confirm"].includes(action)) throw Error("Choose a workspace trust action");
    if (!visiblePath(this.workspace) || this.workspace === "/" || path.posix.normalize(this.workspace) !== this.workspace) throw conflict("The workspace path cannot be safely reviewed for trust.");
    const review = this.review;
    if (action === "confirm" && (!review || input?.confirm !== true || input.reviewId !== review.id || review.binding !== binding || review.expiresAt <= this.now())) {
      throw conflict("Workspace trust confirmation is stale. Inspect the current workspace and confirm again.");
    }
    const controller = new AbortController(), done = Promise.withResolvers(); this.pending = controller; this.done = done.promise;
    const check = async () => { controller.signal.throwIfAborted(); await guard(); controller.signal.throwIfAborted(); };
    let probe, attested = false;
    try {
      await check();
      try { probe = await this.open(controller.signal); }
      catch { throw conflict("Cannot safely open this chat's private Claude trust session. Check the private profile and inspect again; no consent was granted."); }
      await check();
      await probe.request("initialize"); await check();
      const current = this.#snapshot(await probe.request("set_cwd", { path: this.workspace })); await check();
      if (action === "inspect") {
        this.review = current.state === "needs_trust" ? { ...current, id: randomUUID(), binding, expiresAt: this.now() + this.ttlMs } : null;
        return { ...current, reviewId: this.review?.id || null, expiresAt: this.review?.expiresAt || null };
      }
      this.review = null;
      if (current.state === "trusted") return { ...current, reviewId: null, expiresAt: null };
      if (current.directory !== review.directory || current.trustRoot !== review.trustRoot) throw conflict("The native trust scope changed. Inspect it and confirm again.");
      await check();
      if (review.expiresAt <= this.now()) throw conflict("Workspace trust confirmation expired. Inspect and confirm again.");
      attested = true;
      const result = this.#snapshot(await probe.request("set_cwd", { path: this.workspace, trust_accepted: true, trusted_directory: review.directory }));
      await check();
      if (result.state !== "trusted") throw conflict(unavailable);
      return { ...result, reviewId: null, expiresAt: null };
    } catch (error) {
      this.review = null;
      if (attested) throw conflict("Native workspace trust may already have been saved, but its outcome could not be verified. Inspect again before retrying; no automatic retry or worker restart was performed.");
      throw error;
    } finally {
      try { await probe?.close(); }
      finally { if (this.pending === controller) this.pending = null; done.resolve(); }
    }
  }

  close() { this.closed = true; this.review = null; this.pending?.abort(); return this.done; }
}
