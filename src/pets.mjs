import { createHash, randomUUID } from "node:crypto";
import { BUILTIN_PETS, builtinPet, PET_ANIMATIONS, PET_FRAME, PET_IMAGE_LIMIT, PET_LIBRARY_LIMIT, PET_LIBRARY_BYTES } from "../public/pets.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const hash = data => createHash("sha256").update(data).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => { let crc = index; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0; });
const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; };
function label(value, limit, required = true) {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) || (required && !value.trim())) throw fail(`Pet text must be ${required ? "non-empty and " : ""}at most ${limit} characters, without control characters.`);
  return value.trim();
}

// Sniff the actual container rather than trusting a filename or data URL. No
// SVG, HTML, animation containers, remote URL or filesystem path is accepted.
export function petImage(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > PET_IMAGE_LIMIT) throw fail("Use a PNG or WebP sprite sheet no larger than 20 MiB.", 413);
  let width, height, alpha = false, mime;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = "image/png"; let offset = 8, ended = false, imageData = false, header = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset), type = data.toString("ascii", offset + 4, offset + 8), end = offset + size + 12;
      if (end > data.length || !/^[a-z]{4}$/i.test(type)) throw fail("Invalid PNG sprite sheet.");
      if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw fail("PNG sprite sheet checksum failed.");
      if (!header && (type !== "IHDR" || size !== 13)) throw fail("Invalid PNG header.");
      if (type === "IHDR") {
        if (header) throw fail("Invalid PNG header."); header = true;
        width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
        alpha = [4, 6].includes(data[offset + 17]);
      }
      if (["acTL", "fcTL", "fdAT"].includes(type)) throw fail("Upload a static sprite sheet, not an animated PNG.");
      if (type === "tRNS") alpha = true;
      if (type === "IDAT") imageData = true;
      offset = end;
      if (type === "IEND") { if (size) throw fail("Invalid PNG end."); ended = true; break; }
    }
    if (!ended || !imageData || offset !== data.length) throw fail("Incomplete PNG sprite sheet.");
  } else if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    mime = "image/webp";
    if (data.length < 26 || data.readUInt32LE(4) + 8 !== data.length) throw fail("Invalid WebP sprite sheet.");
    let offset = 12, payload = false, canvasWidth, canvasHeight;
    while (offset + 8 <= data.length) {
      const type = data.toString("ascii", offset, offset + 4), size = data.readUInt32LE(offset + 4), start = offset + 8, end = start + size;
      if (end + (size % 2) > data.length) throw fail("Invalid WebP chunk.");
      if (["ANIM", "ANMF"].includes(type) || (type === "VP8X" && size >= 10 && (data[start] & 2))) throw fail("Upload a static sprite sheet, not an animated WebP.");
      if (type === "VP8X") {
        if (size !== 10 || canvasWidth) throw fail("Invalid WebP canvas.");
        canvasWidth = 1 + data.readUIntLE(start + 4, 3); canvasHeight = 1 + data.readUIntLE(start + 7, 3); alpha = Boolean(data[start] & 16);
      }
      if (type === "ALPH") alpha = true;
      if (type === "VP8L" || type === "VP8 ") {
        if (payload) throw fail("A pet must have one static sprite sheet."); payload = true;
        if (type === "VP8L") {
          if (size < 5 || data[start] !== 0x2f) throw fail("Invalid lossless WebP.");
          const bits = data.readUInt32LE(start + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; alpha ||= Boolean(bits & 0x10000000);
        } else {
          if (size < 10 || data.toString("hex", start + 3, start + 6) !== "9d012a") throw fail("Invalid WebP frame.");
          width = data.readUInt16LE(start + 6) & 0x3fff; height = data.readUInt16LE(start + 8) & 0x3fff;
        }
      }
      offset = end + (size % 2);
    }
    if (!payload || offset !== data.length || (canvasWidth && (canvasWidth !== width || canvasHeight !== height))) throw fail("Invalid WebP dimensions.");
  } else throw fail("Only PNG and WebP sprite sheets are supported.");
  if (!alpha) throw fail("Use a sprite sheet with transparency.");
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_777_216) throw fail("Pet dimensions must not exceed 4096 × 4096.");
  return { mime, width, height, bytes: data.length };
}

export function petDefinition(input, dimensions) {
  const manifest = input.manifest ?? {};
  if (!object(manifest)) throw fail("A pet manifest must be a JSON object.");
  // Only metadata is used. Uploaded paths are never resolved on the server.
  if (manifest.spritesheetPath !== undefined && (typeof manifest.spritesheetPath !== "string" || !manifest.spritesheetPath || manifest.spritesheetPath.length > 240 || /(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|[:\u0000-\u001f]/.test(manifest.spritesheetPath))) throw fail("The sprite sheet path must stay inside the selected pet folder.");
  const frame = manifest.frame ?? PET_FRAME;
  if (!object(frame) || ["width", "height", "columns", "rows"].some(key => !Number.isSafeInteger(frame[key]) || frame[key] <= 0) || frame.columns * frame.rows > 256 || frame.width * frame.columns !== dimensions.width || frame.height * frame.rows !== dimensions.height) throw fail("The frame grid must cover the sprite sheet exactly (standard sheets are 1536 × 1872). Up to 256 frames are supported.");
  const animations = manifest.animations ?? PET_ANIMATIONS;
  if (!object(animations) || !Object.keys(animations).length || Object.keys(animations).length > 32) throw fail("Provide at most 32 named animations.");
  const normalized = {};
  for (const [name, animation] of Object.entries(animations)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || ["constructor", "prototype"].includes(name) || !object(animation)) throw fail("Invalid pet animation.");
    const frames = animation.frames ?? [], fps = animation.fps ?? 0;
    if (!Array.isArray(frames) || frames.length > 256 || frames.some(index => !Number.isSafeInteger(index) || index < 0 || index >= frame.columns * frame.rows) || !Number.isFinite(fps) || fps < 0 || fps > 60) throw fail("Animation frames must fit the sheet, at 0–60 frames per second.");
    if (!frames.length && (typeof animation.fallback !== "string" || !Object.hasOwn(animations, animation.fallback))) throw fail("Every animation needs frames or an existing fallback.");
    normalized[name] = { frames, fps, ...(animation.fallback ? { fallback: animation.fallback } : {}) };
  }
  if (!normalized.idle) throw fail("The pet needs an idle animation.");
  for (const name of Object.keys(normalized)) {
    let current = name; const visited = new Set();
    while (!normalized[current].frames.length) { if (visited.has(current)) throw fail("Pet animation fallback cycle."); visited.add(current); current = normalized[current].fallback; }
  }
  return { name: label(input.name || manifest.displayName || manifest.name, 64), description: label(manifest.description ?? "Custom pet", 240, false), frame: Object.fromEntries(["width", "height", "columns", "rows"].map(key => [key, frame[key]])), animations: normalized };
}

export class PetPreferences {
  constructor(records, { fetchImpl = fetch } = {}) { this.records = records; this.fetch = fetchImpl; this.locks = new Map(); this.downloads = new Map(); }
  async get(scope, guard = async () => {}) {
    await guard(); const saved = await this.records.get("pets", scope); await guard();
    return { scope, revision: saved?.revision || 0, selected: saved?.selected || null, pets: [...BUILTIN_PETS.map(pet => builtinPet(pet.id)), ...(saved?.custom || [])] };
  }
  async change(scope, input, guard, update) {
    if (input?.scope !== scope || !Number.isSafeInteger(input.revision) || input.revision < 0) throw fail("The pet account changed. Reload /pets.", 409);
    const previous = this.locks.get(scope) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const snapshot = await this.get(scope, guard);
      if (snapshot.revision !== input.revision) throw fail("Pets changed in another tab. Reload /pets before saving.", 409);
      return update(snapshot);
    });
    this.locks.set(scope, task);
    try { return await task; } finally { if (this.locks.get(scope) === task) this.locks.delete(scope); }
  }
  async write(snapshot, guard) {
    await guard(); await this.records.put("pets", snapshot.scope, { revision: snapshot.revision + 1, selected: snapshot.selected, custom: snapshot.pets.filter(pet => !pet.builtin) }); await guard();
    return { ...snapshot, revision: snapshot.revision + 1 };
  }
  async save(scope, input, guard = async () => {}) {
    return this.change(scope, input, guard, async snapshot => {
      if (input.selected !== null && !snapshot.pets.some(pet => pet.id === input.selected)) throw fail("Choose an available pet, or Off.");
      return this.write({ ...snapshot, selected: input.selected }, guard);
    });
  }
  async upload(scope, input, guard = async () => {}) {
    if (scope === "shared") throw fail("Sign in to a private Relay account to upload custom pets.", 403);
    if (typeof input?.data !== "string" || input.data.length > Math.ceil(PET_IMAGE_LIMIT / 3) * 4 || /[^A-Za-z0-9+/=]/.test(input.data)) throw fail("Invalid sprite sheet data.");
    const data = Buffer.from(input.data, "base64");
    if (data.toString("base64") !== input.data) throw fail("Invalid sprite sheet data.");
    const dimensions = petImage(data), definition = petDefinition(input, dimensions);
    return this.change(scope, input, guard, async snapshot => {
      const custom = snapshot.pets.filter(pet => !pet.builtin);
      if (custom.length >= PET_LIBRARY_LIMIT || custom.reduce((total, pet) => total + pet.bytes, 0) + data.length > PET_LIBRARY_BYTES) throw fail("Your pet library is full (12 pets or 60 MiB). Remove a custom pet before uploading another.", 413);
      if (snapshot.pets.some(pet => pet.name.toLocaleLowerCase() === definition.name.toLocaleLowerCase()) || ["off", "none", "hide", "hidden", "disable", "disabled"].includes(definition.name.toLowerCase())) throw fail("Choose a unique pet name, not a pet-off command alias.");
      const pet = { ...definition, ...dimensions, id: `custom-${randomUUID()}`, builtin: false, version: hash(data) }, key = `${scope}:${pet.id}`;
      await guard(); await this.records.put("pet-assets", key, { data: input.data, mime: dimensions.mime, version: pet.version });
      try { return await this.write({ ...snapshot, pets: [...snapshot.pets, pet] }, guard); }
      catch (error) { const current = await this.records.get("pets", scope); if (!current?.custom?.some(item => item.id === pet.id)) await this.records.delete("pet-assets", key); throw error; }
    });
  }
  async remove(scope, id, input, guard = async () => {}) {
    if (scope === "shared") throw fail("Sign in to manage your custom pets.", 403);
    return this.change(scope, input, guard, async snapshot => {
      if (!snapshot.pets.some(pet => pet.id === id && !pet.builtin)) throw fail("Custom pet not found.", 404);
      const result = await this.write({ ...snapshot, selected: snapshot.selected === id ? null : snapshot.selected, pets: snapshot.pets.filter(pet => pet.id !== id) }, guard);
      await this.records.delete("pet-assets", `${scope}:${id}`); return result;
    });
  }
  async builtinAsset(id) {
    const pet = builtinPet(id); if (!pet) throw fail("Pet not found.", 404);
    if (!this.downloads.has(id)) {
      const task = (async () => {
        const key = `builtin:${id}:${pet.version}`, cached = await this.records.get("pet-assets", key);
        if (cached) { const data = Buffer.from(cached.data, "base64"); if (hash(data) === pet.version) return { data, mime: "image/webp" }; }
        const response = await this.fetch(`https://persistent.oaistatic.com/codex/pets/v1/${id}-spritesheet-v4.webp`, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15000) });
        if (!response.ok || !response.body) throw fail("Pet artwork could not be downloaded. Retry when connected.", 502);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > PET_IMAGE_LIMIT) throw fail("Pet artwork exceeded its size limit.", 502); chunks.push(chunk); }
        const data = Buffer.concat(chunks), dimensions = petImage(data);
        if (hash(data) !== pet.version || dimensions.width !== 1536 || dimensions.height !== 1872) throw fail("Pet artwork verification failed.", 502);
        await this.records.put("pet-assets", key, { data: data.toString("base64") }); return { data, mime: dimensions.mime };
      })();
      this.downloads.set(id, task); task.finally(() => { if (this.downloads.get(id) === task) this.downloads.delete(id); }).catch(() => {});
    }
    return this.downloads.get(id);
  }
  async asset(scope, id, guard = async () => {}) {
    const snapshot = await this.get(scope, guard), pet = snapshot.pets.find(pet => pet.id === id);
    if (!pet) throw fail("Pet not found.", 404);
    const result = pet.builtin ? await this.builtinAsset(id) : await this.records.get("pet-assets", `${scope}:${id}`);
    await guard();
    if (!result) throw fail("Pet artwork is missing. Upload the sprite sheet again.", 404);
    return { data: Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, "base64"), mime: result.mime };
  }
}
