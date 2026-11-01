// WebGL2 renderer for the develop pipeline.
// JS mirror of the shader's lens lookup (32 knots over radius 0..1.3, vec4 per knot).
function lensAtJS(T, rho) {
  const x = Math.min(1, Math.max(0, rho / 1.3)) * 31; const i = Math.min(Math.floor(x), 30), f = x - i;
  const o = []; for (let k = 0; k < 4; k++) o.push(T[i * 4 + k] * (1 - f) + T[(i + 1) * 4 + k] * f); return o;
}
// Source positions (green, red, blue) for a lens-corrected full-image point.
function lensSourcePts(T, x, y, W, H) {
  const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy); const qx = x - cx, qy = y - cy;
  const L = lensAtJS(T, Math.hypot(qx, qy) / R);
  return [[cx + qx * L[0], cy + qy * L[0]], [cx + qx * L[0] * L[2], cy + qy * L[0] * L[2]], [cx + qx * L[0] * L[3], cy + qy * L[0] * L[3]]];
}
class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('此瀏覽器不支援 WebGL2');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxRB = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.progLum = this._prog(VS_QUAD, FS_LUM);
    this.progBlur = this._prog(VS_QUAD, FS_BLUR);
    this.progMain = this._prog(VS_QUAD, FS_MAIN);
    this.progDisp = this._prog(VS_QUAD, FS_DISPLAY);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    this.curveTex = this._tex2D(gl.RGBA16F, 256, 1, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.emptyBrush = this._tex2D(gl.RGBA8, 1, 1, gl.NEAREST, gl.CLAMP_TO_EDGE);
    // film emulation LUTs (3D textures, keyed by id); a 1x1x1 placeholder keeps the sampler complete when none is used
    this.luts = new Map();
    this.emptyLut = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, this.emptyLut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); gl.bindTexture(gl.TEXTURE_3D, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.brush = null;      // {tex,w,h}
    this.src = null;        // {tex,w,h,scale}
    this.blur = null;       // {tex,w,h}
    this.result = null;     // {tex,fb,w,h}
    this.resultBefore = null;
    this.tmpFB = gl.createFramebuffer();
    this.seed = Math.random() * 100;
  }
  _sh(type, src) {
    const gl = this.gl; const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  _prog(vs, fs) {
    const gl = this.gl; const p = gl.createProgram();
    gl.attachShader(p, this._sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, this._sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  _tex2D(ifmt, w, h, filter, wrap) {
    const gl = this.gl; const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  }
  _fbTex(w, h, mip) {
    const gl = this.gl; const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER); if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete ' + st);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h, mip };
  }
  _del(o) { if (!o) return; const gl = this.gl; if (o.tex) gl.deleteTexture(o.tex); if (o.fb) gl.deleteFramebuffer(o.fb); }

  // Upload a 16-bit RGB source (Uint16Array, w*h*3). scale = full-image pixels per source pixel.
  setSource(data, w, h, scale, fullW, fullH) {
    const gl = this.gl;
    this._del(this.src); this._del(this.blur); this.src = null; this.blur = null;
    // downscale by 2 in JS if the device cannot hold the texture
    while (w > this.maxTex || h > this.maxTex) {
      const nw = w >> 1, nh = h >> 1, nd = new Uint16Array(nw * nh * 3);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const a = ((2 * y) * w + 2 * x) * 3, b = a + 3, c2 = a + w * 3, d = c2 + 3, o = (y * nw + x) * 3;
        nd[o] = (data[a] + data[b] + data[c2] + data[d]) >> 2; nd[o + 1] = (data[a + 1] + data[b + 1] + data[c2 + 1] + data[d + 1]) >> 2; nd[o + 2] = (data[a + 2] + data[b + 2] + data[c2 + 2] + data[d + 2]) >> 2;
      }
      data = nd; w = nw; h = nh; scale *= 2;
    }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB16UI, w, h);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.src = { tex, w, h, scale, fullW: fullW || w * scale, fullH: fullH || h * scale, originX: 0, originY: 0 };
    this.buildBlur(this.src);
    return this.src;
  }
  // Build the blurred luminance texture (used for clarity) from a source texture.
  buildBlur(src) {
    const gl = this.gl;
    this._del(this.blur); if (this.blurB) { this._del(this.blurB); }
    const bw = Math.max(32, Math.round(src.w / 4)), bh = Math.max(32, Math.round(src.h / 4));
    const A = this._fbTex(bw, bh, false), B = this._fbTex(bw, bh, false);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.progLum.p); gl.uniformMatrix3fv(this.progLum.u.u_view, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(this.progLum.u.u_src, 0); gl.uniform2f(this.progLum.u.u_srcSize, src.w, src.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb); gl.viewport(0, 0, bw, bh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // blur radius relative to image size: ~1.2% of the long edge, done in several passes
    gl.useProgram(this.progBlur.p); gl.uniformMatrix3fv(this.progBlur.u.u_view, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]); gl.uniform1i(this.progBlur.u.u_tex, 0);
    const passes = Math.max(1, Math.round(Math.max(bw, bh) * 0.012 / 4));
    let from = A, to = B;
    for (let i = 0; i < passes; i++) {
      gl.bindTexture(gl.TEXTURE_2D, from.tex); gl.uniform2f(this.progBlur.u.u_dir, 1 / bw, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindTexture(gl.TEXTURE_2D, to.tex); gl.uniform2f(this.progBlur.u.u_dir, 0, 1 / bh); gl.bindFramebuffer(gl.FRAMEBUFFER, from.fb); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.blur = from; this.blurB = to;
  }
  // rgb: Uint8Array size^3*3, red fastest (index = (b*size + g)*size + r)
  setFilmLUT(id, size, rgb) {
    const gl = this.gl; if (this.luts.has(id)) return;
    const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_3D, null); gl.activeTexture(gl.TEXTURE0);
    this.luts.set(id, { tex, size });
  }
  setCurveLUT(lut /* Float32Array 256*4, 0..1 */) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.curveTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const f = lut instanceof Float32Array ? lut : Float32Array.from(lut, v => v / 255);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.FLOAT, f);
  }
  // Brush masks: RGBA8 texture, one mask per channel, covering the whole (lens-corrected) image.
  setBrushSize(w, h) {
    const gl = this.gl;
    if (this.brush && this.brush.w === w && this.brush.h === h) return;
    if (this.brush) gl.deleteTexture(this.brush.tex); this.brush = null;
    if (!w || !h) return;
    const tex = this._tex2D(gl.RGBA8, w, h, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.brush = { tex, w, h };
  }
  // Upload a rectangle of the full RGBA brush buffer (buf is w*h*4 of the whole texture).
  updateBrush(buf, x, y, rw, rh) {
    const gl = this.gl, B = this.brush; if (!B) return;
    x = Math.max(0, x | 0); y = Math.max(0, y | 0); rw = Math.min(B.w - x, Math.ceil(rw)); rh = Math.min(B.h - y, Math.ceil(rh)); if (rw <= 0 || rh <= 0) return;
    gl.bindTexture(gl.TEXTURE_2D, B.tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, B.w); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }
  // Set all develop uniforms from a prepared uniform object U (see app.js uniformsFromParams)
  _setMainUniforms(U, src, outW, outH, m) {
    const gl = this.gl, u = this.progMain.u;
    gl.useProgram(this.progMain.p);
    gl.uniformMatrix3fv(u.u_view, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(u.u_src, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.blur.tex); gl.uniform1i(u.u_blur, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.curveTex); gl.uniform1i(u.u_curve, 2);
    gl.uniform2f(u.u_srcSize, src.w, src.h); gl.uniform2f(u.u_srcOrigin, src.originX, src.originY); gl.uniform1i(u.u_srcScale, src.scale);
    gl.uniform2f(u.u_fullSize, src.fullW, src.fullH);
    gl.uniform2f(u.u_outSize, outW, outH); gl.uniformMatrix3fv(u.u_m, false, m);
    gl.uniform1f(u.u_exposure, U.exposure); gl.uniform3fv(u.u_wb, U.wb);
    gl.uniform1f(u.u_contrast, U.contrast); gl.uniform1f(u.u_highlights, U.highlights); gl.uniform1f(u.u_shadows, U.shadows); gl.uniform1f(u.u_whites, U.whites); gl.uniform1f(u.u_blacks, U.blacks);
    gl.uniform1f(u.u_vibrance, U.vibrance); gl.uniform1f(u.u_saturation, U.saturation);
    gl.uniform3fv(u.u_hsl, U.hsl); gl.uniform1f(u.u_bw, U.bw); gl.uniform1fv(u.u_bwmix, U.bwmix);
    gl.uniform3fv(u.u_gradeS, U.gradeS); gl.uniform3fv(u.u_gradeM, U.gradeM); gl.uniform3fv(u.u_gradeH, U.gradeH); gl.uniform1f(u.u_gradeBalance, U.gradeBalance);
    gl.uniform1f(u.u_clarity, U.clarity); gl.uniform1f(u.u_dehaze, U.dehaze); gl.uniform1f(u.u_texture, U.texture);
    gl.uniform2fv(u.u_sharpen, U.sharpen); gl.uniform2fv(u.u_nr, U.nr); gl.uniform3fv(u.u_vignette, U.vignette); gl.uniform2fv(u.u_grain, U.grain);
    gl.uniform1f(u.u_fade, U.fade); gl.uniform1f(u.u_seed, this.seed);
    gl.uniformMatrix3fv(u.u_calib, false, U.calib || [1, 0, 0, 0, 1, 0, 0, 0, 1]); gl.uniform1f(u.u_shadowTint, U.shadowTint || 0);
    gl.uniform3fv(u.u_gradeG, U.gradeG || [0, 0, 0]); gl.uniform1f(u.u_gradeBlend, U.gradeBlend ?? 0.5);
    gl.uniform2fv(u.u_vig2, U.vig2 || [0, 0]); gl.uniform1f(u.u_grainRough, U.grainRough ?? 0.5); gl.uniform1f(u.u_sharpMask, U.sharpMask || 0);
    gl.uniform1i(u.u_clipWarn, U.clipWarn ? 1 : 0); gl.uniform1i(u.u_baseTone, U.baseTone ? 1 : 0);
    gl.uniform1i(u.u_nPC, U.nPC || 0); if (U.nPC) { gl.uniform4fv(u.u_pcA, U.pcA); gl.uniform4fv(u.u_pcB, U.pcB); }
    // lens correction
    gl.uniform1i(u.u_lensOn, U.lensOn ? 1 : 0); if (U.lensOn) gl.uniform4fv(u.u_lens, U.lens); gl.uniform1f(u.u_defringe, U.defringe || 0);
    // local adjustments
    const n = U.nMasks || 0; gl.uniform1i(u.u_nMasks, n);
    gl.uniform1i(u.u_anyCR, U.anyCR ? 1 : 0); if (n) { gl.uniform4fv(u.u_mE, U.mE); gl.uniform4fv(u.u_mF, U.mF); }
    if (n) { gl.uniform4fv(u.u_mG1, U.mG1); gl.uniform4fv(u.u_mG2, U.mG2); gl.uniform4fv(u.u_mA, U.mA); gl.uniform4fv(u.u_mB, U.mB); gl.uniform4fv(u.u_mC, U.mC); gl.uniform4fv(u.u_mD, U.mD); }
    gl.uniform1i(u.u_showMask, U.showMask ?? -1); gl.uniform1i(u.u_maskDetail, U.maskDetail ? 1 : 0); gl.uniform1i(u.u_outMode, 0);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, (U.useBrush && this.brush) ? this.brush.tex : this.emptyBrush); gl.uniform1i(u.u_brush, 3);
    { const L = U.lutId ? this.luts.get(U.lutId) : null; gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, L ? L.tex : this.emptyLut); gl.uniform1i(u.u_lut, 4);
      gl.uniform1f(u.u_lutAmt, L ? Math.max(0, Math.min(1, U.lutAmt)) : 0); gl.uniform1f(u.u_lutN, L ? L.size : 2); }
    gl.activeTexture(gl.TEXTURE0);
  }
  // Render the developed image (geometry G: {outW,outH,m}) into a result texture. quality<1 renders smaller.
  renderResult(U, G, quality = 1, into = 'result') {
    const gl = this.gl; const src = this.src; if (!src) return null;
    let w = Math.max(1, Math.round(G.outW * quality)), h = Math.max(1, Math.round(G.outH * quality));
    const cap = Math.min(this.maxTex, this.maxRB, 8192);
    if (w > cap || h > cap) { const s = cap / Math.max(w, h); w = Math.floor(w * s); h = Math.floor(h * s); }
    let R = this[into];
    if (!R || R.w !== w || R.h !== h) { this._del(R); R = this[into] = this._fbTex(w, h, true); }
    // m maps out px -> full-image px; adjust for the render scale
    const s = G.outW / w; const m = G.m.slice(); // column-major mat3
    const ms = [m[0] * s, m[1] * s, m[2], m[3] * s, m[4] * s, m[5], m[6], m[7], m[8]];
    gl.bindVertexArray(this.vao);
    this._setMainUniforms(U, src, w, h, ms);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fb); gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, R.tex); gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return R;
  }
  // Draw result (and optional before texture) to the canvas with a view transform (clip-space mat3)
  draw(view, mode = 0, split = 0.5) {
    const gl = this.gl; const R = this.result; if (!R) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.09, 0.09, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao); gl.useProgram(this.progDisp.p);
    gl.uniformMatrix3fv(this.progDisp.u.u_view, false, view);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.tex); gl.uniform1i(this.progDisp.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (this.resultBefore || R).tex); gl.uniform1i(this.progDisp.u.u_tex2, 1);
    gl.uniform1i(this.progDisp.u.u_mode, this.resultBefore ? mode : 0); gl.uniform1f(this.progDisp.u.u_split, split);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // Read back a small render for the histogram: returns Uint8Array RGBA
  readSmall(U, G, maxW = 320, into = 'hist') {
    const gl = this.gl; const q = Math.min(1, maxW / G.outW);
    const R = this.renderResult(U, G, q, into);
    const px = new Uint8Array(R.w * R.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fb); gl.readPixels(0, 0, R.w, R.h, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { px, w: R.w, h: R.h };
  }
  // Export: render output geometry G (outW,outH,m in full-image px) from a 16-bit source {data,w,h,scale}
  // in horizontal strips; onRows(rgba, rows) receives each strip (top to bottom) for the streaming JPEG encoder.
  // bits = 8: onRows(Uint8Array RGBA, rows); bits = 16: onRows(Uint16Array RGB, rows) — rendered as two RGBA8 passes (high/low byte).
  async renderExport(U, G, src, onRows, onProgress, isCancelled, bits = 8) {
    const gl = this.gl;
    const prev = { src: this.src, blur: this.blur, blurB: this.blurB };
    const fullW = src.w * src.scale, fullH = src.h * src.scale;
    // blurred luminance from a downsampled copy of the source (<= 2048 px)
    const ds = Math.max(1, Math.ceil(Math.max(src.w, src.h) / 2048));
    const dw = Math.floor(src.w / ds), dh = Math.floor(src.h / ds);
    const small = new Uint16Array(dw * dh * 3); const D = src.data, W = src.w;
    for (let y = 0; y < dh; y++) { const sy = y * ds; for (let x = 0; x < dw; x++) { const o = (sy * W + x * ds) * 3, o2 = (y * dw + x) * 3; small[o2] = D[o]; small[o2 + 1] = D[o + 1]; small[o2 + 2] = D[o + 2]; } }
    const smallTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, smallTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB16UI, dw, dh); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, dw, dh, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, small);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.blur = null; this.blurB = null; this.buildBlur({ tex: smallTex, w: dw, h: dh }); gl.deleteTexture(smallTex);
    const T = Math.min(2048, this.maxTex, this.maxRB), SH = 64, MARGIN = 8;
    const cols = Math.ceil(G.outW / T), rows = Math.ceil(G.outH / SH);
    const out = this._fbTex(T, SH, false);
    const b16 = bits === 16;
    const strip = b16 ? new Uint16Array(G.outW * SH * 3) : new Uint8Array(G.outW * SH * 4), px = new Uint8Array(T * SH * 4), px2 = b16 ? new Uint8Array(T * SH * 4) : null;
    const lensMargin = U.lensOn ? 4 : 0;
    let tileTex = null, tw = 0, th = 0; const m = G.m;
    try {
      for (let r = 0; r < rows; r++) {
        if (isCancelled && isCancelled()) break;
        const oy = r * SH, oh = Math.min(SH, G.outH - oy);
        for (let c = 0; c < cols; c++) {
          const ox = c * T, ow = Math.min(T, G.outW - ox);
          // sample the tile border (several points per edge, since lens distortion bends straight edges)
          const border = []; const K = U.lensOn ? 8 : 1;
          for (let i = 0; i <= K; i++) { const t = i / K; border.push([ox + ow * t, oy], [ox + ow * t, oy + oh], [ox, oy + oh * t], [ox + ow, oy + oh * t]); }
          let pts = border.map(([x, y]) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]);
          if (U.lensOn) pts = pts.flatMap(p => lensSourcePts(U.lens, p[0], p[1], fullW, fullH));
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); const MG = MARGIN + lensMargin;
          let sx0 = Math.floor(Math.min(...xs) / src.scale) - MG, sy0 = Math.floor(Math.min(...ys) / src.scale) - MG;
          let sx1 = Math.ceil(Math.max(...xs) / src.scale) + MG, sy1 = Math.ceil(Math.max(...ys) / src.scale) + MG;
          sx0 = Math.max(0, sx0); sy0 = Math.max(0, sy0); sx1 = Math.min(src.w, sx1); sy1 = Math.min(src.h, sy1);
          const sw = Math.max(1, sx1 - sx0), sh = Math.max(1, sy1 - sy0);
          if (!tileTex || sw > tw || sh > th) {
            if (tileTex) gl.deleteTexture(tileTex); tileTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tileTex);
            tw = Math.max(tw, sw, 64); th = Math.max(th, sh, 64); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB16UI, tw, th);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          }
          const region = new Uint16Array(sw * sh * 3);
          for (let y = 0; y < sh; y++) region.set(D.subarray(((sy0 + y) * W + sx0) * 3, ((sy0 + y) * W + sx0 + sw) * 3), y * sw * 3);
          gl.bindTexture(gl.TEXTURE_2D, tileTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sw, sh, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, region);
          // the shader clamps fetches to u_srcSize; pass the region size (texture may be larger)
          const s = { tex: tileTex, w: sw, h: sh, scale: src.scale, fullW, fullH, originX: sx0 * src.scale, originY: sy0 * src.scale };
          const mt = [m[0], m[1], 0, m[3], m[4], 0, m[0] * ox + m[3] * oy + m[6], m[1] * ox + m[4] * oy + m[7], 1];
          gl.bindVertexArray(this.vao); this._setMainUniforms(U, s, ow, oh, mt);
          gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb); gl.viewport(0, 0, ow, oh);
          if (!b16) {
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, px);
            for (let y = 0; y < oh; y++) strip.set(px.subarray(y * ow * 4, (y + 1) * ow * 4), (y * G.outW + ox) * 4);
          } else {
            const uo = this.progMain.u.u_outMode;
            gl.uniform1i(uo, 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, px);
            gl.uniform1i(uo, 2); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, px2);
            for (let y = 0; y < oh; y++) { let s = y * ow * 4, d = (y * G.outW + ox) * 3; for (let x = 0; x < ow; x++, s += 4, d += 3) { strip[d] = (px[s] << 8) | px2[s]; strip[d + 1] = (px[s + 1] << 8) | px2[s + 1]; strip[d + 2] = (px[s + 2] << 8) | px2[s + 2]; } }
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        await onRows(strip.subarray(0, oh * G.outW * (b16 ? 3 : 4)), oh);
        if (onProgress) onProgress('輸出中 ' + Math.round((r + 1) / rows * 100) + '%', 0.1 + 0.85 * (r + 1) / rows);
        if ((r & 3) === 3) await new Promise(res => setTimeout(res));
      }
    } finally {
      this._del(out); if (tileTex) gl.deleteTexture(tileTex);
      this._del(this.blur); this._del(this.blurB);
      this.src = prev.src; this.blur = prev.blur; this.blurB = prev.blurB;
    }
  }
}

