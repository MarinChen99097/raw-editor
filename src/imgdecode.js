// Non-RAW photos (JPEG / HEIC / PNG / WebP / AVIF / TIFF): decoded by the browser itself, converted to the same
// 16-bit linear-sRGB RGB buffer that the LibRaw worker produces, so every edit tool works the same way.
// The browser applies EXIF orientation and converts wide-gamut (Display P3) photos to sRGB while drawing.
const IMG_EXT = /\.(jpe?g|jfif|png|webp|avif|heic|heif|gif|bmp|tiff?)$/i;
// iOS canvases are limited to about 16.7 megapixels, so large photos are rasterised in horizontal strips.
const CANVAS_MAX_AREA = 16000000;
const SRGB_TO_LIN16 = (() => { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = Math.round((c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) * 65535); } return t; })();

// true when the file should be decoded by the browser instead of LibRaw
async function isBrowserImage(file, rawExt) {
  if (rawExt.test(file.name)) return false;
  if (IMG_EXT.test(file.name)) return true;
  if (/^image\//.test(file.type || '')) return true;
  try {
    const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const s = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;            // JPEG
    if (s(1, 3) === 'PNG') return true;                                         // PNG
    if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return true;                  // WebP
    if (s(4, 4) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif|avis)$/.test(s(8, 4))) return true; // HEIF / AVIF
  } catch { }
  return false;
}

// Minimal EXIF reader: finds the "Exif\0\0" TIFF block (JPEG APP1, or the Exif item inside HEIC) in the first 1 MB.
async function readExifMeta(file) {
  const meta = {};
  try {
    const buf = await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer(); const u8 = new Uint8Array(buf);
    let p = -1;
    for (let i = 0; i < u8.length - 10; i++) if (u8[i] === 0x45 && u8[i + 1] === 0x78 && u8[i + 2] === 0x69 && u8[i + 3] === 0x66 && u8[i + 4] === 0 && u8[i + 5] === 0 && (u8[i + 6] === 0x49 || u8[i + 6] === 0x4d)) { p = i + 6; break; }
    if (p < 0) return meta;
    const dv = new DataView(buf, p); const n = buf.byteLength - p; const le = dv.getUint16(0) === 0x4949;
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    const SZ = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
    const readIFD = off => {
      const tags = {}; if (off + 2 > n) return tags; const cnt = u16(off); if (cnt > 500) return tags;
      for (let i = 0; i < cnt; i++) {
        const e = off + 2 + i * 12; if (e + 12 > n) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4), bytes = (SZ[type] || 1) * count, vo = bytes <= 4 ? e + 8 : u32(e + 8);
        if (vo + bytes > n) continue;
        if (type === 2) { let s = ''; for (let k = 0; k < count && dv.getUint8(vo + k); k++) s += String.fromCharCode(dv.getUint8(vo + k)); tags[tag] = s.trim(); }
        else if (type === 3) tags[tag] = u16(vo);
        else if (type === 4) tags[tag] = u32(vo);
        else if (type === 5 || type === 10) { const d = u32(vo + 4); tags[tag] = d ? (type === 10 ? dv.getInt32(vo, le) : u32(vo)) / d : 0; }
      }
      return tags;
    };
    const t0 = readIFD(u32(4)); const ex = t0[0x8769] ? readIFD(t0[0x8769]) : {};
    if (t0[0x10f]) meta.make = t0[0x10f]; if (t0[0x110]) meta.model = t0[0x110];
    if (ex[0x829a]) meta.shutter = ex[0x829a]; if (ex[0x829d]) meta.aperture = ex[0x829d];
    if (ex[0x8827]) meta.iso = ex[0x8827]; if (ex[0x920a]) meta.focal = ex[0x920a];
    if (ex[0xa434]) meta.lens = ex[0xa434];
    const dt = ex[0x9003] || t0[0x132];
    const m = dt && /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(dt);
    if (m) meta.timestamp = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000;
  } catch { }
  return meta;
}

async function loadImageElement(file) {
  const url = URL.createObjectURL(file); const img = new Image(); img.decoding = 'async';
  try { img.src = url; await img.decode(); }
  catch {
    URL.revokeObjectURL(url);
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/.test(file.type || '');
    throw new Error(heic ? '這個瀏覽器無法解碼 HEIC（Safari 可以；Chrome／Android 請先轉成 JPEG）' : '這個瀏覽器無法解碼這個圖片格式');
  }
  return { img, url };
}

// Rasterise img at tw×th into 16-bit linear RGB, strip by strip to stay under the canvas area limit.
async function rasterizeLinear(img, tw, th, onProgress) {
  const out = new Uint16Array(tw * th * 3);
  const sh = Math.max(1, Math.min(th, Math.floor(CANVAS_MAX_AREA / tw), 4096));
  const c = document.createElement('canvas'); c.width = tw; c.height = sh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  for (let y = 0; y < th; y += sh) {
    const h = Math.min(sh, th - y);
    g.clearRect(0, 0, tw, sh); g.drawImage(img, 0, -y, tw, th);
    const d = g.getImageData(0, 0, tw, h).data;
    for (let i = 0, o = y * tw * 3, n = tw * h * 4; i < n; i += 4, o += 3) { out[o] = SRGB_TO_LIN16[d[i]]; out[o + 1] = SRGB_TO_LIN16[d[i + 1]]; out[o + 2] = SRGB_TO_LIN16[d[i + 2]]; }
    if (onProgress && th > sh) { onProgress(`解碼圖片… ${Math.round(Math.min(1, (y + h) / th) * 100)}%`); await new Promise(r => setTimeout(r, 0)); }
  }
  c.width = c.height = 0; // release the canvas backing store right away (matters on iOS)
  return out;
}

function thumbFromImage(img, maxW = 240) {
  const W = img.naturalWidth, H = img.naturalHeight, s = Math.min(1, maxW / W);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.7); c.width = c.height = 0; return url;
}

// Same result shape as the LibRaw worker: {data, width, height, scale, meta, lensMD, timings}
// opts.half: preview decode (half size for photos above ~6 MP), opts.thumbOnly: metadata + thumbnail only.
async function decodeBrowserImage(file, opts = {}, onProgress) {
  const t0 = performance.now();
  const [meta, { img, url }] = await Promise.all([readExifMeta(file), loadImageElement(file)]);
  try {
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('圖片尺寸無效');
    Object.assign(meta, { width: W, height: H, flip: 0, kind: 'image', format: (/\.([a-z0-9]+)$/i.exec(file.name) || [, ''])[1].toUpperCase() || (file.type || '').replace('image/', '').toUpperCase() });
    if (opts.thumbOnly) return { meta, lensMD: null, thumbURL: thumbFromImage(img), timings: { total: performance.now() - t0 } };
    const scale = opts.half && W * H > 6e6 ? 2 : 1;
    const tw = Math.max(1, Math.round(W / scale)), th = Math.max(1, Math.round(H / scale));
    onProgress && onProgress('解碼圖片…');
    const data = await rasterizeLinear(img, tw, th, onProgress);
    const r = { data, width: tw, height: th, scale, meta, lensMD: null, timings: { total: performance.now() - t0 } };
    if (opts.wantThumb) r.thumbURL = thumbFromImage(img);
    return r;
  } finally { URL.revokeObjectURL(url); }
}
