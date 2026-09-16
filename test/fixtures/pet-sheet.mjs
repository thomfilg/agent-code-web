import { deflateSync } from "node:zlib";
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(type, data = Buffer.alloc(0)) {
  const tag = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); tag.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8); return result;
}
// Synthetic geometry fixture, not replacement production artwork. Every frame
// has a different opaque center surrounded by transparent pixels.
export function petSheet(width = 1536, height = 1872, { columns = 8, rows = 9 } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const data = Buffer.alloc(height * (width * 4 + 1)), fw = width / columns, fh = height / rows;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x % fw < fw / 4 || x % fw > fw * 3 / 4 || y % fh < fh / 4 || y % fh > fh * 3 / 4) continue;
    const index = y * (width * 4 + 1) + 1 + x * 4, frame = Math.floor(y / fh) * columns + Math.floor(x / fw);
    data[index] = (frame * 13 + 100) % 255; data[index + 1] = (frame * 37 + 110) % 255; data[index + 2] = (frame * 61 + 120) % 255; data[index + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(data)), pngChunk("IEND")]);
}
