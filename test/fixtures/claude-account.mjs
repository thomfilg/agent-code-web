export const claudeAuthFixture = (now = Date.now()) => ({ claudeAiOauth: { accessToken: "fixture-claude-access-value", refreshToken: "fixture-claude-refresh-value", expiresAt: now + 3600000, scopes: ["user:profile", "user:inference"], subscriptionType: "max", rateLimitTier: "fixture" } });
export const claudeModelsFixture = [{ value: "default", displayName: "Claude account default", supportedEffortLevels: ["low", "medium", "high", "max"] }, { value: "sonnet", displayName: "Sonnet", supportedEffortLevels: ["low", "medium", "high"] }];
export function claudeAccountFixture() {
  const clients = [];
  const factory = () => {
    const completed = Promise.withResolvers(); completed.promise.catch(() => {});
    const client = { closed: false, organization: "fixture-claude-company", subject: "fixture-claude-user", auth: claudeAuthFixture(),
      async start(auth) { if (auth) this.auth = auth; return this; },
      async login() { return { verificationUrl: "https://claude.com/cai/oauth/authorize?state=fixture-state", inputRequired: true, completed: completed.promise }; },
      async submitCode(code) { if (code !== "fixture-code#fixture-state") throw Error("secret-invalid-code"); completed.resolve(); },
      async snapshot() { if (this.snapshotError) throw Error("secret-provider-error"); return { auth: this.auth, subject: this.subject, accountIdentity: this.organization, email: "claude@example.test", plan: "max" }; },
      async models() { return claudeModelsFixture; },
      async cancel() { completed.reject(Error("cancelled")); }, async close() { this.closed = true; },
      approve: () => completed.resolve(), reject: completed.reject,
    }; clients.push(client); return client;
  }; return { clients, factory };
}
