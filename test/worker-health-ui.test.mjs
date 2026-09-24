import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("machine health uses durable push and on-demand snapshots instead of browser polling", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("let healthChatId"), source.indexOf("function messageTime"));
  assert.match(section, /new EventSource\(`\/api\/chats\/\$\{chatId\}\/worker-events`/);
  assert.match(section, /new EventSource\("\/api\/system\/events"/);
  assert.match(section, /elements\.health\.addEventListener\("toggle"/);
  assert.doesNotMatch(section, /setInterval|healthTimer/, "the browser must not poll machine-health on a timer");
});
