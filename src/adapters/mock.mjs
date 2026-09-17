export class MockAdapter {
  constructor({ chat, hooks, chunkDelayMs = 8 }) {
    this.chat = chat;
    this.hooks = hooks;
    this.chunkDelayMs = chunkDelayMs;
    this.running = false;
    this.stopped = true;
  }

  async start() {
    this.stopped = false;
  }

  async send(text) {
    if (this.stopped) await this.start();
    if (this.running) throw new Error("A mock turn is already running");
    this.running = true;
    this.hooks.onEvent?.({ type: "tool", tool: "workspace", state: "running", itemId: "mock_tool", title: "Inspect workspace", output: "" });
    const response = `POC worker received: “${text}”\n\nThis response is streamed from an independent ${this.chat.id} runtime. The runtime will stop after the configured idle window and restart on your next message.`;
    let assembled = "";
    try {
      for (const chunk of response.match(/.{1,12}/gs) || []) {
        if (this.stopped) throw new Error("Mock worker stopped");
        await new Promise((resolve) => setTimeout(resolve, this.chunkDelayMs));
        assembled += chunk;
        this.hooks.onEvent?.({ type: "assistant_delta", delta: chunk });
      }
      this.hooks.onEvent?.({ type: "tool", tool: "workspace", state: "completed", itemId: "mock_tool", title: "Inspect workspace", output: "Mock inspection complete" });
      return { text: assembled, status: "completed" };
    } finally {
      this.running = false;
    }
  }

  async respond() {}

  async interrupt() { this.stopped = true; }

  async stop() {
    this.stopped = true;
    this.running = false;
  }
}
