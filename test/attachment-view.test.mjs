import assert from "node:assert/strict";
import test from "node:test";
import { attachmentPreview, droppedFiles, fileSize, isAttachmentImage } from "../public/attachment-view.js";

const textFile = (source, name = "notes.txt", mime = "text/plain") => ({ name, mime, size: Buffer.byteLength(source), data: Buffer.from(source).toString("base64") });
test("text attachments stay literal, include byte size and correct line counts", () => {
  const source = '<script>window.leaked=true</script>\r\n<img src=x onerror=alert(1)>\r\n';
  const result = attachmentPreview(textFile(source, "unsafe.html", "text/html"));
  assert.equal(result.format, "text"); assert.equal(result.source, source); assert.match(result.metadata, /2 lines$/);
  assert.match(attachmentPreview(textFile("one")).metadata, /1 line$/);
  assert.match(attachmentPreview(textFile("")).metadata, /0 lines$/);
  assert.match(attachmentPreview(textFile("one\n\n")).metadata, /2 lines$/);
  assert.equal(fileSize(1024), "1.0 KB"); assert.equal(fileSize(1024 * 1024), "1.0 MB");
});
test("safe raster formats get images, SVG remains literal and binary gets a metadata preview", () => {
  assert.equal(isAttachmentImage({ mime: "image/png" }), true);
  assert.equal(isAttachmentImage({ mime: "image/svg+xml" }), false);
  assert.equal(attachmentPreview(textFile("<svg onload='bad()'/>", "image.svg", "image/svg+xml")).format, "text");
  assert.match(attachmentPreview(textFile("\0binary")).source, /not available/);
  assert.match(attachmentPreview({ ...textFile("bad"), data: "/w==" }).source, /not available/);
  assert.match(attachmentPreview(textFile("binary", "file.pdf", "application/pdf")).metadata, /application\/pdf/);
});
test("drops reject directories/empty OS paths while preserving exact ordinary files", () => {
  const files = [{ name: "same.txt" }];
  assert.deepEqual(droppedFiles({ files, items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) }] }), files);
  assert.throws(() => droppedFiles({ files, items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }] }), /Folders/);
  assert.throws(() => droppedFiles({ items: [] }), /individual files/);
});
