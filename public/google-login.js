const $ = selector => document.querySelector(selector);
const errors = {
  AccessDenied: "This Google account is not allowed to use this Relay. Ask the administrator to add your email.",
  OAuthCallbackError: "Google sign-in could not be completed. Please try again.",
  CallbackRouteError: "Google sign-in could not be completed. Please try again.",
  Configuration: "Google sign-in needs configuration on this Relay server.",
};

export class GoogleLogin {
  constructor({ api, beforeSignOut = () => true }) {
    this.api = api; this.beforeSignOut = beforeSignOut;
    $("#google-sign-in").onclick = () => this.action("signin/google");
    $("#relay-sign-out").onclick = () => this.action("signout");
    $("#relay-account-button").onclick = () => $("#relay-account-dialog").showModal();
    $("#relay-account-close").onclick = () => $("#relay-account-dialog").close();
    $("#login-dialog").addEventListener("cancel", event => { if (this.google && !this.user) event.preventDefault(); });
    window.addEventListener("storage", event => { if (event.key === "relay-auth-change") void this.checkIdentity(); });
    window.addEventListener("pageshow", event => { if (event.persisted && this.google) location.reload(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void this.checkIdentity(); });
    window.addEventListener("relay-auth-required", () => { void this.checkIdentity(); });
  }
  render(auth) {
    this.google = auth.method === "google"; this.user = auth.user;
    $("#login-form").hidden = this.google;
    $("#google-login-card").hidden = !this.google;
    $("#relay-account-button").hidden = !this.google || !this.user;
    if (!this.google) return;
    try { localStorage.setItem("relay-auth-change", JSON.stringify({ userId: this.user?.id || null, at: Date.now() })); } catch { /* Storage may be disabled. Server-side checks still apply. */ }
    this.info = auth.google;
    $("#relay-account-button").textContent = (this.user?.name || this.user?.email || "?").slice(0, 1).toUpperCase();
    $("#relay-account-button").title = this.user?.email || "Your Relay account";
    $("#sidebar-user-name").textContent = this.user?.name || this.user?.email || "Your workspace";
    $("#relay-account-email").textContent = this.user?.email || "";
    $("#google-sign-in").disabled = !auth.google.configured;
    $("#google-setup").hidden = auth.google.configured;
    $("#google-missing").textContent = auth.google.missing.join(", ");
    $("#google-callback").textContent = auth.google.callbackUrl || "Set AGENT_WEB_PUBLIC_URL to this Relay's public origin.";
    $("#google-sign-in-error").textContent = errors[new URLSearchParams(location.search).get("error")] || (location.search.includes("error=") ? "Sign-in was not completed. Please try again." : "");
    const wrongOrigin = auth.google.origin && auth.google.origin !== location.origin;
    $("#google-canonical").hidden = !wrongOrigin;
    if (wrongOrigin) {
      $("#google-canonical").href = new URL(location.hash || "/", auth.google.origin).href;
      $("#google-sign-in").disabled = true;
    }
  }
  async checkIdentity() {
    if (!this.google || this.checking) return;
    this.checking = true;
    try {
      const result = await this.api("/api/auth");
      if (result.user?.id !== this.user?.id) location.reload();
    } catch { /* An offline tab must not pretend to have signed out. */ }
    finally { this.checking = false; }
  }
  async action(action) {
    if (this.busy || action === "signout" && !this.beforeSignOut()) return;
    this.busy = true;
    const button = $(action === "signout" ? "#relay-sign-out" : "#google-sign-in");
    const error = $(action === "signout" ? "#relay-account-error" : "#google-sign-in-error");
    button.disabled = true; error.textContent = "";
    try {
      const { csrfToken } = await this.api("/api/auth/csrf");
      if (typeof csrfToken !== "string" || !csrfToken) throw new Error("Could not establish a secure sign-in. Reload and try again.");
      const callback = new URL(action === "signout" ? location.origin + "/" : location.href);
      for (const key of ["error", "code", "state"]) callback.searchParams.delete(key);
      const result = await this.api(`/api/auth/${action}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" }, body: new URLSearchParams({ csrfToken, callbackUrl: callback.href }).toString() });
      if (typeof result.url !== "string" || !result.url) throw new Error("The server did not return a sign-in destination. Please try again.");
      const url = new URL(result.url, location.origin);
      if (url.username || url.password || url.origin !== location.origin && (action !== "signin/google" || url.protocol !== "https:" || url.hostname !== "accounts.google.com")) throw new Error("The server returned an unexpected sign-in destination.");
      location.assign(url.href);
    } catch (cause) { error.textContent = cause.message; }
    finally { this.busy = false; button.disabled = false; }
  }
}
