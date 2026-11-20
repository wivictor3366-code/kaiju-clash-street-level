// Pure-code pixel art rasterizer. No canvas / DOM dependency so the exact same
// code bakes sprites in the browser (-> GPU texture array) and in Node (previews).
//
// Workflow: primitives draw into a scratch *layer*; flush() composites the layer
// onto the sprite with an automatic 1px outline (dark outside, darkened-underlying
// inside) which is what gives overlapping limbs their classic sprite separation.

export type Shade = (u: number, v: number, nx: number, ny: number, X: number, Y: number, r: number) => number;
export type Fill = number | ((X: number, Y: number) => number);

/** 0xRRGGBB (+alpha) -> packed little-endian RGBA uint32 */
export function rgb(hex: number, a = 255): number {
  return (((a & 255) << 24) | ((hex & 255) << 16) | (hex & 0xff00) | ((hex >> 16) & 255)) >>> 0;
}
export function darken(c: number, f: number): number {
  const r = Math.min(255, (c & 255) * f) | 0;
  const g = Math.min(255, ((c >>> 8) & 255) * f) | 0;
  const b = Math.min(255, ((c >>> 16) & 255) * f) | 0;
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function bayer(X: number, Y: number): number {
  return (BAYER[(X & 3) + ((Y & 3) << 2)] + 0.5) / 16;
}
export const rad = (d: number) => (d * Math.PI) / 180;
export const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class Raster {
  w: number;
  h: number;
  px: Uint32Array;
  lay: Uint32Array;
  clipY: number;
  private dep: Float32Array;
  private stp: Uint16Array;
  private stamp = 0;
  private ox = 0;
  private oy = 0;
  private cs = 1;
  private sn = 0;
  private pvx = 0;
  private pvy = 0;
  private bx0 = 1e9;
  private by0 = 1e9;
  private bx1 = -1;
  private by1 = -1;
  private sx: number[] = [];
  private sy: number[] = [];
  private xs: number[] = [];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint32Array(w * h);
    this.lay = new Uint32Array(w * h);
    this.dep = new Float32Array(w * h);
    this.stp = new Uint16Array(w * h);
    this.clipY = h - 1;
  }
  clear() {
    this.px.fill(0);
    this.lay.fill(0);
    this.bx0 = this.by0 = 1e9;
    this.bx1 = this.by1 = -1;
  }
  /** rig space (y up) -> sprite space, with optional rotation (deg, CCW) about a rig-space pivot */
  setT(ox: number, oy: number, rot = 0, pvx = 0, pvy = 0) {
    this.ox = ox;
    this.oy = oy;
    this.cs = Math.cos(rad(rot));
    this.sn = Math.sin(rad(rot));
    this.pvx = pvx;
    this.pvy = pvy;
  }
  X(x: number, y: number): number {
    const dx = x - this.pvx, dy = y - this.pvy;
    return this.ox + this.pvx + dx * this.cs - dy * this.sn;
  }
  Y(x: number, y: number): number {
    const dx = x - this.pvx, dy = y - this.pvy;
    return this.oy - (this.pvy + dx * this.sn + dy * this.cs);
  }
  private bb(x0: number, y0: number, x1: number, y1: number) {
    if (x0 < this.bx0) this.bx0 = x0;
    if (y0 < this.by0) this.by0 = y0;
    if (x1 > this.bx1) this.bx1 = x1;
    if (y1 > this.by1) this.by1 = y1;
  }
  private next() {
    if (++this.stamp > 65000) {
      this.stp.fill(0);
      this.stamp = 1;
    }
  }

  /** Tapered capsule chain: pts = [x,y,r, x,y,r, ...] in rig space. Deepest segment wins per pixel. */
  limb(pts: number[], shade: Shade) {
    const n = pts.length / 3;
    const { w, lay, dep, stp } = this;
    const hmax = Math.min(this.h - 1, this.clipY);
    this.next();
    const stamp = this.stamp;
    let u0 = 0;
    for (let i = 0; i < Math.max(1, n - 1); i++) {
      const j = Math.min(i + 1, n - 1);
      const ax = this.X(pts[i * 3], pts[i * 3 + 1]), ay = this.Y(pts[i * 3], pts[i * 3 + 1]), ar = Math.max(0.4, pts[i * 3 + 2]);
      const bx = this.X(pts[j * 3], pts[j * 3 + 1]), by = this.Y(pts[j * 3], pts[j * 3 + 1]), br = Math.max(0.4, pts[j * 3 + 2]);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
      const rm = Math.max(ar, br);
      const X0 = Math.max(0, Math.floor(Math.min(ax, bx) - rm)), X1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + rm));
      const Y0 = Math.max(0, Math.floor(Math.min(ay, by) - rm)), Y1 = Math.min(hmax, Math.ceil(Math.max(ay, by) + rm));
      if (X1 < X0 || Y1 < Y0) {
        u0 += len;
        continue;
      }
      this.bb(X0, Y0, X1, Y1);
      for (let Y = Y0; Y <= Y1; Y++) {
        const py = Y + 0.5 - ay;
        for (let X = X0; X <= X1; X++) {
          const pxx = X + 0.5 - ax;
          let t = len2 > 0 ? (pxx * dx + py * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const r = ar + (br - ar) * t;
          const ex = pxx - dx * t, ey = py - dy * t;
          const d2 = ex * ex + ey * ey;
          if (d2 > r * r) continue;
          const pen = r - Math.sqrt(d2);
          const idx = Y * w + X;
          if (stp[idx] === stamp && dep[idx] >= pen) continue;
          stp[idx] = stamp;
          dep[idx] = pen;
          const v = len > 0 ? (dy * ex - dx * ey) / (len * r) : 0;
          const c = shade(u0 + t * len, v, ex / r, -ey / r, X, Y, r);
          if (c) lay[idx] = c;
        }
      }
      u0 += len;
    }
  }

  /** Rotated ellipse in rig space. */
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, shade: Shade) {
    const { w, lay } = this;
    const hmax = Math.min(this.h - 1, this.clipY);
    const sx = this.X(cx, cy), sy = this.Y(cx, cy);
    // screen-space axis of the ellipse's local +x
    const ax = this.X(cx + Math.cos(rad(rot)), cy + Math.sin(rad(rot))) - sx;
    const ay = this.Y(cx + Math.cos(rad(rot)), cy + Math.sin(rad(rot))) - sy;
    const rm = Math.max(rx, ry);
    const X0 = Math.max(0, Math.floor(sx - rm)), X1 = Math.min(w - 1, Math.ceil(sx + rm));
    const Y0 = Math.max(0, Math.floor(sy - rm)), Y1 = Math.min(hmax, Math.ceil(sy + rm));
    if (X1 < X0 || Y1 < Y0) return;
    this.bb(X0, Y0, X1, Y1);
    for (let Y = Y0; Y <= Y1; Y++)
      for (let X = X0; X <= X1; X++) {
        const dx = X + 0.5 - sx, dy = Y + 0.5 - sy;
        const lx = (dx * ax + dy * ay) / rx, ly = (-dx * ay + dy * ax) / ry;
        if (lx * lx + ly * ly > 1) continue;
        const nx = lx * ax - ly * ay, ny = lx * ay + ly * ax;
        const c = shade(lx * rx, ly, nx, -ny, X, Y, rm);
        if (c) lay[Y * w + X] = c;
      }
  }

  /** Scanline polygon (even-odd), pts = [x,y,...] in rig space. */
  poly(pts: number[], fill: Fill) {
    const n = pts.length / 2;
    const { sx, sy, xs, w, lay } = this;
    const hmax = Math.min(this.h - 1, this.clipY);
    let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9;
    for (let i = 0; i < n; i++) {
      sx[i] = this.X(pts[i * 2], pts[i * 2 + 1]);
      sy[i] = this.Y(pts[i * 2], pts[i * 2 + 1]);
      if (sy[i] < minY) minY = sy[i];
      if (sy[i] > maxY) maxY = sy[i];
      if (sx[i] < minX) minX = sx[i];
      if (sx[i] > maxX) maxX = sx[i];
    }
    const Y0 = Math.max(0, Math.floor(minY)), Y1 = Math.min(hmax, Math.ceil(maxY));
    if (Y1 < Y0) return;
    this.bb(Math.max(0, Math.floor(minX)), Y0, Math.min(w - 1, Math.ceil(maxX)), Y1);
    const fn = typeof fill === "function" ? fill : null;
    const col = typeof fill === "number" ? fill : 0;
    for (let Y = Y0; Y <= Y1; Y++) {
      const yc = Y + 0.5;
      let k = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = sy[i], yj = sy[j];
        if (yi <= yc !== yj <= yc) xs[k++] = sx[i] + ((yc - yi) / (yj - yi)) * (sx[j] - sx[i]);
      }
      // insertion sort (k is tiny)
      for (let a = 1; a < k; a++) {
        const v = xs[a];
        let b = a - 1;
        while (b >= 0 && xs[b] > v) {
          xs[b + 1] = xs[b];
          b--;
        }
        xs[b + 1] = v;
      }
      for (let a = 0; a + 1 < k; a += 2) {
        const xa = Math.max(0, Math.ceil(xs[a] - 0.5)), xb = Math.min(w - 1, Math.ceil(xs[a + 1] - 0.5) - 1);
        for (let X = xa; X <= xb; X++) {
          const c = fn ? fn(X, Y) : col;
          if (c) lay[Y * w + X] = c;
        }
      }
    }
  }

  /** single pixel at rig-space position */
  dot(x: number, y: number, c: number) {
    this.sdot(Math.floor(this.X(x, y)), Math.floor(this.Y(x, y)), c);
  }
  /** single pixel in raw sprite coordinates */
  sdot(X: number, Y: number, c: number) {
    if (X < 0 || Y < 0 || X >= this.w || Y > Math.min(this.h - 1, this.clipY)) return;
    this.lay[Y * this.w + X] = c;
    this.bb(X, Y, X, Y);
  }
  rect(X: number, Y: number, w: number, h: number, c: number) {
    for (let y = Y; y < Y + h; y++) for (let x = X; x < X + w; x++) this.sdot(x, y, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: number) {
    let X0 = Math.floor(this.X(x0, y0)), Y0 = Math.floor(this.Y(x0, y0));
    const X1 = Math.floor(this.X(x1, y1)), Y1 = Math.floor(this.Y(x1, y1));
    const dx = Math.abs(X1 - X0), dy = -Math.abs(Y1 - Y0);
    const sx = X0 < X1 ? 1 : -1, sy = Y0 < Y1 ? 1 : -1;
    let err = dx + dy;
    for (let g = 0; g < 2000; g++) {
      this.sdot(X0, Y0, c);
      if (X0 === X1 && Y0 === Y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        X0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        Y0 += sy;
      }
    }
  }

  /** Composite the scratch layer. outline=0 disables the outline; mul darkens (far-side limbs).
   *  inner = how dark the contact line is where this layer's edge lies over already-drawn pixels
   *  (0.4 = hard sprite separation, 0.8 = soft contact shadow, 1 = none: silhouette outline only). */
  flush(outline = 0, mul = 1, inner = 0.4) {
    if (this.bx1 < 0) return;
    const { w, h, lay, px } = this;
    const x0 = Math.max(0, this.bx0 - 1), x1 = Math.min(w - 1, this.bx1 + 1);
    const y0 = Math.max(0, this.by0 - 1), y1 = Math.min(h - 1, this.by1 + 1);
    const ymax = Math.min(h - 1, this.clipY);
    for (let Y = y0; Y <= y1; Y++)
      for (let X = x0; X <= x1; X++) {
        const i = Y * w + X;
        const c = lay[i];
        if (c) px[i] = mul === 1 ? c : darken(c, mul);
        else if (outline && Y <= ymax && ((X > 0 && lay[i - 1]) || (X < w - 1 && lay[i + 1]) || (Y > 0 && lay[i - w]) || (Y < h - 1 && lay[i + w]))) {
          const u = px[i];
          px[i] = u ? (inner >= 1 ? u : darken(u, inner)) : outline;
        }
      }
    for (let Y = y0; Y <= y1; Y++) lay.fill(0, Y * w + x0, Y * w + x1 + 1);
    this.bx0 = this.by0 = 1e9;
    this.bx1 = this.by1 = -1;
  }
}

/** Catmull-Rom resample of [x,y,r,...] control points into short segments. */
export function spline(p: number[], step = 4): number[] {
  const n = p.length / 3;
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(0, i - 1) * 3, i1 = i * 3, i2 = (i + 1) * 3, i3 = Math.min(n - 1, i + 2) * 3;
    const d = Math.hypot(p[i2] - p[i1], p[i2 + 1] - p[i1 + 1]);
    const k = Math.max(1, Math.ceil(d / step));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      for (let c = 0; c < 3; c++) {
        const a = p[i0 + c], b = p[i1 + c], cc = p[i2 + c], dd = p[i3 + c];
        out.push(0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - dd) * t2 + (-a + 3 * b - 3 * cc + dd) * t3));
      }
    }
  }
  out.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
  return out;
}

/** 2-bone IK. bend=+1 puts the joint counter-clockwise of the root->target line. */
export function ik(hx: number, hy: number, tx: number, ty: number, l1: number, l2: number, bend: number): [number, number] {
  const dx = tx - hx, dy = ty - hy;
  const d = clampi(Math.hypot(dx, dy), Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.01);
  const a = Math.atan2(dy, dx);
  const A = Math.acos(clampi((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  return [hx + Math.cos(a + bend * A) * l1, hy + Math.sin(a + bend * A) * l1];
}

// ---------------------------------------------------------------- poses / animation

export function mix<T>(a: T, b: T, t: number): T {
  if (typeof a === "number") return (a + ((b as unknown as number) - a) * t) as unknown as T;
  if (Array.isArray(a)) return a.map((v, i) => mix(v, (b as unknown as unknown[])[i], t)) as unknown as T;
  const o: Record<string, unknown> = {};
  for (const k in a) o[k] = mix(a[k], b[k], t);
  return o as T;
}

/** Keyframed pose function. Keys are [simFrame, overrides-on-base]. Ease-out between keys (snappy, heavy). */
export function keys<P extends object>(base: P, ks: [number, Partial<P>][]): (t: number) => P {
  const poses = ks.map(([t, o]) => ({ t, p: { ...base, ...o } as P }));
  return (t: number) => {
    if (t <= poses[0].t) return poses[0].p;
    for (let i = 0; i + 1 < poses.length; i++) {
      if (t < poses[i + 1].t) {
        const gap = poses[i + 1].t - poses[i].t;
        let f = (t - poses[i].t) / gap;
        // heavy bodies: slow-in / slow-out through wind-ups and recoveries (weight builds, then settles);
        // short strike segments accelerate INTO the impact instead of snapping out of the pose
        f = gap <= 7 ? f * f * (1.35 - 0.35 * f) : f * f * (3 - 2 * f);
        return mix(poses[i].p, poses[i + 1].p, f);
      }
    }
    return poses[poses.length - 1].p;
  };
}

/** Whip-like follow-through for a chain of angles (tail): segment i samples the pose `lag` frames * i in the past,
 *  so motion travels root -> tip as a wave and the tip trails, curls and cracks instead of the tail moving as one rod. */
export function lagChain<P extends { tail: number[] }>(fn: (t: number) => P, lag: number): (t: number) => P {
  return (t: number) => {
    const p = fn(t);
    const tail = p.tail.map((_, i) => fn(Math.max(0, t - lag * i)).tail[i]);
    return { ...p, tail };
  };
}

export const ANIMS = ["idle", "walk", "dash", "bdash", "block", "light", "heavy", "beamA", "beamB", "beamC", "grab", "throw", "stomp", "sweep", "charge", "hit", "launch", "down", "getup", "win",
  "light2", "light3", "rip", "carry", "hurl", "bslam", "roar", "upper", "tslam", "quake"] as const;
export type AnimName = (typeof ANIMS)[number];

export interface Anim<P> {
  n: number; // baked frame count
  step: number; // sim frames per baked frame
  fn: (t: number) => P;
  flip?: (t: number) => boolean; // sprite mirrored for this frame (turn-around moves)
}

/** Per-frame attachment points in sprite pixel coords: mouths = [x,y, ...], hand = [x,y] */
export interface Anchors {
  mouths: number[];
  /** beam / breath axis of each mouth: screen-space angle in radians (0 = along +x, y up) */
  dirs: number[];
  hand: number[];
  /** strike volumes: PARTS boxes of [x0, y0(bottom), x1, y1(top)] in sprite px, +x = facing dir.
   *  Baked into the hitbox table, so what you see is exactly what hits. */
  parts: number[];
}
export const PART_CLAW = 0, PART_HEAD = 1, PART_TAIL = 2, PART_FEET = 3, PART_BODY = 4, PART_WING = 5, PARTS = 6;

/** AABB (sprite px, y up, relative to the sprite origin) of rig-space points through the current transform. */
export function rigBox(r: Raster, pts: number[], ox: number, oy: number): number[] {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < pts.length; i += 2) {
    const x = r.X(pts[i], pts[i + 1]) - ox, y = oy - r.Y(pts[i], pts[i + 1]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < x0) return [0, 0, 0, 0];
  return [x0, y0, x1, y1];
}
/** AABB around a rig-space disc. */
export function discBox(r: Raster, x: number, y: number, rad: number, ox: number, oy: number): number[] {
  const cx = r.X(x, y) - ox, cy = oy - r.Y(x, y);
  return [cx - rad, cy - rad * 0.8, cx + rad, cy + rad * 0.8];
}
export function emptyParts(): number[] {
  return new Array(PARTS * 4).fill(0);
}
export function setPart(parts: number[], i: number, box: number[]) {
  for (let k = 0; k < 4; k++) parts[i * 4 + k] = box[k];
}

export interface CharArt<P> {
  name: string;
  w: number;
  h: number;
  ox: number;
  oy: number;
  anims: Record<AnimName, Anim<P>>;
  draw(r: Raster, p: P): Anchors;
}
