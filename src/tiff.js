// Streaming 16-bit RGB TIFF writer (little-endian, one strip per addRows call).
// Compression: Adobe Deflate (8) with horizontal predictor (2) via the browser's CompressionStream; uncompressed fallback.
// Strips are kept as Blobs so large files can be paged out by the browser instead of living in the JS heap.
class TiffEncoder {
  constructor(width, height, exif, rowsPerStrip = 64) {
    this.w = width; this.h = height; this.exif = exif; this.rps = rowsPerStrip;
    this.compress = typeof CompressionStream !== 'undefined';
    this.parts = []; this.offsets = []; this.counts = []; this.pos = 8; this.rows = 0;
  }
  async addRows(rgb /* Uint16Array w*rows*3 */, rows) {
    const n = this.w * rows * 3; const bytes = new Uint8Array(n * 2);
    if (this.compress) {
      // horizontal differencing per channel, then little-endian bytes
      const W3 = this.w * 3;
      for (let y = 0; y < rows; y++) {
        const r0 = y * W3; let o = r0 * 2;
        for (let i = 0; i < W3; i++, o += 2) { const v = i < 3 ? rgb[r0 + i] : (rgb[r0 + i] - rgb[r0 + i - 3]) & 0xffff; bytes[o] = v & 255; bytes[o + 1] = v >> 8; }
      }
    } else {
      for (let i = 0, o = 0; i < n; i++, o += 2) { const v = rgb[i]; bytes[o] = v & 255; bytes[o + 1] = v >> 8; }
    }
    let data = bytes;
    if (this.compress) {
      try { data = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()); }
      catch (e) { if (this.offsets.length) throw e; this.compress = false; return this.addRows(rgb, rows); }
    }
    this.offsets.push(this.pos); this.counts.push(data.length); this.pos += data.length;
    this.parts.push(new Blob([data])); this.rows += rows;
  }
  finish() {
    if (this.pos & 1) { this.parts.push(new Blob([new Uint8Array(1)])); this.pos++; }
    const ifd0Off = this.pos; const x = this.exif || {};
    const asc = s => s ? String(s).replace(/[^\x20-\x7e]/g, '') : '';
    const rat = (v, den = 10) => [Math.round(v * den), den];
    const e0 = [
      [256, 4, [this.w]], [257, 4, [this.h]], [258, 3, [16, 16, 16]], [259, 3, [this.compress ? 8 : 1]], [262, 3, [2]],
      x.make && [271, 2, asc(x.make)], x.model && [272, 2, asc(x.model)],
      [273, 4, this.offsets], [274, 3, [1]], [277, 3, [3]], [278, 4, [this.rps]], [279, 4, this.counts],
      [282, 5, [300, 1]], [283, 5, [300, 1]], [284, 3, [1]], [296, 3, [2]],
      [305, 2, asc(x.software || 'RAW Editor')], x.dateTime && [306, 2, asc(x.dateTime)],
      this.compress && [317, 3, [2]], [339, 3, [1, 1, 1]],
    ].filter(Boolean);
    const ex = [
      x.exposure > 0 && [33434, 5, x.exposure >= 1 ? rat(x.exposure) : [1, Math.round(1 / x.exposure)]],
      x.fnumber > 0 && [33437, 5, rat(x.fnumber)], x.iso > 0 && [34855, 3, [Math.min(65535, Math.round(x.iso))]],
      x.dateTime && [36867, 2, asc(x.dateTime)], x.focal > 0 && [37386, 5, rat(x.focal)], x.lens && [42036, 2, asc(x.lens)],
    ].filter(Boolean);
    const hasExif = ex.length > 0;
    if (hasExif) e0.push([34665, 4, [0]]);
    e0.sort((a, b) => a[0] - b[0]);
    const ifd0 = buildIFD(e0, ifd0Off);
    if (hasExif) { const exOff = ifd0Off + ifd0.length; const ent = e0.find(e => e[0] === 34665); ent[2] = [exOff]; }
    const ifd0b = buildIFD(e0, ifd0Off);
    const parts = [tiffHeader(ifd0Off), ...this.parts, ifd0b];
    if (hasExif) parts.push(buildIFD(ex.sort((a, b) => a[0] - b[0]), ifd0Off + ifd0b.length));
    return new Blob(parts, { type: 'image/tiff' });
  }
}
function tiffHeader(ifdOff) { const b = new Uint8Array(8); const v = new DataView(b.buffer); b[0] = b[1] = 0x49; v.setUint16(2, 42, true); v.setUint32(4, ifdOff, true); return b; }
// entries: [tag, type, values] (type 2 = ASCII string, 3 SHORT, 4 LONG, 5 RATIONAL as flat [num,den,...]); returns IFD + its data area
function buildIFD(entries, offset) {
  const size = { 2: 1, 3: 2, 4: 4, 5: 8 };
  const enc = entries.map(([tag, type, vals]) => {
    let count, bytes;
    if (type === 2) { const s = vals + '\0'; count = s.length; bytes = Uint8Array.from(s, ch => ch.charCodeAt(0)); }
    else {
      count = type === 5 ? vals.length / 2 : vals.length; bytes = new Uint8Array(count * size[type]); const dv = new DataView(bytes.buffer);
      vals.forEach((v, i) => { if (type === 3) dv.setUint16(i * 2, v, true); else dv.setUint32(i * 4, v >>> 0, true); });
    }
    return { tag, type, count, bytes };
  });
  const head = 2 + enc.length * 12 + 4; let dataLen = 0;
  for (const e of enc) if (e.bytes.length > 4) dataLen += e.bytes.length + (e.bytes.length & 1);
  const out = new Uint8Array(head + dataLen); const dv = new DataView(out.buffer);
  dv.setUint16(0, enc.length, true); let dp = head;
  enc.forEach((e, i) => {
    const o = 2 + i * 12; dv.setUint16(o, e.tag, true); dv.setUint16(o + 2, e.type, true); dv.setUint32(o + 4, e.count, true);
    if (e.bytes.length <= 4) out.set(e.bytes, o + 8);
    else { dv.setUint32(o + 8, offset + dp, true); out.set(e.bytes, dp); dp += e.bytes.length + (e.bytes.length & 1); }
  });
  dv.setUint32(2 + enc.length * 12, 0, true);
  return out;
}
