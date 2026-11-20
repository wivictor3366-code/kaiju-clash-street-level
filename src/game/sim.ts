// Deterministic fighting simulation — 2.5D street.
//  * The whole game state is ONE flat Int32Array -> rollback snapshots are a single
//    typed-array copy (zero allocations), checksums are trivial.
//  * Integer-only math (cm units, exact 4/5 conversion from sprite pixels) -> bit-identical
//    on every peer and on every CPU/browser.
//  * The street is a 2.5D plane: X runs along the street, Z is depth (toward / away from the
//    camera). Kaiju walk in depth (UP / DOWN), sidestep (double-tap UP / DOWN) and must share a
//    lane to connect. Beams sweep across lanes, thrown towers fly in 3D.
//  * Hitboxes are NOT hand-tuned: every strike volume is measured from the very joints the
//    sprite is drawn from and baked per frame (Frame.parts). strike() tests those boxes,
//    so the hitbox is the visible limb (plus a small forgiving skin) and costs 2 compares.
//  * The city is unlimited: every cleared lot is rebuilt (deterministically) a few seconds later.
//  * step() is pure w.r.t. (state, input0, input1); audio/particle side effects are emitted
//    into a small event ring drained once per frame by the presentation layer.
import type { Frame } from "./art/atlas";
import { PART_CLAW, PART_HEAD } from "./art/raster";

export const IN_L = 1, IN_R = 2, IN_U = 4, IN_D = 8, IN_A = 16, IN_B = 32, IN_S = 64, IN_G = 128, IN_X = 256;
const BTN = IN_A | IN_B | IN_S | IN_G | IN_X;

export const ST_IDLE = 0, ST_WALKF = 1, ST_WALKB = 2, ST_DASHF = 3, ST_DASHB = 4, ST_BLOCK = 5, ST_LIGHT = 6, ST_HEAVY = 7, ST_BEAM = 8, ST_SUPER = 9,
  ST_GRAB = 10, ST_THROW = 11, ST_RIP = 12, ST_HIT = 13, ST_LAUNCH = 14, ST_HELD = 15, ST_DOWN = 16, ST_GETUP = 17, ST_WIN = 18,
  ST_LOW = 19, ST_SWEEP = 20, ST_CHARGE = 21, ST_LIGHT2 = 22, ST_LIGHT3 = 23, ST_CARRY = 24, ST_HURL = 25, ST_BSLAM = 26, ST_ROAR = 27,
  ST_SIDE = 28, ST_WALKZ = 29;
/** legacy name: the old one-shot "environment throw" is now the full rip sequence */
export const ST_ENV = ST_RIP;

export const G_FRAME = 0, G_PHASE = 1, G_PT = 2, G_ROUND = 3, G_TIMER = 4, G_RNG = 5, G_HAVOC = 6, G_FREEZE = 7, G_WINNER = 8, G_KOBY = 9, G_FRZBY = 10, G_GAP = 11,
  G_ARMY = 12, G_ARMT = 13, G_REBUILT = 14;
const G_N = 15;
export const PH_INTRO = 0, PH_FIGHT = 1, PH_KO = 2, PH_END = 3;

export const X = 0, Y = 1, VX = 2, VY = 3, FACE = 4, HP = 5, METER = 6, ST = 7, T = 8, STOP = 9, STUN = 10, COMBO = 11, CDMG = 12, HITF = 13, BUF = 14, BUFT = 15,
  PREV = 16, TAPD = 17, TAPT = 18, CHAR = 19, WINS = 20, INV = 21, JUG = 22, HAVOC = 23, DASHQ = 24, SLOW = 25, FRZ = 26, ACT = 27,
  Z = 28, VZ = 29, AIMZ = 30, CBI = 31, CBW = 32, CBH = 33, CBS = 34, CBX = 35, TX = 36, TZ = 37, OTG = 38, FEAR = 39, BEST = 40;
const F_N = 41;
export const F0 = G_N, F1 = F0 + F_N;

// buildings: BW = half width, depth half-extent = BW * 3/4, BROW = band (0 front, 1 mid-street, 2 back)
// BFL: 0 standing, 1 ripped out, 2 freshly rebuilt (rising), BDT: frame of the last destroy / rebuild
export const NB = 24, BX = 0, BW = 1, BH = 2, BHP = 3, BROW = 4, BDT = 5, BSEED = 6, BFL = 7, BZ = 8;
export const B_N = 9, B0 = F1 + F_N;
// projectiles: PT 1 = hurled tower, 2 = dropped tower; PW/PH = the tower's own half-width / height
export const NP = 4, PT = 0, PX = 1, PY = 2, PVX = 3, PVY = 4, POWN = 5, PSEED = 6, PZ = 7, PVZ = 8, PW = 9, PH = 10;
export const P_N = 11, P0 = B0 + NB * B_N;
export const STATE_SIZE = P0 + NP * P_N;

export const STAGE = 23000, MINSEP = 3400, MAXSEP = 17000, START_X = 7000, ROUND_FRAMES = 99 * 60, MAX_METER = 1000, BEAM_COST = 250;
/** depth limits of the fighting plane (cm, relative to the lane the camera frames) */
export const Z_MIN = -2400, Z_MAX = 4600, LANE = 2200, BODY_Z = 1900, BEAM_Z = 2000, SUPER_Z = 4000;
export const SUPER_FREEZE = 40, SUPER_SU = 14, SUPER_AC = 55, SUPER_RC = 30;
export const GRAB_TOTAL = 58, GRAB_AT = 12, GRAB_WINDOW = 8;
export const THROW_TOTAL = 60, THROW_REL = 40;
export const RIP_GRIP = 18, RIP_TOTAL = 46, CARRY_MAX = 240, HURL_REL = 14, HURL_TOTAL = 36, BS_SU = 16, BS_AC = 6, BS_HIT = BS_SU + 2, BS_TOTAL = 50;
export const ROAR_TOTAL = 72, ROAR_AT = 34, SIDE_TOTAL = 18, RESPAWN = 420, RISE = 70, RIP_MAXH = 7400, ARMY_EVERY = 200;
export const ENV_TOTAL = RIP_TOTAL, ENV_REL = RIP_GRIP; // legacy aliases
export const VICTIM_HALF = 2400; // cm; matches roughly the drawn body width
const SKIN = 900; // forgiving margin around a strike volume (cm)

export interface Move {
  su: number; ac: number; a0: number; a1: number; rc: number; dmg: number; hs: number; bs: number;
  reach: number; part: number; ph: number; pb: number; lvx: number; lvy: number; stop: number; launch: boolean; total: number;
  /** depth reach: how far off-lane (cm) the move still connects */
  zr: number;
}
const mv = (su: number, ac: number, a0: number, a1: number, rc: number, dmg: number, hs: number, bs: number, reach: number, part: number, ph: number, pb: number, stop: number, launch: boolean, zr: number): Move => ({
  su, ac, a0, a1, rc, dmg, hs, bs, reach, part, ph, pb, lvx: launch ? 260 : 0, lvy: launch ? 430 : 0, stop, launch,
  total: su + a1 + rc + 4, zr,
});

export interface CharData {
  name: string; hp: number; height: number; walkF: number; walkB: number; walkZ: number; sideV: number; dashF: number; dashFT: number; dashB: number; dashBT: number;
  light: Move; light2: Move; light3: Move; heavy: Move; low: Move; sweep: Move; charge: Move; grab: number;
  /** forward offset (cm) of the gripping hand / jaw at RIP_GRIP — measured from the baked rip frame */
  ripReach: number;
  beamSu: number; beamAc: number; beamRc: number; beamDmg: number; beamReach: number; beamY: number; beamSlope: number;
}
export const CH: CharData[] = [
  {
    name: "GODZILLA", hp: 1000, height: 12000, walkF: 46, walkB: 34, walkZ: 36, sideV: 175, dashF: 135, dashFT: 20, dashB: 120, dashBT: 18,
    light: mv(10, 4, 6, 13, 20, 55, 22, 13, 9000, PART_CLAW, 240, 620, 9, false, 2200),
    light2: mv(9, 4, 4, 11, 18, 50, 26, 14, 9500, PART_CLAW, 320, 600, 10, false, 2200),
    light3: mv(13, 4, 4, 12, 22, 78, 0, 18, 10500, PART_HEAD, 300, 700, 12, true, 2400),
    heavy: mv(22, 4, 6, 14, 22, 120, 0, 20, 13500, 2, 0, 800, 13, true, 3200),
    low: mv(16, 4, 6, 11, 15, 42, 0, 16, 9000, 3, 300, 560, 10, true, 2600),
    sweep: mv(20, 4, 4, 14, 20, 70, 0, 18, 13500, 2, 420, 640, 12, true, 3600),
    charge: mv(14, 4, 2, 12, 20, 95, 0, 20, 10500, 1, 300, 520, 14, true, 2600),
    grab: 5400, ripReach: 4750,
    beamSu: 36, beamAc: 48, beamRc: 24, beamDmg: 21, beamReach: 17000, beamY: 9800, beamSlope: 42,
  },
  {
    name: "KING GHIDORAH", hp: 1000, height: 15000, walkF: 40, walkB: 32, walkZ: 32, sideV: 165, dashF: 150, dashFT: 22, dashB: 135, dashBT: 20,
    light: mv(10, 4, 6, 13, 20, 48, 22, 13, 12500, PART_CLAW, 240, 620, 9, false, 2200),
    light2: mv(9, 4, 4, 11, 18, 46, 26, 14, 12000, PART_CLAW, 320, 600, 10, false, 2200),
    light3: mv(13, 4, 4, 12, 22, 72, 0, 18, 13000, PART_HEAD, 300, 700, 12, true, 2600),
    heavy: mv(24, 4, 2, 10, 24, 115, 0, 20, 15500, 1, 360, 760, 13, true, 2800),
    low: mv(16, 4, 6, 12, 16, 38, 0, 16, 9000, 3, 300, 560, 10, true, 2600),
    sweep: mv(20, 4, 4, 14, 20, 65, 0, 18, 15000, 2, 420, 640, 12, true, 3600),
    charge: mv(14, 4, 2, 12, 20, 90, 0, 20, 12500, 1, 300, 520, 14, true, 2600),
    grab: 6200, ripReach: 8470,
    beamSu: 36, beamAc: 48, beamRc: 24, beamDmg: 20, beamReach: 18000, beamY: 13500, beamSlope: 62,
  },
];
const SCALE = [100, 90, 78, 66, 56, 46, 38, 32, 28];
/** max HP of a tower per band (front row, mid-street, back row) */
export const BHP_MAX = [130, 200, 260];

/** presentation bridge: must return exactly the frame the renderer draws. */
export interface RigCtx {
  fr: (o: number) => Frame;
}

// ------------------------------------------------------------------ events
export const EV_STEP = 1, EV_HIT = 2, EV_BLOCK = 3, EV_COLLAPSE = 4, EV_CRASH = 5, EV_SLAM = 6, EV_SUPER = 7, EV_BEAM = 8, EV_KO = 9, EV_FIGHT = 10,
  EV_ROUND = 11, EV_GRAB = 12, EV_RIP = 13, EV_CHUNK = 14, EV_SWING = 15, EV_DASH = 16, EV_TIMEUP = 17, EV_END = 18, EV_CLASH = 19,
  EV_ROAR = 20, EV_ARMY = 21, EV_REBUILD = 22, EV_SIDE = 23, EV_BSMASH = 24;
/** hit kinds carried by EV_HIT.b */
export const K_LIGHT = 1, K_HEAVY = 2, K_LOW = 3, K_SWEEP = 4, K_CHARGE = 5, K_BEAM = 6, K_SUPER = 7, K_TOWER = 8, K_LIGHT2 = 9, K_LIGHT3 = 10, K_BSLAM = 11, K_OTG = 12, K_THROW = 13;
/** every event is [type, a, b, c, d] — d is the depth (Z, cm) where it happened when relevant */
export const EVS = 5, EVMAX = 40;
export const EV = new Int32Array(EVMAX * EVS);
export let evN = 0;
function ev(type: number, a = 0, b = 0, c = 0, d = 0) {
  if (evN >= EVMAX) return;
  const i = evN++ * EVS;
  EV[i] = type;
  EV[i + 1] = a;
  EV[i + 2] = b;
  EV[i + 3] = c;
  EV[i + 4] = d;
}

// ------------------------------------------------------------------ helpers
function rnd(s: Int32Array): number {
  let x = s[G_RNG];
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s[G_RNG] = x;
  return x >>> 0;
}
function setSt(s: Int32Array, o: number, st: number) {
  s[o + ST] = st;
  s[o + T] = 0;
}
function addMeter(s: Int32Array, o: number, v: number) {
  const m = s[o + METER] + v;
  s[o + METER] = m > MAX_METER ? MAX_METER : m;
}
function hittable(s: Int32Array, o: number): boolean {
  const st = s[o + ST];
  return s[o + INV] <= 0 && st !== ST_DOWN && st !== ST_GETUP && st !== ST_HELD;
}
const px2cm = (v: number) => Math.trunc(v * 80); // sprite px -> cm (PX_M = 0.8 m per px)
const iabs = (v: number) => (v < 0 ? -v : v);
const who = (o: number) => (o === F0 ? 0 : 1);
/** depth half-extent of a tower */
export const bDepth = (bw: number) => (bw * 3) >> 2;

export function moveOf(o: number, st: number, char: number): Move | null {
  const c = CH[char];
  switch (st) {
    case ST_LIGHT: return c.light;
    case ST_LIGHT2: return c.light2;
    case ST_LIGHT3: return c.light3;
    case ST_HEAVY: return c.heavy;
    case ST_LOW: return c.low;
    case ST_SWEEP: return c.sweep;
    case ST_CHARGE: return c.charge;
    default: return null;
  }
}
const KIND_OF: Record<number, number> = { [ST_LIGHT]: K_LIGHT, [ST_HEAVY]: K_HEAVY, [ST_LOW]: K_LOW, [ST_SWEEP]: K_SWEEP, [ST_CHARGE]: K_CHARGE, [ST_LIGHT2]: K_LIGHT2, [ST_LIGHT3]: K_LIGHT3 };
const ST_OF_KIND: Record<number, number> = { [K_LIGHT]: ST_LIGHT, [K_HEAVY]: ST_HEAVY, [K_LOW]: ST_LOW, [K_SWEEP]: ST_SWEEP, [K_CHARGE]: ST_CHARGE, [K_LIGHT2]: ST_LIGHT2, [K_LIGHT3]: ST_LIGHT3 };

/** neutral movement states (can act freely) */
export function isNeutral(st: number): boolean {
  return st === ST_IDLE || st === ST_WALKF || st === ST_WALKB || st === ST_WALKZ;
}
/** attack / action states (used by the CPU threat read and the presentation layer) */
export function isAttack(st: number): boolean {
  return st === ST_LIGHT || st === ST_LIGHT2 || st === ST_LIGHT3 || st === ST_HEAVY || st === ST_LOW || st === ST_SWEEP || st === ST_CHARGE ||
    st === ST_BEAM || st === ST_SUPER || st === ST_GRAB || st === ST_THROW || st === ST_RIP || st === ST_HURL || st === ST_BSLAM;
}
/** true while the fighter physically holds a ripped tower */
export function holdState(st: number, t: number): boolean {
  return (st === ST_RIP && t >= RIP_GRIP) || st === ST_CARRY || (st === ST_HURL && t < HURL_REL) || (st === ST_BSLAM && t < BS_HIT);
}

function isActive(s: Int32Array, o: number): boolean {
  const st = s[o + ST], t = s[o + T];
  if (st === ST_BEAM) {
    const c = CH[s[o + CHAR]], t0 = t - c.beamSu;
    return t0 > 0 && t0 <= c.beamAc;
  }
  if (st === ST_SUPER) {
    const t0 = t - SUPER_SU;
    return t0 > 0 && t0 <= SUPER_AC;
  }
  if (st === ST_BSLAM) return t > BS_SU && t <= BS_SU + BS_AC;
  const m = moveOf(o, st, s[o + CHAR]);
  if (!m) return false;
  return t > m.su + m.a0 && t <= m.su + m.a1;
}

function destroy(s: Int32Array, b: number, by: number, ripped: number) {
  const bo = B0 + b * B_N;
  s[bo + BHP] = 0;
  s[bo + BDT] = s[G_FRAME];
  s[bo + BFL] = ripped;
  s[G_HAVOC] += ((s[bo + BH] * s[bo + BW]) / 40000 + 5) | 0;
  addMeter(s, by, 70);
  s[by + HAVOC]++;
  ev(ripped ? EV_RIP : EV_COLLAPSE, b, s[bo + BX], s[bo + BH], s[bo + BZ]);
}

// ------------------------------------------------------------------ the city (unlimited, lot-based)
// band: [lots, z0, zSpan, wMin, wSpan, hMin, hSpan, xOffset]
const BANDS = [
  [8, -2900, 300, 800, 700, 1400, 2000, 0],
  [7, 500, 1700, 900, 600, 2400, 2800, 1500],
  [9, 5800, 800, 1100, 900, 4200, 5200, 2400],
];
export function lotBand(i: number): number {
  return i < 8 ? 0 : i < 15 ? 1 : 2;
}
function genLot(s: Int32Array, i: number, initial: boolean) {
  const bo = B0 + i * B_N, band = lotBand(i), B = BANDS[band];
  const slot = band === 0 ? i : band === 1 ? i - 8 : i - 15, n = B[0], span = 42000, cell = (span / n) | 0;
  let x = -21000 + slot * cell + (cell >> 1) + B[7] - (B[7] ? cell >> 2 : 0) + (rnd(s) % 1600) - 800;
  if (initial && band < 2)
    for (let k = -1; k <= 1; k += 2) {
      const c = k * START_X;
      if (iabs(x - c) < 4400) x = x < c ? c - 4400 - (rnd(s) % 500) : c + 4400 + (rnd(s) % 500);
    }
  s[bo + BX] = x;
  s[bo + BZ] = B[1] + (rnd(s) % B[2]);
  s[bo + BW] = B[3] + (rnd(s) % B[4]);
  s[bo + BH] = B[5] + (rnd(s) % B[6]);
  s[bo + BHP] = BHP_MAX[band];
  s[bo + BROW] = band;
  s[bo + BDT] = initial ? -1 : s[G_FRAME];
  s[bo + BSEED] = rnd(s) & 0xffff;
  s[bo + BFL] = initial ? 0 : 2;
}

function resetRound(s: Int32Array) {
  for (let i = 0; i < 2; i++) {
    const o = i ? F1 : F0;
    const ch = s[o + CHAR], wins = s[o + WINS], meter = s[o + METER], hav = s[o + HAVOC], best = s[o + BEST];
    for (let k = 0; k < F_N; k++) s[o + k] = 0;
    s[o + CHAR] = ch;
    s[o + WINS] = wins;
    s[o + HAVOC] = hav;
    s[o + BEST] = best;
    s[o + METER] = meter < BEAM_COST ? BEAM_COST : meter;
    s[o + X] = i ? START_X : -START_X;
    s[o + Z] = 0;
    s[o + AIMZ] = 0;
    s[o + FACE] = i ? -1 : 1;
    s[o + HP] = CH[ch].hp;
    s[o + ST] = ST_WIN;
  }
  for (let k = 0; k < NP * P_N; k++) s[P0 + k] = 0;
  for (let i = 0; i < NB; i++) genLot(s, i, true);
  s[G_PHASE] = PH_INTRO;
  s[G_PT] = 0;
  s[G_TIMER] = ROUND_FRAMES;
  s[G_FREEZE] = 0;
  s[G_KOBY] = 0;
  s[G_GAP] = 0;
  s[G_ARMY] = 0;
  s[G_ARMT] = 0;
  ev(EV_ROUND, s[G_ROUND]);
}

export function initState(s: Int32Array, seed: number, c0: number, c1: number) {
  evN = 0;
  s.fill(0);
  s[G_RNG] = seed | 1;
  s[F0 + CHAR] = c0;
  s[F1 + CHAR] = c1;
  s[G_ROUND] = 1;
  resetRound(s);
}

export function checksum(s: Int32Array): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < STATE_SIZE; i++) h = Math.imul(h ^ s[i], 16777619);
  return h >>> 0;
}

// ------------------------------------------------------------------ move selection (cancel routes)
// A strict DAG so there are no infinite loops: LIGHT < LIGHT2 < LIGHT3 < HEAVY < CHARGE < BEAM < SUPER, LOW < SWEEP < BEAM
const CANCEL: Record<number, number[]> = {
  [ST_LIGHT]: [ST_LIGHT2, ST_HEAVY, ST_LOW, ST_SWEEP, ST_BEAM],
  [ST_LIGHT2]: [ST_LIGHT3, ST_HEAVY, ST_SWEEP, ST_BEAM],
  [ST_LIGHT3]: [ST_HEAVY, ST_CHARGE, ST_BEAM, ST_SUPER],
  [ST_LOW]: [ST_SWEEP, ST_BEAM],
  [ST_SWEEP]: [ST_BEAM, ST_SUPER],
  [ST_HEAVY]: [ST_CHARGE, ST_BEAM, ST_SUPER],
  [ST_CHARGE]: [ST_BEAM, ST_SUPER],
  [ST_BEAM]: [ST_SUPER],
};

/** the tower ↓+GRAB would rip right now (shared by the renderer's telegraph), -1 if none */
export function ripTarget(s: Int32Array, o: number): number {
  const face = s[o + FACE], fr = s[G_FRAME], reach = CH[s[o + CHAR]].ripReach;
  let best = -1, bd = 1 << 30;
  for (let i = 0; i < NB; i++) {
    const bo = B0 + i * B_N;
    if (s[bo + BHP] <= 0 || s[bo + BH] > RIP_MAXH) continue;
    if (s[bo + BFL] === 2 && fr - s[bo + BDT] < RISE) continue; // still rising out of the scaffolding
    const rel = (s[bo + BX] - s[o + X]) * face, dz = iabs(s[bo + BZ] - s[o + Z]);
    if (rel > reach - 6000 && rel < reach + 5500 && dz < 4200) {
      const sc = iabs(rel - reach - s[bo + BW]) + dz * 2;
      if (sc < bd) {
        bd = sc;
        best = i;
      }
    }
  }
  return best;
}

/** from = current state when cancelling, -1 for neutral. returns true if a move started. */
function tryMove(s: Int32Array, o: number, from: number): boolean {
  const b = s[o + BUF];
  if (!b) return false;
  const neutral = from < 0;
  const ok = (st: number) => neutral || (CANCEL[from] ? CANCEL[from].includes(st) : false);
  const w = who(o);
  let ns = -1;
  if (b & IN_X && s[o + METER] >= MAX_METER && ok(ST_SUPER)) {
    ns = ST_SUPER;
    s[o + METER] = 0;
    s[o + AIMZ] = s[o + Z];
    s[G_FREEZE] = SUPER_FREEZE;
    s[G_FRZBY] = w;
    ev(EV_SUPER, w);
  } else if (b & IN_S && s[o + METER] >= BEAM_COST && ok(ST_BEAM)) {
    ns = ST_BEAM;
    s[o + METER] -= BEAM_COST;
    s[o + AIMZ] = s[o + Z];
    ev(EV_BEAM, w);
  } else if (neutral && b & IN_G) {
    if (b & IN_D) {
      const bi = ripTarget(s, o);
      if (bi >= 0) {
        // lock the tower: the lunge lines the gripping hand up with its near wall at RIP_GRIP
        const bo = B0 + bi * B_N, face = s[o + FACE], c = CH[s[o + CHAR]];
        let tx = s[bo + BX] - face * (s[bo + BW] + c.ripReach);
        tx = tx > STAGE ? STAGE : tx < -STAGE ? -STAGE : tx;
        let tz = s[bo + BZ];
        tz = tz > Z_MAX ? Z_MAX : tz < Z_MIN ? Z_MIN : tz;
        s[o + CBI] = bi + 1;
        s[o + TX] = tx;
        s[o + TZ] = tz;
        ns = ST_RIP;
        ev(EV_SWING, w, 5);
      }
    } else if (b & IN_U) {
      ns = ST_ROAR;
    }
    if (ns < 0) {
      ns = ST_GRAB;
      ev(EV_SWING, w, 3);
    }
  } else if (b & IN_B) {
    if (b & IN_U && ok(ST_CHARGE)) ns = ST_CHARGE;
    else if (b & IN_D && ok(ST_SWEEP)) ns = ST_SWEEP;
    else if (ok(ST_HEAVY)) ns = ST_HEAVY;
    if (ns >= 0) ev(EV_SWING, w, ns === ST_CHARGE ? 4 : 2);
  } else if (b & IN_A) {
    if (b & IN_D && ok(ST_LOW)) ns = ST_LOW;
    else if (from === ST_LIGHT && ok(ST_LIGHT2)) ns = ST_LIGHT2;
    else if (from === ST_LIGHT2 && ok(ST_LIGHT3)) ns = ST_LIGHT3;
    else if (ok(ST_LIGHT)) ns = ST_LIGHT;
    if (ns >= 0) ev(EV_SWING, w, 1);
  }
  if (ns < 0) return false;
  s[o + BUF] = 0;
  s[o + BUFT] = 0;
  s[o + HITF] = 0;
  s[o + VX] = 0;
  s[o + VZ] = 0;
  setSt(s, o, ns);
  return true;
}

function spawnTower(s: Int32Array, o: number, kind: number, x: number, y: number, vx: number, vy: number, vz: number) {
  for (let i = 0; i < NP; i++) {
    const po = P0 + i * P_N;
    if (s[po + PT]) continue;
    s[po + PT] = kind;
    s[po + PX] = x;
    s[po + PY] = y;
    s[po + PZ] = s[o + Z];
    s[po + PVX] = vx;
    s[po + PVY] = vy;
    s[po + PVZ] = vz;
    s[po + POWN] = who(o);
    s[po + PSEED] = (s[G_FRAME] * 7 + who(o) * 3 + i) & 0xffff;
    s[po + PW] = s[o + CBW];
    s[po + PH] = s[o + CBH];
    break;
  }
  s[o + CBH] = 0;
  s[o + CBI] = 0;
}

/** a carrier that gets interrupted lets go: the tower topples off its hands */
function dropHeld(s: Int32Array, o: number) {
  const face = s[o + FACE], c = CH[s[o + CHAR]];
  spawnTower(s, o, 2, s[o + X] + face * (2400 + s[o + CBW]), s[o + Y] + ((c.height * 8) / 10 | 0), face * 25, 30, 0);
}

function control(s: Int32Array, o: number, e: number, inp: number, rig: RigCtx) {
  const pressed = inp & ~s[o + PREV];
  s[o + PREV] = inp;
  const btn = pressed & BTN;
  if (btn) {
    s[o + BUF] = btn | (inp & (IN_D | IN_U));
    s[o + BUFT] = 10; // buffered input
  } else if (s[o + BUFT] > 0 && --s[o + BUFT] === 0) s[o + BUF] = 0;
  const dp = pressed & (IN_L | IN_R | IN_U | IN_D);
  if (dp) {
    if (s[o + TAPD] === dp && s[o + TAPT] > 0) {
      s[o + DASHQ] = dp;
      s[o + TAPT] = 0;
    } else {
      s[o + TAPD] = dp;
      s[o + TAPT] = 14;
    }
  } else if (s[o + TAPT] > 0) s[o + TAPT]--;

  s[o + FRZ] = 0;
  if (s[o + STOP] > 0) {
    s[o + STOP]--;
    s[o + FRZ] = 1; // hitstop: freeze both actors, keep the pose
    return;
  }
  if (s[o + INV] > 0) s[o + INV]--;
  if (s[o + FEAR] > 0) s[o + FEAR]--;
  const c = CH[s[o + CHAR]];
  const st = s[o + ST];
  const t = ++s[o + T];
  let face = s[o + FACE];
  const slow = s[o + SLOW];
  s[o + SLOW] = 0;
  const w = who(o);
  const idle = () => {
    setSt(s, o, ST_IDLE);
    s[o + VX] = 0;
    s[o + VZ] = 0;
  };
  const faceFoe = () => {
    const dx = s[e + X] - s[o + X];
    if (dx > 200) face = 1;
    else if (dx < -200) face = -1;
    s[o + FACE] = face;
  };
  /** soft homing in depth during startup frames (k = cm per frame) */
  const track = (k: number) => {
    const dz = s[e + Z] - s[o + Z];
    if (dz > 7000 || dz < -7000) s[o + VZ] = 0;
    else s[o + VZ] = dz > k ? k : dz < -k ? -k : dz;
  };
  const steer = (pct: number) => {
    const fwd = face > 0 ? IN_R : IN_L, back = face > 0 ? IN_L : IN_R;
    const mx = inp & fwd && !(inp & back) ? 1 : inp & back && !(inp & fwd) ? -1 : 0;
    const mz = inp & IN_U && !(inp & IN_D) ? 1 : inp & IN_D && !(inp & IN_U) ? -1 : 0;
    s[o + VX] = mx > 0 ? ((c.walkF * pct) >> 3) * face : mx < 0 ? -((c.walkB * pct) >> 3) * face : 0;
    s[o + VZ] = mz * ((c.walkZ * pct) >> 3);
    return mx > 0 ? ST_WALKF : mx < 0 ? ST_WALKB : mz ? ST_WALKZ : ST_IDLE;
  };
  switch (st) {
    case ST_IDLE:
    case ST_WALKF:
    case ST_WALKB:
    case ST_WALKZ: {
      s[o + COMBO] = 0;
      s[o + CDMG] = 0;
      s[o + JUG] = 0;
      s[o + OTG] = 0;
      faceFoe();
      const fwd = face > 0 ? IN_R : IN_L, back = face > 0 ? IN_L : IN_R;
      if (tryMove(s, o, -1)) break;
      const dq = s[o + DASHQ];
      if (dq === fwd) {
        setSt(s, o, ST_DASHF);
        s[o + VZ] = 0;
        ev(EV_DASH, w);
      } else if (dq === back) {
        setSt(s, o, ST_DASHB);
        s[o + INV] = 7;
        s[o + VZ] = 0;
        ev(EV_DASH, w);
      } else if (dq === IN_U || dq === IN_D) {
        // sidestep: a quick hop out of the lane, briefly intangible
        setSt(s, o, ST_SIDE);
        s[o + INV] = 8;
        s[o + VX] = 0;
        s[o + VZ] = dq === IN_U ? c.sideV : -c.sideV;
        ev(EV_SIDE, w, s[o + X], 0, s[o + Z]);
      } else {
        const ns = steer(slow ? 5 : 8);
        if (st !== ns) setSt(s, o, ns);
        if (ns !== ST_IDLE && s[o + T] % 28 === 1) ev(EV_STEP, s[o + X], w, 0, s[o + Z]);
      }
      break;
    }
    case ST_SIDE:
      if (t > 12) s[o + VZ] = 0;
      if (t > 9 && tryMove(s, o, -1)) break; // attack straight out of the sidestep
      if (t >= SIDE_TOTAL) idle();
      break;
    case ST_DASHF:
      s[o + VX] = c.dashF * face;
      if (t > 6 && tryMove(s, o, -1)) break;
      if (t >= c.dashFT) idle();
      break;
    case ST_DASHB:
      s[o + VX] = -c.dashB * face;
      if (t >= c.dashBT) idle();
      break;
    case ST_BLOCK:
    case ST_HIT:
      s[o + VZ] = 0;
      if (--s[o + STUN] <= 0) idle();
      break;
    case ST_LIGHT:
    case ST_LIGHT2:
    case ST_LIGHT3:
    case ST_LOW:
    case ST_SWEEP:
    case ST_HEAVY:
    case ST_CHARGE: {
      const m = moveOf(o, st, s[o + CHAR])!;
      if (st === ST_LIGHT) s[o + VX] = t <= m.su ? 70 * face : 0;
      else if (st === ST_LIGHT2) s[o + VX] = t <= m.su ? 130 * face : 0;
      else if (st === ST_LIGHT3) s[o + VX] = t > m.su - 5 && t <= m.su + m.a1 ? 100 * face : 0;
      else if (st === ST_LOW) s[o + VX] = t <= m.su ? 60 * face : 0;
      else if (st === ST_SWEEP) s[o + VX] = t > m.su && t < m.su + m.ac ? 90 * face : 0;
      else if (st === ST_CHARGE) s[o + VX] = t > m.su && t < m.su + m.ac ? 165 * face : 0;
      else s[o + VX] = 0;
      if (t <= m.su) track(st === ST_CHARGE ? 60 : 40);
      else s[o + VZ] = 0;
      if (s[o + HITF] && tryMove(s, o, st)) break;
      if (t >= m.total) idle();
      break;
    }
    case ST_BEAM: {
      s[o + VX] = 0;
      s[o + VZ] = 0;
      // the beam sweeps across lanes toward the target: sidestep out of it!
      const k = t <= c.beamSu ? 30 : 60, dz = s[e + Z] - s[o + AIMZ];
      s[o + AIMZ] += dz > k ? k : dz < -k ? -k : dz;
      if (s[o + HITF] && tryMove(s, o, ST_BEAM)) break;
      if (t >= c.beamSu + c.beamAc + c.beamRc) idle();
      break;
    }
    case ST_SUPER: {
      s[o + VX] = 0;
      s[o + VZ] = 0;
      const dz = s[e + Z] - s[o + AIMZ];
      s[o + AIMZ] += dz > 90 ? 90 : dz < -90 ? -90 : dz;
      if (t >= SUPER_SU + SUPER_AC + SUPER_RC) idle();
      break;
    }
    case ST_GRAB:
      s[o + VX] = t <= 10 ? 60 * face : 0;
      if (t <= GRAB_AT) track(50);
      else s[o + VZ] = 0;
      if (t >= GRAB_TOTAL) idle();
      break;
    case ST_THROW:
      s[o + VX] = 0;
      s[o + VZ] = 0;
      if (s[e + ST] === ST_HELD) {
        if (t < THROW_REL) {
          const k = t < 24 ? t : 24;
          s[e + X] = s[o + X] + face * (4000 - k * 70);
          s[e + Y] = k * 230;
          s[e + Z] = s[o + Z];
        } else if (t === THROW_REL) {
          const n = s[e + COMBO];
          const d = (120 * SCALE[n > 8 ? 8 : n]) / 100 | 0;
          s[e + HP] -= d;
          s[e + COMBO] = n + 1;
          s[e + CDMG] += d;
          if (n + 1 > s[o + BEST]) s[o + BEST] = n + 1;
          addMeter(s, o, 90);
          addMeter(s, e, 50);
          setSt(s, e, ST_LAUNCH);
          s[e + VX] = 340 * face;
          s[e + VY] = 520;
          s[e + VZ] = 0;
          s[e + JUG] = 3;
          s[o + STOP] = 8;
          s[e + STOP] = 8;
          s[o + HITF] = 1;
          ev(EV_HIT, s[e + X], K_THROW, d, s[e + Z]);
        }
      }
      if (t >= THROW_TOTAL) idle();
      break;
    case ST_RIP: {
      // 1) lunge + crouch so the gripping hand meets the tower's near wall exactly at RIP_GRIP
      if (t < RIP_GRIP) {
        s[o + VX] = ((s[o + TX] - s[o + X]) / (RIP_GRIP - t)) | 0;
        s[o + VZ] = ((s[o + TZ] - s[o + Z]) / (RIP_GRIP - t)) | 0;
      } else {
        s[o + VX] = 0;
        s[o + VZ] = 0;
      }
      // 2) grip: the tower leaves its foundations and is now carried (its offset is remembered)
      if (t === RIP_GRIP) {
        const bi = s[o + CBI] - 1, bo = B0 + bi * B_N;
        if (bi >= 0 && s[bo + BHP] > 0) {
          s[o + CBW] = s[bo + BW];
          s[o + CBH] = s[bo + BH];
          s[o + CBS] = s[bo + BSEED];
          // the grip is defined as the hand clamping the near wall; any residual misalignment from
          // pushes during the lunge is absorbed by the renderer sliding the tower into the hand
          s[o + CBX] = c.ripReach + s[bo + BW];
          destroy(s, bi, o, 1);
        } else {
          s[o + CBI] = 0; // somebody wrecked it first: grab at thin air
          idle();
          break;
        }
      }
      // 3) heave + hoist overhead (pure animation), then carry
      if (t >= RIP_TOTAL) setSt(s, o, ST_CARRY);
      break;
    }
    case ST_CARRY: {
      faceFoe();
      const b = s[o + BUF];
      if (b & (IN_A | IN_B)) {
        s[o + BUF] = 0;
        s[o + BUFT] = 0;
        s[o + VX] = 0;
        s[o + VZ] = 0;
        s[o + TX] = c.ripReach + s[o + CBH] + 1500; // club reach = arm / neck reach + the tower's own length
        s[o + HITF] = 0;
        setSt(s, o, ST_BSLAM);
        ev(EV_SWING, w, 6);
        break;
      }
      if (b & (IN_G | IN_S) || t >= CARRY_MAX) {
        s[o + BUF] = 0;
        s[o + BUFT] = 0;
        s[o + VX] = 0;
        s[o + VZ] = 0;
        setSt(s, o, ST_HURL);
        ev(EV_SWING, w, 2);
        break;
      }
      const ns = steer(5);
      if (ns !== ST_IDLE && t % 30 === 1) ev(EV_STEP, s[o + X], w, 0, s[o + Z]);
      break;
    }
    case ST_HURL:
      s[o + VX] = 0;
      s[o + VZ] = 0;
      if (t === HURL_REL && s[o + CBH] > 0) {
        // release from the exact hand position of the frame being drawn
        const fr = rig.fr(o), hx = px2cm(fr.hand[0]), hy = px2cm(fr.hand[1]);
        let d = (((s[e + X] - s[o + X]) * face - 3000) / 40) | 0;
        d = d < 120 ? 120 : d > 460 ? 460 : d;
        const sx = s[o + X] + face * (hx + s[o + CBW]), sy = s[o + Y] + hy;
        const flight = iabs(s[e + X] - sx) / d | 0;
        const vz = ((s[e + Z] - s[o + Z]) / (flight < 10 ? 10 : flight)) | 0;
        spawnTower(s, o, 1, sx, sy, d * face, 120, vz > 220 ? 220 : vz < -220 ? -220 : vz);
        ev(EV_SWING, w, 2);
      }
      if (t >= HURL_TOTAL) idle();
      break;
    case ST_BSLAM:
      s[o + VX] = t > 6 && t <= BS_SU ? 40 * face : 0;
      if (t <= BS_SU) track(40);
      else s[o + VZ] = 0;
      if (t === BS_HIT && s[o + CBH] > 0) {
        // the tower is used as a club and shatters on the street
        const ix = s[o + X] + face * (c.ripReach + ((s[o + CBH] * 3) >> 2)), iz = s[o + Z];
        for (let i = 0; i < NB; i++) {
          const bo = B0 + i * B_N;
          if (s[bo + BHP] > 0 && iabs(s[bo + BX] - ix) < s[bo + BW] + 2000 && iabs(s[bo + BZ] - iz) < bDepth(s[bo + BW]) + 2000) destroy(s, i, o, 0);
        }
        ev(EV_BSMASH, ix, s[o + CBH], w, iz);
        s[o + CBH] = 0;
        s[o + CBI] = 0;
      }
      if (t >= BS_TOTAL) idle();
      break;
    case ST_ROAR:
      s[o + VX] = 0;
      s[o + VZ] = 0;
      if (t === 12) ev(EV_ROAR, w, s[o + X], 0, s[o + Z]);
      if (t === ROAR_AT) {
        addMeter(s, o, 160);
        s[o + FEAR] = 420; // the army pulls back from a roaring monster
      }
      if (t >= ROAR_TOTAL) idle();
      break;
    case ST_HELD:
      s[o + VZ] = 0;
      if (s[e + ST] !== ST_THROW) {
        setSt(s, o, ST_LAUNCH);
        s[o + VX] = 0;
        s[o + VY] = 0;
      }
      break;
    case ST_DOWN:
      s[o + VX] = 0;
      s[o + VZ] = 0;
      if (s[o + HP] > 0 && t >= 46) setSt(s, o, ST_GETUP);
      break;
    case ST_GETUP:
      if (t >= 30) {
        idle();
        s[o + INV] = 4;
        s[o + OTG] = 0;
      }
      break;
  }
  s[o + DASHQ] = 0;
  s[o + ACT] = isActive(s, o) ? 1 : 0;
}

function physics(s: Int32Array, o: number, e: number) {
  if (s[o + FRZ]) return;
  const st = s[o + ST];
  if (st === ST_HELD) return;
  if (st === ST_LAUNCH) {
    s[o + VY] -= 20;
    s[o + X] += s[o + VX];
    s[o + Y] += s[o + VY];
    s[o + Z] += s[o + VZ];
    if (s[o + Y] <= 0 && s[o + VY] < 0) {
      s[o + Y] = 0;
      s[o + VX] = 0;
      s[o + VY] = 0;
      s[o + VZ] = 0;
      setSt(s, o, ST_DOWN);
      ev(EV_SLAM, s[o + X], 0, 0, s[o + Z]);
      for (let i = 0; i < NB; i++) {
        const bo = B0 + i * B_N;
        if (s[bo + BHP] > 0 && iabs(s[bo + BX] - s[o + X]) < s[bo + BW] + 2600 && iabs(s[bo + BZ] - s[o + Z]) < bDepth(s[bo + BW]) + 2600) destroy(s, i, e, 0);
      }
    }
  } else {
    s[o + X] += s[o + VX];
    s[o + Z] += s[o + VZ];
    if (st === ST_HIT || st === ST_BLOCK) s[o + VX] = ((s[o + VX] * 7) / 8) | 0;
  }
  if (s[o + X] > STAGE) {
    s[o + X] = STAGE;
    if (st === ST_LAUNCH) s[o + VX] = 0;
  } else if (s[o + X] < -STAGE) {
    s[o + X] = -STAGE;
    if (st === ST_LAUNCH) s[o + VX] = 0;
  }
  if (s[o + Z] > Z_MAX) s[o + Z] = Z_MAX;
  else if (s[o + Z] < Z_MIN) s[o + Z] = Z_MIN;
}

function pushboxes(s: Int32Array) {
  if (s[F0 + ST] === ST_HELD || s[F1 + ST] === ST_HELD) return;
  const d = s[F1 + X] - s[F0 + X];
  const ad = d < 0 ? -d : d;
  if (ad > MAXSEP) {
    const ex = ad - MAXSEP, sg0 = d > 0 ? 1 : -1;
    const a0 = s[F0 + VX] * sg0 < 0, a1 = s[F1 + VX] * sg0 > 0;
    if (a0 && !a1) s[F0 + X] += sg0 * ex;
    else if (a1 && !a0) s[F1 + X] -= sg0 * ex;
    else {
      s[F0 + X] += sg0 * (ex >> 1);
      s[F1 + X] -= sg0 * (ex - (ex >> 1));
    }
    if (a0 && s[F0 + ST] === ST_LAUNCH) s[F0 + VX] = 0;
    if (a1 && s[F1 + ST] === ST_LAUNCH) s[F1 + VX] = 0;
    return;
  }
  if (s[F0 + Y] > 3000 || s[F1 + Y] > 3000) return;
  if (ad >= MINSEP) return;
  if (iabs(s[F1 + Z] - s[F0 + Z]) >= 2600) return; // different lanes: they can walk past each other
  const sg = d >= 0 ? 1 : -1, ov = MINSEP - ad, h = ov >> 1;
  s[F0 + X] -= sg * h;
  s[F1 + X] += sg * (ov - h);
  for (let k = 0; k < 2; k++) {
    const o = k ? F1 : F0, e = k ? F0 : F1;
    if (s[o + X] > STAGE) {
      s[e + X] -= s[o + X] - STAGE;
      s[o + X] = STAGE;
    } else if (s[o + X] < -STAGE) {
      s[e + X] += -STAGE - s[o + X];
      s[o + X] = -STAGE;
    }
  }
}

// ------------------------------------------------------------------ combat
/** true if a strike volume of `a` overlaps the victim's body box right now (and they share a lane) */
function volumeHit(s: Int32Array, a: number, v: number, part: number, m: Move, rig: RigCtx): boolean {
  if (iabs(s[v + Z] - s[a + Z]) > m.zr) return false;
  const d = (s[v + X] - s[a + X]) * s[a + FACE];
  if (d < -1200 || d > m.reach + 3000) return false; // cheap early out, then the visual box decides
  const fr = rig.fr(a), face = s[a + FACE];
  const p = fr.parts;
  const base = part;
  const bx0 = px2cm(p[base * 4] ?? 0), bx1 = px2cm(p[base * 4 + 2] ?? 0);
  const by0 = px2cm(p[base * 4 + 1] ?? 0), by1 = px2cm(p[base * 4 + 3] ?? 0);
  if (bx1 <= bx0 || by1 <= by0) return false;
  let ax0 = s[a + X] + face * (face > 0 ? bx0 : -bx1) - SKIN;
  let ax1 = s[a + X] + face * (face > 0 ? bx1 : -bx0) + SKIN;
  if (ax0 > ax1) [ax0, ax1] = [ax1, ax0];
  const ay0 = s[a + Y] + by0 - SKIN, ay1 = s[a + Y] + by1 + SKIN;
  const vx0 = s[v + X] - VICTIM_HALF, vx1 = s[v + X] + VICTIM_HALF;
  const vy0 = s[v + Y], vy1 = s[v + Y] + CH[s[v + CHAR]].height;
  return ax1 > vx0 && ax0 < vx1 && ay1 > vy0 && ay0 < vy1;
}

/** 0 = nothing, otherwise a K_* hit kind */
function strike(s: Int32Array, a: number, v: number, rig: RigCtx): number {
  if (s[a + FRZ]) return 0;
  const st = s[a + ST], t = s[a + T], c = CH[s[a + CHAR]];
  // OTG: the stomp can pin a downed opponent once per knockdown
  if (st === ST_LOW && s[v + ST] === ST_DOWN && !s[v + OTG] && s[v + HP] > 0) {
    const m = c.low;
    if (t > m.su + m.a0 && t <= m.su + m.a1 && !s[a + HITF] && volumeHit(s, a, v, m.part, m, rig)) return K_OTG;
    return 0;
  }
  if (!hittable(s, v)) return 0;
  const d = (s[v + X] - s[a + X]) * s[a + FACE];
  const m = moveOf(a, st, s[a + CHAR]);
  if (m) {
    if (t > m.su + m.a0 && t <= m.su + m.a1 && !s[a + HITF] && volumeHit(s, a, v, m.part, m, rig)) return KIND_OF[st];
  } else if (st === ST_BEAM) {
    const t0 = t - c.beamSu;
    if (t0 > 0 && t0 <= c.beamAc && (t0 - 1) % 6 === 0 && d > 1000 && d < c.beamReach && s[v + Y] < 11500 && iabs(s[v + Z] - s[a + AIMZ]) < BEAM_Z) return K_BEAM;
  } else if (st === ST_SUPER) {
    const t0 = t - SUPER_SU;
    if (t0 > 0 && t0 <= SUPER_AC && (t0 - 1) % 5 === 0 && d > 1000 && d < 30000 && iabs(s[v + Z] - s[a + AIMZ]) < SUPER_Z) return K_SUPER;
  } else if (st === ST_BSLAM) {
    if (t > BS_SU && t <= BS_SU + BS_AC && !s[a + HITF] && d > -800 && d < s[a + TX] && iabs(s[v + Z] - s[a + Z]) < 3200 && s[v + Y] < 9000) return K_BSLAM;
  }
  return 0;
}

function applyHit(s: Int32Array, a: number, v: number, kind: number, dir: number) {
  const c = CH[s[a + CHAR]];
  let dmg = 0, hs = 0, bs = 0, ph = 0, pb = 0, stop = 0, lvx = 0, lvy = 0, chip = 0, launch = false;
  const mst = ST_OF_KIND[kind];
  if (mst !== undefined) {
    const m = moveOf(a, mst, s[a + CHAR])!;
    dmg = m.dmg; hs = m.hs; bs = m.bs; ph = m.ph; pb = m.pb; stop = m.stop; lvx = m.lvx; lvy = m.lvy; launch = m.launch;
  } else if (kind === K_BEAM) {
    dmg = c.beamDmg; hs = 15; bs = 12; ph = 260; pb = 300; stop = 3; chip = 6;
  } else if (kind === K_SUPER) {
    dmg = 34; hs = 18; bs = 14; ph = 200; pb = 320; stop = 3; chip = 9;
    if (s[a + T] - SUPER_SU > SUPER_AC - 5) {
      launch = true; lvx = 300; lvy = 430;
    }
  } else if (kind === K_BSLAM) {
    dmg = 110 + (((s[a + TX] - c.ripReach - 1500) / 150) | 0); bs = 22; pb = 800; stop = 14; chip = 25; launch = true; lvx = 260; lvy = 520;
  } else if (kind === K_OTG) {
    dmg = 40; stop = 8; launch = true; lvx = 120; lvy = 280;
  } else {
    dmg = 145; bs = 20; pb = 700; stop = 10; chip = 20; launch = true; lvx = 230; lvy = 400; // thrown building
  }
  const vst = s[v + ST];
  const backBit = s[v + FACE] > 0 ? IN_L : IN_R, fwdBit = s[v + FACE] > 0 ? IN_R : IN_L;
  const proj = kind === K_TOWER;
  if (kind !== K_OTG && (vst === ST_IDLE || vst === ST_WALKB || vst === ST_WALKZ || vst === ST_BLOCK) && s[v + PREV] & backBit && !(s[v + PREV] & fwdBit) && s[v + Y] === 0) {
    setSt(s, v, ST_BLOCK);
    s[v + STUN] = bs;
    s[v + VX] = pb * dir;
    s[v + VZ] = 0;
    if (chip) s[v + HP] = s[v + HP] - chip < 1 ? 1 : s[v + HP] - chip;
    s[v + STOP] = stop < 6 ? stop : 6;
    if (!proj) {
      s[a + HITF] = 2;
      s[a + STOP] = s[v + STOP];
    }
    addMeter(s, a, 15);
    addMeter(s, v, 22);
    ev(EV_BLOCK, s[v + X], kind, 0, s[v + Z]);
    return;
  }
  const n = s[v + COMBO];
  let d = (dmg * SCALE[n > 8 ? 8 : n]) / 100 | 0;
  if (d < 1) d = 1;
  s[v + HP] -= d;
  s[v + COMBO] = n + 1;
  s[v + CDMG] += d;
  if (n + 1 > s[a + BEST]) s[a + BEST] = n + 1;
  addMeter(s, a, (d * 7) / 10 | 0);
  addMeter(s, v, d >> 1);
  if (kind === K_OTG) s[v + OTG] = 1;
  const air = vst === ST_LAUNCH;
  s[v + VZ] = 0;
  if (launch || air || s[v + HP] <= 0) {
    const jug = ++s[v + JUG];
    setSt(s, v, ST_LAUNCH);
    if (air && !launch) {
      s[v + VX] = 120 * dir;
      s[v + VY] = 300 - jug * 40 < 160 ? 160 : 300 - jug * 40;
    } else {
      s[v + VX] = (lvx || 220) * dir;
      s[v + VY] = lvy || 380;
    }
    if (jug > 5) s[v + INV] = 90;
  } else {
    setSt(s, v, ST_HIT);
    s[v + STUN] = hs;
    s[v + VX] = ph * dir;
  }
  s[v + STOP] = stop;
  if (!proj) {
    s[a + HITF] = 1;
    s[a + STOP] = stop;
  }
  ev(EV_HIT, s[v + X], kind, d, s[v + Z]);
}

function grabOk(s: Int32Array, a: number, v: number): boolean {
  if (s[a + ST] !== ST_GRAB || s[a + FRZ] || s[a + HITF]) return false;
  const t = s[a + T];
  if (t <= GRAB_AT || t > GRAB_AT + GRAB_WINDOW) return false;
  const vst = s[v + ST];
  if (s[v + Y] !== 0 || s[v + INV] > 0 || vst === ST_HIT || vst === ST_BLOCK || vst === ST_LAUNCH || vst === ST_HELD || vst === ST_DOWN || vst === ST_GETUP || vst === ST_THROW || vst === ST_DASHB || vst === ST_SIDE) return false;
  if (iabs(s[v + Z] - s[a + Z]) > 2400) return false;
  const d = (s[v + X] - s[a + X]) * s[a + FACE];
  return d >= 0 && d <= CH[s[a + CHAR]].grab;
}

function attacks(s: Int32Array, rig: RigCtx) {
  const h0 = strike(s, F0, F1, rig), h1 = strike(s, F1, F0, rig);
  // weapon clash: simultaneous active limbs grind against each other
  if (h0 && h1) {
    for (let k = 0; k < 2; k++) {
      const o = k ? F1 : F0;
      setSt(s, o, ST_BLOCK);
      s[o + STUN] = 10;
      s[o + VX] = -560 * s[o + FACE];
      s[o + VZ] = 0;
      s[o + STOP] = 8;
    }
    s[F0 + COMBO] = 0;
    s[F1 + COMBO] = 0;
    addMeter(s, F0, 45);
    addMeter(s, F1, 45);
    ev(EV_CLASH, (s[F0 + X] + s[F1 + X]) >> 1, 0, 0, (s[F0 + Z] + s[F1 + Z]) >> 1);
    return;
  }
  if (h0) applyHit(s, F0, F1, h0, s[F0 + FACE]);
  if (h1) applyHit(s, F1, F0, h1, s[F1 + FACE]);
  const g0 = grabOk(s, F0, F1), g1 = grabOk(s, F1, F0);
  if (g0 && g1) {
    for (let k = 0; k < 2; k++) {
      const o = k ? F1 : F0;
      setSt(s, o, ST_BLOCK);
      s[o + STUN] = 16;
      s[o + VX] = -500 * s[o + FACE];
    }
    ev(EV_BLOCK, (s[F0 + X] + s[F1 + X]) >> 1, 1, 0, (s[F0 + Z] + s[F1 + Z]) >> 1);
  } else if (g0 || g1) {
    const a = g0 ? F0 : F1, v = g0 ? F1 : F0;
    setSt(s, a, ST_THROW);
    s[a + HITF] = 1;
    setSt(s, v, ST_HELD);
    s[v + VX] = 0;
    s[v + VY] = 0;
    s[v + VZ] = 0;
    ev(EV_GRAB, s[v + X], 0, 0, s[v + Z]);
  }
}

function buildings(s: Int32Array) {
  const fr = s[G_FRAME];
  for (let i = 0; i < NB; i++) {
    const bo = B0 + i * B_N;
    if (s[bo + BHP] <= 0) {
      // unlimited city: a cleared lot is rebuilt once nobody is standing on it
      if (s[G_PHASE] === PH_FIGHT && s[bo + BDT] >= 0 && fr - s[bo + BDT] >= RESPAWN) {
        let clear = true;
        for (let k = 0; k < 2; k++) {
          const o = k ? F1 : F0;
          if (iabs(s[o + X] - s[bo + BX]) < s[bo + BW] + 4200 && iabs(s[o + Z] - s[bo + BZ]) < bDepth(s[bo + BW]) + 3200) clear = false;
        }
        if (clear) {
          genLot(s, i, false);
          s[G_REBUILT]++;
          ev(EV_REBUILD, i, s[bo + BX], s[bo + BH], s[bo + BZ]);
        }
      }
      continue;
    }
    const rising = s[bo + BFL] === 2 && fr - s[bo + BDT] < RISE;
    for (let k = 0; k < 2 && s[bo + BHP] > 0; k++) {
      const o = k ? F1 : F0, e = k ? F0 : F1;
      const bx = s[bo + BX], bw = s[bo + BW], bz = s[bo + BZ], bd = bDepth(bw);
      const st = s[o + ST], c = CH[s[o + CHAR]];
      const dx = iabs(s[o + X] - bx), dz = iabs(s[o + Z] - bz);
      if (dx < bw + 1900 && dz < bd + BODY_Z && s[o + Y] < s[bo + BH]) {
        if (st === ST_LAUNCH) {
          destroy(s, i, e, 0);
          s[o + HP] -= 15;
          s[o + CDMG] += 15;
          s[o + VX] = ((s[o + VX] * 3) / 4) | 0;
          ev(EV_CRASH, bx, s[o + Y], 0, bz);
          continue;
        } else if (s[o + Y] === 0 && st !== ST_DOWN && st !== ST_HELD && !s[o + FRZ] && !rising) {
          const moving = s[o + VX] !== 0 || s[o + VZ] !== 0;
          s[bo + BHP] -= st === ST_DASHF || st === ST_DASHB || st === ST_CHARGE || st === ST_SIDE ? 45 : st === ST_CARRY && moving ? 14 : moving ? 9 : 3;
          s[o + SLOW] = 1;
          if (s[bo + BHP] <= 0) {
            destroy(s, i, o, 0);
            continue;
          }
        }
      }
      if (s[o + FRZ]) continue;
      const rel = (bx - s[o + X]) * s[o + FACE], t = s[o + T];
      const m = moveOf(o, st, s[o + CHAR]);
      if (m && t > m.su + m.a0 && t <= m.su + m.a1 && rel > 0 && rel < m.reach + bw && dz < bd + m.zr) s[bo + BHP] -= m === c.light || m === c.light2 ? 50 : 90;
      else if (st === ST_BEAM || st === ST_SUPER) {
        const sup = st === ST_SUPER;
        const t0 = t - (sup ? SUPER_SU : c.beamSu);
        if (t0 > 0 && t0 <= (sup ? SUPER_AC : c.beamAc)) {
          const d = (s[e + X] - s[o + X]) * s[o + FACE];
          const reach = sup ? 30000 : c.beamReach;
          const lim = d > 1000 && d < reach && hittable(s, e) && !sup && iabs(s[e + Z] - s[o + AIMZ]) < BEAM_Z ? d : reach;
          if (rel > 2000 && rel < lim) {
            const zAt = s[o + Z] + (((s[o + AIMZ] - s[o + Z]) * rel) / lim | 0);
            if (iabs(bz - zAt) < bd + (sup ? 3000 : 1400) && (sup || s[bo + BH] > c.beamY - ((rel * c.beamSlope) / 100 | 0))) s[bo + BHP] -= sup ? 80 : 30;
          }
        }
      }
      if (s[bo + BHP] <= 0) destroy(s, i, o, 0);
    }
  }
}

function projectiles(s: Int32Array) {
  for (let i = 0; i < NP; i++) {
    const po = P0 + i * P_N;
    if (!s[po + PT]) continue;
    s[po + PVY] -= 16;
    s[po + PX] += s[po + PVX];
    s[po + PY] += s[po + PVY];
    s[po + PZ] += s[po + PVZ];
    if (s[po + PZ] > Z_MAX + 3000) s[po + PZ] = Z_MAX + 3000;
    else if (s[po + PZ] < Z_MIN - 3000) s[po + PZ] = Z_MIN - 3000;
    const a = s[po + POWN] ? F1 : F0, v = s[po + POWN] ? F0 : F1;
    const px = s[po + PX], py = s[po + PY], pz = s[po + PZ];
    const rx = 3200 + (s[po + PH] >> 3);
    if (iabs(px - s[v + X]) < rx && iabs(pz - s[v + Z]) < 3000 && py < s[v + Y] + CH[s[v + CHAR]].height && py > s[v + Y] - 1000 && hittable(s, v)) {
      applyHit(s, a, v, K_TOWER, s[po + PVX] >= 0 ? 1 : -1);
      ev(EV_CHUNK, px, py, s[po + PH], pz);
      s[po + PT] = 0;
    } else if (py <= 0 || px > STAGE + 6000 || px < -STAGE - 6000) {
      ev(EV_CHUNK, px, 0, s[po + PH], pz);
      for (let b = 0; b < NB; b++) {
        const bo = B0 + b * B_N;
        if (s[bo + BHP] > 0 && iabs(s[bo + BX] - px) < s[bo + BW] + 1500 && iabs(s[bo + BZ] - pz) < bDepth(s[bo + BW]) + 1800) destroy(s, b, a, 0);
      }
      s[po + PT] = 0;
    } else {
      // a hurled tower ploughs through anything standing in its flight path
      for (let b = 0; b < NB; b++) {
        const bo = B0 + b * B_N;
        if (s[bo + BHP] > 0 && py < s[bo + BH] && iabs(s[bo + BX] - px) < s[bo + BW] + 900 && iabs(s[bo + BZ] - pz) < bDepth(s[bo + BW]) + 900) {
          destroy(s, b, a, 0);
          ev(EV_CRASH, s[bo + BX], py, 0, s[bo + BZ]);
          s[po + PVX] = ((s[po + PVX] * 3) / 4) | 0;
        }
      }
    }
  }
}

function endRound(s: Int32Array, koby: number) {
  s[G_PHASE] = PH_KO;
  s[G_PT] = 0;
  s[G_KOBY] = koby;
  if (koby & 1) s[F0 + WINS]++;
  if (koby & 2) s[F1 + WINS]++;
}

/** the military opens fire on whichever monster has wrecked more of the city (unless roared off) */
function army(s: Int32Array) {
  if (++s[G_ARMY] < ARMY_EVERY) return;
  s[G_ARMY] = 0;
  const h0 = s[F0 + HAVOC], h1 = s[F1 + HAVOC];
  let tg = h0 > h1 ? 0 : h1 > h0 ? 1 : ((s[G_FRAME] / ARMY_EVERY) | 0) & 1;
  if (s[(tg ? F1 : F0) + FEAR] > 0) tg ^= 1;
  const o = tg ? F1 : F0;
  if (s[o + FEAR] > 0) {
    s[G_ARMT] = 0;
    return;
  }
  s[G_ARMT] = tg + 1;
  addMeter(s, o, 30); // getting shelled only makes it angrier
  if (s[o + HP] > 40) s[o + HP] -= 4; // shells sting but never decide a round
  ev(EV_ARMY, tg, s[o + X], s[o + Y] + ((CH[s[o + CHAR]].height * 6) / 10 | 0), s[o + Z]);
}

/** anti-turtle: if both players sit still the burning city stirs them up */
function gapCheck(s: Int32Array) {
  const st0 = s[F0 + ST], st1 = s[F1 + ST];
  const busy =
    s[F0 + ACT] || s[F1 + ACT] || st0 === ST_BEAM || st1 === ST_BEAM || s[G_FREEZE] > 0 ||
    s[P0 + PT] || s[P0 + P_N + PT] || s[P0 + 2 * P_N + PT] || s[P0 + 3 * P_N + PT] ||
    !(isNeutral(st0) || st0 === ST_BLOCK || st0 === ST_DASHF || st0 === ST_DASHB || st0 === ST_SIDE) ||
    !(isNeutral(st1) || st1 === ST_BLOCK || st1 === ST_DASHF || st1 === ST_DASHB || st1 === ST_SIDE);
  if (busy) {
    s[G_GAP] = 0;
    return;
  }
  s[G_GAP]++;
  if (s[G_GAP] > 260) {
    s[G_GAP] = 0;
    addMeter(s, F0, 90);
    addMeter(s, F1, 90);
    ev(EV_CLASH, (s[F0 + X] + s[F1 + X]) >> 1, 0, 0, (s[F0 + Z] + s[F1 + Z]) >> 1);
  }
}

// ------------------------------------------------------------------ step
export function step(s: Int32Array, in0: number, in1: number, rig: RigCtx): void {
  evN = 0;
  s[G_FRAME]++;
  const ph = s[G_PHASE];
  const pt = ++s[G_PT];
  if (ph === PH_INTRO) {
    in0 = in1 = 0;
    if (pt >= 110) {
      s[G_PHASE] = PH_FIGHT;
      s[G_PT] = 0;
      setSt(s, F0, ST_IDLE);
      setSt(s, F1, ST_IDLE);
      ev(EV_FIGHT);
    }
  } else if (ph === PH_FIGHT) {
    if (s[G_TIMER] > 0 && --s[G_TIMER] === 0) {
      const a = s[F0 + HP], b = s[F1 + HP];
      endRound(s, a > b ? 1 : b > a ? 2 : 3);
      ev(EV_TIMEUP);
      return;
    }
  } else if (ph === PH_KO) {
    in0 = in1 = 0;
    if (pt === 80) {
      const kb = s[G_KOBY];
      if (kb & 1 && s[F0 + HP] > 0 && s[F0 + Y] === 0) setSt(s, F0, ST_WIN);
      if (kb & 2 && s[F1 + HP] > 0 && s[F1 + Y] === 0) setSt(s, F1, ST_WIN);
    }
    if (pt >= 210) {
      const w0 = s[F0 + WINS] >= 2, w1 = s[F1 + WINS] >= 2;
      if (w0 || w1) {
        s[G_PHASE] = PH_END;
        s[G_PT] = 0;
        s[G_WINNER] = w0 && w1 ? 3 : w0 ? 1 : 2;
        ev(EV_END, s[G_WINNER]);
      } else {
        s[G_ROUND]++;
        resetRound(s);
      }
      return;
    }
    if (pt < 50 && s[G_FRAME] & 1) return; // dramatic K.O. slow motion (deterministic)
  } else {
    in0 = in1 = 0;
  }
  if (s[G_FREEZE] > 0) {
    s[G_FREEZE]--;
    s[F0 + PREV] = in0;
    s[F1 + PREV] = in1;
    return;
  }
  control(s, F0, F1, in0, rig);
  control(s, F1, F0, in1, rig);
  physics(s, F0, F1);
  physics(s, F1, F0);
  pushboxes(s);
  attacks(s, rig);
  buildings(s);
  projectiles(s);
  for (let k = 0; k < 2; k++) {
    const o = k ? F1 : F0;
    if (s[o + CBH] > 0 && !holdState(s[o + ST], s[o + T])) dropHeld(s, o);
  }
  if (s[G_PHASE] === PH_FIGHT) army(s);
  if (s[G_PHASE] === PH_FIGHT && (s[F0 + HP] <= 0 || s[F1 + HP] <= 0)) {
    const a = s[F0 + HP] > 0, b = s[F1 + HP] > 0;
    for (let k = 0; k < 2; k++) {
      const o = k ? F1 : F0;
      if (s[o + HP] <= 0) {
        s[o + HP] = 0;
        if (s[o + ST] !== ST_LAUNCH && s[o + ST] !== ST_DOWN) {
          setSt(s, o, ST_LAUNCH);
          s[o + VX] = -200 * s[o + FACE];
          s[o + VY] = 380;
        }
      }
    }
    endRound(s, a ? 1 : b ? 2 : 3);
    ev(EV_KO, a ? 0 : 1);
  } else if (s[G_PHASE] === PH_FIGHT) gapCheck(s);
}

// ------------------------------------------------------------------ CPU opponent (local play only; not part of synced state)
export interface CpuMem { rng: number; hold: number; holdT: number; think: number; seq: number[] }
export function newCpu(seed: number): CpuMem {
  return { rng: seed | 1, hold: 0, holdT: 0, think: 0, seq: [] };
}
export function cpuInput(s: Int32Array, me: number, m: CpuMem, level: number): number {
  const o = me ? F1 : F0, e = me ? F0 : F1;
  const r = () => {
    m.rng ^= m.rng << 13;
    m.rng ^= m.rng >>> 17;
    m.rng ^= m.rng << 5;
    return (m.rng >>> 0) % 100;
  };
  if (m.seq.length) return m.seq.shift()!;
  const face = s[e + X] >= s[o + X] ? 1 : -1;
  const fwd = face > 0 ? IN_R : IN_L, back = face > 0 ? IN_L : IN_R;
  const d = iabs(s[e + X] - s[o + X]);
  const dzs = s[e + Z] - s[o + Z], dz = iabs(dzs);
  const zb = dz > 1500 ? (dzs > 0 ? IN_U : IN_D) : 0;
  const c = CH[s[o + CHAR]], est = s[e + ST], st = s[o + ST], t = s[o + T];
  if (m.holdT > 0) {
    m.holdT--;
    return m.hold;
  }
  // carrying a tower: club the opponent when close and lined up, otherwise line up and hurl it
  if (st === ST_CARRY) {
    if (d < 9500 && dz < 2400 && r() < 30) return IN_A;
    if ((t > 24 && dz < 2600 && r() < 6 + level * 5) || t > 160) return IN_G;
    return (d > 13000 ? fwd : d < 7000 ? back : 0) | zb;
  }
  if (s[o + HITF] === 1) {
    if (st === ST_LIGHT && r() < 30 + level * 20) return r() < 62 ? IN_A : IN_B;
    if (st === ST_LIGHT2 && r() < 30 + level * 20) return r() < 66 ? IN_A : IN_B;
    if (st === ST_LIGHT3 && r() < 25 + level * 20) return s[o + METER] >= MAX_METER && r() < 50 ? IN_X : s[o + METER] >= BEAM_COST && r() < 50 ? IN_S : IN_U | IN_B;
    if (st === ST_LOW && s[o + METER] >= BEAM_COST && r() < 25 + level * 18) return IN_S;
    if (st === ST_LOW && r() < 35) return IN_D | IN_B;
    if ((st === ST_SWEEP || st === ST_CHARGE || st === ST_HEAVY) && s[o + METER] >= MAX_METER && r() < 25 + level * 20) return IN_X;
    if (st === ST_HEAVY && r() < 15 + level * 10) return IN_U | IN_B;
    if (st === ST_HEAVY && s[o + METER] >= BEAM_COST && r() < 10 + level * 22) return IN_S;
  }
  // pin a downed opponent with an OTG stomp
  if (est === ST_DOWN && s[e + OTG] === 0 && s[e + T] < 26 && d < c.low.reach - 2800 && dz < 2200 && isNeutral(st) && r() < 8 + level * 10) return IN_D | IN_A;
  if (est === ST_DOWN && s[e + OTG] === 0 && d < c.low.reach + 2500 && d > c.low.reach - 2800 && dz < 2200 && isNeutral(st) && r() < 25) return fwd;
  const threat = isAttack(est) && est !== ST_RIP && d < 16000;
  if (threat && isNeutral(st) && r() < 22 + level * 22) {
    // beams sweep across lanes slowly: hop out of the lane; melee: block
    if ((est === ST_BEAM || est === ST_SUPER) && r() < 25 + level * 15) {
      const dir = s[o + Z] > (Z_MIN + Z_MAX) >> 1 ? IN_D : IN_U;
      m.seq = [0, dir, 0, 0];
      return dir;
    }
    m.hold = back;
    m.holdT = 12;
    return back;
  }
  if (est === ST_GRAB && d < 7000 && r() < 30 * level) return IN_A;
  if (--m.think > 0) return m.hold & (IN_L | IN_R | IN_U | IN_D);
  m.think = 8 + (r() % (22 - level * 5));
  const k = r();
  let out = 0;
  if (dz > LANE + 300 && k < 75) out = zb | (d > c.light.reach + 3500 ? fwd : 0); // line up in depth first
  else if (s[o + METER] >= MAX_METER && d < 16000 && dz < 3000 && k < 30) out = IN_X;
  else if (s[o + METER] < 400 && d > 13000 && k < 12) out = IN_U | IN_G; // roar to build meter
  else if (d > 8000 && k < 30 && ripTarget(s, o) >= 0) out = IN_D | IN_G; // rip a tower to throw
  else if (d < c.light.reach + 1500) out = k < 34 ? IN_A : k < 46 ? IN_D | IN_A : k < 56 ? IN_G : k < 76 ? IN_B : k < 86 ? IN_D | IN_B : back;
  else if (d < c.sweep.reach + 1200) out = k < 30 ? IN_B : k < 42 ? IN_D | IN_B : k < 52 && s[o + METER] >= BEAM_COST ? IN_S : k < 76 ? IN_U | IN_B : fwd;
  else out = k < 14 && s[o + METER] >= BEAM_COST * 2 ? IN_S : fwd | zb;
  m.hold = out & (IN_L | IN_R | IN_U | IN_D);
  if (out & IN_G && out & (IN_D | IN_U)) {
    // press the direction first so it is held when the button lands
    const dir = out & (IN_D | IN_U);
    m.hold = dir;
    m.holdT = 1;
    return dir | IN_G;
  }
  if (out & BTN) m.hold &= ~(IN_U | IN_D);
  return out;
}
