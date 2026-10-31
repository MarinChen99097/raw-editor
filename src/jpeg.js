// Streaming baseline JPEG encoder (4:4:4, 8-bit) with optional EXIF. Rows are fed incrementally so a full-size
// image never needs to live in memory at once (important on phones, and avoids canvas size limits).
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const QY = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const DC_L_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_C_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const AC_L_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_VALS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const AC_C_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALS = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

function huffTable(bits, vals) { // -> [code,len] indexed by symbol
  const t = []; let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) { for (let i = 0; i < bits[len - 1]; i++) { t[vals[k++]] = [code, len]; code++; } code <<= 1; }
  return t;
}
const COS = new Float32Array(64); for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) COS[u * 8 + x] = Math.cos((2 * x + 1) * u * Math.PI / 16) * (u === 0 ? Math.SQRT1_2 : 1) * 0.5;

class JpegEncoder {
  constructor(width, height, quality = 90, exif = null) {
    this.w = width; this.h = height;
    const q = quality < 50 ? 5000 / quality : 200 - quality * 2;
    const scale = b => Math.min(255, Math.max(1, Math.floor((b * q + 50) / 100)));
    this.qy = QY.map(scale); this.qc = QC.map(scale);
    const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];
    const fq = q => { const o = new Float32Array(64); for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) o[r * 8 + c] = 1 / (q[r * 8 + c] * AAN[r] * AAN[c] * 8); return o; };
    this.fqy = fq(this.qy); this.fqc = fq(this.qc);
    this.hdcL = huffTable(DC_L_BITS, DC_VALS); this.hdcC = huffTable(DC_C_BITS, DC_VALS);
    this.hacL = huffTable(AC_L_BITS, AC_L_VALS); this.hacC = huffTable(AC_C_BITS, AC_C_VALS);
    this.buf = new Uint8Array(1 << 20); this.pos = 0; this.bitBuf = 0; this.bitCnt = 0;
    this.pred = [0, 0, 0];
    this.pending = new Uint8Array(width * 8 * 4); this.pendRows = 0; this.rowsDone = 0;
    this.blk = new Float32Array(64); this.tmp = new Float32Array(64); this.coef = new Int32Array(64);
    this._header(exif);
  }
  _b(v) { if (this.pos >= this.buf.length) { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; } this.buf[this.pos++] = v; }
  _w16(v) { this._b((v >> 8) & 255); this._b(v & 255); }
  _bits(code, len) {
    this.bitBuf = (this.bitBuf << len) | code; this.bitCnt += len;
    while (this.bitCnt >= 8) { const b = (this.bitBuf >> (this.bitCnt - 8)) & 255; this._b(b); if (b === 255) this._b(0); this.bitCnt -= 8; }
    this.bitBuf &= (1 << this.bitCnt) - 1;
  }
  _header(exif) {
    this._w16(0xFFD8);
    if (exif) { const e = buildExif(exif, this.w, this.h); this._w16(0xFFE1); this._w16(e.length + 2); for (const b of e) this._b(b); }
    // DQT
    this._w16(0xFFDB); this._w16(132); this._b(0); for (let i = 0; i < 64; i++) this._b(this.qy[ZIGZAG[i]]); this._b(1); for (let i = 0; i < 64; i++) this._b(this.qc[ZIGZAG[i]]);
    // SOF0
    this._w16(0xFFC0); this._w16(17); this._b(8); this._w16(this.h); this._w16(this.w); this._b(3);
    this._b(1); this._b(0x11); this._b(0); this._b(2); this._b(0x11); this._b(1); this._b(3); this._b(0x11); this._b(1);
    // DHT
    const dht = (cls, id, bits, vals) => { this._w16(0xFFC4); this._w16(3 + 16 + vals.length); this._b((cls << 4) | id); for (const b of bits) this._b(b); for (const v of vals) this._b(v); };
    dht(0, 0, DC_L_BITS, DC_VALS); dht(1, 0, AC_L_BITS, AC_L_VALS); dht(0, 1, DC_C_BITS, DC_VALS); dht(1, 1, AC_C_BITS, AC_C_VALS);
    // SOS
    this._w16(0xFFDA); this._w16(12); this._b(3); this._b(1); this._b(0x00); this._b(2); this._b(0x11); this._b(3); this._b(0x11); this._b(0); this._b(63); this._b(0);
  }
  // rgba: Uint8Array/Uint8ClampedArray of `rows` rows × width × 4
  addRows(rgba, rows) {
    const W = this.w; let off = 0;
    while (rows > 0) {
      const take = Math.min(rows, 8 - this.pendRows);
      this.pending.set(rgba.subarray(off, off + take * W * 4), this.pendRows * W * 4);
      this.pendRows += take; rows -= take; off += take * W * 4;
      if (this.pendRows === 8) { this._mcuRow(); this.pendRows = 0; }
    }
  }
  _mcuRow() {
    const W = this.w, p = this.pending, blk = this.blk;
    const rowsValid = Math.min(8, this.h - this.rowsDone);
    for (let bx = 0; bx < W; bx += 8) {
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < 8; y++) {
          const yy = Math.min(y, rowsValid - 1);
          for (let x = 0; x < 8; x++) {
            const xx = Math.min(bx + x, W - 1), o = (yy * W + xx) * 4;
            const r = p[o], g = p[o + 1], b = p[o + 2];
            blk[y * 8 + x] = c === 0 ? 0.299 * r + 0.587 * g + 0.114 * b - 128 : c === 1 ? -0.168736 * r - 0.331264 * g + 0.5 * b : 0.5 * r - 0.418688 * g - 0.081312 * b;
          }
        }
        this._block(c);
      }
    }
    this.rowsDone += 8;
  }
  _block(c) {
    const d = this.blk, coef = this.coef, fq = c === 0 ? this.fqy : this.fqc;
    // AAN float forward DCT (IJG jfdctflt): rows then columns
    for (let p = 0; p < 2; p++) {
      const stride = p === 0 ? 1 : 8, step = p === 0 ? 8 : 1;
      for (let i = 0; i < 8; i++) {
        const o = i * step;
        const d0 = d[o], d1 = d[o + stride], d2 = d[o + 2 * stride], d3 = d[o + 3 * stride], d4 = d[o + 4 * stride], d5 = d[o + 5 * stride], d6 = d[o + 6 * stride], d7 = d[o + 7 * stride];
        const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        d[o] = t10 + t11; d[o + 4 * stride] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781;
        d[o + 2 * stride] = t13 + z1; d[o + 6 * stride] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        d[o + 5 * stride] = z13 + z2; d[o + 3 * stride] = z13 - z2; d[o + stride] = z11 + z4; d[o + 7 * stride] = z11 - z4;
      }
    }
    for (let i = 0; i < 64; i++) { const v = d[i] * fq[i]; coef[i] = v > 0 ? (v + 0.5) | 0 : -((-v + 0.5) | 0); }
    const hdc = c === 0 ? this.hdcL : this.hdcC, hac = c === 0 ? this.hacL : this.hacC;
    const dc = coef[0], diff = dc - this.pred[c]; this.pred[c] = dc;
    this._emit(hdc, 0, diff);
    let run = 0;
    for (let i = 1; i < 64; i++) {
      const v = coef[ZIGZAG[i]];
      if (v === 0) { run++; continue; }
      while (run > 15) { const z = hac[0xF0]; this._bits(z[0], z[1]); run -= 16; }
      this._emit(hac, run, v); run = 0;
    }
    if (run > 0) { const e = hac[0x00]; this._bits(e[0], e[1]); }
  }
  _emit(tbl, run, v) {
    let a = v < 0 ? -v : v, size = 0; while (a) { size++; a >>= 1; }
    const code = tbl[(run << 4) | size]; this._bits(code[0], code[1]);
    if (size) this._bits(v < 0 ? (v + (1 << size) - 1) & ((1 << size) - 1) : v, size);
  }
  finish() {
    if (this.pendRows > 0) { // pad remaining rows by replicating the last valid row
      const W = this.w; for (let y = this.pendRows; y < 8; y++) this.pending.copyWithin(y * W * 4, (this.pendRows - 1) * W * 4, this.pendRows * W * 4);
      this._mcuRow(); this.pendRows = 0;
    }
    if (this.bitCnt > 0) this._bits((1 << (8 - this.bitCnt)) - 1, 8 - this.bitCnt);
    this._w16(0xFFD9);
    return this.buf.subarray(0, this.pos);
  }
}

// Minimal EXIF (little-endian TIFF) builder: {make, model, software, dateTime, exposure, fnumber, iso, focal, lens}
function buildExif(x, w, h) {
  const enc = new TextEncoder();
  const asc = s => { const b = enc.encode(String(s || '')); const o = new Uint8Array(b.length + 1); o.set(b); return o; };
  const rat = (n, d = 1) => { const o = new DataView(new ArrayBuffer(8)); o.setUint32(0, n >>> 0, true); o.setUint32(4, d >>> 0, true); return new Uint8Array(o.buffer); };
  const toRat = v => { if (!v || !isFinite(v)) return rat(0, 1); if (v >= 1) return rat(Math.round(v * 1000), 1000); return rat(1, Math.round(1 / v)); };
  const ifd0 = [], exif = [];
  if (x.make) ifd0.push([0x010F, 2, asc(x.make)]);
  if (x.model) ifd0.push([0x0110, 2, asc(x.model)]);
  ifd0.push([0x0112, 3, 1]);
  if (x.software) ifd0.push([0x0131, 2, asc(x.software)]);
  if (x.dateTime) ifd0.push([0x0132, 2, asc(x.dateTime)]);
  ifd0.push([0x8769, 4, 0]); // Exif IFD pointer, patched below
  if (x.exposure) exif.push([0x829A, 5, toRat(x.exposure)]);
  if (x.fnumber) exif.push([0x829D, 5, toRat(x.fnumber)]);
  if (x.iso) exif.push([0x8827, 3, Math.round(x.iso)]);
  if (x.dateTime) exif.push([0x9003, 2, asc(x.dateTime)]);
  if (x.focal) exif.push([0x920A, 5, toRat(x.focal)]);
  exif.push([0xA001, 3, 1]); exif.push([0xA002, 4, w]); exif.push([0xA003, 4, h]);
  if (x.lens) exif.push([0xA434, 2, asc(x.lens)]);
  const isNum = e => e[1] === 3 || e[1] === 4;
  const count = e => isNum(e) || e[1] === 5 ? 1 : e[2].length;
  const ifdSize = n => 2 + n * 12 + 4;
  const offExif = 8 + ifdSize(ifd0.length);
  let cursor = offExif + ifdSize(exif.length);
  const offsets = new Map();
  for (const e of ifd0.concat(exif)) if (!isNum(e) && e[2].length > 4) { offsets.set(e, cursor); cursor += e[2].length + (e[2].length & 1); }
  const out = new Uint8Array(6 + cursor); const dv = new DataView(out.buffer);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0]); const base = 6; let p = base;
  out[p++] = 0x49; out[p++] = 0x49; dv.setUint16(p, 42, true); p += 2; dv.setUint32(p, 8, true); p += 4;
  const writeIFD = entries => {
    dv.setUint16(p, entries.length, true); p += 2;
    for (const e of entries) {
      dv.setUint16(p, e[0], true); dv.setUint16(p + 2, e[1], true); dv.setUint32(p + 4, count(e), true);
      if (e[0] === 0x8769) dv.setUint32(p + 8, offExif, true);
      else if (e[1] === 3) dv.setUint16(p + 8, e[2], true);
      else if (e[1] === 4) dv.setUint32(p + 8, e[2], true);
      else if (e[2].length <= 4) out.set(e[2], p + 8);
      else { dv.setUint32(p + 8, offsets.get(e), true); out.set(e[2], base + offsets.get(e)); }
      p += 12;
    }
    dv.setUint32(p, 0, true); p += 4;
  };
  writeIFD(ifd0); writeIFD(exif);
  return out;
}
