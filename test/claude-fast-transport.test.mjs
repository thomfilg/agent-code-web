import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { observeClaudeFastRequest, observeClaudeFastResponse, claudeFastRejection } from "../src/claude-fast-transport.mjs";
import { claudeFastCredential } from "../src/claude-fast.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { testConfig, temporaryDirectory } from "./helpers.mjs";

async function inspect(raw, width) {
  const input = Buffer.from(raw), chunks = [];
  for (let index = 0; index < input.length; index += width) chunks.push(input.subarray(index, index + width));
  const observer = observeClaudeFastRequest(), hash = createHash("sha256");
  await pipeline(Readable.from(chunks), observer.stream, new Writable({ write(chunk, _, next) { hash.update(chunk); next(); } }));
  assert.equal(hash.digest("hex"), createHash("sha256").update(input).digest("hex"), "Forward every byte unchanged");
  return observer.isFast();
}

test("Fast request observation handles chunk/escape boundaries, nested input and duplicate fields without buffering prompts", async () => {
  const cases = [
    ['{"speed":"fast"}', true], ['{"messages":[{"speed":"fast","content":"\\\"speed\\\":\\\"fast\\\""}]}', false],
    [JSON.stringify({ speed: "fast", messages: [{ speed: "standard", text: 'ação🙂\\"' }] }), true],
    ['{"spe\\u0065d":"f\\u0061st"}', true], ['{"speed":"fast","speed":"standard"}', false],
    ['{"speed":"fast","speed":null}', false], ['{"speed":"fast","speed":{"speed":"fast"}}', false],
    ['{"speed":"fast","speed":100}', false], ['{"speed":"standard","speed":"fast"}', true],
    ['[{"speed":"fast"}]', false], ['1{"speed":"fast"}', false], ['{"speed":"fast"}other', false], ['{"speed":"fast"', false],
  ];
  for (const [raw, fast] of cases) for (const width of [1, 2, 17, 4096]) assert.equal(await inspect(raw, width), fast, `${raw} (${width})`);
  assert.equal(await inspect(JSON.stringify({ messages: [{ content: "private canary ".repeat(100000) }], speed: "fast" }), 4096), true);
  assert.equal(await inspect(JSON.stringify({ speed: "fast".repeat(10000) }), 4096), false);
});

test("rejection metadata matches native short-retry, cooldown and credit/organization distinctions", () => {
  const now = 1000, headers = value => new Headers(value);
  for (const value of ["0", "1", "19", "-1"]) assert.equal(claudeFastRejection(429, headers({ "retry-after": value }), "", now), null);
  for (const [value, delay] of [["20", 600000], ["600", 600000], ["900", 900000], ["bad", 1800000], ["9007199254740991", 1800000]]) {
    assert.deepEqual(claudeFastRejection(429, headers({ "retry-after": value }), "", now), { type: "cooldown", reason: "rate_limit", until: now + delay });
  }
  assert.deepEqual(claudeFastRejection(529, headers(), "", now), { type: "cooldown", reason: "overloaded", until: now + 1800000 });
  assert.deepEqual(claudeFastRejection(429, headers({ "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" })), { type: "credits", reason: "out_of_credits" });
  assert.deepEqual(claudeFastRejection(429, headers({ "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled" })), { type: "disabled", reason: "extra_usage_disabled" });
  assert.deepEqual(claudeFastRejection(400, headers(), '{"error":{"message":"Fast mode is not enabled for this organization"}}'), { type: "disabled", reason: "preference" });
  for (const body of ['{"error":{"message":"Unrelated validation error"}}', '<html>Fast mode is not enabled</html>', 'secret']) assert.equal(claudeFastRejection(400, headers(), body), null);
  assert.equal(claudeFastRejection(401, headers()), null); assert.equal(claudeFastRejection(200, headers()), null);
});

test("response observation preserves bytes, bounds error inspection and publishes no raw error/header data", async () => {
  for (const [body, fast, expected] of [
    ['{"error":{"message":"Fast mode is not enabled","private":"SECRET"}}', true, [{ type: "disabled", reason: "preference", credential: "binding" }]],
    ['{"error":{"message":"Fast mode is not enabled"}}', false, []],
    [JSON.stringify({ error: { message: "Fast mode is not enabled", private: "SECRET".repeat(1000) } }), true, []],
  ]) {
    const feedback = [], chunks = [];
    await pipeline(Readable.from([body]), observeClaudeFastResponse({ upstream: { status: 400, headers: new Headers() }, isFast: () => fast, notify: value => feedback.push(value), credential: "binding" }), new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } }));
    assert.equal(Buffer.concat(chunks).toString(), body); assert.deepEqual(feedback, expected); assert(!JSON.stringify(feedback).includes("SECRET"));
  }
});

test("capability observers are request/turn/provider scoped and reject late, revoked or foreign notifications", () => {
  const broker = new CapabilityBroker({ ttlMs: 10000 }), token = broker.issue({ chatId: "one", provider: "anthropic" }), other = broker.issue({ chatId: "two", provider: "anthropic" });
  const first = [], second = [], foreign = [];
  const detach = broker.observeProvider(token, "anthropic", value => first.push(value));
  broker.observeProvider(other, "anthropic", value => foreign.push(value));
  const oldRequest = broker.captureProviderObserver(token, "anthropic"); oldRequest("first"); detach();
  broker.observeProvider(token, "anthropic", value => second.push(value));
  oldRequest("late"); broker.captureProviderObserver(token, "openai")("wrong provider");
  const currentRequest = broker.captureProviderObserver(token, "anthropic"); currentRequest("current"); broker.revokeChat("one"); currentRequest("revoked");
  assert.deepEqual(first, ["first"]); assert.deepEqual(second, ["current"]); assert.deepEqual(foreign, []);
  assert.throws(() => broker.observeProvider(token, "anthropic", () => {}), /expired/);
  assert.throws(() => broker.observeProvider(other, "openai", () => {}), /expired/);
});

test("actual gateway response observations use the validated capability and real request speed, not nested content or headers", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), broker = new CapabilityBroker({ ttlMs: 10000 });
  const token = broker.issue({ chatId: "one", provider: "anthropic" }), other = broker.issue({ chatId: "two", provider: "anthropic" });
  const feedback = [], foreign = [], received = [];
  broker.observeProvider(token, "anthropic", value => feedback.push(value)); broker.observeProvider(other, "anthropic", value => foreign.push(value));
  const gateway = new ProviderGateway({ config, broker, now: () => 5000, fetchImpl: async (_, options) => {
    let raw = ""; for await (const chunk of options.body) raw += chunk;
    assert.equal(options.headers.get("x-api-key"), config.claude.providerKey); received.push(JSON.parse(raw));
    return new Response('{"error":{"message":"Controlled rejection"}}', { status: 429, headers: { "content-type": "application/json", "retry-after": "600" } });
  } });
  const server = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/gateway/anthropic/v1/messages`;
  for (const body of [{ messages: [{ speed: "fast", content: "private canary" }] }, { speed: "standard", messages: [{ speed: "fast" }] }, { speed: "fast", messages: [{ content: "private canary" }] }]) {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "anthropic-beta": "fast-mode-2026-02-01" }, body: JSON.stringify(body) });
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "600"); assert.deepEqual(await response.json(), { error: { message: "Controlled rejection" } });
  }
  assert.deepEqual(feedback, [{ type: "cooldown", reason: "rate_limit", until: 605000, credential: claudeFastCredential(config.claude) }]);
  assert.deepEqual(foreign, []); assert.equal(received.length, 3); assert(!JSON.stringify(feedback).includes("private canary"));
  const denied = await fetch(url, { method: "POST", headers: { authorization: "Bearer forged" }, body: '{"speed":"fast"}' }); assert.equal(denied.status, 401); await denied.text();
  assert.equal(received.length, 3); assert.equal(feedback.length, 1);
});
