// Tone curve: monotone cubic interpolation + a small touch-friendly editor.
function curveLUT(points, n = 256) {
  // points: [[x,y],...] in 0..1, sorted by x. Fritsch–Carlson monotone cubic.
  const P = points.slice().sort((a, b) => a[0] - b[0]);
  if (P.length < 2) return Float32Array.from({ length: n }, (_, i) => i / (n - 1));
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]), k = P.length;
  const d = [], m = [];
  for (let i = 0; i < k - 1; i++) { const dx = Math.max(xs[i + 1] - xs[i], 1e-6); d.push((ys[i + 1] - ys[i]) / dx); }
  m[0] = d[0]; m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= xs[0]) { out[j] = ys[0]; continue; }
    if (x >= xs[k - 1]) { out[j] = ys[k - 1]; continue; }
    let i = 0; while (i < k - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    out[j] = Math.min(1, Math.max(0, y));
  }
  return out;
}

class CurveEditor {
  constructor(canvas, onChange) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.onChange = onChange;
    this.curves = { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };
    this.channel = 'rgb'; this.drag = null; this.hist = null;
    const pos = e => { const r = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))]; };
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault(); canvas.setPointerCapture(e.pointerId);
      const [x, y] = pos(e); const pts = this.curves[this.channel];
      let best = -1, bd = 0.06;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); best = pts.findIndex(p => p[0] === x && p[1] === y); }
      this.drag = { i: best, moved: false, t: Date.now() };
      this.draw(); this.onChange();
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.drag) return; const pts = this.curves[this.channel]; const [x, y] = pos(e); const i = this.drag.i;
      const lo = i > 0 ? pts[i - 1][0] + 0.01 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
      pts[i] = [i === 0 ? 0 : i === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, x)), y];
      this.drag.moved = true; this.draw(); this.onChange();
    });
    const up = e => {
      if (!this.drag) return; const pts = this.curves[this.channel];
      // tap on an existing interior point without moving: remove it (double-tap semantics for touch)
      if (!this.drag.moved && pts.length > 2 && this.drag.i > 0 && this.drag.i < pts.length - 1 && this.lastTap && Date.now() - this.lastTap < 350) { pts.splice(this.drag.i, 1); this.onChange(); }
      this.lastTap = Date.now(); this.drag = null; this.draw();
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  }
  setCurves(c) { this.curves = JSON.parse(JSON.stringify(c)); this.draw(); }
  reset(ch) { this.curves[ch || this.channel] = [[0, 0], [1, 1]]; this.draw(); this.onChange(); }
  lutRGBA() {
    // float LUT (uploaded as RGBA16F) so 16-bit export keeps full precision
    const o = new Float32Array(256 * 4);
    const L = ['rgb', 'r', 'g', 'b'].map(k => curveLUT(this.curves[k]));
    for (let i = 0; i < 256; i++) for (let c = 0; c < 4; c++) o[i * 4 + c] = L[c][i];
    return o;
  }
  draw() {
    const cv = this.cv, ctx = this.ctx, dpr = devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight; if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#1b1b1f'; ctx.fillRect(0, 0, W, H);
    if (this.hist) { // luminance histogram backdrop
      const h = this.hist, mx = Math.max(...h) || 1; ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath(); ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * W, H - Math.sqrt(h[i] / mx) * H * 0.9); ctx.lineTo(W, H); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < 4; i++) { ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, H); ctx.moveTo(0, i * H / 4); ctx.lineTo(W, i * H / 4); } ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.stroke();
    const col = { rgb: '#eee', r: '#ff6b6b', g: '#6bff8a', b: '#6ba8ff' };
    for (const k of ['r', 'g', 'b', 'rgb']) {
      if (k !== this.channel && JSON.stringify(this.curves[k]) === '[[0,0],[1,1]]') continue;
      const L = curveLUT(this.curves[k]); ctx.beginPath();
      for (let i = 0; i < 256; i++) { const x = i / 255 * W, y = H - L[i] * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = col[k]; ctx.globalAlpha = k === this.channel ? 1 : 0.4; ctx.lineWidth = k === this.channel ? 2 : 1.2; ctx.stroke(); ctx.globalAlpha = 1;
    }
    for (const p of this.curves[this.channel]) { ctx.beginPath(); ctx.arc(p[0] * W, H - p[1] * H, 6, 0, Math.PI * 2); ctx.fillStyle = col[this.channel]; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke(); }
  }
}
