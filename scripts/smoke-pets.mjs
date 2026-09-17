// Downloads only fixed, public OpenAI artwork (no model or account requests).
// The production sprite renderer runs in a fresh Playwright browser on loopback.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { PetPreferences } from "../src/pets.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { BUILTIN_PETS, builtinPet, PET_ANIMATIONS } from "../public/pets.js";
const requests = [], pets = new PetPreferences(new MemoryRecords(), { fetchImpl: (url, options) => { requests.push(url); return fetch(url, options); } });
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost"), asset = /^\/api\/pets\/assets\/([a-z0-9-]+)$/.exec(url.pathname);
    if (asset) { const result = await pets.builtinAsset(asset[1]); response.writeHead(200, { "content-type": result.mime }); response.end(result.data); return; }
    if (["/pets.js", "/pet-sprite.js"].includes(url.pathname)) { response.setHeader("content-type", "text/javascript"); response.end(await readFile(new URL(`../public${url.pathname}`, import.meta.url))); return; }
    response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Native pet artwork verification</title><style>body{margin:24px;background:#151812;color:#edf3e5;font:14px system-ui}main{display:grid;grid-template-columns:repeat(4,200px);gap:20px}section{border:1px solid #48513d;border-radius:10px;padding:14px}canvas{width:96px;height:auto;max-height:104px}#live{position:fixed;left:-300px}h1{font-size:24px}p{color:#b2c2a4}</style><h1>Native pets · verified v4 artwork</h1><p>Running · Needs input · Ready · Blocked</p><main id="gallery"></main><div id="live"></div></html>');
  } catch (error) { response.writeHead(502, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 960, height: 860 }, reducedMotion: "reduce" }), errors = [];
  page.on("pageerror", error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const entry of BUILTIN_PETS) {
    const pet = builtinPet(entry.id);
    const result = await page.evaluate(async pet => {
      const { PetSprite } = await import("/pet-sprite.js"), root = document.querySelector("#live"), sprite = new PetSprite(root), card = document.createElement("section"), name = document.createElement("h2");
      name.textContent = pet.name; card.append(name); document.querySelector("#gallery").append(card);
      const states = [];
      for (const animation of ["typing", "waiting", "bounce", "sad"]) {
        await sprite.show(pet, "shared", { animation, animate: true });
        if (root.dataset.art !== "ready") throw Error(root.textContent || "Artwork did not decode");
        const canvas = document.createElement("canvas"); canvas.width = sprite.canvas.width; canvas.height = sprite.canvas.height; canvas.getContext("2d").drawImage(sprite.canvas, 0, 0); card.append(canvas);
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let visible = 0, transparent = 0; for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]) visible++; if (pixels[i] === 0) transparent++; }
        states.push({ animation, visible, transparent, frame: Number(root.dataset.frame), animating: root.dataset.animating });
      }
      // Verify every declared frame, not just one lucky first frame per state.
      const context = sprite.canvas.getContext("2d"), empty = [];
      for (const [animation, spec] of Object.entries(pet.animations)) for (const frame of spec.frames) {
        context.clearRect(0, 0, 192, 208); context.drawImage(sprite.bitmap, frame % 8 * 192, Math.floor(frame / 8) * 208, 192, 208, 0, 0, 192, 208);
        const pixels = context.getImageData(0, 0, 192, 208).data;
        if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) empty.push({ animation, frame });
      }
      sprite.destroy(); root.replaceChildren(); return { states, empty };
    }, pet);
    for (const state of result.states) { assert(state.visible > 100); assert(state.transparent > 100); assert.equal(state.frame, PET_ANIMATIONS[state.animation].frames[0]); assert.equal(state.animating, "false"); }
    assert.deepEqual(result.empty, [], `${pet.name} has empty declared frames`); console.log(`${pet.name}: checksum, decode, transparency, all declared frames and four states pass`);
  }
  assert.equal(requests.length, 8); assert.deepEqual(errors, []);
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true }); await page.screenshot({ path: new URL("../test-results/pets-native-artwork.png", import.meta.url).pathname, fullPage: true });
  console.log("8/8 real built-ins verified; cached repeats made no extra external requests.");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
