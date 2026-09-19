import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

for (const stream of ["sidebar", "chat"]) {
  for (const pendingStep of ["session", "resources"]) {
    test(`shutdown rejects ${stream} SSE already waiting for ${pendingStep}`, { timeout: 5000 }, async t => {
      const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root) });
      const { url } = await app.start();
      t.after(() => app.stop());
      const chat = stream === "chat" ? await app.manager.createChat({ agent: "mock", title: "Shutdown fixture" }) : null;
      const endpoint = chat ? `/api/chats/${chat.id}/events` : "/api/sidebar/events";
      const service = pendingStep === "session" ? app.browserUsers : app.resources;
      const method = pendingStep === "session" ? "session" : "forOwner";
      const original = service[method].bind(service);
      let release, arrived;
      const gate = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { arrived = resolve; });
      service[method] = async (...args) => { arrived(); await gate; return original(...args); };
      const abort = new AbortController();
      const request = fetch(`${url}${endpoint}`, { signal: abort.signal });
      try {
        await entered;
        const stopped = app.stop();
        assert.equal(app.stop(), stopped, "shutdown is idempotent");
        release();
        const response = await request;
        try {
          assert.equal(response.status, 503, "late request must not reopen an event stream");
          assert.equal(response.headers.get("connection"), "close");
          assert.deepEqual(await response.json(), { error: "Relay is restarting" });
        } finally { await response.body?.cancel().catch(() => {}); }
        await stopped;
        if (chat) {
          assert.equal(app.store.get(chat.id).title, "Shutdown fixture");
          assert.deepEqual(app.store.get(chat.id).messages, []);
        }
      } finally { release(); abort.abort(); await request.catch(() => {}); }
    });
  }
}
