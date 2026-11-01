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
let toastT; function toast(msg, ms = 2400, opts = {}) { // design-system toast: icon for success / error, at most one action
  const t = $('#toast'); const err = opts.kind === 'err' || /^(無法|匯出失敗|讀取失敗)|失敗：/.test(msg), ok = !err && (opts.kind === 'ok' || /^已/.test(msg));
  t.className = err ? 'err' : ''; t.innerHTML = ''; if (err || ok) { const s = el('span', { class: err ? 'err' : 'ok' }); s.innerHTML = iconSVG(err ? 'close' : 'check', 16); t.append(s); }
  t.append(el('span', {}, msg)); if (opts.action) { t.append(el('button', { class: 'act', onclick: () => { t.classList.remove('on'); opts.action.fn(); } }, opts.action.label)); ms = Math.max(ms, 5000); }
  void t.offsetWidth; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }
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
  maskSel: -1, showMask: false, tool: { size: 20, feather: 60, flow: 100, erase: false, spotSize: 25, spotFeather: 50, dustSens: 30, healMode: 'heal' }, cursor: null };
const TOOL_DEFAULTS = { size: 20, feather: 60, flow: 100, spotSize: 25, spotFeather: 50, dustSens: 30 };
const SPOT_DEFAULTS = { size: 25, feather: 50, opacity: 100, pupil: 50, darken: 50 };
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
function mapPt(m, x, y) { const w = m[2] * x + m[5] * y + m[8]; return [(m[0] * x + m[3] * y + m[6]) / w, (m[1] * x + m[4] * y + m[7]) / w]; } // projective
// Returns {outW,outH,m, Wr,Hr, frame:mat (frame px -> full px)} for params.geo over a full image W×H
function geometry(geo, W, H, ignoreCrop = false) {
  const k = ((geo.rot % 4) + 4) % 4; const Wr = k % 2 ? H : W, Hr = k % 2 ? W : H;
  const Rinv = [M(1, 0, 0, 1, 0, 0), M(0, -1, 1, 0, 0, H), M(-1, 0, 0, -1, W, H), M(0, 1, -1, 0, W, 0)][k];
  let F = M(1, 0, 0, 1, 0, 0); if (geo.flipH) F = mmul(F, M(-1, 0, 0, 1, Wr, 0)); if (geo.flipV) F = mmul(F, M(1, 0, 0, -1, 0, Hr));
  const a = geo.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const s = Math.cos(Math.abs(a)) + (Math.max(Wr, Hr) / Math.min(Wr, Hr)) * Math.sin(Math.abs(a));
  const Cx = Wr / 2, Cy = Hr / 2;
  const rotS = t => M(ca * t, sa * t, -sa * t, ca * t, Cx - (ca * Cx - sa * Cy) * t, Cy - (sa * Cx + ca * Cy) * t); // straighten about the centre, scale t
  let S = rotS(1 / s);
  const P = perspPx(geo, Wr, Hr);
  if (P) { // perspective: zoom (Constrain Crop) so every frame-edge sample stays inside the image, found by bisection
    let t = 1 / s;
    if (geo.constrain !== false) {
      const inside = tt => { const A = mmul(P, rotS(tt)); for (let i = 0; i <= 48; i++) { const u = i / 48; for (const [x, y] of [[u * Wr, 0], [u * Wr, Hr], [0, u * Hr], [Wr, u * Hr]]) { const q = mapPt(A, x, y); if (!(q[0] >= -0.5 && q[1] >= -0.5 && q[0] <= Wr + 0.5 && q[1] <= Hr + 0.5)) return false; } } return true; };
      if (inside(1)) t = 1; else { let lo = 0.02, hi = 1; for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid; } t = lo; }
    } else t = 1;
    S = mmul(P, rotS(t));
  }
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
const MASK_TYPES = { linear: 0, radial: 1, brush: 2, sky: 2, subject: 2, background: 2 }; // 2 = raster (brush texture channel)
function packMasks(U, masks) {
  const n = Math.min(8, masks.length); U.nMasks = n; if (!n) return;
  const A = () => new Float32Array(32); U.mG1 = A(); U.mG2 = A(); U.mA = A(); U.mB = A(); U.mC = A(); U.mD = A(); U.mE = A(); U.mF = A();
  const d = MASK_DEFAULTS;
  for (let i = 0; i < n; i++) {
    const m = masks[i], a = Object.assign({}, d.adj, m.adj), o = i * 4, t = MASK_TYPES[m.type] ?? 0;
    const k = (m.amount ?? 100) / 100; if (k !== 1) for (const key of Object.keys(a)) a[key] *= k; // mask amount scales every adjustment
    const cr = m.colorRange; if (cr && cr.on) { U.mE.set([cr.a, cr.b, cr.L, 0.02 + (cr.amt ?? 40) / 100 * 0.25], o); U.anyCR = true; }
    { const cs = (m.adj && m.adj.colorSat || 0) / 100 * k, ch = okHueRad((m.adj && m.adj.colorHue) ?? 30); U.mF.set([a.hue / 100, a.noise / 100, Math.cos(ch) * 0.08 * cs, Math.sin(ch) * 0.08 * cs], o); }
    if (t === 0) U.mG1.set([m.x0, m.y0, m.x1, m.y1], o); else if (t === 1) U.mG1.set([m.cx, m.cy, m.rx, m.ry], o);
    U.mG2.set([t === 1 ? (m.angle || 0) * Math.PI / 180 : t === 2 ? m.ch : 0, (m.feather ?? d.feather) / 100, m.invert ? 1 : 0, t], o);
    U.mA.set([a.exposure, a.contrast / 100, a.highlights / 100, a.shadows / 100], o);
    U.mB.set([a.whites / 100, a.blacks / 100, a.temp / 100, a.tint / 100], o);
    U.mC.set([a.saturation / 100, a.clarity / 100, a.dehaze / 100, a.texture / 100], o);
    U.mD.set([a.sharpen / 100, (m.lumLo ?? 0) / 100, (m.lumHi ?? 100) / 100, m.hidden ? 0 : (m.opacity ?? 100) / 100], o);
    if (t === 2) U.useBrush = true;
    if (a.sharpen || a.texture || a.noise) U.maskDetail = true;
  }
}

// ---------- profiles (from LightCraft's built-in profiles, MIT) ----------
// A profile is a set of slider deltas added under the user's sliders (the sliders keep showing the user's own values),
// scaled by the profile amount. 'color' is the plain base rendering; 'flat' also turns off the RAW base tone map.
// Deltas are LightCraft's numbers converted to this editor's slider scale (highlights/whites/blacks x0.6, shadows x0.8).
const PROFILE_LIST = [['color', '色彩'], ['neutral', '中性'], ['vivid', '鮮豔'], ['landscape', '風景'], ['portrait', '人像'], ['mono', '單色'], ['flat', '平淡']];
const PROFILES = {
  neutral: { contrast: -18, saturation: -10, highlights: -6, shadows: 6 },
  vivid: { contrast: 16, saturation: 14, vibrance: 14, blacks: -4 },
  landscape: { contrast: 10, vibrance: 10, clarity: 6, hsl: { s: [0, 0, 0, 14, 10, 14, 0, 0], l: [0, 0, 0, 0, 0, -6, 0, 0] } },
  portrait: { contrast: -6, texture: -6, hsl: { s: [-5, -8, 0, 0, 0, 0, 0, 0], l: [0, 6, 0, 0, 0, 0, 0, 0] } },
  mono: { bw: true, contrast: 8 },
};
let profileUI = {};
function profileParams(p) {
  const d = PROFILES[p.profile]; if (!d) return p;
  const k = Math.max(0, Math.min(2, (p.profileAmt ?? 100) / 100)); if (!k) return p;
  const q = Object.assign({}, p), cl = v => Math.max(-100, Math.min(100, v));
  for (const [key, v] of Object.entries(d)) {
    if (key === 'bw') q.bw = true;
    else if (key === 'hsl') { q.hsl = { h: p.hsl.h.slice(), s: p.hsl.s.slice(), l: p.hsl.l.slice() }; for (const c of ['h', 's', 'l']) if (v[c]) q.hsl[c] = q.hsl[c].map((x, i) => cl(x + v[c][i] * k)); }
    else q[key] = cl((p[key] || 0) + v * k);
  }
  return q;
}
function refreshProfileUI() {
  const im = CUR(); if (!profileUI.chips) return; const cur = im ? (im.params.profile || 'color') : 'color';
  [...profileUI.chips.children].forEach(b => b.classList.toggle('on', b.dataset.p === cur));
}
// Auto tone (LightCraft's recipe, fitted to Lightroom on raw files): exposure from the mean log luminance of the white-balanced
// source, plus a fixed recovery recipe, converted to this editor's slider scale.
function autoTone() {
  const im = CUR(), pd = state.previewData; if (!im || !pd || pd.imId !== im.id) return;
  const U = baseUniforms(im.params), w = U.wb, d = pd.data, n = pd.w * pd.h, step = Math.max(1, Math.floor(n / 250000)); let s = 0, k = 0;
  for (let p = 0; p < n; p += step) { const i = p * 3, y = (0.2126 * d[i] * w[0] + 0.7152 * d[i + 1] * w[1] + 0.0722 * d[i + 2] * w[2]) / 65535; s += Math.log2(Math.max(y, 1e-6) / 0.18); k++; }
  const m = s / Math.max(k, 1), raw = !im.file._isImage;
  const exposure = Math.round(Math.max(-2, Math.min(3, -0.58 - 0.41 * m)) * 100) / 100;
  Object.assign(im.params, raw ? { exposure, contrast: 24, highlights: -40, shadows: 42, whites: 0, blacks: 0, vibrance: 20, saturation: 0 }
    : { exposure: Math.round(Math.max(-1, Math.min(1, exposure * 0.5)) * 100) / 100, contrast: 10, highlights: -25, shadows: 25, whites: 0, blacks: 0, vibrance: 12, saturation: 0 });
  im.presetId = null; refreshAll(); commit(); toast(`自動：曝光 ${fmt.ev(im.params.exposure)}，亮部、暗部與鮮豔度已調整`);
}

// ---------- camera look: start a RAW from the camera's own JPEG rendering ----------
// The JPEG embedded in a RAW file carries the camera's picture style (tone curve, saturation, white balance rendering); our
// plain RAW rendering is flatter. On import we fit the basic sliders so our rendering matches that JPEG — lightness quantiles,
// mean a/b (cast) and chroma spread, compared in OkLab — and use the result as the photo's starting values. The defaults stay
// at 0, so setting those sliders back to 0 gives the plain RAW rendering again.
// key, min, max, finite-difference step, prior scale. The tone sliders overlap (exposure + whites can mimic highlights...), so a
// prior pulls them toward 0: the fit then prefers natural values (brightness mostly from exposure) at a lightness error of
// ~0.005-0.009 OkLab L on test files, instead of exact but odd combinations like highlights +60 / whites -70.
const LOOK_KEYS = [
  ['exposure', -3, 3, 0.12, 4], ['contrast', -100, 100, 8, 12], ['highlights', -100, 100, 8, 12], ['shadows', -100, 100, 8, 12],
  ['whites', -100, 100, 8, 12], ['blacks', -100, 100, 8, 12], ['temp', -60, 60, 4, 30], ['tint', -60, 60, 4, 30], ['saturation', -100, 100, 6, 30]];
const LOOK_Q = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98];
let camLookOn = true; try { camLookOn = localStorage.getItem('rawedit:camlook') !== '0'; } catch { }
const needsCamLook = im => camLookOn && !im.file._isImage && !im.edited && !im.look && im.hist.length === 1 && !!im.thumbBlobUrl;
const LOOK_GW = 40; // colour grid columns (rows follow the aspect ratio)
// OkLab statistics of an RGBA8 image: lightness quantiles, mean a/b, chroma spread; with gw/gh also a block-averaged L/a/b grid
function lookStats(px, w = 0, h = 0, gw = 0, gh = 0) {
  const n = px.length >> 2, Ls = new Float32Array(n); let sa = 0, sb = 0, saa = 0, clip = 0;
  const lin = SRGB8_TO_LIN || (SRGB8_TO_LIN = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }));
  const grid = gw ? new Float32Array(gw * gh * 4) : null; // L, a, b, count
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = lin[px[i]], g = lin[px[i + 1]], b = lin[px[i + 2]]; if (px[i] >= 250 || px[i + 1] >= 250 || px[i + 2] >= 250) clip++;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s, L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    Ls[j] = L; sa += A; sb += B; saa += A * A + B * B;
    if (grid) { const x = j % w, y = (j / w) | 0, k = (((y * gh / h) | 0) * gw + ((x * gw / w) | 0)) * 4; grid[k] += L; grid[k + 1] += A; grid[k + 2] += B; grid[k + 3]++; }
  }
  if (grid) for (let k = 0; k < grid.length; k += 4) { const c = grid[k + 3] || 1; grid[k] /= c; grid[k + 1] /= c; grid[k + 2] /= c; }
  Ls.sort(); const ma = sa / n, mb = sb / n;
  return { q: LOOK_Q.map(f => Ls[Math.round(f * (n - 1))]), a: ma, b: mb, c: Math.sqrt(Math.max(0, saa / n - ma * ma - mb * mb)), grid, clip: clip / n };
}
let SRGB8_TO_LIN = null;
// lightness: quantiles (robust to small framing differences); colour: cell by cell when the two images line up, otherwise
// mean cast + chroma spread (the spread alone is fooled by fine colour detail and noise, so cells are preferred)
// clipping: a channel at the top where the JPEG kept detail costs a lot (lifting mid-tones with exposure would otherwise
// push bright, saturated areas — a yellow wall, a white dress — to flat white; the camera's curve keeps a shoulder there)
const clipResidual = (o, t) => Math.max(0, o.clip - t.clip - 0.002) * 400;
// skin and other warm/pink tones in the JPEG (hue around 20 deg, +-45, moderate chroma) weigh 3x per cell: faces are small,
// but a face that turns grey-green is what people notice first
function skinWeights(grid) {
  const w = new Float32Array(grid.length / 4);
  for (let k = 0; k < grid.length; k += 4) {
    const L = grid[k], a = grid[k + 1], b = grid[k + 2], C = Math.hypot(a, b), h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    const dh = Math.abs(((h - 20 + 540) % 360) - 180), mh = dh < 45 ? 1 : dh < 65 ? (65 - dh) / 20 : 0;
    w[k / 4] = 1 + 2 * (C > 0.008 && C < 0.14 && L > 0.3 && L < 0.92 ? mh : 0);
  }
  return w;
}
function lookResidual(o, t, aligned) {
  const r = o.q.map((v, i) => (v - t.q[i]) * 100); r.push(clipResidual(o, t));
  if (!aligned) { r.push((o.a - t.a) * 250, (o.b - t.b) * 250, (o.c - t.c) * 250); return r; }
  const g = o.grid, h = t.grid, w = 250 / Math.sqrt(g.length / 4), wL = 100 / Math.sqrt(g.length / 4), sw = t.sw;
  // lightness cell by cell only counts fully in the JPEG's mid-tones: in deep shadows the camera's own local lifting
  // (Active D-Lighting, DRO) would otherwise be read as lens vignetting and pull the corner correction up
  for (let k = 0; k < g.length; k += 4) { const e = sw ? sw[k / 4] : 1, m = h[k] > 0.35 && h[k] < 0.88 ? 1 : 0.25; r.push((g[k] - h[k]) * wL * e * m, (g[k + 1] - h[k + 1]) * w * e, (g[k + 2] - h[k + 2]) * w * e); }
  return r;
}
function gridCorrL(a, b) { // Pearson correlation of the lightness grids (tone-independent alignment check)
  let sa = 0, sb = 0, n = 0; for (let k = 0; k < a.length; k += 4) { sa += a[k]; sb += b[k]; n++; }
  const ma = sa / n, mb = sb / n; let c = 0, va = 0, vb = 0;
  for (let k = 0; k < a.length; k += 4) { const x = a[k] - ma, y = b[k] - mb; c += x * y; va += x * x; vb += y * y; }
  return c / Math.sqrt(va * vb || 1e-12);
}
function solveSym(M, v) { // Gaussian elimination with partial pivoting (small dense systems)
  const n = v.length, A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / d; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  const x = new Array(n).fill(0); for (let r = n - 1; r >= 0; r--) { let s = A[r][n]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / (A[r][r] || 1e-12); } return x;
}
// small box-downsampled copy of a 16-bit RGB source, for fitting a photo that is not the one on screen (batch export)
function smallSource(src, maxW) {
  const k = Math.max(1, Math.ceil(Math.max(src.w, src.h) / maxW)), w = Math.floor(src.w / k), h = Math.floor(src.h / k), d = src.data, out = new Uint16Array(w * h * 3);
  const st = Math.max(1, k >> 2); // up to 4x4 samples per block
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, c = 0;
    for (let yy = 0; yy < k; yy += st) for (let xx = 0; xx < k; xx += st) { const i = ((y * k + yy) * src.w + x * k + xx) * 3; r += d[i]; g += d[i + 1]; b += d[i + 2]; c++; }
    const o = (y * w + x) * 3; out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c;
  }
  return { data: out, w, h, scale: src.w * src.scale / w };
}
// fit the camera look for im; src = a decoded source that is not on screen (batch export), otherwise the current preview is used.
// isStale() lets the caller abandon the fit (user switched photos). Returns the fitted values or null.
// Levenberg–Marquardt on slider values. K: [path, min, max, finite-difference step, prior scale]; evalAt(th) -> residuals.
// A prior pulls every slider toward 0 so the fit prefers small, natural values. The Jacobian (one render per slider) is
// refreshed at most `jac` times; up to three steps reuse each one (the sliders are close to linear over a few steps).
// Past `deadline` (performance.now) it stops and keeps the best values so far, so a slow phone never waits long.
async function lmFit(K, evalAt, isStale, jac, deadline = Infinity) {
  const P = K.map(k => 0.5 / k[4]);
  const cost = (r, th) => r.reduce((a, v) => a + v * v, 0) + th.reduce((a, v, i) => a + (P[i] * v) ** 2, 0);
  let th = K.map(() => 0), r = evalAt(th), C = cost(r, th), lambda = 0.01, n = 0;
  for (let it = 0; it < jac; it++) {
    const J = r.map(() => new Float64Array(th.length));
    for (let i = 0; i < th.length; i++) {
      const h = K[i][3] * (th[i] + K[i][3] > K[i][2] ? -1 : 1), t2 = th.slice(); t2[i] += h;
      const r2 = evalAt(t2); for (let k = 0; k < r.length; k++) J[k][i] = (r2[k] - r[k]) / h;
      if (++n % 3 === 0) { await new Promise(res => setTimeout(res, 0)); if (isStale()) return null; }
      if (performance.now() > deadline) return th;
    }
    const JtJ = th.map((_, a) => th.map((_, b) => { let s = 0; for (const row of J) s += row[a] * row[b]; return s + (a === b ? P[a] * P[a] : 0); }));
    let gain = 0;
    for (let step = 0; step < 3; step++) {
      const g = th.map((_, a) => { let s = 0; for (let k = 0; k < r.length; k++) s += J[k][a] * r[k]; return s + P[a] * P[a] * th[a]; });
      let ok = false;
      for (let tries = 0; tries < 4; tries++) {
        const M = JtJ.map((row, a) => row.map((v, b) => a === b ? v * (1 + lambda) + 1e-9 : v)), d = solveSym(M, g);
        const th2 = th.map((v, i) => clamp(v - d[i], K[i][1], K[i][2])), r2 = evalAt(th2), C2 = cost(r2, th2); n++;
        if (C2 < C) { gain += (C - C2) / C; th = th2; r = r2; C = C2; lambda = Math.max(1e-4, lambda / 3); ok = true; break; }
        lambda *= 4;
      }
      if (!ok) break;
      if (isStale()) return null;
      if (performance.now() > deadline) return th;
    }
    if (gain < 0.01) break;
  }
  return th;
}
// HSL band weights, same as bandW() in the shader (OkLCh hue, raised cosine between neighbouring band centres)
const HSL_HUES = [29, 60, 100, 142, 195, 264, 300, 340];
function hslBandW(h, i) {
  const c = HSL_HUES[i], dPrev = (c - HSL_HUES[(i + 7) % 8] + 360) % 360, dNext = (HSL_HUES[(i + 1) % 8] - c + 360) % 360;
  const d = ((h - c + 540) % 360) - 180, t = Math.min(1, Math.abs(d) / (d < 0 ? dPrev : dNext)); return 0.5 + 0.5 * Math.cos(t * Math.PI);
}
const zeroHSL = () => ({ h: new Array(8).fill(0), s: new Array(8).fill(0), l: new Array(8).fill(0) });
function clearCameraLook(p) { for (const [k] of LOOK_KEYS) p[k] = 0; p.hsl = zeroHSL(); p.lens = Object.assign({}, p.lens, { manVig: 0 }); }
// put fitted values into params: plain keys, hsl replaced, lens merged (only manVig is part of the look)
function mergeLook(p, v) { for (const [k, x] of Object.entries(v)) p[k] = k === 'lens' ? Object.assign({}, p.lens, x) : clone(x); return p; }
const setLookKey = (p, k, v) => { const [a, b] = k.split('.'); if (b) { p[a] = Object.assign({}, p[a]); p[a][b] = v; } else p[a] = v; };
// fit the camera look for im; src = a decoded source that is not on screen (batch export), otherwise the current preview is used.
// isStale() lets the caller abandon the fit (user switched photos). Returns the fitted values or null.
// Stage 1: the global sliders (LOOK_KEYS). Stage 2, when the JPEG lines up with our rendering: the HSL sliders of the colour
// bands present in the photo, matched cell by cell. Cameras render each hue their own way (greens, skies, reds...), which
// global temperature / tint / saturation cannot reproduce (Adobe's look tables and darktable's colour LUT play this role).
async function fitCameraLook(im, src, isStale = () => false) {
  let bm;
  try {
    const blob = await (await fetch(im.thumbBlobUrl)).blob();
    bm = await createImageBitmap(blob, { resizeWidth: 256, resizeQuality: 'high' });
    if (bm.width < 64 || bm.height < 32) { bm.close(); return null; }
  } catch (e) { console.warn('camera look: no usable embedded JPEG', e); return null; }
  if (isStale()) { bm.close(); return null; }
  const swap = !!src, t0 = performance.now(); // time budget: global sliders ~6 s, HSL until ~9 s (headless tests take 1-6 s)
  if (swap) { const s = smallSource(src, 512); renderer.setSource(s.data, s.w, s.h, s.scale, src.w * src.scale, src.h * src.scale); }
  const FW = swap ? src.w * src.scale : im.fullW, FH = swap ? src.h * src.scale : im.fullH, imx = swap ? Object.assign({}, im, { fullW: FW, fullH: FH }) : im;
  const base = clone(im.params), G = geometry(base.geo, FW, FH);
  renderer.setCurveLUT(curveLUTFor(base));
  const ow = 192, oh = Math.max(8, Math.round(192 * G.outH / G.outW)), gw = LOOK_GW, gh = Math.max(4, Math.round(LOOK_GW * G.outH / G.outW));
  const statsFor = p => { const U = uniformsFromParams(p, imx, {}); U.showMask = -1; U.clipWarn = 0; const r = renderer.readSmall(U, G, ow, 'look'); return lookStats(r.px, r.w, r.h, gw, gh); };
  let K1 = LOOK_KEYS;
  const with1 = th => { const p = Object.assign({}, base); K1.forEach(([k], i) => setLookKey(p, k, th[i])); return p; };
  try {
    // the embedded JPEG may be stored unrotated (portrait shots) or with another crop: try the orientations that fit the output's
    // aspect and keep the one whose lightness lines up best; colour is compared cell by cell only when it lines up well
    const plain = statsFor(with1(K1.map(() => 0)));
    const swapAR = (bm.width > bm.height) !== (G.outW > G.outH), arJ = swapAR ? bm.height / bm.width : bm.width / bm.height;
    let target = null, best = -2;
    for (const rot of swapAR ? [90, 270] : [0, 180]) {
      const c = document.createElement('canvas'); c.width = ow; c.height = oh; const g = c.getContext('2d', { willReadFrequently: true });
      g.translate(ow / 2, oh / 2); g.rotate(rot * Math.PI / 180); const sw = rot % 180 ? oh : ow, sh = rot % 180 ? ow : oh; g.drawImage(bm, -sw / 2, -sh / 2, sw, sh);
      const t = lookStats(g.getImageData(0, 0, ow, oh).data, ow, oh, gw, gh), corr = gridCorrL(plain.grid, t.grid);
      if (corr > best) { best = corr; target = t; }
    }
    const aligned = best > 0.8 && Math.abs(arJ / (G.outW / G.outH) - 1) < 0.04;
    target.sw = skinWeights(target.grid);
    const info = { corr: +best.toFixed(3), aligned, bands: [] }; fitCameraLook.last = info;
    if (aligned) K1 = [...LOOK_KEYS, ['lens.manVig', -30, 50, 8, 20]];
    const th1 = await lmFit(K1, th => lookResidual(statsFor(with1(th)), target, aligned), isStale, 7, t0 + 6000);
    if (!th1) return null;
    const vals = {}; K1.forEach(([k], i) => { const v = k === 'exposure' ? Math.round(th1[i] * 100) / 100 : Math.round(th1[i]); if (k === 'lens.manVig') vals.lens = { manVig: v }; else vals[k] = v; });
    vals.hsl = zeroHSL();
    if (!aligned || performance.now() > t0 + 7500) return vals;
    // stage 2: bands that cover at least 1 % of the photo (chroma-weighted as the shader applies HSL; skin cells count 3x)
    const p1 = mergeLook(Object.assign({}, base), vals), s1 = statsFor(p1), cells = s1.grid.length / 4, act = new Array(8).fill(0);
    for (let k = 0; k < s1.grid.length; k += 4) {
      const a = s1.grid[k + 1], b = s1.grid[k + 2], C = Math.hypot(a, b); if (C < 0.005) continue;
      const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360, wC = Math.min(1, C / 0.06);
      for (let i = 0; i < 8; i++) act[i] += hslBandW(h, i) * wC * target.sw[k / 4] / cells;
    }
    const bands = act.map((v, i) => v >= 0.01 ? i : -1).filter(i => i >= 0); info.bands = bands;
    if (!bands.length) return vals;
    // hue and saturation only, kept moderate: lightness stays with the tone sliders (an HSL lightness fit would darken blues
    // and greens to make up for tone differences elsewhere, turning a light blue dress into a deep blue one)
    const hp = 15, K2 = []; for (const i of bands) K2.push([`h.${i}`, -25, 25, 6, hp], [`s.${i}`, -40, 40, 6, hp]);
    const with2 = th => { const p = Object.assign({}, p1, { hsl: zeroHSL() }); K2.forEach(([q], i) => { const [c, b] = q.split('.'); p.hsl[c][+b] = th[i]; }); return p; };
    const wab = 250 / Math.sqrt(cells);
    const res2 = o => {
      const r = o.q.map((v, i) => (v - target.q[i]) * 100), g = o.grid, t = target.grid; r.push(clipResidual(o, target));
      for (let k = 0; k < g.length; k += 4) { const e = target.sw[k / 4]; r.push((g[k + 1] - t[k + 1]) * wab * e, (g[k + 2] - t[k + 2]) * wab * e); }
      return r;
    };
    const th2 = await lmFit(K2, th => res2(statsFor(with2(th))), isStale, 2, t0 + 9000);
    if (!th2) return null;
    K2.forEach(([q], i) => { const [c, b] = q.split('.'); vals.hsl[c][+b] = Math.round(th2[i]); });
    return vals;
  } finally {
    bm.close();
    if (swap && state.previewData && CUR()) { const pd = state.previewData; renderer.setSource(pd.data, pd.w, pd.h, pd.scale, CUR().fullW, CUR().fullH); refreshSpotSource(CUR(), true); }
    if (CUR()) renderer.setCurveLUT(curveLUTFor(CUR().params));
  }
}
// the photo's starting point: defaults plus the fitted camera look. Every 「重設」 (photo, section) returns here, like
// Lightroom's reset to the import defaults; double-tapping a single slider still sets that slider to 0.
function startingParams(im) { const p = clone(defaultsFor(im)); if (im.look && camLookOn) mergeLook(p, im.look); return p; }
// apply fitted values as the photo's starting point (not an edit: history starts here, the photo is not marked edited)
function applyCameraLook(im, vals) {
  im.params = mergeLook(clone(im.params), vals); im.look = vals; // a copy: editing the HSL sliders must not change the saved look
  im.hist = [JSON.stringify(im.params)]; im.hi = 0;
}
// 「相機色調」 button: fit again on the current photo (e.g. after resetting), as a normal undoable edit
async function cameraLookButton() {
  const im = CUR(); if (!im || !state.previewData || state.previewData.imId !== im.id) return;
  if (im.file._isImage) { toast('JPEG／HEIC 本來就是相機的顏色，不需要這一步'); return; }
  if (!im.thumbBlobUrl) { toast('這個 RAW 檔裡沒有相機 JPEG 預覽，無法比對'); return; }
  status('比對相機 JPEG 的色調…');
  const keep = clone(im.params); clearCameraLook(im.params);
  const vals = await fitCameraLook(im, null); status('');
  if (!vals) { im.params = keep; toast('無法比對相機 JPEG', 3000, { kind: 'err' }); return; }
  mergeLook(im.params, vals); im.look = vals; im.presetId = null; refreshAll(); commit();
  toast('已套用相機 JPEG 的色調');
}
function camLookToast(im) {
  if (camLookToast.shown) return; camLookToast.shown = true;
  toast('已從相機 JPEG 的色調開始；這些滑桿歸零就是原始 RAW', 6000, { kind: 'ok', action: { label: '改用原始', fn: () => { if (CUR() !== im) return; clearCameraLook(im.params); im.presetId = null; refreshAll(); commit(); } } });
}

// ---------- uniforms ----------
// im (optional) supplies the lens metadata and image size; opts.export disables the on-screen mask overlay.
function uniformsFromParams(p, im, opts = {}) {
  const U = baseUniforms(profileParams(p));
  U.baseTone = im && !(im.file && im.file._isImage) && p.profile !== 'flat' ? 1 : 0; // display-referred JPEG/HEIC get no base tone
  if (im) { const L = lensFor(im, p.lens || DEFAULTS.lens); U.lensOn = L.on; U.lens = L.table; U.defringe = ((p.lens && p.lens.defringe) || 0) / 100; }
  packMasks(U, p.masks || []);
  { const pcs = (p.pointColors || []).slice(0, 4); U.nPC = pcs.length; if (pcs.length) { U.pcA = new Float32Array(16); U.pcB = new Float32Array(16);
    pcs.forEach((q, i) => { U.pcA.set([q.L, q.a, q.b, 0.03 + (q.range ?? 40) / 100 * 0.25], i * 4); U.pcB.set([(q.hue || 0) / 100, (q.sat || 0) / 100, (q.lum || 0) / 100, 0], i * 4); }); } }
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
  { id: 'local', name: '局部' }, { id: 'heal', name: '修復' }, { id: 'fx', name: '效果' }, { id: 'detail', name: '細節' }, { id: 'lens', name: '鏡頭' }, { id: 'crop', name: '裁切' }, { id: 'presets', name: '預設' }, { id: 'info', name: '資訊' },
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
  if (path.startsWith('PC.')) { const [, i, k] = path.split('.'); return [CUR() ? (CUR().params.pointColors || [])[+i] : null, k, PC_DEFAULTS]; }
  if (path.startsWith('S.')) { const s = CUR() && (CUR().params.spots || [])[healUI.sel]; return [s ? Object.assign({ size: 25 }, s) : null, path.slice(2), SPOT_DEFAULTS]; }
  return [CUR() ? CUR().params : null, path, defaultsFor(CUR())];
}
let lastScrollT = 0; document.addEventListener('scroll', () => { lastScrollT = Date.now(); }, { capture: true, passive: true }); // any panel scroll (sliders ignore the tap that stops it)
function makeSlider(path, label, min, max, step, format, grad) {
  // design-system slider: bipolar fill from 0 with a tick, relative drag (mouse: jump when pressed far from the knob),
  // double tap resets, tap the value to type it, keyboard (arrows, Shift = x10, Home/End, Backspace = reset), modified value in amber
  const [, sub0, defs] = sliderTarget(path); const def = getPath(defs, sub0);
  const root = el('div', { class: 'sl' + (grad ? ' colorful' : ''), style: grad ? `--grad:${grad}` : '', role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': String(min), 'aria-valuemax': String(max) });
  const lbl = el('span', { class: 'lbl' }, label), val = el('span', { class: 'val' });
  const track = el('div', { class: 'track' }), fill = el('div', { class: 'fill' }), knob = el('div', { class: 'knob' });
  const zero = min < def && def < max ? el('div', { class: 'zero' }) : null;
  if (zero) track.append(zero); track.append(fill, knob); root.append(lbl, val, track);
  const cur = () => { const [obj, sub] = sliderTarget(path); let v = def; try { if (obj) v = getPath(obj, sub) ?? def; } catch { } return v; };
  const update = () => {
    const v = cur(); val.textContent = format(v); val.classList.toggle('changed', Math.abs(v - def) > 1e-9);
    const t = (v - min) / (max - min), d = (def - min) / (max - min);
    knob.style.left = (t * 100) + '%'; fill.style.left = (Math.min(t, d) * 100) + '%'; fill.style.width = (Math.abs(t - d) * 100) + '%'; if (zero) zero.style.left = (d * 100) + '%';
    root.setAttribute('aria-valuenow', String(v)); root.setAttribute('aria-valuetext', format(v));
  };
  const put = (v, commitNow) => { v = clamp(Math.round(v / step) * step, min, max); setParam(path, +v.toFixed(4), commitNow); };
  // touch: nothing changes until the finger clearly moves sideways; a vertical move is left to the panel (touch-action: pan-y),
  // a single tap never changes the value (it is often just stopping a scroll). Mouse: press far from the knob jumps there.
  let drag = null, lastTap = null, lastClickT = 0, prevSide = 0;
  const side = v => Math.sign(Math.round((v - def) / step));
  const setFromClient = cx => { const r = track.getBoundingClientRect(); put(min + clamp((cx - r.left) / r.width, 0, 1) * (max - min), false); };
  const begin = e => { drag.on = true; drag.v = cur(); prevSide = side(drag.v); try { track.setPointerCapture(e.pointerId); } catch { } root.classList.add('dragging'); };
  track.addEventListener('pointerdown', e => {
    const [obj] = sliderTarget(path); if (!CUR() || !obj || drag) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: Date.now(), mouse: e.pointerType === 'mouse', on: false };
    if (!drag.mouse) return;
    e.preventDefault();
    const now = Date.now(); if (now - lastClickT < 320) { lastClickT = 0; drag = null; setParam(path, def, true); return; } lastClickT = now; // double click resets
    const r = track.getBoundingClientRect(), kx = r.left + (cur() - min) / (max - min) * r.width;
    if (Math.abs(e.clientX - kx) > 16) setFromClient(e.clientX); // far from the knob: jump there, then drag relatively
    begin(e);
  });
  track.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { drag = null; return; } // scrolling the panel
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 2) return;
      begin(e);
    }
    const r = track.getBoundingClientRect(); const fine = e.shiftKey ? 0.25 : 1; put(drag.v + dx / r.width * (max - min) * fine, false);
    const sd = side(cur()); if (sd !== prevSide && navigator.vibrate) { try { navigator.vibrate(8); } catch { } } prevSide = sd; // light tick when crossing the default (Android)
  });
  track.addEventListener('touchmove', e => { if (drag && drag.on) e.preventDefault(); }, { passive: false }); // once dragging, the panel must not start scrolling (iOS)
  const end = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.id) return; const d = drag; drag = null;
    if (d.on) { root.classList.remove('dragging'); commit(); return; }
    if (cancelled || d.mouse) return;
    // two quick taps on the same spot reset; ignored right after the panel scrolled (that tap only stops the scroll)
    const now = Date.now(); if (now - d.t0 > 300 || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 10 || now - lastScrollT < 400) { lastTap = null; return; }
    if (lastTap && now - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) < 30) { lastTap = null; setParam(path, def, true); } else lastTap = { t: now, x: e.clientX };
  };
  track.addEventListener('pointerup', e => end(e, false)); track.addEventListener('pointercancel', e => end(e, true));
  lbl.addEventListener('dblclick', () => setParam(path, def, true));
  root.addEventListener('keydown', e => {
    if (e.target !== root) return; const k = e.key, m = e.shiftKey ? 10 : 1, v = cur();
    if (k === 'ArrowRight' || k === 'ArrowUp') put(v + step * m, true); else if (k === 'ArrowLeft' || k === 'ArrowDown') put(v - step * m, true);
    else if (k === 'Home') put(min, true); else if (k === 'End') put(max, true); else if (k === 'Backspace' || k === 'Delete') setParam(path, def, true); else return;
    e.preventDefault(); e.stopPropagation();
  });
  val.addEventListener('click', () => { // type a value
    const [obj] = sliderTarget(path); if (!CUR() || !obj) return;
    const inp = el('input', { class: 'valin', type: 'text', inputmode: 'decimal', value: String(+cur().toFixed(4)) }); val.replaceWith(inp); inp.focus(); inp.select();
    let done = false; const fin = ok => { if (done) return; done = true; if (ok) { const n = parseFloat(String(inp.value).replace(/[^\d.+-]/g, '')); if (isFinite(n)) put(n, true); } inp.replaceWith(val); update(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
    inp.addEventListener('blur', () => fin(true));
  });
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
  if (path.startsWith('S.')) { const s = (im.params.spots || [])[healUI.sel]; if (!s) return; const k = path.slice(2); s[k] = v; if (k === 'size') s.r = spotRadiusIso(v) * (s.mode === 'redeye' || s.mode === 'pet' ? 1.4 : 1);
    const sl = sliders.get(path); if (sl) sl.update(); drawOverlay(); clearTimeout(healUI.st); healUI.st = setTimeout(() => refreshSpotSource(im), 120); if (doCommit) commit(); return; }
  if (path.startsWith('PC.')) { const [, i, k] = path.split('.'); const q = (im.params.pointColors || [])[+i]; if (!q) return; q[k] = v; const s = sliders.get(path); if (s) s.update(); requestRender(true); if (doCommit) commit(); return; }
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
    const sec = el('div', { class: 'sec', id: 'sec-' + t.id }); panel.append(sec);
    if (SL[t.id]) { const h = hdr(t.name, el('button', { onclick: () => resetGroup(SL[t.id].map(s => s[0])) }, '重設')); nav.sections.push({ el: h, keys: SL[t.id].map(s => s[0]) }); sec.append(h); for (const s of SL[t.id]) sec.append(makeSlider(...s)); }
    if (t.id === 'light') {
      const pr = el('div', { class: 'chips profchips' }); profileUI.chips = pr;
      for (const [k, n] of PROFILE_LIST) pr.append(el('button', { 'data-p': k, onclick: () => { const im = CUR(); if (!im) return; im.params.profile = k; refreshAll(); commit(); } }, n));
      const auto = el('button', { class: 'primary', onclick: () => autoTone() }, '自動');
      const cam = el('button', { title: '讓顏色和亮度接近相機拍出來的 JPEG', onclick: () => cameraLookButton() }, '相機色調');
      sec.insertBefore(el('div', {}, hdr('描述檔', cam, auto), pr, makeSlider('profileAmt', '描述檔強度', 0, 200, 1, v => Math.round(v) + '%')), sec.children[0]);
    }
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
      sec.append(hdr('點顏色', el('button', { id: 'pcPick', onclick: () => { const im = CUR(); if (!im) return; if ((im.params.pointColors || []).length >= 4) { toast('最多 4 個點顏色'); return; } state.pickPC = !state.pickPC; $('#pcPick').classList.toggle('on', state.pickPC); if (state.pickPC) toast('點一下照片上要調整的顏色', 3000); } }, '＋ 吸取顏色')));
      sec.append(el('div', { id: 'pcList' }));
      sec.append(hdr('HSL / 顏色', el('button', { onclick: () => resetGroup(['hsl']) }, '重設')));
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
    if (t.id === 'heal') buildHealPanel(sec);
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
  state.tab = id; updateNav(id);
  [...$('#panel').children].forEach(s => s.classList.toggle('on', s.id === 'sec-' + id));
  const wasLocal = !!selectTab.prevLocal; selectTab.prevLocal = id === 'local';
  const wasCrop = state.cropMode; state.cropMode = id === 'crop'; state.cursor = null;
  if (panelMode === 'auto') $('#side').classList.toggle('tall', id === 'curve' || id === 'hsl' || id === 'presets');
  if (id === 'curve') setTimeout(() => curveEd.draw(), 0);
  if (id === 'presets') schedulePresetThumbs();
  if (id === 'info') renderHistoryUI();
  if (wasCrop !== state.cropMode) { if (!state.cropMode) commit(); fitView(); requestRender(false); }
  else if (CUR() && wasLocal !== (id === 'local') && state.showMask && state.maskSel >= 0) requestRender(false); // red mask overlay on/off
  else drawOverlay(); // handles / crop frame only
  fitCanvas();
}
function resetGroup(keys) { const im = CUR(); if (!im) return; const st = startingParams(im); for (const k of keys) setPath(im.params, k, clone(getPath(st, k))); refreshAll(); commit(); }
function refreshBW() { const im = CUR(); const on = im && im.params.bw; const b = $('#bwToggle'); if (b) { b.classList.toggle('on', !!on); b.textContent = on ? '黑白：開（點擊關閉）' : '轉為黑白'; } $('#bwmix').style.display = on ? '' : 'none'; }
function refreshAll() { refreshNavDots(); refreshHealUI(); if (CUR()) refreshSpotSource(CUR()); refreshProfileUI(); refreshPointColorUI(); refreshLocalUI(); refreshLensUI(); for (const s of sliders.values()) s.update(); refreshBW(); if (CUR()) { curveEd.setCurves(CUR().params.curves); renderer.setCurveLUT(curveLUTFor(CUR().params)); } renderHistoryUI(); refreshCropUI(); refreshPresetUI(); requestRender(false); }

// ---------- local adjustments panel ----------
const MASK_NAMES = { linear: '線性漸層', radial: '放射狀', brush: '筆刷', sky: '天空', subject: '主體', background: '背景' };
const MASK_ICON = { linear: '▤', radial: '◎', brush: '✎', sky: '☁', subject: '◉', background: '▢' };
let localUI = {};
const activeMask = () => { const im = CUR(); return im && state.maskSel >= 0 ? im.params.masks[state.maskSel] || null : null; };
function buildLocalPanel(sec) {
  sec.append(hdr('局部調整', el('button', { onclick: () => { const im = CUR(); if (!im || !im.params.masks.length) return; if (!confirm('刪除這張照片的全部遮罩？')) return; im.params.masks = []; state.maskSel = -1; refreshAll(); commit(); } }, '全部刪除')));
  sec.append(el('div', { class: 'toolbar addmask' },
    el('button', { onclick: () => addMask('linear') }, '＋ ▤ 線性漸層'), el('button', { onclick: () => addMask('radial') }, '＋ ◎ 放射狀'), el('button', { onclick: () => addMask('brush') }, '＋ ✎ 筆刷'),
    el('button', { onclick: () => addMask('sky') }, '＋ ☁ 天空'), el('button', { onclick: () => addMask('subject') }, '＋ ◉ 主體（AI）'), el('button', { onclick: () => addMask('background') }, '＋ ▢ 背景（AI）')));
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
    ['saturation', '飽和度'], ['hue', '色相（微調）', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#ff5c8a,#888,#7cd65f)'], ['clarity', '清晰度'], ['dehaze', '去朦朧'], ['texture', '紋理'], ['sharpen', '銳利度'], ['noise', '降噪', 0, 100, 1, fmt.pos], ['colorHue', '色彩：色相', 0, 360, 1, fmt.deg, 'linear-gradient(90deg,#f66,#fc6,#cf6,#6f9,#6ff,#69f,#c6f,#f6c,#f66)'], ['colorSat', '色彩：濃度', 0, 100, 1, fmt.pos]];
  for (const [k, n, mn = -100, mx = 100, st = 1, f = fmt.int, g] of AS) ed.append(makeSlider('M.adj.' + k, n, mn, mx, st, f, g));
  ed.append(makeSlider('M.amount', '整體強度', 0, 200, 1, v => Math.round(v) + '%'));
  ed.append(hdr('範圍'));
  localUI.crRow = el('div', { class: 'crrow' },
    el('div', { class: 'toolbar' }, el('button', { id: 'crPick', onclick: () => { state.pickCR = !state.pickCR; $('#crPick').classList.toggle('on', state.pickCR); if (state.pickCR) toast('點一下照片上要選取的顏色', 3000); } }, '顏色範圍：吸取'),
      el('span', { class: 'crsw', id: 'crSwatch' }), el('button', { onclick: () => { const m = activeMask(); if (!m || !m.colorRange) return; m.colorRange.on = false; refreshLocalUI(); requestRender(false); commit(); } }, '清除顏色範圍')),
    makeSlider('M.colorRange.amt', '顏色範圍寬度', 1, 100, 1, fmt.pos));
  ed.append(localUI.crRow);
  ed.append(makeSlider('M.lumLo', '亮度範圍：下限', 0, 100, 1, fmt.pos, 'linear-gradient(90deg,#000,#fff)'), makeSlider('M.lumHi', '亮度範圍：上限', 0, 100, 1, fmt.pos, 'linear-gradient(90deg,#000,#fff)'), makeSlider('M.opacity', '遮罩強度', 0, 100, 1, fmt.pos));
}
function updateMaskChips() {
  const im = CUR(); const box = localUI.chips; if (!box) return; box.innerHTML = '';
  const ms = im ? im.params.masks : [];
  ms.forEach((m, i) => box.append(el('button', { class: (i === state.maskSel ? 'on' : '') + (m.hidden ? ' off' : ''), onclick: () => selectMask(i) }, `${MASK_ICON[m.type]} ${i + 1} ${MASK_NAMES[m.type]}${m.invert ? '（反轉）' : ''}`)));
}
function refreshLocalUI() {
  if (localUI.crRow) { const m = activeMask(); const on = !!(m && m.colorRange && m.colorRange.on); localUI.crRow.querySelector('.sl').style.display = on ? '' : 'none'; const sw = $('#crSwatch'); if (sw) { sw.style.display = on ? '' : 'none'; if (on) sw.style.background = m.colorRange.css || '#888'; } }
  if (!localUI.ed) return; const im = CUR();
  if (im && state.maskSel >= im.params.masks.length) state.maskSel = im.params.masks.length - 1;
  const m = activeMask();
  updateMaskChips();
  localUI.ed.style.display = m ? '' : 'none'; localUI.empty.style.display = m ? 'none' : '';
  if (!m) return;
  localUI.geoRadial.style.display = m.type === 'radial' ? '' : 'none'; localUI.geoLinear.style.display = m.type === 'linear' ? '' : 'none'; localUI.geoBrush.style.display = isRaster(m.type) ? '' : 'none';
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
  else { const used = new Set(ms.filter(x => isRaster(x.type)).map(x => x.ch)); const ch = [0, 1, 2, 3].find(c => !used.has(c)); if (ch === undefined) { toast('筆刷／天空／主體／背景遮罩合計最多 4 個'); return; } Object.assign(m, { ch, strokes: [] }, type === 'brush' ? {} : { base: { kind: type, ev: im.params.exposure || 0 } }); }
  ms.push(m); state.maskSel = ms.length - 1; state.showMask = true;
  refreshAll(); commit();
  if (type === 'subject' || type === 'background') upgradeSubjectMask(m);
  toast(type === 'brush' ? '在照片上塗抹要調整的區域' : type === 'sky' ? '已選取天空。可以用畫筆加入、橡皮擦減去範圍' : type === 'subject' || type === 'background' ? '先用一般演算法選取，AI 正在分析…' : '拖曳圓點調整範圍，再調整下方滑桿');
}
function dupMask() {
  const im = CUR(), m = activeMask(); if (!m) return; const ms = im.params.masks; if (ms.length >= 8) { toast('最多 8 個遮罩'); return; }
  const c = clone(m); c.id = newId();
  if (isRaster(c.type)) { const used = new Set(ms.filter(x => isRaster(x.type)).map(x => x.ch)); const ch = [0, 1, 2, 3].find(k => !used.has(k)); if (ch === undefined) { toast('最多 4 個筆刷遮罩'); return; } c.ch = ch; }
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
const ASPECTS = [['free', '自由'], ['orig', '原始'], ['1:1', '1:1'], ['3:2', '3:2'], ['4:3', '4:3'], ['16:9', '16:9'], ['16:10', '16:10'], ['4:5', '4:5'], ['5:7', '5:7'], ['1.85:1', '1.85:1 電影'], ['2.39:1', '2.39:1 寬銀幕']];
// crop guides (overlay only)
const CROP_GUIDES = [['thirds', '三分法'], ['grid', '格線'], ['golden', '黃金比例'], ['diagonal', '對角線'], ['triangle', '三角形'], ['none', '無']];
state.cropGuide = (() => { try { return localStorage.getItem('rawedit:guide') || 'thirds'; } catch { return 'thirds'; } })();
function drawCropGuides(ctx, x0, y0, x1, y1, dpr) {
  const w = x1 - x0, h = y1 - y0, k = state.cropGuide, L = (ax, ay, bx, by) => { ctx.moveTo(x0 + ax * w, y0 + ay * h); ctx.lineTo(x0 + bx * w, y0 + by * h); };
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1 * dpr; ctx.beginPath();
  if (k === 'thirds') for (let i = 1; i < 3; i++) { L(i / 3, 0, i / 3, 1); L(0, i / 3, 1, i / 3); }
  else if (k === 'grid') for (let i = 1; i < 8; i++) { L(i / 8, 0, i / 8, 1); L(0, i / 8, 1, i / 8); }
  else if (k === 'golden') for (const t of [0.382, 0.618]) { L(t, 0, t, 1); L(0, t, 1, t); }
  else if (k === 'diagonal') { L(0, 0, 1, 1); L(1, 0, 0, 1); const m = Math.min(w, h) / Math.max(w, h); if (w > h) { L(0, 0, m, 1); L(1, 0, 1 - m, 1); L(0, 1, m, 0); L(1, 1, 1 - m, 0); } else { L(0, 0, 1, m); L(0, 1, 1, 1 - m); } }
  else if (k === 'triangle') { L(0, 1, 1, 0); const t = h * h / (w * w + h * h); L(0, 0, t, 1 - t); L(1, 1, 1 - t, t); }
  ctx.stroke();
}
let cropUI = {};
function buildCropPanel(sec) {
  sec.append(hdr('裁切與旋轉', el('button', { onclick: () => { const im = CUR(); if (!im) return; im.params.geo = clone(DEFAULTS.geo); refreshAll(); fitView(); commit(); } }, '重設')));
  const tools = el('div', { class: 'croptools' },
    el('button', { onclick: () => rot(-1) }, '↺ 逆時針 90°'), el('button', { onclick: () => rot(1) }, '↻ 順時針 90°'),
    el('button', { id: 'flipH', onclick: () => { CUR().params.geo.flipH = !CUR().params.geo.flipH; refreshAll(); commit(); } }, '⇋ 水平翻轉'),
    el('button', { id: 'flipV', onclick: () => { CUR().params.geo.flipV = !CUR().params.geo.flipV; refreshAll(); commit(); } }, '⇅ 垂直翻轉'));
  sec.append(tools);
  sec.append(makeSlider('geo.angle', '拉直角度', -45, 45, 0.1, v => v.toFixed(1) + '°'));
  sec.append(el('div', { class: 'toolbar' }, el('button', { onclick: () => autoStraighten() }, '自動拉直')));
  sec.append(hdr('變形（透視校正）', el('button', { onclick: () => { const g = CUR().params.geo; g.tr = clone(DEFAULTS.geo.tr); g.upright = null; g.uprightMode = 'off'; refreshAll(); fitView(); commit(); } }, '重設')));
  const up = el('div', { class: 'chips' }); cropUI.upright = up;
  for (const [k, n] of [['off', '關閉'], ['auto', '自動'], ['level', '水平'], ['vertical', '垂直'], ['full', '完整']]) up.append(el('button', { 'data-u': k, onclick: () => computeUpright(k) }, n));
  sec.append(el('div', { class: 'hint' }, 'Upright：自動找出照片裡的直線，把建築拉正。'), up);
  for (const [k, n, mn, mx, st, f] of [['v', '垂直', -100, 100, 1, fmt.int], ['h', '水平', -100, 100, 1, fmt.int], ['rot', '旋轉', -10, 10, 0.1, v => v.toFixed(1) + '°'], ['asp', '長寬比', -100, 100, 1, fmt.int], ['scale', '縮放', 50, 150, 1, fmt.pos], ['ox', 'X 位移', -100, 100, 1, fmt.int], ['oy', 'Y 位移', -100, 100, 1, fmt.int]]) sec.append(makeSlider('geo.tr.' + k, n, mn, mx, st, f));
  cropUI.constrain = el('button', { onclick: () => { const g = CUR().params.geo; g.constrain = g.constrain === false; refreshAll(); fitView(); commit(); } }, '限制裁切');
  sec.append(el('div', { class: 'toolbar' }, cropUI.constrain), el('div', { class: 'hint' }, '「限制裁切」開著時會自動放大，避免變形後露出空白邊。'));
  sec.append(hdr('長寬比'));
  const chips = el('div', { class: 'chips' }); cropUI.chips = chips;
  for (const [k, n] of ASPECTS) chips.append(el('button', { 'data-a': k, onclick: () => setAspect(k) }, n));
  chips.append(el('button', { onclick: () => { const g = CUR().params.geo; g.aspectSwap = !g.aspectSwap; setAspect(g.aspect); } }, '⟲ 直/橫'));
  sec.append(chips, el('div', { class: 'hint' }, '在畫面上拖曳邊框或角落調整裁切範圍，拖曳中間可移動。'));
  sec.append(hdr('參考線')); const gch = el('div', { class: 'chips' });
  const syncG = () => [...gch.children].forEach(b => b.classList.toggle('on', b.dataset.g === state.cropGuide));
  for (const [k, n] of CROP_GUIDES) gch.append(el('button', { 'data-g': k, onclick: () => { state.cropGuide = k; try { localStorage.setItem('rawedit:guide', k); } catch { } syncG(); drawOverlay(); } }, n));
  sec.append(gch); syncG();
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
function refreshCropUI() {
  if (cropUI.upright) { const g = CUR() ? CUR().params.geo : DEFAULTS.geo; [...cropUI.upright.children].forEach(b => b.classList.toggle('on', b.dataset.u === (g.uprightMode || 'off'))); cropUI.constrain.classList.toggle('on', g.constrain !== false); } const im = CUR(); if (!im || !cropUI.chips) return; const g = im.params.geo; [...cropUI.chips.children].forEach(b => b.classList.toggle('on', b.dataset.a === g.aspect)); $('#flipH').classList.toggle('on', g.flipH); $('#flipV').classList.toggle('on', g.flipV); }

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
// Auto white balance (LightCraft's weighting, MIT): average the as-shot linear colour, weighted towards low-chroma mid tones
// around 2^-2.5 of white; the white balance that makes that average neutral is the answer.
function autoWB() {
  const im = CUR(), pd = state.previewData; if (!im || !pd || pd.imId !== im.id) return;
  const d = pd.data, n = pd.w * pd.h, step = Math.max(1, Math.floor(n / 250000)); let R = 0, G = 0, B = 0, W = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 3, r = d[i] / 65535, g = d[i + 1] / 65535, b = d[i + 2] / 65535, y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (y < 0.01 || y > 2) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = (mx - mn) / (mx + 1e-6);
    const w = (1 - ch) ** 2 * (1 - Math.min(Math.abs((Math.log2(y) + 2.5) / 4), 1)); if (w <= 0) continue;
    R += r * w; G += g * w; B += b * w; W += w;
  }
  if (W <= 0) { toast('這張照片沒有足夠的中性區域可以自動判斷'); return; }
  const [t, ti, out] = wbFromRGB(R / W, G / W, B / W); applyWB(t, ti, out);
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

// ---------- colour pickers: point colour and mask colour range ----------
function linToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const srgbToLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
// colour as displayed (after all adjustments): read back the rendered result around the tapped point
function displayedColorAt(sx, sy) {
  const R = renderer.result, G = currentGeometry(); if (!R) return null;
  const f = screenToFrame(sx, sy); const x = Math.round(f[0] * R.w / G.outW), y = Math.round(f[1] * R.h / G.outH);
  if (x < 2 || y < 2 || x > R.w - 3 || y > R.h - 3) return null;
  const gl = renderer.gl, px = new Uint8Array(5 * 5 * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.fb); gl.readPixels(x - 2, y - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let r = 0, g = 0, b = 0; for (let i = 0; i < 100; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  return [r / 25, g / 25, b / 25];
}
function pickColorAt(e) {
  const im = CUR(); if (!im) return; const [sx, sy] = canvasPt(e);
  if (state.pickPC) {
    const c = displayedColorAt(sx, sy); if (!c) { toast('請點在照片上'); return; }
    const lab = linToOklab(srgbToLin(c[0]), srgbToLin(c[1]), srgbToLin(c[2]));
    im.params.pointColors = (im.params.pointColors || []).concat([{ L: lab[0], a: lab[1], b: lab[2], css: `rgb(${c.map(Math.round).join(',')})`, hue: 0, sat: 0, lum: 0, range: 40 }]);
    state.pickPC = false; const b = $('#pcPick'); if (b) b.classList.remove('on');
    refreshAll(); commit(); toast('已加入點顏色，拉下面的滑桿調整');
  } else if (state.pickCR) {
    const m = activeMask(); if (!m) { state.pickCR = false; return; }
    const iso = canvasToIso(sx, sy), Lm = Math.max(im.fullW, im.fullH); const s = previewSample(iso[0] * Lm, iso[1] * Lm, 3);
    if (!s || !s.R) { toast('請點在照片上'); return; }
    const U = baseUniforms(im.params), k = U.exposure / 65535; const lin = [s.R * k * U.wb[0], s.G * k * U.wb[1], s.B * k * U.wb[2]];
    const lab = linToOklab(...lin); const d = displayedColorAt(sx, sy);
    m.colorRange = Object.assign({ amt: 40 }, m.colorRange || {}, { on: true, L: lab[0], a: lab[1], b: lab[2], css: d ? `rgb(${d.map(Math.round).join(',')})` : '#888' });
    state.pickCR = false; const b = $('#crPick'); if (b) b.classList.remove('on');
    refreshLocalUI(); requestRender(false); commit(); toast('遮罩只會影響相近的顏色；用「顏色範圍寬度」調整');
  }
}
function refreshPointColorUI() {
  const box = $('#pcList'); if (!box) return; const im = CUR(); const list = im ? (im.params.pointColors || []) : [];
  for (const k of [...sliders.keys()]) if (k.startsWith('PC.')) sliders.delete(k);
  box.innerHTML = '';
  if (!list.length) { box.append(el('div', { class: 'hint' }, '用「＋ 吸取顏色」點照片上的某個顏色（例如膚色、天空、衣服），再單獨調整它的色相、飽和度和明度。')); return; }
  list.forEach((q, i) => {
    const del = el('button', { onclick: () => { im.params.pointColors = list.filter((_, j) => j !== i); refreshAll(); commit(); } }, '刪除');
    box.append(el('div', { class: 'pcitem' }, hdr('', del),
      makeSlider(`PC.${i}.hue`, '色相', -100, 100, 1, fmt.int, 'linear-gradient(90deg,#ff5c8a,#888,#7cd65f)'), makeSlider(`PC.${i}.sat`, '飽和度', -100, 100, 1, fmt.int),
      makeSlider(`PC.${i}.lum`, '明度', -100, 100, 1, fmt.int), makeSlider(`PC.${i}.range`, '範圍', 1, 100, 1, fmt.pos)));
    const h = box.lastChild.querySelector('.hdr span'); h.append(el('span', { class: 'pcsw', style: `background:${q.css || '#888'}` }), ' 點顏色 ' + (i + 1));
  });
  for (const k of sliders.keys()) if (k.startsWith('PC.')) sliders.get(k).update();
}

// ---------- spot removal (heal / clone), red eye, dust detection ----------
// Algorithms adapted from LightCraft (https://github.com/storytold/lightcraft), Copyright (c) 2026 ArtCraft Team and the
// LightCraft contributors, MIT License. Spots are applied on the CPU to a copy of the decoded source (scene-linear, before
// the shader), so the preview, histogram, thumbnails and the export all see them. Geometry is stored in "iso" units like masks.
// spot: { mode: 'heal'|'clone'|'redeye'|'pet', x, y, r, ox, oy, feather, opacity }  (r, offsets: fraction of the long edge)
const spotRadiusIso = s => 0.003 + Math.pow(s / 100, 1.5) * 0.08;
const healUI = { sel: -1 };
function healGeom(im) { // iso -> source px mapping helpers for the current source buffer
  const Lm = Math.max(im.fullW, im.fullH); const L = lensFor(im, im.params.lens || DEFAULTS.lens);
  const toSrcFull = (ix, iy) => L.on ? lensSourcePts(L.table, ix * Lm, iy * Lm, im.fullW, im.fullH)[0] : [ix * Lm, iy * Lm];
  return { Lm, toSrcFull };
}
function bilinear3(d, w, h, x, y, out) {
  x = Math.min(w - 1.001, Math.max(0, x - 0.5)); y = Math.min(h - 1.001, Math.max(0, y - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i00 = (y0 * w + x0) * 3, i10 = i00 + 3, i01 = i00 + w * 3, i11 = i01 + 3;
  for (let c = 0; c < 3; c++) out[c] = (d[i00 + c] * (1 - fx) + d[i10 + c] * fx) * (1 - fy) + (d[i01 + c] * (1 - fx) + d[i11 + c] * fx) * fy;
  return out;
}
function boxBlurInPlace(a, w, h, r) { // separable box blur with clamped edges (3 passes ~ Gaussian)
  if (r < 1) return; const t = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) { let s = 0; const o = y * w; for (let k = -r; k <= r; k++) s += a[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) { t[x] = s / (2 * r + 1); s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; } for (let x = 0; x < w; x++) a[o + x] = t[x]; }
  for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += a[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) { t[y] = s / (2 * r + 1); s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x]; } for (let y = 0; y < h; y++) a[y * w + x] = t[y]; }
}
const gauss3 = (a, w, h, sigma) => { const r = Math.max(1, Math.round(Math.sqrt(12 * sigma * sigma / 3 + 1) / 2)); for (let i = 0; i < 3; i++) boxBlurInPlace(a, w, h, r); };
// Heal / clone one circular spot in place. cx, cy, r, ox, oy in source px.
function healSpot(d, w, h, cx, cy, r, ox, oy, feather, opacity, heal) {
  const pad = r, x0 = Math.max(0, Math.floor(cx - r - pad)), y0 = Math.max(0, Math.floor(cy - r - pad)), x1 = Math.min(w, Math.ceil(cx + r + pad)), y1 = Math.min(h, Math.ceil(cy + r + pad));
  const bw = x1 - x0, bh = y1 - y0; if (bw < 2 || bh < 2) return;
  const n = bw * bh, alpha = new Float32Array(n), src = new Float32Array(n * 3), inner = r * (1 - feather / 100 * 0.8), tmp = [0, 0, 0];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const px = x0 + x + 0.5, py = y0 + y + 0.5, dd = Math.hypot(px - cx, py - cy), i = y * bw + x;
    const t = Math.min(1, Math.max(0, (dd - inner) / Math.max(r - inner, 1e-6))); alpha[i] = (1 - t * t * (3 - 2 * t)) * opacity / 100;
    bilinear3(d, w, h, px + ox, py + oy, tmp); src[i * 3] = tmp[0]; src[i * 3 + 1] = tmp[1]; src[i * 3 + 2] = tmp[2];
  }
  let low = null;
  if (heal) { // tone from the surroundings only: normalised convolution of (target - source) outside the spot
    const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = alpha[i] < 0.02 ? 1 : 0;
    const g = new Float32Array(out); const sig = Math.max(0.6 * r, 1); gauss3(g, bw, bh, sig); low = [];
    for (let c = 0; c < 3; c++) {
      const diff = new Float32Array(n); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = y * bw + x; diff[i] = (d[((y0 + y) * w + x0 + x) * 3 + c] - src[i * 3 + c]) * out[i]; }
      gauss3(diff, bw, bh, sig); for (let i = 0; i < n; i++) diff[i] /= Math.max(g[i], 1e-4); low.push(diff);
    }
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x, a = alpha[i]; if (a <= 0) continue; const o = ((y0 + y) * w + x0 + x) * 3;
    for (let c = 0; c < 3; c++) { const tg = d[o + c], v = src[i * 3 + c] + (low ? low[c][i] : 0); d[o + c] = Math.max(0, Math.min(65535, Math.round(tg + (v - tg) * a))); }
  }
}
// Automatic source: compare the ring around the spot with rings around 48 candidates (3 distances x 16 angles).
function autoSpotSource(d, w, h, cx, cy, r) {
  const ring = (x, y, r0, r1) => { const o = []; const t = [0, 0, 0];
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; for (const rr of [r0, (r0 + r1) / 2, r1]) { const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; if (px < 0 || py < 0 || px >= w || py >= h) return null; bilinear3(d, w, h, px, py, t); o.push(t[0] / 65535, t[1] / 65535, t[2] / 65535); } }
    return o; };
  const A = ring(cx, cy, 1.05 * r, 1.6 * r); let best = null, bs = Infinity;
  for (const k of [2.4, 3.2, 4.2]) for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, ox = Math.cos(a) * k * r, oy = Math.sin(a) * k * r; if (!A) break;
    const B = ring(cx + ox, cy + oy, 1.05 * r, 1.6 * r); if (!B) continue;
    let S = 0; for (let j = 0; j < A.length; j++) { const q = Math.sqrt(Math.max(A[j], 0)) - Math.sqrt(Math.max(B[j], 0)); S += q * q; }
    const I = ring(cx + ox, cy + oy, 0.2 * r, 0.9 * r);
    if (I) { let mA = 0, cnt = 0; for (let j = 1; j < A.length; j += 3) { mA += Math.sqrt(A[j]); cnt++; } mA /= cnt; let v = 0, ci = 0; for (let j = 1; j < I.length; j += 3) { const q = Math.sqrt(I[j]) - mA; v += q * q; ci++; } S += v / ci * A.length * 0.5; }
    if (S < bs) { bs = S; best = [ox, oy]; }
  }
  return best || [2.5 * r, 0];
}
// Red eye / pet eye inside an ellipse (cx, cy, rx, ry in source px): detect the pupil, then neutralise it.
function fixEye(d, w, h, cx, cy, rx, ry, pet, darken, pupil) {
  let tot = 0, sx = 0, sy = 0, ns = 0, ymax = 0, ysum = 0; const S = [];
  for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) {
    const dx = (i + 0.5) / 40 * 2 - 1, dy = (j + 0.5) / 40 * 2 - 1; if (dx * dx + dy * dy > 1) continue;
    const px = Math.round(cx + dx * rx), py = Math.round(cy + dy * ry); if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const o = (py * w + px) * 3, R = d[o] / 65535, G = d[o + 1] / 65535, B = d[o + 2] / 65535, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B; ns++;
    S.push([px, py, R, G, B, Y]); ymax = Math.max(ymax, Y); ysum += Y;
  }
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (const [px, py, R, G, B, Y] of S) {
    let wgt = 0;
    if (pet) { if (ymax > 1e-6 && ymax >= 1.5 * ysum / Math.max(ns, 1)) wgt = sm(0.5, 0.8, Y / ymax); }
    else wgt = R > 1e-3 ? sm(0.22, 0.42, (R - Math.max(G, B)) / (R + G + B + 1e-6)) : 0;
    tot += wgt; sx += wgt * px; sy += wgt * py;
  }
  let pc = [cx, cy], pr = 0.5 * Math.min(rx, ry);
  if (tot >= 3) { pc = [sx / tot, sy / tot]; pr = Math.sqrt(tot / ns * rx * ry); }
  pr = Math.max(0.5, Math.min(pr * (0.5 + pupil / 100), Math.max(rx, ry) * 1.1));
  const k = darken / 100, x0 = Math.max(0, Math.floor(pc[0] - pr * 1.4)), x1 = Math.min(w, Math.ceil(pc[0] + pr * 1.4)), y0 = Math.max(0, Math.floor(pc[1] - pr * 1.4)), y1 = Math.min(h, Math.ceil(pc[1] + pr * 1.4));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const dd = Math.hypot(x + 0.5 - pc[0], y + 0.5 - pc[1]) / pr, o = (y * w + x) * 3; let R = d[o], G = d[o + 1], B = d[o + 2];
    if (pet) { const m = 1 - sm(0.95, 1.2, dd); const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B; const t = Math.min(Y, 0.04 * 65535) * (1 - 0.85 * k); R += (t - R) * m; G += (t - G) * m; B += (t - B) * m; }
    else { const m = 1 - sm(1.0, 1.35, dd); const red = (R - Math.max(G, B)) / Math.max(R, 1); const a = m * sm(0.25, 0.5, red); const nv = 0.5 * (G + B) * (1 - 0.9 * k); R += (nv - R) * a; G += (nv - G) * a; B += (nv - B) * a; }
    d[o] = Math.max(0, Math.round(R)); d[o + 1] = Math.max(0, Math.round(G)); d[o + 2] = Math.max(0, Math.round(B));
  }
}
// Apply every spot, in order, to a source buffer (w x h, full px = source px * scale).
function applySpotsToBuffer(d, w, h, scale, spots, im) {
  const { Lm, toSrcFull } = healGeom(im);
  for (const sp of spots) {
    const c = toSrcFull(sp.x, sp.y), cx = c[0] / scale, cy = c[1] / scale, r = Math.max(1, sp.r * Lm / scale);
    if (sp.mode === 'redeye' || sp.mode === 'pet') { fixEye(d, w, h, cx, cy, r, r * 0.8, sp.mode === 'pet', sp.darken ?? 50, sp.pupil ?? 50); continue; }
    const s = toSrcFull(sp.x + sp.ox, sp.y + sp.oy);
    healSpot(d, w, h, cx, cy, r, s[0] / scale - cx, s[1] / scale - cy, sp.feather ?? 50, sp.opacity ?? 100, sp.mode !== 'clone');
  }
}
// Re-apply spots to the preview source when they changed (keeps the decoded original untouched in state.previewData).
function refreshSpotSource(im, force) {
  const pd = state.previewData; if (!im || !pd || pd.imId !== im.id) return;
  const spots = im.params.spots || [], sig = JSON.stringify(spots);
  if (!force && sig === healUI.sig && healUI.imId === im.id) return;
  healUI.sig = sig; healUI.imId = im.id;
  let data = pd.data; if (spots.length) { data = new Uint16Array(pd.data); applySpotsToBuffer(data, pd.w, pd.h, pd.scale, spots, im); }
  if (!renderer.updateSourceData(data, pd.w, pd.h)) renderer.setSource(data, pd.w, pd.h, pd.scale, im.fullW, im.fullH);
  requestRender(false);
}
function addSpotAt(ix, iy) {
  const im = CUR(), pd = state.previewData; if (!im || !pd) return;
  const mode = state.tool.healMode || 'heal'; const r = spotRadiusIso(state.tool.spotSize ?? 25);
  const sp = { mode, x: ix, y: iy, r, ox: 0, oy: 0, feather: state.tool.spotFeather ?? 50, opacity: 100, size: state.tool.spotSize ?? 25 };
  if (mode === 'redeye' || mode === 'pet') { sp.r = r * 1.4; sp.darken = 50; sp.pupil = 50; }
  else { // pick the source once on the preview and store it, so preview and export agree
    const { Lm, toSrcFull } = healGeom(im); const c = toSrcFull(ix, iy);
    const o = autoSpotSource(pd.data, pd.w, pd.h, c[0] / pd.scale, c[1] / pd.scale, Math.max(1, r * Lm / pd.scale));
    sp.ox = o[0] * pd.scale / Lm; sp.oy = o[1] * pd.scale / Lm;
  }
  im.params.spots = (im.params.spots || []).concat([sp]); healUI.sel = im.params.spots.length - 1;
  refreshSpotSource(im); refreshHealUI(); commit(); drawOverlay();
}
// Dust detection on the rendered image (useful for film scans): small dark blobs on smooth surroundings become heal spots.
function detectDust(sens = 50) {
  const im = CUR(); if (!im || !renderer.src) return;
  const HU = uniformsFromParams(im.params, im); HU.showMask = -1; HU.clipWarn = 0;
  const G = geometry(im.params.geo, im.fullW, im.fullH, true); const { px, w, h } = renderer.readSmall(HU, G, 1600, 'dust');
  const n = w * h, l = new Float32Array(n); for (let i = 0; i < n; i++) l[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  const long = Math.max(w, h), around = new Float32Array(l); gauss3(around, w, h, Math.max(0.012 * long, 2));
  const tex = new Float32Array(n); for (let i = 0; i < n; i++) tex[i] = Math.abs(l[i] - around[i]); gauss3(tex, w, h, Math.max(0.02 * long, 3));
  const minDark = 0.03 - 0.022 * sens / 100, cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const dk = Math.max(around[i] - l[i], 0); cand[i] = dk > minDark && dk > 3 * tex[i] && l[i] > 0.08 ? 1 : 0; }
  const seen = new Uint8Array(n), found = [], maxN = Math.pow(0.02 * long, 2) * 4;
  for (let s = 0; s < n; s++) {
    if (!cand[s] || seen[s]) continue; const st = [s]; seen[s] = 1; let cnt = 0, mx = 0, my = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, peak = 0, big = false;
    while (st.length) { const p = st.pop(), x = p % w, y = (p - x) / w; cnt++; mx += x; my += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); peak = Math.max(peak, around[p] - l[p]);
      if (cnt > maxN) { big = true; } for (const q of [p - 1, p + 1, p - w, p + w]) { if (q < 0 || q >= n || seen[q] || !cand[q]) continue; if (Math.abs((q % w) - x) > 1) continue; seen[q] = 1; if (!big) st.push(q); } }
    if (big) continue; const bw = x1 - x0 + 1, bh = y1 - y0 + 1, r = Math.max(bw, bh) / 2;
    if (r < 0.0015 * long || r > 0.02 * long || Math.max(bw, bh) / Math.min(bw, bh) > 1.8 || cnt < 0.45 * bw * bh) continue;
    // the surroundings must be smooth: a ring at 1.6r..3r around the blob may vary much less than the blob is dark (rejects twigs, texture)
    { const cx0 = mx / cnt, cy0 = my / cnt; let m = 0, m2 = 0, k = 0;
      for (let a = 0; a < 32; a++) for (const rr of [1.6 * r + 1, 2.3 * r + 1.5, 3 * r + 2]) { const x = Math.round(cx0 + Math.cos(a / 32 * 6.2832) * rr), y = Math.round(cy0 + Math.sin(a / 32 * 6.2832) * rr); if (x < 0 || y < 0 || x >= w || y >= h) continue; const v = l[y * w + x]; m += v; m2 += v * v; k++; }
      if (k < 40) continue; m /= k; const sd = Math.sqrt(Math.max(0, m2 / k - m * m)); if (sd > peak * 0.2) continue;
      // a line (twig, wire, edge) crossing the blob shows up as dark samples on the ring; real dust is an isolated speck
      let hits = 0; for (let a = 0; a < 32; a++) for (const rr of [2.3 * r + 1.5, 3 * r + 2]) { const x = Math.round(cx0 + Math.cos(a / 32 * 6.2832) * rr), y = Math.round(cy0 + Math.sin(a / 32 * 6.2832) * rr); if (x >= 0 && y >= 0 && x < w && y < h && l[y * w + x] < m - 0.5 * peak) hits++; }
      if (hits >= 2) continue; }
    found.push({ fx: (mx / cnt + 0.5) / w, fy: (my / cnt + 0.5) / h, r: r / long * 1.6, s: peak });
  }
  found.sort((a, b) => b.s - a.s); const top = found.slice(0, 60);
  if (!top.length) { toast('沒有找到明顯的灰塵'); return 0; }
  const Lm = Math.max(im.fullW, im.fullH), pd = state.previewData, { toSrcFull } = healGeom(im); const add = [];
  for (const f of top) { // detected on the uncropped output frame -> iso
    const p = mapPt(G.m, f.fx * G.outW, f.fy * G.outH), ix = p[0] / Lm, iy = p[1] / Lm, r = f.r * Math.max(G.outW, G.outH) / Lm;
    const c = toSrcFull(ix, iy), o = autoSpotSource(pd.data, pd.w, pd.h, c[0] / pd.scale, c[1] / pd.scale, Math.max(1, r * Lm / pd.scale));
    add.push({ mode: 'heal', x: ix, y: iy, r, ox: o[0] * pd.scale / Lm, oy: o[1] * pd.scale / Lm, feather: 50, opacity: 100, dust: 1 });
  }
  im.params.spots = (im.params.spots || []).concat(add); refreshSpotSource(im); refreshHealUI(); commit(); drawOverlay();
  toast(`找到並修掉 ${add.length} 個灰塵點，可以點選個別的點調整或刪除`); return add.length;
}
function healHit(sx, sy) {
  const im = CUR(); if (!im) return null; const sp = im.params.spots || []; const R = 14 * dprNow();
  for (let i = sp.length - 1; i >= 0; i--) {
    const s = sp[i], c = isoToCanvas(s.x, s.y), e = isoToCanvas(s.x + s.r, s.y), rr = Math.max(R, Math.hypot(e[0] - c[0], e[1] - c[1]));
    if (s.mode === 'heal' || s.mode === 'clone') { const q = isoToCanvas(s.x + s.ox, s.y + s.oy); if (Math.hypot(sx - q[0], sy - q[1]) < rr) return { i, part: 'src' }; }
    if (Math.hypot(sx - c[0], sy - c[1]) < rr) return { i, part: 'dst' };
  }
  return null;
}
function drawHealOverlay(ctx) {
  const im = CUR(); const sp = im.params.spots || []; const dpr = dprNow();
  sp.forEach((s, i) => {
    const c = isoToCanvas(s.x, s.y), e = isoToCanvas(s.x + s.r, s.y), rr = Math.hypot(e[0] - c[0], e[1] - c[1]); const on = i === healUI.sel;
    ctx.lineWidth = (on ? 2 : 1.2) * dpr; ctx.strokeStyle = on ? '#fff' : 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(c[0], c[1], rr, 0, Math.PI * 2); ctx.stroke();
    if (s.mode === 'heal' || s.mode === 'clone') {
      const q = isoToCanvas(s.x + s.ox, s.y + s.oy); ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.strokeStyle = on ? '#7fb6ff' : 'rgba(127,182,255,0.6)';
      ctx.beginPath(); ctx.arc(q[0], q[1], rr, 0, Math.PI * 2); ctx.stroke();
      const dx = q[0] - c[0], dy = q[1] - c[1], dl = Math.hypot(dx, dy) || 1; ctx.beginPath(); ctx.moveTo(c[0] + dx / dl * rr, c[1] + dy / dl * rr); ctx.lineTo(q[0] - dx / dl * rr, q[1] - dy / dl * rr); ctx.stroke(); ctx.setLineDash([]);
    } else { ctx.strokeStyle = on ? '#ff6b6b' : 'rgba(255,107,107,0.7)'; ctx.beginPath(); ctx.arc(c[0], c[1], rr * 0.5, 0, Math.PI * 2); ctx.stroke(); }
  });
}
const HEAL_MODES = [['heal', '修復'], ['clone', '仿製'], ['redeye', '紅眼'], ['pet', '寵物眼']];
function buildHealPanel(sec) {
  sec.append(hdr('污點修復', el('button', { onclick: () => { const im = CUR(); if (!im || !(im.params.spots || []).length) return; if (!confirm('清除這張照片的全部修復點？')) return; im.params.spots = []; healUI.sel = -1; refreshSpotSource(im); refreshHealUI(); commit(); drawOverlay(); } }, '全部清除')));
  const seg = el('div', { class: 'seg' }); healUI.seg = seg;
  for (const [k, n] of HEAL_MODES) seg.append(el('button', { 'data-m': k, onclick: () => { state.tool.healMode = k; refreshHealUI(); } }, n));
  sec.append(el('div', { class: 'row', style: 'margin:6px 0' }, seg));
  sec.append(makeSlider('T.spotSize', '新增點的大小', 1, 100, 1, fmt.pos), makeSlider('T.spotFeather', '新增點的羽化', 0, 100, 1, fmt.pos));
  sec.append(el('div', { class: 'hint' }, IS_TOUCH ? '點一下照片放修復點，來源會自動挑選；拖曳白圈移動位置，拖曳藍色虛線圈換來源。雙指可縮放。' : '點一下照片放修復點，來源會自動挑選；拖曳白圈移動位置，拖曳藍色虛線圈換來源。滾輪縮放。'));
  healUI.edit = el('div', {}); sec.append(healUI.edit);
  sec.append(hdr('灰塵（底片掃描）'), el('div', { class: 'toolbar' }, el('button', { onclick: () => detectDust(state.tool.dustSens ?? 30) }, '自動偵測灰塵')), makeSlider('T.dustSens', '偵測靈敏度', 0, 100, 1, fmt.pos));
  refreshHealUI();
}
function refreshHealUI() {
  if (!healUI.seg) return; const im = CUR(); const mode = state.tool.healMode || 'heal';
  [...healUI.seg.children].forEach(b => b.classList.toggle('on', b.dataset.m === mode));
  for (const k of [...sliders.keys()]) if (k.startsWith('S.')) sliders.delete(k);
  healUI.edit.innerHTML = ''; const sp = im ? (im.params.spots || []) : [];
  if (healUI.sel >= sp.length) healUI.sel = -1;
  if (!sp.length) return; healUI.edit.append(el('div', { class: 'hint' }, `共 ${sp.length} 個修復點${healUI.sel >= 0 ? '，正在編輯第 ' + (healUI.sel + 1) + ' 個' : '，點一下圓圈可以編輯'}`));
  if (healUI.sel < 0) return; const s = sp[healUI.sel];
  healUI.edit.append(hdr('選取的點', el('button', { class: 'danger', onclick: () => { im.params.spots = sp.filter((_, j) => j !== healUI.sel); healUI.sel = -1; refreshSpotSource(im); refreshHealUI(); commit(); drawOverlay(); } }, '刪除')));
  healUI.edit.append(makeSlider('S.size', '大小', 1, 100, 1, fmt.pos));
  if (s.mode === 'heal' || s.mode === 'clone') healUI.edit.append(makeSlider('S.feather', '羽化', 0, 100, 1, fmt.pos), makeSlider('S.opacity', '不透明度', 0, 100, 1, fmt.pos));
  else healUI.edit.append(makeSlider('S.pupil', '瞳孔大小', 0, 100, 1, fmt.pos), makeSlider('S.darken', '變暗', 0, 100, 1, fmt.pos));
  for (const k of sliders.keys()) if (k.startsWith('S.')) sliders.get(k).update();
}

// ---------- perspective transform, Upright, auto straighten ----------
// Adapted from LightCraft (https://github.com/storytold/lightcraft), Copyright (c) 2026 ArtCraft Team and the LightCraft
// contributors, MIT License. Homographies act on centred coordinates q = (p - centre) / (long edge / 2) of the oriented,
// lens-corrected image and map lens-corrected -> transformed (rendering samples with the inverse). Row-major 3x3 arrays.
const H3 = {
  I: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul: (A, B) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return o; },
  inv: A => { const [a, b, c, d, e, f, g, h, i] = A; const C = [e * i - f * h, -(b * i - c * h), b * f - c * e, -(d * i - f * g), a * i - c * g, -(a * f - c * d), d * h - e * g, -(a * h - b * g), a * e - b * d]; const det = a * C[0] + b * C[3] + c * C[6]; return C.map(v => v / det); },
  ap: (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; },
  isI: H => !H || H.every((v, i) => Math.abs(v - H3.I[i]) < 1e-9),
};
const diag3 = (a, b, c) => [a, 0, 0, 0, b, 0, 0, 0, c];
function recentreH(H) { // keep the centre fixed and preserve local area there
  const o = H3.ap(H, 0, 0); const T = H3.mul([1, 0, -o[0], 0, 1, -o[1], 0, 0, 1], H);
  const e = 1e-4, p0 = H3.ap(T, 0, 0), px = H3.ap(T, e, 0), py = H3.ap(T, 0, e);
  const J = [(px[0] - p0[0]) / e, (py[0] - p0[0]) / e, (px[1] - p0[1]) / e, (py[1] - p0[1]) / e];
  const s = 1 / Math.sqrt(Math.abs(J[0] * J[3] - J[1] * J[2])); return H3.mul(diag3(s, s, 1), T);
}
const rotHom = (R, f) => H3.mul(H3.mul(diag3(f, f, 1), R), diag3(1 / f, 1 / f, 1));
const rotX3 = a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotY3 = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const TR_F = 1.5, TR_KMAX = 0.5;
function manualH(tr) {
  if (!tr) return H3.I; let H = H3.I; const v = tr.v || 0, h = tr.h || 0;
  if (v || h) H = recentreH(rotHom(H3.mul(rotY3(h / 100 * TR_KMAX), rotX3(-v / 100 * TR_KMAX)), TR_F));
  if (tr.rot) { const a = tr.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); H = H3.mul([c, -s, 0, s, c, 0, 0, 0, 1], H); }
  if (tr.asp) { const k = Math.pow(2, tr.asp / 200); H = H3.mul(diag3(1 / k, k, 1), H); }
  const sc = Math.max(0.1, Math.min(10, (tr.scale ?? 100) / 100)); if (sc !== 1) H = H3.mul(diag3(sc, sc, 1), H);
  if (tr.ox || tr.oy) H = H3.mul([1, 0, (tr.ox || 0) / 100 * 0.5, 0, 1, -(tr.oy || 0) / 100 * 0.5, 0, 0, 1], H);
  return H;
}
// Pixel-space homography (column-major, for mmul): transformed oriented px -> lens-corrected oriented px; null if identity.
function perspPx(geo, Wr, Hr) {
  const Ht = H3.mul(manualH(geo.tr), geo.upright || H3.I); if (H3.isI(Ht)) return null;
  const L = Math.max(Wr, Hr) / 2, cx = Wr / 2, cy = Hr / 2;
  const P = H3.mul(H3.mul([L, 0, cx, 0, L, cy, 0, 0, 1], H3.inv(Ht)), [1 / L, 0, -cx / L, 0, 1 / L, -cy / L, 0, 0, 1]);
  return [P[0], P[3], P[6], P[1], P[4], P[7], P[2], P[5], P[8]];
}

// --- analysis image + line segments (CPU, ~1024 px) ---
function uprightImage(im) {
  const g0 = Object.assign({}, im.params.geo, { angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, tr: null, upright: null });
  const G = geometry(g0, im.fullW, im.fullH, true); const U = uniformsFromParams(im.params, im); U.showMask = -1; U.clipWarn = 0;
  const maxW = Math.round(1024 * G.outW / Math.max(G.outW, G.outH)); const { px, w, h } = renderer.readSmall(U, G, maxW, 'upright');
  const v = new Float32Array(w * h); for (let i = 0; i < w * h; i++) v[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  return { v, w, h };
}
function detectSegments(img) {
  const { w, h } = img, n = w * h, v = new Float32Array(img.v); gauss3(v, w, h, 0.8);
  const mag = new Float32Array(n), ang = new Float32Array(n), vals = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, a = v[i - w - 1], b = v[i - w], c = v[i - w + 1], d = v[i - 1], f = v[i + 1], g = v[i + w - 1], hh = v[i + w], k = v[i + w + 1];
    const gx = (c + 2 * f + k) - (a + 2 * d + g), gy = (g + 2 * hh + k) - (a + 2 * b + c);
    mag[i] = Math.hypot(gx, gy) / 8; let an = Math.atan2(gy, gx) + Math.PI / 2; an = ((an % Math.PI) + Math.PI) % Math.PI; ang[i] = an; if (mag[i] > 1e-4) vals.push(mag[i]);
  }
  if (vals.length < 32) return [];
  vals.sort((p, q) => p - q); const thr = Math.max(0.35 * vals[Math.floor(vals.length * 0.9)], 0.008);
  const seeds = []; for (let i = 0; i < n; i++) if (mag[i] > thr) seeds.push(i); seeds.sort((p, q) => mag[q] - mag[p]);
  const used = new Uint8Array(n), segs = [], long = Math.max(w, h), L = long / 2, TOL = 22.5 * Math.PI / 180;
  for (const s of seeds) {
    if (used[s]) continue; used[s] = 1; const reg = [s]; let C2 = Math.cos(2 * ang[s]) * mag[s], S2 = Math.sin(2 * ang[s]) * mag[s];
    for (let q = 0; q < reg.length; q++) {
      const p = reg[q], x = p % w, y = (p - x) / w; const mean = 0.5 * Math.atan2(S2, C2);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const xx = x + dx, yy = y + dy; if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
        const j = yy * w + xx; if (used[j] || mag[j] <= thr) continue;
        let df = Math.abs(ang[j] - mean) % Math.PI; if (df > Math.PI / 2) df = Math.PI - df; if (df > TOL) continue;
        used[j] = 1; reg.push(j); C2 += Math.cos(2 * ang[j]) * mag[j]; S2 += Math.sin(2 * ang[j]) * mag[j];
      }
    }
    if (reg.length < 12) continue;
    let W = 0, mx = 0, my = 0; for (const p of reg) { const x = p % w, y = (p - x) / w; W += mag[p]; mx += mag[p] * x; my += mag[p] * y; } mx /= W; my /= W;
    let sxx = 0, syy = 0, sxy = 0; for (const p of reg) { const x = p % w - mx, y = (p - (p % w)) / w - my; sxx += mag[p] * x * x; syy += mag[p] * y * y; sxy += mag[p] * x * y; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th); let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of reg) { const x = p % w - mx, y = (p - (p % w)) / w - my, along = x * ux + y * uy, across = -x * uy + y * ux; a0 = Math.min(a0, along); a1 = Math.max(a1, along); b0 = Math.min(b0, across); b1 = Math.max(b1, across); }
    const len = a1 - a0, wid = b1 - b0; if (len < 0.04 * long || len / Math.max(wid, 1) < 5) continue;
    const P0 = [(mx + a0 * ux + 0.5 - w / 2) / L, (my + a0 * uy + 0.5 - h / 2) / L], P1 = [(mx + a1 * ux + 0.5 - w / 2) / L, (my + a1 * uy + 0.5 - h / 2) / L];
    const lh = [P0[1] - P1[1], P1[0] - P0[0], P0[0] * P1[1] - P1[0] * P0[1]], nn = Math.hypot(lh[0], lh[1]);
    const dx = P1[0] - P0[0], dy = P1[1] - P0[1], sl = Math.hypot(dx, dy);
    segs.push({ p0: P0, p1: P1, m: [(P0[0] + P1[0]) / 2, (P0[1] + P1[1]) / 2], d: [dx / sl, dy / sl], len: sl, l: lh.map(t => t / nn), tilt: Math.acos(Math.min(1, Math.abs(dy) / sl)) * 180 / Math.PI });
  }
  return segs;
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return a.map(t => t / n); };
function vpErr(s, v) { // degrees between the segment and the direction from its midpoint to the vanishing point
  let dx, dy; if (Math.abs(v[2]) > 1e-9) { dx = v[0] / v[2] - s.m[0]; dy = v[1] / v[2] - s.m[1]; } else { dx = v[0]; dy = v[1]; }
  const n = Math.hypot(dx, dy); if (n < 1e-12) return 90; return Math.acos(Math.min(1, Math.abs((dx * s.d[0] + dy * s.d[1]) / n))) * 180 / Math.PI;
}
function smallestEigvec3(A) { // Jacobi on a symmetric 3x3
  const a = [[A[0], A[1], A[2]], [A[3], A[4], A[5]], [A[6], A[7], A[8]]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1; if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; } if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
    if (Math.abs(a[p][q]) < 1e-14) break; const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
  }
  let m = 0; for (let i = 1; i < 3; i++) if (a[i][i] < a[m][m]) m = i; return [V[0][m], V[1][m], V[2][m]];
}
function findVP(fam, vertical) {
  const top = fam.slice().sort((a, b) => b.len - a.len).slice(0, 60); if (top.length < 2) return null;
  let best = null, bs = 0;
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const v = norm3(cross3(top[i].l, top[j].l)); let sc = 0; for (const s of fam) if (vpErr(s, v) < 1.5) sc += s.len; if (sc > bs) { bs = sc; best = v; }
  }
  if (!best) return null; const inl = fam.filter(s => vpErr(s, best) < 3); if (inl.length < 2) return null;
  const A = new Array(9).fill(0); for (const s of inl) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A[r * 3 + c] += s.len * s.l[r] * s.l[c];
  const v = smallestEigvec3(A); const inl2 = fam.filter(s => vpErr(s, v) < 3); const famLen = fam.reduce((a, s) => a + s.len, 0), inLen = inl2.reduce((a, s) => a + s.len, 0);
  const ms = inl2.map(s => vertical ? s.m[0] : s.m[1]); const spread = ms.length ? Math.max(...ms) - Math.min(...ms) : 0;
  const finiteNear = Math.abs(v[2]) > 1e-9 && Math.abs(v[0] / v[2]) < 2 && Math.abs(v[1] / v[2]) < 2;
  const reliable = inl2.length >= 3 && inLen >= 0.5 && spread >= 0.4 && inLen >= 0.6 * famLen && !finiteNear;
  return { v, reliable, inliers: inl2 };
}
function rotBetween(a, b) { // Rodrigues: minimal rotation taking unit a onto unit b
  const k = cross3(a, b), s = Math.hypot(k[0], k[1], k[2]), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; if (s < 1e-12) return H3.I.slice();
  const K = [0, -k[2], k[1], k[2], 0, -k[0], -k[1], k[0], 0], K2 = H3.mul(K, K), f = (1 - c) / (s * s);
  return H3.I.map((v, i) => v + K[i] + K2[i] * f);
}
const rotAngleDeg = R => Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) * 180 / Math.PI;
const vdir = (v, f) => norm3([v[0] / f, v[1] / f, v[2]]);
function levelAngle(segs, maxDev = 45, minLines = 2) { // length-weighted median deviation, with a consensus test
  const hz = segs.filter(s => s.tilt > 60), vt = segs.filter(s => s.tilt < 30), sl = a => a.reduce((t, s) => t + s.len, 0);
  const useH = sl(hz) >= 0.5 * sl(vt), fam = useH ? hz : vt; if (fam.length < minLines) return null;
  const dev = fam.map(s => { let d = useH ? Math.atan2(s.d[1], s.d[0]) * 180 / Math.PI : -Math.atan2(s.d[0], s.d[1]) * 180 / Math.PI; while (d > 90) d -= 180; while (d <= -90) d += 180; return { d, len: s.len }; }).filter(o => Math.abs(o.d) <= maxDev);
  if (dev.length < minLines) return null; dev.sort((a, b) => a.d - b.d); const tot = sl(dev); let acc = 0, med = dev[0].d; for (const o of dev) { acc += o.len; if (acc >= tot / 2) { med = o.d; break; } }
  const agree = dev.filter(o => Math.abs(o.d - med) <= 2).reduce((t, o) => t + o.len, 0); if (agree < 0.5 * tot) return null; return -med;
}
const rotH = deg => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
function solveUpright(segs, mode) {
  const vt = segs.filter(s => s.tilt < 30), hz = segs.filter(s => s.tilt > 60);
  const V = findVP(vt, true), Hh = findVP(hz, false);
  const vertical = () => { if (!V || !V.reliable) return null; let d = vdir(V.v, TR_F); if (d[1] < 0) d = d.map(t => -t); const R = rotBetween(d, [0, 1, 0]); return { H: recentreH(rotHom(R, TR_F)), ang: rotAngleDeg(R) }; };
  const full = () => {
    if (!V || !V.reliable || !Hh || !Hh.reliable) return null; const v = V.v, h = Hh.v; let f = TR_F;
    if (Math.abs(v[2]) > 0.02 && Math.abs(h[2]) > 0.02) { const f2 = -((v[0] / v[2]) * (h[0] / h[2]) + (v[1] / v[2]) * (h[1] / h[2])); if (f2 > 0 && Math.sqrt(f2) >= 0.5 && Math.sqrt(f2) <= 6) f = Math.sqrt(f2); }
    let dv = vdir(v, f); if (dv[1] < 0) dv = dv.map(t => -t); let dh = vdir(h, f); if (dh[0] < 0) dh = dh.map(t => -t);
    const k = dh[0] * dv[0] + dh[1] * dv[1] + dh[2] * dv[2], r1 = norm3([dh[0] - k * dv[0], dh[1] - k * dv[1], dh[2] - k * dv[2]]), r3 = cross3(r1, dv);
    const R = [...r1, ...dv, ...r3]; return { H: recentreH(rotHom(R, f)), ang: rotAngleDeg(R) };
  };
  const level = () => { const a = levelAngle(segs); return a == null ? null : { H: rotH(a), ang: Math.abs(a), deg: a }; };
  if (mode === 'level') return level(); if (mode === 'vertical') return vertical() || level(); if (mode === 'full') return full() || vertical() || level();
  if (mode === 'auto') { const f = full(); if (f && f.ang < 20) return f; const v = vertical(); if (v && v.ang < 25) return v; const l = level(); if (l && Math.abs(l.deg) <= 5) return l; return null; }
  return null;
}
function computeUpright(mode) {
  const im = CUR(); if (!im || !renderer.src) return; const g = im.params.geo;
  if (mode === 'off') { g.upright = null; g.uprightMode = 'off'; refreshAll(); fitView(); commit(); return; }
  const t0 = performance.now(); const segs = detectSegments(uprightImage(im)); const r = solveUpright(segs, mode);
  if (!r) { toast('找不到足夠可靠的直線，這張照片不適合自動校正'); return; }
  g.upright = r.H; g.uprightMode = mode; if (g.constrain === undefined) g.constrain = true; refreshAll(); fitView(); commit();
  toast(`Upright：已校正（偵測到 ${segs.length} 條線，${Math.round(performance.now() - t0)} ms）`);
}
// Auto straighten: plumb lines, then long lines, then a horizon search; result is the crop angle (max 5 degrees).
function horizonAngle(img) {
  const { w, h } = img, v = new Float32Array(img.v); gauss3(v, w, h, 1.5); const k = 4; if (w < 32 || h < 4 * k + 8) return null;
  const cols = []; for (let x = 0; x < w; x += 4) cols.push(x);
  const P = new Float32Array((h + 1) * cols.length); cols.forEach((x, ci) => { let s = 0; for (let y = 0; y < h; y++) { P[ci * (h + 1) + y] = s; s += v[y * w + x]; } P[ci * (h + 1) + h] = s; });
  const diff = (ci, y) => { const o = ci * (h + 1); return ((P[o + y] - P[o + y - k]) - (P[o + y + k] - P[o + y])) / k; };
  const all = []; for (let ci = 0; ci < cols.length; ci += 2) for (let y = k; y < h - k; y += 2) { const d = Math.abs(diff(ci, y)); if (d > 0) all.push(d); }
  if (all.length < 100) return null; all.sort((a, b) => a - b); const norm = Math.max(all[Math.floor(all.length * 0.99)], 1e-4);
  const y0 = Math.max(Math.ceil(0.05 * h), k), y1 = Math.min(Math.floor(0.95 * h), h - k), buf = new Float32Array(cols.length);
  const score = (tn, b, sg) => { let n = 0; for (let ci = 0; ci < cols.length; ci++) { const y = Math.round(b + tn * (cols[ci] - w / 2)); if (y < y0 || y >= y1) continue; buf[n++] = sg * diff(ci, y); } if (n * 5 < cols.length * 4) return -Infinity; const a = buf.subarray(0, n).sort(); return a[Math.floor(n * 0.3)]; };
  let best = -Infinity, bd = 0, bb = 0, bsg = 1;
  for (const sg of [1, -1]) for (let deg = -10; deg <= 10; deg += 0.25) { const tn = Math.tan(deg * Math.PI / 180); for (let b = y0; b < y1; b += 4) { const s = score(tn, b, sg); if (s > best) { best = s; bd = deg; bb = b; bsg = sg; } } }
  for (let deg = bd - 0.3; deg <= bd + 0.3; deg += 0.02) { const tn = Math.tan(deg * Math.PI / 180); for (let b = bb - 3; b <= bb + 3; b += 0.5) { const s = score(tn, b, bsg); if (s > best) { best = s; bd = deg; bb = b; } } }
  return best / norm >= 0.3 && Math.abs(bd) <= 5 ? -bd : null;
}
function autoStraighten() {
  const im = CUR(); if (!im || !renderer.src) return; const img = uprightImage(im), segs = detectSegments(img);
  let roll = null; const vt = segs.filter(s => s.tilt < 20);
  if (vt.length >= 8) { const V = findVP(vt, true); if (V) { const inl = vt.filter(s => vpErr(s, V.v) < 2), tl = inl.reduce((a, s) => a + s.len, 0), xs = inl.map(s => s.m[0]);
    const finiteNear = Math.abs(V.v[2]) > 1e-9 && Math.abs(V.v[0] / V.v[2]) < 2 && Math.abs(V.v[1] / V.v[2]) < 2;
    if (inl.length >= 8 && tl >= 1.5 && xs.length && Math.max(...xs) - Math.min(...xs) >= 0.6 && !finiteNear) { let d = V.v[1] < 0 ? V.v.map(t => -t) : V.v; let r = Math.atan2(d[0], d[1]) * 180 / Math.PI; while (r > 90) r -= 180; while (r <= -90) r += 180; if (Math.abs(r) <= 5) roll = r; } } }
  let ang = roll;
  if (ang == null) { const l = levelAngle(segs, 10, 3), hz = horizonAngle(img); if (hz != null && l != null) ang = Math.abs(hz - l) <= 1 ? hz : null; else if (hz != null) ang = hz; else if (l != null && Math.abs(l) <= 5) ang = l; }
  if (ang == null) { toast('找不到可以拉直的水平線或垂直線'); return; }
  im.params.geo.angle = Math.round(-ang * 10) / 10 || 0; refreshAll(); fitView(); commit(); toast(`已自動拉直 ${im.params.geo.angle.toFixed(1)}°`);
}

// ---------- smart masks: sky, subject, background ----------
// Raster masks like the brush (one channel of the brush texture each), refined with the same brush/eraser. Sky and the
// fallback subject are LightCraft's heuristics (MIT); "subject" uses the U^2-Net-P model (Apache-2.0 weights, rembg ONNX export
// MIT) through onnxruntime-web (MIT) when it can be downloaded, running entirely on this device.
const isRaster = t => t === 'brush' || t === 'sky' || t === 'subject' || t === 'background';
const smoothJ = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const AI = { ort: null, sess: null, loading: null, cache: new Map() };
// oriented-frame coordinates (0..1, ignoring crop and straighten) for every texel of the W x H brush texture
function orientedGrid(im, W, H, geo) {
  const g0 = Object.assign({}, geo || im.params.geo, { angle: 0, tr: null, upright: null }), G0 = geometry(g0, im.fullW, im.fullH, true);
  const nx = new Float32Array(W * H), ny = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = invMap(G0.m, (x + 0.5) / W * im.fullW, (y + 0.5) / H * im.fullH); nx[y * W + x] = o[0] / G0.outW; ny[y * W + x] = o[1] / G0.outH; }
  return { nx, ny, G0 };
}
function logLumGrid(pd, W, H, ev) { const gain = Math.pow(2, ev || 0), n = W * H, logL = new Float32Array(n), blue = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = Math.min(pd.w - 1, Math.floor((x + 0.5) / W * pd.w)), py = Math.min(pd.h - 1, Math.floor((y + 0.5) / H * pd.h)), o = (py * pd.w + px) * 3;
    const R = pd.data[o] / 65535 * gain, G = pd.data[o + 1] / 65535 * gain, B = pd.data[o + 2] / 65535 * gain, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, i = y * W + x;
    logL[i] = Math.log2(Math.max(Y, 1e-7) / 0.18); blue[i] = Math.max(B - R, 0) / (B + 1e-4);
  }
  return { logL, blue };
}
// two-image guided filter (Gaussian windows): snaps a soft mask to the edges of the guide I
function guidedCross(I, p, W, H, sigma, eps) {
  const n = W * H, mI = new Float32Array(I), mp = new Float32Array(p), II = new Float32Array(n), Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
  for (const a of [mI, mp, II, Ip]) gauss3(a, W, H, sigma);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = II[i] - mI[i] * mI[i]; A[i] = (Ip[i] - mI[i] * mp[i]) / (v + eps); B[i] = mp[i] - A[i] * mI[i]; }
  gauss3(A, W, H, sigma); gauss3(B, W, H, sigma);
  const q = new Float32Array(n); for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, A[i] * I[i] + B[i])); return q;
}
// alpha (0..1, W x H) for a smart mask, or null while an AI result is still being decoded
function smartAlpha(im, m, W, H, src) {
  const pd = src || (state.previewData && state.previewData.imId === im.id ? state.previewData : null); if (!pd) return null;
  const b = m.base || { kind: m.type }, S = Math.max(W, H), kind = b.kind;
  const { logL, blue } = logLumGrid(pd, W, H, b.ev);
  let a;
  if (kind === 'sky') {
    const { ny } = orientedGrid(im, W, H); a = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { const top = 1 - smoothJ(0.25, 0.7, ny[i]); a[i] = top * smoothJ(-3.5, -1.0, logL[i]) * (0.4 + 0.6 * Math.max(smoothJ(0, 0.3, blue[i]), smoothJ(0, 1.5, logL[i]))); }
    gauss3(a, W, H, Math.max(0.01 * S, 0.5));
  } else if (b.ai) {
    const map = AI.cache.get(b.ai.z); if (!map) { decodeAIMask(b.ai.z, b.ai.w, b.ai.h); return null; }
    const { nx, ny } = orientedGrid(im, W, H, b.ai.geo); a = new Float32Array(W * H); const aw = b.ai.w, ah = b.ai.h;
    for (let i = 0; i < W * H; i++) { // bilinear lookup of the model output in the oriented frame
      const fx = Math.min(aw - 1.001, Math.max(0, nx[i] * aw - 0.5)), fy = Math.min(ah - 1.001, Math.max(0, ny[i] * ah - 0.5)), x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, o = y0 * aw + x0;
      a[i] = ((map[o] * (1 - tx) + map[o + 1] * tx) * (1 - ty) + (map[o + aw] * (1 - tx) + map[o + aw + 1] * tx) * ty) / 255;
    }
    const q = guidedCross(logL, a, W, H, Math.max(0.006 * S, 1), 0.02); for (let i = 0; i < a.length; i++) a[i] = 0.35 * a[i] + 0.65 * q[i];
    if (kind === 'background') for (let i = 0; i < a.length; i++) a[i] = 1 - a[i];
  } else { // heuristic subject: centre-weighted, favouring local contrast
    const { nx, ny } = orientedGrid(im, W, H); const bl = new Float32Array(logL); gauss3(bl, W, H, Math.max(0.03 * S, 1)); a = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { const d = Math.hypot((nx[i] - 0.5) / 0.35, (ny[i] - 0.55) / 0.4), con = Math.abs(logL[i] - bl[i]); a[i] = (1 - smoothJ(0.6, 1, d)) * (0.5 + 0.5 * smoothJ(0.05, 0.6, con)); }
    gauss3(a, W, H, Math.max(0.015 * S, 0.5));
    if (kind === 'background') for (let i = 0; i < a.length; i++) a[i] = 1 - a[i];
  }
  return a;
}
async function decodeAIMask(z, w, h) {
  if (AI.cache.has(z) || AI['dec_' + z]) return; AI['dec_' + z] = 1;
  try {
    const bin = Uint8Array.from(atob(z), c => c.charCodeAt(0));
    const raw = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    AI.cache.set(z, raw); BR.sig = ['', '', '', '']; if (CUR()) { syncBrush(CUR()); requestRender(false); }
  } catch (e) { console.error(e); }
}
// lazily load onnxruntime-web (wasm, single thread) and the U^2-Net-P model; the model file is cached for offline use
async function loadSubjectModel(onProgress) {
  if (AI.sess) return AI.sess; if (AI.loading) return AI.loading;
  AI.loading = (async () => {
    const BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
    onProgress && onProgress('下載 AI 執行環境…');
    const ort = AI.ort || (AI.ort = await import(BASE + 'esm/ort.wasm-core.min.js'));
    ort.env.wasm.wasmPaths = BASE; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    const URL_ = 'https://huggingface.co/BritishWerewolf/U-2-Netp/resolve/7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8/onnx/model.onnx';
    let buf = null; try { const c = await caches.open('raw-editor-models'); const hit = await c.match(URL_); if (hit) buf = await hit.arrayBuffer(); } catch { }
    if (!buf) { onProgress && onProgress('下載主體模型（約 4.6 MB，只需一次）…'); const r = await fetch(URL_); if (!r.ok) throw new Error('模型下載失敗 ' + r.status); buf = await r.clone().arrayBuffer(); try { (await caches.open('raw-editor-models')).put(URL_, r); } catch { } }
    AI.sess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }); return AI.sess;
  })();
  try { return await AI.loading; } catch (e) { AI.loading = null; throw e; }
}
async function runSubjectAI(im) {
  const sess = await loadSubjectModel(msg => status(msg)); const ort = AI.ort; status('AI 分析主體…');
  const g0 = Object.assign({}, im.params.geo, { angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, tr: null, upright: null }), G0 = geometry(g0, im.fullW, im.fullH, true);
  const U = uniformsFromParams(im.params, im); U.showMask = -1; U.clipWarn = 0; const { px, w, h } = renderer.readSmall(U, G0, 640, 'ai');
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer.slice(0)), w, h), 0, 0);
  const c2 = document.createElement('canvas'); c2.width = 320; c2.height = 320; const g2 = c2.getContext('2d'); g2.drawImage(cv, 0, 0, 320, 320);
  const d = g2.getImageData(0, 0, 320, 320).data; const inp = new Float32Array(3 * 320 * 320); let mx = 1;
  for (let i = 0; i < 320 * 320; i++) mx = Math.max(mx, d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) for (let i = 0; i < 320 * 320; i++) inp[c * 320 * 320 + i] = (d[i * 4 + c] / mx - mean[c]) / std[c];
  await new Promise(r => setTimeout(r, 30)); // let the status message paint before the blocking run
  const t0 = performance.now(); const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, 320, 320]) });
  const o = out[sess.outputNames[0]].data; let lo = Infinity, hi = -Infinity; for (const v of o) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const map = new Uint8Array(320 * 320); for (let i = 0; i < map.length; i++) map[i] = Math.round((o[i] - lo) / Math.max(hi - lo, 1e-6) * 255);
  const z = new Uint8Array(await new Response(new Blob([map]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  let s = ''; for (let i = 0; i < z.length; i += 32768) s += String.fromCharCode.apply(null, z.subarray(i, i + 32768));
  const zz = btoa(s); AI.cache.set(zz, map); status('');
  return { z: zz, w: 320, h: 320, ms: Math.round(performance.now() - t0), geo: { rot: im.params.geo.rot, flipH: im.params.geo.flipH, flipV: im.params.geo.flipV } };
}
async function upgradeSubjectMask(m) {
  const im = CUR(); if (!im) return;
  try {
    const ai = await runSubjectAI(im); if (!im.params.masks.includes(m)) return;
    m.base = Object.assign({}, m.base, { ai }); BR.sig = ['', '', '', '']; syncBrush(im); requestRender(false); commit();
    toast(`AI 已選取主體（${ai.ms} ms）。可以用畫筆／橡皮擦修邊。`);
  } catch (e) { console.error(e); status(''); toast('AI 模型無法使用（' + (e.message || e) + '），先用一般演算法選取。', 5000); }
}

// ---------- design-system shell: grouped navigation, panel, gestures, theme ----------
// Eight groups in editing order (design system "ToolBar" / "Tabs"); groups with several sections get a segmented sub-nav.
const GROUPS = [
  { id: 'presets', name: '預設', icon: 'presets', tabs: [['presets', '預設集']] },
  { id: 'light', name: '光線', icon: 'light', tabs: [['light', '光線']] },
  { id: 'color', name: '顏色', icon: 'color', tabs: [['color', '基本'], ['hsl', 'HSL／點顏色'], ['grade', '色調分級']] },
  { id: 'curve', name: '曲線', icon: 'curve', tabs: [['curve', '曲線']] },
  { id: 'fx', name: '效果', icon: 'effects', tabs: [['fx', '效果']] },
  { id: 'detail', name: '細節', icon: 'detail', tabs: [['detail', '細節']] },
  { id: 'local', name: '局部', icon: 'mask', tabs: [['local', '遮罩'], ['heal', '修復']] },
  { id: 'geo', name: '幾何', icon: 'crop', tabs: [['crop', '裁切與變形'], ['lens', '鏡頭']] },
];
const GROUP_KEYS = {
  presets: ['film'], light: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'profile', 'profileAmt'],
  color: ['temp', 'tint', 'vibrance', 'saturation', 'hsl', 'pointColors', 'bw', 'bwmix', 'grade', 'calib'], curve: ['curves', 'pcurve'],
  fx: ['clarity', 'dehaze', 'texture', 'fade', 'vignette', 'vigMid', 'vigFeather', 'vigRound', 'vigHi', 'grain', 'grainSize', 'grainRough'],
  detail: ['sharpen', 'sharpenRadius', 'sharpenMask', 'nrLum', 'nrColor'], local: ['masks', 'spots'], geo: ['geo', 'lens'],
};
const groupOf = tab => GROUPS.find(g => g.tabs.some(t => t[0] === tab));
const nav = { sub: {}, sections: [] }; // last sub-tab per group; [{el, keys}] section headers with a modified dot
function buildNav() {
  const tabs = $('#tabs'), tb = $('#toolbar'); tabs.innerHTML = ''; tb.innerHTML = '';
  for (const g of GROUPS) {
    const go = () => {
      const cur = groupOf(state.tab);
      if (cur === g && !app.classList.contains('desktop')) { setPanelMode($('#side').classList.contains('collapsed') ? 'auto' : 'collapsed'); return; } // tapping the current tool folds the panel
      selectTab(nav.sub[g.id] || g.tabs[0][0]); if ($('#side').classList.contains('collapsed')) setPanelMode('auto');
    };
    tabs.append(el('button', { 'data-group': g.id, 'data-tab': g.tabs[0][0], role: 'tab', onclick: go }, g.name, el('span', { class: 'dot' })));
    const b = el('button', { 'data-group': g.id, 'data-tab': g.tabs[0][0], role: 'tab', 'aria-label': g.name, onclick: go }); b.innerHTML = iconSVG(g.icon) + `<span>${g.name}</span><span class="dot"></span>`; tb.append(b);
  }
  updateNav(state.tab);
}
function updateNav(tab) {
  const g = groupOf(tab); if (g) nav.sub[g.id] = tab;
  for (const bar of [$('#tabs'), $('#toolbar')]) for (const b of bar.children) b.classList.toggle('on', !!g && b.dataset.group === g.id);
  const st = $('#subtabs'); st.innerHTML = '';
  if (g && g.tabs.length > 1) { for (const [id, name] of g.tabs) st.append(el('button', { class: id === tab ? 'on' : '', role: 'tab', onclick: () => selectTab(id) }, name)); st.classList.add('on'); }
  else st.classList.remove('on');
  for (const bar of [$('#tabs'), $('#toolbar')]) { const b = g && bar.querySelector(`[data-group="${g.id}"]`); if (b && (b.offsetLeft < bar.scrollLeft || b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth)) bar.scrollTo({ left: b.offsetLeft - (bar.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' }); }
}
function refreshNavDots() {
  const im = CUR(); const d = im ? defaultsFor(im) : null; const p = im ? im.params : null;
  const differs = k => { if (!p) return false; const a = p[k], b = d[k]; if (k === 'masks' || k === 'spots' || k === 'pointColors') return !!(a && a.length); return JSON.stringify(a) !== JSON.stringify(b); };
  for (const bar of [$('#tabs'), $('#toolbar')]) for (const b of bar.children) b.classList.toggle('mod', (GROUP_KEYS[b.dataset.group] || []).some(differs));
  for (const s of nav.sections) s.el.classList.toggle('mod', s.keys.some(k => p && JSON.stringify(getPath(p, k)) !== JSON.stringify(getPath(d, k))));
}
// phone panel: peek (38vh) / tall (56vh) / collapsed (only the grab bar); drag the grab bar to snap
let panelMode = 'auto';
function setPanelMode(m) {
  panelMode = m; const side = $('#side');
  side.classList.toggle('collapsed', m === 'collapsed');
  if (m === 'peek') side.classList.remove('tall'); else if (m === 'tall') side.classList.add('tall');
  else if (m === 'auto') side.classList.toggle('tall', ['curve', 'hsl', 'presets'].includes(state.tab));
  side.style.height = '';
}
function initPanelDrag() {
  const side = $('#side'), grab = $('#grab'); let drag = null;
  grab.addEventListener('pointerdown', e => { if (app.classList.contains('desktop')) return; try { grab.setPointerCapture(e.pointerId); } catch { } drag = { y: e.clientY, h: side.getBoundingClientRect().height, moved: false }; side.classList.add('dragging'); });
  grab.addEventListener('pointermove', e => { if (!drag) return; const dy = drag.y - e.clientY; if (Math.abs(dy) > 4) drag.moved = true; side.classList.remove('collapsed'); side.style.height = Math.max(22, Math.min(innerHeight * 0.6, drag.h + dy)) + 'px'; });
  const end = () => { if (!drag) return; side.classList.remove('dragging');
    if (!drag.moved) { setPanelMode(side.classList.contains('collapsed') ? 'auto' : 'collapsed'); drag = null; return; }
    const h = side.getBoundingClientRect().height / innerHeight; drag = null;
    setPanelMode(h < 0.2 ? 'collapsed' : h < 0.47 ? 'peek' : 'tall'); };
  grab.addEventListener('pointerup', end); grab.addEventListener('pointercancel', end);
  // the photo area follows the panel live (drag, snap, collapse, first photo): refit and redraw in the same frame so it never stretches
  let rt = 0; new ResizeObserver(() => { const w = view.width, h = view.height; fitCanvas(); if (view.width !== w || view.height !== h) { draw(); clearTimeout(rt); rt = setTimeout(() => requestRender(false), 150); } }).observe($('#stage'));
}
// theme: dark (default) / light (outdoor); the photo surround follows the canvas token
function applyTheme(t) {
  document.documentElement.dataset.theme = t; try { localStorage.setItem('rawedit:theme', t); } catch { }
  const cs = getComputedStyle(document.documentElement);
  const hex = cs.getPropertyValue('--canvas').trim(); const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (m && renderer) { const v = parseInt(m[1], 16); renderer.bgColor = [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; draw(); }
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = cs.getPropertyValue('--surface').trim();
  for (const b of $('#themeSeg').children) b.classList.toggle('on', b.dataset.theme === t);
}
// one-line shooting info under the file name
function exifLine(im) {
  const m = im.meta || {}; const sh = m.shutter ? (m.shutter >= 1 ? m.shutter.toFixed(1) + 's' : '1/' + Math.round(1 / m.shutter) + 's') : '';
  const parts = [m.model || '', m.focal ? Math.round(m.focal) + 'mm' : '', m.aperture ? 'f/' + (+m.aperture.toFixed(1)) : '', sh, m.iso ? 'ISO ' + Math.round(m.iso) : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : `${im.fullW}×${im.fullH}`;
}
function initDesignUI() {
  for (const b of document.querySelectorAll('[data-icon]')) { const lbl = b.dataset.label; b.innerHTML = iconSVG(b.dataset.icon, lbl ? 18 : 22) + (lbl ? `<span>${lbl}</span>` : ''); }
  buildNav(); initPanelDrag();
  const info = $('#sec-info'); if (info) { $('#menuInfo').append(info); info.classList.add('on'); }
  $('#mRedo').onclick = () => { $('#modalMenu').classList.remove('on'); redo(); };
  $('#mFilm').onclick = () => { $('#modalMenu').classList.remove('on'); $('#btnFilm').onclick(); };
  for (const b of $('#themeSeg').children) b.onclick = () => applyTheme(b.dataset.theme);
  let t = 'dark'; try { t = localStorage.getItem('rawedit:theme') || 'dark'; } catch { } applyTheme(t);
  // export format as a segmented control (the select stays the source of truth)
  const fs = $('#expFmtSeg'), sel = $('#expFmt');
  for (const o of sel.options) fs.append(el('button', { 'data-v': o.value, onclick: () => { sel.value = o.value; sel.dispatchEvent(new Event('change')); syncFmt(); } }, o.value === 'jpeg' ? 'JPEG' : o.value === 'tiff' ? 'TIFF 16 位元' : 'PNG 16 位元'));
  const syncFmt = () => { for (const b of fs.children) b.classList.toggle('on', b.dataset.v === sel.value); }; sel.addEventListener('change', syncFmt); syncFmt();
  // drag a file over the photo: dashed accent frame
  const stage = $('#stage'); let dz = 0;
  vw.addEventListener('dragenter', () => { dz++; stage.classList.add('dragover'); }); vw.addEventListener('dragleave', () => { if (--dz <= 0) { dz = 0; stage.classList.remove('dragover'); } });
  vw.addEventListener('drop', () => { dz = 0; stage.classList.remove('dragover'); });
  initPhotoGestures(); initSheets();
}
// sheets (export, more, paste): Esc closes, focus moves in on open and back on close, swipe the grab bar / title down to close (phone)
function initSheets() {
  const closeable = m => !(m.id === 'modalExport' && state.busy);
  const onToggle = m => {
    const on = m.classList.contains('on'); if (on === !!m._open) return; m._open = on;
    const sh = m.querySelector('.sheet'); if (!sh) return;
    if (on) {
      m._ret = document.activeElement; sh.style.transform = ''; sh.style.transition = '';
      if (!sh.querySelector(':scope > .sgrab')) sh.prepend(el('div', { class: 'sgrab', 'aria-hidden': 'true' }));
      const f = [...sh.querySelectorAll('button, select, input, [tabindex="0"]')].find(x => !x.disabled && x.offsetParent && !x.closest('.sgrab'));
      if (f) try { f.focus({ preventScroll: true }); } catch { }
    } else if (m._ret && m._ret.isConnected && m._ret.focus) { try { m._ret.focus({ preventScroll: true }); } catch { } m._ret = null; }
  };
  const watch = m => { if (m._watched) return; m._watched = true; new MutationObserver(() => onToggle(m)).observe(m, { attributes: true, attributeFilter: ['class'] }); };
  document.querySelectorAll('.modal').forEach(watch);
  new MutationObserver(ms => { for (const r of ms) for (const n of r.addedNodes) if (n.classList && n.classList.contains('modal')) watch(n); }).observe(document.body, { childList: true });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return; const open = [...document.querySelectorAll('.modal.on')].pop(); if (!open || !closeable(open)) return;
    e.preventDefault(); e.stopPropagation(); open.classList.remove('on');
  }, true);
  document.addEventListener('pointerdown', e => {
    if (app.classList.contains('desktop') || e.button !== 0) return;
    const sh = e.target.closest && e.target.closest('.modal.on > .sheet'); if (!sh || !e.target.closest('.sgrab, .sheet > h3') || e.target.closest('button, input, select')) return;
    const m = sh.parentElement, y0 = e.clientY, t0 = Date.now(), H = sh.getBoundingClientRect().height; let dy = 0;
    sh.style.transition = 'none';
    const mv = ev => { dy = Math.max(0, ev.clientY - y0); sh.style.transform = dy ? `translateY(${dy}px)` : ''; };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      sh.style.transition = 'transform 200ms ease-out';
      if ((dy > 90 || (dy > 40 && Date.now() - t0 < 250)) && closeable(m)) { sh.style.transform = `translateY(${H}px)`; setTimeout(() => m.classList.remove('on'), 190); }
      else sh.style.transform = '';
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
}
// press and hold the photo = original; swipe left/right = next/previous photo (when fitted and not in a tool that uses touches)
function initPhotoGestures() {
  let g = null;
  const busyTab = () => ['local', 'heal', 'crop'].includes(state.tab) || state.pickWB || state.pickPC || state.pickCR;
  view.addEventListener('pointerdown', e => {
    if (!CUR() || busyTab() || e.button !== 0) { g = null; return; }
    if (g && g.id !== e.pointerId) { clearTimeout(g.t); if (g.hold) { state.compare = 0; draw(); } g = null; return; } // second finger: pinch
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: Date.now(), hold: false, moved: false };
    g.t = setTimeout(() => { if (!g || g.moved) return; g.hold = true; ensureBefore(); if (state.compare !== 2) { state.compare = 1; draw(); } }, 380);
  }, true);
  view.addEventListener('pointermove', e => { if (!g || e.pointerId !== g.id) return; if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) { g.moved = true; clearTimeout(g.t); } }, true);
  const end = e => {
    if (!g || e.pointerId !== g.id) return; clearTimeout(g.t);
    if (g.hold) { if (state.compare === 1) { state.compare = 0; draw(); } g = null; return; }
    const dx = e.clientX - g.x, dy = e.clientY - g.y, dt = Date.now() - g.t0;
    if (images.length > 1 && dt < 450 && Math.abs(dx) > 70 && Math.abs(dy) < 50 && Math.abs(state.zoom - 1) < 1e-6) { const n = cur + (dx < 0 ? 1 : -1); if (n >= 0 && n < images.length) selectImage(n); }
    g = null;
  };
  view.addEventListener('pointerup', end, true); view.addEventListener('pointercancel', e => { if (g && e.pointerId === g.id) { clearTimeout(g.t); if (g.hold && state.compare === 1) { state.compare = 0; draw(); } g = null; } }, true);
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
      if (it.id === 'none') clearPresetUI(); else if (b.classList.contains('on')) clearPresetUI(); else applyPresetUI(it.p, it.id); // tapping the selected card again = back to before
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
  renderHistoryUI(); refreshNavDots(); updateUndoButtons(); saveEdits(im); updateFilmstrip();
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
  if (state.tab === 'heal') { drawHealOverlay(ctx); return; }
  if (!state.cropMode) return;
  const G = currentGeometry(); const c = im.params.geo.crop;
  const [x0, y0] = frameToScreen(c.x * G.Wr, c.y * G.Hr), [x1, y1] = frameToScreen((c.x + c.w) * G.Wr, (c.y + c.h) * G.Hr);
  const [fx0, fy0] = frameToScreen(0, 0), [fx1, fy1] = frameToScreen(G.Wr, G.Hr);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.rect(fx0, fy0, fx1 - fx0, fy1 - fy0); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill('evenodd');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1 * dpr; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  drawCropGuides(ctx, x0, y0, x1, y1, dpr);
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
function invMap(m, x, y) { if (m[2] || m[5] || m[8] !== 1) { const R = H3.inv([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]); return H3.ap(R, x, y); } const a = m[0], b = m[1], c = m[3], d = m[4], X = x - m[6], Y = y - m[7], det = a * d - b * c; return [(d * X - c * Y) / det, (-b * X + a * Y) / det]; }
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
  } else if (isRaster(m.type) && state.cursor) {
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
function strokesSig(m) { let n = 0; for (const s of m.strokes) n += s.p.length; const b = m.base; return m.id + ':' + m.strokes.length + ':' + n + (b ? ':' + b.kind + ':' + (b.ev || 0) + (b.ai ? ':ai' + b.ai.z.length : '') : ''); }
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
function rasterMask(ch, m, im, src) {
  const ctx = BR.ctx[ch]; ctx.clearRect(0, 0, BR.W, BR.H);
  if (m && m.type !== 'brush' && im) { // smart mask base alpha, then the user's add/erase strokes on top
    const a = smartAlpha(im, m, BR.W, BR.H, src);
    if (a) { const img = new ImageData(BR.W, BR.H); for (let i = 0; i < a.length; i++) { const o = i * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = Math.round(a[i] * 255); } ctx.putImageData(img, 0, 0); }
  }
  if (m) for (const st of m.strokes) { const p = st.p; if (p.length < 2) continue; paintSegment(ctx, st, p[0], p[1], p[0], p[1], true); for (let i = 2; i + 1 < p.length; i += 2) paintSegment(ctx, st, p[i - 2], p[i - 1], p[i], p[i + 1], false); }
  copyChannel(ch, 0, 0, BR.W, BR.H);
}
// make the GPU brush texture match im's brush masks (cheap when nothing changed)
function syncBrush(im, src) {
  if (!im || !im.fullW) return; const ms = (im.params.masks || []).filter(m => isRaster(m.type)); if (!ms.length) return;
  const S = LOW_MEM ? 1024 : 1536, Lm = Math.max(im.fullW, im.fullH);
  const W = Math.max(8, Math.round(S * im.fullW / Lm)), H = Math.max(8, Math.round(S * im.fullH / Lm));
  if (BR.imId !== im.id || BR.W !== W || BR.H !== H) {
    BR.imId = im.id; BR.W = W; BR.H = H; BR.S = S; BR.buf = new Uint8Array(W * H * 4); BR.sig = ['', '', '', ''];
    for (let c = 0; c < 4; c++) { const cv = BR.cv[c] || (BR.cv[c] = document.createElement('canvas')); cv.width = W; cv.height = H; BR.ctx[c] = cv.getContext('2d', { willReadFrequently: true }); }
    renderer.setBrushSize(W, H); BR.dirtyAll = true;
  }
  let dirty = BR.dirtyAll; BR.dirtyAll = false;
  for (let c = 0; c < 4; c++) { const m = ms.find(x => x.ch === c); const sig = m ? strokesSig(m) : ''; if (sig !== BR.sig[c]) { rasterMask(c, m, im, src); BR.sig[c] = sig; dirty = true; } }
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
function cancelShortStroke() { const m = activeMask(); if (m && isRaster(m.type) && m.strokes.length && m.strokes[m.strokes.length - 1].p.length <= 8) { m.strokes.pop(); requestRender(true); } }

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
// spot tool: tap adds a spot (auto source), drag a circle to move it, drag the dashed circle to change the source
view.addEventListener('pointerdown', e => {
  if (state.tab !== 'heal' || !CUR() || !CUR().fullW) return;
  if (healUI.tap && healUI.tap.id !== e.pointerId) { healUI.tap = null; return; } // second finger: pinch, not a tap
  if (e.button !== 0) return; const [x, y] = canvasPt(e); const hit = healHit(x, y);
  if (hit) { e.preventDefault(); e.stopImmediatePropagation(); healUI.sel = hit.i; healUI.drag = Object.assign({ id: e.pointerId, moved: false }, hit); (() => { try { view.setPointerCapture(e.pointerId); } catch { } })(); refreshHealUI(); drawOverlay(); return; }
  healUI.tap = { x, y, id: e.pointerId, t: Date.now() };
}, true);
view.addEventListener('pointermove', e => {
  if (healUI.drag && e.pointerId === healUI.drag.id) {
    e.stopImmediatePropagation(); const [x, y] = canvasPt(e); const iso = canvasToIso(x, y); const s = CUR().params.spots[healUI.drag.i]; if (!s) return;
    if (healUI.drag.part === 'dst') { s.x = iso[0]; s.y = iso[1]; } else { s.ox = iso[0] - s.x; s.oy = iso[1] - s.y; }
    healUI.drag.moved = true; drawOverlay(); clearTimeout(healUI.dt); healUI.dt = setTimeout(() => refreshSpotSource(CUR()), 120); return;
  }
  if (healUI.tap && e.pointerId === healUI.tap.id) { const [x, y] = canvasPt(e); if (Math.hypot(x - healUI.tap.x, y - healUI.tap.y) > 10 * dprNow()) healUI.tap = null; }
}, true);
view.addEventListener('pointerup', e => {
  if (healUI.drag && e.pointerId === healUI.drag.id) { e.stopImmediatePropagation(); const moved = healUI.drag.moved; healUI.drag = null; if (moved) { refreshSpotSource(CUR()); commit(); } return; }
  const t = healUI.tap; healUI.tap = null;
  if (state.tab === 'heal' && t && e.pointerId === t.id && Date.now() - t.t < 450) {
    const im = CUR(); const [x, y] = canvasPt(e); const iso = canvasToIso(x, y), Lm = Math.max(im.fullW, im.fullH);
    if (iso[0] < 0 || iso[1] < 0 || iso[0] > im.fullW / Lm || iso[1] > im.fullH / Lm) return;
    addSpotAt(iso[0], iso[1]);
  }
}, true);
view.addEventListener('pointerdown', e => { if ((state.pickPC || state.pickCR) && CUR() && e.button === 0) { e.preventDefault(); e.stopImmediatePropagation(); pickColorAt(e); } }, true);
view.addEventListener('pointerdown', e => { if (state.pickWB && CUR() && e.button === 0) { e.preventDefault(); e.stopImmediatePropagation(); pickWBAt(e); } }, true);
view.addEventListener('pointerdown', e => {
  if (!CUR()) return; (() => { try { view.setPointerCapture(e.pointerId); } catch { } })(); const [x, y] = canvasPt(e); ptrs.set(e.pointerId, { x, y });
  if (ptrs.size === 1 && state.tab === 'local' && activeMask() && !spaceDown && e.button === 0 && CUR().fullW) {
    const m = activeMask();
    if (isRaster(m.type)) { gesture = { type: 'paint', lastTap: 0 }; state.cursor = [x, y]; strokeStart(x, y); return; }
    const hit = maskHit(x, y); if (hit) { gesture = { type: 'mask', key: hit, m0: clone(m), start: canvasToIso(x, y), lastTap: 0 }; return; }
  }
  if (ptrs.size === 1) {
    const now = Date.now();
    if (gesture && gesture.lastTap && now - gesture.lastTap < 300 && !state.cropMode && state.tab !== 'heal') { // double tap: toggle 100% / fit
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
  if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse' && state.tab === 'local' && activeMask() && isRaster(activeMask().type)) { state.cursor = canvasPt(e); drawOverlay(); } return; }
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
  $('#drop').style.display = 'none'; app.classList.remove('empty'); $('#filmstrip').classList.toggle('hidden', images.length < 2);
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
    healUI.sig = null; healUI.sel = -1; refreshSpotSource(im, true);
    if (r.thumbURL && !im.thumbUrl) { im.thumbUrl = r.thumbURL; updateFilmstrip(); }
    if (r.thumb && !im.thumbBlobUrl) { im.thumbBlobUrl = URL.createObjectURL(new Blob([r.thumb], { type: 'image/jpeg' })); im.thumbUrl = im.thumbBlobUrl; updateFilmstrip(); }
    if (needsCamLook(im)) {
      status('比對相機 JPEG 的色調…'); const vals = await fitCameraLook(im, null, () => seq !== loadSeq); if (seq !== loadSeq) return;
      if (vals) { applyCameraLook(im, vals); refreshAll(); updateUndoButtons(); camLookToast(im); }
    }
    ti.style.display = 'none';
    curveEd.setCurves(im.params.curves); renderer.setCurveLUT(curveLUTFor(im.params));
    fitCanvas(); fitView(); refreshLensUI(); refreshLocalUI(); requestRender(false); showInfo(); $('#btnExport').disabled = false;
    schedulePresetThumbs();
    $('#finfo').textContent = exifLine(im); $('#finfo').title = $('#finfo').dataset.dims = `${im.fullW}×${im.fullH} · 預覽 ${r.width}×${r.height} · ${(r.timings.total / 1000).toFixed(1)}s`;
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
$('#mReset').onclick = async () => {
  const im = CUR(); if (!im) return; $('#modalMenu').classList.remove('on');
  if (!im.look && camLookOn && !im.file._isImage && im.thumbBlobUrl && state.previewData && state.previewData.imId === im.id) {
    status('比對相機 JPEG 的色調…'); const v = await fitCameraLook(Object.assign({}, im, { params: clone(defaultsFor(im)) }), null); status('');
    if (CUR() !== im) return; if (v) im.look = v;
  }
  im.params = startingParams(im); im.presetId = null; refreshAll(); fitView(); commit();
  toast(im.look && camLookOn ? '已重設為相機 JPEG 的色調' : '已重設這張照片', 5000, { action: { label: '復原', fn: undo } });
};
$('#mExportPresets').onclick = () => download(new Blob([JSON.stringify({ app: 'RAW Editor', presets: userPresets }, null, 1)], { type: 'application/json' }), 'raw-editor-presets.json');
$('#mImportPresets').onclick = () => { const inp = el('input', { type: 'file', accept: '.json' }); inp.onchange = async () => { try { const j = JSON.parse(await inp.files[0].text()); const list = j.presets || (Array.isArray(j) ? j : null); if (!list) throw new Error('格式不符'); for (const p of list) if (p && p.name && p.p) userPresets.push(p); saveUserPresets(); renderPresetGrid(); toast('已匯入 ' + list.length + ' 個預設集'); } catch (e) { toast('匯入失敗：' + e.message); } }; inp.click(); };
$('#optCamLook').checked = camLookOn; $('#optCamLook').onchange = e => { camLookOn = e.target.checked; try { localStorage.setItem('rawedit:camlook', camLookOn ? '1' : '0'); } catch { } };
$('#optHQ').checked = state.hq; $('#optHQ').onchange = e => { state.hq = e.target.checked; try { localStorage.setItem('rawedit:hq', state.hq ? '1' : '0'); } catch { } };
$('#optHist').checked = state.hist; $('#optHist').onchange = e => { state.hist = e.target.checked; try { localStorage.setItem('rawedit:hist', state.hist ? '1' : '0'); } catch { } updateHistogram(); };
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'ArrowRight' && !e.ctrlKey) selectImage(cur + 1); else if (e.key === 'ArrowLeft' && !e.ctrlKey) selectImage(cur - 1);
  else if (e.key === ' ' && state.tab === 'local' && activeMask() && isRaster(activeMask().type)) { e.preventDefault(); spaceDown = true; }
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
$('#btnExport').onclick = () => { if (!CUR()) return; if (LOW_MEM && !modalExport.dataset.init) { $('#expSize').value = '4000'; } modalExport.dataset.init = 1; $('#expMsg').textContent = ''; $('#expBar').style.width = '0'; $('#expGo').disabled = false; $('#expGo').textContent = '開始匯出'; $('#expGo').classList.add('primary'); $('#expCancel').textContent = '取消'; $('#expCancel').style.display = ''; $('#expScope').style.display = images.length > 1 ? '' : 'none'; $('#expScope').parentElement.style.display = images.length > 1 ? '' : 'none'; modalExport.classList.add('on'); };
{ const f = $('#expFmt'); try { f.value = localStorage.getItem('rawedit:fmt') || 'jpeg'; } catch { } const sync = () => { $('#expQRow').style.display = f.value !== 'jpeg' ? 'none' : ''; try { localStorage.setItem('rawedit:fmt', f.value); } catch { } }; f.onchange = sync; sync(); }
$('#expCancel').onclick =() => { if (state.busy) state.cancelExport = true; else modalExport.classList.remove('on'); };
$('#expGo').onclick = async () => {
  if (state.busy) { state.cancelExport = true; $('#expGo').disabled = true; $('#expGo').textContent = '正在取消…'; return; }
  state.busy = true; state.cancelExport = false; $('#expGo').textContent = '取消匯出'; $('#expGo').classList.remove('primary'); $('#expCancel').style.display = 'none';
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
      const outName = im.name.replace(/\.[^.]+$/, '') + (format === 'tiff' ? '_edit.tif' : format === 'png' ? '_edit.png' : '_edit.jpg');
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
      if (navigator.canShare({ files: [f] })) toast('已匯出，可存到相簿', 5000, { kind: 'ok', action: { label: '分享', fn: () => navigator.share({ files: [f] }).catch(() => { }) } });
      else toast('已匯出，點「下載檔案」儲存', 3000, { kind: 'ok' });
    } else if (results.length) {
      $('#expMsg').textContent = `完成 ${results.length} 張，共 ${(results.reduce((a, r) => a + r.size, 0) / 1048576).toFixed(1)} MB`;
      const kept = results.filter(r => r.blob);
      if (kept.length) {
        const files = kept.map(r => new File([r.blob], r.name, { type: r.blob.type || 'image/jpeg' })); const row = el('div', { class: 'toolbar' });
        if (navigator.canShare({ files })) row.append(el('button', { class: 'primary', onclick: async () => { try { await navigator.share({ files }); } catch (e) { } } }, `分享 / 儲存 ${files.length} 張到相簿`));
        row.append(el('button', { onclick: () => kept.forEach((r, i) => setTimeout(() => download(r.blob, r.name), i * 400)) }, '全部下載'));
        $('#expMsg').append(row);
        if (kept.length < results.length) $('#expMsg').append(el('div', { class: 'hint' }, `另外 ${results.length - kept.length} 張已直接下載（避免占用太多記憶體）。`));
        if (navigator.canShare({ files })) toast(`已匯出 ${results.length} 張`, 5000, { kind: 'ok', action: { label: '分享', fn: () => navigator.share({ files }).catch(() => { }) } });
      } else toast(results.length > 1 ? `已匯出 ${results.length} 張到「下載」` : '已匯出到「下載」');
    }
    else if (state.cancelExport) $('#expMsg').textContent = '已取消';
  } catch (e) { console.error(e); $('#expMsg').textContent = '匯出失敗：' + friendlyError(e); }
  finally { state.busy = false; $('#expGo').disabled = false; $('#expGo').textContent = '再次匯出'; $('#expGo').classList.add('primary'); $('#expCancel').textContent = '關閉'; $('#expCancel').style.display = ''; $('#expBar').style.width = '100%'; if (CUR() && state.previewData && state.previewData.imId === CUR().id) { /* preview source restored by renderer */ } requestRender(false); }
};
async function exportImage(im, o, prog) {
  let params = im.params; const Gfull0 = geometry(params.geo, im.fullW || 1, im.fullH || 1);
  const longEdge = Math.max(Gfull0.outW, Gfull0.outH);
  let target = o.sizeSel === 'full' ? Infinity : o.sizeSel === 'preview' ? longEdge / 2 : +o.sizeSel;
  // choose decode scale: half-size is a true box downsample, good when the target is at most half of the full output
  let src;
  if (target <= longEdge / 2 && state.previewData && state.previewData.imId === im.id) { src = state.previewData; }
  else if (target <= longEdge / 2) { prog('解碼（半尺寸）…', 0.02); const r = await decodeFile(im.file, { half: true }, m => prog(m, 0.05)); src = { data: r.data, w: r.width, h: r.height, scale: r.scale || 2 }; }
  else { prog('全解析度解碼，請稍候…', 0.02); const q = o.demosaic === 'auto' ? undefined : +o.demosaic; const r = await decodeFile(im.file, { half: false, quality: q }, m => prog(m, 0.05)); src = { data: r.data, w: r.width, h: r.height, scale: 1 }; }
  if (state.cancelExport) return null;
  if (needsCamLook(im)) { prog('比對相機 JPEG 的色調…', 0.06); const vals = await fitCameraLook(im, src); if (vals) applyCameraLook(im, vals); params = im.params; }
  if ((params.spots || []).length) { const data = src === state.previewData ? new Uint16Array(src.data) : src.data; applySpotsToBuffer(data, src.w, src.h, src.scale, params.spots, im); src = Object.assign({}, src, { data }); }
  const fullW = src.w * src.scale, fullH = src.h * src.scale;
  const G = geometry(params.geo, fullW, fullH);
  let outW = G.outW, outH = G.outH, m = G.m;
  if (isFinite(target) && Math.max(outW, outH) > target) { const s = Math.max(outW, outH) / target; outW = Math.round(outW / s); outH = Math.round(outH / s); m = [m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s, m[6], m[7], m[8]]; }
  const meta = im.meta || {}; const dt = meta.timestamp ? new Date(meta.timestamp * 1000) : new Date();
  const pad = n => String(n).padStart(2, '0'); const dts = `${dt.getFullYear()}:${pad(dt.getMonth() + 1)}:${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  const exif = o.wantExif ? { make: meta.make, model: meta.model, software: 'RAW Editor (LibRaw)', dateTime: dts, exposure: meta.shutter, fnumber: meta.aperture, iso: meta.iso, focal: meta.focal, lens: meta.lens } : null;
  const tiff = o.format === 'tiff', png = o.format === 'png';
  const enc = png ? new PngEncoder(outW, outH) : tiff ? new TiffEncoder(outW, outH, exif) : new JpegEncoder(outW, outH, o.quality, exif);
  const U = uniformsFromParams(params, im, { export: true });
  if (U.useBrush) syncBrush(im, im === CUR() ? null : src); // smart masks of other photos are computed from this export's source
  // make sure the LUT matches this image
  renderer.setCurveLUT(curveLUTFor(params));
  try {
    await renderer.renderExport(U, { outW, outH, m }, src, (rows, n) => enc.addRows(rows, n), prog, () => state.cancelExport, tiff || png ? 16 : 8);
  } finally { if (CUR()) { renderer.setCurveLUT(curveLUTFor(CUR().params)); syncBrush(CUR()); } } // restore LUT and brush texture for the current image
  if (state.cancelExport) return null;
  prog(tiff ? '寫入 TIFF…' : png ? '寫入 PNG…' : '寫入 JPEG…', 0.98);
  if (tiff || png) return enc.finish();
  return new Blob([enc.finish()], { type: 'image/jpeg' });
}

// ---------- boot ----------
window.__dbg = { fitCameraLook, lookStats, LOOK_KEYS, needsCamLook, clearCameraLook, hslBandW, startingParams, activeMask, smartAlpha, upgradeSubjectMask, AI, syncBrush, solveUpright, findVP, computeUpright, autoStraighten, detectSegments, uprightImage, levelAngle, horizonAngle, perspPx, mapPt, isoToCanvas, healUI, addSpotAt, detectDust, applySpotsToBuffer, refreshSpotSource, autoTone, profileParams, PROFILES, displayedColorAt, pickColorAt, curveLUTFor, calibMatrix, wbFromRGB, autoWB, histLabel, pasteSettings, COPY_GROUPS, FILM_LUTS: typeof FILM_LUTS !== "undefined" ? FILM_LUTS : null, decodeFilmLUT, loadFilmLUTs, images, state, clone, defaultsFor, applyPreset, CurveEditor, schedulePresetThumbs, get renderer() { return renderer; }, get cur() { return CUR(); }, selectTab, setParam, commit, geometry, requestRender, exportImage, applyPresetUI, PRESETS, selectImage, undo, redo, refreshAll, updateHistogram, curveEd, decodeFile, addMask, activeMask, selectMask, strokeStart, strokeMove, isoToCanvas, canvasToIso, maskDrag, BR, uniformsFromParams, buildLensTable, get view() { return view; } };
buildPanels(); initDesignUI(); fitCanvas();
if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
(async () => {
  try {
    await decoder.init(); const v = decoder.version, n = decoder.cameras; decoder.terminate();
    $('#caps').textContent = `LibRaw ${v} · 支援 ${n} 款相機 · WebGL2 ✓ · 最大材質 ${renderer.maxTex}px` + (IS_TOUCH ? ' · 觸控模式' : '');
    $('#about').innerHTML = `RAW Editor — 單一 HTML 檔、純瀏覽器運作，不上傳任何資料。<br>解碼：LibRaw ${v}（LGPL 2.1 / CDDL 1.0），WebAssembly 建置來自 @colorhythm/libraw-wasm（MIT）。<br>調色：WebGL2，OkLab 色彩空間。匯出：內建串流 JPEG 編碼器（4:4:4）。<br>膠片模擬 LUT：改編自 RawTherapee Film Simulation Collection（Pat David、Pavlov Dmitry、Michael Ezra，CC BY-SA 4.0）、t3mujinpack（MIT）、FilmSim（CC0），詳見 FILM_LUTS.md。<br>快捷鍵：Ctrl+Z 復原、Ctrl+Shift+Z 重做、空白鍵/\\ 比較原圖、← → 切換照片、0 符合視窗、滑桿連點兩下重設、Shift 拖曳微調。`;
  } catch (e) { $('#caps').textContent = '解碼器初始化失敗：' + e.message; console.error(e); }
})();
