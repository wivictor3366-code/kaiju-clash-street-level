// HUD vocabulary: pixel icons, keycap labels and the step-by-step "coach".
// The HUD used to explain the game with sentences; it now shows ONE thing at a time, as an icon + keycap,
// waits until the player has actually done it, then moves on. Nothing here touches the simulation.
import * as S from "./sim";

// ------------------------------------------------------------------ icons (9 x 9, '#' = lit pixel)
const RAW: Record<string, string[]> = {
  tower: ["..#####..", "..#.#.#..", "..#####..", "..#.#.#..", "..#####..", "..#.#.#..", "..#####..", "..#.#.#..", ".#######."],
  target: ["...###...", ".##...##.", ".#..#..#.", "#..###..#", "#.#####.#", "#..###..#", ".#..#..#.", ".##...##.", "...###..."],
  bolt: ["....###..", "...###...", "..###....", ".######..", "...###...", "..###....", "..##.....", ".##......", ".#......."],
  flame: ["....#....", "...##....", "...###...", "..#####..", ".##.###..", ".######.#", ".#######.", ".#######.", "..#####.."],
  shield: ["#########", "#########", "#########", "#########", ".#######.", ".#######.", "..#####..", "...###...", "....#...."],
  plus: ["...###...", "...###...", "...###...", "#########", "#########", "#########", "...###...", "...###...", "...###..."],
  claw: [".#...#...", ".##..##..", "..##..##.", "..##..##.", "...##..##", "...##..##", "....##..#", "....##...", ".....#..."],
  tail: ["..#####..", ".##...##.", ".#.....#.", ".#.....#.", ".#.......", ".##......", "..##.....", "...###...", ".....###."],
  check: [".........", "........#", ".......##", "#.....##.", "##...##..", ".##.##...", "..###....", "...#.....", "........."],
  skull: ["##.....##", ".##...##.", "..##.##..", "...###...", "....#....", "...###...", "..##.##..", ".##...##.", "##.....##"],
  human: ["...###...", "...###...", "....#....", "..#####..", ".#.###.#.", "...###...", "...#.#...", "..##.##..", "..#...#.."],
  bomb: ["......##.", ".....#...", "....#....", "..####...", ".######..", "#######..", "#######..", ".######..", "..####..."],
  star: ["....#....", "....#....", "...###...", "#########", ".#######.", "..#####..", "..##.##..", ".##...##.", ".#.....#."],
  roar: ["#...#...#", ".#...#...", "..#..#.#.", ".#..###.#", "#..#####.", ".#..###.#", "..#..#.#.", ".#...#...", "#...#...#"],
  fist: [".##.##.##", ".#######.", ".#######.", ".#######.", ".#######.", "..######.", "..#####..", "...###...", "...###..."],
  beam: [".........", ".##......", ".####....", ".#######.", ".########", ".#######.", ".####....", ".##......", "........."],
  hammer: [".#######.", ".#######.", ".#######.", ".#######.", "....#....", "....#....", "....#....", "....#....", "....#...."],
  street: ["....#....", "...###...", "..#####..", "....#....", "....#....", "....#....", "..#####..", "...###...", "....#...."],
  arrowR: ["....#....", "....##...", "#######..", "########.", "#########", "########.", "#######..", "....##...", "....#...."],
  clock: ["..#####..", ".#..#..#.", "#...#...#", "#...#...#", "#...###.#", "#.......#", "#.......#", ".#.....#.", "..#####.."],
};
const flipH = (a: string[]) => a.map((r) => [...r].reverse().join(""));
const transpose = (a: string[]) => a[0].split("").map((_, x) => a.map((r) => r[x]).join(""));
RAW.arrowL = flipH(RAW.arrowR);
RAW.arrowD = transpose(RAW.arrowR);
RAW.arrowU = [...transpose(RAW.arrowR)].reverse();
export const ICONS = RAW;

export type RectFn = (x: number, y: number, w: number, h: number, r: number, g: number, b: number) => void;

/** draw an icon (top-left x,y; sc = pixel scale) with a 1px drop shadow so it reads on any background */
export function drawIcon(rect: RectFn, name: string, x: number, y: number, sc: number, r: number, g: number, b: number, shadow = true) {
  const bm = ICONS[name];
  if (!bm) return;
  for (let pass = shadow ? 0 : 1; pass < 2; pass++) {
    const off = pass ? 0 : Math.max(1, sc >> 1);
    for (let j = 0; j < bm.length; j++) {
      const row = bm[j];
      let i = 0;
      while (i < row.length) {
        if (row[i] !== "#") { i++; continue; }
        let k = i;
        while (k < row.length && row[k] === "#") k++;
        if (pass) rect(x + i * sc, y + j * sc, (k - i) * sc, sc, r, g, b);
        else rect(x + i * sc + off, y + j * sc + off, (k - i) * sc, sc, 0.02, 0.02, 0.05);
        i = k;
      }
    }
  }
}

// ------------------------------------------------------------------ key labels
// "@L" "@R" "@U" "@D" are drawn as arrow icons inside the keycap
export interface KeySet { l: string; r: string; u: string; d: string; light: string; heavy: string; beam: string; grab: string }
export const KEYS_SOLO: KeySet = { l: "A", r: "D", u: "W", d: "S", light: "J", heavy: "K", beam: "L", grab: "U" };
export const KEYS_P1: KeySet = { l: "A", r: "D", u: "W", d: "S", light: "F", heavy: "G", beam: "H", grab: "R" };
export const KEYS_P2: KeySet = { l: "@L", r: "@R", u: "@U", d: "@D", light: "J", heavy: "K", beam: "L", grab: "U" };

// ------------------------------------------------------------------ coach
interface Track {
  x: number | null; dist: number; z: number | null; dz: number;
  light: number; heavy: number; side: number; rip: number; beam: number;
  prevSt: number; ripNear: boolean; beamOk: boolean;
}
export interface Step {
  id: string;
  icon: string;
  /** keycap sequence: tokens; "+" = chord, "/" = alternatives (shown alternating) */
  keys: (k: KeySet) => string[];
  need: number;
  prog: (t: Track) => number;
  /** the card only appears once this is true (e.g. a tower is within reach) */
  ready?: (t: Track) => boolean;
  color: [number, number, number];
}
const STEPS: Step[] = [
  { id: "move", icon: "arrowR", keys: (k) => [k.l, "/", k.r], need: 7000, prog: (t) => t.dist, color: [0.55, 0.85, 1] },
  { id: "claw", icon: "claw", keys: (k) => [k.light], need: 3, prog: (t) => t.light, color: [1, 0.8, 0.35] },
  { id: "tail", icon: "tail", keys: (k) => [k.heavy], need: 2, prog: (t) => t.heavy, color: [1, 0.55, 0.3] },
  { id: "street", icon: "street", keys: (k) => [k.u, "/", k.d], need: 4500, prog: (t) => t.dz + t.side * 4500, color: [0.6, 1, 0.6] },
  { id: "rip", icon: "tower", keys: (k) => [k.d, "+", k.grab], need: 1, prog: (t) => t.rip, ready: (t) => t.ripNear, color: [1, 0.85, 0.35] },
  { id: "beam", icon: "beam", keys: (k) => [k.beam], need: 1, prog: (t) => t.beam, ready: (t) => t.beamOk, color: [0.45, 0.9, 1] },
];
export const COACH_STEPS = STEPS.length;
const STORE = "kaiju-coach-v2";

export interface CoachView { idx: number; total: number; step: Step; p: number; age: number; done: number }

const blankTrack = (): Track => ({ x: null, dist: 0, z: null, dz: 0, light: 0, heavy: 0, side: 0, rip: 0, beam: 0, prevSt: -1, ripNear: false, beamOk: false });

export class Coach {
  idx = 0;
  private tr: Track = blankTrack();
  private age = 0;
  private doneT = 0; // >0 while the check-mark plays
  private cool = 90; // quiet frames before the next card slides in
  private lastFrame = -1;

  constructor() {
    try {
      const v = parseInt(localStorage.getItem(STORE) || "0", 10);
      if (v > 0) this.idx = Math.min(STEPS.length, v);
    } catch { /* storage unavailable */ }
  }
  /** start the guided intro again (menu "HOW TO PLAY" button) */
  reset() {
    this.idx = 0;
    this.age = 0;
    this.doneT = 0;
    this.cool = 90;
    this.tr = blankTrack();
    try { localStorage.setItem(STORE, "0"); } catch { /* ignore */ }
  }
  get finished() { return this.idx >= STEPS.length; }

  /** call once per rendered frame with the coached fighter's offset */
  update(s: Int32Array, o: number) {
    const fr = s[S.G_FRAME];
    if (fr === this.lastFrame) return; // paused / duplicate render
    this.lastFrame = fr;
    if (this.finished || s[S.G_PHASE] !== S.PH_FIGHT) return;
    const t = this.tr, st = s[o + S.ST], x = s[o + S.X], z = s[o + S.Z];
    if (t.x !== null) t.dist += Math.abs(x - t.x);
    if (t.z !== null) t.dz += Math.abs(z - t.z);
    t.x = x;
    t.z = z;
    if (st !== t.prevSt) {
      if (st === S.ST_LIGHT) t.light++;
      else if (st === S.ST_HEAVY || st === S.ST_SWEEP || st === S.ST_CHARGE || st === S.ST_TSLAM) t.heavy++;
      else if (st === S.ST_SIDE) t.side++;
      else if (st === S.ST_RIP) t.rip++;
      else if (st === S.ST_BEAM || st === S.ST_SUPER) t.beam++;
      t.prevSt = st;
    }
    t.ripNear = S.isNeutral(st) && S.ripTarget(s, o) >= 0;
    t.beamOk = s[o + S.METER] >= S.BEAM_COST;
    this.age++;
    if (this.cool > 0) { this.cool--; return; }
    const step = STEPS[this.idx];
    if (this.doneT > 0) {
      if (--this.doneT === 0) this.advance();
      return;
    }
    if (step.prog(t) >= step.need) this.doneT = 55;
  }
  private advance() {
    this.idx++;
    this.age = 0;
    this.cool = 80;
    const t = this.tr;
    t.dist = t.dz = 0;
    t.light = t.heavy = t.side = t.rip = t.beam = 0;
    try { localStorage.setItem(STORE, String(this.idx)); } catch { /* ignore */ }
  }
  /** null while nothing should be on screen */
  view(): CoachView | null {
    if (this.finished || this.cool > 0) return null;
    const step = STEPS[this.idx], t = this.tr;
    if (step.ready && !step.ready(t) && this.doneT === 0) return null;
    return { idx: this.idx, total: STEPS.length, step, p: Math.min(1, step.prog(t) / step.need), age: this.age, done: this.doneT };
  }
}
