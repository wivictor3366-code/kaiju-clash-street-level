// KING GHIDORAH — drawn entirely in code.
// Rig: body spine (near tail -> pelvis -> chest -> middle neck), two extra necks,
// three hinged dragon heads with swept horns, two bat wings (arm + 4 finger bones +
// scalloped membrane), IK legs, twin maced tails. Gold ramp with staggered scale
// texture, pale segmented underbelly, fire-lit under-rim.
import { TM, retime, BV } from "../timing";
import { Raster, Shade, darken, rgb, hash2, bayer, rad, spline, ik, keys, clampi, rigBox, discBox, emptyParts, setPart, PART_CLAW, PART_HEAD, PART_TAIL, PART_FEET, PART_BODY, PART_WING, type Anim, type AnimName, type Anchors, type CharArt } from "./raster";

export interface KPose {
  px: number;
  py: number;
  rot: number;
  torso: number;
  necks: number[][]; // [far, mid, near] -> [a0, k1, k2] (start angle, curvature lower half, curvature upper half)
  heads: number[]; // abs angles
  jaws: number[];
  wingN: number[]; // [humerus, forearm, fanStart, fanStep]
  wingF: number[];
  footN: number[];
  footF: number[];
  tails: number[][]; // [far, near] -> [a0, k]
}

const W = 372, H = 316, OX = 202, OY = 272;

const OUT = rgb(0x120803);
const GOLD = [0x221105, 0x432409, 0x6c400f, 0x986417, 0xc38c22, 0xe7b93c, 0xfce27c];
const BELLY = [0x4a2f10, 0x7b5a22, 0xab863b, 0xd2b15e, 0xf0d78e];
const MEMB = [0x1c0b07, 0x321309, 0x4c200d, 0x6b3211, 0x8c4a18].map((h) => rgb(h));
const WARM = [0x8c3a10, 0xd4621a, 0xffa032];
const HORN = [0x64553c, 0xa69876, 0xdcd2b0, 0xf8f2dc];

/** gold scales; al!=255 encodes emissive position (GPU glow sweep up the necks) */
function gold(belly: boolean, al = 255): Shade {
  return (u, v, nx, ny, X, Y, r) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const w = -ny;
    if (w > 0.9) return rgb(WARM[w > 0.965 ? 2 : 1], al);
    if (w > 0.78 && bayer(X, Y) < 0.5) return rgb(WARM[0], al);
    if (belly && v < -0.36) {
      const seg = u / 5 - Math.floor(u / 5);
      const lb = 0.5 + ny * 0.3 + nz * 0.22 - (seg < 0.24 ? 0.3 : 0) + (bayer(X, Y) - 0.5) * 0.08;
      return rgb(BELLY[clampi(Math.floor(lb * 5), 0, 4)], al);
    }
    let l = 0.33 + ny * 0.42 + nz * 0.22;
    const row = Math.floor(u / 4), fu = u / 4 - row;
    const vv = (v * r) / 4 + (row & 1) * 0.5, fv = vv - Math.floor(vv);
    if (fu < 0.27) l -= 0.1;
    else if (fu > 0.55 && fv > 0.25 && fv < 0.78) l += 0.1;
    if (fv < 0.15) l -= 0.08;
    l += (bayer(X, Y) - 0.5) * 0.05;
    return rgb(GOLD[clampi(Math.floor(l * 7), 0, 6)], al);
  };
}
const G0 = gold(false), GB = gold(true);

function spike(r: Raster, bx: number, by: number, ang: number, len: number, wd: number, c0 = 1, al = 255) {
  const cx = Math.cos(rad(ang)), cy = Math.sin(rad(ang));
  r.poly([bx - cy * wd, by + cx * wd, bx + cx * len, by + cy * len, bx + cy * wd, by - cx * wd], rgb(HORN[c0 + 1], al));
  r.line(bx + cy * wd * 0.6, by - cx * wd * 0.6, bx + cx * (len - 1), by + cy * (len - 1), rgb(HORN[c0], al));
  r.dot(bx + cx * (len - 1), by + cy * (len - 1), rgb(HORN[3], al));
}

function neckPts(bx: number, by: number, np: number[], r0: number, r1: number): number[] {
  const out = [bx, by, r0];
  let x = bx, y = by;
  for (let i = 0; i < 8; i++) {
    const a = rad(np[0] + np[1] * Math.min(i, 4) + np[2] * Math.max(0, i - 4));
    x += Math.cos(a) * 10.5;
    y += Math.sin(a) * 10.5;
    out.push(x, y, r0 + ((r1 - r0) * (i + 1)) / 8);
  }
  return out;
}

/** spikes down the back of a neck (drawn before the neck so their bases tuck under) */
function neckSpikes(r: Raster, ch: number[]) {
  const n = ch.length / 3;
  let acc = 0;
  for (let i = 1; i < n; i++) {
    const dx = ch[i * 3] - ch[i * 3 - 3], dy = ch[i * 3 + 1] - ch[i * 3 - 2];
    const L = Math.hypot(dx, dy) || 1;
    acc += L;
    if (acc < 7) continue;
    acc = 0;
    const rr = ch[i * 3 + 2];
    const a = (Math.atan2(dy, dx) * 180) / Math.PI + 90 + 28; // back normal, raked toward the base
    spike(r, ch[i * 3] - (dy / L) * (rr - 2), ch[i * 3 + 1] + (dx / L) * (rr - 2), a, 5.5, 1.8, 0, 128 + Math.round((i / n) * 96));
  }
}

function head(r: Raster, bx: number, by: number, ang: number, jaw: number, sh: Shade): number[] {
  const ha = rad(ang), hx = Math.cos(ha), hy = Math.sin(ha);
  const k = 1.28;
  const Hx = (lx: number, ly: number) => bx + (lx * hx - ly * hy) * k;
  const Hy = (lx: number, ly: number) => by + (lx * hy + ly * hx) * k;
  // crown of horns sweeping back
  const horn = (x0: number, y0: number, x1: number, y1: number, tx: number, ty: number) => {
    r.poly([Hx(x0, y0), Hy(x0, y0), Hx(x1, y1), Hy(x1, y1), Hx(tx, ty), Hy(tx, ty)], (X, Y) => rgb(HORN[1 + ((hash2(X, Y) > 0.5 ? 1 : 0) & 1)]));
    r.line(Hx(x0, y0), Hy(x0, y0), Hx(tx, ty), Hy(tx, ty), rgb(HORN[0]));
    r.dot(Hx(tx, ty), Hy(tx, ty), rgb(HORN[3]));
  };
  horn(0, 3, 5, 7, -19, 16);
  horn(-2, 0, 1, 5, -21, 7);
  horn(-1, -4, 2, -1, -14, -5);
  // lower jaw
  const ja = rad(ang - 4 - jaw * 34), jx = Math.cos(ja), jy = Math.sin(ja);
  const J0x = Hx(3, -3.6), J0y = Hy(3, -3.6);
  r.limb([J0x, J0y, 3.7 * k, J0x + jx * 10 * k, J0y + jy * 10 * k, 3 * k, J0x + jx * 21 * k, J0y + jy * 21 * k, 2.2 * k], sh);
  if (jaw > 0.12) r.poly([Hx(4, -0.5), Hy(4, -0.5), Hx(25, -1.5), Hy(25, -1.5), J0x + (jx * 21 - jy * 2) * k, J0y + (jy * 21 + jx * 2) * k, J0x - jy * 3 * k, J0y + jx * 3 * k], (X, Y) => rgb(hash2(X >> 1, Y >> 1) > 0.55 ? 0x7a1a1e : 0x4a0e14, 228));
  // skull + long snout, cut flat on the lip line
  const sX = r.X(bx, by), sY = r.Y(bx, by);
  const uX = r.X(bx + hx, by + hy) - sX, uY = r.Y(bx + hx, by + hy) - sY;
  const cut: Shade = (u, v, nx, ny, X, Y, rr) => {
    const qx = X + 0.5 - sX, qy = Y + 0.5 - sY;
    if (qx * uX + qy * uY > 4 * k && qx * uY - qy * uX < -1.7 * k) return 0;
    return sh(u, v, nx, ny, X, Y, rr);
  };
  r.limb([Hx(0, 0.4), Hy(0, 0.4), 6.2 * k, Hx(6, 1.6), Hy(6, 1.6), 6.2 * k], cut);
  r.limb([Hx(6, 1.6), Hy(6, 1.6), 6 * k, Hx(15, 1), Hy(15, 1), 4.5 * k, Hx(22.5, 0.6), Hy(22.5, 0.6), 3.8 * k], cut);
  // angry brow spur, eye, nostril
  r.poly([Hx(4, 6), Hy(4, 6), Hx(12, 4.6), Hy(12, 4.6), Hx(3, 10), Hy(3, 10)], rgb(GOLD[5]));
  r.line(Hx(6, 5.4), Hy(6, 5.4), Hx(12.5, 4.2), Hy(12.5, 4.2), rgb(GOLD[0]));
  r.dot(Hx(9, 3), Hy(9, 3), rgb(0xff2a14, 250));
  r.dot(Hx(10.2, 3), Hy(10.2, 3), rgb(0xffa060, 250));
  r.dot(Hx(9.6, 3.8), Hy(9.6, 3.8), rgb(0xff2a14, 250));
  r.dot(Hx(24.5, 2.4), Hy(24.5, 2.4), rgb(GOLD[0]));
  // fangs
  for (let lx = 8; lx < 25; lx += 2.2) r.dot(Hx(lx, -2.3), Hy(lx, -2.3), rgb(HORN[lx > 18 ? 3 : 2]));
  r.dot(Hx(22, -3.5), Hy(22, -3.5), rgb(HORN[3]));
  r.dot(Hx(24.6, -3.5), Hy(24.6, -3.5), rgb(HORN[3]));
  if (jaw > 0.3) for (let s = 7; s < 21; s += 3) r.dot(J0x + (jx * s - jy * 3.3) * k, J0y + (jy * s + jx * 3.3) * k, rgb(HORN[2]));
  const mx = Hx(24, -3 - jaw * 4), my = Hy(24, -3 - jaw * 4);
  const lr = -3 - jaw * 4, kr = (24 * hx - lr * hy) * k, ky = (24 * hy + lr * hx) * k;
  return [r.X(mx, my), r.Y(mx, my), bx + kr, by + ky];
}

function wing(r: Raster, rx: number, ry: number, wp: number[], sc: number, mul: number, atx: number, aty: number): number[] {
  const ex = rx + Math.cos(rad(wp[0])) * 52 * sc, ey = ry + Math.sin(rad(wp[0])) * 52 * sc;
  const wx = ex + Math.cos(rad(wp[1])) * 60 * sc, wy = ey + Math.sin(rad(wp[1])) * 60 * sc;
  const LEN = [118, 112, 98, 78];
  const tips: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = rad(wp[2] + wp[3] * i);
    tips.push(wx + Math.cos(a) * LEN[i] * sc, wy + Math.sin(a) * LEN[i] * sc);
  }
  const pts = [rx, ry, ex, ey, wx, wy, tips[0], tips[1]];
  for (let i = 0; i < 3; i++) {
    const mx = (tips[i * 2] + tips[i * 2 + 2]) / 2, my = (tips[i * 2 + 1] + tips[i * 2 + 3]) / 2;
    pts.push(mx + (wx - mx) * 0.24, my + (wy - my) * 0.24, tips[i * 2 + 2], tips[i * 2 + 3]);
  }
  const mx = (tips[6] + atx) / 2, my = (tips[7] + aty) / 2;
  pts.push(mx + (ex - mx) * 0.3, my + (ey - my) * 0.3, atx, aty);
  const sX = r.X(wx, wy), sY = r.Y(wx, wy);
  r.poly(pts, (X, Y) => {
    const d = Math.hypot(X - sX, Y - sY) / (115 * sc);
    // thin membrane: darker by the bones, glowing warmer toward the trailing edge; faint radial streaks
    const streak = hash2(Math.floor((Math.atan2(Y - sY, X - sX) * 40) | 0), 3) > 0.7 ? -0.5 : 0;
    return MEMB[clampi(Math.floor(0.6 + d * 3.1 + streak + (bayer(X, Y) - 0.5) * 1.1), 0, 4)];
  });
  for (let i = 0; i < 4; i++) r.limb([wx, wy, 3.2, tips[i * 2], tips[i * 2 + 1], 1.2], G0);
  r.limb([rx, ry, 8.5, ex, ey, 6.4], G0);
  r.limb([ex, ey, 6.2, wx, wy, 4.4], G0);
  spike(r, wx, wy, wp[1] - 20 * Math.sign(wp[3]), 12, 2.6, 1);
  r.flush(OUT, mul);
  return pts;
}

function leg(r: Raster, hx: number, hy: number, ax: number, lift: number, mul: number) {
  const ay = 8 + lift;
  const [kx, ky] = ik(hx, hy, ax, ay, 33, 29, 1);
  r.limb([hx, hy, 18, kx, ky, 12.5], G0);
  r.limb([kx, ky, 11, ax, ay, 7], G0);
  const fa = rad(-10 - Math.max(0, lift) * 2.4);
  const tx = ax + Math.cos(fa) * 18, ty = ay + Math.sin(fa) * 18;
  r.limb([ax - 3, ay - 0.5, 6.5, ax, ay, 7, tx, ty - 0.5, 5.6], G0);
  for (let i = 0; i < 3; i++) spike(r, tx + 3, ty - 3 + i * 0.5, -22 + i * 16 - Math.max(0, lift) * 2.4, 10, 2, 1);
  spike(r, ax - 7, ay - 2, 200, 6, 1.8, 1);
  r.flush(OUT, mul);
}

function tailPts(bx: number, by: number, tp: number[]): number[] {
  const TR = [13, 11.5, 10, 8.6, 7.2, 5.9, 4.7, 3.7, 3];
  const fw = [bx, by, TR[0]];
  let x = bx, y = by;
  for (let i = 0; i < 8; i++) {
    const a = rad(tp[0] + tp[1] * i);
    x += Math.cos(a) * 15;
    y += Math.sin(a) * 15;
    fw.push(x, y, TR[i + 1]);
  }
  const out: number[] = [];
  for (let i = 8; i >= 0; i--) out.push(fw[i * 3], fw[i * 3 + 1], fw[i * 3 + 2]);
  return out; // tip -> base
}
function mace(r: Raster, t: number[]) {
  const a = (Math.atan2(t[1] - t[4], t[0] - t[3]) * 180) / Math.PI;
  for (const d of [-80, -40, 0, 40, 80]) spike(r, t[0], t[1], a + d, d === 0 ? 10 : 8, 2, 1);
}

function draw(r: Raster, p: KPose): Anchors {
  const pvx = p.px, pvy = 66 + p.py;
  r.setT(OX, OY, p.rot, pvx, pvy);
  r.clipY = p.rot !== 0 && p.py >= 0 ? H - 1 : OY - 1;
  const tr = rad(p.torso), tx = Math.cos(tr), ty = Math.sin(tr), fx = ty, fy = -tx;
  const bel = [pvx + tx * 22 + fx * 3, pvy + ty * 22 + fy * 3];
  const che = [pvx + tx * 50, pvy + ty * 50];

  // ---- far wing, far tail, far leg, far neck
  // BOTH wings sweep back over the same shoulder line: the far wing is the near wing's twin, folded a little higher and
  // further up/forward so it peeks out behind it (drawn behind the whole body, dimmer); the near wing is drawn in front of it.
  const wN = p.wingN;
  const wF = [wN[0] - 24, wN[1] - 16, wN[2] - 12, wN[3] * 0.92];
  wing(r, che[0] + 3 * fx + 2 * tx, che[1] + 3 * fy + 2 * ty + 6, wF, 0.9, 0.52, pvx - 10, pvy + 20);
  const ft = spline(tailPts(pvx - 6, pvy + 2, p.tails[0]), 5);
  mace(r, ft);
  r.limb(ft, G0);
  r.flush(OUT, 0.66);
  leg(r, pvx - 3, pvy - 6, p.footF[0], p.footF[1], 0.6);
  // far neck: its root sinks into the chest (hidden behind the torso) so it grows out of the shoulders
  const fnb = [che[0] - 9 * fx - 2 * tx, che[1] - 9 * fy - 2 * ty + 3];
  const fnp = neckPts(fnb[0], fnb[1], p.necks[0], 10, 7.5);
  const fn = spline([fnb[0] - tx * 16, fnb[1] - ty * 16, 14, fnb[0] - tx * 8, fnb[1] - ty * 8, 12.5, ...fnp], 4);
  neckSpikes(r, fn);
  r.limb(fn, GB);
  const m0 = head(r, fn[fn.length - 3], fn[fn.length - 2], p.heads[0], p.jaws[0], G0);
  r.flush(OUT, 0.7);

  // ---- body: near tail -> pelvis -> chest -> middle neck -> middle head
  const nt = tailPts(pvx - 10, pvy - 6, p.tails[1]);
  const mn = neckPts(che[0] + tx * 6, che[1] + ty * 6, p.necks[1], 13.5, 7.7);
  // the chest tapers into the neck roots through an intermediate shoulder mass instead of ending in a round cap
  const cp = [...nt, pvx, pvy, 24, bel[0], bel[1], 26, che[0], che[1], 22.5, che[0] + tx * 3, che[1] + ty * 3, 18, ...mn];
  const body = spline(cp, 5);
  mace(r, body);
  neckSpikes(r, spline(mn, 4));
  r.limb(body, GB);
  const m1 = head(r, mn[mn.length - 3], mn[mn.length - 2], p.heads[1], p.jaws[1], G0);
  r.flush(OUT);

  // ---- near wing: in front of the body and the far wing, behind the near neck
  const wpN = wing(r, che[0] - fx * 13 + tx * 2, che[1] - fy * 13 + ty * 2, wN, 1, 0.86, pvx - 16, pvy + 12);

  // ---- near leg
  leg(r, pvx + 4, pvy - 8, p.footN[0], p.footN[1], 1);

  // ---- near neck + head: starts deep inside the chest and cross-fades (dithered) into the torso that is already drawn,
  //      then grows its own scales; a soft crease only appears where it passes over other necks / the wing
  const nnb = [che[0] + 7 * fx + 3 * tx, che[1] + 7 * fy + 3 * ty];
  const nnp = neckPts(nnb[0], nnb[1], p.necks[2], 12.5, 7.6);
  const nn = spline([nnb[0] - tx * 26, nnb[1] - ty * 26 - fy * 2, 17, nnb[0] - tx * 14, nnb[1] - ty * 14, 15, nnb[0] - tx * 5, nnb[1] - ty * 5, 13.5, ...nnp], 4);
  const px0 = r.px, W0 = r.w;
  const nearGold: Shade = (u, v, nx, ny, X, Y, rr) => {
    const under = px0[Y * W0 + X];
    if (under) {
      const L = 22, B = 16;
      if (u < L) return 0;
      if (u < L + B && bayer(X, Y) > (u - L) / B) return 0;
      if (u > L + B && Math.abs(v) > 0.84) return darken(GB(u, v, nx, ny, X, Y, rr), 0.55);
    }
    return GB(u, v, nx, ny, X, Y, rr);
  };
  const nearHeadSh: Shade = (u, v, nx, ny, X, Y, rr) => (px0[Y * W0 + X] && Math.abs(v) > 0.86 ? darken(G0(u, v, nx, ny, X, Y, rr), 0.55) : G0(u, v, nx, ny, X, Y, rr));
  neckSpikes(r, nn);
  r.limb(nn, nearGold);
  const m2 = head(r, nn[nn.length - 3], nn[nn.length - 2], p.heads[2], p.jaws[2], nearHeadSh);
  r.flush(OUT, 1, 1);

  const parts = emptyParts();
  setPart(parts, PART_CLAW, discBox(r, nn[nn.length - 3], nn[nn.length - 2], 17, OX, OY));
  const hp: number[] = [];
  for (const m of [m0, m1, m2]) hp.push(m[2] - 9, m[3] - 9, m[2] + 15, m[3] + 13);
  for (const b of [fn, mn, nn]) hp.push(b[b.length - 3] - 12, b[b.length - 2] - 12, b[b.length - 3] + 18, b[b.length - 2] + 18);
  setPart(parts, PART_HEAD, rigBox(r, hp, OX, OY));
  const tp: number[] = [];
  for (const t2 of [ft, body]) for (const i of [0, 3, 6, 9, 12, 15]) tp.push(t2[i] - 11, t2[i + 1] - 11, t2[i] + 11, t2[i + 1] + 11);
  setPart(parts, PART_TAIL, rigBox(r, tp, OX, OY));
  setPart(parts, PART_FEET, rigBox(r, [p.footN[0] - 22, 2 + p.footN[1], p.footN[0] + 26, 2 + p.footN[1], pvx + 4, pvy - 36, pvx + 44, pvy - 36], OX, OY));
  setPart(parts, PART_BODY, rigBox(r, [pvx - 28, pvy - 32, che[0] - 24, che[1] - 30, che[0] + 24, che[1] + 30, pvx + 36, pvy + 32], OX, OY));
  setPart(parts, PART_WING, rigBox(r, wpN, OX, OY)); // the wing sweep volume (WING GALE)
  const da = (i: number) => rad(p.heads[i] + p.rot); // each head fires along its own axis
  return { mouths: [m1[0], m1[1], m2[0], m2[1], m0[0], m0[1]], dirs: [da(1), da(2), da(0)], hand: m2, parts };
}

// ------------------------------------------------------------------ animation
const KN: KPose = {
  px: 0, py: 0, rot: 0, torso: 80,
  necks: [[106, 5, -19], [92, 5, -21], [80, -3, -21]],
  heads: [-6, -18, -28],
  jaws: [0.1, 0.1, 0.15],
  wingN: [140, 96, 168, 27],
  wingF: [58, 88, 14, -24],
  footN: [-12, 0], footF: [16, 0],
  tails: [[186, -11], [205, -9]],
};
const S = Math.sin, PI2 = Math.PI * 2;
const sway = (f: number, n: number[], i: number): number[] => [n[0] + S(f - i * 1.3) * 3.4, n[1] + S(f - i) * 0.7, n[2] + S(f - i * 0.9) * 1.7];

const idle = (t: number): KPose => {
  const f = (PI2 * t) / 84;
  return {
    ...KN,
    py: -1 + Math.cos(f),
    necks: KN.necks.map((n, i) => sway(f, n, i)),
    heads: KN.heads.map((h, i) => h + S(f - i * 1.1) * 4.5),
    jaws: KN.jaws.map((j, i) => (S(f - i * 2) > 0.6 ? 0.45 : j)),
    wingN: [140 + S(f) * 2.4, 96 + S(f - 0.4) * 2.4, 168, 27 + S(f) * 0.9],
    wingF: [58 - S(f) * 2.4, 88 - S(f - 0.4) * 2.4, 14, -24 - S(f) * 0.9],
    tails: KN.tails.map((tl, i) => [tl[0] + S(f - i * 1.5) * 4.5, tl[1] + S(f - i) * 1.4]),
  };
};
const stepFoot = (ph: number): number[] => {
  ph -= Math.floor(ph);
  if (ph < 0.6) return [16 - 32 * (ph / 0.6), 0];
  const s = (ph - 0.6) / 0.4;
  return [-16 + 32 * s, S(Math.PI * s) * 12];
};
const walk = (t: number): KPose => {
  const ph = t / 64, f = PI2 * ph;
  const a = stepFoot(ph), b = stepFoot(ph + 0.5);
  return {
    ...KN,
    py: -2.5 + 2.5 * Math.abs(S(f)),
    torso: 78 + 3 * S(f),
    necks: KN.necks.map((n, i) => [n[0] + S(f - i * 1.2) * 4, n[1], n[2] + S(f - i) * 1.8]),
    heads: KN.heads.map((h, i) => h + S(f * 2 - i) * 3.5),
    wingN: [140 + S(f * 2) * 3.5, 96 + S(f * 2 - 0.5) * 3.5, 168, 27],
    wingF: [58 - S(f * 2) * 3.5, 88, 14, -24],
    footN: [a[0] - 3, a[1]], footF: [b[0] + 5, b[1]],
    tails: KN.tails.map((tl, i) => [tl[0] + S(f - i * 1.5) * 5.5, tl[1] + S(f - i) * 1.7]),
  };
};
const FIRE: Partial<KPose> = { px: 3, py: -2, torso: 76, necks: [[100, 2, -22], [88, 2, -24], [76, 0, -22]], heads: [-14, -20, -26], jaws: [1, 1, 1], wingN: [146, 104, 160, 30], wingF: [52, 82, 20, -27], footN: [-16, 0], footF: [19, 0] };
const GRAB: Partial<KPose> = { px: 6, py: -2, torso: 72, necks: [[104, 5, -19], [68, -4, -12], [56, -6, -9]], heads: [-8, -26, -18], jaws: [0.1, 0.9, 0.9], footF: [22, 0] };
const DOWN: Partial<KPose> = { rot: 95, py: -41, torso: 82, necks: [[100, -4, -10], [92, -5, -9], [84, -6, -8]], heads: [44, 30, 16], jaws: [0.5, 0.3, 0.6], wingN: [62, 80, 62, 10], wingF: [-52, -70, -60, -12], footN: [5, -34], footF: [17, -28], tails: [[258, 6], [268, 4]] };
const SLAM: Partial<KPose> = { px: 8, py: -3, torso: 68, necks: [[72, -4, -10], [62, -5, -10], [52, -6, -9]], heads: [-30, -28, -24], jaws: [0.35, 0.35, 0.35], wingN: [165, 122, 192, 21], wingF: [62, 96, 44, -22], footF: [22, 0] };
const CROUCH: Partial<KPose> = { px: -6, py: -8, torso: 90, necks: [[118, 6, -12], [110, 6, -12], [102, 4, -12]], heads: [10, 4, -2], jaws: [0.2, 0.2, 0.2], wingN: [122, 88, 150, 28], wingF: [66, 92, 30, -26], footN: [-18, 0], footF: [14, 0] };
const RISE: Partial<KPose> = { px: 2, py: -16, torso: 62, necks: [[92, 0, -18], [80, -2, -18], [68, -4, -16]], heads: [-26, -30, -34], jaws: [0.9, 0.9, 0.9], wingN: [176, 140, 210, 18], wingF: [34, 58, -8, -20], footN: [-6, 16], footF: [28, 19], tails: [[180, -3], [196, -3]] };
const SW_BACK = [[168, -6], [188, -6]];
const SW_FWD = [[28, 8], [44, 6]];

const anims: Partial<Record<AnimName, Anim<KPose>>> = {
  idle: { n: 7, step: 12, fn: idle },
  walk: { n: 8, step: 8, fn: walk },
  dash: { n: 3, step: 9, fn: (t) => ({ ...KN, px: 6, py: 4, torso: 62, necks: [[86, 0, -16], [74, 0, -16], [62, -2, -14]], heads: [-10, -14, -18], wingN: t < 9 ? [128, 92, 150, 30] : [168, 130, 196, 20], wingF: t < 9 ? [64, 92, 30, -28] : [36, 60, -6, -20], footN: [-18, 8], footF: [6, 12], tails: [[182, -3], [192, -3]] }) },
  bdash: { n: 3, step: 9, fn: (t) => ({ ...KN, px: -6, py: 4, torso: 90, necks: [[112, 4, -14], [102, 4, -14], [92, 2, -14]], heads: [-20, -26, -32], wingN: t < 9 ? [160, 120, 190, 22] : [130, 92, 152, 30], wingF: t < 9 ? [44, 70, 0, -22] : [66, 94, 30, -28], footN: [-6, 8], footF: [18, 12], tails: [[200, -12], [220, -11]] }) },
  block: { n: 2, step: 7, fn: (t) => ({ ...KN, px: t < 7 ? -7 : -4, py: -4, torso: t < 7 ? 89 : 85, necks: [[122, 6, -12], [114, 6, -14], [106, 4, -16]], heads: [-42, -48, -52], jaws: [0, 0, 0], wingN: [122, 100, 188, 17], wingF: [70, 84, 4, -16], footN: [-16, 0], footF: [10, 0] }) },
  light: {
    n: 13, step: 3,
    fn: keys(KN, [
      [0, {}],
      [7, { px: -7, py: -3, torso: 86, necks: [[112, 5, -17], [100, 5, -18], [104, 2, -13]], heads: [4, -8, 6], jaws: [0.15, 0.15, 0.95], wingN: [130, 92, 158, 28] }],
      [12, { px: -8, py: -4, torso: 88, necks: [[114, 5, -16], [102, 5, -17], [108, 2, -12]], heads: [6, -6, 8], jaws: [0.15, 0.15, 1] }],
      [17, { px: 7, py: -2, torso: 70, necks: [[102, 5, -19], [88, 4, -21], [50, -6, -8]], heads: [-10, -22, -16], jaws: [0.1, 0.3, 0.85], footF: [23, 0], wingN: [150, 108, 172, 24] }],
      [23, { px: 8, py: -2, torso: 69, necks: [[102, 5, -19], [88, 4, -21], [48, -6, -8]], heads: [-10, -22, -20], jaws: [0.1, 0.3, 0.1], footF: [23, 0] }],
      [30, { px: -1, torso: 78, necks: [[104, 5, -19], [90, 5, -20], [72, -2, -16]], heads: [-8, -18, -24], jaws: [0.1, 0.1, 0.15] }],
      [39, {}],
    ]),
  },
  heavy: {
    n: 16, step: 4,
    fn: keys(KN, [
      [0, {}],
      [12, { px: -5, py: -4, torso: 88, necks: [[118, 4, -8], [108, 4, -8], [98, 3, -8]], heads: [24, 18, 12], jaws: [0.9, 0.9, 0.9], wingN: [128, 98, 150, 26], wingF: [66, 92, 30, -27] }],
      [18, { px: -6, py: -5, torso: 89, necks: [[120, 4, -7], [110, 4, -7], [100, 3, -7]], heads: [27, 21, 15], jaws: [1, 1, 1], wingN: [126, 96, 148, 27], wingF: [68, 94, 32, -28] }],
      [26, SLAM],
      [34, { ...SLAM, px: 9, heads: [-32, -30, -26] }],
      [44, { ...SLAM, px: 8, heads: [-24, -22, -18], jaws: [0.2, 0.2, 0.2] }],
      [56, { px: 2, torso: 82, necks: [[108, 4, -15], [96, 4, -16], [84, 1, -15]], heads: [0, -8, -14] }],
      [72, {}],
    ]),
  },
  beamA: {
    n: 5, step: 8,
    fn: keys(KN, [
      [0, {}],
      [10, { px: -4, torso: 86, necks: [[108, 3, -6], [98, 3, -6], [88, 2, -6]], heads: [54, 48, 42], jaws: [0.4, 0.4, 0.4], wingN: [150, 110, 160, 30], wingF: [50, 80, 22, -28] }],
      [22, { px: -4, torso: 85, necks: [[110, 3, -5], [100, 3, -5], [90, 2, -5]], heads: [58, 52, 46], jaws: [0.6, 0.6, 0.6], wingN: [152, 112, 160, 30] }],
      [34, { px: -2, torso: 82, necks: [[106, 3, -12], [96, 3, -13], [84, 1, -12]], heads: [24, 18, 10], jaws: [0.8, 0.8, 0.8], wingN: [148, 106, 160, 30], wingF: [52, 82, 20, -27] }],
      [40, { px: -2, torso: 82, necks: [[106, 3, -12], [96, 3, -13], [84, 1, -12]], heads: [24, 18, 10], jaws: [0.7, 0.7, 0.7] }],
    ]),
  },
  // 3 pitch variants x BV frames: [low, mid, high]; every head tilts with the variant so each beam leaves its own mouth on its own axis
  beamB: { n: BV * 3, step: 11, fn: (t) => {
    const i = Math.round(t / 11), v = Math.floor(i / BV), tt = (i % BV) * 11, off = [-13, 0, 12][v];
    const h = tt < 11 ? [-15, -21, -27] : [-13, -21, -25];
    return { ...KN, ...FIRE, px: tt < 22 ? 3 : 4, heads: h.map((a) => a + off), jaws: tt < 33 ? [1, 1, 1] : [0.9, 0.9, 0.9] };
  } },
  beamC: { n: 3, step: 10, fn: keys(KN, [[0, { ...FIRE, jaws: [0.6, 0.6, 0.6] }], [14, { ...FIRE, jaws: [0.2, 0.2, 0.2], heads: [-16, -22, -28] }], [28, {}]]) },
  grab: { n: 9, step: 7, fn: keys(KN, [[0, {}], [8, { ...GRAB, px: 3, necks: [[104, 5, -19], [84, 0, -16], [70, -3, -12]] }], [16, GRAB], [40, GRAB], [52, { px: 4, torso: 76, necks: [[102, 4, -18], [86, 2, -18], [72, -2, -15]], heads: [-6, -20, -22], jaws: [0.2, 0.5, 0.4] }], [58, {}]]) },
  throw: {
    n: 12, step: 6,
    fn: keys(KN, [
      [0, GRAB],
      [13, { px: 0, torso: 87, necks: [[110, 5, -14], [102, 4, -10], [94, 3, -10]], heads: [10, 32, 30], jaws: [0.3, 0.8, 0.8], wingN: [132, 98, 154, 28] }],
      [24, { px: -1, torso: 88, necks: [[110, 5, -14], [104, 4, -9], [96, 3, -9]], heads: [10, 36, 34], jaws: [0.3, 0.8, 0.8], wingN: [130, 96, 152, 28] }],
      [31, { px: 8, py: -3, torso: 68, necks: [[90, 0, -20], [64, -4, -12], [54, -5, -10]], heads: [-20, -30, -25], jaws: [1, 1, 1], wingN: [164, 120, 190, 21], footF: [22, 0] }],
      [40, { px: 8, py: -3, torso: 68, necks: [[90, 0, -20], [62, -4, -12], [52, -5, -10]], heads: [-20, -32, -27], jaws: [0.8, 0.8, 0.8], wingN: [164, 120, 190, 21], footF: [22, 0] }],
      [52, { px: 2, torso: 79 }],
      [66, {}],
    ]),
  },
  stomp: {
    n: 13, step: 4,
    fn: keys(KN, [
      [0, {}],
      [8, CROUCH],
      [14, CROUCH],
      [24, RISE],
      [30, { px: 4, py: 8, torso: 94, necks: [[104, 2, -14], [94, 2, -14], [84, 0, -14]], heads: [8, 2, -6], jaws: [1, 1, 1], wingN: [188, 152, 216, 15], wingF: [30, 50, -14, -17], footN: [-24, 0], footF: [24, 0], tails: [[188, -12], [204, -11]] }],
      [38, { px: 2, py: 4, torso: 92, necks: [[104, 2, -14], [94, 2, -14], [84, 0, -14]], heads: [2, -2, -10], jaws: [0.5, 0.5, 0.5], footN: [-22, 0], footF: [22, 0] }],
      [52, {}],
    ]),
  },
  sweep: {
    n: 14, step: 4,
    fn: keys(KN, [
      [0, {}],
      [9, { px: -6, py: -4, torso: 92, necks: [[116, 4, -12], [106, 4, -12], [96, 3, -12]], heads: [14, 8, 2], wingN: [128, 94, 158, 26], tails: SW_BACK, footN: [-18, 0], footF: [14, 0] }],
      [15, { px: -7, py: -5, torso: 93, necks: [[118, 4, -11], [108, 4, -11], [98, 3, -11]], heads: [16, 10, 4], tails: [[176, -4], [196, -4]] }],
      [25, { px: 8, py: -3, torso: 66, necks: [[96, 2, -18], [84, 2, -18], [72, 0, -16]], heads: [-12, -18, -24], jaws: [0.6, 0.6, 0.6], tails: SW_FWD, footF: [22, 0], wingN: [162, 122, 186, 21] }],
      [32, { px: 9, py: -3, torso: 65, necks: [[96, 2, -18], [84, 2, -18], [72, 0, -16]], heads: [-12, -18, -24], jaws: [0.3, 0.3, 0.3], tails: [[10, 10], [26, 8]], footF: [22, 0], wingN: [162, 122, 186, 21] }],
      [48, {}],
    ]),
  },
  charge: {
    n: 13, step: 4,
    fn: keys(KN, [
      [0, {}],
      [9, { px: -9, py: -6, torso: 92, necks: [[120, 4, -10], [110, 4, -10], [100, 2, -10]], heads: [24, 16, 8], jaws: [0.3, 0.3, 0.3], wingN: [124, 92, 156, 27], footN: [-20, 0], footF: [12, 0] }],
      [16, { px: 2, py: -3, torso: 70, necks: [[96, 0, -18], [84, -2, -18], [72, -4, -16]], heads: [-18, -24, -30], jaws: [0.9, 0.9, 0.9], wingN: [166, 128, 196, 20], footN: [-6, 0], footF: [22, 0], tails: [[180, -6], [196, -6]] }],
      [24, { px: 8, py: -4, torso: 64, necks: [[92, 0, -20], [80, -2, -20], [68, -4, -18]], heads: [-24, -30, -36], jaws: [0.9, 0.9, 0.9], wingN: [176, 140, 206, 18], footF: [24, 0], tails: [[176, -4], [192, -4]] }],
      [34, { px: 8, py: -4, torso: 64, necks: [[92, 0, -20], [80, -2, -20], [68, -4, -18]], heads: [-24, -30, -36], jaws: [0.7, 0.7, 0.7], wingN: [176, 140, 206, 18], footF: [24, 0] }],
      [48, {}],
    ]),
  },
  hit: { n: 2, step: 8, fn: (t) => (t < 8 ? { ...KN, px: -6, torso: 91, necks: [[126, 6, -4], [119, 6, -4], [111, 6, -4]], heads: [62, 52, 42], jaws: [0.8, 0.6, 0.8], wingN: [152, 122, 178, 19], wingF: [72, 96, 34, -24], footN: [-15, 0], footF: [8, 0], tails: [[178, -8], [196, -7]] } : { ...KN, px: -3, torso: 86, necks: [[116, 5, -12], [106, 5, -13], [96, 2, -13]], heads: [24, 14, 6], jaws: [0.4, 0.3, 0.4] }) },
  launch: { n: 2, step: 12, fn: (t) => ({ ...KN, rot: t < 12 ? 30 : 62, torso: 86, necks: [[120, 5, -6], [112, 5, -6], [104, 4, -6]], heads: [50, 42, 34], jaws: [0.8, 0.8, 0.8], wingN: [124, 104, 204, 11], wingF: [74, 102, 64, -13], footN: [6, 12], footF: [24, 18], tails: [[190, -5], [200, -5]] }) },
  down: { n: 1, step: 10, fn: () => ({ ...KN, ...DOWN }) },
  getup: { n: 4, step: 8, fn: keys(KN, [[0, DOWN], [10, { rot: 40, py: -20, torso: 76, necks: [[104, 4, -10], [94, 3, -10], [84, 0, -10]], heads: [30, 22, 12], wingN: [120, 96, 150, 22], wingF: [20, 30, -10, -18], footN: [2, -8], footF: [20, -6], tails: [[230, -4], [244, -4]] }], [20, { rot: 6, py: -6, torso: 80, necks: [[106, 5, -18], [94, 5, -19], [82, 2, -17]], heads: [2, -8, -16], wingN: [132, 100, 160, 25], wingF: [56, 86, 12, -23], tails: [[200, -8], [216, -8]] }], [32, {}]]) },
  win: {
    n: 10, step: 8,
    fn: (t) => {
      const k = keys(KN, [[0, {}], [10, { torso: 84, necks: [[110, 4, -12], [98, 4, -13], [86, 1, -13]], heads: [20, 16, 10], jaws: [0.5, 0.5, 0.5] }], [22, { px: -2, torso: 87, necks: [[114, 3, -8], [100, 3, -8], [86, 2, -8]], heads: [44, 48, 38], jaws: [1, 1, 1], wingN: [136, 96, 152, 30], wingF: [56, 86, 26, -28] }], [30, { px: -2, py: -14, torso: 88, necks: [[116, 3, -6], [102, 3, -6], [88, 2, -6]], heads: [50, 54, 44], jaws: [1, 1, 1], wingN: [186, 150, 212, 16], wingF: [26, 46, -12, -17], footN: [-4, 14], footF: [26, 16] }]])(t);
      return t > 30 ? { ...k, heads: k.heads.map((h, i) => h + S(t * 0.8 + i * 2) * 4) } : k;
    },
  },
};

// ---- 2.5D brawler moves. Ghidorah has no arms: the NEAR head's jaws are its "hand" — it bites
// the tower, tears it out and carries it aloft on the near neck (the renderer pins it to that mouth).
const KCARRY: Partial<KPose> = { px: -3, py: -2, torso: 86, necks: [[112, 4, -10], [104, 3, -10], [104, 3, -4]], heads: [24, 18, 30], jaws: [0.4, 0.4, 0.15], wingN: [150, 112, 168, 30], wingF: [52, 82, 20, -28], footN: [-14, 0], footF: [18, 0] };
const kCarryWalk = (t: number): KPose => {
  const ph = t / 48, f = PI2 * ph;
  const a = stepFoot(ph), b = stepFoot(ph + 0.5);
  return {
    ...KN, ...KCARRY,
    py: -3 + 2 * Math.abs(S(f)), torso: 86 + 1.5 * S(f),
    necks: [[112 + S(f) * 3, 4, -10], [104 + S(f - 1) * 3, 3, -10], [104 + S(f) * 2, 3, -4]],
    heads: [24 + S(f * 2) * 4, 18 + S(f * 2 - 1) * 4, 30 + S(f) * 2],
    wingN: [150 + S(f * 2) * 6, 112 + S(f * 2 - 0.5) * 6, 168, 30], wingF: [52 - S(f * 2) * 6, 82, 20, -28],
    footN: [a[0] * 0.75 - 3, a[1] * 0.8], footF: [b[0] * 0.75 + 5, b[1] * 0.8],
    tails: KN.tails.map((tl, i) => [tl[0] + S(f - i * 1.5) * 4, tl[1] + S(f - i) * 1.2]),
  };
};
Object.assign(anims, {
  // near head pecks down from high (chains from LIGHT)
  light2: {
    n: 11, step: 3,
    fn: keys(KN, [
      [0, { px: 7, py: -2, torso: 70, necks: [[102, 5, -19], [88, 4, -21], [50, -6, -8]], heads: [-10, -22, -16], jaws: [0.1, 0.3, 0.6], footF: [23, 0] }],
      [6, { px: 3, py: -3, torso: 80, necks: [[104, 5, -18], [92, 5, -20], [112, 4, -10]], heads: [-8, -20, 30], jaws: [0.2, 0.3, 1], wingN: [146, 104, 166, 26] }],
      [11, { px: 11, py: -2, torso: 68, necks: [[100, 4, -19], [86, 4, -20], [38, -8, -12]], heads: [-10, -24, -50], jaws: [0.2, 0.4, 0.2], footF: [24, 0], wingN: [156, 114, 180, 23] }],
      [16, { px: 11, py: -2, torso: 68, necks: [[100, 4, -19], [86, 4, -20], [34, -8, -12]], heads: [-10, -24, -56], jaws: [0.2, 0.4, 0.5], footF: [24, 0] }],
      [24, { px: 2, torso: 78 }],
      [30, {}],
    ]),
  },
  // all three heads lunge and snap shut (chains from LIGHT2, launches)
  light3: {
    n: 13, step: 3,
    fn: keys(KN, [
      [0, { px: 8, py: -2, torso: 70, necks: [[100, 4, -19], [86, 4, -20], [40, -8, -12]], heads: [-10, -24, -50], jaws: [0.2, 0.4, 0.5] }],
      [7, { px: -6, py: -4, torso: 88, necks: [[116, 4, -10], [106, 4, -10], [98, 3, -10]], heads: [20, 14, 8], jaws: [0.8, 0.8, 0.8], wingN: [126, 94, 150, 27], wingF: [66, 92, 30, -27] }],
      [13, { px: 6, py: -3, torso: 70, necks: [[90, 0, -18], [78, -2, -18], [66, -4, -16]], heads: [-14, -20, -26], jaws: [1, 1, 1] }],
      [17, { px: 15, py: -3, torso: 62, necks: [[70, -4, -12], [58, -5, -12], [46, -6, -10]], heads: [-24, -26, -28], jaws: [0.1, 0.1, 0.1], wingN: [170, 130, 196, 20], footN: [-20, 0], footF: [27, 0] }],
      [25, { px: 14, py: -3, torso: 63, necks: [[72, -4, -12], [60, -5, -12], [48, -6, -10]], heads: [-22, -24, -26], jaws: [0.3, 0.3, 0.3], footN: [-20, 0], footF: [27, 0] }],
      [36, {}],
    ]),
  },
  // crouch, near head dives and bites the tower at RIP_GRIP (t=18), wings flare as it tears it out
  rip: {
    n: 12, step: 4,
    fn: keys(KN, [
      [0, {}],
      [8, { px: 2, py: -8, torso: 74, necks: [[100, 3, -16], [86, 2, -16], [40, -6, -12]], heads: [-20, -30, -50], jaws: [0.3, 0.3, 0.8], footN: [-18, 0], footF: [22, 0] }],
      [18, { px: 4, py: -24, torso: 64, necks: [[92, 2, -16], [76, 0, -14], [0, -6, -10]], heads: [-26, -36, -85], jaws: [0.5, 0.5, 0.15], wingN: [128, 94, 156, 27], wingF: [64, 92, 28, -26], footN: [-22, 0], footF: [24, 0] }],
      [26, { px: 0, py: -12, torso: 78, necks: [[104, 4, -14], [96, 3, -14], [60, -2, -10]], heads: [10, 0, -20], jaws: [1, 1, 0.15], wingN: [160, 124, 190, 21], wingF: [40, 66, 0, -20], footN: [-20, 0], footF: [22, 0] }],
      [34, { px: -2, py: -6, torso: 84, necks: [[108, 4, -12], [100, 3, -12], [92, 2, -8]], heads: [20, 14, 10], jaws: [0.6, 0.6, 0.15], wingN: [168, 132, 200, 19], wingF: [36, 60, -6, -20] }],
      [42, KCARRY],
      [44, KCARRY],
    ]),
  },
  carry: { n: 6, step: 8, fn: kCarryWalk },
  hurl: {
    n: 9, step: 4,
    fn: keys(KN, [
      [0, KCARRY],
      [7, { px: -6, py: -4, torso: 92, necks: [[116, 4, -8], [108, 4, -8], [118, 4, -2]], heads: [30, 24, 50], jaws: [0.6, 0.6, 0.15], wingN: [126, 92, 150, 28] }],
      [14, { px: 10, py: -3, torso: 66, necks: [[92, 0, -18], [76, -2, -16], [40, -6, -10]], heads: [-16, -24, -34], jaws: [1, 1, 1], wingN: [168, 128, 196, 20], footN: [-18, 0], footF: [24, 0] }],
      [20, { px: 9, py: -3, torso: 66, necks: [[92, 0, -18], [76, -2, -16], [36, -6, -10]], heads: [-18, -26, -38], jaws: [0.7, 0.7, 0.6], footN: [-18, 0], footF: [24, 0] }],
      [32, {}],
    ]),
  },
  bslam: {
    n: 12, step: 4,
    fn: keys(KN, [
      [0, KCARRY],
      [9, { px: -7, py: -2, torso: 94, necks: [[118, 4, -6], [110, 4, -6], [124, 4, 0]], heads: [34, 28, 60], jaws: [0.6, 0.6, 0.15], wingN: [130, 96, 152, 28] }],
      [16, { px: 9, py: -10, torso: 62, necks: [[80, -2, -14], [66, -4, -12], [20, -8, -12]], heads: [-30, -34, -70], jaws: [1, 1, 0.15], wingN: [172, 136, 204, 18], footN: [-22, 0], footF: [26, 0] }],
      [20, { px: 10, py: -12, torso: 60, necks: [[78, -2, -14], [64, -4, -12], [14, -8, -12]], heads: [-32, -36, -76], jaws: [0.9, 0.9, 0.6], footN: [-22, 0], footF: [26, 0] }],
      [30, { px: 8, py: -8, torso: 66, necks: [[86, 0, -16], [72, -2, -14], [30, -6, -10]], heads: [-24, -28, -50], jaws: [0.5, 0.5, 0.5], footN: [-22, 0], footF: [26, 0] }],
      [44, {}],
    ]),
  },
  roar: {
    n: 9, step: 8,
    fn: (t: number) => {
      const k = keys(KN, [
        [0, {}],
        [10, { px: -3, torso: 84, necks: [[112, 4, -10], [100, 4, -10], [88, 2, -10]], heads: [30, 26, 20], jaws: [0.6, 0.6, 0.6], wingN: [150, 112, 168, 30], wingF: [50, 80, 20, -28] }],
        [20, { px: -4, py: -3, torso: 88, necks: [[120, 3, -4], [106, 3, -4], [92, 2, -4]], heads: [60, 54, 48], jaws: [1, 1, 1], wingN: [176, 140, 214, 17], wingF: [30, 52, -14, -18] }],
        [54, { px: -4, py: -3, torso: 88, necks: [[120, 3, -4], [106, 3, -4], [92, 2, -4]], heads: [58, 52, 46], jaws: [1, 1, 1], wingN: [176, 140, 214, 17], wingF: [30, 52, -14, -18] }],
        [64, {}],
      ])(t);
      return t > 20 && t < 54 ? { ...k, heads: k.heads.map((h, i) => h + S(t * 0.9 + i * 2) * 4), jaws: k.jaws.map((j, i) => 0.85 + S(t * 1.9 + i) * 0.15) } : k;
    },
  },
  // RISING MAWS (UP+LIGHT): coil, then all three heads whip upward
  upper: {
    n: 13, step: 4,
    fn: keys(KN, [
      [0, {}],
      [7, { ...CROUCH, px: -6, py: -9, necks: [[118, 6, -12], [110, 6, -12], [102, 4, -12]], heads: [10, 4, -2], jaws: [0.3, 0.3, 0.3] }],
      [13, { ...CROUCH, px: -8, py: -12, torso: 92, heads: [12, 6, 0], jaws: [0.2, 0.2, 0.2] }],
      [17, { px: 13, py: 3, torso: 60, necks: [[62, 2, -10], [54, 0, -10], [46, -2, -8]], heads: [26, 34, 44], jaws: [1, 1, 1], wingN: [176, 140, 210, 18], wingF: [34, 58, -8, -20], footN: [-18, 0], footF: [22, 0] }],
      [24, { px: 14, py: 4, torso: 59, necks: [[60, 2, -10], [52, 0, -10], [44, -2, -8]], heads: [30, 38, 48], jaws: [0.4, 0.4, 0.4], wingN: [176, 140, 210, 18], footN: [-18, 0], footF: [22, 0] }],
      [34, { px: 2, torso: 80 }],
      [46, {}],
    ]),
  },
  // TAIL SLAM: mace tail goes up over the back, hangs, then crashes down
  tslam: {
    n: 13, step: 4,
    fn: keys(KN, [
      [0, {}],
      [8, { px: -5, py: -3, torso: 88, necks: [[116, 5, -14], [106, 5, -15], [96, 3, -14]], heads: [8, 0, -8], tails: [[140, -5], [152, -5]], wingN: [128, 92, 150, 28], footN: [-18, 0], footF: [16, 0] }],
      [15, { px: -7, py: -5, torso: 92, necks: [[120, 5, -12], [110, 5, -13], [100, 3, -12]], heads: [14, 6, -2], tails: [[122, -4], [134, -4]], wingN: [126, 90, 148, 28], footN: [-20, 0], footF: [14, 0] }],
      [21, { px: -7, py: -5, torso: 93, necks: [[120, 5, -12], [110, 5, -13], [100, 3, -12]], heads: [14, 6, -2], tails: [[118, -4], [130, -4]], wingN: [126, 90, 148, 28], footN: [-20, 0], footF: [14, 0] }],
      [25, { px: 9, py: -3, torso: 66, necks: [[88, 0, -18], [76, -2, -16], [64, -4, -12]], heads: [-20, -26, -28], jaws: [0.8, 0.8, 0.8], tails: [[26, 8], [42, 6]], wingN: [162, 118, 190, 21], footF: [22, 0] }],
      [32, { px: 10, py: -3, torso: 64, tails: [[18, 8], [34, 6]], wingN: [162, 118, 190, 21], footF: [22, 0] }],
      [48, {}],
    ]),
  },
  // QUAKE STOMP: crouch, wings flare, leap, crash
  quake: {
    n: 15, step: 4,
    fn: keys(KN, [
      [0, {}],
      [8, CROUCH],
      [14, { ...CROUCH, px: -7, py: -9 }],
      [21, { ...RISE, px: 0, py: 12, torso: 88, necks: [[106, 3, -12], [96, 3, -12], [86, 2, -12]], heads: [20, 14, 8], jaws: [1, 1, 1], wingN: [188, 152, 216, 15], wingF: [30, 50, -14, -17], footN: [-8, 14], footF: [22, 16] }],
      [28, { px: 7, py: -8, torso: 84, necks: [[104, 2, -14], [94, 2, -14], [84, 0, -14]], heads: [4, -2, -8], jaws: [1, 1, 1], wingN: [168, 128, 196, 20], wingF: [40, 64, -4, -19], footN: [-24, 0], footF: [26, 0], tails: [[190, -12], [206, -11]] }],
      [36, { px: 6, py: -10, torso: 86, wingN: [150, 108, 172, 24], footN: [-24, 0], footF: [26, 0] }],
      [48, { px: 2, torso: 82 }],
      [60, {}],
    ]),
  },
} as Partial<Record<AnimName, Anim<KPose>>>);

// ---- signature moves ------------------------------------------------------------------------------
// TRI-HEAD FRENZY: the far, middle and near head lunge one after the other (bites at orig frames 16 / 26 / 36)
const BITEN: number[][] = [[88, 0, -14], [72, -4, -12], [58, -6, -9]];
const bite = (i: number, jaw = 1): Partial<KPose> => ({
  px: 5 + i, py: -3, torso: 70,
  necks: KN.necks.map((n, j) => (j === i ? BITEN[i] : [n[0] + 10, n[1] + 1, n[2] + 4])),
  heads: KN.heads.map((h, j) => (j === i ? -26 : 14 + j * 4)),
  jaws: KN.jaws.map((_, j) => (j === i ? jaw : 0.5)),
  wingN: [150, 104, 170, 26], footN: [-18, 0], footF: [22, 0],
});
const REAR: Partial<KPose> = { px: -7, py: -4, torso: 88, necks: [[116, 5, -14], [108, 5, -15], [100, 3, -14]], heads: [20, 14, 8], jaws: [0.6, 0.6, 0.6], wingN: [128, 92, 156, 28], footN: [-18, 0], footF: [14, 0] };
// WING GALE: wings hauled up and back, then hurled forward-down twice (strokes at orig frames 24 / 36)
const GALE_UP: Partial<KPose> = { px: -6, py: -6, torso: 90, necks: [[116, 6, -12], [108, 6, -12], [100, 4, -12]], heads: [16, 10, 4], jaws: [0.4, 0.4, 0.4], wingN: [118, 78, 140, 30], footN: [-18, 0], footF: [14, 0] };
const GALE_DN: Partial<KPose> = { px: 5, py: -4, torso: 72, necks: [[100, 2, -18], [90, 2, -20], [80, 0, -20]], heads: [-14, -18, -22], jaws: [1, 1, 1], wingN: [52, 22, 32, -22], footN: [-18, 0], footF: [22, 0], tails: [[176, -4], [196, -4]] };
anims.sig1 = {
  n: 17, step: 4,
  fn: keys(KN, [
    [0, {}],
    [8, REAR],
    [14, { ...REAR, px: -8, torso: 90 }],
    [16, bite(2)],
    [20, bite(2, 0.15)],
    [24, { ...REAR, px: -2, torso: 82 }],
    [26, bite(1)],
    [30, bite(1, 0.15)],
    [34, { ...REAR, px: 0, torso: 80 }],
    [36, bite(0)],
    [40, { ...bite(0, 0.15), px: 7 }],
    [52, { px: 3, torso: 80 }],
    [68, {}],
  ]),
};
anims.sig2 = {
  n: 17, step: 4,
  fn: keys(KN, [
    [0, {}],
    [10, GALE_UP],
    [20, { ...GALE_UP, px: -8, wingN: [112, 70, 126, 32] }],
    [24, GALE_DN],
    [30, { ...GALE_UP, px: 0, wingN: [116, 76, 134, 30] }],
    [35, { ...GALE_UP, px: -4, wingN: [112, 72, 128, 32] }],
    [38, GALE_DN],
    [46, { ...GALE_DN, px: 4, wingN: [66, 40, 60, -12] }],
    [60, { px: 2, torso: 82 }],
    [74, {}],
  ]),
};

const timed = { ...anims } as Record<string, Anim<KPose>>;
for (const k in TM) if (timed[k]) timed[k] = retime(timed[k], TM[k]);
export const GHIDORAH: CharArt<KPose> = { name: "KING GHIDORAH", w: W, h: H, ox: OX, oy: OY, anims: timed as Record<AnimName, Anim<KPose>>, draw };
