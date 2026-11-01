// Streaming 16-bit RGB PNG encoder. Rows (Uint16 RGB, top to bottom) are Sub-filtered and fed into one zlib stream
// (CompressionStream 'deflate' = zlib framing, as PNG requires); compressed pieces become consecutive IDAT chunks.
const PNG_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i); out.set(data, 8);
  let c = 0xffffffff; for (let i = 4; i < 8 + data.length; i++) c = PNG_CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0); return out;
}
class PngEncoder {
  constructor(width, height) {
    if (typeof CompressionStream === 'undefined') throw new Error('這個瀏覽器不支援 PNG 匯出（缺少 CompressionStream）');
    this.w = width; this.h = height; this.parts = [];
    const cs = new CompressionStream('deflate'); this.writer = cs.writable.getWriter();
    this.reading = (async () => { const r = cs.readable.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; this.parts.push(pngChunk('IDAT', value)); } })();
  }
  async addRows(rgb /* Uint16Array w*rows*3 */, rows) {
    const W = this.w, rb = 1 + W * 6, buf = new Uint8Array(rb * rows);
    for (let y = 0; y < rows; y++) {
      const o = y * rb, s = y * W * 3; buf[o] = 1; // filter type 1 (Sub): each byte minus the byte one pixel (6 bytes) to the left
      for (let x = 0; x < W * 3; x++) { const v = rgb[s + x], i = o + 1 + x * 2; buf[i] = v >> 8; buf[i + 1] = v & 255; }
      for (let i = o + rb - 1; i >= o + 7; i--) buf[i] = (buf[i] - buf[i - 6]) & 255;
    }
    await this.writer.write(buf);
  }
  async finish() {
    await this.writer.close(); await this.reading;
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, this.w); dv.setUint32(4, this.h); ihdr[8] = 16; ihdr[9] = 2; // 16-bit RGB
    const sw = new TextEncoder().encode('Software\0RAW Editor');
    return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('sRGB', new Uint8Array([0])), pngChunk('tEXt', sw), ...this.parts, pngChunk('IEND', new Uint8Array(0))], { type: 'image/png' });
  }
}
