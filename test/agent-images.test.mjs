import test from "node:test";
import assert from "node:assert/strict";
import { captureAgentImages, imageReferences } from "../src/agent-images.mjs";
import { agentImageFor, chatImages } from "../public/attachment-view.js";

test("agents cite workspace images by relative path; URLs and escapes are ignored", () => {
  const text = [
    "![Home page](screens/home.png) and again ![dup](./screens/home.png)",
    "![abs](/work/chat/shots/a.jpeg) ![outside](/etc/b.png) ![up](../secret.png) ![mid](a/../b.png)",
    "![remote](https://example.com/x.png) ![data](data:image/png;base64,AAAA) ![proto](//cdn/x.png)",
    "![spaces](<shots/with space.webp>) ![encoded](shots/caf%C3%A9.gif \"title\") ![text](notes.md)",
  ].join("\n");
  assert.deepEqual(imageReferences(text, "/work/chat").map(item => item.path),
    ["screens/home.png", "shots/a.jpeg", "shots/with space.webp", "shots/café.gif"]);
  assert.equal(imageReferences(text, "/work/chat")[0].alt, "Home page");
  const many = Array.from({ length: 14 }, (_, index) => `![${index}](shot-${index}.png)`).join(" ");
  assert.equal(imageReferences(many).length, 10, "at most 10 images per message");
});

test("captured images become attachments; unreadable or non-image files are skipped", async () => {
  const files = {
    "ok.png": { kind: "file", binary: true, mime: "image/png", data: "iVBORw0KGgo=" },
    "big.png": { kind: "file", referenceOnly: true, mime: "text/plain", data: "" },
    "fake.png": { kind: "file", binary: false, mime: "text/plain", data: "aGk=" },
  };
  const uploads = [];
  const images = await captureAgentImages({ workspace: "/w",
    text: "![Result](ok.png) ![Too big](big.png) ![Text](fake.png) ![Missing](gone.png)",
    read: async relative => { if (!files[relative]) throw new Error("ENOENT"); return files[relative]; },
    upload: async file => { uploads.push(file); return { id: `file_${uploads.length}`, name: file.name, mime: file.mime, size: 8 }; } });
  assert.deepEqual(uploads.map(file => file.name), ["ok.png"]);
  assert.deepEqual(images, [{ id: "file_1", name: "ok.png", mime: "image/png", size: 8, agentImage: { path: "ok.png", source: "ok.png", caption: "Result" } }]);
});

test("the viewer pages through every image in the chat and maps Markdown sources to captures", () => {
  const shot = { id: "file_b", name: "home.png", mime: "image/png", agentImage: { path: "screens/home.png", source: "./screens/home.png" } };
  const messages = [
    { id: "m1", role: "user", attachments: [{ id: "file_a", name: "sent.png", mime: "image/png" }, { id: "file_t", name: "notes.txt", mime: "text/plain" }] },
    { id: "m2", role: "assistant", attachments: [shot] },
    { id: "m3", role: "user", attachments: [{ copied: true, name: "old.png", mime: "image/png" }] },
  ];
  assert.deepEqual(chatImages(messages).map(image => [image.file.id, image.messageId]), [["file_a", "m1"], ["file_b", "m2"]]);
  assert.equal(agentImageFor([shot], "./screens/home.png"), shot);
  assert.equal(agentImageFor([shot], "screens/home.png"), shot);
  assert.equal(agentImageFor([shot], "/work/chat/screens/home.png"), shot);
  assert.equal(agentImageFor([shot], "other.png"), null);
  const before = { id: "file_x", agentImage: { path: "shots/x.png", source: "shots/x.png" } };
  const after = { id: "file_y", agentImage: { path: "old/shots/x.png", source: "old/shots/x.png" } };
  assert.equal(agentImageFor([before, after], "old/shots/x.png"), after, "an exact path wins over a suffix");
  assert.equal(agentImageFor([before, after], "/work/chat/old/shots/x.png"), after, "the longest suffix wins");
});
