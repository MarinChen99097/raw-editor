// GLSL ES 3.00 shaders for the develop pipeline.
const VS_QUAD = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;      // -1..1
uniform mat3 u_view;                    // clip-space transform (display pass only; identity otherwise)
out vec2 v_uv;
void main(){
  v_uv = a_pos*0.5+0.5;
  vec3 p = u_view*vec3(a_pos,1.0);
  gl_Position = vec4(p.xy,0.0,1.0);
}`;

// Shared colour helpers
const GLSL_COMMON = `
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float cbrt1(float x){ return x < 0.0 ? -pow(-x, 1.0/3.0) : pow(x, 1.0/3.0); }
vec3 lin2oklab(vec3 c){
  float l = 0.4122214708*c.r + 0.5363325363*c.g + 0.0514459929*c.b;
  float m = 0.2119034982*c.r + 0.6806995451*c.g + 0.1073969566*c.b;
  float s = 0.0883024619*c.r + 0.2817188376*c.g + 0.6299787005*c.b;
  l = cbrt1(l); m = cbrt1(m); s = cbrt1(s);
  return vec3(0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
              1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
              0.0259040371*l + 0.7827717662*m - 0.8086757660*s);
}
vec3 oklab2lin(vec3 c){
  float l_ = c.x + 0.3963377774*c.y + 0.2158037573*c.z;
  float m_ = c.x - 0.1055613458*c.y - 0.0638541728*c.z;
  float s_ = c.x - 0.0894841775*c.y - 1.2914855480*c.z;
  float l = l_*l_*l_, m = m_*m_*m_, s = s_*s_*s_;
  return vec3( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
              -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
              -0.0041960863*l - 0.7034186147*m + 1.7076147010*s);
}
float enc(float x){ return pow(max(x,0.0), 1.0/2.2); }   // perceptual encode
float dec(float x){ return pow(max(x,0.0), 2.2); }
vec3 srgbOETF(vec3 c){
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c*12.92, hi = 1.055*pow(c, vec3(1.0/2.4)) - 0.055;
  return mix(lo, hi, step(0.0031308, c));
}
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
`;

// Pass A: perceptual luminance of the (downsampled) source for the clarity blur.
const FS_LUM = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D u_src; uniform vec2 u_srcSize;
in vec2 v_uv; out vec4 o;
${GLSL_COMMON}
void main(){
  // box-average a few source texels per output texel for smoother downsampling
  vec2 p = v_uv*u_srcSize; ivec2 sz = ivec2(u_srcSize);
  vec3 acc = vec3(0.0);
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    ivec2 q = clamp(ivec2(p)+ivec2(i,j)*2, ivec2(0), sz-1);
    acc += vec3(texelFetch(u_src,q,0).rgb)/65535.0;
  }
  acc/=9.0;
  o = vec4(enc(dot(acc,LUMA)),0.0,0.0,1.0);
}`;

// Pass B: separable gaussian blur (RGBA8, R channel used).
const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform vec2 u_dir; // dir in texel units
in vec2 v_uv; out vec4 o;
void main(){
  float w[9]; w[0]=0.1964825502; w[1]=0.2969069646; w[2]=0.0944703979; w[3]=0.0103813624; w[4]=0.0;w[5]=0.0;w[6]=0.0;w[7]=0.0;w[8]=0.0;
  vec3 acc = texture(u_tex, v_uv).rgb*w[0];
  for(int i=1;i<4;i++){
    vec2 off = u_dir*float(i)*1.5;
    acc += texture(u_tex, v_uv+off).rgb*w[i];
    acc += texture(u_tex, v_uv-off).rgb*w[i];
  }
  o = vec4(acc,1.0);
}`;

// Pass C: the develop pipeline. Output pixel -> full-image pixel via u_m (mat3), then lens correction to the source.
const FS_MAIN = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D u_src;       // linear RGB16 (tile or whole preview)
uniform vec2  u_srcSize;        // size of u_src texture (texels)
uniform vec2  u_srcOrigin;      // origin of u_src within the full image (export tiles)
uniform vec2  u_fullSize;       // full image size in pixels
uniform sampler2D u_blur;       // blurred perceptual luminance of full image
uniform sampler2D u_curve;      // 256x1 RGBA16F: r=RGB curve, g/b/a = R/G/B curves
uniform sampler2D u_brush;      // brush masks, one per channel (normalised full-image coords)
uniform highp sampler3D u_lut;  // film emulation 3D LUT, display-referred sRGB in and out
uniform float u_lutAmt, u_lutN;  // strength 0..1, LUT size per axis
uniform mat3  u_calib;          // camera calibration: primaries hue/saturation in linear RGB (white preserving)
uniform float u_shadowTint;     // calibration shadow tint: -1 green .. +1 magenta
uniform vec3  u_gradeG;         // colour grading, global wheel (oklab dL, a, b)
uniform float u_gradeBlend;     // colour grading blending 0..1 (0.5 = default overlap)
uniform vec2  u_vig2;           // vignette roundness (-1..1), highlight priority (0..1)
uniform float u_grainRough;     // grain roughness 0..1
uniform float u_sharpMask;      // sharpening edge mask 0..1
uniform int   u_clipWarn;       // show clipped highlights (red) and shadows (blue)
uniform vec2  u_outSize;
uniform mat3  u_m;              // out pixel -> full-image pixel (lens-corrected space)
uniform float u_exposure;       // linear multiplier
uniform vec3  u_wb;
uniform float u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_vibrance, u_saturation;
uniform vec3  u_hsl[8];         // hue shift, sat, lum per band (-1..1)
uniform float u_bw; uniform float u_bwmix[8];
uniform vec3  u_gradeS, u_gradeM, u_gradeH; // oklab (dL, a, b) offsets
uniform float u_gradeBalance;
uniform float u_clarity, u_dehaze, u_texture;
uniform vec2  u_sharpen;        // amount, radius(px)
uniform vec2  u_nr;             // luminance, colour (0..1)
uniform vec3  u_vignette;       // amount, midpoint, feather
uniform vec2  u_grain;          // amount, size
uniform float u_fade;           // matte/fade blacks
uniform float u_seed;
uniform int   u_srcScale;       // 1 = source pixels equal full-image pixels; 2 = source is half of full
// lens correction: 32 knots over normalised radius 0..1.3 (half-diagonal = 1)
//   x = source/dest radius ratio (green, autoscale folded in), y = vignetting gain at that *source* radius,
//   z = red ratio relative to green, w = blue ratio relative to green
uniform int   u_lensOn;
uniform vec4  u_lens[32];
uniform float u_defringe;
// local adjustments
uniform int   u_nMasks;
uniform vec4  u_mG1[8];         // linear: p0.xy p1.xy | radial: centre.xy, rx, ry   (units: full px / long edge)
uniform vec4  u_mG2[8];         // x angle(rad) or brush channel, y feather, z invert, w type (0 linear, 1 radial, 2 brush)
uniform vec4  u_mA[8];          // exposure(EV), contrast, highlights, shadows
uniform vec4  u_mB[8];          // whites, blacks, temp, tint
uniform vec4  u_mC[8];          // saturation, clarity, dehaze, texture
uniform vec4  u_mD[8];          // sharpen, luminance range low, high, opacity
uniform int   u_showMask;       // index of mask to tint red, -1 = none
uniform int   u_maskDetail;     // 1 if any mask changes sharpening/texture (needs the mask before the detail pass)
uniform int   u_outMode;        // 0 = 8-bit (dithered), 1 = high byte of 16-bit, 2 = low byte of 16-bit
in vec2 v_uv; out vec4 o;
${GLSL_COMMON}

vec3 fetchSrc(ivec2 q){
  q = clamp(q, ivec2(0), ivec2(u_srcSize)-1);
  return vec3(texelFetch(u_src,q,0).rgb)*(1.0/65535.0);
}
vec3 sampleSrc(vec2 p){ // bilinear in source texel space
  p -= 0.5; vec2 f = fract(p); ivec2 q = ivec2(floor(p));
  vec3 a = fetchSrc(q), b = fetchSrc(q+ivec2(1,0)), c = fetchSrc(q+ivec2(0,1)), d = fetchSrc(q+ivec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
vec2 toLocal(vec2 fullPx){ return (fullPx - u_srcOrigin)/float(u_srcScale); }
vec4 lensAt(float rho){
  float x = clamp(rho/1.3, 0.0, 1.0)*31.0; int i = min(int(floor(x)), 30);
  return mix(u_lens[i], u_lens[i+1], x - float(i));
}
float maskPos(int i, vec2 fullPx){
  vec4 g1 = u_mG1[i], g2 = u_mG2[i];
  vec2 p = fullPx / max(u_fullSize.x, u_fullSize.y);
  int t = int(g2.w + 0.5); float w;
  if(t == 0){
    vec2 d = g1.zw - g1.xy; float s = dot(p - g1.xy, d)/max(dot(d,d), 1e-10);
    w = 1.0 - smoothstep(0.0, 1.0, s);
  } else if(t == 1){
    vec2 q = p - g1.xy; float ca = cos(g2.x), sa = sin(g2.x);
    vec2 r = vec2(ca*q.x + sa*q.y, -sa*q.x + ca*q.y) / max(g1.zw, vec2(1e-5));
    float f = clamp(g2.y, 0.002, 1.0);
    w = 1.0 - smoothstep(1.0 - f, 1.0, length(r));
  } else {
    vec4 b = texture(u_brush, fullPx/u_fullSize); int ch = int(g2.x + 0.5);
    w = ch == 0 ? b.r : ch == 1 ? b.g : ch == 2 ? b.b : b.a;
  }
  if(g2.z > 0.5) w = 1.0 - w;
  return w * u_mD[i].w;
}
float rangeW(int i, float Y){ vec4 d = u_mD[i]; return smoothstep(d.y - 0.1, d.y, Y) * (1.0 - smoothstep(d.z, d.z + 0.1, Y)); }
// Band weights in OkLCh hue (degrees). red, orange, yellow, green, aqua, blue, purple, magenta
const float HUES[8] = float[8](29.0, 60.0, 100.0, 142.0, 195.0, 264.0, 300.0, 340.0);
float bandW(float h, int i){
  float c = HUES[i];
  float prev = HUES[(i+7)%8], next = HUES[(i+1)%8];
  float dPrev = mod(c - prev + 360.0, 360.0), dNext = mod(next - c + 360.0, 360.0);
  float d = mod(h - c + 540.0, 360.0) - 180.0;       // signed distance
  float span = d < 0.0 ? dPrev : dNext;
  float t = clamp(abs(d)/span, 0.0, 1.0);
  return 0.5 + 0.5*cos(t*3.14159265);                 // raised cosine, partitions unity
}
float invSmooth(float x){ return 0.5 - sin(asin(1.0 - 2.0*clamp(x,0.0,1.0))/3.0); }

void main(){
  vec2 outPx = v_uv*u_outSize;
  vec2 fullPx = (u_m*vec3(outPx,1.0)).xy;       // lens-corrected full-image coords (masks live here)

  // --- local adjustment masks: positional weights ---
  float lSharp = 0.0, lTex = 0.0;
  if(u_maskDetail == 1){
    for(int i=0;i<8;i++){ if(i >= u_nMasks) break; float w = maskPos(i, fullPx); lSharp += w*u_mD[i].x; lTex += w*u_mC[i].w; }
  }

  // --- lens correction: distortion + lateral CA (dest -> source mapping) ---
  vec2 ctr = u_fullSize*0.5; float Rn = length(ctr);
  vec2 srcG = fullPx; float vgain = 1.0; vec4 Lt = vec4(1.0);
  if(u_lensOn == 1){
    vec2 q = fullPx - ctr; Lt = lensAt(length(q)/Rn);
    srcG = ctr + q*Lt.x;
    vgain = lensAt(length(srcG - ctr)/Rn).y;
  }
  vec2 lp = toLocal(srcG);
  vec3 c = sampleSrc(lp);
  if(u_lensOn == 1 && abs(Lt.z - 1.0) + abs(Lt.w - 1.0) > 1e-7){
    vec2 q = fullPx - ctr;
    c.r = sampleSrc(toLocal(ctr + q*Lt.x*Lt.z)).r;
    c.b = sampleSrc(toLocal(ctr + q*Lt.x*Lt.w)).b;
  }
  ivec2 ci = ivec2(floor(lp));

  // --- noise reduction (bilateral on linear RGB) ---
  if(u_nr.x > 0.001){
    float Lc = dot(c,LUMA); float sig = 0.02 + u_nr.x*0.25; vec3 acc=vec3(0.0); float ws=0.0;
    for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
      vec3 s = fetchSrc(ci+ivec2(i,j)); float Ls = dot(s,LUMA);
      float dl = (Ls-Lc)/(Lc+0.004); float w = exp(-(dl*dl)/(2.0*sig*sig)) * exp(-float(i*i+j*j)/6.0);
      acc += s*w; ws += w;
    }
    c = acc/ws;
  }
  // --- sharpen / texture (unsharp mask on linear luminance, pre-tone) ---
  float shAmt = max(u_sharpen.x + lSharp, 0.0), txAmt = u_texture + lTex;
  if(shAmt > 0.001 || abs(txAmt) > 0.001){
    int r = int(max(1.0, round(u_sharpen.y)));
    float Lc = dot(c,LUMA);
    float La = (dot(fetchSrc(ci+ivec2(r,0)),LUMA)+dot(fetchSrc(ci-ivec2(r,0)),LUMA)+dot(fetchSrc(ci+ivec2(0,r)),LUMA)+dot(fetchSrc(ci-ivec2(0,r)),LUMA))*0.25;
    float Lt2 = (dot(fetchSrc(ci+ivec2(3,0)),LUMA)+dot(fetchSrc(ci-ivec2(3,0)),LUMA)+dot(fetchSrc(ci+ivec2(0,3)),LUMA)+dot(fetchSrc(ci-ivec2(0,3)),LUMA)
               +dot(fetchSrc(ci+ivec2(2,2)),LUMA)+dot(fetchSrc(ci-ivec2(2,2)),LUMA)+dot(fetchSrc(ci+ivec2(2,-2)),LUMA)+dot(fetchSrc(ci-ivec2(2,-2)),LUMA))*0.125;
    float km = 1.0; // sharpening mask: only edges get sharpened (smooth areas such as skin and sky are left alone)
    if(u_sharpMask > 0.001){ float ed = abs(enc(Lc) - enc(La))*2.0 + abs(enc(Lc) - enc(Lt2)); km = smoothstep(u_sharpMask*0.05, u_sharpMask*0.05 + 0.02, ed); }
    float hp = (Lc-La)*shAmt*1.5*km + (Lc-Lt2)*txAmt*1.2;
    float m = smoothstep(0.0, 0.01, abs(Lc-La)+abs(Lc-Lt2));
    c *= 1.0 + hp*m/max(Lc,0.002);
  }
  // edge strength for purple-fringe removal
  float fringeEdge = 0.0;
  if(u_defringe > 0.001){
    float a0 = enc(dot(fetchSrc(ci+ivec2(2,0)),LUMA)), a1 = enc(dot(fetchSrc(ci-ivec2(2,0)),LUMA));
    float a2 = enc(dot(fetchSrc(ci+ivec2(0,2)),LUMA)), a3 = enc(dot(fetchSrc(ci-ivec2(0,2)),LUMA));
    fringeEdge = smoothstep(0.04, 0.2, max(abs(a0-a1), abs(a2-a3)));
  }

  // --- lens vignetting correction ---
  c *= vgain;

  // --- local adjustments: luminance range + accumulate ---
  float Y0 = enc(dot(c*u_exposure*u_wb, LUMA));
  float lExp=0.0, lCon=0.0, lHi=0.0, lSh=0.0, lWh=0.0, lBl=0.0, lTemp=0.0, lTint=0.0, lSat=0.0, lCla=0.0, lDeh=0.0, wShow=0.0;
  for(int i=0;i<8;i++){
    if(i >= u_nMasks) break;
    float w = maskPos(i, fullPx)*rangeW(i, Y0);
    if(i == u_showMask) wShow = w;
    lExp += w*u_mA[i].x; lCon += w*u_mA[i].y; lHi += w*u_mA[i].z; lSh += w*u_mA[i].w;
    lWh += w*u_mB[i].x; lBl += w*u_mB[i].y; lTemp += w*u_mB[i].z; lTint += w*u_mB[i].w;
    lSat += w*u_mC[i].x; lCla += w*u_mC[i].y; lDeh += w*u_mC[i].z;
  }
  vec3 lwb = max(vec3(1.0 + 0.45*lTemp, 1.0 - 0.25*lTint, 1.0 - 0.45*lTemp), vec3(0.05)); lwb /= dot(lwb, LUMA);
  float lMul = exp2(lExp);

  // --- exposure & white balance ---
  c *= u_exposure * u_wb * lMul * lwb;
  // --- camera calibration (primaries) + shadow tint ---
  c = max(u_calib * c, 0.0);
  if(abs(u_shadowTint) > 0.001){ float Ls = dot(c, LUMA); c.g *= 1.0 - u_shadowTint*0.3*(1.0 - smoothstep(0.0, 0.18, Ls)); }

  // --- dehaze (simple atmospheric model) ---
  float dehaze = clamp(u_dehaze + lDeh, -1.0, 1.0);
  if(abs(dehaze) > 0.001){
    float A = 0.8;
    if(dehaze > 0.0){
      // remove a veil from luminance with a soft toe (L^2(1+v)/(L+v)): no per-channel clipping, so dark areas don't turn into
      // saturated blue/black blotches; then restore some of the colour a haze washes out
      float t = 1.0 - dehaze*0.45; float v = A*(1.0-t)/t;
      float L = max(dot(c, LUMA), 1e-6); float Ln = L*L*(1.0+v)/(L+v);
      c *= Ln/L; c = mix(vec3(Ln), c, 1.0 + 0.4*dehaze);
    }
    else { float k = -dehaze*0.5; c = c*(1.0-k) + A*k; }
    c = max(c, 0.0);
  }

  // --- tone (perceptual luminance domain, ratio preserving) ---
  float L = max(dot(c,LUMA), 1e-6);
  float Lp = enc(L);
  float clarity = u_clarity + lCla;
  if(abs(clarity) > 0.001){
    float bl = texture(u_blur, srcG/u_fullSize).r;
    bl *= enc(u_exposure*dot(u_wb,LUMA)*lMul*vgain);
    float mid = 1.0 - abs(2.0*clamp(Lp,0.0,1.0)-1.0);
    Lp += clarity * (Lp - bl) * (0.35 + 0.65*mid) * 1.2;
  }
  {
    float hi = u_highlights + lHi, sh = u_shadows + lSh, wh = u_whites + lWh, bk = u_blacks + lBl;
    float x = clamp(Lp, 0.0, 1.5);
    float wH = smoothstep(0.3, 0.95, x);
    float wS = 1.0 - smoothstep(0.0, 0.6, x);
    float wW = smoothstep(0.15, 1.0, x);
    float wB = 1.0 - smoothstep(0.0, 0.35, x);
    float d = 0.0;
    d += hi * wH * (hi > 0.0 ? 0.25 : 0.40) * (1.2 - 0.5*x);
    d += sh * wS * (sh > 0.0 ? 0.35 : 0.30) * sqrt(x+0.02);
    d += wh * wW * 0.30 * x;
    d += bk * wB * 0.22 * (1.0 - x);
    Lp = max(Lp + d, 0.0);
  }
  float contrast = clamp(u_contrast + lCon, -1.0, 1.0);
  if(abs(contrast) > 0.001){
    float x = clamp(Lp,0.0,1.0); float over = Lp - x;
    float y = contrast > 0.0 ? mix(x, x*x*(3.0-2.0*x), contrast*0.9) : mix(x, invSmooth(x), -contrast*0.9);
    Lp = y + over;
  }
  if(u_fade > 0.001){ Lp = Lp*(1.0-u_fade*0.25) + u_fade*0.25*(1.0 - pow(1.0-clamp(Lp,0.0,1.0), 2.0))*0.6 + u_fade*0.08; }
  Lp = texture(u_curve, vec2(clamp(Lp,0.0,1.0)*(255.0/256.0)+0.5/256.0, 0.5)).r + max(Lp-1.0,0.0);
  float ratio = dec(Lp)/L;
  c *= ratio;
  {
    float mx = max(c.r, max(c.g, c.b));
    if(mx > 1.0){ float Ln = dot(c,LUMA); float k = clamp((mx-1.0)/max(mx-Ln, 1e-4), 0.0, 1.0); c = mix(c, vec3(min(Ln, mx)), k*0.85); }
  }

  // --- colour (OkLab/OkLCh) ---
  vec3 lab = lin2oklab(max(c,0.0));
  float C = length(lab.yz);
  float h = degrees(atan(lab.z, lab.y)); if(h < 0.0) h += 360.0;
  float Cs = smoothstep(0.0, 0.06, C);
  float Ln = lab.x;
  if(fringeEdge > 0.0){
    float pw = smoothstep(255.0, 280.0, h) * (1.0 - smoothstep(335.0, 355.0, h));
    C *= 1.0 - clamp(u_defringe*pw*fringeEdge, 0.0, 1.0);
  }
  {
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for(int i=0;i<8;i++){ float w = bandW(h,i); dh += w*u_hsl[i].x; ds += w*u_hsl[i].y; dl += w*u_hsl[i].z; }
    h += dh*45.0;
    C *= max(0.0, 1.0 + ds);
    Ln += dl*0.18*Cs;
  }
  if(abs(u_vibrance) > 0.001){
    float skin = 1.0 - 0.6*smoothstep(15.0, 35.0, h)*(1.0-smoothstep(60.0, 85.0, h));
    float low = 1.0 - smoothstep(0.0, 0.22, C);
    C *= 1.0 + u_vibrance*(0.35 + 0.9*low)*(u_vibrance>0.0?skin:1.0);
  }
  C *= max(0.0, 1.0 + u_saturation + lSat);
  if(u_bw > 0.5){
    float dl = 0.0; for(int i=0;i<8;i++) dl += bandW(h,i)*u_bwmix[i];
    Ln += dl*0.25*Cs; C = 0.0;
  }
  lab = vec3(Ln, C*cos(radians(h)), C*sin(radians(h)));
  {
    float x = clamp(Ln, 0.0, 1.0);
    float b = u_gradeBalance*0.25;
    float sp = 0.5 + u_gradeBlend;           // blending widens/narrows the overlap; 1.0 at the default 50
    float eS = 0.55 + b, cS = eS*0.5, hS = eS*0.5*sp;
    float wS = 1.0 - smoothstep(cS - hS, cS + hS, x);
    float sH = 0.45 + b, cH = (sH + 1.0)*0.5, hH = (1.0 - sH)*0.5*sp;
    float wH = smoothstep(cH - hH, cH + hH, x);
    float wM = max(0.0, 1.0 - wS - wH);
    lab += wS*u_gradeS + wM*u_gradeM + wH*u_gradeH + u_gradeG;
  }
  c = oklab2lin(lab);
  c = max(c, 0.0);

  // --- vignette (creative, in output space) ---
  if(abs(u_vignette.x) > 0.001){
    vec2 q = (v_uv - 0.5)*2.0; float asp = u_outSize.x/max(u_outSize.y, 1.0); float rnd = u_vig2.x, d;
    if(rnd >= 0.0){ float s = mix(1.0, asp, rnd); q.x *= s; q /= max(s, 1.0); d = length(q)/1.41421356; } // 0 = follows the frame, 1 = circle
    else { float n = 2.0 - rnd*6.0; vec2 a = abs(q); d = pow(pow(a.x, n) + pow(a.y, n), 1.0/n)/pow(2.0, 1.0/n); } // towards a rounded rectangle
    float mid = u_vignette.y, fe = max(u_vignette.z, 0.02);
    float v = smoothstep(mid - fe*0.7, mid + fe*0.7, d);
    if(u_vignette.x < 0.0){
      float k = 1.0 + u_vignette.x*v*0.9;
      if(u_vig2.y > 0.001){ float Lv = enc(dot(c, LUMA)); k = mix(k, 1.0, u_vig2.y*smoothstep(0.55, 0.95, Lv)); } // highlight priority
      c *= k;
    } else c = mix(c, vec3(1.0), u_vignette.x*v*0.6);
  }

  // --- output encode ---
  vec3 e = srgbOETF(c);
  if(u_lutAmt > 0.001){ // film emulation: user sliders act first, then the image goes 'through the film'; R/G/B curves and grain follow
    vec3 q = clamp(e, 0.0, 1.0)*((u_lutN - 1.0)/u_lutN) + 0.5/u_lutN;
    e = mix(e, texture(u_lut, q).rgb, u_lutAmt);
  }
  e.r = texture(u_curve, vec2(e.r*(255.0/256.0)+0.5/256.0, 0.5)).g;
  e.g = texture(u_curve, vec2(e.g*(255.0/256.0)+0.5/256.0, 0.5)).b;
  e.b = texture(u_curve, vec2(e.b*(255.0/256.0)+0.5/256.0, 0.5)).a;
  if(u_clipWarn == 1){ // clipping warning (display only)
    float mxe = max(e.r, max(e.g, e.b)), mne = min(e.r, min(e.g, e.b));
    if(mxe >= 0.997) e = vec3(1.0, 0.12, 0.12); else if(mne <= 0.003) e = vec3(0.15, 0.35, 1.0);
  }
  if(u_grain.x > 0.001){
    float sz = 1.0 + u_grain.y*3.0;
    vec2 gp = floor(fullPx/sz);
    float n = hash12(gp + u_seed) - 0.5;
    float n2 = hash12(gp*1.7 + 13.1 + u_seed) - 0.5;
    float lum = dot(e,LUMA); float mask = 0.25 + 0.75*(4.0*lum*(1.0-lum));
    float n3 = hash12(floor(fullPx/(sz*3.0)) + u_seed*1.37) - 0.5; // coarse clumping = roughness
    e += (n*0.75 + n2*0.25)*u_grain.x*0.22*mask*(1.0 + (u_grainRough - 0.5)*3.2*n3);
  }
  if(u_showMask >= 0) e = mix(e, vec3(1.0, 0.15, 0.25), wShow*0.6);
  if(u_outMode == 0){
    e += (hash12(outPx + u_seed*7.0) - 0.5)/255.0;
    o = vec4(clamp(e,0.0,1.0), 1.0);
  } else {
    vec3 v = floor(clamp(e,0.0,1.0)*65535.0 + 0.5);
    vec3 hi = floor(v/256.0);
    o = vec4((u_outMode == 1 ? hi : v - hi*256.0)/255.0, 1.0);
  }
}`;

// Display pass: textured quad with view transform; optional split for before/after.
const FS_DISPLAY = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform sampler2D u_tex2; uniform float u_split; uniform int u_mode;
in vec2 v_uv; out vec4 o;
void main(){
  vec4 a = texture(u_tex, v_uv);
  if(u_mode == 1){ o = texture(u_tex2, v_uv); return; }
  if(u_mode == 2){ vec4 b = texture(u_tex2, v_uv); float line = smoothstep(0.0, 1.5/float(textureSize(u_tex,0).x), abs(v_uv.x-u_split)); o = mix(vec4(1.0), v_uv.x < u_split ? b : a, line); return; }
  o = a;
}`;

export { VS_QUAD, FS_LUM, FS_BLUR, FS_MAIN, FS_DISPLAY };
