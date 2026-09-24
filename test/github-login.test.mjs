import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, stat } from "node:fs/promises";
import { GitHubLogin, githubLoginEnvironment } from "../src/github-login.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { userRecords } from "../src/user-services.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
function nativeFixture() {
  let child, spawnOptions, extractionOptions;
  const client = new GitHubLogin({ spawnImpl: (binary, args, options) => {
    spawnOptions = options;
    assert.deepEqual(args, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage"]);
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
    child.kill = () => { child.killed = true; child.exitCode = 143; setImmediate(() => child.emit("close", 143)); return true; };
    return child;
  }, runImpl: async (binary, args, options) => { extractionOptions = options; return { stdout: "fixture_github_token" }; } });
  return { client, child: () => child, options: () => spawnOptions, extraction: () => extractionOptions };
}
test("native GitHub profile never inherits host identities and accepts only a device code", async () => {
  const env = githubLoginEnvironment("/tmp/private-fixture", { PATH: "/usr/bin", HOME: "/host", GH_TOKEN: "host-secret", GITHUB_TOKEN: "host-secret", GH_CONFIG_DIR: "/host/config", GH_BROWSER: "evil", SSH_AUTH_SOCK: "/secret", DBUS_SESSION_BUS_ADDRESS: "keyring", GH_DEBUG: "api" });
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "GH_DEBUG"]) assert.equal(env[key], undefined);
  assert.equal(env.GH_CONFIG_DIR, "/tmp/private-fixture/gh"); assert.equal(env.HOME, "/tmp/private-fixture"); assert.equal(env.GH_BROWSER, "/bin/true");
  const native = nativeFixture(); let device;
  const promise = native.client.start(value => { device = value; });
  while (!native.child()) await tick();
  const profile = native.client.profile;
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  native.child().stderr.write("! First copy your one-time co"); native.child().stderr.write("de: AAAA-BBBB\nhttps://malicious.example/secret\n");
  assert.equal(device.userCode, "AAAA-BBBB"); assert.equal(device.verificationUrl, "https://github.com/login/device");
  native.child().exitCode = 0; native.child().emit("close", 0);
  assert.equal(await promise, "fixture_github_token");
  assert.equal(native.extraction().env, native.options().env);
  await assert.rejects(access(profile));
});
test("native cancel removes private profile and never returns host tokens", async () => {
  const native = nativeFixture(), promise = native.client.start(() => {});
  const rejected = assert.rejects(promise, /cancelled/);
  while (!native.child()) await tick();
  const profile = native.client.profile;
  await native.client.close(); await rejected;
  assert.equal(native.extraction(), undefined); await assert.rejects(access(profile));
});
test("missing native CLI fails safely and close does not wait on a process that never spawned", async () => {
  const client = new GitHubLogin({ executable: "/missing/relay-test-gh" });
  await assert.rejects(client.start(() => assert.fail("no code expected")), error => error.code === "start" && !error.message.includes("ENOENT"));
  await client.close(); await assert.rejects(access(client.profile));
});
test("native timeout and denial clean up without exposing process output", async () => {
  for (const reason of ["start", "timeout", "denied"]) {
    const native = nativeFixture();
    if (reason === "start") native.client.startupTimeoutMs = 5;
    if (reason === "timeout") native.client.timeoutMs = 5;
    const hold = setTimeout(() => {}, 1000), promise = native.client.start(() => {});
    const rejected = assert.rejects(promise, error => error.code === reason && !error.message.includes("sensitive"));
    while (!native.child()) await tick();
    if (reason !== "start") native.child().stderr.write("one-time code: TEST-CODE\nsensitive-output\n");
    if (reason === "denied") { native.child().exitCode = 1; native.child().emit("close", 1); }
    await rejected; clearTimeout(hold); await native.client.close(); await assert.rejects(access(native.client.profile));
  }
});

function fixture(records = new MemoryRecords()) {
  const clients = [], calls = [];
  const github = new GitHubConnection({ records, config: { apiBase: "https://api.github.com" }, loginFactory: () => {
    const client = { start: onCode => new Promise((resolve, reject) => { Object.assign(client, { onCode, resolve, reject }); }), close: async () => { client.closed = true; client.reject?.(new Error("cancelled")); } }; clients.push(client); return client;
  }, fetchImpl: async (url, options) => {
    calls.push({ url, auth: options.headers.authorization });
    if (url.endsWith("/user")) return Response.json({ id: options.headers.authorization.includes("other") ? 2 : 1, login: "fixture-user" });
    if (url.includes("/user/repos")) return Response.json([{ full_name: "allowed/repo", id: 1, default_branch: "main" }, { full_name: "excluded/repo", id: 2 }]);
    return Response.json({ full_name: "allowed/repo", id: 1, default_branch: "main", size: 0 });
  } });
  return { github, records, clients, calls };
}
async function finish(github, client, token = "fixture_github_token") {
  client.resolve(token);
  for (let i = 0; i < 100 && github.pending.size; i++) await tick();
  assert.equal(github.pending.size, 0);
  return (await github.status()).connections[0];
}
test("native start is immediate; owner-only codes stay in memory; GitHub permissions apply immediately after consent", async () => {
  const { github, clients, records } = fixture();
  const flow = await github.beginDevice();
  assert.equal(flow.connection.signIn.state, "starting"); assert.equal(flow.connection.connected, false);
  clients[0].onCode({ userCode: "AAAA-BBBB", verificationUrl: "https://github.com/login/device" });
  assert.equal((await github.status()).connections[0].signIn.userCode, "AAAA-BBBB");
  assert.equal(JSON.stringify(await records.list("github_connection")).includes("AAAA-BBBB"), false);
  const connected = await finish(github, clients[0]);
  assert.equal(connected.login, "fixture-user"); assert.equal(connected.name, "fixture-user"); assert.equal(connected.connected, true);
  assert.equal(connected.repositoryAccess, "github"); assert.equal(connected.companies, undefined); assert.equal(connected.allowUnassigned, undefined); assert.equal(connected.scopeNeedsReview, undefined); assert.equal(connected.token, undefined);
  assert.equal((await github.requireConnection({ repository: "allowed/repo" })).id, connected.id);
  assert.deepEqual((await github.repositories()).map(repo => repo.fullName), ["allowed/repo", "excluded/repo"]);
  await github.update({ id: connected.id, revision: connected.revision, name: "Personal" });
  assert.equal((await github.resolveSelections([{ fullName: "allowed/repo", githubConnectionId: connected.id }]))[0].githubConnectionId, connected.id);
  await github.close();
});
test("cancel and shutdown beat late authentication; retry retains id; another account cannot replace it", async () => {
  const { github, clients, records } = fixture();
  const flow = await github.beginDevice();
  await github.cancelDevice(flow.id); clients[0].resolve("fixture_github_token"); await tick();
  let saved = await github.get(flow.connection.id); assert.equal(saved.token, null); assert.equal(clients[0].closed, true);
  await github.beginDevice({ id: saved.id, revision: saved.revision });
  let connected = await finish(github, clients[1]);
  await github.update({ id: connected.id, revision: connected.revision, name: "Personal" });
  connected = (await github.status()).connections[0];
  await github.beginDevice({ id: connected.id, revision: connected.revision });
  await finish(github, clients[2], "other_github_token");
  saved = await github.get(connected.id); assert.equal(saved.token, "fixture_github_token"); assert.match(saved.error, /different GitHub/); assert.equal(saved.companies, undefined);
  await github.beginDevice({ id: saved.id, revision: saved.revision });
  await github.close(); assert.equal((await records.get("github_connection", saved.id)).token, "fixture_github_token"); assert.equal(clients[3].closed, true);
});
test("restart never revives lost native processes; user namespaces reject another user's flow, record and repository", async () => {
  const records = new MemoryRecords(), alice = fixture(userRecords(records, "alice")), bob = fixture(userRecords(records, "bob"));
  const flow = await alice.github.beginDevice();
  assert.equal((await bob.github.status()).connections.length, 0);
  await assert.rejects(bob.github.cancelDevice(flow.id), { statusCode: 404 });
  await assert.rejects(bob.github.get(flow.connection.id), { statusCode: 404 });
  const recovered = fixture(userRecords(records, "alice"));
  const saved = (await recovered.github.status()).connections[0];
  assert.equal(saved.connected, false); assert.equal(saved.signIn, undefined); assert.match(saved.error, /restarted/);
  await alice.github.close(); await bob.github.close(); await recovered.github.close();
});
test("a connected owner's repositories and credential remain invisible to another Google user", async () => {
  const records = new MemoryRecords(), alice = fixture(userRecords(records, "alice")), bob = fixture(userRecords(records, "bob"));
  const connected = (await alice.github.connect({ token: "fixture_github_token" })).connection;
  assert.equal((await alice.github.repositories()).length, 2);
  assert.deepEqual(await bob.github.repositories(), []);
  await assert.rejects(bob.github.requireConnection({ connectionId: connected.id, repository: "allowed/repo" }), { statusCode: 404 });
  await assert.rejects(bob.github.resolveSelections([{ fullName: "allowed/repo", githubConnectionId: connected.id }]), { statusCode: 404 });
  assert.equal(bob.calls.length, 0);
  await alice.github.close(); await bob.github.close();
});
test("cancellation during GitHub identity verification cannot persist a late token", async () => {
  const { github, clients } = fixture();
  let release, entered = false;
  github.fetch = async () => { entered = true; return new Promise(resolve => { release = () => resolve(Response.json({ id: 1, login: "late" })); }); };
  const flow = await github.beginDevice(); clients[0].resolve("fixture_github_token");
  while (!entered) await tick();
  const cancelled = github.cancelDevice(flow.id); release(); await cancelled;
  const record = await github.get(flow.connection.id);
  assert.equal(record.token, null); assert.equal(record.loginState, "disconnected"); assert.match(record.error, /cancelled/);
  await github.close();
});
test("public update endpoints reject token and server profile imports regardless of configuration", async () => {
  const { github } = fixture();
  for (const input of [{ method: "local" }, { token: "fixture_github_token" }, { id: "github", token: "fixture_github_token" }]) {
    await assert.rejects(github.update(input), /browser sign-in/); await assert.rejects(github.beginDevice(input), /browser sign-in/);
  }
  await assert.rejects(github.connect({ method: "local" }), /Server credentials/);
  await github.close();
});
test("obsolete public company updates fail explicitly without changing the saved connection", async () => {
  const { github, records } = fixture();
  const connected = (await github.connect({ token: "fixture_github_token" })).connection;
  const before = await github.get(connected.id);
  for (const input of [{ companies: [] }, { companies: ["allowed"] }, { organization: "allowed" }, { allowUnassigned: true }]) {
    const value = { id: connected.id, revision: connected.revision, name: "Unapplied rename", ...input };
    await assert.rejects(github.update(value), error => error.statusCode === 400 && /Reload Relay/.test(error.message));
    await assert.rejects(github.beginDevice(value), error => error.statusCode === 400 && /Reload Relay/.test(error.message));
  }
  assert.deepEqual(await github.get(connected.id), before);
  assert.equal(github.pending.size, 0);
  await github.close();
});
test("listing started with an old credential cannot continue pagination or publish cache after reconnect", async () => {
  const { github, records } = fixture();
  const connected = (await github.connect({ token: "fixture_github_token" })).connection;
  let release, started = false, requests = 0;
  github.fetch = async () => { requests++; started = true; return new Promise(resolve => { release = () => resolve(Response.json(Array.from({ length: 100 }, (_, index) => ({ id: index + 1, full_name: `old/repo${index}`, name: `repo${index}` })))); }); };
  const listing = assert.rejects(github.repositories(), { statusCode: 409 }); while (!started) await tick();
  await records.put("github_connection", connected.id, { ...await github.get(connected.id), revision: connected.revision + 1, token: "fixture_reconnected_token" });
  release(); await listing; assert.equal(github.cache.has(connected.id), false); assert.equal(requests, 1);
  await github.close();
});
test("cached repository lists bind both credential identity and revision", async () => {
  const { github, records } = fixture();
  const connected = (await github.connect({ token: "fixture_github_token" })).connection;
  assert.equal((await github.repositories()).length, 2);
  await records.put("github_connection", connected.id, { ...await github.get(connected.id), token: "fixture_new_credential" });
  let requests = 0;
  github.fetch = async (_url, options) => { requests++; assert.equal(options.headers.authorization, "Bearer fixture_new_credential"); return Response.json([{ id: 42, full_name: "current/repo", name: "repo" }]); };
  assert.deepEqual((await github.repositories()).map(repo => repo.fullName), ["current/repo"]);
  assert.equal(requests, 1); await github.close();
});
test("a multi-account listing rechecks earlier connections after later provider work", async () => {
  const { github, records } = fixture();
  const first = (await github.connect({ token: "fixture_first_token" })).connection;
  await github.connect({ token: "fixture_second_token" });
  let release, held = false;
  github.fetch = async (_url, options) => {
    if (options.headers.authorization === "Bearer fixture_first_token") return Response.json([{ id: 1, full_name: "first/repo", name: "repo" }]);
    held = true; return new Promise(resolve => { release = () => resolve(Response.json([])); });
  };
  const listing = assert.rejects(github.repositories(), { statusCode: 409 }); while (!held) await tick();
  await records.delete("github_connection", first.id); release(); await listing; await github.close();
});
test("a mutation during the final multi-account validation cannot publish an earlier stale connection", async () => {
  const { github, records } = fixture();
  const first = (await github.connect({ token: "fixture_first_token" })).connection;
  const second = (await github.connect({ token: "fixture_second_token" })).connection;
  await github.repositories(); // Exercise the compact cached path, not provider work.
  const originalGet = records.get.bind(records); let secondReads = 0, release, held = false;
  records.get = async (kind, id) => {
    const snapshot = await originalGet(kind, id);
    if (kind === "github_connection" && id === second.id && ++secondReads === 3) {
      held = true; await new Promise(resolve => { release = resolve; });
    }
    return snapshot;
  };
  const listing = assert.rejects(github.repositories(), { statusCode: 409 });
  for (let attempt = 0; attempt < 100 && !held; attempt++) await tick();
  assert.equal(held, true, "second connection's final read must be gated");
  await github.update({ id: first.id, revision: first.revision, name: "Renamed while listing" });
  release(); await listing; await github.close();
});
test("failed sign-in output stays private and outstanding native processes are bounded per user", async () => {
  const { github, clients } = fixture();
  const flows = await Promise.all([github.beginDevice(), github.beginDevice(), github.beginDevice()]);
  await assert.rejects(github.beginDevice(), { statusCode: 429 });
  clients[0].reject(new Error("sensitive native output and token"));
  while (github.pending.size === 3) await tick();
  const saved = await github.get(flows[0].connection.id);
  assert.equal(saved.token, null); assert.equal(saved.error.includes("sensitive"), false);
  await github.beginDevice({ id: saved.id, revision: saved.revision });
  assert.equal((await github.status()).connections.length, 3);
  await github.close(); assert.ok(clients.every(client => client.closed));
});
test("a delayed revocation write cannot overwrite a newly reconnected credential", async () => {
  const { github, records } = fixture();
  const saved = (await github.connect({ token: "fixture_old_token", companies: ["allowed"] })).connection;
  const fetch = github.fetch; github.fetch = (url, options) => url.endsWith("/user") ? fetch(url, options) : Promise.resolve(Response.json({}, { status: 401 }));
  const put = records.put.bind(records); let release, entered = false;
  records.put = async (kind, id, value) => {
    if (kind === "github_connection" && value.token === null && !entered) { entered = true; await new Promise(resolve => { release = resolve; }); }
    return put(kind, id, value);
  };
  const rejected = assert.rejects(github.request("/repos/allowed/repo", { connectionId: saved.id }), { statusCode: 401 });
  while (!entered) await tick();
  const reconnect = github.connect({ id: saved.id, revision: saved.revision + 1, token: "fixture_new_token", companies: ["allowed"] });
  await tick(); release(); await rejected; await reconnect;
  assert.equal((await github.get(saved.id)).token, "fixture_new_token");
  await github.close();
});
