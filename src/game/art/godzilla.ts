// GODZILLA — drawn entirely in code.
// A skeletal rig (spine chain tail->head, IK legs, FK arms, hinged jaw, maple-leaf
// dorsal plates) rasterised straight to pixels with a 7-tone charcoal ramp,
// craggy hide texture, cool top light and a warm "burning city" under-rim.
import { TM, retime, BV } from "../timing";
import { Raster, Shade, rgb, hash2, bayer, rad, spline, ik, skeys as keys, clampi, rigBox, discBox, emptyParts, setPart, PART_CLAW, PART_HEAD, PART_TAIL, PART_FEET, PART_BODY, type Anim, type AnimName, type Anchors, type CharArt } from "./raster";

export interface GPose {
  px: number; // pelvis offset
  py: number;
  rot: number; // whole body rotation about pelvis (knockdowns)
  torso: number; // abs angles, degrees
  neck: number;
  head: number;
  jaw: number; // 0..1
  armN: number[]; // [upper, fore] abs angles
  armF: number[];
  footN: number[]; // ankle [x, lift]
  footF: number[];
  tail: number[]; // 7 abs angles (elevation / droop of every link)
  tyaw: number[]; // 7 yaw offsets (deg): 0 = trailing straight behind, +90 = swung toward the camera, +180 = forward, <0 = swung away
}

const W = 336, H = 250, OX = 180, OY = 204;

const OUT = rgb(0x06080c);
const HIDE = [0x0d1117, 0x161c24, 0x202931, 0x2c373f, 0x3c494f, 0x526160, 0x70827b].map((h) => rgb(h));
const WARM = [0x55301f, 0x8f4a26, 0xd07a32].map((h) => rgb(h));
const BONE = [0x7a705e, 0xb3a98d, 0xe6dec2, 0xfbf7e8].map((h) => rgb(h));
const MOUTH = [0x2e0a12, 0x6a1820, 0xa63a3a].map((h) => rgb(h));
const PLATE = [0x1b222a, 0x333e48, 0x55636b, 0x84939a, 0xbdcaca, 0xeef6f2];

function hide(lv = 0): Shade {
  return (u, v, nx, ny, X, Y, r) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    let l = 0.3 + ny * 0.44 + nz * 0.2;
    const cu = Math.floor(u / 3.3), cv = Math.floor((v * r) / 2.7);
    const t = hash2(cu + 91, cv + 17);
    l += (t - 0.5) * 0.17;
    if (hash2(cu * 7 + cv, cv * 3 - cu) > 0.87) l -= 0.15; // fissures in the hide
    l += (bayer(X, Y) - 0.5) * 0.05;
    const k = clampi(Math.floor(l * 7) + lv, 0, 6);
    const w = -ny;
    if (w > 0.9) return WARM[w > 0.965 && t > 0.3 ? 2 : 1]; // fire-lit underside rim
    if (w > 0.76 && bayer(X, Y) < 0.55) return WARM[0];
    return HIDE[k];
  };
}

const LEAF = [-0.5, 0, -0.68, 0.28, -0.4, 0.36, -0.62, 0.62, -0.28, 0.64, -0.22, 0.9, 0, 1, 0.16, 0.8, 0.44, 0.8, 0.3, 0.5, 0.62, 0.4, 0.46, 0];

function plate(r: Raster, bx: number, by: number, dx: number, dy: number, nx: number, ny: number, w: number, h: number, f: number, far: boolean) {
  const pts: number[] = [];
  if (h < 6.5) pts.push(bx - (dx * w) / 2, by - (dy * w) / 2, bx + nx * h, by + ny * h, bx + (dx * w) / 2, by + (dy * w) / 2);
  else for (let i = 0; i < LEAF.length; i += 2) pts.push(bx + dx * LEAF[i] * w + nx * LEAF[i + 1] * h, by + dy * LEAF[i] * w + ny * LEAF[i + 1] * h);
  const sx = r.X(bx, by), sy = r.Y(bx, by);
  const nsx = r.X(bx + nx, by + ny) - sx, nsy = r.Y(bx + nx, by + ny) - sy;
  const tsx = r.X(bx + dx, by + dy) - sx, tsy = r.Y(bx + dx, by + dy) - sy;
  const al = 128 + Math.round(clampi(f, 0, 1) * 100); // alpha encodes position along spine -> GPU glow sweep
  r.poly(pts, (X, Y) => {
    const qx = X + 0.5 - sx, qy = Y + 0.5 - sy;
    const b = (qx * nsx + qy * nsy) / h, a = Math.abs(qx * tsx + qy * tsy) / w;
    let k = Math.floor(b * 2.6 + a * 4.2 + (hash2(X, Y) - 0.5) * 0.8) + (far ? -1 : 0);
    k = clampi(k, 0, far ? 3 : 5);
    return rgb(PLATE[k], al);
  });
  r.flush(OUT);
}

function plateH(f: number): number {
  const K = [0, 4, 0.3, 11, 0.55, 18, 0.7, 26, 0.84, 35, 0.92, 25, 0.98, 12, 1, 7];
  for (let i = 0; i + 2 < K.length; i += 2) if (f <= K[i + 2]) return K[i + 1] + ((K[i + 3] - K[i + 1]) * (f - K[i])) / (K[i + 2] - K[i]);
  return 6;
}

function plates(r: Raster, ch: number[], far: boolean) {
  const n = ch.length / 3;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(ch[i * 3] - ch[i * 3 - 3], ch[i * 3 + 1] - ch[i * 3 - 2]);
  const total = cum[n - 1];
  let s = far ? 24 : 12, seg = 1;
  while (s < total - 3) {
    const f = s / total;
    const h0 = plateH(f) * (far ? 0.7 : 1), w = h0 * 0.8 + 2;
    while (seg < n - 1 && cum[seg] < s) seg++;
    const i0 = (seg - 1) * 3, i1 = seg * 3;
    const t = (s - cum[seg - 1]) / Math.max(1e-6, cum[seg] - cum[seg - 1]);
    const x = ch[i0] + (ch[i1] - ch[i0]) * t, y = ch[i0 + 1] + (ch[i1 + 1] - ch[i0 + 1]) * t, rr = ch[i0 + 2] + (ch[i1 + 2] - ch[i0 + 2]) * t;
    let dx = ch[i1] - ch[i0], dy = ch[i1 + 1] - ch[i0 + 1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L;
    dy /= L;
    const lx = -dy - dx * 0.22, ly = dx - dy * 0.22, ll = Math.hypot(lx, ly); // back normal, leaning toward the tail
    plate(r, x - dy * (rr - 3.5), y + dx * (rr - 3.5), dx, dy, lx / ll, ly / ll, w, h0, f, far);
    s += w * (far ? 0.95 : 0.68);
  }
}

function claws(r: Raster, x: number, y: number, ang: number, len: number, spread: number, n: number, wd = 2) {
  for (let i = 0; i < n; i++) {
    const a = rad(ang + (i - (n - 1) / 2) * spread);
    const cx = Math.cos(a), cy = Math.sin(a);
    const bx = x + cx * 1.5, by = y + cy * 1.5;
    r.poly([bx - cy * wd, by + cx * wd, bx + cx * len, by + cy * len, bx + cy * wd, by - cx * wd], BONE[2]);
    r.dot(bx + cx * (len - 1.5), by + cy * (len - 1.5), BONE[3]);
    r.dot(bx + cy * wd * 0.6, by - cx * wd * 0.6, BONE[0]);
  }
}

function leg(r: Raster, hx: number, hy: number, ax: number, lift: number, sh: Shade, mul: number, weld = false) {
  const ay = 8 + lift;
  const [kx, ky] = ik(hx, hy, ax, ay, 31, 27, 1);
  r.limb([hx, hy, 17.5, kx, ky, 12.5], sh);
  r.limb([kx, ky, 11.5, ax, ay, 7.5], sh);
  const fa = rad(-10 - Math.max(0, lift) * 2.4);
  const tx = ax + Math.cos(fa) * 19, ty = ay + Math.sin(fa) * 19;
  r.limb([ax - 3, ay - 0.5, 7, ax, ay, 7.5, tx, ty - 0.5, 6.2], sh);
  claws(r, tx + 4, ty - 2.5, -6 - Math.max(0, lift) * 2.4, 10, 15, 3);
  // weld: the leg joins the body layer (thigh melts into the pelvis, no seam, no outline between them)
  if (!weld) r.flush(OUT, mul, true);
}

function arm(r: Raster, sx: number, sy: number, a: number[], sh: Shade, mul: number): number[] {
  const ex = sx + Math.cos(rad(a[0])) * 17, ey = sy + Math.sin(rad(a[0])) * 17;
  const hx = ex + Math.cos(rad(a[1])) * 16, hy = ey + Math.sin(rad(a[1])) * 16;
  r.limb([sx, sy, 7, ex, ey, 5.6], sh);
  r.limb([ex, ey, 5.4, hx, hy, 4.4], sh);
  r.limb([hx, hy, 4.6], sh);
  claws(r, hx + Math.cos(rad(a[1])) * 2, hy + Math.sin(rad(a[1])) * 2, a[1] - 6, 9, 30, 3, 1.25);
  r.exempt(sx, sy, 6.5); // the shoulder grows out of the chest: no contact shadow at the root
  r.flush(OUT, mul, true);
  return [hx, hy];
}

function draw(r: Raster, p: GPose): Anchors {
  const pvx = p.px, pvy = 62 + p.py;
  r.setT(OX, OY, p.rot, pvx, pvy);
  r.clipY = p.rot !== 0 && p.py >= 0 ? H - 1 : OY - 1; // airborne tumbles are not clipped by the ground
  const tr = rad(p.torso), nr = rad(p.neck);
  const tx = Math.cos(tr), ty = Math.sin(tr); // torso axis
  const fx = ty, fy = -tx; // "front" of torso
  const bel = [pvx + tx * 22 + fx * 3, pvy + ty * 22 + fy * 3];
  const che = [pvx + tx * 48, pvy + ty * 48];
  const nm = [che[0] + Math.cos(nr) * 12, che[1] + Math.sin(nr) * 12];
  const hb = [che[0] + Math.cos(nr) * 24, che[1] + Math.sin(nr) * 24];

  // spine chain: tail tip -> pelvis -> chest -> neck -> head base
  // The tail is a 3D chain projected to the side view: each link has an elevation (p.tail) and a yaw (p.tyaw).
  // A link that yaws toward the camera shortens on screen, drops down the screen and grows a little (perspective),
  // which is what lets the tail wrap AROUND the body instead of poking through it.
  const TR = [20.5, 17.5, 14.5, 11.5, 9, 6.5, 4.5, 2.2];
  const tl: number[] = [];
  const tz: number[] = [0];
  let x = pvx - 8, y = pvy - 5, z = 0;
  tl.push(x, y, TR[0]);
  for (let i = 0; i < 7; i++) {
    const a = rad(p.tail[i]), yw = rad(p.tyaw[i]);
    const m = -Math.cos(a) * 22, dz = m * Math.sin(yw);
    x += -m * Math.cos(yw);
    y += Math.sin(a) * 22 - dz * 0.34;
    z += dz;
    tz.push(z);
    tl.push(x, y, TR[i + 1] * (1 + clampi(z, -40, 40) * 0.0045));
  }
  // first link (>= 2) that has swung in front of the body: from there the tail is drawn over the legs
  let jf = -1;
  for (let i = 2; i < 8; i++) if (tz[i] > 7) { jf = i; break; }
  const top = jf < 0 ? 7 : jf;
  const cp: number[] = [];
  for (let i = top; i >= 0; i--) cp.push(tl[i * 3], tl[i * 3 + 1], tl[i * 3 + 2]);
  cp.push(pvx, pvy, 23, bel[0], bel[1], 24.5, che[0], che[1], 19.5, nm[0], nm[1], 14.5, hb[0], hb[1], 11.5);
  const chain = spline(cp, 5);

  const sh = hide(0);
  const shx = che[0] + fx * 11 - tx * 8, shy = che[1] + fy * 11 - ty * 8; // shoulder

  // ---- far side limbs (darker)
  arm(r, shx + 3, shy + 2, p.armF, sh, 0.62);
  leg(r, pvx - 2, pvy - 5, p.footF[0], p.footF[1], sh, 0.62);

  // ---- dorsal plates (far row, then main row)
  plates(r, chain, true);
  plates(r, chain, false);

  // ---- body + head + near leg (single layer => seamless silhouette, the thigh grows out of the pelvis)
  leg(r, pvx + 3, pvy - 7, p.footN[0], p.footN[1], sh, 1, true);
  r.limb(chain, sh);
  const ha = rad(p.head), hx = Math.cos(ha), hy = Math.sin(ha);
  const Hx = (lx: number, ly: number) => hb[0] + lx * hx - ly * hy;
  const Hy = (lx: number, ly: number) => hb[1] + lx * hy + ly * hx;
  // lower jaw (hinged)
  const ja = rad(p.head - 5 - p.jaw * 32), jx = Math.cos(ja), jy = Math.sin(ja);
  const J0x = Hx(5, -6), J0y = Hy(5, -6);
  r.limb([J0x, J0y, 5.6, J0x + jx * 9, J0y + jy * 9, 4.6, J0x + jx * 19, J0y + jy * 19, 3.2], sh);
  if (p.jaw > 0.12) {
    r.poly([Hx(6, -1), Hy(6, -1), Hx(26, -2.5), Hy(26, -2.5), J0x + jx * 19 - jy * 3, J0y + jy * 19 + jx * 3, J0x - jy * 5, J0y + jx * 5], (X, Y) => MOUTH[hash2(X >> 1, Y >> 1) > 0.62 ? 1 : 0]);
  }
  // cranium + snout, cut flat along the lip line
  const hbX = r.X(hb[0], hb[1]), hbY = r.Y(hb[0], hb[1]);
  const uX = r.X(hb[0] + hx, hb[1] + hy) - hbX, uY = r.Y(hb[0] + hx, hb[1] + hy) - hbY; // head +x in screen space
  const cut: Shade = (u, v, nx, ny, X, Y, rr) => {
    const qx = X + 0.5 - hbX, qy = Y + 0.5 - hbY;
    const lx = qx * uX + qy * uY, ly = qx * uY - qy * uX;
    if (lx > 6 && ly < -3) return 0;
    return sh(u, v, nx, ny, X, Y, rr);
  };
  r.limb([Hx(0, 0), Hy(0, 0), 11.5, Hx(7, 3.4), Hy(7, 3.4), 10.2], cut);
  r.limb([Hx(7, 3.4), Hy(7, 3.4), 9.8, Hx(15, 2.4), Hy(15, 2.4), 7.6, Hx(21.5, 1.6), Hy(21.5, 1.6), 6], cut);
  // teeth
  for (let lx = 11; lx < 26.5; lx += 2.5) r.dot(Hx(lx, -3.7), Hy(lx, -3.7), BONE[lx > 20 ? 3 : 2]);
  if (p.jaw > 0.3) for (let s = 8; s < 19; s += 2.6) r.dot(J0x + jx * s - jy * (5 - s * 0.1), J0y + jy * s + jx * (5 - s * 0.1), BONE[2]);
  // brow, eye, nostril
  r.line(Hx(8.5, 9.6), Hy(8.5, 9.6), Hx(15.5, 8), Hy(15.5, 8), HIDE[5]); // lit brow ridge
  r.line(Hx(9, 8.3), Hy(9, 8.3), Hx(16.5, 6.2), Hy(16.5, 6.2), HIDE[0]); // scowl
  r.line(Hx(11, 3.6), Hy(11, 3.6), Hx(15, 3.4), Hy(15, 3.4), HIDE[1]); // socket shadow
  r.dot(Hx(12, 5), Hy(12, 5), HIDE[0]);
  r.dot(Hx(23.5, 5.6), Hy(23.5, 5.6), HIDE[5]); // nose bump highlight
  r.dot(Hx(13.2, 5), Hy(13.2, 5), rgb(0xff9a1e, 250));
  r.dot(Hx(14.3, 5), Hy(14.3, 5), rgb(0xffe27a, 250));
  r.dot(Hx(25, 3.6), Hy(25, 3.6), HIDE[0]);
  r.flush(OUT, 1, true);

  // ---- near arm (soft contact shadow on the chest) and the tail when it sweeps across the front of the body
  const hand = arm(r, shx, shy, p.armN, sh, 1);
  if (jf >= 0) {
    const fch: number[] = [];
    for (let i = 7; i >= jf - 1; i--) fch.push(tl[i * 3], tl[i * 3 + 1], tl[i * 3 + 2]);
    const fc = spline(fch, 5);
    plates(r, fc, false);
    r.limb(fc, sh);
    r.exempt(tl[(jf - 1) * 3], tl[(jf - 1) * 3 + 1], tl[(jf - 1) * 3 + 2] + 3);
    r.exempt(tl[jf * 3], tl[jf * 3 + 1], tl[jf * 3 + 2] + 3);
    r.flush(OUT, 1, true);
  }

  // beam / breath leaves the centre of the open muzzle, along the head axis
  const mx = Hx(24, -3.5 - p.jaw * 4.5), my = Hy(24, -3.5 - p.jaw * 4.5);
  const mdx = r.X(mx + hx, my + hy) - r.X(mx, my), mdy = r.Y(mx, my) - r.Y(mx + hx, my + hy);
  // exact strike volumes, measured from the very same joints the sprite is drawn from
  const parts = emptyParts();
  setPart(parts, PART_CLAW, discBox(r, hand[0] + Math.cos(rad(p.armN[1])) * 7, hand[1] + Math.sin(rad(p.armN[1])) * 7, 11, OX, OY));
  setPart(parts, PART_HEAD, rigBox(r, [Hx(-1, 12), Hy(-1, 12), Hx(28, -9 - p.jaw * 4), Hy(28, -9 - p.jaw * 4), Hx(6, -12), Hy(6, -12)], OX, OY));
  const tip = [(tl[7 * 3] + tl[6 * 3]) / 2, (tl[7 * 3 + 1] + tl[6 * 3 + 1]) / 2];
  const tp: number[] = [];
  for (let i = 0; i < 8; i++) tp.push(tl[i * 3] - 10, tl[i * 3 + 1] - 10, tl[i * 3] + 10, tl[i * 3 + 1] + 10);
  tp.push(tip[0] - 9, tip[1] - 9, tip[0] + 9, tip[1] + 9);
  setPart(parts, PART_TAIL, rigBox(r, tp, OX, OY));
  setPart(parts, PART_FEET, rigBox(r, [p.footN[0] - 20, 2 + p.footN[1], p.footN[0] + 24, 2 + p.footN[1], pvx + 3, pvy - 34, pvx + 40, pvy - 34], OX, OY));
  setPart(parts, PART_BODY, rigBox(r, [pvx - 26, pvy - 30, che[0] - 22, che[1] - 28, hb[0] + 26, hb[1] + 26, pvx + 34, pvy + 30], OX, OY));
  return { mouths: [r.X(mx, my), r.Y(mx, my)], dirs: [Math.atan2(mdy, mdx)], hand: [r.X(hand[0], hand[1]), r.Y(hand[0], hand[1])], parts };
}

// ------------------------------------------------------------------ animation
const TAIL0 = [215, 225, 212, 195, 182, 170, 155];
const N: GPose = { px: 0, py: 0, rot: 0, torso: 74, neck: 58, head: -6, jaw: 0.08, armN: [-55, 15], armF: [-38, 34], footN: [-12, 0], footF: [15, 0], tail: TAIL0, tyaw: [0, 0, 0, 0, 0, 0, 0] };
const S = Math.sin, C = Math.cos, PI2 = Math.PI * 2;
const sw = (f: number, i: number, v: number, k: number) => v + S(f - i * k) * (1.6 + i * 1.3);

const idle = (t: number): GPose => {
  const f = (PI2 * t) / 84;
  return { ...N, py: -1 + C(f), torso: 74 + S(f) * 2, neck: 58 + S(f - 0.6) * 2.5, head: -6 + S(f - 1) * 3, jaw: S(f) > 0.6 ? 0.22 : 0.08, armN: [-55 + 5 * S(f), 15 + 7 * S(f - 0.5)], armF: [-38 + 5 * S(f + 1), 34 + 6 * S(f)], tail: TAIL0.map((a, i) => sw(f, i, a, 0.55)) };
};
const stepFoot = (ph: number): number[] => {
  ph -= Math.floor(ph);
  if (ph < 0.6) return [16 - 32 * (ph / 0.6), 0];
  const s = (ph - 0.6) / 0.4;
  return [-16 + 32 * s, S(Math.PI * s) * 11];
};
const walk = (t: number): GPose => {
  const ph = t / 64, f = PI2 * ph;
  const a = stepFoot(ph), b = stepFoot(ph + 0.5);
  return { ...N, py: -2.5 + 2.5 * Math.abs(S(f)), px: S(f * 2) * 1, torso: 71 + 3.5 * S(f), neck: 56 - 3 * S(f), head: -6 + 2.5 * S(f * 2), armN: [-55 + 12 * S(f), 15 + 9 * S(f)], armF: [-38 - 12 * S(f), 34 - 9 * S(f)], footN: [a[0] - 3, a[1]], footF: [b[0] + 5, b[1]], tail: TAIL0.map((v, i) => v + S(f - i * 0.6) * (3 + i * 1.4)) };
};
const FIRE: Partial<GPose> = { px: 4, py: -2, torso: 64, neck: 46, head: -12, jaw: 1, armN: [-30, 40], armF: [-20, 50], footN: [-17, 0], footF: [19, 0], tail: [205, 212, 200, 188, 178, 170, 160] };
const GRAB: Partial<GPose> = { px: 8, py: -2, torso: 60, neck: 46, head: -8, jaw: 0.7, armN: [5, -5], armF: [16, 6], footN: [-14, 0], footF: [23, 0] };
const CROUCH: Partial<GPose> = { px: -6, py: -7, torso: 88, neck: 74, head: 8, jaw: 0.15, armN: [-92, -30], armF: [-80, -18], footN: [-20, 0], footF: [18, 0] };
const RISE: Partial<GPose> = { px: 2, py: -16, torso: 58, neck: 44, head: -22, jaw: 0.9, armN: [70, 108], armF: [82, 118], footN: [-6, 14], footF: [26, 17], tail: [228, 226, 210, 192, 176, 163, 150] };
const DOWN: Partial<GPose> = { rot: 97, py: -41, torso: 80, neck: 76, head: 62, jaw: 0.5, armN: [10, 50], armF: [25, 60], footN: [5, -32], footF: [16, -27], tail: [263, 263, 268, 278, 293, 313, 333] };
const SWEEP_BACK = [148, 168, 186, 200, 210, 216, 220];
const SWEEP_FWD = [28, 8, -6, -18, -28, -38, -48];


// ---- K / HEAVY: TAIL WHIP --------------------------------------------------------------------------
// Authored in original frames; the strike (tail meets the target) is at t = 28.
//  0-9   weight transfer: hips settle back, the tail starts to peel away from the ground
//  9-17  coil: torso dips forward over the front foot while the tail swings out AWAY from the camera and rises
//        (it shortens and slips behind the body - the long readable tell)
//  17-30 release: the root barely moves, the outer links whip around the camera side of the body, each link
//        lagging the one before it (wave travels root -> tip), accelerating into the hit
//  30-44 follow-through: the tip overshoots in front, the body rocks onto the front foot
//  44-58 momentum carries the tail on around the far side and it drags back down to rest
type Key = [number, number, number]; // [t, value, ease 0 smooth / 1 ease-in / 2 ease-out]
const curve = (ks: Key[]) => (t: number): number => {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 0; i + 1 < ks.length; i++) {
    if (t < ks[i + 1][0]) {
      const u = (t - ks[i][0]) / (ks[i + 1][0] - ks[i][0]), m = ks[i + 1][2];
      const f = m === 1 ? Math.pow(u, 1.8) : m === 2 ? 1 - Math.pow(1 - u, 2.2) : u * u * (3 - 2 * u);
      return ks[i][1] + (ks[i + 1][1] - ks[i][1]) * f;
    }
  }
  return ks[ks.length - 1][1];
};
const WHIP_PH = curve([[0, 0, 0], [9, -16, 0], [17, -92, 0], [18.5, -96, 0], [23, 128, 1], [30, 216, 2], [44, 236, 0], [58, 360, 0]]);
const WHIP_LIFT = curve([[0, 0, 0], [8, 0.15, 0], [17, 1, 0], [32, 1, 0], [46, 0.35, 0], [58, 0, 0]]);
const WHIP_BLEND = curve([[0, 0, 0], [17, 0, 0], [25, 1, 0], [58, 1, 0]]); // coil elevation -> level sweep
const WHIP_REC = curve([[0, 0, 0], [44, 0, 0], [58, 1, 0]]); // un-weight the yaw so 360 deg lands exactly on rest
const WHIP_W = [0.16, 0.28, 0.42, 0.6, 0.78, 0.94, 1.05];
const COIL_E = [200, 190, 178, 168, 160, 156, 154];
const WHIP_E = [192, 186, 182, 179, 177, 176, 176];
const WHIP_LAG = 1.25;
const whipBody = keys(N, [
  [0, {}],
  [9, { px: -3, py: -3, torso: 79, neck: 63, head: 4, jaw: 0.12, armN: [-68, -8], armF: [-50, 20], footN: [-15, 0], footF: [16, 0] }],
  [17, { px: -8, py: -9, torso: 64, neck: 50, head: -14, jaw: 0.25, armN: [-96, -36], armF: [-74, -12], footN: [-21, 0], footF: [20, 0] }],
  [21, { px: -9, py: -9, torso: 63, neck: 49, head: -16, jaw: 0.3, armN: [-98, -38], armF: [-76, -14], footN: [-21, 0], footF: [20, 0] }],
  [29, { px: 4, py: -5, torso: 63, neck: 49, head: -13, jaw: 0.8, armN: [-22, 40], armF: [-30, 30], footN: [-18, 0], footF: [19, 0] }],
  [36, { px: 9, py: -5, torso: 61, neck: 48, head: -14, jaw: 0.75, armN: [-8, 34], armF: [-22, 26], footN: [-18, 0], footF: [19, 0] }],
  [46, { px: 6, py: -3, torso: 66, neck: 52, head: -8, jaw: 0.4, armN: [-30, 18], armF: [-34, 22], footN: [-14, 0], footF: [17, 0] }],
  [58, {}],
]);
function tailWhip(t: number): GPose {
  const b = whipBody(t);
  const tyaw: number[] = [], tail: number[] = [];
  for (let i = 0; i < 7; i++) {
    const tt = t - i * WHIP_LAG;
    const rec = WHIP_REC(tt), w = WHIP_W[i] + (1 - WHIP_W[i]) * rec;
    tyaw.push(WHIP_PH(tt) * w);
    const lift = WHIP_LIFT(tt), bl = WHIP_BLEND(tt), tg = COIL_E[i] + (WHIP_E[i] - COIL_E[i]) * bl;
    tail.push(TAIL0[i] + (tg - TAIL0[i]) * lift);
  }
  return { ...b, tail, tyaw };
}

const anims: Partial<Record<AnimName, Anim<GPose>>> = {
  idle: { n: 7, step: 12, fn: idle },
  walk: { n: 8, step: 8, fn: walk },
  dash: { n: 3, step: 9, fn: (t) => ({ ...N, px: 7, py: -4, torso: 56, neck: 42, head: -4, jaw: 0.4, armN: [-20, 40], armF: [-10, 50], footN: t < 9 ? [-24, 2] : t < 18 ? [22, 6] : [-12, 1], footF: t < 9 ? [26, 7] : t < 18 ? [-20, 1] : [18, 5], tail: [196, 192, 186, 181, 176, 172, 168] }) },
  bdash: { n: 3, step: 9, fn: (t) => ({ ...N, px: -6, py: -2, torso: 86, neck: 66, head: -14, armN: [-10, 30], armF: [0, 40], footN: t < 9 ? [14, 5] : [-16, 0], footF: t < 9 ? [-12, 0] : [18, 6], tail: [228, 236, 216, 196, 180, 170, 160] }) },
  block: { n: 2, step: 7, fn: (t) => ({ ...N, px: t < 7 ? -7 : -4, py: -4, torso: t < 7 ? 86 : 81, neck: 71, head: -31, jaw: 0, armN: [38, 96], armF: [48, 102], footN: [-16, 0], footF: [10, 0] }) },
  light: {
    n: 13, step: 3,
    fn: keys(N, [
      [0, {}],
      [7, { px: -6, py: -3, torso: 84, neck: 66, head: 8, jaw: 0.25, armN: [72, 120], armF: [-50, 20], tail: [222, 230, 214, 196, 182, 170, 157] }],
      [12, { px: -7, py: -4, torso: 86, neck: 68, head: 10, jaw: 0.3, armN: [78, 126], armF: [-45, 24] }],
      [17, { px: 9, py: -3, torso: 58, neck: 44, head: -17, jaw: 0.85, armN: [-10, -6], armF: [-62, -4], footF: [23, 0], tail: [200, 204, 198, 188, 178, 168, 158] }],
      [23, { px: 10, py: -3, torso: 56, neck: 43, head: -19, jaw: 0.7, armN: [-38, -48], armF: [-62, -4], footF: [23, 0] }],
      [30, { px: -2, py: -1, torso: 78, neck: 60, head: -2, jaw: 0.3, armN: [-58, 10], armF: [-40, 28] }],
      [39, {}],
    ]),
  },
  heavy: { n: 17, step: 4, fn: tailWhip },
  beamA: { n: 5, step: 8, fn: keys(N, [[0, {}], [10, { px: -5, torso: 86, neck: 76, head: 26, jaw: 0.3, armN: [-100, -50], armF: [-90, -40] }], [22, { px: -6, torso: 84, neck: 74, head: 30, jaw: 0.45, armN: [-104, -54], armF: [-94, -44] }], [34, { px: -3, torso: 81, neck: 71, head: 16, jaw: 0.7, armN: [-92, -42], armF: [-82, -32] }], [40, { px: -2, torso: 80, neck: 70, head: 14, jaw: 0.6 }]]) },
  // 3 pitch variants x BV frames: [low (burns the skyline), mid, high]; the sim picks the variant, the head really tilts
  beamB: { n: BV * 3, step: 11, fn: (t) => {
    const i = Math.round(t / 11), v = Math.floor(i / BV), tt = (i % BV) * 11, off = [-17, 0, 14][v];
    return { ...N, ...FIRE, px: 4 + (tt % 22 === 0 ? 1 : 0), torso: 64 + [-5, 0, 4][v], neck: 46 + [-5, 0, 5][v], head: (tt < 11 ? -13 : -10) + off, jaw: tt < 22 ? 0.95 : 1 };
  } },
  beamC: { n: 3, step: 10, fn: keys(N, [[0, { ...FIRE, jaw: 0.6, head: -10 }], [12, { ...FIRE, jaw: 0.2, head: -14 }], [28, {}]]) },
  grab: { n: 9, step: 7, fn: keys(N, [[0, {}], [8, { ...GRAB, px: 4, armN: [30, 50] }], [16, GRAB], [40, GRAB], [52, { px: 6, torso: 66, neck: 52, head: 2, armN: [16, 20], armF: [24, 26] }], [58, {}]]) },
  throw: {
    n: 12, step: 6,
    fn: keys(N, [
      [0, GRAB],
      [13, { px: 1, torso: 85, neck: 72, head: 12, jaw: 0.3, armN: [72, 86], armF: [82, 96] }],
      [24, { px: 0, torso: 87, neck: 74, head: 14, jaw: 0.3, armN: [78, 92], armF: [88, 102] }],
      [31, { px: 9, py: -3, torso: 57, neck: 45, head: -15, jaw: 0.9, armN: [-25, -35], armF: [-15, -25], footF: [22, 0] }],
      [40, { px: 9, py: -3, torso: 57, neck: 45, head: -15, jaw: 0.8, armN: [-35, -45], armF: [-25, -35], footF: [22, 0] }],
      [52, { px: 2, torso: 78, jaw: 0.3 }],
      [66, {}],
    ]),
  },
  stomp: {
    n: 13, step: 4,
    fn: keys(N, [
      [0, {}],
      [8, CROUCH],
      [14, CROUCH],
      [24, RISE],
      [30, { px: 4, py: 8, torso: 92, neck: 80, head: 16, jaw: 0.9, armN: [-30, 20], armF: [-20, 30], footN: [-24, 0], footF: [24, 0], tail: [214, 226, 214, 198, 184, 172, 160] }],
      [38, { px: 2, py: 4, torso: 90, neck: 78, head: 12, jaw: 0.6, footN: [-22, 0], footF: [22, 0] }],
      [52, {}],
    ]),
  },
  sweep: {
    n: 14, step: 4,
    fn: keys(N, [
      [0, {}],
      [9, { px: -6, py: -4, torso: 92, neck: 78, head: 14, armN: [50, 90], armF: [60, 100], tail: SWEEP_BACK, footN: [-18, 0], footF: [16, 0] }],
      [15, { px: -7, py: -5, torso: 94, neck: 80, head: 16, armN: [58, 98], armF: [68, 108], tail: SWEEP_BACK.map((v) => v + 10) }],
      [25, { px: 9, py: -3, torso: 62, neck: 48, head: -12, jaw: 0.8, armN: [-20, 20], armF: [-10, 26], tail: SWEEP_FWD, footF: [22, 0] }],
      [32, { px: 10, py: -3, torso: 60, neck: 46, head: -14, jaw: 0.6, armN: [-26, 16], armF: [-16, 22], tail: SWEEP_FWD.map((v) => v - 16), footF: [22, 0] }],
      [48, {}],
    ]),
  },
  charge: {
    n: 13, step: 4,
    fn: keys(N, [
      [0, {}],
      [9, { px: -9, py: -6, torso: 90, neck: 76, head: 18, jaw: 0.35, armN: [-96, -40], armF: [-86, -30], footN: [-22, 0], footF: [12, 0], tail: [226, 232, 216, 198, 182, 168, 154] }],
      [16, { px: 2, py: -3, torso: 62, neck: 48, head: -16, jaw: 0.9, armN: [-18, 20], armF: [-8, 28], footN: [-8, 0], footF: [22, 0], tail: [200, 202, 196, 188, 180, 172, 164] }],
      [24, { px: 8, py: -4, torso: 54, neck: 42, head: -22, jaw: 0.9, armN: [-10, 30], armF: [0, 36], footN: [-4, 0], footF: [24, 0], tail: [196, 198, 194, 188, 182, 176, 170] }],
      [34, { px: 8, py: -4, torso: 54, neck: 42, head: -21, jaw: 0.7 }],
      [48, {}],
    ]),
  },
  hit: { n: 2, step: 8, fn: (t) => (t < 8 ? { ...N, px: -6, torso: 89, neck: 80, head: 36, jaw: 0.7, armN: [-112, -70], armF: [-100, -60], footN: [-15, 0], footF: [8, 0], tail: [222, 232, 214, 194, 178, 166, 150] } : { ...N, px: -3, torso: 82, neck: 68, head: 14, jaw: 0.35, armN: [-80, -30], armF: [-70, -20] }) },
  launch: { n: 2, step: 12, fn: (t) => ({ ...N, rot: t < 12 ? 30 : 64, torso: 84, neck: 76, head: 34, jaw: 0.8, armN: [20, 62], armF: [32, 72], footN: [6, 12], footF: [24, 18], tail: [205, 198, 190, 184, 178, 172, 166] }) },
  down: { n: 1, step: 10, fn: () => ({ ...N, ...DOWN }) },
  getup: { n: 4, step: 8, fn: keys(N, [[0, DOWN], [10, { rot: 42, py: -20, torso: 70, neck: 56, head: 0, jaw: 0.3, footN: [2, -8], footF: [20, -6], armN: [-70, -20], armF: [-60, -10], tail: [240, 240, 225, 205, 190, 178, 165] }], [20, { rot: 6, py: -6, torso: 78, neck: 62, head: -4, armN: [-62, 0], armF: [-50, 10], tail: [224, 226, 214, 198, 184, 172, 160] }], [32, {}]]) },
  win: {
    n: 8, step: 8,
    fn: (t) => {
      const k = keys(N, [[0, {}], [10, { torso: 80, neck: 74, head: 30, jaw: 0.4, armN: [-20, 50], armF: [-10, 60] }], [22, { px: -2, torso: 85, neck: 82, head: 48, jaw: 1, armN: [12, 72], armF: [22, 82], tail: [210, 215, 200, 180, 162, 146, 130] }]])(t);
      return t > 22 ? { ...k, head: k.head + S(t * 0.8) * 3, px: -2 + S(t * 1.3), jaw: 0.75 + S(t * 1.7) * 0.2 } : k;
    },
  },
};

// ---- 2.5D brawler moves: light chain, rip -> carry -> hurl / club smash, roar
// CARRY: the tower is held overhead in both hands (the near hand is the anchor the renderer pins it to)
const CARRY: Partial<GPose> = { px: -3, py: -2, torso: 86, neck: 72, head: 12, jaw: 0.4, armN: [78, 92], armF: [88, 102], footN: [-14, 0], footF: [18, 0] };
const carryWalk = (t: number): GPose => {
  const ph = t / 48, f = PI2 * ph;
  const a = stepFoot(ph), b = stepFoot(ph + 0.5);
  return { ...N, ...CARRY, py: -3 + 2 * Math.abs(S(f)), torso: 86 + 1.5 * S(f), neck: 72 - 2 * S(f), armN: [78 + 3 * S(f), 92 + 3 * S(f)], armF: [88 + 3 * S(f), 102 + 3 * S(f)], footN: [a[0] * 0.75 - 3, a[1] * 0.8], footF: [b[0] * 0.75 + 5, b[1] * 0.8], tail: TAIL0.map((v, i) => v + S(f - i * 0.6) * (2 + i)) };
};
Object.assign(anims, {
  // rising uppercut claw (chains from LIGHT)
  light2: {
    n: 11, step: 3,
    fn: keys(N, [
      [0, { px: 7, py: -3, torso: 60, neck: 46, head: -14, jaw: 0.5, armN: [-60, -90], armF: [-55, -6], footF: [23, 0] }],
      [6, { px: 4, py: -6, torso: 68, neck: 52, head: -8, jaw: 0.3, armN: [-96, -122], armF: [-40, 16] }],
      [11, { px: 14, py: -1, torso: 60, neck: 46, head: -2, jaw: 0.9, armN: [-5, 30], armF: [-50, -10], footF: [25, 0], tail: [200, 204, 198, 188, 178, 168, 158] }],
      [17, { px: 14, py: 0, torso: 62, neck: 48, head: 4, jaw: 0.7, armN: [22, 64], armF: [-50, -10], footF: [25, 0] }],
      [24, { px: 3, torso: 76, armN: [-30, 30], armF: [-40, 28] }],
      [30, {}],
    ]),
  },
  // lunging bite (chains from LIGHT2, launches)
  light3: {
    n: 13, step: 3,
    fn: keys(N, [
      [0, { px: 8, torso: 66, neck: 52, head: 4, jaw: 0.5, armN: [40, 84], armF: [-45, 0] }],
      [7, { px: -6, py: -5, torso: 88, neck: 78, head: 26, jaw: 0.6, armN: [-30, 30], armF: [-20, 40], tail: [222, 230, 214, 196, 182, 170, 157] }],
      [13, { px: 4, py: -4, torso: 70, neck: 56, head: 0, jaw: 1 }],
      [17, { px: 15, py: -3, torso: 50, neck: 35, head: -20, jaw: 0.12, armN: [-60, -20], armF: [-50, -10], footN: [-20, 0], footF: [27, 0], tail: [200, 204, 198, 188, 178, 168, 158] }],
      [25, { px: 14, py: -3, torso: 52, neck: 37, head: -18, jaw: 0.3, armN: [-60, -20], armF: [-50, -10], footN: [-20, 0], footF: [27, 0] }],
      [36, {}],
    ]),
  },
  // deep crouch -> both hands clamp the tower's near wall at RIP_GRIP (t=18) -> heave -> hoist overhead
  rip: {
    n: 12, step: 4,
    fn: keys(N, [
      [0, {}],
      [8, { px: 2, py: -10, torso: 52, neck: 42, head: -30, jaw: 0.3, armN: [-40, -30], armF: [-30, -20], footN: [-18, 0], footF: [22, 0], tail: [200, 206, 198, 188, 178, 168, 158] }],
      [18, { px: 4, py: -22, torso: 30, neck: 38, head: -46, jaw: 0.6, armN: [-70, -55], armF: [-62, -48], footN: [-22, 0], footF: [24, 0], tail: [190, 196, 192, 186, 180, 174, 168] }],
      [26, { px: 0, py: -16, torso: 58, neck: 48, head: -10, jaw: 1, armN: [-30, 10], armF: [-22, 18], footN: [-22, 0], footF: [24, 0], tail: [212, 220, 208, 194, 182, 170, 158] }],
      [34, { px: -2, py: -8, torso: 80, neck: 66, head: 6, jaw: 0.8, armN: [40, 70], armF: [50, 80], footN: [-18, 0], footF: [20, 0] }],
      [42, CARRY],
      [44, CARRY],
    ]),
  },
  carry: { n: 6, step: 8, fn: carryWalk },
  hurl: {
    n: 9, step: 4,
    fn: keys(N, [
      [0, CARRY],
      [7, { px: -6, py: -4, torso: 94, neck: 80, head: 20, jaw: 0.5, armN: [100, 125], armF: [108, 132], footN: [-12, 0], footF: [16, 0] }],
      [14, { px: 10, py: -3, torso: 58, neck: 45, head: -14, jaw: 1, armN: [-10, -20], armF: [0, -10], footN: [-18, 0], footF: [24, 0], tail: [200, 204, 198, 188, 178, 168, 158] }],
      [20, { px: 9, py: -3, torso: 56, neck: 44, head: -16, jaw: 0.8, armN: [-35, -45], armF: [-25, -35], footN: [-18, 0], footF: [24, 0] }],
      [32, {}],
    ]),
  },
  // overhead club smash with the tower: it shatters on the street at BS_HIT (t=18)
  bslam: {
    n: 12, step: 4,
    fn: keys(N, [
      [0, CARRY],
      [9, { px: -7, py: -2, torso: 96, neck: 84, head: 26, jaw: 0.6, armN: [104, 130], armF: [112, 136], footN: [-12, 0], footF: [16, 0] }],
      [16, { px: 8, py: -10, torso: 50, neck: 38, head: -24, jaw: 1, armN: [-20, -50], armF: [-10, -40], footN: [-22, 0], footF: [26, 0] }],
      [20, { px: 10, py: -12, torso: 46, neck: 34, head: -26, jaw: 0.9, armN: [-45, -70], armF: [-35, -60], footN: [-22, 0], footF: [26, 0] }],
      [30, { px: 8, py: -8, torso: 52, neck: 40, head: -18, jaw: 0.5, armN: [-50, -60], armF: [-40, -50], footN: [-22, 0], footF: [26, 0] }],
      [44, {}],
    ]),
  },
  roar: {
    n: 9, step: 8,
    fn: (t: number) => {
      const k = keys(N, [
        [0, {}],
        [10, { px: -4, py: -3, torso: 84, neck: 76, head: 30, jaw: 0.5, armN: [-30, 10], armF: [-20, 20] }],
        [20, { px: -5, py: -4, torso: 88, neck: 84, head: 50, jaw: 1, armN: [5, 40], armF: [15, 50], tail: [210, 215, 200, 180, 162, 146, 130] }],
        [54, { px: -5, py: -4, torso: 88, neck: 84, head: 48, jaw: 1, armN: [5, 40], armF: [15, 50], tail: [210, 215, 200, 180, 162, 146, 130] }],
        [64, {}],
      ])(t);
      return t > 20 && t < 54 ? { ...k, head: k.head + S(t * 0.9) * 3, jaw: 0.85 + S(t * 1.9) * 0.15 } : k;
    },
  },
  // RISING JAW (UP+LIGHT): coil low, then the whole neck whips up and the jaws snap shut under the foe
  upper: {
    n: 13, step: 4,
    fn: keys(N, [
      [0, {}],
      [7, { px: -6, py: -9, torso: 94, neck: 70, head: -10, jaw: 0.2, armN: [-95, -40], armF: [-80, -25], footN: [-20, 0], footF: [16, 0], tail: [222, 230, 214, 196, 182, 170, 157] }],
      [13, { px: -8, py: -12, torso: 96, neck: 72, head: -14, jaw: 0.1, armN: [-100, -50], armF: [-85, -30], footN: [-22, 0], footF: [14, 0], tail: [226, 234, 216, 198, 184, 172, 158] }],
      [17, { px: 9, py: 5, torso: 66, neck: 92, head: 52, jaw: 1, armN: [-20, 30], armF: [-10, 40], footN: [-18, 0], footF: [22, 0], tail: [200, 204, 198, 188, 178, 168, 158] }],
      [24, { px: 10, py: 7, torso: 64, neck: 96, head: 58, jaw: 0.35, armN: [-20, 30], armF: [-10, 40], footN: [-18, 0], footF: [22, 0] }],
      [34, { px: 2, torso: 80, neck: 66, head: 10, jaw: 0.3 }],
      [46, {}],
    ]),
  },
  // TAIL SLAM (HEAVY, then HEAVY): the tail rises high over the back, hangs there, then comes down like a felled tree
  tslam: {
    n: 13, step: 4,
    fn: keys(N, [
      [0, {}],
      [8, { px: -5, py: -3, torso: 90, neck: 74, head: 14, armN: [40, 90], armF: [50, 100], tail: [170, 150, 130, 114, 102, 94, 88], footN: [-18, 0], footF: [16, 0] }],
      [15, { px: -7, py: -5, torso: 96, neck: 80, head: 20, armN: [55, 100], armF: [65, 110], tail: [150, 128, 110, 96, 86, 78, 72], footN: [-20, 0], footF: [14, 0] }],
      [21, { px: -7, py: -5, torso: 97, neck: 80, head: 22, jaw: 0.3, armN: [55, 100], armF: [65, 110], tail: [146, 124, 106, 92, 82, 74, 68], footN: [-20, 0], footF: [14, 0] }],
      [25, { px: 9, py: -3, torso: 60, neck: 46, head: -14, jaw: 0.9, armN: [-20, 20], armF: [-10, 26], tail: [60, 36, 14, -4, -18, -30, -40], footF: [22, 0] }],
      [32, { px: 10, py: -3, torso: 58, neck: 44, head: -16, jaw: 0.6, armN: [-26, 16], armF: [-16, 22], tail: [52, 26, 2, -16, -28, -38, -48], footF: [22, 0] }],
      [48, {}],
    ]),
  },
  // QUAKE STOMP (after SWEEP / CHARGE / LOW / TAIL SLAM): deep crouch, leap, arms thrown up, both feet crash down
  quake: {
    n: 15, step: 4,
    fn: keys(N, [
      [0, {}],
      [8, CROUCH],
      [14, { ...CROUCH, px: -7, py: -9 }],
      [21, { px: 0, py: 12, torso: 90, neck: 80, head: 20, jaw: 0.9, armN: [100, 125], armF: [110, 135], footN: [-8, 14], footF: [22, 16], tail: [228, 236, 216, 196, 180, 168, 154] }],
      [28, { px: 7, py: -8, torso: 82, neck: 66, head: 6, jaw: 1, armN: [-30, 20], armF: [-20, 30], footN: [-24, 0], footF: [26, 0], tail: [214, 226, 214, 198, 184, 172, 160] }],
      [36, { px: 6, py: -10, torso: 84, neck: 68, head: 8, jaw: 0.6, armN: [-40, 10], armF: [-30, 20], footN: [-24, 0], footF: [26, 0] }],
      [48, { px: 2, torso: 82 }],
      [60, {}],
    ]),
  },
} as Partial<Record<AnimName, Anim<GPose>>>);

const timed = { ...anims } as Record<string, Anim<GPose>>;
for (const k in TM) if (timed[k]) timed[k] = retime(timed[k], TM[k]);
export const GODZILLA: CharArt<GPose> = { name: "GODZILLA", w: W, h: H, ox: OX, oy: OY, anims: timed as Record<AnimName, Anim<GPose>>, draw };
