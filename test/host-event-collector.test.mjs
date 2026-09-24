import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { temporaryDirectory } from "./helpers.mjs";

const collector = new URL("../deploy/aws/host-event-collector.py", import.meta.url).pathname;
const timeNano = 1790280000000000000;
const containerId = "a".repeat(64);
const fixture = ({ name = "relay", action = "die", id = containerId, at = timeNano } = {}) => ({
  Type: "container", Action: action, timeNano: at,
  Actor: { ID: id, Attributes: { name, exitCode: "137", secret: "must-not-leak" } },
});

test("the host witness persists only allowlisted Docker facts before cursor advancement", async t => {
  const root = await temporaryDirectory(t);
  const rows = [fixture(), fixture({ name: "unrelated" }), fixture({ action: "oom", at: timeNano + 1 })];
  const input = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  execFileSync("python3", [collector, "--outbox", root, "--stdin"], { input });
  const names = await readdir(root);
  const eventNames = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(eventNames.length, 2);
  const events = await Promise.all(eventNames.map(async name => JSON.parse(await readFile(`${root}/${name}`, "utf8"))));
  assert.deepEqual(events.map(event => event.action).sort(), ["die", "oom"]);
  assert.equal(events.find(event => event.action === "die").exitCode, 137);
  assert.ok(events.every(event => !JSON.stringify(event).includes("must-not-leak")));
  assert.equal(JSON.parse(await readFile(`${root}/.cursor.json`, "utf8")).timeNano, timeNano + 1);
  execFileSync("python3", [collector, "--outbox", root, "--stdin"], { input });
  assert.equal((await readdir(root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 2, "replay is idempotent in the outbox");
});

test("the host witness rejects an invalid timestamp rather than advancing past an unknown event", async t => {
  const root = await temporaryDirectory(t);
  assert.throws(() => execFileSync("python3", [collector, "--outbox", root, "--stdin"], {
    input: JSON.stringify(fixture({ at: 0 })) + "\n", stdio: ["pipe", "pipe", "ignore"],
  }));
  assert.deepEqual(await readdir(root), []);
});

test("a host restart records a Docker state snapshot without treating it as a stop cause", async t => {
  const root = await temporaryDirectory(t);
  const snapshot = { Id: containerId, State: { Status: "exited", OOMKilled: true, ExitCode: 137,
    StartedAt: "2026-09-24T21:00:00Z", FinishedAt: "2026-09-24T22:00:00Z" } };
  const input = JSON.stringify(snapshot);
  execFileSync("python3", [collector, "--outbox", root, "--snapshot-stdin"], { input });
  execFileSync("python3", [collector, "--outbox", root, "--snapshot-stdin"], { input });
  const events = (await readdir(root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(events.length, 1);
  const event = JSON.parse(await readFile(`${root}/${events[0]}`, "utf8"));
  assert.equal(event.action, "snapshot");
  assert.equal(event.status, "exited");
  assert.equal(event.oomKilled, true);
  assert.ok(!Object.hasOwn(event, "cause"), "a state snapshot alone does not prove who stopped the container");
});

test("the host witness runs separately from Relay with only local Docker-event access", async () => {
  const unit = await readFile(new URL("../deploy/aws/host-event-collector.service", import.meta.url), "utf8");
  assert.match(unit, /^User=1000$/m);
  assert.match(unit, /^SupplementaryGroups=docker$/m);
  assert.match(unit, /^PrivateNetwork=yes$/m);
  assert.match(unit, /^ReadWritePaths=\/srv\/relay\/data\/host-events$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /AGENT_.*(?:TOKEN|SECRET)|\/var\/run\/docker\.sock.*relay/);
});
