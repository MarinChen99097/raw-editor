// ===== RAW Editor main program =====
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined) e.setAttribute(k, v); } for (const k of kids) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k)); return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const IS_TOUCH = matchMedia('(pointer:coarse)').matches;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const LOW_MEM = IS_IOS || (navigator.deviceMemory && navigator.deviceMemory <= 4);
const app = $('#app');
function layout() { app.classList.toggle('desktop', innerWidth >= 900 && innerWidth > innerHeight); }
layout(); addEventListener('resize', () => { layout(); fitCanvas(); requestDraw(); });

// ---------- toast / status ----------
let toastT; function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }
function status(msg) { const s = $('#status'); if (!msg) { s.classList.remove('on'); return; } s.textContent = msg; s.classList.add('on'); }

// ---------- decoder worker ----------
function b64ToBuf(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
const WASM = b64ToBuf(WASM_B64);
// compile LibRaw once; every decode worker instantiates the shared compiled module (no recompilation per file)
let WASM_MODULE = null; const wasmModuleP = WebAssembly.compile(WASM).then(m => (WASM_MODULE = m)).catch(() => null);
const workerURL = URL.createObjectURL(new Blob([$('#workersrc').textContent], { type: 'text/javascript' }));
class Decoder {
  constructor() { this.w = null; this.pending = new Map(); this.nid = 1; }
  async init() {
    if (this.w) return;
    this.w = new Worker(workerURL);
    this.w.onmessage = ({ data }) => { const p = this.pending.get(data.id); if (!p) return; if (data.progress !== undefined) { p.onProgress && p.onProgress(data.progress); return; } this.pending.delete(data.id); data.ok ? p.res(data) : p.rej(new Error(data.error)); };
    this.w.onerror = e => { for (const p of this.pending.values()) p.rej(new Error('Worker 錯誤：' + (e.message || e))); this.pending.clear(); };
    await wasmModuleP;
    let info;
    try { info = await this.call('init', { wasm: WASM_MODULE || WASM.slice(0) }, [], null, true); }
    catch (e) { if (!WASM_MODULE) throw e; info = await this.call('init', { wasm: WASM.slice(0) }, [], null, true); } // fallback if modules can't be posted

    this.version = info.version; this.cameras = info.cameras;
  }
  call(cmd, payload, transfer, onProgress) {
    const id = this.nid++;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, onProgress }); this.w.postMessage({ id, cmd, ...payload }, transfer); });
  }
  terminate() { if (this.w) { this.w.terminate(); this.w = null; } for (const p of this.pending.values()) p.rej(new Error('cancelled')); this.pending.clear(); }
}
let decoder = new Decoder();
async function decodeFile(file, opts, onProgress) {
  if (file._isImage === undefined) file._isImage = await isBrowserImage(file, RAW_EXT);
  if (file._isImage) return decodeBrowserImage(file, opts, onProgress);
  // fresh worker per decode so the wasm heap is released afterwards (important on phones)
  const d = new Decoder(); await d.init();
  try {
    const buf = await file.arrayBuffer();
    return await d.call('decode', { buffer: buf, name: file.name, opts }, [buf], onProgress);
  } finally { d.terminate(); }
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (m.includes('JXL_DNG')) return '這張 ProRAW 用 JPEG-XL 壓縮，瀏覽器版 LibRaw 解不開。請到 iPhone「設定 > 相機 > 格式 > ProRAW 格式」改選「JPEG」後再拍。';
  if (/Unsupported file format|not RAW file/i.test(m)) return '不是支援的 RAW 或圖片格式（' + m + '）';
  return m;
}

// ---------- state ----------
const images = []; let cur = -1;
const state = { zoom: 1, panX: 0, panY: 0, compare: 0, split: 0.5, cropMode: false, tab: 'light', hq: false, hist: true, clipboard: null, previewData: null, busy: false,
  maskSel: -1, showMask: false, tool: { size: 20, feather: 60, flow: 100, erase: false }, cursor: null };
const TOOL_DEFAULTS = { size: 20, feather: 60, flow: 100 };
// JPEG/HEIC/PNG were already sharpened and denoised in the camera, so they start without the RAW capture sharpening / colour NR.
const IMG_DEFAULTS = Object.assign(clone(DEFAULTS), { sharpen: 0, nrColor: 0 });
const defaultsFor = imOrFile => { const f = imOrFile && (imOrFile.file || imOrFile); return f && f._isImage ? IMG_DEFAULTS : DEFAULTS; };
let renderer; try { renderer = new Renderer($('#view')); } catch (e) { $('#drop').innerHTML = '<h1>無法啟動</h1><p>' + e.message + '</p>'; throw e; }
const curveEd = new CurveEditor(document.createElement('canvas'), () => { onCurveChange(); });
const CUR = () => images[cur];
const imgKey = f => f.name + '|' + f.size + '|' + f.lastModified;
const userPresets = JSON.parse(localStorage.getItem('rawedit:presets') || '[]');
try { state.hq = localStorage.getItem('rawedit:hq') === '1'; state.hist = localStorage.getItem('rawedit:hist') !== '0'; } catch { }

// ---------- geometry ----------
const M = (a, b, c, d, e, f) => [a, b, 0, c, d, 0, e, f, 1];
function mmul(A, B) { const o = new Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = A[r] * B[c * 3] + A[3 + r] * B[c * 3 + 1] + A[6 + r] * B[c * 3 + 2]; return o; }
function mapPt(m, x, y) { return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]; }
// Returns {outW,outH,m, Wr,Hr, frame:mat (frame px -> full px)} for params.geo over a full image W×H
function geometry(geo, W, H, ignoreCrop = false) {
  const k = ((geo.rot % 4) + 4) % 4; const Wr = k % 2 ? H : W, Hr = k % 2 ? W : H;
  const Rinv = [M(1, 0, 0, 1, 0, 0), M(0, -1, 1, 0, 0, H), M(-1, 0, 0, -1, W, H), M(0, 1, -1, 0, W, 0)][k];
  let F = M(1, 0, 0, 1, 0, 0); if (geo.flipH) F = mmul(F, M(-1, 0, 0, 1, Wr, 0)); if (geo.flipV) F = mmul(F, M(1, 0, 0, -1, 0, Hr));
  const a = geo.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const s = Math.cos(Math.abs(a)) + (Math.max(Wr, Hr) / Math.min(Wr, Hr)) * Math.sin(Math.abs(a));
  const Cx = Wr / 2, Cy = Hr / 2;
  const S = M(ca / s, sa / s, -sa / s, ca / s, Cx - (ca * Cx - sa * Cy) / s, Cy - (sa * Cx + ca * Cy) / s);
  const frame = mmul(Rinv, mmul(F, S));
  const c = ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : geo.crop;
  const outW = Math.max(8, Math.round(c.w * Wr)), outH = Math.max(8, Math.round(c.h * Hr));
  const m = mmul(frame, M(1, 0, 0, 1, c.x * Wr, c.y * Hr));
  return { outW, outH, m, Wr, Hr, frame };
}

// ---------- lens correction ----------
// darktable-style linear spline: clamp to end values outside the knot range
function spline(xs, ys, x) {
  if (x < xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x >= xs[i - 1] && x <= xs[i]) { const d = xs[i] - xs[i - 1]; return d > 0 ? ys[i - 1] + (x - xs[i - 1]) * (ys[i] - ys[i - 1]) / d : ys[i]; }
  return ys[ys.length - 1];
}
// Build the 32-knot table used by the shader. md = embedded metadata from the worker (or null), L = params.lens.
// Distortion/CA splines map a destination radius r (half-diagonal = 1) to the source/dest ratio, as in darktable (embedded metadata v2).
function buildLensTable(md, L, W, H) {
  const fd = (L.dist ?? 100) / 100, fv = (L.vig ?? 100) / 100, useCA = L.ca !== false;
  let kd = null, cor = null, kv = null, vv = null;
  if (L.auto && md) {
    if (md.type === 'sony') {
      const nc = md.dist.length; kd = []; cor = [[], [], []]; kv = []; vv = [];
      for (let i = 0; i < nc; i++) {
        const k = (i + 0.5) / (nc - 1); kd.push(k); kv.push(k);
        const d = fd * md.dist[i] * Math.pow(2, -14) + 1;
        cor[0].push(d * (useCA ? md.caR[i] * Math.pow(2, -21) + 1 : 1)); cor[1].push(d); cor[2].push(d * (useCA ? md.caB[i] * Math.pow(2, -21) + 1 : 1));
        vv.push(Math.pow(2, 0.5 - Math.pow(2, fv * md.vig[i] * Math.pow(2, -13) - 1)));
      }
    } else if (md.type === 'fuji') {
      const kin = [], cin = [], rin_ = [], bin = []; kv = []; vv = [];
      if (md.knots[0] > 0) { kin.push(0); cin.push(1); rin_.push(0); bin.push(0); kv.push(0); vv.push(1); }
      md.knots.forEach((k, i) => { const kk = md.cropf * k; kin.push(kk); cin.push(fd * md.dist[i] / 100 + 1); rin_.push(useCA ? md.caR[i] : 0); bin.push(useCA ? md.caB[i] : 0); kv.push(kk); vv.push(1 - fv * (1 - md.vig[i] / 100)); });
      kd = []; cor = [[], [], []];
      for (let i = 0; i < 16; i++) { const rin = i / 15, m = spline(kin, cin, rin); kd.push(rin / m); cor[1].push(m); cor[0].push(m * (spline(kin, rin_, rin) + 1)); cor[2].push(m * (spline(kin, bin, rin) + 1)); }
    } else if (md.type === 'dng') {
      kd = []; cor = [[], [], []]; kv = []; vv = [];
      for (let i = 0; i < 16; i++) {
        const r = i / 15, r2 = r * r, r4 = r2 * r2, r6 = r4 * r2; kd.push(r); kv.push(r);
        for (let c = 0; c < 3; c++) { const w = md.warp ? md.warp[md.warp.length === 3 && useCA ? c : (md.warp.length === 3 ? 1 : 0)] : null; cor[c].push(w ? fd * (w[0] + w[1] * r2 + w[2] * r4 + w[3] * r6 - 1) + 1 : 1); }
        if (md.vig) { const v = md.vig; const dv = v[0] * r2 + v[1] * r4 + v[2] * r6 + v[3] * r4 * r4 + v[4] * r4 * r6; vv.push(1 / (1 + fv * dv)); } else vv.push(1);
      }
    }
  }
  const k = (L.manDist || 0) / 100 * 0.12, mv = (L.manVig || 0) / 100;
  const caR = 1 + (L.caR || 0) / 100 * 0.003, caB = 1 + (L.caB || 0) / 100 * 0.003;
  const f = (c, r) => (kd ? spline(kd, cor[c], r) : 1) * (1 - k * r * r) * (c === 0 ? caR : c === 2 ? caB : 1);
  const on = !!(kd || kv || k || mv || L.caR || L.caB);
  // autoscale so no empty corners appear (max ratio between the short-edge midpoint and the corner)
  const hw = W / 2, hh = H / 2, srr = Math.min(hw, hh) / Math.hypot(hw, hh);
  let s = 0; for (let i = 0; i < 200; i++) { const x = srr + (1 - srr) * i / 199; for (let c = 0; c < 3; c++) s = Math.max(s, f(c, x)); }
  if (!(s > 0.5 && s < 2)) s = 1;
  const vgain = rs => { let g = 1; if (kv) g /= Math.max(1e-4, spline(kv, vv, rs)); if (mv) g *= Math.pow(2, mv * rs * rs * (0.6 + 0.4 * rs * rs)); return g; };
  const T = new Float32Array(128);
  for (let i = 0; i < 32; i++) { const rho = i / 31 * 1.3, r = rho / s, g = f(1, r); T[i * 4] = g / s; T[i * 4 + 1] = vgain(rho); T[i * 4 + 2] = f(0, r) / g; T[i * 4 + 3] = f(2, r) / g; }
  return { on, table: T, scale: s };
}
function lensFor(im, L) {
  const W = im.fullW || 1, H = im.fullH || 1; const key = JSON.stringify(L) + W + 'x' + H + (im.lensMD ? im.lensMD.type : '-');
  if (im._lensKey !== key) { im._lensKey = key; im._lens = buildLensTable(im.lensMD, L, W, H); }
  return im._lens;
}
const MASK_TYPES = { linear: 0, radial: 1, brush: 2 };
function packMasks(U, masks) {
  const n = Math.min(8, masks.length); U.nMasks = n; if (!n) return;
  const A = () => new Float32Array(32); U.mG1 = A(); U.mG2 = A(); U.mA = A(); U.mB = A(); U.mC = A(); U.mD = A();
  const d = MASK_DEFAULTS;
  for (let i = 0; i < n; i++) {
    const m = masks[i], a = Object.assign({}, d.adj, m.adj), o = i * 4, t = MASK_TYPES[m.type] ?? 0;
    if (t === 0) U.mG1.set([m.x0, m.y0, m.x1, m.y1], o); else if (t === 1) U.mG1.set([m.cx, m.cy, m.rx, m.ry], o);
    U.mG2.set([t === 1 ? (m.angle || 0) * Math.PI / 180 : t === 2 ? m.ch : 0, (m.feather ?? d.feather) / 100, m.invert ? 1 : 0, t], o);
    U.mA.set([a.exposure, a.contrast / 100, a.highlights / 100, a.shadows / 100], o);
    U.mB.set([a.whites / 100, a.blacks / 100, a.temp / 100, a.tint / 100], o);
    U.mC.set([a.saturation / 100, a.clarity / 100, a.dehaze / 100, a.texture / 100], o);
    U.mD.set([a.sharpen / 100, (m.lumLo ?? 0) / 100, (m.lumHi ?? 100) / 100, m.hidden ? 0 : (m.opacity ?? 100) / 100], o);
    if (t === 2) U.useBrush = true;
    if (a.sharpen || a.texture) U.maskDetail = true;
  }
}

// ---------- uniforms ----------
// im (optional) supplies the lens metadata and image size; opts.export disables the on-screen mask overlay.
function uniformsFromParams(p, im, opts = {}) {
  const U = baseUniforms(p);
  if (im) { const L = lensFor(im, p.lens || DEFAULTS.lens); U.lensOn = L.on; U.lens = L.table; U.defringe = ((p.lens && p.lens.defringe) || 0) / 100; }
  packMasks(U, p.masks || []);
  { const f = p.film; if (f && f.id && f.amount > 0) { U.lutId = f.id; U.lutAmt = f.amount / 100; if (filmLUTState !== 'ready') loadFilmLUTs(); } }
  U.showMask = (!opts.export && im && im === CUR() && state.tab === 'local' && state.showMask && state.maskSel >= 0 && state.maskSel < U.nMasks) ? state.maskSel : -1;
  U.clipWarn = !opts.export && im && im === CUR() && state.clipWarn ? 1 : 0;
  return U;
}
// Colour-grading hue sliders use ordinary RGB hue (0 red, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta, as drawn on
// the slider and as in Lightroom). The shader works in OkLab, so convert to the OkLab hue angle of that RGB colour.
const OK_HUE = (() => {
  const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const t = [];
  for (let i = 0; i < 360; i++) {
    const h = i / 60, x = 1 - Math.abs(h % 2 - 1); const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
    const R = lin(r), G = lin(g), B = lin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    const n = Math.hypot(A, Bb); t.push([A / n, Bb / n]);
  }
  return t;
})();
function okHueRad(deg) { // interpolate unit vectors so the 359 -> 0 wrap is smooth
  const d = ((deg % 360) + 360) % 360, i = Math.floor(d), f = d - i, a = OK_HUE[i], b = OK_HUE[(i + 1) % 360];
  return Math.atan2(a[1] + (b[1] - a[1]) * f, a[0] + (b[0] - a[0]) * f);
}
function baseUniforms(p) {
  const t = p.temp / 100, ti = p.tint / 100;
  let wb = [1 + 0.45 * t, 1 - 0.25 * ti, 1 - 0.45 * t]; wb = wb.map(v => Math.max(0.05, v));
  const L = 0.2126 * wb[0] + 0.7152 * wb[1] + 0.0722 * wb[2]; wb = wb.map(v => v / L);
  const g = r => { const a = okHueRad(r.h || 0), s = (r.s || 0) / 100 * 0.12; return [(r.l || 0) / 100 * 0.15, s * Math.cos(a), s * Math.sin(a)]; };
  const hsl = []; for (let i = 0; i < 8; i++) hsl.push(p.hsl.h[i] / 100, p.hsl.s[i] / 100, p.hsl.l[i] / 100);
  return {
    exposure: Math.pow(2, p.exposure), wb,
    contrast: p.contrast / 100, highlights: p.highlights / 100, shadows: p.shadows / 100, whites: p.whites / 100, blacks: p.blacks / 100,
    vibrance: p.vibrance / 100, saturation: p.saturation / 100, hsl, bw: p.bw ? 1 : 0, bwmix: p.bwmix.map(v => v / 100),
    gradeS: g(p.grade.s), gradeM: g(p.grade.m), gradeH: g(p.grade.h), gradeBalance: p.grade.balance / 100,
    clarity: p.clarity / 100, dehaze: p.dehaze / 100, texture: p.texture / 100,
    sharpen: [p.sharpen / 100, p.sharpenRadius], nr: [p.nrLum / 100, p.nrColor / 100],
    vignette: [p.vignette / 100, p.vigMid / 100, p.vigFeather / 100], grain: [p.grain / 100, p.grainSize / 100], fade: p.fade / 100,
    gradeG: g(p.grade.g || {}), gradeBlend: (p.grade.blend ?? 50) / 100,
    calib: calibMatrix(p.calib), shadowTint: ((p.calib && p.calib.shadow) || 0) / 100,
    vig2: [(p.vigRound || 0) / 100, (p.vigHi || 0) / 100], grainRough: (p.grainRough ?? 50) / 100, sharpMask: (p.sharpenMask || 0) / 100,
  };
}
const DEFAULT_U = uniformsFromParams(defaultParams());

// ---------- UI schema ----------
const fmt = { ev: v => (v > 0 ? '+' : '') + v.toFixed(2), int: v => (v > 0 ? '+' : '') + Math.round(v), pos: v => Math.round(v), dec: v => v.toFixed(1), deg: v => Math.round(v) + '°' };
const TABS = [
  { id: 'light', name: '光線' }, { id: 'color', name: '顏色' }, { id: 'hsl', name: 'HSL' }, { id: 'curve', name: '曲線' }, { id: 'grade', name: '色調' },
  { id: 'local', name: '局部' }, { id: 'fx', name: '效果' }, { id: 'detail', name: '細節' }, { id: 'lens', name: '鏡頭' }, { id: 'crop', name: '裁切' }, { id: 'presets', name: '預設' }, { id: 'info', name: '資訊' },
];
const SL = {
  light: [['exposure', '曝光', -5, 5, 0.01, fmt.ev], ['contrast', '對比', -100, 100, 1, fmt.int], ['highlights', '亮部', -100, 100, 1, fmt.int], ['shadows', '暗部', -100, 100, 1, fmt.int], ['whites', '白色', -100, 100, 1, fmt.int], ['blacks', '黑色', -100, 100, 1, fmt.int]],
  color: [['temp', '色溫', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#3f78ff,#888,#ffb347)'], ['tint', '色調', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#4fd64f,#888,#ff5cc8)'], ['vibrance', '鮮豔度', -100, 100, 1, fmt.int], ['saturation', '飽和度', -100, 100, 1, fmt.int]],
  fx: [['clarity', '清晰度', -100, 100, 1, fmt.int], ['texture', '紋理', -100, 100, 1, fmt.int], ['dehaze', '去朦朧', -100, 100, 1, fmt.int], ['fade', '褪色（霧面）', 0, 100, 1, fmt.pos], ['vignette', '暈影', -100, 100, 1, fmt.int], ['vigMid', '暈影中點', 0, 100, 1, fmt.pos], ['vigFeather', '暈影羽化', 0, 100, 1, fmt.pos], ['vigRound', '暈影圓度', -100, 100, 1, fmt.int], ['vigHi', '亮部優先', 0, 100, 1, fmt.pos], ['grain', '顆粒', 0, 100, 1, fmt.pos], ['grainSize', '顆粒大小', 0, 100, 1, fmt.pos], ['grainRough', '顆粒粗糙度', 0, 100, 1, fmt.pos]],
  detail: [['sharpen', '銳利化', 0, 150, 1, fmt.pos], ['sharpenRadius', '銳利化半徑', 1, 3, 0.1, fmt.dec], ['sharpenMask', '銳利化遮色（只銳化邊緣）', 0, 100, 1, fmt.pos], ['nrLum', '明度降噪', 0, 100, 1, fmt.pos], ['nrColor', '色彩降噪', 0, 100, 1, fmt.pos]],
};
const sliders = new Map(); // path -> {update()}
const getPath = (o, path) => path.split('.').reduce((a, k) => a[k], o);
const setPath = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

// Slider paths: 'M.xxx' -> active local mask, 'T.xxx' -> brush tool settings, otherwise image params.
function sliderTarget(path) {
  if (path.startsWith('M.')) return [activeMask(), path.slice(2), MASK_DEFAULTS];
  if (path.startsWith('T.')) return [state.tool, path.slice(2), TOOL_DEFAULTS];
  return [CUR() ? CUR().params : null, path, defaultsFor(CUR())];
}
function makeSlider(path, label, min, max, step, format, grad) {
  const [, sub0, defs] = sliderTarget(path); const def = getPath(defs, sub0);
  const root = el('div', { class: 'sl' + (grad ? ' colorful' : ''), style: grad ? `--grad:${grad}` : '' });
  const lbl = el('span', { class: 'lbl' }, label), val = el('span', { class: 'val' });
  const track = el('div', { class: 'track' }), fill = el('div', { class: 'fill' }), knob = el('div', { class: 'knob' });
  track.append(fill, knob); root.append(lbl, val, track);
  const update = () => {
    const [obj, sub] = sliderTarget(path); let v = def; try { if (obj) v = getPath(obj, sub) ?? def; } catch { }
    val.textContent = format(v); val.classList.toggle('changed', Math.abs(v - def) > 1e-9);
    const t = (v - min) / (max - min), d = (def - min) / (max - min);
    knob.style.left = (t * 100) + '%'; fill.style.left = (Math.min(t, d) * 100) + '%'; fill.style.width = (Math.abs(t - d) * 100) + '%';
  };
  let dragging = false, startX = 0, startV = 0, moved = false, lastTap = 0;
  const setFromClient = (cx, fine) => { const r = track.getBoundingClientRect(); let v = min + clamp((cx - r.left) / r.width, 0, 1) * (max - min); v = Math.round(v / step) * step; setParam(path, +v.toFixed(4), false); };
  track.addEventListener('pointerdown', e => {
    const [obj, sub] = sliderTarget(path); if (!CUR() || !obj) return; e.preventDefault(); track.setPointerCapture(e.pointerId); dragging = true; moved = false; startX = e.clientX; startV = getPath(obj, sub) ?? def;
    const now = Date.now(); if (now - lastTap < 320) { setParam(path, def, true); dragging = false; lastTap = 0; return; } lastTap = now;
  });
  track.addEventListener('pointermove', e => {
    if (!dragging) return; const dx = e.clientX - startX; if (Math.abs(dx) > 2) moved = true;
    if (!moved) return;
    const r = track.getBoundingClientRect(); const fine = e.shiftKey ? 0.2 : 1; const dv = dx / r.width * (max - min) * fine;
    let v = clamp(startV + dv, min, max); v = Math.round(v / step) * step; setParam(path, +v.toFixed(4), false);
  });
  const up = e => { if (!dragging) return; dragging = false; if (!moved) { setFromClient(e.clientX); } commit(); };
  track.addEventListener('pointerup', up); track.addEventListener('pointercancel', () => { if (dragging) { dragging = false; commit(); } });
  lbl.addEventListener('dblclick', () => setParam(path, def, true));
  sliders.set(path, { update, root }); update();
  return root;
}
function setParam(path, v, doCommit) {
  const im = CUR(); if (!im) return;
  if (path.startsWith('T.')) { setPath(state.tool, path.slice(2), v); const s = sliders.get(path); if (s) s.update(); drawOverlay(); return; }
  if (path.startsWith('M.')) {
    const m = activeMask(); if (!m) return; setPath(m, path.slice(2), v); const s = sliders.get(path); if (s) s.update();
    if (path.startsWith('M.adj.') && state.showMask) { state.showMask = false; refreshLocalUI(); } // show the effect, not the red overlay, while adjusting
    requestRender(true); if (doCommit) commit(); else { clearTimeout(setParam.t); setParam.t = setTimeout(() => updateMaskChips(), 200); } return;
  }
  setPath(im.params, path, v);
  const s = sliders.get(path); if (s) s.update();
  if (path === '_presetAmount') { if (im.presetObj && im.presetId) applyPresetUI(im.presetObj, im.presetId, true); return; }
  if (path.startsWith('pcurve.')) renderer.setCurveLUT(curveLUTFor(im.params));
  if (path.startsWith('geo')) { requestRender(false); } else requestRender(true);
  if (doCommit) commit();
}
function hdr(title, ...btns) { return el('div', { class: 'hdr' }, el('span', {}, title), el('span', {}, ...btns)); }

function buildPanels() {
  const tabs = $('#tabs'), panel = $('#panel');
  for (const t of TABS) {
    tabs.append(el('button', { 'data-tab': t.id, onclick: () => selectTab(t.id) }, t.name));
    const sec = el('div', { class: 'sec', id: 'sec-' + t.id }); panel.append(sec);
    if (SL[t.id]) { sec.append(hdr(t.name, el('button', { onclick: () => resetGroup(SL[t.id].map(s => s[0])) }, '重設'))); for (const s of SL[t.id]) sec.append(makeSlider(...s)); }
    if (t.id === 'color') {
      const wbBar = el('div', { class: 'toolbar wbbar' }, el('span', { class: 'hint' }, '白平衡'),
        el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.temp = 0; im.params.tint = 0; refreshAll(); commit(); } }, '原廠'),
        el('button', { onclick: () => autoWB() }, '自動'),
        el('button', { id: 'wbPick', onclick: () => { state.pickWB = !state.pickWB; $('#wbPick').classList.toggle('on', state.pickWB); if (state.pickWB) toast('點一下照片中原本應該是白色或灰色的地方', 3500); } }, '吸管'));
      sec.insertBefore(wbBar, sec.children[1]);
      sec.append(hdr('黑白'));
      const bwBtn = el('button', { id: 'bwToggle', onclick: () => { setParam('bw', !CUR().params.bw, true); refreshBW(); } }, '轉為黑白');
      sec.append(el('div', { class: 'toolbar' }, bwBtn));
      const mix = el('div', { id: 'bwmix' }); sec.append(mix);
      HSL_NAMES.forEach((n, i) => mix.append(makeSlider('bwmix.' + i, n + '色亮度', -100, 100, 1, fmt.int, `linear-gradient(90deg,#222,${HSL_COLORS[i]})`)));
    }
    if (t.id === 'color') {
      const CK = ['calib.shadow', 'calib.rh', 'calib.rs', 'calib.gh', 'calib.gs', 'calib.bh', 'calib.bs'];
      sec.append(hdr('相機校正', el('button', { onclick: () => resetGroup(CK) }, '重設')));
      sec.append(makeSlider('calib.shadow', '陰影色調', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#4fd64f,#888,#ff5cc8)'));
      for (const [c, n, g1, g2] of [['r', '紅', '#ff4fa0', '#ffa040'], ['g', '綠', '#c8e040', '#40e0b0'], ['b', '藍', '#40c8ff', '#9a60ff']]) {
        sec.append(makeSlider(`calib.${c}h`, n + '原色 色相', -100, 100, 1, fmt.int, `linear-gradient(90deg,${g1},${g2})`));
        sec.append(makeSlider(`calib.${c}s`, n + '原色 飽和度', -100, 100, 1, fmt.int));
      }
    }
    if (t.id === 'hsl') {
      sec.append(hdr('HSL / 顏色', el('button', { onclick: () => { for (const c of 'hsl') for (let i = 0; i < 8; i++) setPath(CUR().params, `hsl.${c}.${i}`, 0); refreshAll(); commit(); } }, '重設')));
      const bands = el('div', { class: 'hslbands' }); sec.append(bands);
      let band = 0; const mode = el('div', { class: 'seg' }); let modeSel = 'all';
      const rows = el('div');
      const render = () => {
        rows.innerHTML = '';
        if (modeSel === 'all') {
          const names = ['色相', '飽和度', '明度'];
          'hsl'.split('').forEach((c, ci) => rows.append(makeSlider(`hsl.${c}.${band}`, HSL_NAMES[band] + ' ' + names[ci], -100, 100, 1, fmt.int, ci === 0 ? hueGrad(band) : ci === 1 ? `linear-gradient(90deg,#777,${HSL_COLORS[band]})` : `linear-gradient(90deg,#111,${HSL_COLORS[band]},#fff)`)));
        } else {
          HSL_NAMES.forEach((n, i) => rows.append(makeSlider(`hsl.${modeSel}.${i}`, n, -100, 100, 1, fmt.int, modeSel === 'h' ? hueGrad(i) : modeSel === 's' ? `linear-gradient(90deg,#777,${HSL_COLORS[i]})` : `linear-gradient(90deg,#111,${HSL_COLORS[i]},#fff)`)));
        }
        [...bands.children].forEach((b, i) => b.classList.toggle('on', i === band && modeSel === 'all'));
        [...mode.children].forEach(b => b.classList.toggle('on', b.dataset.m === modeSel));
      };
      HSL_COLORS.forEach((c, i) => bands.append(el('button', { style: `background:${c}`, title: HSL_NAMES[i], onclick: () => { band = i; modeSel = 'all'; render(); } })));
      [['all', '單色'], ['h', '色相'], ['s', '飽和度'], ['l', '明度']].forEach(([m, n]) => mode.append(el('button', { 'data-m': m, onclick: () => { modeSel = m; render(); } }, n)));
      sec.append(el('div', { class: 'row', style: 'margin:6px 0' }, mode), rows); render();
    }
    if (t.id === 'curve') {
      sec.append(hdr('色調曲線', el('button', { onclick: () => curveEd.reset() }, '重設此通道')));
      const seg = el('div', { class: 'seg' });
      [['rgb', 'RGB'], ['r', '紅'], ['g', '綠'], ['b', '藍']].forEach(([c, n]) => seg.append(el('button', { 'data-c': c, class: c === 'rgb' ? 'on' : '', onclick: () => { curveEd.channel = c; [...seg.children].forEach(b => b.classList.toggle('on', b.dataset.c === c)); curveEd.draw(); } }, n)));
      curveEd.cv.id = 'curvecv';
      sec.append(el('div', { class: 'row', style: 'margin:6px 0' }, seg), curveEd.cv, el('div', { class: 'hint' }, '點擊新增控制點、拖曳調整；快速連點兩下控制點可刪除。'));
      const PC = ['pcurve.hi', 'pcurve.li', 'pcurve.da', 'pcurve.sh', 'pcurve.s1', 'pcurve.s2', 'pcurve.s3'];
      sec.append(hdr('區域曲線', el('button', { onclick: () => resetGroup(PC) }, '重設')));
      for (const [k, n] of [['hi', '亮部'], ['li', '亮調'], ['da', '暗調'], ['sh', '陰影']]) sec.append(makeSlider('pcurve.' + k, n, -100, 100, 1, fmt.int));
      for (const [k, n] of [['s1', '分界：陰影／暗調'], ['s2', '分界：暗調／亮調'], ['s3', '分界：亮調／亮部']]) sec.append(makeSlider('pcurve.' + k, n, 5, 95, 1, fmt.pos));
      sec.append(el('div', { class: 'hint' }, '區域曲線先套用，上面的點曲線再疊在它之上（和 Lightroom 一樣）。'));
    }
    if (t.id === 'grade') {
      sec.append(hdr('色調分離 / 分級', el('button', { onclick: () => { CUR().params.grade = clone(DEFAULTS.grade); refreshAll(); commit(); } }, '重設')));
      for (const [r, n] of [['s', '陰影'], ['m', '中間調'], ['h', '亮部']]) {
        sec.append(hdr(n));
        sec.append(makeSlider(`grade.${r}.h`, '色相', 0, 360, 1, fmt.deg, 'linear-gradient(90deg,#f66,#fc6,#cf6,#6f9,#6ff,#69f,#c6f,#f6c,#f66)'));
        sec.append(makeSlider(`grade.${r}.s`, '飽和度', 0, 100, 1, fmt.pos));
        sec.append(makeSlider(`grade.${r}.l`, '明度', -100, 100, 1, fmt.int));
      }
      sec.append(hdr('整體色輪'));
      sec.append(makeSlider('grade.g.h', '色相', 0, 360, 1, fmt.deg, 'linear-gradient(90deg,#f66,#fc6,#cf6,#6f9,#6ff,#69f,#c6f,#f6c,#f66)'));
      sec.append(makeSlider('grade.g.s', '飽和度', 0, 100, 1, fmt.pos)); sec.append(makeSlider('grade.g.l', '明度', -100, 100, 1, fmt.int));
      sec.append(hdr('混合與平衡')); sec.append(makeSlider('grade.blend', '混合（區域重疊）', 0, 100, 1, fmt.pos));
      sec.append(makeSlider('grade.balance', '平衡（陰影 ↔ 亮部）', -100, 100, 1, fmt.int));
    }
    if (t.id === 'local') buildLocalPanel(sec);
    if (t.id === 'lens') buildLensPanel(sec);
    if (t.id === 'crop') buildCropPanel(sec);
    if (t.id === 'presets') buildPresetPanel(sec);
    if (t.id === 'info') {
      sec.append(el('div', { class: 'info', id: 'infobox' }, '尚未開啟照片。'));
      sec.append(hdr('快照', el('button', { onclick: addSnapshot }, '＋ 建立快照')), el('div', { class: 'histlist', id: 'snapList' }));
      sec.append(hdr('歷史紀錄'), el('div', { class: 'histlist', id: 'histList' }));
    }
  }
  selectTab('light');
}
function hueGrad(i) { const c = HSL_COLORS; return `linear-gradient(90deg,${c[(i + 7) % 8]},${c[i]},${c[(i + 1) % 8]})`; }
function selectTab(id) {
  state.tab = id; [...$('#tabs').children].forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  [...$('#panel').children].forEach(s => s.classList.toggle('on', s.id === 'sec-' + id));
  { // keep the active tab visible by scrolling only the tab bar (scrollIntoView could also shift ancestors)
    const bar = $('#tabs'), tb = bar.querySelector(`[data-tab="${id}"]`);
    if (tb && (tb.offsetLeft < bar.scrollLeft || tb.offsetLeft + tb.offsetWidth > bar.scrollLeft + bar.clientWidth)) bar.scrollTo({ left: tb.offsetLeft - (bar.clientWidth - tb.offsetWidth) / 2, behavior: 'smooth' });
  }
  const wasLocal = !!selectTab.prevLocal; selectTab.prevLocal = id === 'local';
  const wasCrop = state.cropMode; state.cropMode = id === 'crop'; state.cursor = null;
  $('#side').classList.toggle('tall', id === 'curve' || id === 'hsl' || id === 'presets');
  if (id === 'curve') setTimeout(() => curveEd.draw(), 0);
  if (id === 'presets') schedulePresetThumbs();
  if (id === 'info') renderHistoryUI();
  if (wasCrop !== state.cropMode) { if (!state.cropMode) commit(); fitView(); requestRender(false); }
  else if (CUR() && wasLocal !== (id === 'local') && state.showMask && state.maskSel >= 0) requestRender(false); // red mask overlay on/off
  else drawOverlay(); // handles / crop frame only
  fitCanvas();
}
function resetGroup(keys) { const im = CUR(); if (!im) return; for (const k of keys) setPath(im.params, k, getPath(defaultsFor(im), k)); refreshAll(); commit(); }
function refreshBW() { const im = CUR(); const on = im && im.params.bw; const b = $('#bwToggle'); if (b) { b.classList.toggle('on', !!on); b.textContent = on ? '黑白：開（點擊關閉）' : '轉為黑白'; } $('#bwmix').style.display = on ? '' : 'none'; }
function refreshAll() { refreshLocalUI(); refreshLensUI(); for (const s of sliders.values()) s.update(); refreshBW(); if (CUR()) { curveEd.setCurves(CUR().params.curves); renderer.setCurveLUT(curveLUTFor(CUR().params)); } renderHistoryUI(); refreshCropUI(); refreshPresetUI(); requestRender(false); }

// ---------- local adjustments panel ----------
const MASK_NAMES = { linear: '線性漸層', radial: '放射狀', brush: '筆刷' };
const MASK_ICON = { linear: '▤', radial: '◎', brush: '✎' };
let localUI = {};
const activeMask = () => { const im = CUR(); return im && state.maskSel >= 0 ? im.params.masks[state.maskSel] || null : null; };
function buildLocalPanel(sec) {
  sec.append(hdr('局部調整', el('button', { onclick: () => { const im = CUR(); if (!im || !im.params.masks.length) return; if (!confirm('刪除這張照片的全部遮罩？')) return; im.params.masks = []; state.maskSel = -1; refreshAll(); commit(); } }, '全部刪除')));
  sec.append(el('div', { class: 'toolbar addmask' },
    el('button', { onclick: () => addMask('linear') }, '＋ ▤ 線性漸層'), el('button', { onclick: () => addMask('radial') }, '＋ ◎ 放射狀'), el('button', { onclick: () => addMask('brush') }, '＋ ✎ 筆刷')));
  localUI.chips = el('div', { class: 'chips maskchips' }); sec.append(localUI.chips);
  localUI.empty = el('div', { class: 'hint' }, '新增遮罩後，只有遮罩範圍內會套用下方的調整。線性漸層適合天空，放射狀適合主體或暗角，筆刷可以自由塗抹。');
  sec.append(localUI.empty);
  const ed = el('div', { class: 'maskedit' }); localUI.ed = ed; sec.append(ed);
  localUI.ops = el('div', { class: 'toolbar' },
    localUI.btnShow = el('button', { onclick: () => { state.showMask = !state.showMask; refreshLocalUI(); requestRender(false); } }, '顯示遮罩'),
    localUI.btnHide = el('button', { onclick: () => { const m = activeMask(); if (!m) return; m.hidden = !m.hidden; refreshLocalUI(); requestRender(false); commit(); } }, '停用'),
    localUI.btnInv = el('button', { onclick: () => { const m = activeMask(); if (!m) return; m.invert = !m.invert; refreshLocalUI(); requestRender(false); commit(); } }, '反轉'),
    el('button', { onclick: dupMask }, '複製'),
    el('button', { class: 'danger', onclick: delMask }, '刪除'));
  ed.append(localUI.ops);
  // geometry / brush tools
  localUI.geoRadial = el('div', {}, makeSlider('M.feather', '羽化', 0, 100, 1, fmt.pos), makeSlider('M.angle', '角度', -90, 90, 1, fmt.deg),
    el('div', { class: 'hint' }, '拖曳中心移動；拖曳邊上的圓點調整大小與角度。'));
  localUI.geoLinear = el('div', { class: 'hint' }, '實心圓點是效果最強處，空心圓點是效果消失處；拖曳中間的小圓點移動整條漸層。');
  const seg = el('div', { class: 'seg' }); localUI.brushSeg = seg;
  for (const [er, n] of [[false, '✎ 畫筆'], [true, '⌫ 橡皮擦']]) seg.append(el('button', { 'data-e': er ? 1 : 0, onclick: () => { state.tool.erase = er; refreshLocalUI(); } }, n));
  localUI.geoBrush = el('div', {}, el('div', { class: 'row', style: 'margin:6px 0;gap:8px' }, seg, el('button', { onclick: () => { const m = activeMask(); if (!m || !m.strokes.length) return; m.strokes = []; requestRender(false); commit(); } }, '清除筆觸')),
    makeSlider('T.size', '筆刷大小', 1, 100, 1, fmt.pos), makeSlider('T.feather', '筆刷羽化', 0, 100, 1, fmt.pos), makeSlider('T.flow', '流量', 5, 100, 1, fmt.pos),
    el('div', { class: 'hint' }, IS_TOUCH ? '單指塗抹，雙指縮放／移動畫面。' : '拖曳塗抹，滾輪縮放；按住空白鍵或用滑鼠中鍵拖曳可移動畫面。'));
  ed.append(localUI.geoRadial, localUI.geoLinear, localUI.geoBrush);
  ed.append(hdr('調整', el('button', { onclick: () => { const m = activeMask(); if (!m) return; m.adj = clone(MASK_DEFAULTS.adj); refreshAll(); commit(); } }, '重設')));
  const AS = [['exposure', '曝光', -4, 4, 0.01, fmt.ev], ['contrast', '對比'], ['highlights', '亮部'], ['shadows', '暗部'], ['whites', '白色'], ['blacks', '黑色'],
    ['temp', '色溫', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#3f78ff,#888,#ffb347)'], ['tint', '色調', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#4fd64f,#888,#ff5cc8)'],
    ['saturation', '飽和度'], ['clarity', '清晰度'], ['dehaze', '去朦朧'], ['texture', '紋理'], ['sharpen', '銳利度']];
  for (const [k, n, mn = -100, mx = 100, st = 1, f = fmt.int, g] of AS) ed.append(makeSlider('M.adj.' + k, n, mn, mx, st, f, g));
  ed.append(hdr('範圍'));
  ed.append(makeSlider('M.lumLo', '亮度範圍：下限', 0, 100, 1, fmt.pos, 'linear-gradient(90deg,#000,#fff)'), makeSlider('M.lumHi', '亮度範圍：上限', 0, 100, 1, fmt.pos, 'linear-gradient(90deg,#000,#fff)'), makeSlider('M.opacity', '遮罩強度', 0, 100, 1, fmt.pos));
}
function updateMaskChips() {
  const im = CUR(); const box = localUI.chips; if (!box) return; box.innerHTML = '';
  const ms = im ? im.params.masks : [];
  ms.forEach((m, i) => box.append(el('button', { class: (i === state.maskSel ? 'on' : '') + (m.hidden ? ' off' : ''), onclick: () => selectMask(i) }, `${MASK_ICON[m.type]} ${i + 1} ${MASK_NAMES[m.type]}${m.invert ? '（反轉）' : ''}`)));
}
function refreshLocalUI() {
  if (!localUI.ed) return; const im = CUR();
  if (im && state.maskSel >= im.params.masks.length) state.maskSel = im.params.masks.length - 1;
  const m = activeMask();
  updateMaskChips();
  localUI.ed.style.display = m ? '' : 'none'; localUI.empty.style.display = m ? 'none' : '';
  if (!m) return;
  localUI.geoRadial.style.display = m.type === 'radial' ? '' : 'none'; localUI.geoLinear.style.display = m.type === 'linear' ? '' : 'none'; localUI.geoBrush.style.display = m.type === 'brush' ? '' : 'none';
  localUI.btnShow.classList.toggle('on', state.showMask); localUI.btnHide.classList.toggle('on', !!m.hidden); localUI.btnHide.textContent = m.hidden ? '已停用' : '停用'; localUI.btnInv.classList.toggle('on', !!m.invert);
  [...localUI.brushSeg.children].forEach(b => b.classList.toggle('on', (b.dataset.e === '1') === !!state.tool.erase));
  for (const [k, s] of sliders) if (k.startsWith('M.')) s.update();
}
function selectMask(i) { state.maskSel = i; state.cursor = null; refreshLocalUI(); requestRender(false); }
function newId() { return Math.random().toString(36).slice(2, 9); }
function addMask(type) {
  const im = CUR(); if (!im || !im.fullW) return; const ms = im.params.masks;
  if (ms.length >= 8) { toast('最多 8 個遮罩'); return; }
  const G = currentGeometry(), Lm = Math.max(im.fullW, im.fullH);
  const iso = (fx, fy) => { const p = mapPt(G.m, fx * G.outW, fy * G.outH); return [p[0] / Lm, p[1] / Lm]; };
  const m = Object.assign(clone(MASK_DEFAULTS), { id: newId(), type });
  if (type === 'linear') { const a = iso(0.5, 0.15), b = iso(0.5, 0.55); Object.assign(m, { x0: a[0], y0: a[1], x1: b[0], y1: b[1] }); }
  else if (type === 'radial') { const c = iso(0.5, 0.5), e = iso(0.5 + 0.22 * Math.min(G.outW, G.outH) / G.outW, 0.5); const r = Math.hypot(e[0] - c[0], e[1] - c[1]); Object.assign(m, { cx: c[0], cy: c[1], rx: r * 1.25, ry: r, angle: 0 }); }
  else { const used = new Set(ms.filter(x => x.type === 'brush').map(x => x.ch)); const ch = [0, 1, 2, 3].find(c => !used.has(c)); if (ch === undefined) { toast('最多 4 個筆刷遮罩'); return; } Object.assign(m, { ch, strokes: [] }); }
  ms.push(m); state.maskSel = ms.length - 1; state.showMask = true;
  refreshAll(); commit();
  toast(type === 'brush' ? '在照片上塗抹要調整的區域' : '拖曳圓點調整範圍，再調整下方滑桿');
}
function dupMask() {
  const im = CUR(), m = activeMask(); if (!m) return; const ms = im.params.masks; if (ms.length >= 8) { toast('最多 8 個遮罩'); return; }
  const c = clone(m); c.id = newId();
  if (c.type === 'brush') { const used = new Set(ms.filter(x => x.type === 'brush').map(x => x.ch)); const ch = [0, 1, 2, 3].find(k => !used.has(k)); if (ch === undefined) { toast('最多 4 個筆刷遮罩'); return; } c.ch = ch; }
  ms.splice(state.maskSel + 1, 0, c); state.maskSel++; refreshAll(); commit();
}
function delMask() { const im = CUR(); if (!activeMask()) return; im.params.masks.splice(state.maskSel, 1); state.maskSel = Math.min(state.maskSel, im.params.masks.length - 1); refreshAll(); commit(); }

// ---------- lens panel ----------
let lensUI = {};
function buildLensPanel(sec) {
  sec.append(hdr('鏡頭校正', el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.lens = clone(DEFAULTS.lens); refreshAll(); commit(); } }, '重設')));
  lensUI.info = el('div', { class: 'info lensinfo' }); sec.append(lensUI.info);
  lensUI.auto = el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.lens.auto = !im.params.lens.auto; refreshAll(); commit(); } }, '');
  lensUI.ca = el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.lens.ca = !(im.params.lens.ca !== false); refreshAll(); commit(); } }, '色差校正');
  sec.append(el('div', { class: 'toolbar' }, lensUI.auto, lensUI.ca));
  lensUI.autoBox = el('div', {}, makeSlider('lens.dist', '扭曲校正量', 0, 150, 1, v => Math.round(v) + '%'), makeSlider('lens.vig', '暗角校正量', 0, 150, 1, v => Math.round(v) + '%'));
  sec.append(lensUI.autoBox);
  sec.append(hdr('手動校正'));
  sec.append(makeSlider('lens.manDist', '扭曲（＋修正桶狀）', -100, 100, 1, fmt.int), makeSlider('lens.manVig', '暗角（＋提亮四角）', -100, 100, 1, fmt.int),
    makeSlider('lens.caR', '色差：紅／青', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#3fd0d0,#888,#ff4d4d)'), makeSlider('lens.caB', '色差：藍／黃', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#ffe04d,#888,#4d7cff)'),
    makeSlider('lens.defringe', '去紫邊', 0, 100, 1, fmt.pos, 'linear-gradient(90deg,#777,#a35cff)'));
  sec.append(el('div', { class: 'hint' }, 'Sony、Fujifilm 與帶校正資料的 DNG 會自動讀取相機內嵌的鏡頭描述檔（扭曲、暗角、色差）。Nikon、Ricoh 等沒有內嵌資料的檔案請用手動校正。放大到 100% 檢查邊緣色差最準。'));
}
function refreshLensUI() {
  if (!lensUI.info) return; const im = CUR(); const L = im ? im.params.lens : DEFAULTS.lens; const md = im && im.lensMD;
  const names = { sony: 'Sony 內嵌鏡頭描述檔', fuji: 'Fujifilm 內嵌鏡頭描述檔', dng: 'DNG 內嵌校正（OpcodeList）' };
  lensUI.info.textContent = !im ? '尚未開啟照片。' : md ? `偵測到：${names[md.type]}${im.meta && im.meta.lens ? '（' + im.meta.lens + '）' : ''}` : (im.lensMD === null ? '這個檔案沒有內嵌鏡頭校正資料，請使用下方手動校正。' : '讀取中…');
  lensUI.auto.textContent = L.auto ? '自動校正：開' : '自動校正：關'; lensUI.auto.classList.toggle('on', !!L.auto); lensUI.auto.disabled = !md;
  lensUI.ca.classList.toggle('on', L.ca !== false); lensUI.ca.disabled = !md || !L.auto;
  lensUI.autoBox.style.opacity = md && L.auto ? '' : '.45'; lensUI.autoBox.style.pointerEvents = md && L.auto ? '' : 'none';
}


// ---------- crop panel ----------
const ASPECTS = [['free', '自由'], ['orig', '原始'], ['1:1', '1:1'], ['3:2', '3:2'], ['4:3', '4:3'], ['16:9', '16:9'], ['4:5', '4:5'], ['5:7', '5:7']];
let cropUI = {};
function buildCropPanel(sec) {
  sec.append(hdr('裁切與旋轉', el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.geo = clone(DEFAULTS.geo); refreshAll(); fitView(); commit(); } }, '重設')));
  const tools = el('div', { class: 'croptools' },
    el('button', { onclick: () => rot(-1) }, '↺ 逆時針 90°'), el('button', { onclick: () => rot(1) }, '↻ 順時針 90°'),
    el('button', { id: 'flipH', onclick: () => { CUR().params.geo.flipH = !CUR().params.geo.flipH; refreshAll(); commit(); } }, '⇋ 水平翻轉'),
    el('button', { id: 'flipV', onclick: () => { CUR().params.geo.flipV = !CUR().params.geo.flipV; refreshAll(); commit(); } }, '⇅ 垂直翻轉'));
  sec.append(tools);
  sec.append(makeSlider('geo.angle', '拉直角度', -45, 45, 0.1, v => v.toFixed(1) + '°'));
  sec.append(hdr('長寬比'));
  const chips = el('div', { class: 'chips' }); cropUI.chips = chips;
  for (const [k, n] of ASPECTS) chips.append(el('button', { 'data-a': k, onclick: () => setAspect(k) }, n));
  chips.append(el('button', { onclick: () => { const g = CUR().params.geo; g.aspectSwap = !g.aspectSwap; setAspect(g.aspect); } }, '⟲ 直/橫'));
  sec.append(chips, el('div', { class: 'hint' }, '在畫面上拖曳邊框或角落調整裁切範圍，拖曳中間可移動。'));
  function rot(d) { const im = CUR(); if (!im) return; const g = im.params.geo; g.rot = (g.rot + d + 4) % 4; const c = g.crop; g.crop = d > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }; refreshAll(); fitView(); commit(); }
}
function aspectValue(g, Wr, Hr) {
  let a = null; if (g.aspect === 'orig') a = Wr / Hr; else if (g.aspect && g.aspect !== 'free') { const [x, y] = g.aspect.split(':').map(Number); a = x / y; }
  if (a && g.aspectSwap) a = 1 / a; return a;
}
function setAspect(k) {
  const im = CUR(); if (!im) return; const g = im.params.geo; g.aspect = k;
  const G = geometry(g, im.fullW, im.fullH, true); const a = aspectValue(g, G.Wr, G.Hr);
  if (a) { // fit a centred rect of this aspect inside current crop
    const c = g.crop; const cw = c.w * G.Wr, ch = c.h * G.Hr; let nw = cw, nh = cw / a; if (nh > ch) { nh = ch; nw = ch * a; }
    g.crop = { x: c.x + (cw - nw) / 2 / G.Wr, y: c.y + (ch - nh) / 2 / G.Hr, w: nw / G.Wr, h: nh / G.Hr };
  }
  refreshAll(); commit();
}
function refreshCropUI() { const im = CUR(); if (!im || !cropUI.chips) return; const g = im.params.geo; [...cropUI.chips.children].forEach(b => b.classList.toggle('on', b.dataset.a === g.aspect)); $('#flipH').classList.toggle('on', g.flipH); $('#flipV').classList.toggle('on', g.flipV); }

// ---------- camera calibration ----------
// Red/green/blue primaries rotated towards their neighbours (hue) and pushed from/to grey (saturation) in linear RGB, then
// rows rescaled so white stays white. Returns a column-major mat3.
function calibMatrix(k) {
  if (!k || !(k.rh || k.rs || k.gh || k.gs || k.bh || k.bs)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const f = v => (v || 0) / 100, Y = [0.2126, 0.7152, 0.0722], H = 0.35;
  const rh = f(k.rh), gh = f(k.gh), bh = f(k.bh);
  const P = [ // red: + towards orange/yellow, - towards magenta; green: + towards cyan, - towards yellow; blue: + towards purple, - towards cyan
    [1, Math.max(0, rh) * H, Math.max(0, -rh) * H],
    [Math.max(0, -gh) * H, 1, Math.max(0, gh) * H],
    [Math.max(0, bh) * H, Math.max(0, -bh) * H, 1]];
  [f(k.rs), f(k.gs), f(k.bs)].forEach((s, i) => { const p = P[i], y = p[0] * Y[0] + p[1] * Y[1] + p[2] * Y[2]; for (let c = 0; c < 3; c++) p[c] = y + (p[c] - y) * (1 + s * 0.6); });
  const w = [0, 1, 2].map(r => P[0][r] + P[1][r] + P[2][r]);
  const m = []; for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m.push(P[c][r] / w[r]);
  return m;
}

// ---------- tone curve LUT: parametric (region) curve, then the point curves ----------
function paramCurve(x, pc) {
  if (!pc || !(pc.hi || pc.li || pc.da || pc.sh)) return x;
  const sp = [pc.s1 ?? 25, pc.s2 ?? 50, pc.s3 ?? 75].map(v => Math.min(0.95, Math.max(0.05, v / 100))).sort((a, b) => a - b);
  const edges = [0, sp[0], sp[1], sp[2], 1], amt = [pc.sh, pc.da, pc.li, pc.hi].map(v => (v || 0) / 100);
  let y = x;
  for (let i = 0; i < 4; i++) {
    if (!amt[i]) continue;
    const a = edges[i], b = edges[i + 1], c = (a + b) / 2, hw = Math.max(b - a, 0.05); // raised-cosine bump spanning the region and half of each neighbour
    const t = (x - c) / hw; if (Math.abs(t) >= 1) continue;
    y += amt[i] * 0.22 * (0.5 + 0.5 * Math.cos(Math.PI * t)) * Math.sqrt(Math.max(0, 4 * x * (1 - x))); // ends stay pinned
  }
  return y;
}
function curveLUTFor(p) {
  const L = ['rgb', 'r', 'g', 'b'].map(k => curveLUT(p.curves[k]));
  const o = new Float32Array(256 * 4); let prev = 0;
  for (let i = 0; i < 256; i++) {
    let y = Math.min(1, Math.max(prev, paramCurve(i / 255, p.pcurve))); prev = y; // monotone: no tonal inversions
    const fpos = y * 255, j = Math.min(254, Math.floor(fpos)), t = fpos - j;
    o[i * 4] = L[0][j] * (1 - t) + L[0][j + 1] * t;
    for (let c = 1; c < 4; c++) o[i * 4 + c] = L[c][i];
  }
  return o;
}

// ---------- white balance: eyedropper and auto ----------
// temp/tint (-100..100) that make linear (R,G,B) neutral with the editor's WB model wb = [1+0.45t, 1-0.25ti, 1-0.45t]
function wbFromRGB(R, G, B) {
  const q = B / Math.max(R, 1e-6), t = (q - 1) / (0.45 * (q + 1));
  const ti = (1 - (R / Math.max(G, 1e-6)) * (1 + 0.45 * t)) / 0.25;
  const cl = v => Math.round(Math.max(-100, Math.min(100, v * 100)));
  return [cl(t), cl(ti), Math.abs(t) > 1 || Math.abs(ti) > 1];
}
function previewSample(cx, cy, r) { // mean linear RGB of the decoded preview around full-image px (cx, cy)
  const pd = state.previewData; if (!pd) return null;
  const px = Math.round(cx / pd.scale), py = Math.round(cy / pd.scale); let R = 0, G = 0, B = 0, n = 0, clip = 0;
  for (let y = py - r; y <= py + r; y++) for (let x = px - r; x <= px + r; x++) {
    if (x < 0 || y < 0 || x >= pd.w || y >= pd.h) continue; const i = (y * pd.w + x) * 3;
    const a = pd.data[i], b = pd.data[i + 1], c = pd.data[i + 2]; if (Math.max(a, b, c) > 64000) { clip++; continue; }
    R += a; G += b; B += c; n++;
  }
  return n ? { R: R / n, G: G / n, B: B / n, clip } : { clip };
}
function applyWB(t, ti, out) {
  const im = CUR(); if (!im) return; im.params.temp = t; im.params.tint = ti; refreshAll(); commit();
  toast(out ? `白平衡已設為 色溫 ${t}、色調 ${ti}（超出範圍，已到滑桿極限）` : `白平衡：色溫 ${t > 0 ? '+' : ''}${t}、色調 ${ti > 0 ? '+' : ''}${ti}`);
}
function pickWBAt(e) {
  const im = CUR(); if (!im || !state.previewData) return;
  const [sx, sy] = canvasPt(e); const iso = canvasToIso(sx, sy), Lm = Math.max(im.fullW, im.fullH);
  const s = previewSample(iso[0] * Lm, iso[1] * Lm, 4);
  if (!s || !s.R) { toast(s && s.clip ? '這裡過曝了，請點一個沒有過曝的白色或灰色區域' : '請點在照片上'); return; }
  const [t, ti, out] = wbFromRGB(s.R, s.G, s.B);
  state.pickWB = false; const b = $('#wbPick'); if (b) b.classList.remove('on');
  applyWB(t, ti, out);
}
// Auto white balance: grey-world over mid tones, ignoring clipped and very dark pixels and the most saturated colours.
function autoWB() {
  const im = CUR(), pd = state.previewData; if (!im || !pd || pd.imId !== im.id) return;
  const d = pd.data, n = pd.w * pd.h, step = Math.max(1, Math.floor(n / 200000)); let R = 0, G = 0, B = 0, k = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 3, r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 62000 || mx < 1500 || (mx - mn) / mx > 0.6) continue;
    R += r; G += g; B += b; k++;
  }
  if (k < 100) { toast('這張照片沒有足夠的中性區域可以自動判斷'); return; }
  const [t, ti, out] = wbFromRGB(R / k, G / k, B / k); applyWB(t, ti, out);
}
$('#histo').addEventListener('click', () => {
  state.clipWarn = !state.clipWarn; $('#histo').classList.toggle('clip', state.clipWarn);
  toast(state.clipWarn ? '剪裁警告：開（紅色＝亮部過曝，藍色＝暗部全黑）' : '剪裁警告：關'); requestRender(false);
});

// ---------- history list and snapshots ----------
const PARAM_NAMES = (() => {
  const o = { hsl: 'HSL', curves: '點曲線', pcurve: '區域曲線', grade: '色調分級', masks: '局部調整', lens: '鏡頭校正', geo: '裁切／旋轉', film: '膠片模擬',
    bw: '黑白', bwmix: '黑白混色', calib: '相機校正', profile: '描述檔', profileAmt: '描述檔強度', spots: '污點修復' };
  for (const list of Object.values(SL)) for (const s of list) o[s[0]] = s[1];
  return o;
})();
function histLabel(a, b) {
  const ch = Object.keys(b).filter(k => k !== '_presetAmount' && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (!ch.length) return '（沒有變更）';
  if (ch.length > 3) return `${ch.length} 項設定（預設集或貼上）`;
  return ch.map(k => { const n = PARAM_NAMES[k] || k, v = b[k]; return typeof v === 'number' ? `${n} ${k === 'exposure' ? fmt.ev(v) : fmt.int(v)}` : n; }).join('、');
}
const snapKey = im => 'rawedit:snap:' + im.key;
function loadSnaps(im) { if (!im.snaps) { try { im.snaps = JSON.parse(localStorage.getItem(snapKey(im)) || '[]'); } catch { im.snaps = []; } } return im.snaps; }
function saveSnaps(im) { try { localStorage.setItem(snapKey(im), JSON.stringify(im.snaps || [])); } catch { toast('儲存空間不足，快照沒有存起來'); } }
function addSnapshot() {
  const im = CUR(); if (!im) return; const list = loadSnaps(im);
  const name = prompt('快照名稱：', '快照 ' + (list.length + 1)); if (!name) return;
  list.push({ name, t: Date.now(), params: stripAmount(im.params) }); saveSnaps(im); renderHistoryUI(); toast('已建立快照');
}
function renderHistoryUI() {
  const hl = $('#histList'), sl = $('#snapList'); if (!hl || !sl) return; const im = CUR();
  hl.innerHTML = ''; sl.innerHTML = ''; if (!im) return;
  const snaps = loadSnaps(im);
  if (!snaps.length) sl.append(el('div', { class: 'hint' }, '把目前的調整存成快照，之後可以隨時切回來比較。'));
  snaps.forEach((s, i) => sl.append(el('button', {
    onclick: () => { const geo = im.params.geo; im.params = mergeParams(s.params); im.presetId = null; refreshAll(); commit(); toast('已套用快照「' + s.name + '」'); },
    oncontextmenu: e => { e.preventDefault(); if (confirm('刪除快照「' + s.name + '」？')) { snaps.splice(i, 1); saveSnaps(im); renderHistoryUI(); } }
  }, el('span', {}, s.name), el('small', {}, new Date(s.t).toLocaleString() + ' · 長按刪除'))));
  const H = im.hist.map(j => JSON.parse(j));
  for (let i = H.length - 1; i >= 0; i--) {
    const label = i === 0 ? '開啟（起點）' : histLabel(H[i - 1], H[i]);
    hl.append(el('button', { class: (i === im.hi ? 'on' : '') + (i > im.hi ? ' future' : ''), onclick: () => { im.hi = i; im.params = JSON.parse(im.hist[i]); im.presetId = null; refreshAll(); updateUndoButtons(); saveEdits(im); } },
      el('span', {}, label), el('small', {}, '#' + i)));
  }
}

// ---------- selective copy / paste ----------
// [id, name, param keys, checked by default]
const COPY_GROUPS = [
  ['wb', '白平衡', ['temp', 'tint'], true], ['light', '光線', ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'], true],
  ['presence', '鮮豔度／飽和度', ['vibrance', 'saturation'], true], ['profile', '描述檔／膠片', ['profile', 'profileAmt', 'film'], true],
  ['hsl', 'HSL', ['hsl'], true], ['bw', '黑白', ['bw', 'bwmix'], true], ['curve', '曲線', ['curves', 'pcurve'], true], ['grade', '色調分級', ['grade'], true],
  ['fx', '效果', ['clarity', 'dehaze', 'texture', 'fade', 'vignette', 'vigMid', 'vigFeather', 'vigRound', 'vigHi', 'grain', 'grainSize', 'grainRough'], true],
  ['detail', '細節', ['sharpen', 'sharpenRadius', 'sharpenMask', 'nrLum', 'nrColor'], true], ['calib', '相機校正', ['calib'], true], ['lens', '鏡頭校正', ['lens'], true],
  ['masks', '局部調整（遮罩）', ['masks'], false], ['spots', '污點修復', ['spots'], false], ['geo', '裁切與旋轉', ['geo'], false]];
function lastPasteGroups() {
  try { const g = JSON.parse(localStorage.getItem('rawedit:pastegroups') || 'null'); if (Array.isArray(g)) return g; } catch { }
  return COPY_GROUPS.filter(g => g[3]).map(g => g[0]);
}
function pasteSettings(all, groups) {
  const src = state.clipboard; if (!src) { toast('請先在「⋯」選單按「複製設定」'); return; }
  const keys = COPY_GROUPS.filter(g => groups.includes(g[0])).flatMap(g => g[2]);
  const targets = all ? images : [CUR()].filter(Boolean); let n = 0;
  for (const im of targets) {
    const np = clone(im.params); for (const k of keys) if (k in src) np[k] = clone(src[k]);
    if (JSON.stringify(np) === JSON.stringify(im.params)) continue;
    im.params = np; im.presetId = null; n++;
    if (im === CUR()) commit();
    else { const snap = JSON.stringify(np); im.hist = im.hist.slice(0, im.hi + 1); im.hist.push(snap); if (im.hist.length > 60) im.hist.shift(); im.hi = im.hist.length - 1; im.edited = true; saveEdits(im); }
  }
  refreshAll(); updateFilmstrip(); toast(n ? `已貼到 ${n} 張照片` : '沒有需要變更的照片');
}
function openPasteDialog(all) {
  if (!state.clipboard) { toast('請先在「⋯」選單按「複製設定」'); return; }
  $('#modalMenu').classList.remove('on');
  let m = $('#modalPaste');
  if (!m) { m = el('div', { class: 'modal', id: 'modalPaste' }); document.body.append(m); m.addEventListener('click', e => { if (e.target === m) m.classList.remove('on'); }); }
  const sel = new Set(lastPasteGroups()); const list = el('div', { class: 'pastelist' });
  for (const [id, name] of COPY_GROUPS) { const cb = el('input', { type: 'checkbox' }); cb.checked = sel.has(id); cb.onchange = () => cb.checked ? sel.add(id) : sel.delete(id); list.append(el('label', {}, cb, name)); }
  const go = a => { const g = [...sel]; try { localStorage.setItem('rawedit:pastegroups', JSON.stringify(g)); } catch { } m.classList.remove('on'); pasteSettings(a, g); };
  m.innerHTML = '';
  m.append(el('div', { class: 'sheet' }, el('h3', {}, '貼上哪些設定？'), list,
    el('div', { class: 'toolbar' }, el('button', { class: all ? '' : 'primary', onclick: () => go(false) }, '貼到這張'),
      el('button', { class: all ? 'primary' : '', onclick: () => go(true) }, `貼到全部 ${images.length} 張`), el('button', { onclick: () => m.classList.remove('on') }, '取消')),
    el('div', { class: 'hint' }, '貼上不會清掉照片原本的復原紀錄。快速鍵 Ctrl+V 會用上次勾選的項目。')));
  m.classList.add('on');
}

// ---------- film emulation LUTs ----------
// FILM_LUTS (filmluts.js): { size, list:[{id,name,d,...}], data: base64(zlib(all LUTs, size^3*3 bytes each, red fastest)) }
const FILM_LIST = (typeof FILM_LUTS !== 'undefined' && FILM_LUTS.list) || [];
for (const f of FILM_LIST) PRESETS.push({ id: 'lut_' + f.id, cat: 'lut', name: f.name, d: f.d, p: { film: { id: f.id, amount: f.amount ?? 100 } } });
let filmLUTState = null; // null | Promise | 'ready' | 'error'
function loadFilmLUTs() {
  if (filmLUTState || !FILM_LIST.length) return filmLUTState;
  filmLUTState = (async () => {
    const bin = Uint8Array.from(atob(FILM_LUTS.data), c => c.charCodeAt(0));
    const raw = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const N = FILM_LUTS.size, n = N * N * N * 3;
    FILM_LIST.forEach((f, i) => renderer.setFilmLUT(f.id, N, decodeFilmLUT(raw.subarray(i * n, (i + 1) * n), N)));
    filmLUTState = 'ready';
    if (presetUI.cards) presetUI.cards.forEach(c => c.sig = '');
    if (CUR()) requestRender(false); schedulePresetThumbs();
  })().catch(e => { console.error(e); filmLUTState = 'error'; toast('膠片模擬資料載入失敗：' + e.message, 5000); });
  return filmLUTState;
}
// undo the encoding of tools/make_film_luts.py: running sum along red, then add the identity LUT (all mod 256)
function decodeFilmLUT(src, N) {
  const ident = Array.from({ length: N }, (_, i) => Math.round(i * 255 / (N - 1))), out = new Uint8Array(src.length);
  for (let b = 0, o = 0; b < N; b++) for (let g = 0; g < N; g++) {
    let dr = 0, dg = 0, db = 0;
    for (let r = 0; r < N; r++, o += 3) {
      dr = (dr + src[o]) & 255; dg = (dg + src[o + 1]) & 255; db = (db + src[o + 2]) & 255;
      out[o] = (dr + ident[r]) & 255; out[o + 1] = (dg + ident[g]) & 255; out[o + 2] = (db + ident[b]) & 255;
    }
  }
  return out;
}
const filmName = id => (FILM_LIST.find(f => f.id === id) || {}).name || id;

// ---------- presets panel ----------
// Presets only set ordinary sliders (see PRESETS in presets.js), so everything stays adjustable afterwards.
const PRESET_CATS = [['basic', '基本'], ['lut', '膠片模擬'], ['fuji', '富士底片模擬'], ['japanese', '日系'], ['cinematic', '電影感'], ['film', '經典底片'], ['bw', '黑白'], ['master', '大師風格'], ['user', '我的']];
let presetUI = { edit: false };
let presetCat = 'lut'; try { presetCat = localStorage.getItem('rawedit:pcat') || 'lut'; } catch { }
let hiddenPresets = new Set(); try { hiddenPresets = new Set(JSON.parse(localStorage.getItem('rawedit:hidden') || '[]')); } catch { }
const saveHidden = () => { try { localStorage.setItem('rawedit:hidden', JSON.stringify([...hiddenPresets])); } catch { } };
const presetItems = cat => cat === 'user'
  ? userPresets.map((p, i) => ({ p, id: 'u' + i, user: true, i }))
  : PRESETS.map((p, i) => ({ p, id: 'b:' + (p.id || i) })).filter(x => (x.p.cat || 'basic') === cat);
const visibleItems = cat => presetItems(cat).filter(x => x.user || !hiddenPresets.has(x.id));
function buildPresetPanel(sec) {
  presetUI.editBtn = el('button', { onclick: () => { presetUI.edit = !presetUI.edit; renderPresetGrid(); } }, '管理');
  sec.append(hdr('預設集', presetUI.editBtn, el('button', { onclick: savePresetDialog }, '＋ 儲存目前設定')));
  const chips = el('div', { class: 'pcats' }); sec.append(chips); presetUI.chips = chips;
  presetUI.editBar = el('div', { class: 'toolbar peditbar' },
    el('button', { onclick: () => { for (const it of presetItems(presetCat)) hiddenPresets.delete(it.id); saveHidden(); renderPresetGrid(); } }, '這類全部顯示'),
    el('button', { onclick: () => { for (const it of presetItems(presetCat)) if (!it.user) hiddenPresets.add(it.id); saveHidden(); renderPresetGrid(); } }, '這類全部隱藏'),
    el('button', { onclick: () => { if (confirm('顯示所有預設集？')) { hiddenPresets.clear(); saveHidden(); renderPresetGrid(); } } }, '全部還原'));
  sec.append(presetUI.editBar);
  presetUI.amt = makeSlider('_presetAmount', '強度', 0, 150, 1, fmt.pos); sec.append(presetUI.amt);
  presetUI.filmRow = el('div', { class: 'filmrow' },
    hdr('', el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.film = { id: '', amount: 100 }; refreshAll(); commit(); } }, '移除膠片')),
    makeSlider('film.amount', '膠片強度', 0, 100, 1, fmt.pos));
  sec.append(presetUI.filmRow);
  const grid = el('div', { class: 'presets' }); sec.append(grid); presetUI.grid = grid;
  presetUI.hint = el('div', { class: 'hint' }); sec.append(presetUI.hint);
  renderPresetGrid();
}
// the amount slider lives outside params: emulate a param path on a side object
for (const d of [DEFAULTS, IMG_DEFAULTS]) Object.defineProperty(d, '_presetAmount', { value: 100, enumerable: false });
function renderPresetGrid() {
  const grid = presetUI.grid; if (!grid) return; grid.innerHTML = '';
  const edit = presetUI.edit;
  // categories with nothing visible disappear outside the manager ("我的" always stays, it holds the save hint)
  const cats = PRESET_CATS.filter(([id]) => (id !== 'lut' || FILM_LIST.length) && (edit || id === 'user' || visibleItems(id).length) && presetItems(id).length + (id === 'user' ? 1 : 0));
  if (!cats.some(([id]) => id === presetCat)) presetCat = cats[0][0];
  presetUI.chips.innerHTML = '';
  for (const [id, name] of cats) presetUI.chips.append(el('button', { class: id === presetCat ? 'on' : '', onclick: () => { presetCat = id; try { localStorage.setItem('rawedit:pcat', id); } catch { } renderPresetGrid(); } }, name));
  presetUI.editBtn.textContent = edit ? '完成' : '管理'; presetUI.editBtn.classList.toggle('on', edit);
  presetUI.editBar.style.display = edit ? '' : 'none'; presetUI.amt.style.display = edit ? 'none' : '';
  presetUI.hint.textContent = edit ? '點卡片切換顯示／隱藏，隱藏的預設集不會出現在清單裡。設定存在這台裝置。'
    : '點一下套用，換別的預設會直接取代、不會疊加；之後手動調過的滑桿會保留。預設集只是幫你拉好滑桿，套用後每個都能再調。「膠片模擬」是底片 LUT，會疊在你的調整之後，可用「膠片強度」調整或移除。不影響裁切、局部調整與鏡頭校正。';
  if (presetCat === 'lut') loadFilmLUTs();
  const items = edit ? presetItems(presetCat) : visibleItems(presetCat);
  const card = (it, label, sub) => {
    const cv = el('canvas', { class: 'pthumb', width: 300, height: 200 });
    const off = !it.user && it.id !== 'none' && hiddenPresets.has(it.id);
    const click = () => {
      if (edit) { if (it.user || it.id === 'none') return; hiddenPresets.has(it.id) ? hiddenPresets.delete(it.id) : hiddenPresets.add(it.id); saveHidden(); b.classList.toggle('off'); return; }
      it.id === 'none' ? clearPresetUI() : applyPresetUI(it.p, it.id);
    };
    const attrs = { class: 'pcard' + (it.user ? ' user' : '') + (off ? ' off' : '') + (edit ? ' editing' : ''), 'data-id': it.id, onclick: click };
    if (it.user) attrs.oncontextmenu = e => { e.preventDefault(); if (confirm('刪除預設集「' + it.p.name + '」？')) { userPresets.splice(it.i, 1); saveUserPresets(); renderPresetGrid(); } };
    const b = el('button', attrs, cv, el('span', { class: 'pn' }, label), el('small', {}, sub), edit && !it.user ? el('span', { class: 'ptick' }) : '');
    grid.append(b); return { btn: b, canvas: cv, preset: it.id === 'none' ? null : it.p, id: it.id, sig: '' };
  };
  presetUI.cards = edit ? [] : [card({ id: 'none' }, '原圖', '不套用預設')];
  for (const it of items) presetUI.cards.push(card(it, it.p.name, it.p.d || it.p.en || (it.user ? '我的預設 · 長按/右鍵刪除' : '')));
  if (presetCat === 'user' && !items.length) grid.append(el('div', { class: 'hint' }, '還沒有自己的預設。調好一張照片後，按上方「＋ 儲存目前設定」。'));
  refreshPresetUI(); schedulePresetThumbs();
}
// Params a preset is applied on top of: switching between presets starts again from the pre-preset photo instead of stacking.
// Sliders the user moved after applying the preset are kept (they override the pre-preset values).
function presetBaseFor(im) {
  if (!im.presetId || !im.presetBase || !im.presetResult) return im.params;
  const cur = stripAmount(im.params); if (JSON.stringify(cur) === im.presetResult) return im.presetBase;
  const res = JSON.parse(im.presetResult), base = clone(im.presetBase);
  for (const k of Object.keys(cur)) { if (k === 'geo' || k === 'masks' || k === 'lens') continue; if (JSON.stringify(cur[k]) !== JSON.stringify(res[k])) base[k] = clone(cur[k]); }
  return base;
}
function applyPresetUI(p, id, fromAmount) {
  const im = CUR(); if (!im) return;
  { const base = presetBaseFor(im); if (base !== im.presetBase) im.presetBase = clone(stripAmount(base)); im.presetId = id; im.presetObj = p; }
  const amount = (im.params._presetAmount ?? 100) / 100;
  const np = applyPreset(im.presetBase, p.p, amount); np.geo = im.params.geo; np.masks = im.params.masks; np.lens = im.params.lens; np._presetAmount = im.params._presetAmount ?? 100; im.params = np;
  im.presetResult = JSON.stringify(stripAmount(np));
  refreshAll(); if (!fromAmount) commit(); else { clearTimeout(applyPresetUI.t); applyPresetUI.t = setTimeout(commit, 400); }
}
function clearPresetUI() {
  const im = CUR(); if (!im || !im.presetId) return;
  const base = presetBaseFor(im); if (base === im.params) { im.presetId = null; refreshPresetUI(); return; }
  const np = clone(base); np.geo = im.params.geo; np.masks = im.params.masks; np.lens = im.params.lens; im.params = np; im.presetId = null; im.presetResult = null;
  refreshAll(); commit();
}
function refreshPresetUI() {
  const im = CUR(); if (!presetUI.cards) return;
  const cur = im && im.presetId && JSON.stringify(stripAmount(im.params)) === im.presetResult ? im.presetId : 'none';
  for (const c of presetUI.cards) c.btn.classList.toggle('on', !presetUI.edit && !!im && c.id === cur);
  const f = im && im.params.film && im.params.film.id;
  if (presetUI.filmRow) { presetUI.filmRow.style.display = f && !presetUI.edit ? '' : 'none'; if (f) presetUI.filmRow.querySelector('.hdr span').textContent = '膠片：' + filmName(f); }
}
// Live thumbnails: each preset rendered from the current photo (small GPU render, a few per frame so the UI stays responsive)
const presetThumbJob = { seq: 0 };
function schedulePresetThumbs() {
  const seq = ++presetThumbJob.seq; const im = CUR();
  if (!im || state.tab !== 'presets' || !presetUI.cards || !renderer.src || !state.previewData || state.previewData.imId !== im.id) return;
  const base = stripAmount(presetBaseFor(im)); const G = geometry(im.params.geo, im.fullW, im.fullH);
  const sig = im.id + '|' + JSON.stringify(base) + '|' + G.outW + 'x' + G.outH + '|' + (filmLUTState === 'ready');
  const todo = presetUI.cards.filter(c => c.sig !== sig); let i = 0;
  const step = () => {
    if (seq !== presetThumbJob.seq || CUR() !== im || state.tab !== 'presets') return;
    const t0 = performance.now();
    try { while (i < todo.length && performance.now() - t0 < 24) { drawPresetThumb(im, base, G, todo[i]); todo[i].sig = sig; i++; } }
    finally { renderer.setCurveLUT(curveLUTFor(im.params)); } // thumbnails swap the curve LUT; restore it for the main view
    if (i < todo.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function drawPresetThumb(im, base, G, card) {
  const p = card.preset ? applyPreset(base, card.preset.p, 1) : base;
  const U = uniformsFromParams(p, im, {}); U.showMask = -1; U.clipWarn = 0;
  renderer.setCurveLUT(curveLUTFor(p));
  const cv = card.canvas, CW = cv.width, CH = cv.height;
  const fitW = G.outW / G.outH > CW / CH ? Math.round(CH * 2 * G.outW / G.outH) : CW * 2; // render ~2x the box for a clean downscale
  const { px, w, h } = renderer.readSmall(U, G, fitW, 'pthumb');
  const tmp = presetUI.tmp || (presetUI.tmp = document.createElement('canvas')); tmp.width = w; tmp.height = h;
  const img = new ImageData(w, h);
  img.data.set(px); // the result target is already stored top row first (draw() flips it for the screen)
  tmp.getContext('2d').putImageData(img, 0, 0);
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const s = Math.max(CW / w, CH / h), dw = w * s, dh = h * s; // cover
  g.drawImage(tmp, (CW - dw) / 2, (CH - dh) / 2, dw, dh);
}
function savePresetDialog() {
  const im = CUR(); if (!im) return; const name = prompt('預設集名稱：', '我的預設 ' + (userPresets.length + 1)); if (!name) return;
  userPresets.push({ name, p: paramsToPreset(im.params) }); saveUserPresets(); presetCat = 'user'; presetUI.edit = false; try { localStorage.setItem('rawedit:pcat', 'user'); } catch { } renderPresetGrid(); toast('已儲存到「我的」');
}
function saveUserPresets() { try { localStorage.setItem('rawedit:presets', JSON.stringify(userPresets)); } catch { } }

// ---------- history ----------
function commit() {
  const im = CUR(); if (!im) return; const snap = JSON.stringify(im.params);
  if (im.hist[im.hi] === snap) return;
  im.hist = im.hist.slice(0, im.hi + 1); im.hist.push(snap); if (im.hist.length > 60) im.hist.shift(); im.hi = im.hist.length - 1;
  im.edited = JSON.stringify(stripAmount(im.params)) !== JSON.stringify(clone(defaultsFor(im)));
  if (state.tab === 'presets') { refreshPresetUI(); clearTimeout(commit.pt); commit.pt = setTimeout(schedulePresetThumbs, 500); }
  if (state.tab === 'info') renderHistoryUI(); updateUndoButtons(); saveEdits(im); updateFilmstrip();
}
function stripAmount(p) { const c = clone(p); delete c._presetAmount; return c; }
function undo() { const im = CUR(); if (!im || im.hi <= 0) return; im.hi--; im.params = JSON.parse(im.hist[im.hi]); im.presetId = null; refreshAll(); updateUndoButtons(); saveEdits(im); }
function redo() { const im = CUR(); if (!im || im.hi >= im.hist.length - 1) return; im.hi++; im.params = JSON.parse(im.hist[im.hi]); im.presetId = null; refreshAll(); updateUndoButtons(); saveEdits(im); }
function updateUndoButtons() { const im = CUR(); $('#btnUndo').disabled = !im || im.hi <= 0; $('#btnRedo').disabled = !im || im.hi >= im.hist.length - 1; }
let saveT; function saveEdits(im) { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('rawedit:edit:' + im.key, JSON.stringify(stripAmount(im.params))); } catch { } }, 300); }
function loadEdits(key) { try { const s = localStorage.getItem('rawedit:edit:' + key); return s ? mergeParams(JSON.parse(s)) : null; } catch { return null; } }
function mergeParams(p) { const d = defaultParams(); const deep = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deep(a[k], b[k]); else a[k] = b[k]; } }; deep(d, p || {}); return d; }

// ---------- rendering ----------
const view = $('#view'), overlay = $('#overlay');
function fitCanvas() {
  const w = $('#stage').clientWidth, h = $('#stage').clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  if (view.width !== Math.round(w * dpr) || view.height !== Math.round(h * dpr)) { view.width = Math.round(w * dpr); view.height = Math.round(h * dpr); overlay.width = view.width; overlay.height = view.height; fitView(); requestDraw(); }
}
let renderReq = null, fullTimer = null, histTimer = null;
function requestRender(interactive) {
  const im = CUR(); if (!im || !renderer.src) return;
  if (renderReq) cancelAnimationFrame(renderReq);
  renderReq = requestAnimationFrame(() => {
    renderReq = null;
    const G = currentGeometry();
    // never render the preview above the decoded source resolution (half-size decode -> half the pixels)
    const qFull = previewQ(); const big = G.outW * G.outH * qFull * qFull > 2.5e6;
    const q = (interactive && big && !state.hq) ? qFull * 0.5 : qFull;
    syncBrush(im);
    renderer.renderResult(uniformsFromParams(im.params, im), G, q);
    draw();
    clearTimeout(fullTimer);
    if (q < qFull) fullTimer = setTimeout(() => { if (CUR() !== im) return; syncBrush(im); renderer.renderResult(uniformsFromParams(im.params, im), currentGeometry(), previewQ()); draw(); }, 220);
    clearTimeout(histTimer); histTimer = setTimeout(updateHistogram, interactive ? 160 : 0);
  });
}
function previewQ() { const s = renderer.src; return s && s.scale > 1 ? 1 / s.scale : 1; }
function currentGeometry() { const im = CUR(); return geometry(im.params.geo, im.fullW, im.fullH, state.cropMode); }
let drawReq = null; function requestDraw() { if (drawReq) return; drawReq = requestAnimationFrame(() => { drawReq = null; draw(); }); }
function viewMatrix() {
  const R = renderer.result; if (!R) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const cw = view.width, ch = view.height, G = currentGeometry();
  const fit = Math.min(cw / G.outW, ch / G.outH); const sc = fit * state.zoom;
  const sx = G.outW * sc / cw, sy = G.outH * sc / ch;
  return [sx, 0, 0, 0, -sy, 0, state.panX * 2 / cw, -state.panY * 2 / ch, 1];
}
function fitView() { state.zoom = 1; state.panX = 0; state.panY = 0; updateZoomLabel(); }
function updateZoomLabel() { const im = CUR(); if (!im) { $('#zoomlbl').textContent = ''; return; } const G = currentGeometry(); const fit = Math.min(view.width / G.outW, view.height / G.outH); const pct = fit * state.zoom * 100 / (Math.min(devicePixelRatio || 1, 2)); $('#zoomlbl').textContent = (state.zoom === 1 ? '符合視窗 · ' : '') + Math.round(pct) + '%'; }
function draw() {
  if (!renderer.result) return;
  renderer.draw(viewMatrix(), state.compare, state.split);
  drawOverlay();
}
// Screen-space helpers (CSS px → canvas px handled via dpr in pointer handlers)
function frameToScreen(fx, fy) { // frame px (uncropped straightened frame) → canvas px
  const G = currentGeometry(); const cw = view.width, ch = view.height; const fit = Math.min(cw / G.outW, ch / G.outH) * state.zoom;
  const ox = cw / 2 + state.panX - G.outW * fit / 2, oy = ch / 2 + state.panY - G.outH * fit / 2;
  return [ox + fx * fit, oy + fy * fit];
}
function screenToFrame(sx, sy) { const G = currentGeometry(); const cw = view.width, ch = view.height; const fit = Math.min(cw / G.outW, ch / G.outH) * state.zoom; const ox = cw / 2 + state.panX - G.outW * fit / 2, oy = ch / 2 + state.panY - G.outH * fit / 2; return [(sx - ox) / fit, (sy - oy) / fit]; }
function drawOverlay() {
  const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
  const im = CUR(); if (!im || !im.fullW) return;
  if (state.tab === 'local') { drawLocalOverlay(ctx); return; }
  if (!state.cropMode) return;
  const G = currentGeometry(); const c = im.params.geo.crop;
  const [x0, y0] = frameToScreen(c.x * G.Wr, c.y * G.Hr), [x1, y1] = frameToScreen((c.x + c.w) * G.Wr, (c.y + c.h) * G.Hr);
  const [fx0, fy0] = frameToScreen(0, 0), [fx1, fy1] = frameToScreen(G.Wr, G.Hr);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.rect(fx0, fy0, fx1 - fx0, fy1 - fy0); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill('evenodd');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1 * dpr; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); for (let i = 1; i < 3; i++) { ctx.moveTo(x0 + (x1 - x0) * i / 3, y0); ctx.lineTo(x0 + (x1 - x0) * i / 3, y1); ctx.moveTo(x0, y0 + (y1 - y0) * i / 3); ctx.lineTo(x1, y0 + (y1 - y0) * i / 3); } ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * dpr; const L = 18 * dpr;
  for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) { ctx.beginPath(); ctx.moveTo(cx, cy + dy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * L, cy); ctx.stroke(); }
  for (const [ax, ay, bx, by] of [[(x0 + x1) / 2 - L / 2, y0, (x0 + x1) / 2 + L / 2, y0], [(x0 + x1) / 2 - L / 2, y1, (x0 + x1) / 2 + L / 2, y1], [x0, (y0 + y1) / 2 - L / 2, x0, (y0 + y1) / 2 + L / 2], [x1, (y0 + y1) / 2 - L / 2, x1, (y0 + y1) / 2 + L / 2]]) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
}
function updateHistogram() {
  const im = CUR(); if (!im || !renderer.src || !state.hist) { $('#histo').style.display = 'none'; return; }
  $('#histo').style.display = '';
  const HU = uniformsFromParams(im.params, im); HU.showMask = -1; HU.clipWarn = 0;
  const { px, w, h } = renderer.readSmall(HU, currentGeometry(), 256);
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
  for (let i = 0; i < w * h * 4; i += 4) { hr[px[i]]++; hg[px[i + 1]]++; hb[px[i + 2]]++; hl[(px[i] * 54 + px[i + 1] * 183 + px[i + 2] * 19) >> 8]++; }
  const cv = $('#histo'), ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  let mx = 1; for (let i = 2; i < 254; i++) mx = Math.max(mx, hr[i], hg[i], hb[i]);
  ctx.globalCompositeOperation = 'lighter';
  for (const [hh, col] of [[hr, 'rgba(255,70,70,0.75)'], [hg, 'rgba(70,255,90,0.75)'], [hb, 'rgba(80,130,255,0.75)']]) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, cv.height);
    for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * cv.width, cv.height - Math.min(1, hh[i] / mx) * cv.height * 0.95);
    ctx.lineTo(cv.width, cv.height); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  curveEd.hist = Array.from(hl); if (state.tab === 'curve') curveEd.draw();
}
function onCurveChange() { const im = CUR(); if (!im) return; im.params.curves = clone(curveEd.curves); renderer.setCurveLUT(curveLUTFor(im.params)); requestRender(true); clearTimeout(onCurveChange.t); onCurveChange.t = setTimeout(commit, 400); }


// ---------- local masks: coordinates, overlay, interaction ----------
// Mask geometry is stored in "iso" units: lens-corrected full-image pixels divided by the long edge.
function invMap(m, x, y) { const a = m[0], b = m[1], c = m[3], d = m[4], X = x - m[6], Y = y - m[7], det = a * d - b * c; return [(d * X - c * Y) / det, (-b * X + a * Y) / det]; }
function isoToCanvas(ix, iy) { const im = CUR(); const Lm = Math.max(im.fullW, im.fullH); const G = currentGeometry(); const o = invMap(G.m, ix * Lm, iy * Lm); return frameToScreen(o[0], o[1]); }
function canvasToIso(sx, sy) { const im = CUR(); const Lm = Math.max(im.fullW, im.fullH); const G = currentGeometry(); const f = screenToFrame(sx, sy); const p = mapPt(G.m, f[0], f[1]); return [p[0] / Lm, p[1] / Lm]; }
function maskHandles(m) {
  if (m.type === 'linear') {
    const a = isoToCanvas(m.x0, m.y0), b = isoToCanvas(m.x1, m.y1);
    return [{ k: 'p0', x: a[0], y: a[1] }, { k: 'p1', x: b[0], y: b[1] }, { k: 'mid', x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }];
  }
  if (m.type === 'radial') {
    const t = (m.angle || 0) * Math.PI / 180, ux = Math.cos(t), uy = Math.sin(t);
    const P = (du, dv) => isoToCanvas(m.cx + ux * du - uy * dv, m.cy + uy * du + ux * dv);
    const c = P(0, 0), a = P(m.rx, 0), b = P(-m.rx, 0), d = P(0, m.ry), e = P(0, -m.ry);
    return [{ k: 'c', x: c[0], y: c[1] }, { k: 'u+', x: a[0], y: a[1] }, { k: 'u-', x: b[0], y: b[1] }, { k: 'v+', x: d[0], y: d[1] }, { k: 'v-', x: e[0], y: e[1] }];
  }
  return [];
}
function maskHit(x, y) {
  const m = activeMask(); if (!m) return null; const R = 26 * dprNow();
  let best = null, bd = R; for (const h of maskHandles(m)) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.k; } }
  if (best) return best;
  if (m.type === 'radial') { // inside the ellipse = move
    const [ix, iy] = canvasToIso(x, y); const t = (m.angle || 0) * Math.PI / 180, qx = ix - m.cx, qy = iy - m.cy;
    const u = (Math.cos(t) * qx + Math.sin(t) * qy) / m.rx, v = (-Math.sin(t) * qx + Math.cos(t) * qy) / m.ry; if (u * u + v * v < 1) return 'c';
  }
  return null;
}
function maskDrag(g, x, y) {
  const m = activeMask(); if (!m) return; const p = canvasToIso(x, y), dx = p[0] - g.start[0], dy = p[1] - g.start[1], m0 = g.m0;
  if (m.type === 'linear') {
    if (g.key === 'p0' || g.key === 'mid') { m.x0 = m0.x0 + dx; m.y0 = m0.y0 + dy; }
    if (g.key === 'p1' || g.key === 'mid') { m.x1 = m0.x1 + dx; m.y1 = m0.y1 + dy; }
  } else if (m.type === 'radial') {
    if (g.key === 'c') { m.cx = m0.cx + dx; m.cy = m0.cy + dy; }
    else {
      const qx = p[0] - m0.cx, qy = p[1] - m0.cy;
      if (g.key[0] === 'u') { m.rx = Math.max(0.01, Math.hypot(qx, qy)); let a = Math.atan2(g.key === 'u+' ? qy : -qy, g.key === 'u+' ? qx : -qx) * 180 / Math.PI; if (a > 90) a -= 180; if (a < -90) a += 180; m.angle = +a.toFixed(1); const s = sliders.get('M.angle'); if (s) s.update(); }
      else { const t = (m0.angle || 0) * Math.PI / 180; m.ry = Math.max(0.01, Math.abs(-Math.sin(t) * qx + Math.cos(t) * qy)); }
    }
  }
  requestRender(true);
}
function drawLocalOverlay(ctx) {
  const m = activeMask(); if (!m) return; const dpr = dprNow();
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 3 * dpr;
  const handle = (h, filled, r = 8) => { ctx.beginPath(); ctx.arc(h.x, h.y, r * dpr, 0, Math.PI * 2); ctx.fillStyle = filled ? '#fff' : 'rgba(0,0,0,.35)'; ctx.fill(); ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke(); };
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5 * dpr;
  if (m.type === 'linear') {
    const [a, b, mid] = maskHandles(m); let dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; const L = 6000;
    const line = (p, dash) => { ctx.setLineDash(dash ? [6 * dpr, 6 * dpr] : []); ctx.beginPath(); ctx.moveTo(p.x - dy * L, p.y + dx * L); ctx.lineTo(p.x + dy * L, p.y - dx * L); ctx.stroke(); };
    line(a, false); line(b, false); line(mid, true); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    handle(a, true); handle(b, false); handle(mid, true, 5);
  } else if (m.type === 'radial') {
    const t = (m.angle || 0) * Math.PI / 180, ux = Math.cos(t), uy = Math.sin(t);
    const ell = (k, dash) => { ctx.setLineDash(dash ? [6 * dpr, 6 * dpr] : []); ctx.beginPath(); for (let i = 0; i <= 96; i++) { const s = i / 96 * Math.PI * 2, du = Math.cos(s) * m.rx * k, dv = Math.sin(s) * m.ry * k; const q = isoToCanvas(m.cx + ux * du - uy * dv, m.cy + uy * du + ux * dv); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); } ctx.stroke(); };
    ell(1, false); const f = (m.feather ?? 50) / 100; if (f > 0.02) ell(1 - f, true); ctx.setLineDash([]);
    const hs = maskHandles(m); handle(hs[0], true, 6); for (const h of hs.slice(1)) handle(h, false, 7);
  } else if (m.type === 'brush' && state.cursor) {
    const [ix, iy] = canvasToIso(state.cursor[0], state.cursor[1]); const r = brushRadiusIso(state.tool.size);
    const a = isoToCanvas(ix, iy), b = isoToCanvas(ix + r, iy); const rr = Math.hypot(b[0] - a[0], b[1] - a[1]);
    ctx.beginPath(); ctx.arc(a[0], a[1], rr, 0, Math.PI * 2); ctx.strokeStyle = state.tool.erase ? 'rgba(255,120,120,.95)' : 'rgba(255,255,255,.95)'; ctx.stroke();
    const fi = rr * (1 - state.tool.feather / 100); if (fi > 2) { ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.beginPath(); ctx.arc(a[0], a[1], fi, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  }
  ctx.restore();
}

// ---------- brush masks (rasterised on 2D canvases, one texture channel per mask) ----------
const BR = { imId: null, W: 0, H: 0, S: 0, cv: [], ctx: [], sig: ['', '', '', ''], buf: null, sprites: new Map(), dirtyAll: false };
function brushRadiusIso(size) { return 0.004 + Math.pow(size / 100, 1.6) * 0.2; }
function strokesSig(m) { let n = 0; for (const s of m.strokes) n += s.p.length; return m.id + ':' + m.strokes.length + ':' + n; }
function dabSprite(feather) {
  const k = Math.round(feather); let c = BR.sprites.get(k); if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const inner = 64 * (1 - k / 100) * 0.97; const gr = g.createRadialGradient(64, 64, inner, 64, 64, 64);
  for (let i = 0; i <= 8; i++) { const t = i / 8; gr.addColorStop(t, `rgba(255,255,255,${(0.5 + 0.5 * Math.cos(t * Math.PI)).toFixed(3)})`); }
  g.fillStyle = gr; g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill(); BR.sprites.set(k, c); return c;
}
// paint one stroke segment (iso coords) onto ctx; returns the dirty rect in canvas px
function paintSegment(ctx, st, x0, y0, x1, y1, first) {
  const S = BR.S, r = Math.max(0.75, st.r * S), spr = dabSprite(st.f);
  ctx.globalCompositeOperation = st.e ? 'destination-out' : 'source-over'; ctx.globalAlpha = st.a ?? 1;
  const ax = x0 * S, ay = y0 * S, bx = x1 * S, by = y1 * S; const len = Math.hypot(bx - ax, by - ay);
  const n = first ? 0 : Math.max(1, Math.round(len / Math.max(0.5, r * 0.18)));
  if (first) ctx.drawImage(spr, ax - r, ay - r, 2 * r, 2 * r);
  for (let i = 1; i <= n; i++) { const t = i / n; ctx.drawImage(spr, ax + (bx - ax) * t - r, ay + (by - ay) * t - r, 2 * r, 2 * r); }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  return [Math.min(ax, bx) - r - 2, Math.min(ay, by) - r - 2, Math.abs(bx - ax) + 2 * r + 4, Math.abs(by - ay) + 2 * r + 4];
}
function copyChannel(ch, x, y, w, h) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y)); w = Math.min(BR.W - x, Math.ceil(w)); h = Math.min(BR.H - y, Math.ceil(h)); if (w <= 0 || h <= 0) return null;
  const d = BR.ctx[ch].getImageData(x, y, w, h).data, buf = BR.buf, W = BR.W;
  for (let j = 0; j < h; j++) { let s = j * w * 4 + 3, o = ((y + j) * W + x) * 4 + ch; for (let i = 0; i < w; i++, s += 4, o += 4) buf[o] = d[s]; }
  return [x, y, w, h];
}
function rasterMask(ch, m) {
  const ctx = BR.ctx[ch]; ctx.clearRect(0, 0, BR.W, BR.H);
  if (m) for (const st of m.strokes) { const p = st.p; if (p.length < 2) continue; paintSegment(ctx, st, p[0], p[1], p[0], p[1], true); for (let i = 2; i + 1 < p.length; i += 2) paintSegment(ctx, st, p[i - 2], p[i - 1], p[i], p[i + 1], false); }
  copyChannel(ch, 0, 0, BR.W, BR.H);
}
// make the GPU brush texture match im's brush masks (cheap when nothing changed)
function syncBrush(im) {
  if (!im || !im.fullW) return; const ms = (im.params.masks || []).filter(m => m.type === 'brush'); if (!ms.length) return;
  const S = LOW_MEM ? 1024 : 1536, Lm = Math.max(im.fullW, im.fullH);
  const W = Math.max(8, Math.round(S * im.fullW / Lm)), H = Math.max(8, Math.round(S * im.fullH / Lm));
  if (BR.imId !== im.id || BR.W !== W || BR.H !== H) {
    BR.imId = im.id; BR.W = W; BR.H = H; BR.S = S; BR.buf = new Uint8Array(W * H * 4); BR.sig = ['', '', '', ''];
    for (let c = 0; c < 4; c++) { const cv = BR.cv[c] || (BR.cv[c] = document.createElement('canvas')); cv.width = W; cv.height = H; BR.ctx[c] = cv.getContext('2d', { willReadFrequently: true }); }
    renderer.setBrushSize(W, H); BR.dirtyAll = true;
  }
  let dirty = BR.dirtyAll; BR.dirtyAll = false;
  for (let c = 0; c < 4; c++) { const m = ms.find(x => x.ch === c); const sig = m ? strokesSig(m) : ''; if (sig !== BR.sig[c]) { rasterMask(c, m); BR.sig[c] = sig; dirty = true; } }
  if (dirty) renderer.updateBrush(BR.buf, 0, 0, W, H);
}
const r5 = v => Math.round(v * 1e5) / 1e5;
function strokeStart(x, y) {
  const im = CUR(), m = activeMask(); if (!m) return; syncBrush(im);
  const [ix, iy] = canvasToIso(x, y);
  const st = { r: r5(brushRadiusIso(state.tool.size)), f: state.tool.feather, a: state.tool.flow / 100, e: state.tool.erase ? 1 : 0, p: [r5(ix), r5(iy)] };
  m.strokes.push(st); const bb = paintSegment(BR.ctx[m.ch], st, ix, iy, ix, iy, true); flushBrush(m, bb);
}
function strokeMove(x, y) {
  const m = activeMask(); if (!m || !m.strokes.length) return; const st = m.strokes[m.strokes.length - 1], p = st.p;
  const [ix, iy] = canvasToIso(x, y); const lx = p[p.length - 2], ly = p[p.length - 1];
  if (Math.hypot(ix - lx, iy - ly) < st.r * 0.15) return;
  p.push(r5(ix), r5(iy)); const bb = paintSegment(BR.ctx[m.ch], st, lx, ly, ix, iy, false); flushBrush(m, bb);
}
function flushBrush(m, bb) { const r = copyChannel(m.ch, ...bb); if (r) renderer.updateBrush(BR.buf, ...r); BR.sig[m.ch] = strokesSig(m); requestRender(true); }
function cancelShortStroke() { const m = activeMask(); if (m && m.type === 'brush' && m.strokes.length && m.strokes[m.strokes.length - 1].p.length <= 8) { m.strokes.pop(); requestRender(true); } }

// ---------- view interaction (pan / zoom / crop / masks) ----------
const ptrs = new Map(); let gesture = null;
const dprNow = () => Math.min(devicePixelRatio || 1, 2);
function canvasPt(e) { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) * dprNow(), (e.clientY - r.top) * dprNow()]; }
function cropHit(sx, sy) {
  const im = CUR(); const G = currentGeometry(); const c = im.params.geo.crop;
  const [x0, y0] = frameToScreen(c.x * G.Wr, c.y * G.Hr), [x1, y1] = frameToScreen((c.x + c.w) * G.Wr, (c.y + c.h) * G.Hr);
  const t = 22 * dprNow(); const nx = Math.abs(sx - x0) < t, px = Math.abs(sx - x1) < t, ny = Math.abs(sy - y0) < t, py = Math.abs(sy - y1) < t;
  const inX = sx > x0 - t && sx < x1 + t, inY = sy > y0 - t && sy < y1 + t;
  if (!inX || !inY) return null;
  return { l: nx, r: px, t: ny, b: py, move: !nx && !px && !ny && !py && sx > x0 && sx < x1 && sy > y0 && sy < y1 };
}
view.style.touchAction = 'none';
view.addEventListener('pointerdown', e => { if (state.pickWB && CUR() && e.button === 0) { e.preventDefault(); e.stopImmediatePropagation(); pickWBAt(e); } }, true);
view.addEventListener('pointerdown', e => {
  if (!CUR()) return; view.setPointerCapture(e.pointerId); const [x, y] = canvasPt(e); ptrs.set(e.pointerId, { x, y });
  if (ptrs.size === 1 && state.tab === 'local' && activeMask() && !spaceDown && e.button === 0 && CUR().fullW) {
    const m = activeMask();
    if (m.type === 'brush') { gesture = { type: 'paint', lastTap: 0 }; state.cursor = [x, y]; strokeStart(x, y); return; }
    const hit = maskHit(x, y); if (hit) { gesture = { type: 'mask', key: hit, m0: clone(m), start: canvasToIso(x, y), lastTap: 0 }; return; }
  }
  if (ptrs.size === 1) {
    const now = Date.now();
    if (gesture && gesture.lastTap && now - gesture.lastTap < 300 && !state.cropMode) { // double tap: toggle 100% / fit
      if (state.zoom === 1) { const im = CUR(); const G = currentGeometry(); const fit = Math.min(view.width / G.outW, view.height / G.outH); state.zoom = (im.previewScale || 1) / fit; const cx = view.width / 2, cy = view.height / 2; const k = state.zoom; state.panX = (state.panX - (x - cx)) * k + (x - cx); state.panY = (state.panY - (y - cy)) * k + (y - cy); } else fitView();
      clampPan(); updateZoomLabel(); requestDraw(); gesture = { lastTap: 0 }; return;
    }
    gesture = { type: state.cropMode ? 'crop' : 'pan', x, y, panX: state.panX, panY: state.panY, lastTap: now, hit: state.cropMode ? cropHit(x, y) : null, crop: state.cropMode ? clone(CUR().params.geo.crop) : null, moved: false };
  } else if (ptrs.size === 2) {
    if (gesture && gesture.type === 'paint') { cancelShortStroke(); state.cursor = null; }
    if (gesture && gesture.type === 'mask') { Object.assign(activeMask() || {}, gesture.m0); requestRender(false); }
    const [a, b] = [...ptrs.values()]; gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: state.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, panX: state.panX, panY: state.panY, lastTap: 0 };
  }
});
view.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse' && state.tab === 'local' && activeMask() && activeMask().type === 'brush') { state.cursor = canvasPt(e); drawOverlay(); } return; }
  if (!gesture) return; const [x, y] = canvasPt(e); ptrs.set(e.pointerId, { x, y });
  if (gesture.type === 'paint' && ptrs.size === 1) { state.cursor = [x, y]; strokeMove(x, y); return; }
  if (gesture.type === 'mask' && ptrs.size === 1) { maskDrag(gesture, x, y); return; }
  if (gesture.type === 'pan') { if (state.zoom > 1 || state.compare === 2) { if (state.compare === 2 && Math.abs(x - state.split * view.width) < 30 * dprNow() && !gesture.splitDrag && !gesture.moved) gesture.splitDrag = true; if (gesture.splitDrag) { state.split = clamp(x / view.width, 0.02, 0.98); requestDraw(); return; } state.panX = gesture.panX + (x - gesture.x); state.panY = gesture.panY + (y - gesture.y); clampPan(); requestDraw(); } gesture.moved = true; }
  else if (gesture.type === 'pinch' && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); const k = clamp(gesture.z0 * d / gesture.d0, 1, 16) / gesture.z0;
    const cx = view.width / 2, cy = view.height / 2; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    state.zoom = gesture.z0 * k; state.panX = (gesture.panX - (gesture.cx - cx)) * k + (mx - cx); state.panY = (gesture.panY - (gesture.cy - cy)) * k + (my - cy); clampPan(); updateZoomLabel(); requestDraw();
  }
  else if (gesture.type === 'crop' && gesture.hit) {
    const im = CUR(), G = currentGeometry(), h = gesture.hit, c0 = gesture.crop; const [fx, fy] = screenToFrame(x, y), [fx0, fy0] = screenToFrame(gesture.x, gesture.y);
    const dx = (fx - fx0) / G.Wr, dy = (fy - fy0) / G.Hr; let c = { ...c0 }; const minW = 0.05, minH = 0.05;
    if (h.move) { c.x = clamp(c0.x + dx, 0, 1 - c0.w); c.y = clamp(c0.y + dy, 0, 1 - c0.h); }
    else {
      let x0 = c0.x, y0 = c0.y, x1 = c0.x + c0.w, y1 = c0.y + c0.h;
      if (h.l) x0 = clamp(x0 + dx, 0, x1 - minW); if (h.r) x1 = clamp(x1 + dx, x0 + minW, 1); if (h.t) y0 = clamp(y0 + dy, 0, y1 - minH); if (h.b) y1 = clamp(y1 + dy, y0 + minH, 1);
      const a = aspectValue(im.params.geo, G.Wr, G.Hr);
      if (a) { // keep aspect: adjust the dimension not being dragged (or height when a corner)
        let w = x1 - x0, hh = y1 - y0; const px = G.Wr, py = G.Hr;
        if ((h.l || h.r) && !(h.t || h.b)) { hh = w * px / a / py; const cy = (y0 + y1) / 2; y0 = cy - hh / 2; y1 = cy + hh / 2; }
        else if ((h.t || h.b) && !(h.l || h.r)) { w = hh * py * a / px; const cx = (x0 + x1) / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
        else { hh = w * px / a / py; if (h.t) y0 = y1 - hh; else y1 = y0 + hh; }
        if (x0 < 0 || x1 > 1 || y0 < 0 || y1 > 1) return;
      }
      c = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    im.params.geo.crop = c; gesture.moved = true; drawOverlay();
  }
});
const ptrUp = e => { if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); if (gesture && gesture.type === 'crop' && gesture.moved) commit();
  if (gesture && (gesture.type === 'paint' || gesture.type === 'mask')) { commit(); if (e.pointerType !== 'mouse') state.cursor = null; requestRender(false); } if (ptrs.size === 0 && gesture && gesture.type !== 'pan') gesture = { lastTap: 0 }; if (ptrs.size === 0 && gesture && gesture.type === 'pan') gesture = { lastTap: gesture.lastTap }; };
view.addEventListener('pointerup', ptrUp); view.addEventListener('pointercancel', ptrUp);
view.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && state.cursor && !ptrs.size) { state.cursor = null; drawOverlay(); } });
let spaceDown = false;
addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });
view.addEventListener('wheel', e => {
  if (!CUR() || state.cropMode) return; e.preventDefault(); const [x, y] = canvasPt(e); const k = Math.exp(-e.deltaY * 0.0015); const nz = clamp(state.zoom * k, 1, 16); const kk = nz / state.zoom;
  const cx = view.width / 2, cy = view.height / 2; state.panX = (state.panX - (x - cx)) * kk + (x - cx); state.panY = (state.panY - (y - cy)) * kk + (y - cy); state.zoom = nz; clampPan(); updateZoomLabel(); if (state.cursor) state.cursor = [x, y]; requestDraw();
}, { passive: false });
function clampPan() { const G = currentGeometry(); const fit = Math.min(view.width / G.outW, view.height / G.outH) * state.zoom; const hw = Math.max(0, (G.outW * fit - view.width) / 2), hh = Math.max(0, (G.outH * fit - view.height) / 2); state.panX = clamp(state.panX, -hw, hw); state.panY = clamp(state.panY, -hh, hh); }

// ---------- compare ----------
const cmpBtn = $('#btnCompare');
function ensureBefore() { if (!renderer.resultBefore && renderer.src) renderer.renderResult(DEFAULT_U, geometry(CUR().params.geo, CUR().fullW, CUR().fullH, state.cropMode), previewQ(), 'resultBefore'); }
cmpBtn.addEventListener('pointerdown', e => { e.preventDefault(); if (!CUR()) return; cmpBtn.setPointerCapture(e.pointerId); ensureBefore(); if (state.compare !== 2) { state.compare = 1; draw(); } });
const cmpUp = () => { if (state.compare === 1) { state.compare = 0; draw(); } };
cmpBtn.addEventListener('pointerup', cmpUp); cmpBtn.addEventListener('pointercancel', cmpUp);
cmpBtn.addEventListener('dblclick', () => { if (!CUR()) return; ensureBefore(); state.compare = state.compare === 2 ? 0 : 2; cmpBtn.classList.toggle('on', state.compare === 2); draw(); toast(state.compare === 2 ? '分割檢視：左原圖 / 右編輯。拖曳分隔線可移動。' : '離開分割檢視'); });

// ---------- files ----------
if (IS_IOS || IS_TOUCH) $('#fileInput').removeAttribute('accept');
if (IS_IOS) $('#iosHint').style.display = '';
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
const vw = $('#viewwrap');
vw.addEventListener('dragover', e => { e.preventDefault(); }); vw.addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
const RAW_EXT = /\.(arw|srf|sr2|nef|nrw|raf|dng|cr2|cr3|crw|orf|rw2|pef|srw|x3f|3fr|fff|iiq|rwl|raw|mrw|erf|kdc|dcr|mos|mef)$/i;
async function addFiles(files) {
  const jsons = files.filter(f => /\.json$/i.test(f.name)); const raws = []; let skipped = 0;
  for (const f of files) {
    if (/\.json$/i.test(f.name)) continue;
    f._isImage = await isBrowserImage(f, RAW_EXT);
    if (f._isImage || RAW_EXT.test(f.name)) raws.push(f);
    else if (/^(video|audio|text)\//.test(f.type || '') || /\.(mov|mp4|m4v|avi|pdf|zip|txt|aae|xmp|nksc)$/i.test(f.name)) skipped++;
    else raws.push(f); // unknown extension: let LibRaw try
  }
  if (skipped) toast(`已略過 ${skipped} 個不支援的檔案（影片、文件等）`);
  if (!raws.length && !jsons.length) { if (!skipped) toast('沒有可開啟的照片'); return; }
  const sidecars = new Map(); for (const j of jsons) { try { sidecars.set(j.name.replace(/\.json$/i, '').toLowerCase(), JSON.parse(await j.text())); } catch { } }
  // a lone json: apply to current image
  if (!raws.length && jsons.length && CUR()) { const j = [...sidecars.values()][0]; applyLoadedSettings(j); return; }
  let firstNew = -1;
  for (const f of raws) {
    if (images.some(i => i.key === imgKey(f))) continue;
    const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    const side = sidecars.get(base) || sidecars.get(f.name.toLowerCase());
    const saved = loadEdits(imgKey(f));
    const params = side ? mergeParams(side.params || side) : (saved || clone(defaultsFor(f)));
    const im = { id: Math.random().toString(36).slice(2), file: f, name: f.name, key: imgKey(f), params, hist: [JSON.stringify(params)], hi: 0, edited: !!(side || saved), meta: null, thumbUrl: null, fullW: 0, fullH: 0 };
    images.push(im); if (firstNew < 0) firstNew = images.length - 1;
    makeThumb(im);
  }
  $('#drop').style.display = 'none'; $('#filmstrip').classList.toggle('hidden', images.length < 2);
  updateFilmstrip();
  if (firstNew >= 0) selectImage(firstNew);
}
// thumbnails are extracted one at a time so opening many files does not spawn many workers at once
const thumbQueue = []; let thumbBusy = false;
function makeThumb(im) { thumbQueue.push(im); pumpThumbs(); }
async function pumpThumbs() {
  if (thumbBusy) return; thumbBusy = true;
  while (thumbQueue.length) { const im = thumbQueue.shift(); if (im.thumbUrl) continue; await makeThumbNow(im); }
  thumbBusy = false;
}
async function makeThumbNow(im) {
  try {
    const r = await decodeFile(im.file, { wantThumb: true, thumbOnly: true });
    im.meta = r.meta; if (r.lensMD !== undefined) im.lensMD = r.lensMD;
    if (r.thumbURL) { im.thumbUrl = r.thumbURL; if (!im.thumbBlobUrl) im.thumbBlobUrl = URL.createObjectURL(im.file); }
    else if (r.thumb) { const blob = new Blob([r.thumb], { type: 'image/jpeg' }); im.thumbBlobUrl = URL.createObjectURL(blob); try { const bm = await createImageBitmap(blob, { resizeWidth: 240, resizeQuality: 'medium' }); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0); im.thumbUrl = c.toDataURL('image/jpeg', 0.7); bm.close(); } catch { im.thumbUrl = im.thumbBlobUrl; } }
    updateFilmstrip(); if (CUR() === im) showInfo();
  } catch (e) { console.warn('thumb', e); }
}
let loadSeq = 0;
async function selectImage(i) {
  if (i < 0 || i >= images.length) return; if (cur !== i) state.maskSel = -1; cur = i; const im = CUR(); const seq = ++loadSeq;
  $('#fname').textContent = im.name; $('#finfo').textContent = '';
  updateFilmstrip(); refreshAll(); updateUndoButtons(); showInfo(); $('#btnExport').disabled = true;
  // show embedded preview while decoding
  const ti = $('#thumbimg'); if (im.thumbBlobUrl) { ti.src = im.thumbBlobUrl; ti.style.display = 'block'; } else ti.style.display = 'none';
  renderer.resultBefore = null; state.compare = 0; cmpBtn.classList.remove('on');
  status('載入 ' + im.name + '…');
  try {
    const r = await decodeFile(im.file, { half: true, wantThumb: !im.thumbBlobUrl }, p => { if (seq === loadSeq) status(p); });
    if (seq !== loadSeq) return; // user moved on
    const sc = r.scale || 2;
    im.meta = r.meta; im.lensMD = r.lensMD ?? null; im.previewW = r.width; im.previewH = r.height; im.previewScale = sc; im.fullW = r.width * sc; im.fullH = r.height * sc;
    if (im.meta && im.meta.width) { const mw = (im.meta.flip & 4) ? im.meta.height : im.meta.width, mh = (im.meta.flip & 4) ? im.meta.width : im.meta.height; if (Math.abs(mw - im.fullW) <= 2 && Math.abs(mh - im.fullH) <= 2) { im.fullW = mw; im.fullH = mh; } }
    state.previewData = { data: r.data, w: r.width, h: r.height, scale: sc, imId: im.id };
    renderer.setSource(r.data, r.width, r.height, sc, im.fullW, im.fullH);
    if (r.thumbURL && !im.thumbUrl) { im.thumbUrl = r.thumbURL; updateFilmstrip(); }
    if (r.thumb && !im.thumbBlobUrl) { im.thumbBlobUrl = URL.createObjectURL(new Blob([r.thumb], { type: 'image/jpeg' })); im.thumbUrl = im.thumbBlobUrl; updateFilmstrip(); }
    ti.style.display = 'none';
    curveEd.setCurves(im.params.curves); renderer.setCurveLUT(curveLUTFor(im.params));
    fitCanvas(); fitView(); refreshLensUI(); refreshLocalUI(); requestRender(false); showInfo(); $('#btnExport').disabled = false;
    schedulePresetThumbs();
    $('#finfo').textContent = `${im.fullW}×${im.fullH} · 預覽 ${r.width}×${r.height} · ${(r.timings.total / 1000).toFixed(1)}s`;
    status('');
    if (im.file._isImage && IS_IOS && /\.jpe?g$/i.test(im.name) && !selectImage.iosHint) { selectImage.iosHint = true; toast('提示：從「照片圖庫」選的照片，iPhone 一律轉成 JPEG 給網頁，RAW 也會被轉。要修 RAW 請按＋選「選擇檔案」。', 8000); }
  } catch (e) { if (seq === loadSeq) { status(''); toast('無法開啟：' + friendlyError(e), 8000); ti.style.display = 'none'; } console.error(e); }
}
function updateFilmstrip() {
  const fs = $('#filmstrip'); fs.innerHTML = '';
  images.forEach((im, i) => { const d = el('div', { class: 'fs' + (i === cur ? ' cur' : '') + (im.edited ? ' edited' : ''), title: im.name, onclick: () => selectImage(i) }, el('span', {}, im.name)); if (im.thumbUrl) d.style.backgroundImage = `url(${im.thumbUrl})`; fs.append(d); });
  if (images.length >= 2 && !fs.classList.contains('userhidden')) fs.classList.remove('hidden');
  fitCanvas(); requestDraw();
}
$('#btnFilm').onclick = () => { const fs = $('#filmstrip'); fs.classList.toggle('hidden'); fs.classList.toggle('userhidden', fs.classList.contains('hidden')); };
function showInfo() {
  const im = CUR(); const box = $('#infobox'); if (!im) { box.textContent = '尚未開啟照片。'; return; } const m = im.meta || {};
  const sh = m.shutter ? (m.shutter >= 1 ? m.shutter.toFixed(1) + 's' : '1/' + Math.round(1 / m.shutter) + 's') : '';
  const dt = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : '';
  box.innerHTML = `<b>${im.name}</b><br>${[m.make, m.model].filter(Boolean).join(' ')}<br>${m.lens || ''}<br>${[m.focal ? Math.round(m.focal) + 'mm' : '', m.aperture ? 'f/' + m.aperture.toFixed(1) : '', sh, m.iso ? 'ISO ' + Math.round(m.iso) : ''].filter(Boolean).join(' · ')}<br>${dt}<br>${im.fullW ? `尺寸 ${im.fullW}×${im.fullH}` : ''} ${m.kind === 'image' ? '· ' + m.format : m.filters === 9 ? '· X-Trans' : m.filters ? '· Bayer' : m.colors === 3 ? '· 線性 DNG' : ''}<br><span style="font-size:11px">檔案大小 ${(im.file.size / 1048576).toFixed(1)} MB</span>`;
}

// ---------- settings json / clipboard ----------
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
function settingsJSON(im) { return JSON.stringify({ app: 'RAW Editor', version: 1, file: im.name, params: stripAmount(im.params) }, null, 1); }
function applyLoadedSettings(j) { const im = CUR(); if (!im) return; im.params = mergeParams(j.params || j); im.presetId = null; refreshAll(); commit(); toast('已套用設定'); }
$('#btnMenu').onclick = () => { $('#modalMenu').classList.add('on'); };
$('#menuClose').onclick = () => $('#modalMenu').classList.remove('on');
for (const m of document.querySelectorAll('.modal')) m.addEventListener('click', e => { if (e.target === m) m.classList.remove('on'); });
$('#mSaveJson').onclick = () => { const im = CUR(); if (!im) return; download(new Blob([settingsJSON(im)], { type: 'application/json' }), im.name.replace(/\.[^.]+$/, '') + '.json'); };
$('#mLoadJson').onclick = () => { const inp = el('input', { type: 'file', accept: '.json' }); inp.onchange = async () => { try { applyLoadedSettings(JSON.parse(await inp.files[0].text())); } catch (e) { toast('讀取失敗：' + e.message); } }; inp.click(); };
$('#mCopy').onclick = () => { const im = CUR(); if (!im) return; state.clipboard = stripAmount(im.params); toast('已複製設定'); };
$('#mPaste').onclick = () => openPasteDialog(false);
$('#mPasteAll').onclick = () => openPasteDialog(true);
$('#mReset').onclick = () => { const im = CUR(); if (!im) return; im.params = clone(defaultsFor(im)); im.presetId = null; refreshAll(); fitView(); commit(); };
$('#mExportPresets').onclick = () => download(new Blob([JSON.stringify({ app: 'RAW Editor', presets: userPresets }, null, 1)], { type: 'application/json' }), 'raw-editor-presets.json');
$('#mImportPresets').onclick = () => { const inp = el('input', { type: 'file', accept: '.json' }); inp.onchange = async () => { try { const j = JSON.parse(await inp.files[0].text()); const list = j.presets || (Array.isArray(j) ? j : null); if (!list) throw new Error('格式不符'); for (const p of list) if (p && p.name && p.p) userPresets.push(p); saveUserPresets(); renderPresetGrid(); toast('已匯入 ' + list.length + ' 個預設集'); } catch (e) { toast('匯入失敗：' + e.message); } }; inp.click(); };
$('#optHQ').checked = state.hq; $('#optHQ').onchange = e => { state.hq = e.target.checked; try { localStorage.setItem('rawedit:hq', state.hq ? '1' : '0'); } catch { } };
$('#optHist').checked = state.hist; $('#optHist').onchange = e => { state.hist = e.target.checked; try { localStorage.setItem('rawedit:hist', state.hist ? '1' : '0'); } catch { } updateHistogram(); };
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'ArrowRight' && !e.ctrlKey) selectImage(cur + 1); else if (e.key === 'ArrowLeft' && !e.ctrlKey) selectImage(cur - 1);
  else if (e.key === ' ' && state.tab === 'local' && activeMask() && activeMask().type === 'brush') { e.preventDefault(); spaceDown = true; }
  else if ((e.key === 'o' || e.key === 'O') && state.tab === 'local' && activeMask()) { state.showMask = !state.showMask; refreshLocalUI(); requestRender(false); }
  else if (e.key === '[' || e.key === ']') { if (state.tab === 'local') { setParam('T.size', clamp(state.tool.size + (e.key === ']' ? 5 : -5), 1, 100)); } }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.tab === 'local' && activeMask()) { e.preventDefault(); delMask(); }
  else if (e.key === '\\' || e.key === ' ') { if (!CUR()) return; e.preventDefault(); ensureBefore(); state.compare = state.compare === 1 ? 0 : 1; draw(); }
  else if (e.key === '0') { fitView(); requestDraw(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { $('#mCopy').onclick(); } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { pasteSettings(false, lastPasteGroups()); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); $('#btnExport').click(); }
});

// ---------- export ----------
const modalExport = $('#modalExport');
$('#btnExport').onclick = () => { if (!CUR()) return; if (LOW_MEM && !modalExport.dataset.init) { $('#expSize').value = '4000'; } modalExport.dataset.init = 1; $('#expMsg').textContent = ''; $('#expBar').style.width = '0'; $('#expGo').disabled = false; $('#expGo').textContent = '開始匯出'; $('#expScope').style.display = images.length > 1 ? '' : 'none'; $('#expScope').parentElement.style.display = images.length > 1 ? '' : 'none'; modalExport.classList.add('on'); };
{ const f = $('#expFmt'); try { f.value = localStorage.getItem('rawedit:fmt') || 'jpeg'; } catch { } const sync = () => { $('#expQRow').style.display = f.value === 'tiff' ? 'none' : ''; try { localStorage.setItem('rawedit:fmt', f.value); } catch { } }; f.onchange = sync; sync(); }
$('#expCancel').onclick =() => { if (state.busy) state.cancelExport = true; else modalExport.classList.remove('on'); };
$('#expGo').onclick = async () => {
  if (state.busy) return; state.busy = true; state.cancelExport = false; $('#expGo').disabled = true; $('#expGo').textContent = '處理中…';
  const sizeSel = $('#expSize').value, quality = clamp(+$('#expQ').value || 92, 50, 100), demosaic = $('#expDemosaic').value, wantExif = $('#expExif').checked, format = $('#expFmt').value;
  const list = $('#expScope').value === 'all' ? images.slice() : [CUR()];
  const results = []; let keptMB = 0;
  const shareBatch = list.length > 1 && IS_TOUCH && !!navigator.canShare && format === 'jpeg';
  try {
    for (let n = 0; n < list.length; n++) {
      const im = list[n]; if (state.cancelExport) break;
      const prog = (msg, f) => { $('#expMsg').textContent = (list.length > 1 ? `(${n + 1}/${list.length}) ` : '') + msg; $('#expBar').style.width = Math.round(f * 100) + '%'; };
      const blob = await exportImage(im, { sizeSel, quality, demosaic, wantExif, format }, prog);
      if (!blob) continue;
      const outName = im.name.replace(/\.[^.]+$/, '') + (format === 'tiff' ? '_edit.tif' : '_edit.jpg');
      // batch on a phone: keep JPEGs (up to ~400 MB) so they can be shared / saved to Photos in one go; otherwise save right away
      // and drop the blob so memory does not grow with every photo
      const keep = (list.length === 1 && navigator.canShare && IS_TOUCH) || (list.length > 1 && shareBatch && keptMB + blob.size / 1048576 < 400);
      if (keep) { keptMB += blob.size / 1048576; results.push({ blob, name: outName, size: blob.size }); }
      else { download(blob, outName); results.push({ name: outName, size: blob.size }); }
    }
    if (results.length === 1 && navigator.canShare && IS_TOUCH) {
      const f = new File([results[0].blob], results[0].name, { type: results[0].blob.type || 'image/jpeg' });
      $('#expMsg').innerHTML = ''; const row = el('div', { class: 'toolbar' });
      if (navigator.canShare({ files: [f] })) row.append(el('button', { class: 'primary', onclick: async () => { try { await navigator.share({ files: [f] }); } catch (e) { } } }, '分享 / 儲存到相簿'));
      row.append(el('button', { onclick: () => download(results[0].blob, results[0].name) }, '下載檔案'));
      $('#expMsg').append(el('div', { class: 'hint' }, `完成：${results[0].name}（${(results[0].blob.size / 1048576).toFixed(1)} MB）`), row);
    } else if (results.length) {
      $('#expMsg').textContent = `完成 ${results.length} 張，共 ${(results.reduce((a, r) => a + r.size, 0) / 1048576).toFixed(1)} MB`;
      const kept = results.filter(r => r.blob);
      if (kept.length) {
        const files = kept.map(r => new File([r.blob], r.name, { type: r.blob.type || 'image/jpeg' })); const row = el('div', { class: 'toolbar' });
        if (navigator.canShare({ files })) row.append(el('button', { class: 'primary', onclick: async () => { try { await navigator.share({ files }); } catch (e) { } } }, `分享 / 儲存 ${files.length} 張到相簿`));
        row.append(el('button', { onclick: () => kept.forEach((r, i) => setTimeout(() => download(r.blob, r.name), i * 400)) }, '全部下載'));
        $('#expMsg').append(row);
        if (kept.length < results.length) $('#expMsg').append(el('div', { class: 'hint' }, `另外 ${results.length - kept.length} 張已直接下載（避免占用太多記憶體）。`));
      }
    }
    else if (state.cancelExport) $('#expMsg').textContent = '已取消';
  } catch (e) { console.error(e); $('#expMsg').textContent = '匯出失敗：' + friendlyError(e); }
  finally { state.busy = false; $('#expGo').disabled = false; $('#expGo').textContent = '再次匯出'; $('#expBar').style.width = '100%'; if (CUR() && state.previewData && state.previewData.imId === CUR().id) { /* preview source restored by renderer */ } requestRender(false); }
};
async function exportImage(im, o, prog) {
  const params = im.params; const Gfull0 = geometry(params.geo, im.fullW || 1, im.fullH || 1);
  const longEdge = Math.max(Gfull0.outW, Gfull0.outH);
  let target = o.sizeSel === 'full' ? Infinity : o.sizeSel === 'preview' ? longEdge / 2 : +o.sizeSel;
  // choose decode scale: half-size is a true box downsample, good when the target is at most half of the full output
  let src;
  if (target <= longEdge / 2 && state.previewData && state.previewData.imId === im.id) { src = state.previewData; }
  else if (target <= longEdge / 2) { prog('解碼（半尺寸）…', 0.02); const r = await decodeFile(im.file, { half: true }, m => prog(m, 0.05)); src = { data: r.data, w: r.width, h: r.height, scale: r.scale || 2 }; }
  else { prog('全解析度解碼，請稍候…', 0.02); const q = o.demosaic === 'auto' ? undefined : +o.demosaic; const r = await decodeFile(im.file, { half: false, quality: q }, m => prog(m, 0.05)); src = { data: r.data, w: r.width, h: r.height, scale: 1 }; }
  if (state.cancelExport) return null;
  const fullW = src.w * src.scale, fullH = src.h * src.scale;
  const G = geometry(params.geo, fullW, fullH);
  let outW = G.outW, outH = G.outH, m = G.m;
  if (isFinite(target) && Math.max(outW, outH) > target) { const s = Math.max(outW, outH) / target; outW = Math.round(outW / s); outH = Math.round(outH / s); m = [m[0] * s, m[1] * s, m[2], m[3] * s, m[4] * s, m[5], m[6], m[7], m[8]]; }
  const meta = im.meta || {}; const dt = meta.timestamp ? new Date(meta.timestamp * 1000) : new Date();
  const pad = n => String(n).padStart(2, '0'); const dts = `${dt.getFullYear()}:${pad(dt.getMonth() + 1)}:${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const exif = o.wantExif ? { make: meta.make, model: meta.model, software: 'RAW Editor (LibRaw)', dateTime: dts, exposure: meta.shutter, fnumber: meta.aperture, iso: meta.iso, focal: meta.focal, lens: meta.lens } : null;
  const tiff = o.format === 'tiff';
  const enc = tiff ? new TiffEncoder(outW, outH, exif) : new JpegEncoder(outW, outH, o.quality, exif);
  const U = uniformsFromParams(params, im, { export: true });
  if (U.useBrush) syncBrush(im);
  // make sure the LUT matches this image
  renderer.setCurveLUT(curveLUTFor(params));
  try {
    await renderer.renderExport(U, { outW, outH, m }, src, (rows, n) => enc.addRows(rows, n), prog, () => state.cancelExport, tiff ? 16 : 8);
  } finally { if (CUR()) { renderer.setCurveLUT(curveLUTFor(CUR().params)); syncBrush(CUR()); } } // restore LUT and brush texture for the current image
  if (state.cancelExport) return null;
  prog(tiff ? '寫入 TIFF…' : '寫入 JPEG…', 0.98);
  if (tiff) return enc.finish();
  return new Blob([enc.finish()], { type: 'image/jpeg' });
}

// ---------- boot ----------
window.__dbg = { curveLUTFor, calibMatrix, wbFromRGB, autoWB, histLabel, pasteSettings, COPY_GROUPS, FILM_LUTS: typeof FILM_LUTS !== "undefined" ? FILM_LUTS : null, decodeFilmLUT, loadFilmLUTs, images, state, clone, defaultsFor, applyPreset, CurveEditor, schedulePresetThumbs, get renderer() { return renderer; }, get cur() { return CUR(); }, selectTab, setParam, commit, geometry, requestRender, exportImage, applyPresetUI, PRESETS, selectImage, undo, redo, refreshAll, updateHistogram, curveEd, decodeFile, addMask, activeMask, selectMask, strokeStart, strokeMove, isoToCanvas, canvasToIso, maskDrag, BR, uniformsFromParams, buildLensTable, get view() { return view; } };
buildPanels(); fitCanvas();
if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
(async () => {
  try {
    await decoder.init(); const v = decoder.version, n = decoder.cameras; decoder.terminate();
    $('#caps').textContent = `LibRaw ${v} · 支援 ${n} 款相機 · WebGL2 ✓ · 最大材質 ${renderer.maxTex}px` + (IS_TOUCH ? ' · 觸控模式' : '');
    $('#about').innerHTML = `RAW Editor — 單一 HTML 檔、純瀏覽器運作，不上傳任何資料。<br>解碼：LibRaw ${v}（LGPL 2.1 / CDDL 1.0），WebAssembly 建置來自 @colorhythm/libraw-wasm（MIT）。<br>調色：WebGL2，OkLab 色彩空間。匯出：內建串流 JPEG 編碼器（4:4:4）。<br>膠片模擬 LUT：改編自 RawTherapee Film Simulation Collection（Pat David、Pavlov Dmitry、Michael Ezra，CC BY-SA 4.0）、t3mujinpack（MIT）、FilmSim（CC0），詳見 FILM_LUTS.md。<br>快捷鍵：Ctrl+Z 復原、Ctrl+Shift+Z 重做、空白鍵/\\ 比較原圖、← → 切換照片、0 符合視窗、滑桿連點兩下重設、Shift 拖曳微調。`;
  } catch (e) { $('#caps').textContent = '解碼器初始化失敗：' + e.message; console.error(e); }
})();
