// Embedded lens-correction metadata (runs inside the decode worker, plain JS, no imports).
// Sony ARW  : tags 0x7037 / 0x7035 / 0x7032 in the raw SubIFD (DistortionCorrParams, ChromaticAberrationCorrParams, VignettingCorrParams)
// Fujifilm  : tags 0xf00b / 0xf00f / 0xf010 in the RAF "FujiIFD" (GeometricDistortionParams, ChromaticAberrationParams, VignettingParams)
// DNG       : OpcodeList3 WarpRectilinear (id 1) and FixVignetteRadial (id 3); also OpcodeList2 for vignetting
// Formulas follow darktable's lens module ("embedded metadata", algorithm v2).
const TIFF_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
function tiffWalk(ab, base, wanted, maxIFD = 40) {
  const dv = new DataView(ab); const n = ab.byteLength; const found = {};
  if (base + 8 > n) return found;
  const bo = dv.getUint16(base); let le;
  if (bo === 0x4949) le = true; else if (bo === 0x4d4d) le = false; else return found;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const seen = new Set(); let budget = maxIFD;
  const readVals = (type, count, off) => {
    const out = []; const sz = TIFF_SIZES[type] || 1;
    for (let i = 0; i < count && off + (i + 1) * sz <= n; i++) {
      const o = off + i * sz;
      switch (type) {
        case 1: case 7: out.push(dv.getUint8(o)); break; case 6: out.push(dv.getInt8(o)); break;
        case 3: out.push(u16(o)); break; case 8: out.push(dv.getInt16(o, le)); break;
        case 4: case 13: out.push(u32(o)); break; case 9: out.push(dv.getInt32(o, le)); break;
        case 5: { const d = u32(o + 4); out.push(d ? u32(o) / d : 0); break; }
        case 10: { const d = dv.getInt32(o + 4, le); out.push(d ? dv.getInt32(o, le) / d : 0); break; }
        case 11: out.push(dv.getFloat32(o, le)); break; case 12: out.push(dv.getFloat64(o, le)); break;
        default: out.push(dv.getUint8(o));
      }
    }
    return out;
  };
  const visit = (ifdRel, depth) => {
    while (ifdRel && budget-- > 0) {
      const ifd = base + ifdRel; if (ifd + 2 > n || seen.has(ifd)) return; seen.add(ifd);
      const cnt = u16(ifd); if (cnt > 1000 || ifd + 2 + cnt * 12 > n) return;
      const subs = [];
      for (let i = 0; i < cnt; i++) {
        const e = ifd + 2 + i * 12; const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const bytes = (TIFF_SIZES[type] || 1) * count; const valOff = bytes <= 4 ? e + 8 : base + u32(e + 8);
        if (tag === 0x14a || tag === 0x8769 || tag === 0xf000) { for (const v of readVals(type === 3 ? 3 : 4, Math.min(count, 8), valOff)) subs.push(v); continue; }
        if (wanted.includes(tag) && valOff + bytes <= n && count < 1e6) {
          const rec = { type, count, depth, le, off: valOff, bytes, ifd };
          rec.vals = (type === 7 || type === 1) && count > 64 ? null : readVals(type, Math.min(count, 4096), valOff);
          (found[tag] = found[tag] || []).push(rec);
        }
      }
      for (const s of subs) visit(s, depth + 1);
      if (ifd + 2 + cnt * 12 + 4 > n) return;
      ifdRel = u32(ifd + 2 + cnt * 12); depth = depth; // next IFD in chain keeps the same depth
    }
  };
  visit(u32(base + 4), 0);
  return found;
}
function pickTag(found, tag, preferDeep) {
  const l = found[tag]; if (!l || !l.length) return null;
  if (preferDeep) { const d = l.filter(r => r.depth > 0); if (d.length) return d[0]; }
  return l[0];
}
// DNG opcode lists are always big-endian
function parseOpcodes(ab, rec, res) {
  if (!rec) return; const dv = new DataView(ab, rec.off, rec.bytes); let n = dv.getUint32(0), o = 4;
  while (n-- > 0 && o + 16 <= rec.bytes) {
    const id = dv.getUint32(o), size = dv.getUint32(o + 12); const p = o + 16; if (p + size > rec.bytes) break;
    if (id === 1 && size >= 4) { // WarpRectilinear
      const planes = dv.getUint32(p); if ((planes === 1 || planes === 3) && size >= 4 + 8 * (planes * 6 + 2)) {
        res.warp = []; for (let k = 0; k < planes; k++) { const c = []; for (let i = 0; i < 6; i++) c.push(dv.getFloat64(p + 4 + 8 * (i + k * 6))); res.warp.push(c); }
        res.warpCenter = [dv.getFloat64(p + 4 + 8 * planes * 6), dv.getFloat64(p + 4 + 8 * (planes * 6 + 1))];
      }
    } else if (id === 3 && size >= 56) { // FixVignetteRadial
      res.vig = []; for (let i = 0; i < 5; i++) res.vig.push(dv.getFloat64(p + 8 * i));
      res.vigCenter = [dv.getFloat64(p + 40), dv.getFloat64(p + 48)];
    }
    o = p + size;
  }
}
// Fuji crop mode (1.25x sports finder) lives in the maker note of the embedded JPEG's EXIF.
function fujiCropMode(ab, jpgOff, jpgLen) {
  try {
    const dv = new DataView(ab); let o = jpgOff + 2; const end = Math.min(jpgOff + jpgLen, ab.byteLength);
    while (o + 4 < end) {
      const mk = dv.getUint16(o), len = dv.getUint16(o + 2);
      if (mk === 0xffe1 && dv.getUint32(o + 4) === 0x45786966) { // "Exif"
        const tb = o + 10; const f = tiffWalk(ab, tb, [0x927c]); const mn = pickTag(f, 0x927c);
        if (!mn) return 0; const mo = mn.off; // "FUJIFILM" + u32 LE offset to IFD (relative to maker note start), little-endian IFD
        if (String.fromCharCode(...new Uint8Array(ab, mo, 8)) !== 'FUJIFILM') return 0;
        const ifd = mo + dv.getUint32(mo + 8, true); const cnt = dv.getUint16(ifd, true);
        for (let i = 0; i < cnt; i++) { const e = ifd + 2 + i * 12; if (dv.getUint16(e, true) === 0x104d) return dv.getUint16(e + 8, true); }
        return 0;
      }
      if ((mk & 0xff00) !== 0xff00) return 0; o += 2 + len;
    }
  } catch { }
  return 0;
}
function readLensMeta(ab) {
  try {
    const u8 = new Uint8Array(ab, 0, Math.min(16, ab.byteLength)); const magic = String.fromCharCode(...u8);
    if (magic.startsWith('FUJIFILMCCD-RAW')) {
      const dv = new DataView(ab); const jpgOff = dv.getUint32(84), jpgLen = dv.getUint32(88), cfaOff = dv.getUint32(100);
      const f = tiffWalk(ab, cfaOff, [0xf00b, 0xf00f, 0xf010]);
      const d = pickTag(f, 0xf00b), c = pickTag(f, 0xf00f), v = pickTag(f, 0xf010);
      if (!d || !c || !v) return null;
      const D = d.vals, C = c.vals, V = v.vals; let nc, knots = [], dist = [], caR = [], caB = [], vig = [];
      if (D.length === 19 && C.length === 29 && V.length === 19) {
        nc = 9; for (let i = 0; i < nc; i++) { const k = D[i + 1]; if (Math.abs(k - C[i + 1]) > 1e-6 || Math.abs(k - V[i + 1]) > 1e-6) return null; knots.push(k); dist.push(D[i + 10]); caR.push(C[i + 10]); caB.push(C[i + 19]); vig.push(V[i + 10]); }
      } else if (D.length === 23 && C.length === 31 && V.length === 23) {
        nc = 11; for (let i = 0; i < nc; i++) { const k = D[i + 1]; const kc = i ? C[i] : 0; if (Math.abs(k - kc) > 1e-6 || Math.abs(k - V[i + 1]) > 1e-6) return null; knots.push(k); dist.push(D[i + 12]); caR.push(i ? C[i + 10] : 0); caB.push(i ? C[i + 20] : 0); vig.push(V[i + 12]); }
      } else return null;
      const cm = fujiCropMode(ab, jpgOff, jpgLen);
      return { type: 'fuji', knots, dist, caR, caB, vig, cropf: (cm === 2 || cm === 4) ? 1.25 : 1 };
    }
    const f = tiffWalk(ab, 0, [0x7037, 0x7035, 0x7032, 51009, 51022]);
    const d = pickTag(f, 0x7037, true), c = pickTag(f, 0x7035, true), v = pickTag(f, 0x7032, true);
    if (d && c && v) {
      const nc = d.vals[0];
      if (nc > 0 && nc <= 16 && c.vals[0] === 2 * nc && v.vals[0] === nc) {
        const r = { type: 'sony', dist: [], caR: [], caB: [], vig: [] };
        for (let i = 0; i < nc; i++) { r.dist.push(d.vals[i + 1]); r.caR.push(c.vals[i + 1]); r.caB.push(c.vals[nc + i + 1]); r.vig.push(v.vals[i + 1]); }
        return r;
      }
    }
    const res = {};
    parseOpcodes(ab, pickTag(f, 51022, true), res);
    if (!res.vig) parseOpcodes(ab, pickTag(f, 51009, true), res);
    if (res.warp || res.vig) return Object.assign({ type: 'dng' }, res);
  } catch (e) { }
  return null;
}
