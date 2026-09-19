// Synthetic local-only measurement: no user profile, model call or cloud worker.
// Run before/after on the same machine, with the same CPU limit. These numbers
// exclude network latency and are not an AWS end-to-end latency claim.
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { startBrowserSite } from "../test/fixtures/browser-site.mjs";

const revision = process.argv[2];
if (revision && !/^[a-f0-9]{7,40}$/.test(revision)) throw Error("Use an exact baseline Git commit hash, or omit it for the working tree.");
const { ChromeBrowser } = revision
  ? await import(`data:text/javascript;base64,${execFileSync("git", ["show", `${revision}:src/browser-worker.mjs`], { maxBuffer: 1024 * 1024 }).toString("base64")}`)
  : await import("../src/browser-worker.mjs");

const site = await startBrowserSite();
const browser = new ChromeBrowser({ executable: process.env.AGENT_CHROME_BIN || "google-chrome" });
let frames = 0, bytes = 0, screenshots = 0, measuring = false;
const page = browser.page.bind(browser);
browser.page = (method, params) => { if (measuring && method === "Page.captureScreenshot") screenshots++; return page(method, params); };
browser.on("frame", frame => { if (measuring) { frames++; bytes += Buffer.byteLength(frame.data, "base64"); } });
try {
  await browser.start();
  await browser.command("navigate", { url: site.url });
  for (let tries = 0; tries < 100 && !await browser.evaluate("!!document.querySelector('#entry')"); tries++) await delay(25);
  await browser.evaluate(`(() => {
    const style = document.createElement('style');
    style.textContent = '@keyframes slide {from {transform:translateX(0)} to {transform:translateX(500px)}} #motion {position:absolute;top:480px;width:500px;height:180px;background:linear-gradient(45deg,#acf,#fac);animation:slide 1s linear infinite alternate}';
    document.head.append(style); const motion = document.createElement('div'); motion.id = 'motion'; document.body.append(motion);
    document.querySelector('#entry').focus();
  })()`);
  await browser.watch(true); await delay(500);
  const latencies = [], start = performance.now(); measuring = true;
  for (let index = 0; index < 60; index++) {
    const sent = performance.now();
    await browser.command("text", { text: "a" });
    latencies.push(performance.now() - sent);
    await delay(40);
  }
  const elapsedMs = performance.now() - start; measuring = false;
  const length = await browser.evaluate("document.querySelector('#entry').value.length");
  if (length !== 60) throw Error("Synthetic typing was lost");
  latencies.sort((a, b) => a - b);
  const percentile = value => Math.round(latencies[Math.ceil(latencies.length * value) - 1] * 10) / 10;
  console.log(JSON.stringify({ scope: "local synthetic Chrome; excludes network/model", revision: revision || "working tree", inputCount: length,
    inputAckP50Ms: percentile(.5), inputAckP95Ms: percentile(.95), durationMs: Math.round(elapsedMs),
    frames, framesPerSecond: Math.round(frames * 10000 / elapsedMs) / 10, pngCapturesDuringInteraction: screenshots,
    transmittedImageKiB: Math.round(bytes / 1024), imageKiBPerSecond: Math.round(bytes / 1024 * 1000 / elapsedMs) }));
} finally { await browser.stop(); await site.close(); }
