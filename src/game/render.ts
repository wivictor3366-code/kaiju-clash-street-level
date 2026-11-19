// WebGL2 renderer.
//  * The world is real 3D geometry seen through a street-level camera (eye height 1.7 m)
//    pitched upward with a wide FOV: verticals converge, kaiju tower, people are specks.
//  * Everything renders into a 640x360 framebuffer (pixel art resolution) and is upscaled
//    with a sharp-bilinear pass. Depth buffer + alpha cut-out => no CPU sorting.
//  * One texture array holds every code-drawn sprite; geometry is batched into four
//    vertex buffers => ~6 draw calls per frame. Facades, ground, sky, beams and
//    lightning are procedural fragment shaders (zero texture memory).
//  * Emissive regions (dorsal plates, throats, eyes) are encoded in sprite alpha so the
//    GPU animates the charge-up glow sweep without extra frames.
import type { Atlas, Frame } from "./art/atlas";
import { PAGE, PX_M } from "./art/atlas";
import { FONT_CHARS } from "./art/env";
import { hash2 } from "./art/raster";
import * as S from "./sim";
import type { NetStats } from "./net";
import { animFrame } from "./anim";

export const RW = 640, RH = 360;
const KZ = 130, PITCH = (24 * Math.PI) / 180, TANF = Math.tan((33 * Math.PI) / 180), NEAR = 1, FAR = 2600;
const CM = 0.01, VS = 13, NPART = 1400;

const FS_TRI = `#version 300 es
out vec2 vN; out vec2 vUV;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; vN = p * 2.0 - 1.0; gl_Position = vec4(vN, 0.0, 1.0); }`;

const COMMON = `
const float BAY[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
float bayer(vec2 p){ ivec2 i = ivec2(p) & 3; return (BAY[i.x + i.y * 4] + 0.5) / 16.0; }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

const WORLD_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; layout(location=2) in vec4 aCol; layout(location=3) in vec4 aDat;
uniform mat4 uVP;
out vec2 vUV; out vec4 vCol; flat out vec4 vDat; out float vDepth; out float vY;
void main(){ gl_Position = uVP * vec4(aPos, 1.0); vUV = aUV; vCol = aCol; vDat = aDat; vDepth = gl_Position.w; vY = aPos.y; }`;

const WORLD_FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uAtlas; uniform float uTime; uniform float uFog; uniform float uAmb;
in vec2 vUV; in vec4 vCol; flat in vec4 vDat; in float vDepth; in float vY;
out vec4 o;
const vec3 GLOW[4] = vec3[4](vec3(0.35,0.85,1.0), vec3(1.0,0.92,0.35), vec3(1.0,0.3,0.55), vec3(1.0,1.0,0.9));
${COMMON}
void main(){
  int m = int(vDat.x + 0.5);
  if (vCol.a < bayer(gl_FragCoord.xy)) discard;
  vec3 c = vCol.rgb; float emis = 0.0;
  if (m == 0) {
    vec4 t = texelFetch(uAtlas, ivec3(ivec2(vUV), int(vDat.y + 0.5)), 0);
    if (t.a < 0.02) discard;
    c = t.rgb * vCol.rgb;
    float a = t.a * 255.0;
    if (a < 240.0) {
      float gi = floor(vDat.z * 0.5); float amt = vDat.z - gi * 2.0;
      float k = (a - 128.0) / 100.0;
      float g = clamp((amt * 1.3 - k) * 4.0, 0.0, 1.0);
      g = floor(g * 3.0 + 0.5) / 3.0;
      float lum = dot(t.rgb, vec3(0.4, 0.5, 0.3));
      c = mix(c, GLOW[int(gi)] * (0.45 + lum * 1.1), g); emis = g;
    } else if (a < 253.0) { c = t.rgb; emis = 1.0; }
  } else if (m == 1) {
    // procedural facade: uv in metres, quantised to texels so it reads as pixel art
    float tx = vDat.z; vec2 p = floor(vUV / tx);
    vec2 ci = floor(p / vec2(4.0, 5.0)); vec2 cf = p - ci * vec2(4.0, 5.0);
    float win = (cf.x >= 1.0 && cf.x <= 2.0 && cf.y >= 1.0 && cf.y <= 3.0) ? 1.0 : 0.0;
    float lit = step(0.66, hash(ci + vDat.y * 0.37));
    vec3 wall = vCol.rgb * (0.8 + 0.2 * hash(vec2(ci.y * 3.1, vDat.y)));
    wall += vec3(0.30, 0.11, 0.02) * clamp(1.0 - vY / 30.0, 0.0, 1.0);
    vec3 wc = mix(vec3(0.04, 0.06, 0.11), vec3(1.0, 0.8, 0.42) * (0.75 + 0.25 * hash(ci.yx + vDat.y)), lit);
    c = mix(wall, wc, win); emis = win * lit * 0.85;
  } else if (m == 3) {
    float x = vUV.x, z = vUV.y;
    if (z < 12.0) { c = vec3(0.17, 0.16, 0.19); if (fract(x / 2.0) < 0.06 || z > 11.6) c *= 0.6; }
    else if (z < 30.0) { c = vec3(0.075, 0.075, 0.095); if (z > 20.6 && z < 21.0 && fract(x / 8.0) < 0.5) c = vec3(0.55, 0.5, 0.28); if (z < 12.5 || z > 29.5) c = vec3(0.3); }
    else if (z < 92.0) { c = vec3(0.03, 0.045, 0.085); float g = hash(vec2(floor(x / 1.5), floor(z / 3.0) + floor(uTime * 3.0))); if (g > 0.9) c += vec3(0.55, 0.22, 0.05) * (g - 0.9) * 9.0; }
    else { c = vec3(0.10, 0.085, 0.08) * (0.75 + 0.5 * hash(floor(vec2(x, z) / 4.0))); }
  } else if (m == 4) {
    // beam: white-hot core, coloured sheath, flickering pixel edge
    float v = abs(vUV.y); float q = floor(vUV.x / 1.6);
    float w = 0.72 + 0.28 * hash(vec2(q, floor(uTime * 30.0)));
    if (vDat.z > 0.5) w *= 0.8 + 0.2 * sin(vUV.x * 0.35 - uTime * 40.0);
    if (v > w) discard;
    c = v < 0.36 * w ? vec3(1.0) : vCol.rgb;
    o = vec4(c, 1.0); return;
  } else if (m == 5) {
    // gravity beam: jagged lightning re-rolled 24x per second
    float sg = floor(vUV.x / 5.0), f = fract(vUV.x / 5.0), t = floor(uTime * 24.0) + vDat.y * 7.0;
    float y0 = (hash(vec2(sg, t)) - 0.5) * 1.3, y1 = (hash(vec2(sg + 1.0, t)) - 0.5) * 1.3;
    float d = abs(vUV.y - mix(y0, y1, f));
    if (d > 0.4) discard;
    c = d < 0.15 ? vec3(1.0) : vCol.rgb;
    o = vec4(c, 1.0); return;
  }
  float f = clamp(vDepth * uFog, 0.0, 0.88);
  vec3 fogc = mix(vec3(0.56, 0.22, 0.12), vec3(0.14, 0.08, 0.16), clamp(vY / 140.0, 0.0, 1.0));
  c = mix(c, fogc, f * (1.0 - emis * 0.6));
  c *= mix(uAmb, 1.0, emis);
  c = mix(c, vec3(1.0), vDat.w);
  o = vec4(c, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
uniform float uPitch, uTanF, uAspect, uCamX, uTime, uFlash;
in vec2 vN; out vec4 o;
${COMMON}
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ return vnoise(p) * 0.55 + vnoise(p * 2.1 + 7.3) * 0.3 + vnoise(p * 4.3 + 1.7) * 0.15; }
void main(){
  vec3 d = normalize(vec3(vN.x * uTanF * uAspect, vN.y * uTanF, 1.0));
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 w = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float el = asin(clamp(w.y, -1.0, 1.0)), az = atan(w.x, w.z);
  float t = clamp(el / 1.25, 0.0, 1.0);
  vec3 c = mix(vec3(0.98, 0.47, 0.14), vec3(0.62, 0.17, 0.13), smoothstep(0.0, 0.16, t));
  c = mix(c, vec3(0.27, 0.09, 0.17), smoothstep(0.12, 0.42, t));
  c = mix(c, vec3(0.07, 0.05, 0.13), smoothstep(0.35, 0.8, t));
  c = mix(c, vec3(0.02, 0.02, 0.06), smoothstep(0.7, 1.0, t));
  float st = hash(floor(vec2(az, el) * 230.0));
  if (st > 0.993 && el > 0.4) c += vec3(0.8, 0.8, 1.0) * (st - 0.993) * 120.0;
  vec2 md = vec2((az - 0.62) * cos(el), el - 0.86);
  float mr = length(md);
  if (mr < 0.075) { float cr = hash(floor(md * 150.0)); c = vec3(0.95, 0.88, 0.72) * (cr > 0.8 ? 0.8 : 1.0) * (md.x + md.y > 0.05 ? 0.78 : 1.0); }
  else c += vec3(0.25, 0.2, 0.15) * smoothstep(0.2, 0.075, mr) * 0.5;
  vec2 q = vec2(az * 3.0 + uCamX * 0.0012 + uTime * 0.012, el * 6.0 - uTime * 0.004);
  float cl = smoothstep(0.45, 0.78, fbm(q)) * smoothstep(0.02, 0.3, el);
  vec3 smoke = mix(vec3(0.42, 0.14, 0.08), vec3(0.07, 0.045, 0.085), clamp(t * 1.5, 0.0, 1.0));
  c = mix(c, smoke, cl * 0.9);
  c += uFlash * vec3(0.45, 0.45, 0.6) * (0.25 + cl);
  c = floor(c * 20.0 + 0.5 + (bayer(gl_FragCoord.xy) - 0.5) * 0.95) / 20.0;
  o = vec4(c, 1.0);
}`;

const POST_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uRes; uniform float uFlash, uDark, uAber, uScan, uZoom;
in vec2 vUV; out vec4 o;
void main(){
  vec2 pix = vUV * uRes; vec2 seam = floor(pix + 0.5);
  pix = seam + clamp((pix - seam) / fwidth(pix), -0.5, 0.5);   // sharp-bilinear: crisp pixels at any scale
  vec2 uv = (pix / uRes - 0.5) / uZoom + 0.5;
  vec3 c = texture(uTex, uv).rgb;
  if (uAber > 0.01) { c.r = texture(uTex, uv + vec2(uAber / uRes.x, 0.0)).r; c.b = texture(uTex, uv - vec2(uAber / uRes.x, 0.0)).b; }
  c = mix(c, vec3(1.0), uFlash);
  c *= 1.0 - uDark * 0.5;
  vec2 q = vUV - 0.5; c *= 1.0 - dot(q, q) * 0.6;
  if (uScan > 0.5) c *= 0.86 + 0.14 * step(0.5, fract(vUV.y * uRes.y));
  o = vec4(c, 1.0);
}`;

class Batch {
  data: Float32Array;
  n = 0;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  constructor(private gl: WebGL2RenderingContext, private quads: number, ibo: WebGLBuffer, dyn: boolean) {
    this.data = new Float32Array(quads * 4 * VS);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, dyn ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    const st = VS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, st, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, st, 36);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
  }
  /** corners: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right */
  quad(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number, u0: number, v0: number, u1: number, v1: number, r: number, g: number, b: number, a: number, m: number, l: number, gw: number, fl: number) {
    if (this.n >= this.quads * 4) return;
    const d = this.data;
    let i = this.n * VS;
    d[i] = x0; d[i + 1] = y0; d[i + 2] = z0; d[i + 3] = u0; d[i + 4] = v0;
    d[i + 5] = r; d[i + 6] = g; d[i + 7] = b; d[i + 8] = a; d[i + 9] = m; d[i + 10] = l; d[i + 11] = gw; d[i + 12] = fl;
    i += VS;
    d[i] = x1; d[i + 1] = y1; d[i + 2] = z1; d[i + 3] = u1; d[i + 4] = v0;
    d[i + 5] = r; d[i + 6] = g; d[i + 7] = b; d[i + 8] = a; d[i + 9] = m; d[i + 10] = l; d[i + 11] = gw; d[i + 12] = fl;
    i += VS;
    d[i] = x2; d[i + 1] = y2; d[i + 2] = z2; d[i + 3] = u0; d[i + 4] = v1;
    d[i + 5] = r; d[i + 6] = g; d[i + 7] = b; d[i + 8] = a; d[i + 9] = m; d[i + 10] = l; d[i + 11] = gw; d[i + 12] = fl;
    i += VS;
    d[i] = x3; d[i + 1] = y3; d[i + 2] = z3; d[i + 3] = u1; d[i + 4] = v1;
    d[i + 5] = r; d[i + 6] = g; d[i + 7] = b; d[i + 8] = a; d[i + 9] = m; d[i + 10] = l; d[i + 11] = gw; d[i + 12] = fl;
    this.n += 4;
  }
  upload() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * VS);
  }
  draw() {
    if (!this.n) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, (this.n / 4) * 6, gl.UNSIGNED_SHORT, 0);
  }
}

export interface HudInfo {
  names: [string, string];
  net: NetStats | null;
  demo: boolean;
  banner: string;
}

const WALLS = [[0.3, 0.33, 0.4], [0.38, 0.33, 0.3], [0.26, 0.3, 0.33], [0.42, 0.4, 0.38], [0.33, 0.28, 0.36]];
const SHIRT = [[0.9, 0.3, 0.3], [0.3, 0.5, 0.9], [0.9, 0.85, 0.5], [0.5, 0.8, 0.5], [0.85, 0.85, 0.9], [0.7, 0.4, 0.8]];

export class Renderer {
  gl: WebGL2RenderingContext;
  cam = { x: 0, z: 0, shake: 0, sx: 0, sy: 0 };
  flash = 0;
  aber = 0;
  scan = false;
  debug = false;
  private imp = 0;
  private clash = 0;
  private hint = 0;
  private tsec = 0;
  private time = 0;
  private pWorld: WebGLProgram;
  private pSky: WebGLProgram;
  private pPost: WebGLProgram;
  private U: Record<string, WebGLUniformLocation | null> = {};
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  private emptyVao: WebGLVertexArrayObject;
  private stat: Batch;
  private dyn: Batch;
  private add: Batch;
  private hud: Batch;
  private vp = new Float32Array(16);
  private ortho = new Float32Array([2 / RW, 0, 0, 0, 0, -2 / RH, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]);
  private hpLag = [1000, 1000];
  private tanks: number[] = [];
  // particles (structure of arrays, fixed pool)
  private pp = new Float32Array(NPART * 3);
  private pv = new Float32Array(NPART * 3);
  private pl = new Float32Array(NPART * 4); // life, max, size, grow
  private pc = new Float32Array(NPART * 3);
  private pk = new Uint8Array(NPART * 2); // kind, sprite
  private pcur = 0;
  // crowd
  private hum = new Float32Array(72 * 5); // x, z, dir, speed, tint
  private rs = 9001;

  constructor(public canvas: HTMLCanvasElement, public atlas: Atlas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance", desynchronized: true, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is required");
    this.gl = gl;
    this.pWorld = this.prog(WORLD_VS, WORLD_FS);
    this.pSky = this.prog(FS_TRI, SKY_FS);
    this.pPost = this.prog(FS_TRI, POST_FS);
    for (const [p, names] of [[this.pWorld, ["uVP", "uAtlas", "uTime", "uFog", "uAmb"]], [this.pSky, ["uPitch", "uTanF", "uAspect", "uCamX", "uTime", "uFlash"]], [this.pPost, ["uTex", "uRes", "uFlash", "uDark", "uAber", "uScan", "uZoom"]]] as [WebGLProgram, string[]][])
      for (const n of names) this.U[(p === this.pWorld ? "w" : p === this.pSky ? "s" : "p") + n] = gl.getUniformLocation(p, n);

    // sprite texture array
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE, PAGE, atlas.pages.length);
    atlas.pages.forEach((pg, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, PAGE, PAGE, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pg.buffer)));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    atlas.pages.length = 0; // pixels now live on the GPU; free ~16MB per page of JS heap

    // low-res render target
    this.fboTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, RW, RH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, RW, RH);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // shared quad index buffer
    const QMAX = 4096;
    const idx = new Uint16Array(QMAX * 6);
    for (let i = 0; i < QMAX; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.emptyVao = gl.createVertexArray()!;
    this.stat = new Batch(gl, 2600, ibo, false);
    this.dyn = new Batch(gl, 2600, ibo, true);
    this.add = new Batch(gl, 1200, ibo, true);
    this.hud = new Batch(gl, 900, ibo, true);
    this.buildStatic();
    for (let i = 0; i < 72; i++) {
      const o = i * 5;
      this.hum[o] = (this.rnd() - 0.5) * 150;
      this.hum[o + 1] = i < 5 ? 5.6 + this.rnd() * 1.6 : 10.5 + this.rnd() * 18;
      this.hum[o + 2] = this.rnd() < 0.5 ? -1 : 1;
      this.hum[o + 3] = i < 5 ? 0 : 0.06 + this.rnd() * 0.07;
      this.hum[o + 4] = Math.floor(this.rnd() * 6);
    }
    gl.disable(gl.CULL_FACE);
    gl.depthFunc(gl.LEQUAL);
  }

  private rnd(): number {
    this.rs = (Math.imul(this.rs, 1103515245) + 12345) | 0;
    return (this.rs >>> 8) / 16777216;
  }
  private prog(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
    return p;
  }

  // ------------------------------------------------------------ geometry helpers
  private sprite(b: Batch, name: string, cx: number, y0: number, z: number, w: number, h: number, flip: boolean, r: number, g: number, bl: number, a = 1, fl = 0) {
    const s = this.atlas.env[name];
    const u0 = flip ? s[0] + s[2] : s[0], u1 = flip ? s[0] : s[0] + s[2];
    b.quad(cx - w / 2, y0 + h, z, cx + w / 2, y0 + h, z, cx - w / 2, y0, z, cx + w / 2, y0, z, u0, s[1], u1, s[1] + s[3], r, g, bl, a, 0, 0, 0, fl);
  }
  private box(b: Batch, x: number, z: number, hw: number, d: number, h: number, sink: number, col: number[], seed: number, tx: number, sides: boolean) {
    const top = h - sink, z0 = z - d / 2, z1 = z + d / 2;
    if (top <= 0) return;
    b.quad(x - hw, top, z0, x + hw, top, z0, x - hw, 0, z0, x + hw, 0, z0, 0, 0, hw * 2, top, col[0], col[1], col[2], 1, 1, seed, tx, 0);
    if (!sides) return;
    const r = col[0] * 0.66, g = col[1] * 0.66, bl = col[2] * 0.7;
    b.quad(x - hw, top, z0, x - hw, top, z1, x - hw, 0, z0, x - hw, 0, z1, 0, 0, d, top, r, g, bl, 1, 1, seed + 3, tx, 0);
    b.quad(x + hw, top, z0, x + hw, top, z1, x + hw, 0, z0, x + hw, 0, z1, 0, 0, d, top, r, g, bl, 1, 1, seed + 5, tx, 0);
  }
  private buildStatic() {
    const b = this.stat, gl = this.gl;
    b.n = 0;
    // ground
    b.quad(-1600, 0, 1800, 1600, 0, 1800, -1600, 0, -90, 1600, 0, -90, -1600, 1800, 1600, -90, 1, 1, 1, 1, 3, 0, 0, 0);
    // distant skyline (three depth rows)
    for (let row = 0; row < 3; row++) {
      const z = [205, 300, 450][row], step = [38, 52, 70][row];
      for (let x = -760; x < 760; x += step) {
        const k = Math.floor(x / step) + row * 100;
        if (hash2(k, 1) < 0.18) continue;
        const hw = step * (0.22 + hash2(k, 2) * 0.2), h = [28, 50, 70][row] + hash2(k, 3) * [85, 120, 150][row];
        const wc = WALLS[Math.floor(hash2(k, 4) * 5)], dk = [0.62, 0.48, 0.36][row];
        this.box(b, x + hash2(k, 5) * step * 0.4, z + hash2(k, 6) * 30, hw, hw * 1.6, h, 0, [wc[0] * dk, wc[1] * dk, wc[2] * dk], k & 255, 0.8, row === 0);
      }
    }
    // street furniture near the camera: the human-scale reference
    for (let x = -420; x <= 420; x += 26) this.sprite(b, "lamp", x, 0, 9.5, 1.44, 8.96, false, 1, 1, 1);
    for (let x = -430; x <= 430; x += 45) {
      this.sprite(b, "pole", x + 9, 0, 31, 2.4, 11.2, false, 1, 1, 1);
      // sagging wires to the next pole
      for (let w = 0; w < 2; w++) {
        const y = 10.2 - w * 0.8, xa = x + 9, xm = xa + 22.5, xb = xa + 45;
        b.quad(xa, y + 0.1, 31, xm, y - 0.5, 31, xa, y - 0.1, 31, xm, y - 0.7, 31, 0, 0, 1, 1, 0.03, 0.03, 0.04, 1, 2, 0, 0, 0);
        b.quad(xm, y - 0.5, 31, xb, y + 0.1, 31, xm, y - 0.7, 31, xb, y - 0.1, 31, 0, 0, 1, 1, 0.03, 0.03, 0.04, 1, 2, 0, 0, 0);
      }
    }
    for (let i = 0; i < 46; i++) {
      const x = -420 + hash2(i, 11) * 840;
      if (hash2(i, 12) < 0.45) this.sprite(b, "tree", x, 0, 33 + hash2(i, 13) * 3, 6, 7.8, false, 1, 1, 1);
      else {
        const t = SHIRT[Math.floor(hash2(i, 14) * 6)];
        this.sprite(b, "car", x, 0, hash2(i, 15) < 0.5 ? 13.5 : 26, 4.7, 1.8, hash2(i, 16) < 0.5, t[0] * 0.7, t[1] * 0.7, t[2] * 0.7);
      }
    }
    // army on the far bank
    this.tanks = [];
    for (let i = 0; i < 9; i++) {
      const x = -200 + i * 50 + hash2(i, 21) * 20;
      this.tanks.push(x);
      this.sprite(b, "tank", x, 0, 97 + hash2(i, 22) * 4, 7.9, 3.1, i % 2 === 0, 1, 1, 1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * VS);
  }

  // ------------------------------------------------------------ particles / fx
  private spawn(kind: number, spr: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, r: number, g: number, b: number) {
    const i = this.pcur;
    this.pcur = (i + 1) % NPART;
    this.pp[i * 3] = x; this.pp[i * 3 + 1] = y; this.pp[i * 3 + 2] = z;
    this.pv[i * 3] = vx; this.pv[i * 3 + 1] = vy; this.pv[i * 3 + 2] = vz;
    this.pl[i * 4] = life; this.pl[i * 4 + 1] = life; this.pl[i * 4 + 2] = size; this.pl[i * 4 + 3] = grow;
    this.pc[i * 3] = r; this.pc[i * 3 + 1] = g; this.pc[i * 3 + 2] = b;
    this.pk[i * 2] = kind; this.pk[i * 2 + 1] = spr;
  }
  private dust(x: number, y: number, z: number, n: number, spread: number, size: number) {
    for (let i = 0; i < n; i++) {
      const sh = 0.5 + this.rnd() * 0.25;
      this.spawn(0, Math.floor(this.rnd() * 3), x + (this.rnd() - 0.5) * spread, y + this.rnd() * size * 0.5, z + (this.rnd() - 0.5) * 6, (this.rnd() - 0.5) * 0.5, 0.05 + this.rnd() * 0.22, 0, 70 + this.rnd() * 70, size * (0.6 + this.rnd() * 0.8), 0.07, sh, sh * 0.86, sh * 0.76);
    }
  }
  private debris(x: number, y: number, z: number, n: number, pw: number) {
    for (let i = 0; i < n; i++) {
      const sh = 0.5 + this.rnd() * 0.5;
      this.spawn(1, Math.floor(this.rnd() * 3), x + (this.rnd() - 0.5) * 14, y + this.rnd() * 12, z + (this.rnd() - 0.5) * 5, (this.rnd() - 0.5) * pw, this.rnd() * pw * 0.9, (this.rnd() - 0.5) * 0.2, 90 + this.rnd() * 80, 1.5 + this.rnd() * 4, 0, sh, sh, sh);
    }
  }
  private sparks(x: number, y: number, z: number, n: number, r: number, g: number, b: number) {
    for (let i = 0; i < n; i++) this.spawn(3, 0, x, y, z, (this.rnd() - 0.5) * 2.4, (this.rnd() - 0.3) * 2.2, 0, 14 + this.rnd() * 18, 1 + this.rnd() * 1.6, 0, r, g, b);
  }

  /** presentation reaction to a simulation event */
  event(type: number, a: number, b: number, c: number) {
    const cam = this.cam;
    switch (type) {
      case S.EV_STEP:
        cam.shake += 0.4;
        this.dust(a * CM, 0, KZ - 3, 4, 26, 9);
        break;
      case S.EV_HIT: {
        const heavy = b >= 2 && b <= 5 ? 1 : b === 6 ? 0.4 : 1;
        this.imp = Math.max(this.imp, Math.min(1, 0.3 + c / 95) * (0.6 + heavy * 0.8));
        cam.shake += Math.min(2.6, 0.5 + c / 70) * (0.7 + heavy * 0.7);
        this.flash = Math.max(this.flash, Math.min(0.5, c / 220));
        this.aber = Math.max(this.aber, Math.min(3, c / 38));
        this.sparks(a * CM, 55 + this.rnd() * 35, KZ - 4, 10 + Math.round(c / 12) * 2, 1, 0.72, 0.28);
        this.dust(a * CM, 50, KZ - 3, 3 + Math.round(heavy * 4), 24, 11);
        if (heavy > 0.6) this.debris(a * CM, 62, KZ - 4, 10, 0.9);
        break;
      }
      case S.EV_CLASH: {
        this.clash = Math.max(this.clash, 100);
        cam.shake += 1.8;
        this.flash = Math.max(this.flash, 0.25);
        this.aber = 3;
        this.sparks(a * CM, 70, KZ - 4, 26, 1, 0.95, 0.6);
        this.dust(a * CM, 40, KZ - 4, 8, 40, 14);
        break;
      }
      case S.EV_BLOCK:
        cam.shake += 0.3;
        this.sparks(a * CM, 60 + this.rnd() * 30, KZ - 4, 8, 0.6, 0.8, 1);
        break;
      case S.EV_COLLAPSE:
        cam.shake += 0.8;
        this.dust(b * CM, 0, KZ - 4, 16, 34, 16);
        this.debris(b * CM, c * CM * 0.4, KZ - 4, 18, 0.9);
        break;
      case S.EV_RIP:
        cam.shake += 0.5;
        this.dust(b * CM, 0, KZ - 4, 8, 26, 12);
        this.debris(b * CM, 8, KZ - 4, 12, 0.8);
        break;
      case S.EV_CRASH:
        cam.shake += 1.1;
        this.flash = Math.max(this.flash, 0.15);
        this.debris(a * CM, b * CM + 25, KZ - 4, 22, 1.5);
        this.dust(a * CM, b * CM + 20, KZ - 4, 8, 30, 14);
        break;
      case S.EV_SLAM:
        cam.shake += 1.7;
        this.dust(a * CM, 0, KZ - 5, 20, 90, 15);
        this.debris(a * CM, 2, KZ - 5, 10, 1.1);
        break;
      case S.EV_CHUNK:
        cam.shake += 1;
        this.debris(a * CM, b * CM, KZ - 4, 24, 1.4);
        this.dust(a * CM, b * CM, KZ - 4, 10, 30, 14);
        break;
      case S.EV_KO:
        cam.shake += 2.2;
        this.flash = 0.7;
        break;
      case S.EV_SUPER:
        this.flash = 0.35;
        break;
    }
  }

  /** advance visual-only state; called once per simulated frame */
  update(s: Int32Array) {
    this.time += 1 / 60;
    this.imp *= 0.85;
    if (this.clash > 0) this.clash--;
    this.hint = 0;
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, st = s[o + S.ST];
      if (st === S.ST_IDLE || st === S.ST_WALKF || st === S.ST_WALKB) {
        this.hint |= s[o + S.PREV] & S.IN_D ? 1 << k : 0;
        this.hint |= s[o + S.PREV] & S.IN_U ? 4 << k : 0;
      }
    }
    const x0 = s[S.F0 + S.X] * CM, x1 = s[S.F1 + S.X] * CM;
    this.targetCam = { x: Math.max(-175, Math.min(175, (x0 + x1) / 2)), z: -Math.min(24, Math.max(0, Math.abs(x1 - x0) - 105) * 0.5) };
    this.flash *= 0.84;
    this.aber *= 0.86;
    // particles
    const { pp, pv, pl, pk } = this;
    for (let i = 0; i < NPART; i++) {
      if (pl[i * 4] <= 0) continue;
      pl[i * 4]--;
      const k = pk[i * 2];
      pp[i * 3] += pv[i * 3]; pp[i * 3 + 1] += pv[i * 3 + 1]; pp[i * 3 + 2] += pv[i * 3 + 2];
      if (k === 1) {
        pv[i * 3 + 1] -= 0.022; // slow gravity sells the scale
        if (pp[i * 3 + 1] < 0) pl[i * 4] = 0;
      } else if (k === 3) pv[i * 3 + 1] -= 0.05;
      else {
        pv[i * 3] *= 0.97;
        pv[i * 3 + 1] *= 0.985;
        pl[i * 4 + 2] += pl[i * 4 + 3];
      }
    }
    // smouldering ruins
    const fr = s[S.G_FRAME];
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N;
      if (s[bo + S.BHP] > 0 || s[bo + S.BDT] < 0) continue;
      const age = fr - s[bo + S.BDT];
      if (age < 55 && !s[bo + S.BFL] && (fr & 3) === 0) this.dust(s[bo + S.BX] * CM, 0, this.bz(s, bo) - 3, 1, s[bo + S.BW] * CM * 2.4, 13);
      if ((fr + i * 7) % 14 === 0) {
        const sh = 0.16 + this.rnd() * 0.1;
        this.spawn(4, Math.floor(this.rnd() * 3), s[bo + S.BX] * CM + (this.rnd() - 0.5) * 12, 4, this.bz(s, bo), 0.03 + this.rnd() * 0.05, 0.22 + this.rnd() * 0.1, 0, 220, 8, 0.09, sh, sh * 0.9, sh * 0.95);
      }
    }
    // beam impact sparks + tank tracers
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0;
      const bm = this.beamInfo(s, o);
      if (bm && (fr & 1) === 0) this.sparks(bm[2], bm[3], KZ - 3, 3, bm[6], bm[7], bm[8]);
    }
    if (fr % 23 === 0 && s[S.G_PHASE] === S.PH_FIGHT) {
      const t = this.tanks[Math.floor(this.rnd() * this.tanks.length)], tgt = this.rnd() < 0.5 ? x0 : x1;
      this.spawn(3, 0, t, 3, 99, (tgt - t) / 26, (30 + this.rnd() * 40) / 26 + 0.65, (KZ - 99) / 26, 26, 1.2, 0, 1, 0.9, 0.5);
    }
    // crowd
    const h = this.hum;
    for (let i = 0; i < 72; i++) {
      const o = i * 5;
      h[o] += h[o + 2] * h[o + 3];
      if (h[o] - this.cam.x > 80) h[o] -= 160;
      else if (h[o] - this.cam.x < -80) h[o] += 160;
    }
  }

  /** camera + shake smoothing; called once per RENDERED frame (dt in ms) so 120Hz screens are smooth
   *  while the simulation itself stays on a fixed 60Hz tick. */
  act(dt: number) {
    const k = Math.min(4, dt / 16.667), cam = this.cam, t = this.targetCam;
    cam.x += (t.x - cam.x) * Math.min(1, 0.075 * k);
    cam.z += (t.z - cam.z) * Math.min(1, 0.06 * k);
    cam.shake = Math.min(3, cam.shake) * Math.pow(0.9, k);
    cam.sx = (this.rnd() - 0.5) * cam.shake * 1.5;
    cam.sy = (this.rnd() - 0.5) * cam.shake * 1.2;
    this.tsec += dt / 1000;
  }
  private targetCam = { x: 0, z: 0 };

  private bz(s: Int32Array, bo: number): number {
    const sd = s[bo + S.BSEED];
    return s[bo + S.BROW] ? KZ + 15 + (sd % 9) : KZ - 15 - (sd % 5);
  }

  /** public bridge: the exact frame the simulation tests and the renderer draws */
  frame(s: Int32Array, o: number): Frame {
    return animFrame(s, o, this.atlas.chars);
  }

  /** [x0,y0,x1,y1,halfWidth,super, r,g,b] of the active beam, or null */
  private beamInfo(s: Int32Array, o: number): number[] | null {
    const st = s[o + S.ST], t = s[o + S.T], ch = s[o + S.CHAR], c = S.CH[ch];
    let sup = 0;
    if (st === S.ST_BEAM) {
      if (t <= c.beamSu || t > c.beamSu + c.beamAc) return null;
    } else if (st === S.ST_SUPER) {
      if (t <= S.SUPER_SU || t > S.SUPER_SU + S.SUPER_AC) return null;
      sup = 1;
    } else return null;
    const e = o === S.F0 ? S.F1 : S.F0;
    const fr = this.frame(s, o), face = s[o + S.FACE];
    const X = s[o + S.X] * CM, Y = s[o + S.Y] * CM;
    const mx = X + face * fr.mouths[0] * PX_M, my = Y + fr.mouths[1] * PX_M;
    const d = (s[e + S.X] - s[o + S.X]) * face, reach = sup ? 30000 : c.beamReach;
    let ex: number, ey: number;
    const est = s[e + S.ST];
    if (d > 1000 && d < reach && est !== S.ST_DOWN && est !== S.ST_GETUP) {
      ex = s[e + S.X] * CM - face * 8;
      ey = s[e + S.Y] * CM + S.CH[s[e + S.CHAR]].height * CM * 0.55;
    } else {
      ex = X + face * reach * CM;
      ey = Math.max(2, my - (reach * CM * c.beamSlope) / 100);
    }
    const col = ch === 0 ? (sup ? [1, 0.25, 0.5] : [0.3, 0.75, 1]) : sup ? [1, 1, 0.8] : [1, 0.85, 0.25];
    return [mx, my, ex, ey, ch === 0 ? (sup ? 8 : 4.5) : sup ? 7 : 5, sup, col[0], col[1], col[2]];
  }
  private beamQuad(x0: number, y0: number, x1: number, y1: number, hw: number, r: number, g: number, b: number, mat: number, seed: number, sup: number) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = (-dy / L) * hw, ny = (dx / L) * hw, z = KZ - 2.5;
    this.add.quad(x0 + nx, y0 + ny, z, x1 + nx, y1 + ny, z, x0 - nx, y0 - ny, z, x1 - nx, y1 - ny, z, 0, -1, L, 1, r, g, b, 1, mat, seed, sup, 0);
  }

  private text(str: string, x: number, y: number, sc: number, r: number, g: number, b: number, align = 0) {
    const f = this.atlas.env.font, w = str.length * 6 * sc;
    let px = align === 1 ? x - w / 2 : align === 2 ? x - w : x;
    px = Math.round(px);
    for (let pass = 0; pass < 2; pass++) {
      let cx = px + (pass ? 0 : sc);
      const cy = y + (pass ? 0 : sc), k = pass ? 1 : 0.04;
      for (let i = 0; i < str.length; i++, cx += 6 * sc) {
        const gi = FONT_CHARS.indexOf(str[i]);
        if (gi < 0 || str[i] === " ") continue;
        const u = f[0] + (gi % 40) * 6, v = f[1] + Math.floor(gi / 40) * 8;
        this.hud.quad(cx, cy, 0, cx + 5 * sc, cy, 0, cx, cy + 7 * sc, 0, cx + 5 * sc, cy + 7 * sc, 0, u, v, u + 5, v + 7, r * k, g * k, b * k, 1, 0, 0, 0, 0);
      }
    }
  }
  private rect(x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
    this.hud.quad(x, y, 0, x + w, y, 0, x, y + h, 0, x + w, y + h, 0, 0, 0, 1, 1, r, g, b, 1, 2, 0, 0, 0);
  }

  private boxOverlay(x0: number, y0: number, x1: number, y1: number, z: number, r: number, g: number, b: number, a: number) {
    const t = 1.4;
    this.add.quad(x0, y1, z, x1, y1, z, x0, y1 - t, z, x1, y1 - t, z, 0, 0, 1, 1, r, g, b, a, 2, 0, 0, 0);
    this.add.quad(x0, y0 + t, z, x1, y0 + t, z, x0, y0, z, x1, y0, z, 0, 0, 1, 1, r, g, b, a, 2, 0, 0, 0);
    this.add.quad(x0, y1, z, x0 + t, y1, z, x0, y0, z, x0 + t, y0, z, 0, 0, 1, 1, r, g, b, a, 2, 0, 0, 0);
    this.add.quad(x1 - t, y1, z, x1, y1, z, x1 - t, y0, z, x1, y0, z, 0, 0, 1, 1, r, g, b, a, 2, 0, 0, 0);
  }

  /** same rule the simulation uses for ↓+grab */
  private ripTarget(s: Int32Array, o: number): number {
    const st = s[o + S.ST];
    if (st !== S.ST_IDLE && st !== S.ST_WALKF && st !== S.ST_WALKB) return -1;
    const face = s[o + S.FACE];
    let best = -1, bd = 1 << 30;
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N;
      if (s[bo + S.BHP] <= 0) continue;
      const rel = (s[bo + S.BX] - s[o + S.X]) * face;
      if (rel > -2600 && rel < 12000 && rel < bd) {
        bd = rel;
        best = i;
      }
    }
    return best;
  }

  /** F1 overlay: the exact boxes the simulation tests (limb volume + hurtbox) */
  private drawHitboxes(s: Int32Array) {
    if (!this.debug) return;
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, face = s[o + S.FACE];
      const X = s[o + S.X] * CM, Y = s[o + S.Y] * CM, z = KZ - 6;
      const hh = S.CH[s[o + S.CHAR]].height * CM;
      this.boxOverlay(X - 24, Y, X + 24, Y + hh, z + 1, 0.3, 0.9, 1, 0.6);
      const f = this.frame(s, o), act = s[o + S.ACT] > 0, mp = S.moveOf(o, s[o + S.ST], s[o + S.CHAR]);
      for (let p = 0; p < 6; p++) {
        const bx0 = f.parts[p * 4], by0 = f.parts[p * 4 + 1], bx1 = f.parts[p * 4 + 2], by1 = f.parts[p * 4 + 3];
        if (bx1 <= bx0 || by1 <= by0) continue;
        const ax = face > 0 ? bx0 : bx1, bx = face > 0 ? bx1 : bx0;
        const hit = act && !!mp && p === mp.part;
        this.boxOverlay(X + face * ax * PX_M - 3, Y + by0 * PX_M - 3, X + face * bx * PX_M + 3, Y + by1 * PX_M + 3, z, hit ? 1 : 0.85, hit ? 0.2 : 0.8, hit ? 0.15 : 0.3, hit ? 0.85 : 0.28);
      }
    }
    this.text("SIM HITBOXES ACTIVE", 320, 54, 1, 1, 0.35, 0.35, 1);
  }

  private drawHud(s: Int32Array, info: HudInfo) {
    const ph = s[S.G_PHASE], pt = s[S.G_PT], fr = s[S.G_FRAME];
    if (!info.demo) {
      for (let k = 0; k < 2; k++) {
        const o = k ? S.F1 : S.F0, e = k ? S.F0 : S.F1;
        const max = S.CH[s[o + S.CHAR]].hp, hp = Math.max(0, s[o + S.HP]);
        if (this.hpLag[k] < hp) this.hpLag[k] = hp;
        else this.hpLag[k] += (hp - this.hpLag[k]) * 0.06;
        const W = 262, w = Math.round((W * hp) / max), wl = Math.round((W * this.hpLag[k]) / max);
        const bx = k ? 354 : 24;
        this.rect(bx - 2, 12, W + 4, 14, 0.02, 0.02, 0.04);
        this.rect(bx - 1, 13, W + 2, 12, 0.8, 0.8, 0.85);
        this.rect(bx, 14, W, 10, 0.16, 0.03, 0.05);
        this.rect(k ? bx : bx + W - wl, 14, wl, 10, 0.95, 0.25, 0.15);
        const low = hp < max * 0.25;
        this.rect(k ? bx : bx + W - w, 14, w, 10, low ? 1 : 0.98, low ? 0.45 : 0.85, low ? 0.1 : 0.2);
        this.rect(k ? bx : bx + W - w, 14, w, 3, 1, 1, low ? 0.4 : 0.7);
        this.text(info.names[k], k ? 616 : 24, 29, 1, 1, 1, 1, k ? 2 : 0);
        for (let i = 0; i < 2; i++) {
          const won = i < s[o + S.WINS];
          this.rect(k ? 356 + i * 10 : 277 - i * 10, 29, 7, 7, 0.02, 0.02, 0.04);
          this.rect(k ? 357 + i * 10 : 278 - i * 10, 30, 5, 5, won ? 1 : 0.2, won ? 0.8 : 0.2, won ? 0.2 : 0.25);
        }
        // meter (4 stocks; full = SUPER)
        const mx = k ? 456 : 24, m = s[o + S.METER], full = m >= S.MAX_METER;
        this.rect(mx - 1, 339, 162, 9, 0.02, 0.02, 0.04);
        for (let i = 0; i < 4; i++) {
          const f = Math.max(0, Math.min(1, (m - i * 250) / 250));
          const sx = k ? mx + 160 - (i + 1) * 40 : mx + i * 40;
          this.rect(sx, 340, 39, 7, 0.08, 0.1, 0.16);
          const fw = Math.round(39 * f), pulse = full && (fr >> 2) & 1;
          const cc = s[o + S.CHAR] === 0 ? [0.3, 0.8, 1] : [1, 0.85, 0.25];
          if (fw > 0) this.rect(k ? sx + 39 - fw : sx, 340, fw, 7, pulse ? 1 : cc[0], pulse ? 1 : cc[1], pulse ? 1 : cc[2]);
        }
        this.text(full ? "SUPER READY!" : s[o + S.CHAR] === 0 ? "ATOMIC" : "GRAVITY", k ? 616 : 24, 329, 1, full ? 1 : 0.7, full ? 0.9 : 0.75, full ? 0.3 : 0.8, k ? 2 : 0);
        // combo counter (hits landed on the opponent)
        const cb = s[e + S.COMBO];
        if (cb >= 2) {
          this.text(cb + " HITS", k ? 616 : 24, 52, 2, 1, 0.85, 0.2, k ? 2 : 0);
          this.text(s[e + S.CDMG] + " DMG", k ? 616 : 24, 69, 1, 1, 1, 1, k ? 2 : 0);
        }
      }
      const sec = Math.ceil(s[S.G_TIMER] / 60);
      this.rect(302, 8, 36, 22, 0.02, 0.02, 0.04);
      this.text((sec < 10 ? "0" : "") + sec, 320, 12, 2, 1, sec <= 10 ? 0.3 : 0.95, sec <= 10 ? 0.2 : 0.6, 1);
      const hv = s[S.G_HAVOC];
      this.text("CITY DAMAGE $" + (hv / 10).toFixed(1) + "B", 320, 42, 1, 1, 0.6, 0.3, 1);
      // announcer
      if (ph === S.PH_INTRO) {
        if (pt < 75) this.text("ROUND " + s[S.G_ROUND], 320, 150, 4, 1, 0.9, 0.3, 1);
      } else if (ph === S.PH_FIGHT && pt < 45) this.text("FIGHT!", 320, 146, 5, 1, 0.35, 0.15, 1);
      else if (ph === S.PH_KO && pt < 150) {
        const kb = s[S.G_KOBY], to = s[S.G_TIMER] <= 0;
        this.text(to ? "TIME UP" : kb === 3 ? "DOUBLE K.O." : "K.O.", 320, 140, to || kb === 3 ? 4 : 7, 1, 0.25, 0.1, 1);
      } else if (ph === S.PH_END) {
        const w = s[S.G_WINNER];
        this.text(w === 3 ? "DRAW" : info.names[w - 1] + " WINS", 320, 120, 3, 1, 0.9, 0.3, 1);
        this.text(s[S.F0 + S.HAVOC] + s[S.F1 + S.HAVOC] + " BUILDINGS DESTROYED", 320, 152, 1, 1, 1, 1, 1);
      }
      if (this.clash > 0) this.text("CITY ROARS!", 320, 258, 2, 1, 0.45 + 0.2 * Math.sin(this.tsec * 20), 0.2, 1);
      if (this.hint) this.text("DOWN + GRAB: RIP A BUILDING", 320, 316, 1, 1, 0.82, 0.35, 1);
      if (info.net) {
        const n = info.net;
        this.text((n.relay ? "RELAY " : "P2P ") + "PING " + Math.round(n.rtt) + "MS  ROLLBACK " + n.rollback + "F  DELAY " + n.delay + "F", 320, 348, 1, 0.5, 0.9, 0.6, 1);
        if (n.silentMs > 700) this.text("WAITING FOR OPPONENT...", 320, 200, 2, 1, 0.8, 0.2, 1);
        if (n.desync) this.text("DESYNC DETECTED", 320, 222, 1, 1, 0.2, 0.2, 1);
      }
    }
    if (info.banner) this.text(info.banner, 320, 300, 1, 1, 1, 1, 1);
  }

  resize() {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(RW, Math.round(c.clientWidth * dpr)), h = Math.max(RH, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  draw(s: Int32Array, info: HudInfo) {
    const gl = this.gl, cam = this.cam, dyn = this.dyn, add = this.add;
    const fr = s[S.G_FRAME];
    dyn.n = add.n = this.hud.n = 0;
    const supBy = s[S.G_FREEZE] > 0 ? s[S.G_FRZBY] : s[S.F0 + S.ST] === S.ST_SUPER ? 0 : s[S.F1 + S.ST] === S.ST_SUPER ? 1 : -1;
    const dark = s[S.G_FREEZE] > 0 ? 1 : supBy >= 0 ? 0.45 : 0;

    // ---- view-projection (street-level eye, pitched up)
    const cx = cam.x + cam.sx, cy = 1.7 + cam.sy * 0.4, cz = cam.z;
    const sn = Math.sin(PITCH + cam.sy * 0.004), cs = Math.cos(PITCH + cam.sy * 0.004), aspect = RW / RH;
    const sx = 1 / (TANF * aspect), sy = 1 / TANF, A = (FAR + NEAR) / (FAR - NEAR), B = (-2 * FAR * NEAR) / (FAR - NEAR);
    const tw = -cy * sn - cz * cs, m = this.vp;
    m[0] = sx; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = sy * cs; m[6] = A * sn; m[7] = sn;
    m[8] = 0; m[9] = -sy * sn; m[10] = A * cs; m[11] = cs;
    m[12] = -sx * cx; m[13] = sy * (-cy * cs + cz * sn); m[14] = A * tw + B; m[15] = tw;

    // ---- destructible lane buildings (+ which one can be ripped right now)
    const tgt0 = this.ripTarget(s, S.F0), tgt1 = this.ripTarget(s, S.F1);
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N;
      const x = s[bo + S.BX] * CM, hw = s[bo + S.BW] * CM, h = s[bo + S.BH] * CM, sd = s[bo + S.BSEED], z = this.bz(s, bo);
      const col = WALLS[sd % 5];
      if (s[bo + S.BHP] > 0) {
        const dmg = 1 - s[bo + S.BHP] / (s[bo + S.BROW] ? 260 : 130);
        const j = dmg > 0 ? (hash2(fr, i) - 0.5) * dmg * 1.2 : 0;
        this.box(dyn, x + j, z, hw, hw * 1.5, h, 0, col, sd & 255, 0.8, true);
        const owner = tgt0 === i ? 0 : tgt1 === i ? 1 : -1;
        if (owner >= 0) {
          // rip telegraph: pulsing outline + rising chevrons (brighter while DOWN is held)
          const armed = (this.hint >> (owner * 2)) & 1;
          const pul = 0.5 + 0.5 * Math.sin(this.tsec * (armed ? 16 : 7) + i);
          const zf = z - hw * 0.78;
          this.boxOverlay(x - hw, 0, x + hw, Math.max(6, h), zf, 1, 0.85, 0.3, 0.25 + pul * 0.35 + (armed ? 0.2 : 0));
          for (let c2 = 0; c2 < 3; c2++) {
            const cy = 4 + ((this.tsec * (armed ? 26 : 13) + c2 * 11 + i * 2) % Math.max(12, h - 8));
            this.add.quad(x - hw * 0.5, cy + 2.4, zf, x + hw * 0.5, cy + 2.4, zf, x - hw * 0.5, cy, zf, x + hw * 0.5, cy, zf, 0, 0, 1, 1, 1, 0.92, 0.45, pul * (armed ? 0.95 : 0.6), 2, 0, 0, 0);
          }
          // little "grab me" arrow above the roof
          const ay = Math.min(h + 2, h + 4 + pul * 2);
          const zz = zf, ab = 1.9;
          const quad = (x0: number, x1: number, y0: number, y1: number) => this.add.quad(x0, y1, zz, x1, y1, zz, x0, y0, zz, x1, y0, zz, 0, 0, 1, 1, 1, 0.95, 0.5, pul * (armed ? 1 : 0.7), 2, 0, 0, 0);
          quad(x - 3.4, x + 3.4, ay + 3.6, ay + 3.6 + ab * 2);
          for (let a2 = 0; a2 < 4; a2++) {
            const w2 = 3.4 - a2 * 0.85, y2 = ay + 3.2 - a2 * 1.6;
            quad(x - w2, x + w2, y2, y2 + 1.5);
          }
        }
      } else {
        const age = fr - s[bo + S.BDT];
        if (age < 55 && !s[bo + S.BFL]) {
          const k = age / 55;
          this.box(dyn, x + (hash2(fr, i) - 0.5) * 1.6, z, hw, hw * 1.5, h, h * k * k, col, sd & 255, 0.8, true);
        }
        const rh = Math.min(9, 3 + h * 0.08);
        this.sprite(dyn, "rubble", x, 0, z - hw * 0.75 - 0.5, hw * 2.8, rh, (sd & 1) === 1, 1, 1, 1);
        if (age < 1500)
          for (let f = 0; f < 2; f++) {
            const fx = x + (hash2(sd, f) - 0.5) * hw * 2, fs = 5 + hash2(sd, f + 5) * 5;
            this.sprite(add, "flame" + ((((fr >> 3) + f + i) % 3) | 0), fx, rh * 0.3, z - hw * 0.75 - 1, fs, fs * 1.4, ((fr >> 4) & 1) === f, 1, 1, 1);
          }
      }
    }

    // ---- kaiju
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, e = k ? S.F0 : S.F1;
      const st = s[o + S.ST], t = s[o + S.T], ch = s[o + S.CHAR], c = S.CH[ch];
      const f = this.frame(s, o);
      const face = s[o + S.FACE] * (f.flip ? -1 : 1);
      const stopped = s[o + S.STOP] > 0 && (st === S.ST_HIT || st === S.ST_LAUNCH || st === S.ST_BLOCK);
      const X = s[o + S.X] * CM + (stopped ? (hash2(fr, k) - 0.5) * 1.6 : 0), Y = s[o + S.Y] * CM;
      const atk = st >= S.ST_LIGHT && st <= S.ST_ENV;
      const z = KZ + (atk ? -1.2 : k * 0.6);
      let glow = 0, gcol = ch;
      if (st === S.ST_BEAM) glow = t <= c.beamSu ? t / c.beamSu : t <= c.beamSu + c.beamAc ? 1 : Math.max(0, 1 - (t - c.beamSu - c.beamAc) / c.beamRc);
      else if (st === S.ST_SUPER) {
        glow = t === 0 ? Math.min(1, (S.SUPER_FREEZE - s[S.G_FREEZE]) / 30) : t <= S.SUPER_SU + S.SUPER_AC ? 1 : Math.max(0, 1 - (t - S.SUPER_SU - S.SUPER_AC) / S.SUPER_RC);
        gcol = ch + 2;
      }
      let tr = 1, tg = 1, tb = 1;
      if (k === 1 && s[e + S.CHAR] === ch) {
        tr = 0.8; tg = 0.95; tb = 1.3; // mirror match palette
      }
      if (supBy === k) {
        tr *= 1.9; tg *= 1.9; tb *= 1.9;
      }
      const fl = stopped ? (st === S.ST_BLOCK ? 0.2 : 0.38) : 0;
      const xl = X + face * f.ox * PX_M, xr = X + face * (f.ox + f.w) * PX_M, yt = Y + f.oy * PX_M, yb = Y + (f.oy - f.h) * PX_M;
      dyn.quad(xl, yt, z, xr, yt, z, xl, yb, z, xr, yb, z, f.x, f.y, f.x + f.w, f.y + f.h, tr, tg, tb, 1, 0, f.l, Math.min(0.999, glow) + gcol * 2, fl);
      // a skyscraper torn out of the street: hoisted overhead, then hurled
      if (st === S.ST_ENV) {
        const cs2 = this.atlas.env.chunk;
        const lift = Math.min(1, t / 24), rel = t >= S.ENV_REL ? Math.min(1, (t - S.ENV_REL) / 12) : 0;
        const hx = X + face * f.hand[0] * PX_M * 0.85 + face * rel * 20;
        const hy = Y + 44 + 46 * lift + f.hand[1] * PX_M * 0.25 + rel * 14;
        const bw = 40 + 16 * lift, bh = 58 + 30 * lift;
        const ang = (1 - lift) * 0.45 + rel * 1.1, ca = Math.cos(ang), sa = Math.sin(ang) * face;
        const cx = hx, cy = hy + bh * 0.5;
        const px = (dx: number, dy: number) => cx + dx * ca - dy * sa, py = (dx: number, dy: number) => cy + dx * sa + dy * ca;
        const zb = z - 0.8;
        dyn.quad(px(-bw / 2, bh / 2), py(-bw / 2, bh / 2), zb, px(bw / 2, bh / 2), py(bw / 2, bh / 2), zb, px(-bw / 2, -bh / 2), py(-bw / 2, -bh / 2), zb, px(bw / 2, -bh / 2), py(bw / 2, -bh / 2), zb, cs2[0], cs2[1], cs2[0] + cs2[2], cs2[1] + cs2[3], 1, 1, 1, 1, 0, 0, 0, 0);
        if ((fr & 1) === 0) this.spawn(1, 0, hx, hy - bh * 0.45, zb, (this.rnd() - 0.5) * 0.5, -0.12 - this.rnd() * 0.2, 0, 34, 2.4 + this.rnd() * 3, 0, 0.6, 0.55, 0.5);
      }
      // beams
      const bm = this.beamInfo(s, o);
      if (bm) {
        if (ch === 0) this.beamQuad(bm[0], bm[1], bm[2], bm[3], bm[4], bm[6], bm[7], bm[8], 4, 0, bm[5]);
        else for (let h = 0; h < 3; h++) this.beamQuad(X + face * f.mouths[h * 2] * PX_M, Y + f.mouths[h * 2 + 1] * PX_M, bm[2], bm[3] + (h - 1) * 9, bm[4], bm[6], bm[7], bm[8], 5, h + 1, bm[5]);
        const fs = 14 + hash2(fr, 3) * 10;
        this.sprite(add, "flame" + (fr % 3), bm[2], bm[3] - fs * 0.6, KZ - 3, fs, fs * 1.3, (fr & 2) === 0, bm[6], bm[7], bm[8]);
      }
    }

    // ---- thrown building chunks
    for (let i = 0; i < S.NP; i++) {
      const po = S.P0 + i * S.P_N;
      if (!s[po + S.PT]) continue;
      const x = s[po + S.PX] * CM, y = s[po + S.PY] * CM, a = (fr + s[po + S.PSEED]) * 0.09 * (s[po + S.PVX] > 0 ? -1 : 1);
      const ca = Math.cos(a), sa = Math.sin(a), hw = 14, hh = 18, cs2 = this.atlas.env.chunk, z = KZ - 2;
      dyn.quad(x - hw * ca - hh * sa, y - hw * sa + hh * ca, z, x + hw * ca - hh * sa, y + hw * sa + hh * ca, z, x - hw * ca + hh * sa, y - hw * sa - hh * ca, z, x + hw * ca + hh * sa, y + hw * sa - hh * ca, z, cs2[0], cs2[1], cs2[0] + cs2[2], cs2[1] + cs2[3], 1, 1, 1, 1, 0, 0, 0, 0);
    }

    // ---- crowd, helicopters
    const h = this.hum;
    for (let i = 0; i < 72; i++) {
      const o = i * 5, tn = SHIRT[h[o + 4] | 0], big = i < 5, dk = big ? 0.12 : 0.55;
      this.sprite(dyn, big || ((fr >> 3) + i) & 1 ? "manA" : "manB", h[o], 0, h[o + 1], 1, 1.8, h[o + 2] < 0, tn[0] * dk, tn[1] * dk, tn[2] * dk);
    }
    for (let i = 0; i < 2; i++) {
      const a = this.time * 0.22 + i * 2.6, hx = cam.x + Math.sin(a) * (95 + i * 30), hz = KZ - 28 + Math.cos(a) * 22;
      this.sprite(dyn, "heli" + ((fr >> 1) & 1), hx, 68 + i * 26 + Math.sin(a * 3) * 3, hz, 15, 6, Math.cos(a) > 0, 1, 1, 1);
    }

    // ---- particles
    const { pp, pl, pc, pk } = this;
    for (let i = 0; i < NPART; i++) {
      if (pl[i * 4] <= 0) continue;
      const k = pk[i * 2], sz = pl[i * 4 + 2], life = pl[i * 4] / pl[i * 4 + 1];
      const x = pp[i * 3], y = pp[i * 3 + 1], z = pp[i * 3 + 2];
      if (k === 3) {
        const sp = this.atlas.env.spark;
        add.quad(x - sz / 2, y + sz / 2, z, x + sz / 2, y + sz / 2, z, x - sz / 2, y - sz / 2, z, x + sz / 2, y - sz / 2, z, sp[0], sp[1], sp[0] + 1, sp[1] + 1, pc[i * 3] * life, pc[i * 3 + 1] * life, pc[i * 3 + 2] * life, 1, 0, 0, 0, 0);
      } else {
        const sp = this.atlas.env[(k === 1 ? "deb" : "puff") + pk[i * 2 + 1]];
        dyn.quad(x - sz / 2, y + sz / 2, z, x + sz / 2, y + sz / 2, z, x - sz / 2, y - sz / 2, z, x + sz / 2, y - sz / 2, z, sp[0], sp[1], sp[0] + sp[2], sp[1] + sp[3], pc[i * 3], pc[i * 3 + 1], pc[i * 3 + 2], k === 1 ? 1 : Math.min(1, life * 1.6), 0, 0, 0, 0);
      }
    }

    this.drawHitboxes(s);
    this.drawHud(s, info);

    // ================= GPU passes =================
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // sky
    gl.useProgram(this.pSky);
    gl.uniform1f(this.U.suPitch, PITCH);
    gl.uniform1f(this.U.suTanF, TANF);
    gl.uniform1f(this.U.suAspect, aspect);
    gl.uniform1f(this.U.suCamX, cam.x);
    gl.uniform1f(this.U.suTime, this.time);
    gl.uniform1f(this.U.suFlash, supBy >= 0 && s[supBy ? S.F1 + S.CHAR : S.F0 + S.CHAR] === 1 && hash2(fr >> 2, 9) > 0.5 ? 1 : 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // world (opaque, depth tested, alpha cut-out)
    gl.useProgram(this.pWorld);
    gl.uniformMatrix4fv(this.U.wuVP, false, m);
    gl.uniform1i(this.U.wuAtlas, 0);
    gl.uniform1f(this.U.wuTime, this.time);
    gl.uniform1f(this.U.wuFog, 1 / 1100);
    gl.uniform1f(this.U.wuAmb, 1 - dark * 0.6);
    gl.enable(gl.DEPTH_TEST);
    this.stat.draw();
    dyn.upload();
    dyn.draw();
    // additive (beams, lightning, fire, sparks)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.uniform1f(this.U.wuFog, 0);
    gl.uniform1f(this.U.wuAmb, 1);
    add.upload();
    add.draw();
    // HUD (same program, orthographic)
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(this.U.wuVP, false, this.ortho);
    this.hud.upload();
    this.hud.draw();
    // upscale to the display
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.pPost);
    gl.uniform1i(this.U.puTex, 1);
    gl.uniform2f(this.U.puRes, RW, RH);
    gl.uniform1f(this.U.puFlash, Math.min(0.8, this.flash));
    gl.uniform1f(this.U.puZoom, 1 + this.imp * 0.02 + (this.clash > 0 ? 0.004 : 0));
    gl.uniform1f(this.U.puDark, 0);
    gl.uniform1f(this.U.puAber, this.aber);
    gl.uniform1f(this.U.puScan, this.scan ? 1 : 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
