// Parameter schema, defaults and built-in presets.
const DEFAULTS = ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0,
  hsl: { h: [0, 0, 0, 0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0, 0, 0, 0], l: [0, 0, 0, 0, 0, 0, 0, 0] },
  bw: false, bwmix: [0, 0, 0, 0, 0, 0, 0, 0],
  curves: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
  grade: { s: { h: 0, s: 0, l: 0 }, m: { h: 0, s: 0, l: 0 }, h: { h: 0, s: 0, l: 0 }, balance: 0 },
  clarity: 0, dehaze: 0, texture: 0, fade: 0, vignette: 0, vigMid: 50, vigFeather: 50, grain: 0, grainSize: 25,
  sharpen: 25, sharpenRadius: 1, nrLum: 0, nrColor: 15,
  geo: { rot: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' },
  // lens correction: auto = use the camera's embedded profile (Sony / Fujifilm / DNG); amounts in %
  lens: { auto: true, dist: 100, vig: 100, ca: true, manDist: 0, manVig: 0, caR: 0, caB: 0, defringe: 0 },
  // local adjustments: [{id, type:'linear'|'radial'|'brush', ...geometry, adj:{...}, invert, lumLo, lumHi, opacity}]
  masks: []
});
// defaults for one local-adjustment mask (slider paths 'M.xxx' resolve against the active mask)
const MASK_DEFAULTS = { invert: false, opacity: 100, lumLo: 0, lumHi: 100, feather: 50, angle: 0,
  adj: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temp: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0, texture: 0, sharpen: 0 } };
const HSL_NAMES = ['紅', '橙', '黃', '綠', '青', '藍', '紫', '洋紅'];
const HSL_COLORS = ['#ff4d4d', '#ff9a3c', '#ffe04d', '#5fd65f', '#3fd0d0', '#4d7cff', '#a35cff', '#ff5cc8'];

const PRESETS = [
  { name: '自然增強', en: 'Natural Boost', p: { contrast: 10, vibrance: 20, clarity: 10, shadows: 10, highlights: -10 } },
  { name: '人像柔和', en: 'Soft Portrait', p: { contrast: -8, highlights: -15, shadows: 15, vibrance: 10, saturation: -5, clarity: -8, fade: 10, hsl: { s: [0, -10, 0, 0, 0, 0, 0, 0], l: [0, 8, 0, 0, 0, 0, 0, 0] }, grade: { h: { h: 45, s: 6, l: 0 } } } },
  { name: '經典正片', en: 'Classic Chrome', p: { contrast: 15, saturation: -25, vibrance: 5, shadows: -5, highlights: -10, hsl: { s: [-10, 0, 0, 0, 0, -15, 0, 0], l: [0, 0, 0, 0, 0, -5, 0, 0] }, grade: { s: { h: 200, s: 8, l: 0 }, h: { h: 45, s: 5, l: 0 } }, curves: { rgb: [[0, 0], [0.25, 0.22], [0.75, 0.78], [1, 1]] } } },
  { name: '鮮豔風景', en: 'Vivid Landscape', p: { contrast: 15, vibrance: 35, saturation: 10, clarity: 20, dehaze: 15, hsl: { s: [0, 0, 0, 10, 10, 15, 0, 0], l: [0, 0, 0, -5, 0, -10, 0, 0] } } },
  { name: '電影青橙', en: 'Teal & Orange', p: { contrast: 10, saturation: -10, fade: 6, hsl: { s: [0, 15, 0, 0, 10, 10, 0, 0] }, grade: { s: { h: 200, s: 25, l: 0 }, h: { h: 40, s: 18, l: 0 } } } },
  { name: '霧面日系', en: 'Matte Airy', p: { exposure: 0.3, contrast: -15, blacks: 20, fade: 30, highlights: -20, saturation: -10, temp: 5, grain: 10, grade: { s: { h: 220, s: 6, l: 0 } } } },
  { name: '黑白經典', en: 'Mono Classic', p: { bw: true, contrast: 20, clarity: 15, grain: 15, bwmix: [10, 0, 10, 0, 0, -20, 0, 0] } },
  { name: '黑白高反差', en: 'Mono Punch', p: { bw: true, contrast: 45, blacks: -25, whites: 15, clarity: 30, grain: 25, bwmix: [30, 0, 0, 0, 0, -40, 0, 0] } },
  { name: '復古暖調', en: 'Vintage Warm', p: { temp: 15, tint: 5, contrast: -5, fade: 20, saturation: -15, vignette: -25, grain: 20, grade: { h: { h: 50, s: 15, l: 0 }, s: { h: 30, s: 10, l: 0 } } } },
  { name: '冷調藍夜', en: 'Cool Night', p: { temp: -15, exposure: -0.3, contrast: 15, shadows: 10, saturation: -5, vignette: -20, grade: { s: { h: 240, s: 15, l: 0 } } } },
  { name: '高對比街拍', en: 'Street Contrast', p: { contrast: 35, blacks: -20, clarity: 25, saturation: -20, vignette: -30, grain: 15, highlights: -15 } },
  { name: '淡雅負片', en: 'Soft Negative', p: { contrast: 20, saturation: -20, fade: 8, hsl: { h: [-5, 0, 0, 0, 0, 0, 0, 0], s: [5, 0, 0, -20, 0, 0, 0, 0], l: [0, 0, 0, -10, 0, -10, 0, 0] }, grade: { s: { h: 180, s: 10, l: 0 }, h: { h: 55, s: 10, l: 0 } }, curves: { rgb: [[0, 0.04], [0.5, 0.5], [1, 0.98]] } } },
  { name: '鮮明底片', en: 'Film Vivid', p: { contrast: 25, vibrance: 40, saturation: 20, blacks: -10, shadows: -5, hsl: { s: [15, 0, 0, 20, 0, 20, 0, 0] } } },
  { name: '清新綠意', en: 'Fresh Green', p: { exposure: 0.2, contrast: -5, vibrance: 15, temp: -5, highlights: -10, shadows: 10, hsl: { h: [0, 0, 10, 10, 0, 0, 0, 0], s: [0, 0, 0, -10, 0, 0, 0, 0], l: [0, 0, 0, 10, 0, 0, 0, 0] } } },
  { name: '柔焦夢幻', en: 'Dreamy', p: { clarity: -30, contrast: -10, highlights: -15, shadows: 15, saturation: 5, temp: 5, fade: 15, vignette: -10 } },
  { name: 'HDR 細節', en: 'HDR Detail', p: { highlights: -60, shadows: 60, whites: 10, blacks: -10, clarity: 35, dehaze: 10, vibrance: 15 } },
];

const clone = o => JSON.parse(JSON.stringify(o));
function defaultParams() { return clone(DEFAULTS); }

// Merge a (partial) preset into params with an amount 0..2 (1 = as designed). Geometry is never touched by presets.
function applyPreset(base, preset, amount = 1) {
  const p = clone(base); const d = DEFAULTS;
  const lerp = (a, b) => a + (b - a) * amount;
  for (const k of ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'clarity', 'dehaze', 'texture', 'fade', 'vignette', 'grain', 'sharpen', 'nrLum', 'nrColor'])
    if (k in preset) p[k] = lerp(d[k], preset[k]);
  for (const k of ['vigMid', 'vigFeather', 'grainSize', 'sharpenRadius']) if (k in preset) p[k] = preset[k];
  if ('bw' in preset) p.bw = preset.bw;
  if (preset.bwmix) p.bwmix = preset.bwmix.map((v, i) => lerp(0, v));
  if (preset.hsl) for (const c of ['h', 's', 'l']) if (preset.hsl[c]) p.hsl[c] = preset.hsl[c].map(v => lerp(0, v));
  if (preset.grade) { for (const r of ['s', 'm', 'h']) if (preset.grade[r]) p.grade[r] = { h: preset.grade[r].h || 0, s: lerp(0, preset.grade[r].s || 0), l: lerp(0, preset.grade[r].l || 0) }; if ('balance' in preset.grade) p.grade.balance = lerp(0, preset.grade.balance); }
  if (preset.curves) for (const c of ['rgb', 'r', 'g', 'b']) if (preset.curves[c]) {
    if (amount === 1) p.curves[c] = clone(preset.curves[c]);
    else { const L = curveLUT(preset.curves[c], 17); p.curves[c] = Array.from({ length: 17 }, (_, i) => [i / 16, Math.min(1, Math.max(0, lerp(i / 16, L[i])))]); }
  }
  return p;
}
// Extract the non-geometry, non-default parts of params as a preset body
function paramsToPreset(p) {
  const out = {}; const d = DEFAULTS;
  for (const k of Object.keys(d)) {
    if (k === 'geo' || k === 'masks' || k === 'lens') continue;
    if (JSON.stringify(p[k]) !== JSON.stringify(d[k])) out[k] = clone(p[k]);
  }
  return out;
}
