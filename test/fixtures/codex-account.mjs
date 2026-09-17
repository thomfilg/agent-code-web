// Controller-bound native auth fixture. Never reaches OpenAI or authorizes a
// real account. Tests explicitly resolve/reject the consent ceremony.
export function codexAccountFixture() {
  const clients = [];
  const factory = () => {
    const client = {
      auth: null, identity: "workspace-fixture", subject: "user-fixture", email: "codex@example.test", closed: false, snapshotCalls: [],
      rpc: { request: async method => {
        if (method !== "model/list") throw new Error("Unexpected fixture RPC");
        return { data: [{ model: "fixture-gpt", displayName: "Fixture GPT", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }], nextCursor: null };
      } },
      async start(auth) { this.auth = auth; return this; },
      async login() {
        this.completed = new Promise((resolve, reject) => { this.approve = resolve; this.reject = reject; });
        return { verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-1234", completed: this.completed };
      },
      async snapshot(options = {}) {
        this.snapshotCalls.push(options);
        if (this.snapshotError) throw new Error("secret-native-output-never-publish");
        return { subject: this.subject, email: this.email, plan: "pro", auth: { auth_mode: "chatgpt", tokens: this.auth?.tokens || {
          id_token: "fixture-id-token", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", account_id: this.identity,
        } } };
      },
      async cancel() { this.cancelled = true; },
      async close() { this.closed = true; },
    };
    clients.push(client); return client;
  };
  return { factory, clients };
}
