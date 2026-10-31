// Fast path for Nikon lossless-compressed NEF (e.g. Z5 II, Z6 III, Zf ... 14-bit lossless).
// LibRaw's bit-by-bit Huffman decoder is very slow in WebAssembly (~25 s for 24 MP), so the worker decodes the
// compressed strip here (port of LibRaw::nikon_load_raw, lossless variant only) and hands LibRaw an equivalent
// *uncompressed* NEF: same file, raw IFD switched to Compression=1 with the 16-bit samples appended at the end.
// LibRaw then does everything else (black/white levels, colour matrix, WB, demosaic) exactly as before.
const NIKON_TREE = [
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 4, 3, 6, 2, 7, 1, 0, 8, 9, 11, 10, 12],
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0x39, 0x5a, 0x38, 0x27, 0x16, 5, 4, 3, 2, 1, 0, 11, 12, 12],
  [0, 1, 4, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10, 11, 12],          // 12-bit lossless
  [0, 1, 4, 3, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 5, 6, 4, 7, 8, 3, 9, 2, 1, 0, 10, 11, 12, 13, 14],
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 8, 0x5c, 0x4b, 0x3a, 0x29, 7, 6, 5, 4, 3, 2, 1, 0, 13, 14],
  [0, 1, 4, 2, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 7, 6, 8, 5, 9, 4, 10, 3, 11, 12, 2, 0, 1, 13, 14]]; // 14-bit lossless
function nikonMakeDecoder(src) {
  let max = 16; while (max && !src[max - 1]) max--;
  const huff = new Uint16Array(1 + (1 << max)); huff[0] = max;
  for (let h = 1, len = 1, si = 16; len <= max; len++)
    for (let i = 0; i < src[len - 1]; i++, si++)
      for (let j = 0; j < 1 << (max - len); j++) if (h <= 1 << max) huff[h++] = (len << 8) | src[si];
  return huff;
}
// Returns a new ArrayBuffer (uncompressed NEF) or null when the file is not a supported lossless NEF.
function nikonFastRepack(ab) {
  try {
    const u8 = new Uint8Array(ab); if (ab.byteLength < 1024) return null;
    const le = u8[0] === 0x49; if (!le && u8[0] !== 0x4d) return null;
    const f = tiffWalk(ab, 0, [0x10f, 0x100, 0x101, 0x102, 0x103, 0x111, 0x117, 0x927c]);
    const make = f[0x10f] && f[0x10f][0].vals ? String.fromCharCode(...f[0x10f][0].vals) : '';
    if (!/^NIKON/i.test(make)) return null;
    // raw IFD: compression 34713 with the largest width
    let raw = null;
    for (const c of f[0x103] || []) {
      if (c.vals[0] !== 34713) continue;
      const w = (f[0x100] || []).find(r => r.ifd === c.ifd), h = (f[0x101] || []).find(r => r.ifd === c.ifd), b = (f[0x102] || []).find(r => r.ifd === c.ifd);
      const so = (f[0x111] || []).find(r => r.ifd === c.ifd), sc = (f[0x117] || []).find(r => r.ifd === c.ifd);
      if (!w || !h || !b || !so || !sc || so.count !== 1 || sc.count !== 1) continue;
      if (!raw || w.vals[0] > raw.w) raw = { w: w.vals[0], h: h.vals[0], bps: b.vals[0], comp: c, so, sc, data: so.vals[0], bytes: sc.vals[0] };
    }
    if (!raw || (raw.bps !== 14 && raw.bps !== 12)) return null;
    const mn = f[0x927c] && f[0x927c][0]; if (!mn) return null;
    if (String.fromCharCode(...u8.subarray(mn.off, mn.off + 5)) !== 'Nikon') return null;
    const m = tiffWalk(ab, mn.off + 10, [0x96]); const lin = m[0x96] && m[0x96][0]; if (!lin) return null;
    const dv = new DataView(ab); let mo = lin.off;
    const ver0 = u8[mo], ver1 = u8[mo + 1]; mo += 2;
    if (ver0 !== 0x46) return null;                 // lossless only (lossy needs the linearisation curve / split)
    if (ver0 === 0x49 || ver1 === 0x58) mo += 2110;
    const vpred = [[dv.getUint16(mo, le), dv.getUint16(mo + 2, le)], [dv.getUint16(mo + 4, le), dv.getUint16(mo + 6, le)]];
    const W = raw.w, H = raw.h, max = (1 << raw.bps) & 0x7fff;
    const huff = nikonMakeDecoder(NIKON_TREE[raw.bps === 14 ? 5 : 2]); const hb = huff[0];
    // output: original file + aligned uncompressed strip
    const base = (ab.byteLength + 15) & ~15, outLen = base + W * H * 2;
    const out = new ArrayBuffer(outLen); new Uint8Array(out).set(u8);
    const px = new Uint16Array(out, base, W * H); // host is little-endian; NEF byte order must match
    if (!le) return null;
    let pos = raw.data; const end = Math.min(u8.length, raw.data + raw.bytes + 8);
    let bitbuf = 0, vbits = 0; const hp = [0, 0];
    for (let row = 0, o = 0; row < H; row++) {
      for (let col = 0; col < W; col++, o++) {
        while (vbits < hb) { bitbuf = ((bitbuf << 8) | (pos < end ? u8[pos] : 0)) >>> 0; pos++; vbits += 8; }
        const hv = huff[((bitbuf << (32 - vbits)) >>> (32 - hb)) + 1]; vbits -= hv >> 8;
        const i = hv & 255, len = i & 15, shl = i >> 4, nb = len - shl;
        let g = 0;
        if (nb > 0) { while (vbits < nb) { bitbuf = ((bitbuf << 8) | (pos < end ? u8[pos] : 0)) >>> 0; pos++; vbits += 8; } g = (bitbuf << (32 - vbits)) >>> (32 - nb); vbits -= nb; }
        let diff = (((g << 1) + 1) << shl) >> 1;
        if (len > 0 && (diff & (1 << (len - 1))) === 0) diff -= (1 << len) - (shl ? 0 : 1);
        let v;
        if (col < 2) { v = vpred[row & 1][col] = (vpred[row & 1][col] + diff) & 0xffff; hp[col] = v; }
        else v = hp[col & 1] = (hp[col & 1] + diff) & 0xffff;
        const sv = (v << 16) >> 16; px[o] = sv < 0 ? 0 : sv > 0x3fff ? 0x3fff : sv;
      }
    }
    if (pos > raw.data + raw.bytes + 64) return null; // ran past the strip: corrupt or unexpected format
    // patch the raw IFD entries in the copy: Compression=1, StripOffsets=base, StripByteCounts=W*H*2
    const o = new DataView(out);
    const put = (rec, v) => { if (rec.type === 3) o.setUint16(rec.off, v, rec.le); else o.setUint32(rec.off, v, rec.le); };
    if (raw.so.type === 3 || raw.sc.type === 3) return null;
    put(raw.comp, 1); put(raw.so, base); put(raw.sc, W * H * 2);
    return out;
  } catch (e) { return null; }
}
