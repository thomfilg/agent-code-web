// A credential can span arbitrarily many native deltas. Never emit a suffix
// which could still become a selected account's token in the next chunk. The
// shared Set is deliberately live: refresh adds the new token, retaining old
// tokens for delayed native output. Only the ambiguous suffix is buffered.
export class SecretTextStream {
  #pending = "";
  #finished = false;
  #skippingToken = false;

  constructor(secrets, { tokenPrefix = null } = {}) { this.secrets = secrets; this.tokenPrefix = tokenPrefix; }

  push(value) {
    if (this.#finished) return "";
    const input = this.#pending + value;
    this.#pending = "";
    const secrets = [...this.secrets].filter(value => typeof value === "string" && value).sort((a, b) => b.length - a.length);
    const byInitial = new Map();
    for (const secret of secrets) {
      if (!byInitial.has(secret[0])) byInitial.set(secret[0], []);
      byInitial.get(secret[0]).push(secret);
    }
    let output = "", index = 0;
    while (index < input.length) {
      if (this.#skippingToken) {
        while (index < input.length && /[A-Za-z0-9_-]/.test(input[index])) index++;
        if (index === input.length) break;
        this.#skippingToken = false;
      }
      const candidates = byInitial.get(input[index]);
      // Prefer waiting for a longer credential over publishing a shorter
      // match followed by the longer one's confidential suffix.
      if (candidates?.some(secret => secret.length > input.length - index && secret.startsWith(input.slice(index)))) {
        this.#pending = input.slice(index); break;
      }
      const match = candidates?.find(secret => input.startsWith(secret, index));
      if (match) {
        output += "[redacted]"; index += match.length;
        if (this.tokenPrefix && match.startsWith(this.tokenPrefix) && /^[A-Za-z0-9_-]{8,}$/.test(match.slice(this.tokenPrefix.length))) this.#skippingToken = true;
        continue;
      }
      // Preserve the existing provider-shaped token redaction even for an
      // older token not in this process's Set. Once recognized, discard its
      // arbitrarily long body instead of accumulating an unbounded string.
      if (this.tokenPrefix?.[0] === input[index]) {
        const rest = input.slice(index);
        if (rest.startsWith(this.tokenPrefix)) {
          let end = index + this.tokenPrefix.length;
          while (end < input.length && /[A-Za-z0-9_-]/.test(input[end])) end++;
          if (end - index - this.tokenPrefix.length >= 8) {
            output += "[redacted]"; index = end; this.#skippingToken = end === input.length; continue;
          }
          if (end === input.length) { this.#pending = rest; break; }
        } else if (this.tokenPrefix.startsWith(rest)) { this.#pending = rest; break; }
      }
      output += input[index++];
    }
    return output;
  }

  finish() {
    if (this.#finished) return "";
    this.#finished = true;
    return this.boundary();
  }

  boundary() {
    // Even on success, do not release a partial credential at a turn/process
    // boundary. Error, interrupt and shutdown use the same fail-closed rule.
    const tail = this.#pending ? "[redacted]" : "";
    this.#pending = ""; this.#skippingToken = false;
    return tail;
  }
}
