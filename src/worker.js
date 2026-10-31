// RAW decode worker. The LibRaw Emscripten glue (__LIBRAW_GLUE__) is prepended by build.js.
// Protocol (main -> worker):  {id, cmd:'init', wasm:ArrayBuffer}
//                             {id, cmd:'decode', buffer:ArrayBuffer, name, opts:{half, quality, wantThumb}}
//           (worker -> main): {id, ok:true, ...result} | {id, ok:false, error} | {id, progress:string}
let M = null;
const post = (m, t) => self.postMessage(m, t || []);
const cstr = p => { let s = ''; const h = M.HEAPU8; for (let i = p; h[i]; i++) s += String.fromCharCode(h[i]); return s; };
const err = c => cstr(M._libraw_strerror(c));
const chk = (c, what) => { if (c) throw new Error(what + ': ' + err(c) + ' (' + c + ')'); };
const f32 = (p, n) => Array.from(new Float32Array(M.HEAPU8.buffer, p, n));

// libraw_iparams_t layout (LibRaw 0.22): guard[4] make[64] model[64] software[64] normalized_make[64] normalized_model[64] maker_index(u32) raw_count colors filters ...
function readIParams(lr) {
  const p = M._libraw_get_iparams(lr);
  const s = (o, n) => { let r = ''; const h = M.HEAPU8; for (let i = p + o; i < p + o + n && h[i]; i++) r += String.fromCharCode(h[i]); return r.trim(); };
  return { make: s(4, 64), model: s(68, 64), software: s(132, 64), nmake: s(196, 64), nmodel: s(260, 64) };
}
// libraw_imgother_t: float iso_speed, shutter, aperture, focal_len; time_t timestamp(8); unsigned shot_order; unsigned gpsdata[32]; libraw_gps_info_t parsed_gps; char desc[512]; char artist[64]; ...
function readOther(lr) {
  const p = M._libraw_get_imgother(lr);
  const v = new DataView(M.HEAPU8.buffer);
  const [iso, shutter, aperture, focal] = f32(p, 4);
  const ts = Number(v.getBigInt64(p + 16, true));
  return { iso, shutter, aperture, focal, timestamp: ts };
}
function readLens(lr) {
  const p = M._libraw_get_lensinfo(lr);
  // libraw_lensinfo_t: float MinFocal, MaxFocal, MaxAp4MinFocal, MaxAp4MaxFocal, EXIF_MaxAp; char LensMake[128], Lens[128], LensSerial[128], InternalLensSerial[128]; ushort FocalLengthIn35mmFormat; ...
  const h = M.HEAPU8; const s = (o, n) => { let r = ''; for (let i = p + o; i < p + o + n && h[i]; i++) r += String.fromCharCode(h[i]); return r.trim(); };
  return { lensMake: s(20, 128), lens: s(148, 128) };
}

// DNG 1.7 JPEG-XL (compression 52546) needs Adobe's DNG SDK, which this LibRaw build does not include.
// Detect it up front so the user gets an actionable message instead of a generic LibRaw error.
function isJxlDng(ab) {
  try {
    const f = tiffWalk(ab, 0, [0xfe, 0x103], 40); const comp = f[0x103] || [], sub = f[0xfe] || [];
    return comp.some(c => c.vals && c.vals[0] === 52546 && sub.some(s => s.ifd === c.ifd && s.vals && s.vals[0] === 0));
  } catch { return false; }
}
self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try {
    if (cmd === 'init') {
      const wasm = e.data.wasm;
      M = await Module({ instantiateWasm: (imports, cb) => {
        (wasm instanceof WebAssembly.Module ? WebAssembly.instantiate(wasm, imports).then(inst => cb(inst, wasm)) : WebAssembly.instantiate(wasm, imports).then(r => cb(r.instance, r.module)));
        return {};
      } });
      post({ id, ok: true, version: cstr(M._libraw_version()), cameras: M._libraw_cameraCount() });
      return;
    }
    if (cmd === 'decode') {
      if (!M) throw new Error('worker not initialised');
      let { buffer } = e.data; const { opts } = e.data;
      const t0 = performance.now();
      const out = { timings: {} };
      // Nikon lossless NEF: decode the Huffman strip in JS (much faster than LibRaw in wasm), hand LibRaw an uncompressed NEF
      if (isJxlDng(buffer)) throw new Error('JXL_DNG');
      const lensMD = readLensMeta(buffer);
      let input = buffer;
      if (!opts.thumbOnly && !opts.noFast) { const fast = nikonFastRepack(buffer); if (fast) { input = fast; out.fastPath = 'nikon-lossless'; out.timings.fastDecode = performance.now() - t0; } }
      const lr = M._libraw_init(0);
      const inLen = input.byteLength;
      const inPtr = M._malloc(inLen);
      if (!inPtr) throw new Error('記憶體不足，無法載入檔案');
      M.HEAPU8.set(new Uint8Array(input), inPtr); input = null;
      buffer = null; e.data.buffer = null; // the file now lives in the wasm heap; let the JS copy be collected (48 MP ProRAW is ~100 MB)
      try {
        chk(M._libraw_open_buffer(lr, inPtr, inLen), 'open');
        out.timings.open = performance.now() - t0;
        out.meta = Object.assign(readIParams(lr), readOther(lr), readLens(lr), {
          filters: M._libraw_get_filters(lr) >>> 0, colors: M._libraw_get_colors(lr), flip: M._libraw_get_flip(lr),
          rawWidth: M._libraw_get_raw_width(lr), rawHeight: M._libraw_get_raw_height(lr),
          width: M._libraw_get_iwidth(lr), height: M._libraw_get_iheight(lr),
          camMul: [0, 1, 2, 3].map(i => M._libraw_get_cam_mul(lr, i)), preMul: [0, 1, 2, 3].map(i => M._libraw_get_pre_mul(lr, i)),
          isFoveon: !!M._libraw_get_is_foveon(lr)
        });
        out.lensMD = lensMD;
        // Embedded preview JPEG (fast path for instant display)
        if (opts.wantThumb) {
          const t = performance.now();
          const r = M._libraw_unpack_thumb(lr);
          if (!r) {
            const ep = M._malloc(4);
            const tp = M._libraw_dcraw_make_mem_thumb(lr, ep);
            if (tp) {
              const v = new DataView(M.HEAPU8.buffer);
              const type = v.getUint32(tp, true), size = v.getUint32(tp + 12, true);
              if (type === 1) out.thumb = M.HEAPU8.slice(tp + 16, tp + 16 + size); // JPEG bytes
              M._libraw_dcraw_clear_mem(tp);
            }
            M._free(ep);
          }
          out.timings.thumb = performance.now() - t;
          if (opts.thumbOnly) { post({ id, ok: true, ...out }, out.thumb ? [out.thumb.buffer] : []); return; }
        }
        // Processing parameters: linear 16-bit, sRGB primaries, camera WB, no auto-brightness, no clipping beyond sensor max.
        const xtrans = out.meta.filters === 9;
        M._libraw_set_half_size(lr, opts.half ? 1 : 0);
        M._libraw_set_use_camera_wb(lr, 1);
        M._libraw_set_output_bps(lr, 16);
        M._libraw_set_output_color(lr, 1);
        M._libraw_set_no_auto_bright(lr, 1);
        M._libraw_set_gamma(lr, 0, 1); M._libraw_set_gamma(lr, 1, 1);
        M._libraw_set_highlight(lr, opts.highlight ?? 0);
        M._libraw_set_adjust_maximum_thr(lr, 0.75);
        let q = opts.quality ?? (xtrans ? 0 : 3);
        if (opts.half) q = xtrans ? 0 : 0; // half-size never demosaics
        M._libraw_set_demosaic(lr, q);
        if (opts.fbdd) M._libraw_set_fbdd_noiserd(lr, opts.fbdd);
        let t = performance.now();
        post({ id, progress: '解包感光元件資料…' });
        chk(M._libraw_unpack(lr), 'unpack');
        out.timings.unpack = performance.now() - t; t = performance.now();
        post({ id, progress: opts.half ? '產生預覽…' : '去馬賽克（全尺寸）…' });
        chk(M._libraw_dcraw_process(lr), 'process');
        out.timings.process = performance.now() - t; t = performance.now();
        // Read LibRaw's processed image (imgdata.image, ushort[4] per pixel; the first field of libraw_data_t) directly instead of
        // dcraw_make_mem_image: that call allocates another full-size copy (290 MB for a 48 MP ProRAW). With linear gamma,
        // 16-bit output and no auto-brightening its tone curve is the identity, so only the flip has to be reproduced here.
        // half_size only shrinks Bayer/X-Trans data; linear DNGs (Apple ProRAW etc.) come back full size and are box-downsampled 2x2.
        const iw = M._libraw_get_iwidth(lr), ih = M._libraw_get_iheight(lr), flip = M._libraw_get_flip(lr) & 7;
        const ip = new DataView(M.HEAPU8.buffer).getUint32(lr, true);
        if (!ip || !iw || !ih) throw new Error('no processed image');
        const w = (flip & 4) ? ih : iw, h = (flip & 4) ? iw : ih;
        const fw = (out.meta.flip & 4) ? out.meta.height : out.meta.width;
        const fullOut = opts.half && Math.abs(w - fw) <= 2;
        const down = fullOut && w >= 64 && h >= 64;
        const ow = down ? w >> 1 : w, oh = down ? h >> 1 : h;
        let data;
        if (opts.memImage) { // reference path (tests only)
          const ep = M._malloc(4); const img = M._libraw_dcraw_make_mem_image(lr, ep); const ec = new Int32Array(M.HEAPU8.buffer, ep, 1)[0]; M._free(ep);
          if (!img) chk(ec || -1, 'make_mem_image');
          const ds = new DataView(M.HEAPU8.buffer).getUint32(img + 12, true); data = new Uint16Array(ds / 2); data.set(new Uint16Array(M.HEAPU8.buffer, img + 16, ds / 2)); M._libraw_dcraw_clear_mem(img);
        } else {
          const src = new Uint16Array(M.HEAPU8.buffer, ip, iw * ih * 4);
          // output pixel (r, c) reads source pixel base + r*dr + c*dc (LibRaw flip_index: swap, then mirror rows/cols)
          const base = ((flip & 2) ? (ih - 1) * iw : 0) + ((flip & 1) ? iw - 1 : 0);
          const rowStep = (flip & 2) ? -iw : iw, colStep = (flip & 1) ? -1 : 1;
          const dr = ((flip & 4) ? colStep : rowStep) * 4, dc = ((flip & 4) ? rowStep : colStep) * 4;
          data = new Uint16Array(ow * oh * 3);
          if (down) {
            for (let y = 0, o = 0; y < oh; y++) {
              let s0 = base * 4 + 2 * y * dr;
              for (let x = 0; x < ow; x++, o += 3, s0 += 2 * dc) {
                const s1 = s0 + dc, s2 = s0 + dr, s3 = s2 + dc;
                data[o] = (src[s0] + src[s1] + src[s2] + src[s3] + 2) >> 2;
                data[o + 1] = (src[s0 + 1] + src[s1 + 1] + src[s2 + 1] + src[s3 + 1] + 2) >> 2;
                data[o + 2] = (src[s0 + 2] + src[s1 + 2] + src[s2 + 2] + src[s3 + 2] + 2) >> 2;
              }
            }
            out.linearDownsampled = true;
          } else {
            for (let y = 0, o = 0; y < oh; y++) {
              let si = base * 4 + y * dr;
              for (let x = 0; x < ow; x++, o += 3, si += dc) { data[o] = src[si]; data[o + 1] = src[si + 1]; data[o + 2] = src[si + 2]; }
            }
          }
        }
        out.timings.copy = performance.now() - t;
        out.width = opts.memImage ? w : ow; out.height = opts.memImage ? h : oh; out.data = data; out.scale = opts.half && !(fullOut && !down) ? 2 : 1;
        out.timings.total = performance.now() - t0;
        out.heapMB = M.HEAPU8.length / 1048576;
        const tr = [data.buffer]; if (out.thumb) tr.push(out.thumb.buffer);
        post({ id, ok: true, ...out }, tr);
      } finally {
        M._libraw_recycle(lr); M._libraw_close(lr); M._free(inPtr);
      }
      return;
    }
    throw new Error('unknown cmd ' + cmd);
  } catch (ex) {
    post({ id, ok: false, error: (ex && ex.message) || String(ex) });
  }
};
