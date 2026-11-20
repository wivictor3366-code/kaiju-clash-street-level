// WebGL2 renderer.
//  * The world is real 3D geometry seen through a street-level camera (eye height 1.7 m)
//    pitched upward with a wide FOV: verticals converge, kaiju tower, people are specks.
//  * 2.5D: kaiju, towers, beams, hurled towers and people all live on the street plane (x, z).
//    Depth reads through perspective scale, occlusion by towers and a top-down radar.
//  * Everything renders into a 640x360 framebuffer (pixel art resolution) and is upscaled
//    with a sharp-bilinear pass. Depth buffer + alpha cut-out => no CPU sorting.
//  * One texture array holds every code-drawn sprite; geometry is batched into four
//    vertex buffers => ~6 draw calls per frame. Facades, ground, sky, beams and
//    lightning are procedural fragment shaders (zero texture memory).
//  * A ripped tower is the real facade box, pinned to the baked hand / jaw anchor of the very
//    frame being drawn and rotated rigidly about the grip point, so it never drifts off the
//    hands; when hurled, the flight starts from the last held pose (no pop).
//  * Emissive regions (dorsal plates, throats, eyes) are encoded in sprite alpha so the
//    GPU animates the charge-up glow sweep without extra frames.
import type { Atlas, Frame } from "./art/atlas";
import { PAGE, PX_M } from "./art/atlas";
import { FONT_CHARS } from "./art/env";
import { hash2 } from "./art/raster";
import { iconRuns, POWER_ICON } from "./art/icons";
import * as S from "./sim";
import type { NetStats } from "./net";
import { tw, tf } from "./timing";
import { animFrame, gripHand } from "./anim";

export const RW = 640, RH = 360;
const KZ = 130, PITCH = (24 * Math.PI) / 180, TANF = Math.tan((33 * Math.PI) / 180), NEAR = 1, FAR = 2600;
const CM = 0.01, VS = 13, NPART = 1400;
const NEAR_H = 44, FAR_H = 110, SOLD_H = 16, NH = NEAR_H + FAR_H + SOLD_H;

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

interface BeamHead { x0: number; y0: number; x1: number; y1: number }
interface Beam { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; hw: number; sup: number; r: number; g: number; b: number; heads: BeamHead[] }
const PWC = [[1, 1, 1], [1, 0.32, 0.2], [0.62, 0.78, 1], [0.3, 0.95, 1], [0.4, 1, 0.45]];
interface Heli { a: number; r: number; h: number; x: number; y: number; z: number; alive: boolean; vx: number; vy: number; dead: number }
interface Missile { sx: number; sy: number; sz: number; tx: number; ty: number; tz: number; t: number; dur: number; arc: number }
interface Jet { x: number; y: number; z: number; vx: number; fired: boolean; tx: number; ty: number; tz: number }
interface Held { bx: number; by: number; x: number; y: number; z: number; a: number; hw: number; f: number }
interface PVis { seed: number; ox: number; oy: number; oz: number; k: number; a0: number; f0: number }

const WALLS = [[0.3, 0.33, 0.4], [0.38, 0.33, 0.3], [0.26, 0.3, 0.33], [0.42, 0.4, 0.38], [0.33, 0.28, 0.36]];
const SHIRT = [[0.9, 0.3, 0.3], [0.3, 0.5, 0.9], [0.9, 0.85, 0.5], [0.5, 0.8, 0.5], [0.85, 0.85, 0.9], [0.7, 0.4, 0.8]];
const COMBO_NAMES: [number, string][] = [[12, "KING OF THE MONSTERS!"], [9, "CATACLYSMIC!"], [7, "DEVASTATING!"], [5, "BRUTAL!"], [3, "NICE!"]];

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
  private alarm = 0;
  private alarmX = 0;
  private cheer = 0;
  private armyT = 0;
  private armyTg = 0;
  private roarT = [0, 0];
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
  // people: 0 strolling, 1 fleeing, 2 tossed through the air, 3 cowering, 4 cheering, 5 soldier holding the line
  private hx = new Float32Array(NH);
  private hz = new Float32Array(NH);
  private hy = new Float32Array(NH);
  private hvx = new Float32Array(NH);
  private hvz = new Float32Array(NH);
  private hvy = new Float32Array(NH);
  private ht = new Float32Array(NH);
  private hsp = new Float32Array(NH);
  private hs = new Uint8Array(NH);
  private htn = new Uint8Array(NH);
  // military
  private helis: Heli[] = [];
  private missiles: Missile[] = [];
  private jets: Jet[] = [];
  // ripped towers: last drawn held pose per fighter + per-projectile hand-off
  private notes = [0, 1].map(() => ({ t: 0, text: "", r: 1, g: 1, b: 1 }));
  private objAlert = 0;
  // ---- teaching: one pictogram at a time, anchored to the kaiju, advanced by what the player actually does
  coachOn = [false, false];
  private localKeys = false;
  private coach = [0, 1].map(() => ({ done: [false, false, false, false, false], cur: -1, t: 0, wait: 40, flash: 0, dist: 0, lastX: 0, f: 0 }));
  /** world-anchored icon pops (objective complete, power-up, blast ...) */
  private pops: { x: number; y: number; z: number; icon: string; t: number; max: number; r: number; g: number; b: number }[] = [];
  private held: Held[] = [0, 1].map(() => ({ bx: 0, by: 0, x: 0, y: 0, z: 0, a: 0, hw: 0, f: -99 }));
  private pvis: PVis[] = [];
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
    this.dyn = new Batch(gl, 3600, ibo, true);
    this.add = new Batch(gl, 1600, ibo, true);
    this.hud = new Batch(gl, 1600, ibo, true);
    this.buildStatic();
    for (let i = 0; i < NH; i++) this.spawnHuman(i);
    for (let i = 0; i < 3; i++) this.helis.push({ a: i * 2.1, r: 95 + i * 30, h: 66 + i * 22, x: 0, y: 0, z: 0, alive: true, vx: 0, vy: 0, dead: 0 });
    for (let i = 0; i < S.NP; i++) this.pvis.push({ seed: -1, ox: 0, oy: 0, oz: 0, k: 0, a0: 0, f0: 0 });
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
    if (!s) return;
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
  /** a free (rotated) tower: real facade box. (bx,by) = base centre, phi = world rotation (CCW), z = depth centre */
  private tower(b: Batch, bx: number, by: number, z: number, hw: number, h: number, phi: number, seed: number) {
    const col = WALLS[seed % 5], c = Math.cos(phi), s = Math.sin(phi), dz = hw * 0.75;
    const px = (u: number, v: number) => bx + u * c - v * s, py = (u: number, v: number) => by + u * s + v * c;
    const tlx = px(-hw, h), tly = py(-hw, h), trx = px(hw, h), try_ = py(hw, h), blx = px(-hw, 0), bly = py(-hw, 0), brx = px(hw, 0), bry = py(hw, 0);
    const z0 = z - dz, z1 = z + dz, sd = seed & 255;
    b.quad(tlx, tly, z0, trx, try_, z0, blx, bly, z0, brx, bry, z0, 0, 0, hw * 2, h, col[0], col[1], col[2], 1, 1, sd, 0.8, 0);
    const r = col[0] * 0.66, g = col[1] * 0.66, bl = col[2] * 0.7;
    b.quad(tlx, tly, z0, tlx, tly, z1, blx, bly, z0, blx, bly, z1, 0, 0, dz * 2, h, r, g, bl, 1, 1, sd + 3, 0.8, 0);
    b.quad(trx, try_, z0, trx, try_, z1, brx, bry, z0, brx, bry, z1, 0, 0, dz * 2, h, r, g, bl, 1, 1, sd + 5, 0.8, 0);
    b.quad(tlx, tly, z1, trx, try_, z1, tlx, tly, z0, trx, try_, z0, 0, 0, 1, 1, col[0] * 0.45, col[1] * 0.45, col[2] * 0.5, 1, 2, 0, 0, 0);
    // torn foundations: soil, rebar and broken slab
    b.quad(blx, bly, z0, brx, bry, z0, blx, bly, z1, brx, bry, z1, 0, 0, 1, 1, 0.17, 0.11, 0.07, 1, 2, 0, 0, 0);
  }
  private flat(b: Batch, x0: number, y0: number, x1: number, y1: number, z: number, r: number, g: number, bl: number) {
    b.quad(x0, y1, z, x1, y1, z, x0, y0, z, x1, y0, z, 0, 0, 1, 1, r, g, bl, 1, 2, 0, 0, 0);
  }
  private buildStatic() {
    const b = this.stat, gl = this.gl;
    b.n = 0;
    // ground
    b.quad(-1600, 0, 1800, 1600, 0, 1800, -1600, 0, -90, 1600, 0, -90, -1600, 1800, 1600, -90, 1, 1, 1, 1, 3, 0, 0, 0);
    // distant skyline (three depth rows, behind the fighting plane)
    for (let row = 0; row < 3; row++) {
      const z = [228, 320, 470][row], step = [38, 52, 70][row];
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
    // army dug in on the far bank, in front of the city blocks
    this.tanks = [];
    for (let i = 0; i < 9; i++) {
      const x = -200 + i * 50 + hash2(i, 21) * 20;
      this.tanks.push(x);
      this.sprite(b, "tank", x, 0, 92.5 + hash2(i, 22) * 1.5, 7.9, 3.1, i % 2 === 0, 1, 1, 1);
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
  /** expanding ring of dust on the street plane (roars, club smashes) */
  private ring(x: number, z: number, n: number, sp: number, size: number) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rnd() * 0.3, sh = 0.55 + this.rnd() * 0.2;
      this.spawn(0, Math.floor(this.rnd() * 3), x + Math.cos(a) * 6, 1 + this.rnd() * 3, z + Math.sin(a) * 4, Math.cos(a) * sp, 0.04 + this.rnd() * 0.06, Math.sin(a) * sp * 0.7, 60 + this.rnd() * 40, size, 0.1, sh, sh * 0.85, sh * 0.75);
    }
  }
  private missile(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, dur: number, arc: number) {
    if (this.missiles.length < 40) this.missiles.push({ sx, sy, sz, tx, ty, tz, t: 0, dur, arc });
  }

  // ------------------------------------------------------------ people
  private spawnHuman(i: number) {
    const cx = this.cam.x;
    this.hy[i] = this.hvy[i] = this.hvz[i] = 0;
    this.ht[i] = 0;
    this.htn[i] = Math.floor(this.rnd() * 6);
    this.hvx[i] = this.rnd() < 0.5 ? -1 : 1;
    if (i < NEAR_H) {
      // sidewalk + road right in front of the camera (the "you are 1.7 m tall" reference)
      this.hx[i] = cx + (this.rnd() - 0.5) * 150;
      this.hz[i] = i < 6 ? 5.6 + this.rnd() * 1.6 : 10.5 + this.rnd() * 18;
      this.hsp[i] = i < 6 ? 0 : 0.06 + this.rnd() * 0.07;
      this.hs[i] = 0;
    } else if (i < NEAR_H + FAR_H) {
      // civilians in the city blocks the monsters are fighting through
      this.hx[i] = cx + (this.rnd() - 0.5) * 260;
      this.hz[i] = 97 + this.rnd() * 104;
      this.hsp[i] = 0.03 + this.rnd() * 0.05;
      this.hs[i] = 0;
    } else {
      // soldiers beside the tanks
      const t = this.tanks[(i - NEAR_H - FAR_H) % Math.max(1, this.tanks.length)] ?? 0;
      this.hx[i] = t + (this.rnd() - 0.5) * 14;
      this.hz[i] = 88.5 + this.rnd() * 3;
      this.hsp[i] = 0.05;
      this.hs[i] = 5;
    }
  }
  /** shockwave: far-bank people inside r are thrown, people further out start running */
  private toss(x: number, z: number, r: number, pow: number) {
    for (let i = NEAR_H; i < NH; i++) {
      if (this.hs[i] === 2) continue;
      const dx = this.hx[i] - x, dz = this.hz[i] - z, d = Math.sqrt(dx * dx + dz * dz) + 0.01;
      if (d > r) {
        if (d < r * 2.4 && this.hs[i] !== 5) {
          this.hs[i] = 1;
          this.ht[i] = 110 + this.rnd() * 60;
        }
        continue;
      }
      const k = (1 - d / r) * pow;
      this.hs[i] = 2;
      this.hy[i] = 0.01;
      this.hvy[i] = 0.16 + k * 0.45 + this.rnd() * 0.1;
      this.hvx[i] = (dx / d) * k * 0.42 + (this.rnd() - 0.5) * 0.1;
      this.hvz[i] = (dz / d) * k * 0.3;
    }
  }
  /** a tower coming down: its occupants pour out of the lobby and scatter */
  private evacuate(x: number, z: number, hw: number, n: number) {
    for (let j = 0; j < n; j++) {
      const i = NEAR_H + Math.floor(this.rnd() * FAR_H);
      if (this.hs[i] === 2) continue;
      this.hx[i] = x + (this.rnd() - 0.5) * hw * 2;
      this.hz[i] = z - hw * 0.8 - this.rnd() * 3;
      this.hy[i] = 0;
      this.hs[i] = 1;
      this.ht[i] = 150 + this.rnd() * 60;
    }
  }
  private alarmAt(x: number) {
    this.alarm = 260;
    this.alarmX = x;
  }

  /** presentation reaction to a simulation event (d = depth in cm when relevant) */
  event(type: number, a: number, b: number, c: number, d = 0) {
    const cam = this.cam, ez = KZ + d * CM;
    switch (type) {
      case S.EV_STEP:
        cam.shake += 0.4;
        this.dust(a * CM, 0, ez - 3, 4, 26, 9);
        this.toss(a * CM, ez, 9, 0.5);
        break;
      case S.EV_SIDE:
        this.dust(b * CM, 0, ez - 3, 7, 30, 10);
        break;
      case S.EV_HIT: {
        const heavy = b === S.K_BEAM ? 0.4 : b === S.K_LIGHT || b === S.K_LIGHT2 ? 0.6 : b === S.K_SUPER ? 0.7 : 1;
        this.imp = Math.max(this.imp, Math.min(1, 0.3 + c / 95) * (0.6 + heavy * 0.8));
        cam.shake += Math.min(2.6, 0.5 + c / 70) * (0.7 + heavy * 0.7);
        this.flash = Math.max(this.flash, Math.min(0.5, c / 220));
        this.aber = Math.max(this.aber, Math.min(3, c / 38));
        this.sparks(a * CM, 55 + this.rnd() * 35, ez - 4, 10 + Math.round(c / 12) * 2, 1, 0.72, 0.28);
        this.dust(a * CM, 50, ez - 3, 3 + Math.round(heavy * 4), 24, 11);
        if (heavy > 0.6) this.debris(a * CM, 62, ez - 4, 10, 0.9);
        if (b === S.K_OTG) this.toss(a * CM, ez, 24, 0.9);
        break;
      }
      case S.EV_CLASH: {
        this.clash = Math.max(this.clash, 100);
        cam.shake += 1.8;
        this.flash = Math.max(this.flash, 0.25);
        this.aber = 3;
        this.sparks(a * CM, 70, ez - 4, 26, 1, 0.95, 0.6);
        this.dust(a * CM, 40, ez - 4, 8, 40, 14);
        break;
      }
      case S.EV_BLOCK:
        cam.shake += 0.3;
        this.sparks(a * CM, 60 + this.rnd() * 30, ez - 4, 8, 0.6, 0.8, 1);
        break;
      case S.EV_COLLAPSE:
        cam.shake += 0.8;
        this.dust(b * CM, 0, ez - 4, 16, 34, 16);
        this.debris(b * CM, c * CM * 0.4, ez - 4, 18, 0.9);
        this.evacuate(b * CM, ez, 8, 6);
        this.toss(b * CM, ez, 22, 0.8);
        this.alarmAt(b * CM);
        break;
      case S.EV_RIP:
        // the foundations let go: a burst of soil, rebar and slabs, severed mains arcing, shockwave ring
        cam.shake += 1.8;
        this.flash = Math.max(this.flash, 0.18);
        this.aber = Math.max(this.aber, 1.5);
        this.dust(b * CM, 0, ez - 4, 28, 44, 16);
        this.debris(b * CM, 6, ez - 4, 48, 1.1);
        this.sparks(b * CM, 8, ez - 5, 20, 0.55, 0.8, 1);
        this.ring(b * CM, ez, 22, 0.6, 15);
        this.evacuate(b * CM, ez, 8, 5);
        this.toss(b * CM, ez, 26, 1);
        this.alarmAt(b * CM);
        break;
      case S.EV_CRASH:
        cam.shake += 1.1;
        this.flash = Math.max(this.flash, 0.15);
        this.debris(a * CM, b * CM + 25, ez - 4, 22, 1.5);
        this.dust(a * CM, b * CM + 20, ez - 4, 8, 30, 14);
        break;
      case S.EV_SLAM:
        cam.shake += 1.7;
        this.dust(a * CM, 0, ez - 5, 20, 90, 15);
        this.debris(a * CM, 2, ez - 5, 10, 1.1);
        this.toss(a * CM, ez, 45, 1.2);
        this.alarmAt(a * CM);
        break;
      case S.EV_CHUNK: {
        const big = Math.min(2, 0.6 + c / 5000);
        cam.shake += big;
        this.debris(a * CM, b * CM, ez - 4, Math.round(24 * big), 1.4);
        this.dust(a * CM, b * CM, ez - 4, Math.round(10 * big), 30 * big, 14);
        if (b <= 0) this.toss(a * CM, ez, 34 * big, 1.1);
        this.alarmAt(a * CM);
        break;
      }
      case S.EV_BSMASH:
        cam.shake += 2.4;
        this.flash = Math.max(this.flash, 0.3);
        this.imp = 1;
        this.aber = 3;
        this.debris(a * CM, 4, ez - 4, 44, 1.8);
        this.dust(a * CM, 0, ez - 4, 24, 70, 18);
        this.ring(a * CM, ez, 18, 0.55, 12);
        this.toss(a * CM, ez, 55, 1.4);
        this.alarmAt(a * CM);
        break;
      case S.EV_KO:
        cam.shake += 2.2;
        this.flash = 0.7;
        this.cheer = 300;
        break;
      case S.EV_SUPER:
        this.flash = 0.35;
        this.alarmAt(cam.x);
        break;
      case S.EV_ROAR: {
        cam.shake += 1.5;
        this.roarT[a & 1] = 70;
        this.aber = Math.max(this.aber, 2);
        this.ring(b * CM, ez, 22, 0.7, 14);
        // everyone within earshot freezes in terror, then bolts
        for (let i = 0; i < NH; i++) {
          const near = i < NEAR_H, dx = this.hx[i] - b * CM, dz = near ? 0 : this.hz[i] - ez;
          if (this.hs[i] === 2 || dx * dx + dz * dz > 180 * 180) continue;
          this.hs[i] = 3;
          this.ht[i] = 30 + this.rnd() * 40;
        }
        this.alarmAt(b * CM);
        break;
      }
      case S.EV_ARMY: {
        const tx = b * CM, ty = c * CM, tz = ez;
        this.armyT = 110;
        this.armyTg = a & 1;
        for (const h of this.helis) if (h.alive) for (let j = 0; j < 2; j++) this.missile(h.x, h.y - 2, h.z, tx + (this.rnd() - 0.5) * 14, ty + (this.rnd() - 0.5) * 20, tz - 6, 34 + this.rnd() * 18 + j * 6, 5 + this.rnd() * 6);
        for (let j = 0; j < 4; j++) {
          const t = this.tanks[Math.floor(this.rnd() * this.tanks.length)];
          this.missile(t, 3, 93, tx + (this.rnd() - 0.5) * 12, ty + (this.rnd() - 0.5) * 24, tz - 6, 22 + this.rnd() * 12, 16 + this.rnd() * 14);
          this.sparks(t, 3.5, 92, 4, 1, 0.85, 0.4);
        }
        for (let i = NEAR_H + FAR_H; i < NH; i++) if (this.hs[i] === 5 && this.rnd() < 0.7) this.sparks(this.hx[i], 1.2, this.hz[i] - 0.5, 2, 1, 0.9, 0.5);
        if (this.rnd() < 0.55) {
          const dir = this.rnd() < 0.5 ? 1 : -1;
          this.jets.push({ x: cam.x - dir * 260, y: 150 + this.rnd() * 35, z: KZ + 25 + this.rnd() * 30, vx: 3.3 * dir, fired: false, tx, ty, tz });
        }
        break;
      }
      case S.EV_REBUILD:
        this.dust(b * CM, 0, ez - 4, 10, 30, 12);
        break;
      case S.EV_OBJ:
        this.objAlert = 150;
        this.alarmAt(b * CM);
        break;
      case S.EV_OBJDONE:
        this.flash = Math.max(this.flash, 0.25);
        cam.shake += 0.6;
        this.sparks(c * CM, 20, ez - 4, 28, 1, 0.85, 0.3);
        this.ring(c * CM, ez, 18, 0.5, 12);
        this.pop(c * CM, 24, ez - 4, b ? "star" : "bolt", 110, 1, 0.85, 0.3);
        break;
      case S.EV_POWER: {
        const pc = PWC[b] ?? PWC[0];
        this.ring(c * CM, ez, 16, 0.5, 10);
        this.sparks(c * CM, 60, ez - 4, 24, pc[0], pc[1], pc[2]);
        this.flash = Math.max(this.flash, 0.2);
        this.pop(c * CM, 52, ez - 4, POWER_ICON[b] || "star", 100, pc[0], pc[1], pc[2]);
        break;
      }
      case S.EV_BLAST:
        cam.shake += 1.2;
        this.flash = Math.max(this.flash, 0.35);
        this.sparks(b * CM, c * CM * 0.4, ez - 4, 30, 1, 0.6, 0.2);
        this.debris(b * CM, 5, ez - 4, 30, 1.4);
        this.pop(b * CM, c * CM * 0.4 + 10, ez - 4, "boom", 60, 1, 0.6, 0.2);
        break;
      case S.EV_PLANT:
        this.sparks(b * CM, 3, ez - 4, c ? 10 : 4, 1, 0.3, 0.2);
        break;
      case S.EV_HUMAN:
        this.sparks(b * CM, 2, ez - 1, 14, 1, 0.3, 0.2);
        this.dust(b * CM, 0, ez - 1, 5, 12, 5);
        this.pop(b * CM, 8, ez - 1, "man", 70, 1, 0.4, 0.3);
        break;
    }
  }


  /** called once per match: which fighters are human (they get the step-by-step coach) */
  setup(mode: string, me: number) {
    this.coachOn = mode === "cpu" ? [true, false] : mode === "local" ? [true, true] : mode === "online" ? [me === 0, me === 1] : [false, false];
    this.localKeys = mode === "local";
    this.coach.forEach((c) => {
      c.done = [false, false, false, false, false];
      c.cur = -1;
      c.t = 0;
      c.wait = 70;
      c.flash = 0;
      c.dist = 0;
      c.f = 0;
    });
    this.pops.length = 0;
    this.objAlert = 0;
  }
  private pop(x: number, y: number, z: number, icon: string, max: number, r: number, g: number, b: number) {
    this.pops.push({ x, y, z, icon, t: 0, max, r, g, b });
    if (this.pops.length > 12) this.pops.shift();
  }
  /** is coach step i something the player can do right now? */
  private coachAvail(s: Int32Array, o: number, i: number): boolean {
    if (i === 3) return s[o + S.METER] >= S.BEAM_COST || s[o + S.PWR] === S.PW_ATOMIC;
    if (i === 4) return S.isNeutral(s[o + S.ST]) && S.ripTarget(s, o) >= 0;
    return true;
  }
  private coachUpdate(s: Int32Array) {
    for (let k = 0; k < 2; k++) {
      if (!this.coachOn[k]) continue;
      const o = k ? S.F1 : S.F0, C = this.coach[k], st = s[o + S.ST];
      if (s[S.G_PHASE] !== S.PH_FIGHT) {
        C.lastX = s[o + S.X];
        continue;
      }
      C.f++;
      if (C.flash > 0) C.flash--;
      if (C.cur >= 0) {
        C.t++;
        let ok = false;
        if (C.cur === 0) {
          C.dist += Math.abs(s[o + S.X] - C.lastX) + Math.abs(s[o + S.VZ]);
          ok = C.dist >= 3600;
        } else if (C.cur === 1) ok = st === S.ST_LIGHT || st === S.ST_LIGHT2 || st === S.ST_LIGHT3;
        else if (C.cur === 2) ok = st === S.ST_HEAVY;
        else if (C.cur === 3) ok = st === S.ST_BEAM || st === S.ST_SUPER;
        else ok = st === S.ST_RIP;
        if (ok) {
          C.done[C.cur] = true;
          C.cur = -1;
          C.flash = 56;
          C.wait = 62; // a beat to enjoy the success before the next lesson appears
          const X = s[o + S.X] * CM, ez = this.fz(s, o);
          this.pop(X, 70, ez - 2, "check", 56, 0.4, 1, 0.5);
          this.sparks(X, 70, ez - 3, 14, 0.4, 1, 0.5);
        } else if (C.cur >= 3 && !this.coachAvail(s, o, C.cur)) {
          C.cur = -1;
          C.wait = 20;
        }
      } else if (C.wait > 0) C.wait--;
      else {
        for (let i = 0; i < 5; i++) {
          if (!C.done[i] && this.coachAvail(s, o, i)) {
            C.cur = i;
            C.t = 0;
            break;
          }
        }
      }
      C.lastX = s[o + S.X];
    }
  }

  /** world -> HUD pixels (640x360), null when behind the eye */
  private proj(x: number, y: number, z: number): [number, number] | null {
    const m = this.vp, w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0.05) return null;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return [(cx * 0.5 + 0.5) * RW, (0.5 - cy * 0.5) * RH];
  }
  /** pictogram on the HUD, centred on x,y. sc = pixel size */
  private icon(name: string, x: number, y: number, sc: number, r: number, g: number, b: number, flip = false, shadow = true) {
    const ic = iconRuns(name), ox = Math.round(x - (ic.w * sc) / 2), oy = Math.round(y - (ic.h * sc) / 2);
    for (let pass = shadow ? 0 : 1; pass < 2; pass++) {
      const off = pass ? 0 : Math.max(1, Math.round(sc / 2)), k = pass ? 1 : 0.05;
      for (let i = 0; i < ic.runs.length; i += 3) {
        const row = ic.runs[i], x0 = flip ? ic.w - ic.runs[i + 1] - ic.runs[i + 2] : ic.runs[i + 1], len = ic.runs[i + 2];
        this.rect(ox + Math.round(x0 * sc) + off, oy + Math.round(row * sc) + off, Math.max(1, Math.round(len * sc)), Math.max(1, Math.round(sc)), r * k, g * k, b * k);
      }
    }
  }
  /** same pictogram painted onto the city (additive, world metres per pixel = unit) */
  private iconW(name: string, cx: number, cy: number, z: number, unit: number, r: number, g: number, b: number, a: number) {
    const ic = iconRuns(name);
    for (let i = 0; i < ic.runs.length; i += 3) this.rectW(cx + (ic.runs[i + 1] - ic.w / 2) * unit, cy + (ic.h / 2 - ic.runs[i] - 1) * unit, ic.runs[i + 2] * unit, unit, z, r, g, b, a);
  }
  /** ring of dots: `lit` of `n` are on (a countdown you can read without words) */
  private dotRing(x: number, y: number, rad: number, n: number, lit: number, r: number, g: number, b: number, sz = 2) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2, on = i < lit;
      const px = Math.round(x + Math.cos(a) * rad - sz / 2), py = Math.round(y + Math.sin(a) * rad - sz / 2);
      this.rect(px + 1, py + 1, sz, sz, 0.02, 0.02, 0.03);
      this.rect(px, py, sz, sz, on ? r : 0.22, on ? g : 0.2, on ? b : 0.22);
    }
  }
  private panel(x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
    this.rect(x - 1, y - 1, w + 2, h + 2, 0.02, 0.02, 0.04);
    this.rect(x, y, w, h, 0.07, 0.06, 0.1);
    this.rect(x, y, w, 1, r, g, b);
    this.rect(x, y + h - 1, w, 1, r * 0.5, g * 0.5, b * 0.5);
    this.rect(x, y, 1, h, r * 0.7, g * 0.7, b * 0.7);
    this.rect(x + w - 1, y, 1, h, r * 0.7, g * 0.7, b * 0.7);
  }
  /** a physical keycap that visibly presses. label "@L" "@R" "@down" are icons */
  private keycap(label: string, cx: number, cy: number, press: number) {
    const dy = press > 0.5 ? 1 : 0;
    this.rect(cx - 7, cy - 7, 15, 15, 0.02, 0.02, 0.04);
    this.rect(cx - 6, cy - 5 + (dy ? 1 : 0), 13, 12 - dy, 0.35, 0.34, 0.4);
    const fr = press > 0.5 ? [1, 0.85, 0.3] : [0.88, 0.88, 0.92];
    this.rect(cx - 6, cy - 6 + dy, 13, 11, fr[0], fr[1], fr[2]);
    if (label[0] === "@") {
      const nm = label === "@L" || label === "@R" ? "chevron" : label.slice(1);
      this.icon(nm, cx + (label === "@R" ? 1 : label === "@L" ? -1 : 0), cy - 1 + dy, 1, 0.1, 0.1, 0.14, label === "@L", false);
    } else this.text(label, cx + 1, cy - 3 + dy, 1, 0.1, 0.1, 0.14, 1);
  }
  private keysOf(k: number) {
    if (this.localKeys) return k === 0 ? { mv: ["A", "D"], dn: "S", light: "F", heavy: "G", beam: "H", grab: "R" } : { mv: ["@L", "@R"], dn: "@down", light: "J", heavy: "K", beam: "L", grab: "U" };
    return { mv: ["A", "D"], dn: "S", light: "J", heavy: "K", beam: "L", grab: "U" };
  }

  /** the lesson bubble: pictogram + keycaps + motion. One lesson at a time, next one only after you did it. */
  private drawCoach(s: Int32Array, k: number) {
    const C = this.coach[k], o = k ? S.F1 : S.F0, c = S.CH[s[o + S.CHAR]], face = s[o + S.FACE];
    const fz = this.fz(s, o), X = s[o + S.X] * CM;
    const a0 = this.proj(X + face * 26, c.height * CM * 0.58, fz - 2) ?? [320, 160];
    const ax = Math.max(52, Math.min(588, a0[0])), ay = Math.max(66, Math.min(250, a0[1]));
    const f = C.f, K = this.keysOf(k);
    if (C.cur < 0) {
      if (C.flash > 0) {
        // success: big tick + ring burst where the lesson was
        const u = 1 - C.flash / 56, sc = u < 0.15 ? 2 : 3;
        const rr = 6 + u * 30;
        this.dotRing(ax, ay, rr, 16, 16, 0.4, 1, 0.5);
        this.icon("check", ax, ay - u * 6, sc, 0.45, 1, 0.55);
      }
      return;
    }
    const age = Math.min(1, C.t / 14), e = age < 1 ? 1 - Math.pow(1 - age, 3) : 1;
    const W = Math.round(78 * e), Hh = Math.round(50 * e);
    const bx = Math.round(ax - W / 2), by = Math.round(ay - Hh / 2);
    const pulse = 0.65 + 0.35 * Math.sin(this.tsec * 6);
    this.panel(bx, by, W, Hh, 1, 0.75 * pulse + 0.15, 0.25);
    if (age < 0.7) return;
    // little pointer to the kaiju
    this.rect(bx + (face > 0 ? 4 : W - 12), by + Hh + 1, 8, 2, 1, 0.75, 0.25);
    const cx = ax, top = by + 15, cap = by + Hh - 11;
    const tick = (f >> 4) & 1, beat = f % 70 < 14 ? 1 : 0;
    const wait = C.t > 60 * 14 ? 1 : 0; // ignored for a long time -> shake attention
    const sh = wait && (f >> 2) & 1 ? 1 : 0;
    switch (C.cur) {
      case 0: {
        // footprints stepping + chevrons marching the way you face + A/D caps
        this.icon("foot", cx - 16 + sh, top + 1 - (tick ? 0 : 2), 1, tick ? 1 : 0.5, tick ? 0.9 : 0.45, 0.4);
        this.icon("foot", cx - 4 + sh, top + 1 - (tick ? 2 : 0), 1, tick ? 0.5 : 1, tick ? 0.45 : 0.9, 0.4);
        for (let i = 0; i < 3; i++) {
          const ph = ((f * 0.06 + i / 3) % 1), px = cx + 8 + face * 0 + ph * 22 - 4;
          this.icon("chevron", face > 0 ? px : cx + 34 - (px - cx), top + 1, 1, 1, 0.8, 0.3, face < 0);
        }
        this.keycap(K.mv[0], cx - 10, cap, face < 0 && beat ? 1 : 0);
        this.keycap(K.mv[1], cx + 10, cap, face > 0 && beat ? 1 : 0);
        break;
      }
      case 1: {
        const sw = beat ? (f % 14) * 1.2 : 0;
        this.icon("claw", cx - 4 + sw * (face > 0 ? 1 : -1) * 0.6, top + 1, 2, 1, 0.9, 0.5, face < 0);
        this.keycap(K.light, cx, cap, beat);
        break;
      }
      case 2: {
        // tail: coils back (slow) then whips (fast) - same rhythm the move itself has
        const q = (f % 84) / 84, off = q < 0.6 ? -(q / 0.6) * 5 : -5 + ((q - 0.6) / 0.4) * 11;
        this.icon("tail", cx + off * (face > 0 ? 1 : -1), top + 1, 2, 0.8, 0.95, 1, face < 0);
        this.keycap(K.heavy, cx, cap, f % 84 > 48 && f % 84 < 62 ? 1 : 0);
        break;
      }
      case 3: {
        const g = 0.8 + 0.2 * Math.sin(this.tsec * 14);
        this.icon("flame", cx, top + 1 - (tick ? 1 : 0), 2, 0.4 * g, 0.9 * g, 1 * g);
        this.keycap(K.beam, cx, cap, beat);
        break;
      }
      default: {
        const rise = (f % 60) / 60;
        this.icon("tower", cx, top + 4 - rise * 6, 2, 1, 0.85, 0.4);
        this.keycap(K.dn, cx - 10, cap, beat);
        this.keycap(K.grab, cx + 10, cap, beat);
      }
    }
    // progress pips: which lesson of the five are we on
    for (let i = 0; i < 5; i++) this.rect(bx + W / 2 - 14 + i * 6, by + Hh + 4, 4, 2, C.done[i] ? 0.4 : i === C.cur ? 1 : 0.25, C.done[i] ? 1 : i === C.cur ? 0.8 : 0.25, C.done[i] ? 0.5 : i === C.cur ? 0.3 : 0.3);
  }

  /** objective: a beacon that lives IN the city plus a screen anchor with a dot-ring timer, edge arrow when off screen */
  private drawObjective(s: Int32Array) {
    const ob = s[S.G_OBJ], fr = s[S.G_FRAME], bounce = Math.sin(this.tsec * 7);
    if (!ob) {
      // nothing marked: a quiet ring fills while the next target is chosen
      const fill = 1 - Math.min(1, s[S.G_OBJT] / S.OBJ_GAP) ;
      if (s[S.G_OBJT] <= S.OBJ_GAP) {
        this.dotRing(320, 58, 9, 16, Math.round(16 * fill), 0.8, 0.7, 0.4);
        this.icon("target", 320, 58, 1, 0.55, 0.5, 0.4);
      }
      return;
    }
    const bo = S.B0 + (ob - 1) * S.B_N, x = s[bo + S.BX] * CM, h = s[bo + S.BH] * CM, hw = s[bo + S.BW] * CM, z = this.bz(s, bo) - hw * 0.78;
    const frac = Math.max(0, Math.min(1, s[S.G_OBJT] / S.OBJ_LIFE)), lit = Math.ceil(24 * frac);
    const hot = frac < 0.25 ? 1 : 0, blink = hot && (fr >> 3) & 1;
    const col = hot ? [1, 0.25, 0.2] : [1, 0.55, 0.2];
    const p = this.proj(x, h + 7, z);
    const sx = p ? p[0] : x < this.cam.x ? -99 : 999;
    const T = 150 - this.objAlert; // frames since the objective appeared
    let ix = Math.max(24, Math.min(616, sx)), iy = p ? Math.max(30, Math.min(270, p[1] - 6 * bounce)) : 120;
    const off = sx < 14 || sx > 626;
    if (off) iy = 150 + bounce * 4;
    if (this.objAlert > 0 && T < 110) {
      // announce: pops big in the middle of the screen, then flies to the tower
      const u = T < 60 ? 0 : Math.min(1, (T - 60) / 50), eu = u * u * (3 - 2 * u);
      const mx = 320 + (ix - 320) * eu, my = 120 + (iy - 120) * eu, big = T < 60 ? (T < 10 ? 3 : 5) : Math.max(2, Math.round(5 - eu * 3));
      if (T < 60) for (let i = 0; i < 3; i++) this.dotRing(mx, my, 14 + ((T * 1.5 + i * 18) % 54), 20, 20, col[0], col[1] * 0.8, col[2], 2);
      this.icon("target", mx, my, big, col[0], col[1], col[2]);
      return;
    }
    if (off) {
      const left = sx < 14, ex = left ? 18 : 622, nudge = Math.abs(bounce) * 3 * (left ? 1 : -1);
      if (!blink) {
        this.icon("chevron", ex + nudge + (left ? 12 : -12), iy, 2, col[0], col[1], col[2], left);
        this.icon("chevron", ex + nudge * 0.6 + (left ? 20 : -20), iy, 2, col[0] * 0.7, col[1] * 0.7, col[2] * 0.7, left);
        this.icon("target", ex + (left ? 2 : -2), iy, 2, col[0], col[1], col[2]);
      }
      this.dotRing(ex + (left ? 2 : -2), iy, 15, 24, lit, col[0], col[1], col[2]);
      return;
    }
    if (!blink) {
      this.icon("target", ix, iy, 2, col[0], col[1], col[2]);
      this.icon("down", ix, iy + 24 + Math.abs(bounce) * 4, 1, col[0], col[1], col[2]);
    }
    this.dotRing(ix, iy, 16, 24, lit, col[0], col[1], col[2]);
  }

  /** floating pictograms over power orbs / power-core towers / world pops (all anchored in the city) */
  private drawWorldIcons(s: Int32Array) {
    const fr = s[S.G_FRAME];
    for (let i = 0; i < S.NO; i++) {
      const oo = S.O0 + i * S.O_N, ty = s[oo + S.OB_T];
      if (!ty || (s[oo + S.OB_L] < 150 && (fr >> 2) & 1)) continue;
      const p = this.proj(s[oo + S.OB_X] * CM, 17 + Math.sin(this.tsec * 3 + i) * 2, KZ + s[oo + S.OB_Z] * CM - 1);
      if (p && p[0] > 8 && p[0] < 632) this.icon(POWER_ICON[ty], p[0], Math.max(16, p[1]), 2, PWC[ty][0], PWC[ty][1], PWC[ty][2]);
    }
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N;
      if (s[bo + S.BHP] <= 0) continue;
      const cp = S.corePower(s, bo);
      if (!cp) continue;
      const p = this.proj(s[bo + S.BX] * CM, s[bo + S.BH] * CM + 8 + Math.sin(this.tsec * 3 + i) * 1.5, this.bz(s, bo) - s[bo + S.BW] * CM * 0.78);
      if (p && p[0] > 8 && p[0] < 632 && p[1] > 8) this.icon(POWER_ICON[cp], p[0], p[1], 1, PWC[cp][0], PWC[cp][1], PWC[cp][2]);
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const q = this.pops[i];
      if (++q.t > q.max) {
        this.pops.splice(i, 1);
        continue;
      }
      const u = q.t / q.max, p = this.proj(q.x, q.y + u * 14, q.z);
      if (!p) continue;
      const sc = q.t < 8 ? 2 : q.t < 14 ? 4 : 3;
      if (u > 0.7 && (q.t & 1)) continue; // flicker out
      this.icon(q.icon, Math.max(16, Math.min(624, p[0])), Math.max(16, Math.min(300, p[1])), sc, q.r, q.g, q.b);
    }
  }

  /** advance visual-only state; called once per simulated frame */
  update(s: Int32Array) {
    this.time += 1 / 60;
    this.imp *= 0.85;
    if (this.clash > 0) this.clash--;
    if (this.armyT > 0) this.armyT--;
    for (let k = 0; k < 2; k++) if (this.roarT[k] > 0) this.roarT[k]--;
    this.coachUpdate(s);
    this.hint = 0;
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, st = s[o + S.ST];
      if (S.isNeutral(st) && s[o + S.PREV] & S.IN_D && S.ripTarget(s, o) >= 0) this.hint |= 1 << k;
    }
    const x0 = s[S.F0 + S.X] * CM, x1 = s[S.F1 + S.X] * CM;
    const zFront = Math.min(s[S.F0 + S.Z], s[S.F1 + S.Z]) * CM;
    this.targetCam = { x: Math.max(-175, Math.min(175, (x0 + x1) / 2)), z: -Math.min(34, Math.max(0, Math.abs(x1 - x0) - 105) * 0.5 + Math.max(0, -zFront) * 0.55) };
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
        pv[i * 3 + 2] *= 0.97;
        pl[i * 4 + 2] += pl[i * 4 + 3];
      }
    }
    // smouldering ruins + towers rising out of fresh scaffolding
    const fr = s[S.G_FRAME];
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N;
      if (s[bo + S.BHP] > 0) {
        if (s[bo + S.BFL] === 2 && fr - s[bo + S.BDT] < S.RISE && (fr & 3) === 0) this.dust(s[bo + S.BX] * CM, 0, this.bz(s, bo) - s[bo + S.BW] * CM * 0.8, 1, s[bo + S.BW] * CM * 2.2, 10);
        continue;
      }
      if (s[bo + S.BDT] < 0) continue;
      const age = fr - s[bo + S.BDT];
      if (age < 55 && !s[bo + S.BFL] && (fr & 3) === 0) this.dust(s[bo + S.BX] * CM, 0, this.bz(s, bo) - 3, 1, s[bo + S.BW] * CM * 2.4, 13);
      if ((fr + i * 7) % 14 === 0) {
        const sh = 0.16 + this.rnd() * 0.1;
        this.spawn(4, Math.floor(this.rnd() * 3), s[bo + S.BX] * CM + (this.rnd() - 0.5) * 12, 4, this.bz(s, bo), 0.03 + this.rnd() * 0.05, 0.22 + this.rnd() * 0.1, 0, 220, 8, 0.09, sh, sh * 0.9, sh * 0.95);
      }
    }
    // ---- tower ripping: foundations crack, the tower is wrenched out, then facade slabs / glass / dust crumble off it all the way
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, H = this.held[k], st = s[o + S.ST], t = s[o + S.T];
      if (st === S.ST_RIP && t < S.RIP_GRIP && s[o + S.CBI] > 0 && t > S.RIP_GRIP - 24) {
        // claws sink in: the street heaves and cracks around the base
        const lo = S.B0 + (s[o + S.CBI] - 1) * S.B_N, bx = s[lo + S.BX] * CM, bhw = s[lo + S.BW] * CM, bzz = this.bz(s, lo) - bhw * 0.8;
        if (t % 2 === 0) {
          this.dust(bx, 0, bzz, 2, bhw * 2.4, 9);
          this.debris(bx + (this.rnd() - 0.5) * bhw * 2, 1, bzz, 2, 0.5);
        }
        if (t % 5 === 0) this.cam.shake += 0.35;
      }
      const since = st === S.ST_RIP ? t - S.RIP_GRIP : st === S.ST_CARRY ? t + (S.RIP_TOTAL - S.RIP_GRIP) : st === S.ST_HURL && t < S.HURL_REL ? 400 : -1;
      if (since >= 0 && fr - H.f < 4 && H.hw > 0) {
        const heavy = Math.max(0, 1 - since / 200), burst = since < tf("rip", 16);
        const n = burst ? 3 : (fr & 1) === 0 ? Math.round(heavy * 2.2) : 0;
        for (let j = 0; j < n; j++) {
          const u = this.rnd(), px = H.bx + (H.x - H.bx) * 2 * u + (this.rnd() - 0.5) * H.hw * 2, py = H.by + (H.y - H.by) * 2 * u;
          const big = this.rnd() < 0.12 + heavy * 0.1, sh = 0.42 + this.rnd() * 0.2;
          this.spawn(1, Math.floor(this.rnd() * 3), px, py, H.z - H.hw * 0.7, (this.rnd() - 0.5) * 0.28, -0.02 - this.rnd() * 0.05, (this.rnd() - 0.5) * 0.1, 150, big ? 5 + this.rnd() * 4 : 1.2 + this.rnd() * 2.8, 0, sh, sh * 0.96, sh * 0.92);
          if ((j & 1) === 0) this.spawn(0, Math.floor(this.rnd() * 3), px, py, H.z - H.hw * 0.6, (this.rnd() - 0.5) * 0.1, 0.02, 0, 60 + this.rnd() * 40, 4 + this.rnd() * 4, 0.1, 0.55, 0.5, 0.45);
          if (big) this.cam.shake += 0.15;
        }
        if (burst && this.rnd() < 0.5) this.sparks(H.bx + (this.rnd() - 0.5) * H.hw * 2, H.by + 2, H.z - H.hw * 0.7, 2, 0.6, 0.8, 1); // dangling cables
        if (burst && (fr & 1) === 0) this.dust(H.bx, H.by, H.z - H.hw * 0.7, 1, H.hw * 2.4, 11);
      }
      if (s[o + S.ST] === S.ST_SIDE && (fr & 1) === 0) this.dust(s[o + S.X] * CM, 0, this.fz(s, o) - 3, 1, 20, 8);
    }
    for (let k = 0; k < 2; k++) if (this.notes[k].t > 0) this.notes[k].t--;
    if (this.objAlert > 0) this.objAlert--;
    for (let i = 0; i < S.NO; i++) {
      const oo = S.O0 + i * S.O_N, ty = s[oo + S.OB_T];
      if (ty && fr % 4 === 0) {
        const pc = PWC[ty];
        this.spawn(3, 0, s[oo + S.OB_X] * CM + (this.rnd() - 0.5) * 7, 2, KZ + s[oo + S.OB_Z] * CM - 1, 0, 0.14, 0, 26, 1.4, 0, pc[0], pc[1], pc[2]);
      }
    }
    for (const V of this.pvis) V.k *= 0.82;
    // beam impact sparks + tank tracers
    for (let k = 0; k < 2; k++) {
      const bm = this.beamInfo(s, k ? S.F1 : S.F0);
      if (bm && (fr & 1) === 0) this.sparks(bm.x1, bm.y1, bm.z1 - 0.5, 3, bm.r, bm.g, bm.b);
    }
    // energy streaming into the mouth(s) while a beam charges
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, u = this.chargeU(s, o);
      if (u <= 0) continue;
      const ch = s[o + S.CHAR], col = ch === 0 ? [0.35, 0.8, 1] : [1, 0.85, 0.3];
      for (let h = 0; h < (ch === 0 ? 1 : 3); h++) {
        if (this.rnd() > 0.35 + u * 0.6) continue;
        const m = this.mouthPos(s, o, h), a = this.rnd() * Math.PI * 2, rr = 7 + this.rnd() * 14 * (1.2 - u * 0.6), life = 14;
        const px = m[0] + Math.cos(a) * rr, py = m[1] + Math.sin(a) * rr;
        this.spawn(3, 0, px, py, m[2] - 0.4, (m[0] - px) / life, (m[1] - py) / life, 0, life, 1.2 + u * 1.6, 0, col[0], col[1], col[2]);
      }
      if (this.chargeU(s, o) > 0.3 && (fr & 3) === 0) this.cam.shake += 0.12 + u * 0.25;
    }
    if (fr % 23 === 0 && s[S.G_PHASE] === S.PH_FIGHT) {
      const t = this.tanks[Math.floor(this.rnd() * this.tanks.length)], o = this.rnd() < 0.5 ? S.F0 : S.F1;
      const tgx = s[o + S.X] * CM, tgz = this.fz(s, o);
      this.spawn(3, 0, t, 3, 93, (tgx - t) / 26, (30 + this.rnd() * 40) / 26 + 0.65, (tgz - 93) / 26, 26, 1.2, 0, 1, 0.9, 0.5);
    }
    if (s[S.G_PHASE] === S.PH_KO && s[S.G_PT] === 60) this.cheer = 300;
    this.updatePeople(s);
    this.updateMilitary(s);
  }

  private updatePeople(s: Int32Array) {
    const kx0 = s[S.F0 + S.X] * CM, kx1 = s[S.F1 + S.X] * CM, kz0 = this.fz(s, S.F0), kz1 = this.fz(s, S.F1);
    const cx = this.cam.x;
    const { hx, hz, hy, hvx, hvz, hvy, ht, hs, hsp } = this;
    if (this.alarm > 0) this.alarm--;
    if (this.cheer > 0) this.cheer--;
    for (let i = 0; i < NH; i++) {
      const st = hs[i];
      if (st === 2) {
        // tossed by a shockwave: tumble, land, lie dazed, then run
        hx[i] += hvx[i];
        hz[i] += hvz[i];
        hy[i] += hvy[i];
        hvy[i] -= 0.035;
        if (hy[i] <= 0) {
          hy[i] = 0;
          hs[i] = 3;
          ht[i] = 40 + this.rnd() * 40;
        }
        continue;
      }
      const near = i < NEAR_H;
      const d0x = hx[i] - kx0, d0z = near ? 0 : hz[i] - kz0, d1x = hx[i] - kx1, d1z = near ? 0 : hz[i] - kz1;
      const q0 = d0x * d0x + d0z * d0z, q1 = d1x * d1x + d1z * d1z;
      const dx = q0 < q1 ? d0x : d1x, dz = q0 < q1 ? d0z : d1z, dist = Math.sqrt(Math.min(q0, q1)) + 0.001;
      if (st === 3 || st === 4) {
        if (st === 4) hy[i] = Math.abs(Math.sin(this.time * 9 + i)) * 0.45;
        if (--ht[i] <= 0) {
          hs[i] = st === 4 ? 0 : 1;
          ht[i] = 90 + this.rnd() * 60;
          hy[i] = 0;
        }
        continue;
      }
      if (st === 5) {
        if (dist < 30) {
          hs[i] = 1; // even soldiers break and run when a foot lands next to them
          ht[i] = 160;
        } else hvx[i] = dx > 0 ? -1 : 1; // face the monster
        continue;
      }
      if (near) {
        if (this.cheer > 0 && this.cheer < 240 && this.rnd() < 0.04) {
          hs[i] = 4; // the street cheers the survivor
          ht[i] = 80 + this.rnd() * 90;
          continue;
        }
        if (this.alarm > 0 && i >= 6) {
          const dir = hx[i] >= this.alarmX ? 1 : -1;
          hvx[i] = dir;
          hx[i] += dir * (0.15 + hsp[i] * 1.5);
          hs[i] = 1;
        } else {
          hs[i] = 0;
          hx[i] += hvx[i] * hsp[i];
        }
        if (hx[i] - cx > 80) hx[i] -= 160;
        else if (hx[i] - cx < -80) hx[i] += 160;
        continue;
      }
      if (dist < 64 && st !== 1) {
        hs[i] = 1;
        ht[i] = 100 + this.rnd() * 80;
      }
      if (hs[i] === 1) {
        const sp = 0.15 + hsp[i] * 2.2;
        hx[i] += (dx / dist) * sp + (this.rnd() - 0.5) * 0.05;
        hz[i] += (dz / dist) * sp * 0.8;
        hvx[i] = dx > 0 ? 1 : -1;
        if (--ht[i] <= 0 && dist > 80) hs[i] = 0;
      } else {
        hx[i] += hvx[i] * hsp[i];
        if (this.rnd() < 0.004) hvx[i] = -hvx[i];
      }
      if (hz[i] < 96) hz[i] = 96;
      else if (hz[i] > 204) hz[i] = 204;
      if (hx[i] - cx > 140) {
        hx[i] -= 280;
        hs[i] = 0;
      } else if (hx[i] - cx < -140) {
        hx[i] += 280;
        hs[i] = 0;
      }
    }
  }

  private updateMilitary(s: Int32Array) {
    const fr = s[S.G_FRAME];
    const beams = [this.beamInfo(s, S.F0), this.beamInfo(s, S.F1)];
    for (let i = 0; i < this.helis.length; i++) {
      const h = this.helis[i];
      if (h.alive) {
        h.a += 0.0037 * (i & 1 ? -1 : 1);
        h.x = this.cam.x + Math.sin(h.a) * h.r;
        h.z = KZ - 30 + Math.cos(h.a) * 24 + i * 6;
        h.y = h.h + Math.sin(h.a * 3) * 3;
        let hit = false;
        // swatted out of the sky by a beam ...
        for (const bm of beams) {
          if (!bm) continue;
          const dx = bm.x1 - bm.x0, dy = bm.y1 - bm.y0, L2 = dx * dx + dy * dy || 1;
          const u = Math.max(0, Math.min(1, ((h.x - bm.x0) * dx + (h.y - bm.y0) * dy) / L2));
          const ex = bm.x0 + dx * u - h.x, ey = bm.y0 + dy * u - h.y, zz = bm.z0 + (bm.z1 - bm.z0) * u - h.z;
          if (ex * ex + ey * ey < (bm.hw + 7) * (bm.hw + 7) && Math.abs(zz) < 34) hit = true;
        }
        // ... or by a tower flying past
        for (let p = 0; p < S.NP; p++) {
          const po = S.P0 + p * S.P_N;
          if (s[po + S.PT] && Math.abs(s[po + S.PX] * CM - h.x) < 18 && Math.abs(s[po + S.PY] * CM - h.y) < 22 && Math.abs(KZ + s[po + S.PZ] * CM - h.z) < 30) hit = true;
        }
        if (hit) {
          h.alive = false;
          h.dead = 0;
          h.vy = 0.3;
          h.vx = (this.rnd() - 0.5) * 0.8;
          this.sparks(h.x, h.y, h.z - 1, 24, 1, 0.7, 0.3);
          this.debris(h.x, h.y - 6, h.z - 1, 8, 0.8);
          this.cam.shake += 0.6;
        }
      } else if (h.dead === 0) {
        h.vy -= 0.03;
        h.y += h.vy;
        h.x += h.vx;
        if ((fr & 1) === 0) this.spawn(4, Math.floor(this.rnd() * 3), h.x, h.y, h.z + 1, 0, 0.06, 0, 120, 4, 0.08, 0.15, 0.13, 0.14);
        if (h.y <= 0) {
          h.y = 0;
          h.dead = 1;
          this.sparks(h.x, 2, h.z - 1, 30, 1, 0.6, 0.2);
          this.dust(h.x, 0, h.z - 1, 8, 20, 12);
          this.debris(h.x, 2, h.z - 1, 12, 1);
          this.toss(h.x, h.z, 14, 1);
          this.cam.shake += 0.5;
        }
      } else if (++h.dead > 600) {
        h.alive = true; // reinforcements
        h.dead = 0;
        h.a += 2.4;
      }
    }
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.t++;
      const u = m.t / m.dur;
      const x = m.sx + (m.tx - m.sx) * u, y = m.sy + (m.ty - m.sy) * u + Math.sin(Math.PI * u) * m.arc, z = m.sz + (m.tz - m.sz) * u;
      if ((m.t & 1) === 0) this.spawn(4, Math.floor(this.rnd() * 3), x, y, z + 0.5, 0, 0.02, 0, 50, 1.6, 0.05, 0.42, 0.4, 0.42);
      if (u >= 1) {
        this.sparks(m.tx, m.ty, m.tz, 9, 1, 0.75, 0.3);
        this.dust(m.tx, m.ty, m.tz, 2, 6, 6);
        this.cam.shake += 0.08;
        this.missiles.splice(i, 1);
      }
    }
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i];
      j.x += j.vx;
      if ((fr & 1) === 0) this.spawn(4, 0, j.x - Math.sign(j.vx) * 9, j.y, j.z + 1, 0, 0, 0, 90, 2.4, 0.04, 0.75, 0.72, 0.7);
      if (!j.fired && Math.abs(j.x - j.tx) < 90) {
        j.fired = true;
        for (let k = 0; k < 2; k++) this.missile(j.x, j.y - 3, j.z, j.tx + (this.rnd() - 0.5) * 10, j.ty + (this.rnd() - 0.5) * 16, j.tz - 6, 26 + k * 5, -4);
      }
      if (Math.abs(j.x - this.cam.x) > 300) this.jets.splice(i, 1);
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
    return KZ + s[bo + S.BZ] * CM;
  }
  /** world depth of a fighter */
  private fz(s: Int32Array, o: number): number {
    return KZ + s[o + S.Z] * CM;
  }

  /** public bridge: the exact frame the simulation tests and the renderer draws */
  frame(s: Int32Array, o: number): Frame {
    return animFrame(s, o, this.atlas.chars);
  }

  /** world position of mouth h of fighter o in the frame being drawn */
  private mouthPos(s: Int32Array, o: number, h: number): number[] {
    const fr = this.frame(s, o), face = s[o + S.FACE] * (fr.flip ? -1 : 1);
    return [s[o + S.X] * CM + face * fr.mouths[h * 2] * PX_M, s[o + S.Y] * CM + fr.mouths[h * 2 + 1] * PX_M, this.fz(s, o) - 0.6];
  }

  /** the active beam(s) of fighter o. Every ray starts at the exact mouth anchor of the drawn frame and
   *  follows that mouth's own axis (baked from the head angle) — the same ray the simulation tests. */
  private beamInfo(s: Int32Array, o: number): Beam | null {
    const st = s[o + S.ST], t = s[o + S.T], ch = s[o + S.CHAR], c = S.CH[ch];
    let sup = 0;
    if (st === S.ST_BEAM) {
      if (t <= c.beamSu || t > c.beamSu + c.beamAc) return null;
    } else if (st === S.ST_SUPER) {
      if (t <= S.SUPER_SU || t > S.SUPER_SU + S.SUPER_AC) return null;
      sup = 1;
    } else return null;
    const e = o === S.F0 ? S.F1 : S.F0;
    const fr = this.frame(s, o), face = s[o + S.FACE] * (fr.flip ? -1 : 1);
    const X = s[o + S.X] * CM, Y = s[o + S.Y] * CM;
    const z0 = this.fz(s, o) - 0.6;
    const d = (s[e + S.X] - s[o + S.X]) * s[o + S.FACE], reach = sup ? 30000 : c.beamReach;
    const est = s[e + S.ST], inLane = Math.abs(s[e + S.Z] - s[o + S.AIMZ]) < (sup ? S.SUPER_Z : S.BEAM_Z);
    const hitsLane = d > 1000 && d < reach && est !== S.ST_DOWN && est !== S.ST_GETUP && inLane;
    const nM = ch === 0 ? 1 : 3, heads: BeamHead[] = [];
    const ey0 = s[e + S.Y] * CM, ey1 = ey0 + S.CH[s[e + S.CHAR]].height * CM;
    for (let h = 0; h < nM; h++) {
      const mx = X + face * fr.mouths[h * 2] * PX_M, my = Y + fr.mouths[h * 2 + 1] * PX_M, sl = fr.mslope[h] / 1000;
      let u = reach * CM;
      if (sl < 0) u = Math.min(u, my / -sl); // the ray burns into the street where it meets it
      if (hitsLane) {
        const ut = d * CM - 20, yAt = my + sl * ut;
        if (yAt > ey0 - 12 && yAt < ey1 + 12 && ut < u) u = ut; // ...or ends in the foe's body when the ray really passes through it
      }
      u = Math.max(4, u);
      heads.push({ x0: mx, y0: my, x1: mx + face * u, y1: Math.max(0.5, my + sl * u) });
    }
    const ez = hitsLane ? this.fz(s, e) - 2.5 : KZ + s[o + S.AIMZ] * CM - 2.5;
    const col = ch === 0 ? (sup ? [1, 0.25, 0.5] : [0.3, 0.75, 1]) : sup ? [1, 1, 0.8] : [1, 0.85, 0.25];
    const h0 = heads[0];
    return { x0: h0.x0, y0: h0.y0, z0, x1: h0.x1, y1: h0.y1, z1: ez, hw: ch === 0 ? (sup ? 8 : 4.5) : sup ? 7 : 5, sup, r: col[0], g: col[1], b: col[2], heads };
  }
  /** anticipation: energy gathers in the mouth(s) before a beam, growing for the whole (slow) wind-up */
  private chargeU(s: Int32Array, o: number): number {
    const st = s[o + S.ST], t = s[o + S.T], c = S.CH[s[o + S.CHAR]];
    if (st === S.ST_BEAM && t <= c.beamSu) return Math.max(0, (t - 8) / (c.beamSu - 8));
    if (st === S.ST_SUPER) return t === 0 ? ((S.SUPER_FREEZE - s[S.G_FREEZE]) / S.SUPER_FREEZE) * 0.6 : t <= S.SUPER_SU ? 0.6 + 0.4 * (t / S.SUPER_SU) : 0;
    return 0;
  }
  private chargeOrbs(s: Int32Array, o: number, add: Batch) {
    const u = this.chargeU(s, o);
    if (u <= 0) return;
    const ch = s[o + S.CHAR], col = ch === 0 ? [0.35, 0.8, 1] : [1, 0.85, 0.3], fr = s[S.G_FRAME];
    for (let h = 0; h < (ch === 0 ? 1 : 3); h++) {
      const m = this.mouthPos(s, o, h), sz = (2 + 12 * u * u) * (h === 0 ? 1 : 0.7) * (0.9 + 0.2 * Math.sin(fr * 0.9 + h));
      this.sprite(add, "flame" + ((fr + h) % 3), m[0], m[1] - sz * 0.5, m[2] - 0.3, sz, sz, (fr & 2) === 0, col[0], col[1], col[2]);
    }
  }
  /** soft vertical light column (stacked additive quads fading upward) */
  private pillar(x: number, z: number, w: number, h: number, r: number, g: number, b: number, a: number, y0 = 0) {
    for (let i = 0; i < 6; i++) {
      const ya = y0 + (h * i) / 6, yb = y0 + (h * (i + 1)) / 6, al = a * (1 - i / 6);
      this.add.quad(x - w, yb, z, x + w, yb, z, x - w, ya, z, x + w, ya, z, 0, 0, 1, 1, r, g, b, al, 2, 0, 0, 0);
    }
  }
  private beamQuad(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hw: number, r: number, g: number, b: number, mat: number, seed: number, sup: number) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = (-dy / L) * hw, ny = (dx / L) * hw;
    this.add.quad(x0 + nx, y0 + ny, z0, x1 + nx, y1 + ny, z1, x0 - nx, y0 - ny, z0, x1 - nx, y1 - ny, z1, 0, -1, L, 1, r, g, b, 1, mat, seed, sup, 0);
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
  /** world-space solid bar (additive batch) */
  private rectW(x: number, y: number, w: number, h: number, z: number, r: number, g: number, b: number, a: number) {
    this.add.quad(x, y + h, z, x + w, y + h, z, x, y, z, x + w, y, z, 0, 0, 1, 1, r, g, b, a, 2, 0, 0, 0);
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

  /** face-relative tilt of a held tower (radians, + = top leans back over the shoulders) */
  private tilt(ch: number, st: number, t: number): number {
    const tc = ch === 0 ? 1.36 : 0.96;
    const sm = (v: number) => {
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      return v * v * (3 - 2 * v);
    };
    const r0 = S.RIP_GRIP + tf("rip", 12), r1 = tf("rip", 13), h0 = tw("hurl", 7), b0 = tw("bslam", 9);
    if (st === S.ST_RIP) return t < r0 ? 0 : tc * sm((t - r0) / r1);
    if (st === S.ST_CARRY) return tc + Math.sin(t * 0.09) * 0.035;
    if (st === S.ST_HURL) return t < h0 ? tc + 0.35 * sm(t / h0) : tc + 0.35 + (-0.45 - tc - 0.35) * sm((t - h0) / Math.max(1, S.HURL_REL - h0));
    if (st === S.ST_BSLAM) return t < b0 ? tc + 0.4 * sm(t / b0) : tc + 0.4 + (-1.75 - tc - 0.4) * sm((t - b0) / Math.max(1, S.BS_HIT - b0));
    return 0;
  }

  /** a tower in a kaiju's grip: pinned to the hand / jaw anchor of the frame being drawn and
   *  rotated rigidly about the grip point (the offset from the hand was frozen at RIP_GRIP). */
  private heldTower(s: Int32Array, o: number, f: Frame, X: number, Y: number, face: number, z: number) {
    const st = s[o + S.ST], t = s[o + S.T];
    if (s[o + S.CBH] <= 0 || !S.holdState(st, t)) return;
    const ch = s[o + S.CHAR], hw = s[o + S.CBW] * CM, h = s[o + S.CBH] * CM;
    const g = gripHand(this.atlas.chars, ch);
    const ox = s[o + S.CBX] * CM - g[0] * PX_M, oy = -g[1] * PX_M; // base centre relative to the hand at grip time
    const th = this.tilt(ch, st, t), c = Math.cos(th), sn = Math.sin(th);
    const rx = ox * c - oy * sn, ry = ox * sn + oy * c;
    let bx = X + face * (f.hand[0] * PX_M + rx), by = Y + f.hand[1] * PX_M + ry, phi = th * face;
    let zc = z + hw * 0.75 + 0.6; // just behind the sprite plane: the near hand / jaw overlaps its wall
    const lot = s[o + S.CBI] - 1;
    const wrench = tf("rip", 16);
    if (st === S.ST_RIP && t < S.RIP_GRIP + wrench && lot >= 0) {
      // after the grip the tower is slowly wrenched off its foundations into the hands (it shudders as it comes free)
      const lo = S.B0 + lot * S.B_N, u0 = (t - S.RIP_GRIP) / wrench, u = u0 * u0 * (3 - 2 * u0);
      bx += (hash2(t, 5) - 0.5) * 0.9 * (1 - u);
      bx = s[lo + S.BX] * CM + (bx - s[lo + S.BX] * CM) * u;
      by *= u;
      phi *= u;
      zc = this.bz(s, lo) + (zc - this.bz(s, lo)) * u;
    }
    this.tower(this.dyn, bx, by, zc, hw, h, phi, s[o + S.CBS]);
    const H = this.held[o === S.F0 ? 0 : 1];
    H.bx = bx;
    H.by = by;
    H.x = bx - Math.sin(phi) * h * 0.5;
    H.y = by + Math.cos(phi) * h * 0.5;
    H.z = zc;
    H.a = phi;
    H.hw = hw;
    H.f = s[S.G_FRAME];
  }

  /** F1 overlay: the exact boxes the simulation tests (limb volume + hurtbox) */
  private drawHitboxes(s: Int32Array) {
    if (!this.debug) return;
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, face = s[o + S.FACE];
      const X = s[o + S.X] * CM, Y = s[o + S.Y] * CM, z = this.fz(s, o) - 6;
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
      // grip anchor (where a ripped tower is pinned)
      const hx = X + face * f.hand[0] * PX_M, hy = Y + f.hand[1] * PX_M;
      this.boxOverlay(hx - 2, hy - 2, hx + 2, hy + 2, z - 0.5, 0.3, 1, 0.4, 0.9);
    }
    this.text("SIM HITBOXES ACTIVE", 320, 54, 1, 1, 0.35, 0.35, 1);
  }

  /** top-down radar of the 2.5D street: lots, monsters, lane line, towers in flight */
  private drawRadar(s: Int32Array) {
    const X0 = 250, Y0 = 312, W = 140, H = 34, ZA = -3600, ZB = 7200;
    const mx = (x: number) => X0 + ((x + S.STAGE) / (2 * S.STAGE)) * W, mz = (z: number) => Y0 + H - ((z - ZA) / (ZB - ZA)) * H;
    this.rect(X0 - 2, Y0 - 2, W + 4, H + 4, 0.02, 0.02, 0.04);
    this.rect(X0 - 1, Y0 - 1, W + 2, H + 2, 0.32, 0.3, 0.36);
    this.rect(X0, Y0, W, H, 0.05, 0.06, 0.09);
    this.rect(X0, mz(S.Z_MAX), W, mz(S.Z_MIN) - mz(S.Z_MAX), 0.1, 0.11, 0.15);
    const camL = mx((this.cam.x - 150) / CM), camR = mx((this.cam.x + 150) / CM);
    this.rect(Math.max(X0, camL), Y0 + H - 2, Math.max(1, Math.min(X0 + W, camR) - Math.max(X0, camL)), 2, 0.4, 0.38, 0.3);
    const fr = s[S.G_FRAME];
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N, x = mx(s[bo + S.BX]), z = mz(s[bo + S.BZ]);
      const w = Math.max(2, (s[bo + S.BW] / (2 * S.STAGE)) * W * 2);
      if (s[bo + S.BHP] > 0) {
        const rising = s[bo + S.BFL] === 2 && fr - s[bo + S.BDT] < S.RISE;
        this.rect(Math.round(x - w / 2), Math.round(z - 1), Math.round(w), 2, rising ? 0.95 : 0.55, rising ? 0.75 : 0.55, rising ? 0.2 : 0.6);
      } else this.rect(Math.round(x - 1), Math.round(z), 2, 1, 0.6, 0.18, 0.08);
    }
    for (let i = 0; i < S.NP; i++) {
      const po = S.P0 + i * S.P_N;
      if (s[po + S.PT]) this.rect(Math.round(mx(s[po + S.PX])), Math.round(mz(s[po + S.PZ])), 1, 1, 1, 1, 1);
    }
    const p0x = mx(s[S.F0 + S.X]), p0z = mz(s[S.F0 + S.Z]), p1x = mx(s[S.F1 + S.X]), p1z = mz(s[S.F1 + S.Z]);
    const lane = Math.abs(s[S.F0 + S.Z] - s[S.F1 + S.Z]) < S.LANE;
    for (let k = 1; k < 8; k++) {
      const u = k / 8;
      this.rect(Math.round(p0x + (p1x - p0x) * u), Math.round(p0z + (p1z - p0z) * u), 1, 1, lane ? 0.3 : 0.9, lane ? 0.9 : 0.3, 0.25);
    }
    const ob = s[S.G_OBJ];
    if (ob) {
      const bo = S.B0 + (ob - 1) * S.B_N, w = Math.max(3, (s[bo + S.BW] / (2 * S.STAGE)) * W * 2);
      if ((fr >> 3) & 1) this.rect(Math.round(mx(s[bo + S.BX]) - w / 2) - 1, Math.round(mz(s[bo + S.BZ])) - 3, Math.round(w) + 2, 5, 1, 0.2, 0.15);
    }
    for (let i = 0; i < S.NO; i++) {
      const oo = S.O0 + i * S.O_N, ty = s[oo + S.OB_T];
      if (ty) this.rect(Math.round(mx(s[oo + S.OB_X])) - 1, Math.round(mz(s[oo + S.OB_Z])) - 1, 3, 3, PWC[ty][0], PWC[ty][1], PWC[ty][2]);
    }
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0;
      if (s[o + S.HMS] !== 2) this.rect(Math.round(mx(s[o + S.HMX])), Math.round(mz(s[o + S.HMZ])), 2, 2, 1, 1, 1);
    }
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, x = k ? p1x : p0x, z = k ? p1z : p0z, cc = s[o + S.CHAR] === 0 ? [0.3, 0.8, 1] : [1, 0.85, 0.25];
      this.rect(Math.round(x - 1.5), Math.round(z - 1.5), 3, 3, cc[0], cc[1], cc[2]);
      this.rect(Math.round(x + s[o + S.FACE] * 2.5 - 0.5), Math.round(z - 0.5), 1, 1, 1, 1, 1);
    }
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
        const hx0 = k ? 616 : 24, dirx = k ? -1 : 1, cc = s[o + S.CHAR] === 0 ? [0.3, 0.8, 1] : [1, 0.85, 0.25];
        // round wins
        for (let i = 0; i < 2; i++) {
          const won = i < s[o + S.WINS];
          this.rect(k ? 356 + i * 10 : 277 - i * 10, 29, 7, 7, 0.02, 0.02, 0.04);
          this.rect(k ? 357 + i * 10 : 278 - i * 10, 30, 5, 5, won ? 1 : 0.2, won ? 0.8 : 0.2, won ? 0.2 : 0.25);
        }
        // objectives won: gold stars under the bar
        const stars = Math.min(6, s[o + S.OBJS]);
        for (let i = 0; i < stars; i++) this.icon("star", hx0 + dirx * (5 + i * 11), 36, 1, 1, 0.82, 0.25);
        // atomic meter: 4 stocks, a flame glyph instead of a label, a bobbing star when SUPER is ready
        const mx = k ? 456 : 24, m = s[o + S.METER], full = m >= S.MAX_METER;
        this.rect(mx - 1, 339, 162, 9, 0.02, 0.02, 0.04);
        for (let i = 0; i < 4; i++) {
          const f = Math.max(0, Math.min(1, (m - i * 250) / 250));
          const sx = k ? mx + 160 - (i + 1) * 40 : mx + i * 40;
          this.rect(sx, 340, 39, 7, 0.08, 0.1, 0.16);
          const fw = Math.round(39 * f), pulse = full && (fr >> 2) & 1;
          if (fw > 0) this.rect(k ? sx + 39 - fw : sx, 340, fw, 7, pulse ? 1 : cc[0], pulse ? 1 : cc[1], pulse ? 1 : cc[2]);
        }
        const ready = m >= S.BEAM_COST || s[o + S.PWR] === S.PW_ATOMIC;
        this.icon("flame", k ? 628 : 12, 343, 1, ready ? cc[0] : 0.35, ready ? cc[1] : 0.35, ready ? cc[2] : 0.4);
        if (full) this.icon("star", mx + 81, 330 - ((fr >> 3) & 1), 2, 1, 0.9, 0.3);
        if (this.roarT[k] > 0) this.icon("boom", hx0 + dirx * 8, 318, 1, 1, 0.5 + 0.4 * Math.sin(this.tsec * 30), 0.2);
        // combo: claw + count
        const cb = s[e + S.COMBO];
        if (cb >= 2) {
          this.icon("claw", hx0 + dirx * 8, 56, 1, 1, 0.85, 0.2, k === 0);
          this.text("X" + cb, hx0 + dirx * 20, 51, 2, 1, 0.85, 0.2, k ? 2 : 0);
        }
        const st = s[o + S.ST], kk = this.keysOf(k);
        let iy = 70;
        if (st === S.ST_CARRY) {
          // carrying a tower: smash / hurl as two caps with pictograms
          this.keycap(kk.light, hx0 + dirx * 8, iy + 4, (fr >> 4) & 1);
          this.icon("boom", hx0 + dirx * 24, iy + 4, 1, 1, 0.7, 0.3);
          this.keycap(kk.grab, hx0 + dirx * 42, iy + 4, (fr >> 4) & 1 ? 0 : 1);
          this.icon("chevron", hx0 + dirx * 58, iy + 4, 1, 1, 0.8, 0.3, k === 1);
          iy += 18;
        }
        if (s[o + S.PWR]) {
          const pc = PWC[s[o + S.PWR]], left = s[o + S.PWT] / S.POWER_FRAMES, bl = left < 0.2 && (fr >> 3) & 1;
          if (!bl) this.icon(POWER_ICON[s[o + S.PWR]], hx0 + dirx * 8, iy, 1, pc[0], pc[1], pc[2]);
          this.rect(k ? hx0 - 40 : hx0 + 16, iy - 1, 24, 3, 0.1, 0.1, 0.12);
          const bw = Math.round(24 * left);
          this.rect(k ? hx0 - 16 - bw : hx0 + 16, iy - 1, bw, 3, pc[0], pc[1], pc[2]);
          iy += 14;
        }
        const hs = s[o + S.HMS];
        const sp = hs === 2 ? [1, 0.3, 0.25] : s[o + S.HFU] > 0 ? [1, ((fr >> 2) & 1) * 0.6 + 0.1, 0.1] : s[o + S.HMC] > 0 ? [0.45, 0.45, 0.5] : [0.4, 1, 0.55];
        this.icon("man", hx0 + dirx * 8, iy + 1, 1, sp[0], sp[1], sp[2]);
        if (s[o + S.HMC] > 0 && hs !== 2) {
          const cw = Math.round(24 * (1 - s[o + S.HMC] / S.STRIKE_CD));
          this.rect(k ? hx0 - 40 : hx0 + 16, iy, 24, 2, 0.1, 0.1, 0.12);
          this.rect(k ? hx0 - 16 - cw : hx0 + 16, iy, cw, 2, 0.5, 0.8, 0.6);
        } else if (s[o + S.HFU] > 0) {
          const cw = Math.round((24 * s[o + S.HFU]) / S.FUSE_FRAMES);
          this.rect(k ? hx0 - 16 - cw : hx0 + 16, iy, cw, 2, 1, 0.3, 0.15);
        }
        if (this.armyT > 0 && ph === S.PH_FIGHT && this.armyTg === k && (fr >> 3) & 1) this.icon("warn", k ? 340 : 308, 19, 1, 1, 0.35, 0.25);
      }
      const sec = Math.ceil(s[S.G_TIMER] / 60);
      this.rect(302, 8, 36, 22, 0.02, 0.02, 0.04);
      this.text((sec < 10 ? "0" : "") + sec, 320, 12, 2, 1, sec <= 10 ? 0.3 : 0.95, sec <= 10 ? 0.2 : 0.6, 1);
      if (ph === S.PH_FIGHT) this.drawObjective(s);
      // announcer: kept to one or two words
      if (ph === S.PH_INTRO) {
        if (pt < 75) this.text("ROUND " + s[S.G_ROUND], 320, 150, 4, 1, 0.9, 0.3, 1);
      } else if (ph === S.PH_FIGHT && pt < 45) this.text("FIGHT!", 320, 146, 5, 1, 0.35, 0.15, 1);
      else if (ph === S.PH_KO && pt < 150) {
        const kb = s[S.G_KOBY], to = s[S.G_TIMER] <= 0;
        this.text(to ? "TIME UP" : kb === 3 ? "DOUBLE K.O." : "K.O.", 320, 140, to || kb === 3 ? 4 : 7, 1, 0.25, 0.1, 1);
      } else if (ph === S.PH_END) {
        const w = s[S.G_WINNER];
        this.text(w === 3 ? "DRAW" : info.names[w - 1] + " WINS", 320, 120, 3, 1, 0.9, 0.3, 1);
        // results as pictograms + numbers
        const rows: [string, number, number[]][] = [["tower", s[S.F0 + S.HAVOC] + s[S.F1 + S.HAVOC], [1, 0.6, 0.3]], ["claw", Math.max(s[S.F0 + S.BEST], s[S.F1 + S.BEST]), [1, 0.85, 0.3]], ["star", s[S.F0 + S.OBJS] + s[S.F1 + S.OBJS], [1, 0.9, 0.4]]];
        rows.forEach((r, i) => {
          this.icon(r[0], 292, 160 + i * 16, 1, r[2][0], r[2][1], r[2][2]);
          this.text(String(r[1]), 306, 157 + i * 16, 1, 1, 1, 1);
        });
      }
      this.drawRadar(s);
      if (ph !== S.PH_END) for (let k = 0; k < 2; k++) if (this.coachOn[k] && ph === S.PH_FIGHT) this.drawCoach(s, k);
      this.drawWorldIcons(s);
      if (info.net) {
        const n = info.net;
        this.text((n.relay ? "RELAY " : "P2P ") + "PING " + Math.round(n.rtt) + "MS  ROLLBACK " + n.rollback + "F  DELAY " + n.delay + "F", 320, 351, 1, 0.5, 0.9, 0.6, 1);
        if (n.silentMs > 700) this.text("WAITING FOR OPPONENT...", 320, 200, 2, 1, 0.8, 0.2, 1);
        if (n.desync) this.text("DESYNC DETECTED", 320, 222, 1, 1, 0.2, 0.2, 1);
      }
    }
    if (info.banner) this.text(info.banner, 320, 298, 1, 1, 1, 1, 1);
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

    // ---- city lots: standing towers (+ which one can be ripped / is locked), rising rebuilds, ruins
    const tg = [S.isNeutral(s[S.F0 + S.ST]) ? S.ripTarget(s, S.F0) : -1, S.isNeutral(s[S.F1 + S.ST]) ? S.ripTarget(s, S.F1) : -1];
    const lock = [0, 1].map((k) => {
      const o = k ? S.F1 : S.F0;
      return s[o + S.ST] === S.ST_RIP && s[o + S.T] < S.RIP_GRIP ? s[o + S.CBI] - 1 : -1;
    });
    for (let i = 0; i < S.NB; i++) {
      const bo = S.B0 + i * S.B_N;
      const x = s[bo + S.BX] * CM, hw = s[bo + S.BW] * CM, h = s[bo + S.BH] * CM, sd = s[bo + S.BSEED], z = this.bz(s, bo);
      const col = WALLS[sd % 5];
      if (s[bo + S.BHP] > 0) {
        const age = fr - s[bo + S.BDT];
        if (s[bo + S.BFL] === 2 && age < S.RISE) {
          // the city rebuilds: the tower climbs out of its scaffolding next to a tower crane
          const k = age / S.RISE, e2 = 1 - (1 - k) * (1 - k), top = h * e2, zf = z - hw * 0.75 - 0.4;
          this.box(dyn, x, z, hw, hw * 1.5, h, h - top, col, sd & 255, 0.8, true);
          const mxx = x + hw + 2.5, mh = h + 9;
          this.flat(dyn, mxx - 0.6, 0, mxx + 0.6, mh, zf, 0.85, 0.62, 0.12);
          this.flat(dyn, x - hw - 4, mh - 1, mxx + 7, mh, zf, 0.85, 0.62, 0.12);
          this.flat(dyn, mxx + 4, mh - 3.5, mxx + 7, mh - 1, zf, 0.3, 0.3, 0.32);
          const hook = x + Math.sin(this.tsec * 1.5) * hw * 0.5;
          this.flat(dyn, hook - 0.15, top + 2, hook + 0.15, mh - 1, zf, 0.1, 0.1, 0.1);
          for (let yy = 4; yy < top; yy += 6) this.flat(dyn, x - hw, yy, x + hw, yy + 0.35, zf, 0.55, 0.42, 0.18);
          if ((fr >> 3) & 1) this.add.quad(mxx - 0.5, mh + 1, zf, mxx + 0.5, mh + 1, zf, mxx - 0.5, mh, zf, mxx + 0.5, mh, zf, 0, 0, 1, 1, 1, 0.2, 0.15, 1, 2, 0, 0, 0);
          continue;
        }
        const dmg = 1 - s[bo + S.BHP] / S.BHP_MAX[s[bo + S.BROW]];
        const j = dmg > 0 ? (hash2(fr, i) - 0.5) * dmg * 1.2 : 0;
        this.box(dyn, x + j, z, hw, hw * 1.5, h, 0, col, sd & 255, 0.8, true);
        const owner = lock[0] === i ? 0 : lock[1] === i ? 1 : tg[0] === i ? 0 : tg[1] === i ? 1 : -1;
        if (owner >= 0) {
          // rip telegraph: pulsing outline + rising chevrons (brighter while DOWN is held / once locked)
          const locked = lock[owner] === i, armed = locked || (this.hint >> owner) & 1;
          const pul = 0.5 + 0.5 * Math.sin(this.tsec * (armed ? 16 : 7) + i);
          const zf = z - hw * 0.78;
          this.boxOverlay(x - hw, 0, x + hw, Math.max(6, h), zf, 1, locked ? 0.55 : 0.85, 0.3, 0.25 + pul * 0.35 + (armed ? 0.25 : 0));
          for (let c2 = 0; c2 < 3; c2++) {
            const cy2 = 4 + ((this.tsec * (armed ? 26 : 13) + c2 * 11 + i * 2) % Math.max(12, h - 8));
            this.add.quad(x - hw * 0.5, cy2 + 2.4, zf, x + hw * 0.5, cy2 + 2.4, zf, x - hw * 0.5, cy2, zf, x + hw * 0.5, cy2, zf, 0, 0, 1, 1, 1, 0.92, 0.45, pul * (armed ? 0.95 : 0.6), 2, 0, 0, 0);
          }
          const ay = Math.min(h + 2, h + 4 + pul * 2), ab = 1.9;
          const quad = (x0: number, x1: number, y0: number, y1: number) => this.add.quad(x0, y1, zf, x1, y1, zf, x0, y0, zf, x1, y0, zf, 0, 0, 1, 1, 1, 0.95, 0.5, pul * (armed ? 1 : 0.7), 2, 0, 0, 0);
          quad(x - 3.4, x + 3.4, ay + 3.6, ay + 3.6 + ab * 2);
          for (let a2 = 0; a2 < 4; a2++) {
            const w2 = 3.4 - a2 * 0.85, y2 = ay + 3.2 - a2 * 1.6;
            quad(x - w2, x + w2, y2, y2 + 1.5);
          }
        }
        {
          const zf2 = z - hw * 0.78, cp = S.corePower(s, bo);
          if (cp) {
            // power-core tower: glowing roof lamp + coloured stripe + thin beacon (wreck it for a power orb)
            const pc = PWC[cp], pul = 0.5 + 0.5 * Math.sin(this.tsec * 4 + i);
            this.pillar(x, zf2, 0.5, 24 + pul * 8, pc[0], pc[1], pc[2], 0.5, h);
            this.sprite(add, "flame" + ((fr >> 2) % 3), x, h - 1, zf2 - 0.3, 5, 5, false, pc[0], pc[1], pc[2]);
            this.boxOverlay(x - hw, h * 0.7, x + hw, h * 0.7 + 1.6, zf2, pc[0], pc[1], pc[2], 0.3 + pul * 0.4);
          }
          if (s[S.G_OBJ] === i + 1) {
            // condemned tower: pulsing red outline + tall beacon
            const pul = 0.5 + 0.5 * Math.sin(this.tsec * 9);
            this.boxOverlay(x - hw - 1, 0, x + hw + 1, h + 1, zf2 - 0.2, 1, 0.15, 0.1, 0.4 + pul * 0.5);
            this.pillar(x, zf2, hw * 0.5, 80, 1, 0.25, 0.15, 0.4 + pul * 0.3, h);
            // hologram painted on the facade + hazard tape down both edges + a scan line climbing the tower
            const fz3 = zf2 - 0.4, big = Math.min(hw * 1.7, 12) / 11, iyc = Math.max(6, Math.min(h * 0.55, 34));
            this.iconW("target", x, iyc, fz3, big, 1, 0.3, 0.18, 0.35 + pul * 0.5);
            for (let q = 0; q * 2.6 < h; q++) {
              const on = (q + Math.floor(this.tsec * 4)) & 1;
              this.rectW(x - hw - 1.1, q * 2.6, 1.1, 1.3, fz3, on ? 1 : 0.35, on ? 0.75 : 0.08, 0.1, 0.8);
              this.rectW(x + hw, q * 2.6, 1.1, 1.3, fz3, on ? 1 : 0.35, on ? 0.75 : 0.08, 0.1, 0.8);
            }
            const sc3 = (this.tsec * 18) % Math.max(10, h);
            this.rectW(x - hw, sc3, hw * 2, 0.7, fz3, 1, 0.35, 0.2, 0.6);
          }
          for (let k = 0; k < 2; k++) {
            const o = k ? S.F1 : S.F0;
            if (s[o + S.HMB] === i + 1 && (s[o + S.HFU] > 0 || s[o + S.HMS] === 1)) {
              const fast = s[o + S.HFU] > 0 && s[o + S.HFU] < 40, on = ((fr >> (fast ? 1 : 2)) & 1) === 1;
              this.boxOverlay(x - 2.2, 0, x + 2.2, 4.2, zf2 - 0.4, 1, 0.2, 0.1, on ? 0.95 : 0.3);
              if (on) this.sprite(add, "flame0", x, 3, zf2 - 0.6, 3.2, 3.2, false, 1, 0.4, 0.2);
            }
          }
        }
      } else {
        const age = fr - s[bo + S.BDT];
        if (age < 55 && !s[bo + S.BFL]) {
          const k = age / 55;
          this.box(dyn, x + (hash2(fr, i) - 0.5) * 1.6, z, hw, hw * 1.5, h, h * k * k, col, sd & 255, 0.8, true);
        }
        if (s[bo + S.BFL] === 1) {
          // a ripped tower leaves a broken stub with rebar sticking out of a torn-up crater
          const stubH = Math.min(9, 2 + h * 0.1);
          this.box(dyn, x, z, hw, hw * 1.5, h, h - stubH, [col[0] * 0.55, col[1] * 0.5, col[2] * 0.5], sd & 255, 0.8, true);
          for (let q = 0; q < 7; q++) {
            const rx = x + (hash2(sd, q) - 0.5) * hw * 1.8;
            this.flat(dyn, rx - 0.18, stubH, rx + 0.18, stubH + 1.5 + hash2(sd, q + 9) * 4.5, z - hw * 0.75 - 0.2, 0.42, 0.3, 0.22);
          }
          this.flat(dyn, x - hw * 1.35, 0, x + hw * 1.35, 0.4, z - hw * 0.75 - 0.6, 0.06, 0.05, 0.04);
        }
        const rh = s[bo + S.BFL] === 1 ? Math.min(5, 2 + h * 0.03) : Math.min(9, 3 + h * 0.08);
        this.sprite(dyn, "rubble", x, 0, z - hw * 0.75 - 0.5, hw * 2.8, rh, (sd & 1) === 1, 1, 1, 1);
        for (let f = 0; f < 2; f++) {
          const fx = x + (hash2(sd, f) - 0.5) * hw * 2, fs = 5 + hash2(sd, f + 5) * 5;
          this.sprite(add, "flame" + ((((fr >> 3) + f + i) % 3) | 0), fx, rh * 0.3, z - hw * 0.75 - 1, fs, fs * 1.4, ((fr >> 4) & 1) === f, 1, 1, 1);
        }
      }
    }

    // ---- kaiju (+ the tower in their grip, + beams)
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, e = k ? S.F0 : S.F1;
      const st = s[o + S.ST], t = s[o + S.T], ch = s[o + S.CHAR], c = S.CH[ch];
      const f = this.frame(s, o);
      const face = s[o + S.FACE] * (f.flip ? -1 : 1);
      const stopped = s[o + S.STOP] > 0 && (st === S.ST_HIT || st === S.ST_LAUNCH || st === S.ST_BLOCK);
      const X = s[o + S.X] * CM + (stopped ? (hash2(fr, k) - 0.5) * 1.6 : 0), Y = s[o + S.Y] * CM;
      const z = this.fz(s, o) + (S.isAttack(st) ? -1.2 : k * 0.6);
      let glow = 0, gcol = ch;
      if (st === S.ST_BEAM) glow = t <= c.beamSu ? t / c.beamSu : t <= c.beamSu + c.beamAc ? 1 : Math.max(0, 1 - (t - c.beamSu - c.beamAc) / c.beamRc);
      else if (st === S.ST_SUPER) {
        glow = t === 0 ? Math.min(1, (S.SUPER_FREEZE - s[S.G_FREEZE]) / 30) : t <= S.SUPER_SU + S.SUPER_AC ? 1 : Math.max(0, 1 - (t - S.SUPER_SU - S.SUPER_AC) / S.SUPER_RC);
        gcol = ch + 2;
      } else if (st === S.ST_ROAR) glow = t > 12 && t < 60 ? 0.55 + 0.25 * Math.sin(t * 0.5) : 0;
      let tr = 1, tg2 = 1, tb = 1;
      if (k === 1 && s[e + S.CHAR] === ch) {
        tr = 0.8; tg2 = 0.95; tb = 1.3; // mirror match palette
      }
      if (supBy === k) {
        tr *= 1.9; tg2 *= 1.9; tb *= 1.9;
      }
      const fl = stopped ? (st === S.ST_BLOCK ? 0.2 : 0.38) : s[o + S.INV] > 0 && st === S.ST_SIDE && (fr & 2) ? 0.15 : 0;
      const xl = X + face * f.ox * PX_M, xr = X + face * (f.ox + f.w) * PX_M, yt = Y + f.oy * PX_M, yb = Y + (f.oy - f.h) * PX_M;
      dyn.quad(xl, yt, z, xr, yt, z, xl, yb, z, xr, yb, z, f.x, f.y, f.x + f.w, f.y + f.h, tr, tg2, tb, 1, 0, f.l, Math.min(0.999, glow) + gcol * 2, fl);
      this.heldTower(s, o, f, X, Y, face, z);
      const bm = this.beamInfo(s, o);
      if (bm) {
        bm.heads.forEach((hd, h) => {
          this.beamQuad(hd.x0, hd.y0, bm.z0, hd.x1, hd.y1, bm.z1, bm.hw * (ch === 0 ? 1 : 0.85), bm.r, bm.g, bm.b, ch === 0 ? 4 : 5, ch === 0 ? 0 : h + 1, bm.sup);
          const fs = (h === 0 ? 14 : 9) + hash2(fr, 3 + h) * 9;
          this.sprite(add, "flame" + ((fr + h) % 3), hd.x1, hd.y1 - fs * 0.6, bm.z1 - 0.5, fs, fs * 1.3, ((fr + h) & 2) === 0, bm.r, bm.g, bm.b);
          // muzzle flare sitting exactly on the mouth
          const mf = 5 + hash2(fr, 11 + h) * 3;
          this.sprite(add, "flame" + ((fr + h + 1) % 3), hd.x0, hd.y0 - mf * 0.5, bm.z0 - 0.2, mf, mf * 1.1, (fr & 1) === 0, bm.r, bm.g, bm.b);
        });
      }
      this.chargeOrbs(s, o, add);
    }

    // ---- power orbs (dropped by the condemned tower and by power-core towers)
    for (let i = 0; i < S.NO; i++) {
      const oo = S.O0 + i * S.O_N, ty = s[oo + S.OB_T];
      if (!ty) continue;
      if (s[oo + S.OB_L] < 150 && (fr >> 2) & 1) continue;
      const pc = PWC[ty], ox = s[oo + S.OB_X] * CM, oz = KZ + s[oo + S.OB_Z] * CM, bob = 7 + Math.sin(this.tsec * 3 + i) * 2, sz = 8 + Math.sin(this.tsec * 7 + i) * 1.2;
      this.pillar(ox, oz - 0.5, 0.7, 45, pc[0], pc[1], pc[2], 0.45);
      this.sprite(add, "flame" + ((fr >> 2) % 3), ox, bob - sz * 0.5, oz - 1, sz, sz * 1.25, false, pc[0], pc[1], pc[2]);
    }
    // ---- the street-level spotters (dual control): tiny humans with a team-coloured beacon so you can find them
    for (let k = 0; k < 2; k++) {
      const o = k ? S.F1 : S.F0, hs = s[o + S.HMS];
      if (hs === 2) continue;
      const col = s[o + S.CHAR] === 0 ? [0.35, 0.85, 1] : [1, 0.85, 0.3];
      const hx2 = s[o + S.HMX] * CM, hz2 = KZ + s[o + S.HMZ] * CM, spot = (s[o + S.PREV] & S.IN_Y) !== 0;
      this.sprite(dyn, hs === 1 ? "manC" : ((fr >> 3) & 1) === 0 ? "manA" : "manB", hx2, 0, hz2 - 0.8, 3.2, 6.4, s[o + S.HMF] < 0, col[0], col[1], col[2]);
      this.pillar(hx2, hz2 - 1, spot ? 0.7 : 0.35, 34, col[0], col[1], col[2], spot ? 0.75 : 0.5);
      if (hs === 1) {
        const pr = 1 - s[o + S.HMT] / S.PLANT_FRAMES;
        this.rectW(hx2 - 4, 8, 8, 1.1, hz2 - 1.2, 0.1, 0.1, 0.1, 0.9);
        this.rectW(hx2 - 4, 8, 8 * pr, 1.1, hz2 - 1.3, 1, 0.5, 0.15, 1);
      } else if (s[o + S.HFU] > 0) this.rectW(hx2 - 4, 8, (8 * s[o + S.HFU]) / S.FUSE_FRAMES, 1.1, hz2 - 1.3, 1, 0.2, 0.15, 1);
    }

    // ---- hurled / dropped towers: real towers tumbling through 3D, handed off from the grip
    for (let i = 0; i < S.NP; i++) {
      const po = S.P0 + i * S.P_N, V = this.pvis[i];
      if (!s[po + S.PT]) {
        V.seed = -1;
        continue;
      }
      const hw = s[po + S.PW] * CM, h = s[po + S.PH] * CM, seed = s[po + S.PSEED];
      const x = s[po + S.PX] * CM, y = s[po + S.PY] * CM, z = KZ + s[po + S.PZ] * CM;
      if (V.seed !== seed) {
        const H = this.held[s[po + S.POWN] & 1], fresh = fr - H.f <= 3;
        V.seed = seed;
        V.f0 = fr;
        V.k = fresh ? 1 : 0;
        V.ox = fresh ? H.x - x : 0;
        V.oy = fresh ? H.y - y : 0;
        V.oz = fresh ? H.z - z : 0;
        V.a0 = fresh ? H.a : 0;
      }
      const dir = s[po + S.PVX] >= 0 ? 1 : -1, spin = s[po + S.PT] === 2 ? 0.03 : 0.07;
      const ang = V.a0 - dir * spin * (fr - V.f0);
      const ccx = x + V.ox * V.k, ccy = y + V.oy * V.k, ccz = z + V.oz * V.k;
      this.tower(dyn, ccx + Math.sin(ang) * h * 0.5, ccy - Math.cos(ang) * h * 0.5, ccz, hw, h, ang, seed);
      if ((fr & 1) === 0) this.spawn(4, (fr >> 1) % 3, ccx, ccy, ccz + 1, 0, 0.05, 0, 70, 5, 0.08, 0.3, 0.27, 0.27);
    }

    // ---- people
    const { hx, hz, hy, hs, htn, hvx, hsp } = this;
    for (let i = 0; i < NH; i++) {
      const st = hs[i], tn = SHIRT[htn[i]], dk = i < 6 ? 0.12 : i < NEAR_H ? 0.55 : 0.85;
      let name = "manA", w = 1, h = 1.8;
      if (st === 5) name = "soldier";
      else if (st === 2) {
        name = "manD";
        w = 1.8;
        h = 1;
      } else if (st === 3 || st === 4) name = "manC";
      else if ((st === 1 || hsp[i] > 0) && ((fr >> (st === 1 ? 2 : 3)) + i) & 1) name = "manB";
      if (st === 5) this.sprite(dyn, name, hx[i], hy[i], hz[i], w, h, hvx[i] < 0, dk, dk, dk);
      else this.sprite(dyn, name, hx[i], hy[i], hz[i], w, h, hvx[i] < 0, tn[0] * dk, tn[1] * dk, tn[2] * dk);
    }

    // ---- military: helicopters, missiles, jets
    for (let i = 0; i < this.helis.length; i++) {
      const hl = this.helis[i];
      if (hl.dead > 0) continue;
      const falling = !hl.alive;
      this.sprite(dyn, "heli" + ((fr >> 1) & 1), hl.x, hl.y, hl.z, 15, 6, falling ? ((fr >> 2) & 1) === 1 : Math.cos(hl.a) > 0, falling ? 0.5 : 1, falling ? 0.4 : 1, falling ? 0.35 : 1);
    }
    for (const mi of this.missiles) {
      const u = mi.t / mi.dur, x = mi.sx + (mi.tx - mi.sx) * u, y = mi.sy + (mi.ty - mi.sy) * u + Math.sin(Math.PI * u) * mi.arc, z = mi.sz + (mi.tz - mi.sz) * u;
      add.quad(x - 0.9, y + 0.9, z, x + 0.9, y + 0.9, z, x - 0.9, y - 0.9, z, x + 0.9, y - 0.9, z, 0, 0, 1, 1, 1, 0.85, 0.45, 1, 2, 0, 0, 0);
    }
    for (const j of this.jets) this.sprite(dyn, "jet", j.x, j.y, j.z, 16, 5.3, j.vx < 0, 1, 1, 1);

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
