import test from "node:test";
import assert from "node:assert/strict";
import { PetPreferences, petImage, petDefinition } from "../src/pets.mjs";
import { BUILTIN_PETS, builtinPet, findPet, petActivity, petAnimation, PET_FRAME, PET_ANIMATIONS, PET_IMAGE_LIMIT } from "../public/pets.js";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { petSheet, pngChunk } from "./fixtures/pet-sheet.mjs";

const sheet = petSheet(), upload = { name: "Test friend", data: sheet.toString("base64") };
test("pet commands are UI controls and activity uses only the current session's reported state", () => {
  assert.equal(BUILTIN_PETS.length, 8); assert.equal(new Set(BUILTIN_PETS.map(pet => pet.id)).size, 8);
  assert.equal(builtinPet("__proto__"), null); assert.equal(findPet(BUILTIN_PETS, "NULL SIGNAL").id, "null-signal");
  assert.throws(() => findPet(BUILTIN_PETS, "missing"), /Unknown pet/);
  for (const agent of ["codex", "claude", "mock"]) {
    assert(webCommands(agent).find(command => command.name === "pets").aliases.includes("pet"));
    for (const text of ["/pets", "/pet", "/pet codex", "/pets off"]) assert.throws(() => messageCommand(agent, text), /web composer/);
  }
  assert.equal(petActivity({ status: "running" }).label, "Running");
  assert.equal(petActivity({ status: "running", pendingRequest: {} }).label, "Needs input");
  assert.equal(petActivity({ status: "running", awaitingUser: true }).label, "Needs input");
  assert.equal(petActivity({ status: "idle" }).label, "Ready");
  assert.equal(petActivity({ status: "error" }).label, "Blocked");
  assert.equal(petActivity({ status: "stopped" }).label, "Stopped");
  assert.equal(petActivity({ status: "running", archived: true }).animate, false);
  assert.equal(petActivity({ status: "running", agent: "codex", agentSessionId: "new", goal: { threadId: "old", status: "blocked" } }).label, "Running");
  assert.equal(petActivity({ status: "running", agent: "codex", agentSessionId: "new", goal: { threadId: "new", status: "blocked" } }).label, "Blocked");
  assert.equal(petActivity({ messages: [{ text: "Running" }], browser: { status: "active" } }).label, "Status not reported");
  assert.deepEqual(petAnimation({ animations: { idle: { frames: [0], fps: 0 }, typing: { fallback: "idle" } } }, "typing"), { frames: [0], fps: 0 });
});

test("sprite containers and custom metadata have bounded, literal paths, dimensions and frame indexes", () => {
  const dimensions = petImage(sheet); assert.equal(dimensions.width, 1536); assert.equal(dimensions.height, 1872); assert.equal(dimensions.mime, "image/png");
  assert.deepEqual(petDefinition(upload, dimensions).frame, PET_FRAME);
  for (const data of [Buffer.from("<svg onload='alert(1)'>"), sheet.subarray(0, 40), Buffer.concat([sheet, Buffer.from("extra")]), Buffer.alloc(PET_IMAGE_LIMIT + 1)]) assert.throws(() => petImage(data));
  const damaged = Buffer.from(sheet); damaged[50] ^= 1; assert.throws(() => petImage(damaged), /checksum/);
  const animated = Buffer.concat([sheet.subarray(0, 33), pngChunk("acTL", Buffer.alloc(8)), sheet.subarray(33)]); assert.throws(() => petImage(animated), /animated PNG/);
  const webp = Buffer.alloc(26); webp.write("RIFF"); webp.writeUInt32LE(18, 4); webp.write("WEBPVP8L", 8); webp.writeUInt32LE(5, 16); webp[20] = 0x2f; webp.writeUInt32LE(0x10000000 | 1535 | (1871 << 14), 21);
  assert.equal(petImage(webp).mime, "image/webp"); webp.writeUInt32LE(0, 4); assert.throws(() => petImage(webp), /WebP/);
  for (const spritesheetPath of ["../private.png", "/secret.png", "C:\\secret.png", "https://other.invalid/sheet.png", "a/../../b"]) assert.throws(() => petDefinition({ ...upload, manifest: { spritesheetPath } }, dimensions), /inside/);
  for (const name of ["", "x".repeat(65), "hidden\u202edata"]) assert.throws(() => petDefinition({ name }, dimensions));
  assert.throws(() => petDefinition({ ...upload, manifest: { frame: { ...PET_FRAME, columns: 7 } } }, dimensions), /grid/);
  assert.throws(() => petDefinition({ ...upload, manifest: { animations: { idle: { frames: [999], fps: 4 } } } }, dimensions), /frames/);
  assert.throws(() => petDefinition({ ...upload, manifest: { animations: { idle: { fallback: "other" }, other: { fallback: "idle" } } } }, dimensions), /cycle/);
  assert.throws(() => petDefinition({ ...upload, manifest: { animations: { idle: { frames: [0], fps: 61 } } } }, dimensions), /frames/);
  const small = petImage(petSheet(128, 128, { columns: 2, rows: 2 }));
  const custom = petDefinition({ manifest: { displayName: "Local friend", spritesheetPath: "assets/sheet.png", frame: { width: 64, height: 64, columns: 2, rows: 2 }, animations: { idle: { frames: [0, 1], fps: 2 }, typing: { frames: [2, 3], fps: 6 }, waiting: { fallback: "idle" } } } }, small);
  assert.equal(custom.name, "Local friend"); assert.equal(petAnimation(custom, "waiting").fps, 2);
});

test("custom pet quotas and failed or revoked writes cannot leak unlisted artwork or lose a prior selection", async () => {
  const records = new MemoryRecords(), settings = new PetPreferences(records);
  let snapshot = await settings.get("owner");
  for (let i = 0; i < 12; i++) snapshot = await settings.upload("owner", { ...snapshot, ...upload, name: `Friend ${i}` });
  await assert.rejects(settings.upload("owner", { ...snapshot, ...upload, name: "Overflow" }), { statusCode: 413 });
  assert.equal((await records.list("pet-assets")).length, 12);
  const originalPut = records.put.bind(records); let failWrite = true;
  records.put = async (kind, id, data) => { if (kind === "pets" && id === "other" && failWrite) throw Error("Fixture database failure"); return originalPut(kind, id, data); };
  await assert.rejects(settings.upload("other", { scope: "other", revision: 0, ...upload }), /database failure/);
  assert.equal((await records.list("pet-assets")).length, 12); assert.equal((await settings.get("other")).pets.length, 8);
  failWrite = false;
  const ready = await settings.save("other", { scope: "other", revision: 0, selected: "codex" }); let revoked = false;
  records.put = async (kind, id, data) => { const result = await originalPut(kind, id, data); if (kind === "pet-assets") revoked = true; return result; };
  await assert.rejects(settings.upload("other", { ...ready, ...upload }, async () => { if (revoked) throw Error("Account revoked"); }), /revoked/);
  assert.equal((await settings.get("other")).selected, "codex"); assert.equal((await records.list("pet-assets")).length, 12);
});

test("pet libraries persist by account, serialize revisions, keep images separate and delete only the selected custom asset", async () => {
  const records = new MemoryRecords(), settings = new PetPreferences(records, { fetchImpl: () => { throw Error("Unexpected download"); } });
  const initial = await settings.get("first"); assert.equal(initial.selected, null);
  const saved = await settings.save("first", { ...initial, selected: "dewey" });
  const results = await Promise.allSettled([settings.upload("first", { ...saved, ...upload }), settings.save("first", { ...saved, selected: "codex" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  const library = await new PetPreferences(records).get("first"), custom = library.pets.at(-1);
  assert.equal(custom.builtin, false); assert.equal(JSON.stringify(library).includes(upload.data), false);
  assert.deepEqual((await settings.asset("first", custom.id)).data, sheet);
  await assert.rejects(settings.asset("second", custom.id), { statusCode: 404 });
  assert.equal((await settings.get("second")).pets.length, 8); assert.equal((await settings.get("shared")).selected, null);
  await assert.rejects(settings.upload("shared", { scope: "shared", revision: 0, ...upload }), { statusCode: 403 });
  await assert.rejects(settings.save("second", { ...library, selected: custom.id }), /account changed/);
  await assert.rejects(settings.save("first", { ...library, selected: "missing" }), /available/);
  await assert.rejects(settings.upload("first", { ...library, ...upload }), /unique/);
  await assert.rejects(settings.save("first", { ...library, selected: null }, async () => { throw Error("Revoked"); }), /Revoked/);
  const selected = await settings.save("first", { ...library, selected: custom.id });
  await assert.rejects(settings.remove("first", "codex", selected), /not found/);
  const removed = await settings.remove("first", custom.id, selected);
  assert.equal(removed.selected, null); assert.equal(removed.pets.length, 8); assert.equal(await records.get("pet-assets", `first:${custom.id}`), null);
  await assert.rejects(settings.asset("first", custom.id), { statusCode: 404 });
  assert.equal(await records.get("syntax-theme", "first"), null);
});

test("built-in asset downloads use a fixed origin, no redirects or credentials, checksum checks and deduplicated retries", async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
  const settings = new PetPreferences(new MemoryRecords(), { fetchImpl: async (url, options) => { calls.push({ url, options }); entered.resolve(); await release.promise; return new Response(sheet); } });
  const first = settings.builtinAsset("codex"), second = settings.builtinAsset("codex"); await entered.promise;
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://persistent.oaistatic.com/codex/pets/v1/codex-spritesheet-v4.webp"); assert.equal(calls[0].options.redirect, "error"); assert.equal(calls[0].options.credentials, "omit");
  release.resolve(); for (const result of await Promise.allSettled([first, second])) assert.match(result.reason.message, /verification failed/);
  await assert.rejects(settings.builtinAsset("../../secrets"), { statusCode: 404 });
  await assert.rejects(settings.builtinAsset("codex"), /verification failed/); assert.equal(calls.length, 2);
});

test("pet HTTP routes enforce authentication, origin, owner scope, revocation and no worker access", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "pet-fixture" }), records, adapterFactory: () => { throw Error("Pets must not start a worker"); }, petFetch: () => { throw Error("Pets must not download until explicitly selected"); } });
  const { url } = await app.start(); t.after(() => app.stop());
  const call = (route, { cookie, body, method, origin } = {}) => fetch(`${url}${route}`, { method: method || (body ? "POST" : "GET"), headers: { authorization: "Bearer pet-fixture", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(`${url}/api/pets`)).status, 401); assert.equal((await fetch(`${url}/api/pets/assets/codex?scope=shared`)).status, 401);
  const shared = await (await call("/api/pets")).json(); assert.equal(shared.selected, null);
  assert.equal((await call("/api/pets", { method: "PATCH", origin: "https://other.invalid", body: { ...shared, selected: "codex" } })).status, 403);
  assert.equal((await call("/api/pets/custom", { body: { ...shared, ...upload } })).status, 403);
  const register = async username => { const response = await call("/api/browser-account/register", { body: { username, password: "isolated-pet-account-password" } }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0]; };
  const first = await register("first-pet-user"), second = await register("second-pet-user");
  const initial = await (await call("/api/pets", { cookie: first })).json();
  const response = await call("/api/pets/custom", { cookie: first, body: { ...initial, ...upload } }); assert.equal(response.status, 200);
  const library = await response.json(), custom = library.pets.at(-1), route = `/api/pets/assets/${custom.id}?scope=${library.scope}`;
  const asset = await call(route, { cookie: first }); assert.equal(asset.status, 200); assert.equal(asset.headers.get("content-type"), "image/png"); assert.equal(asset.headers.get("cache-control"), "private, no-store"); assert.deepEqual(Buffer.from(await asset.arrayBuffer()), sheet);
  assert.equal((await call(route, { cookie: second })).status, 409);
  const other = await (await call("/api/pets", { cookie: second })).json();
  assert.equal((await call(`/api/pets/assets/${custom.id}?scope=${other.scope}`, { cookie: second })).status, 404);
  assert.equal((await call(`/api/pets/custom/${custom.id}`, { cookie: second, method: "DELETE", body: { scope: other.scope, revision: other.revision } })).status, 404);
  assert.equal((await call("/api/pets", { cookie: second, method: "PATCH", body: { scope: library.scope, revision: library.revision, selected: custom.id } })).status, 409);
  assert.equal((await call("/api/pets", { cookie: first, method: "PATCH", body: { scope: library.scope, revision: library.revision, selected: custom.id } })).status, 200);
  await call("/api/browser-account", { cookie: first, method: "DELETE" });
  assert.equal((await call(route, { cookie: first })).status, 409);
  assert.equal((await call("/api/pets", { cookie: first, method: "PATCH", body: { scope: library.scope, revision: 2, selected: null } })).status, 409);
  assert.equal(app.store.list().length, 0); assert.equal(PET_ANIMATIONS.typing.frames[0], 56);
});
