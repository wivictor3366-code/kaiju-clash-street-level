// Single source of truth for "giant" timing. The keyframed art (art/*.ts) and the simulation
// frame data (sim.ts) are BOTH derived from this table, so a hitbox is still exactly the pixels drawn.
//
// Every move is authored in "original" 60 Hz frames. H is the frame where the strike pose begins
// (= startup + active delay). The wind-up part [0, H] is stretched by kw %, everything after the
// strike (impact, follow-through, recovery) by kf %. A 1.7 m human watching a 120 m monster needs
// time to *see* the anticipation, so wind-ups are ~2.4x slower than the arcade original, recoveries ~1.9x (giants need time to arrive and time to settle).
export interface Tm {
  H: number;
  kw: number;
  kf: number;
}

export const TM: Record<string, Tm> = {
  light: { H: 16, kw: 228, kf: 188 },
  light2: { H: 13, kw: 228, kf: 188 },
  light3: { H: 17, kw: 252, kf: 200 },
  heavy: { H: 28, kw: 240, kf: 188 },
  stomp: { H: 22, kw: 222, kf: 188 },
  sweep: { H: 24, kw: 228, kf: 188 },
  charge: { H: 16, kw: 222, kf: 188 },
  // new moves
  upper: { H: 17, kw: 228, kf: 188 },
  tslam: { H: 24, kw: 240, kf: 188 },
  quake: { H: 28, kw: 234, kf: 188 },
  // grabs / tower work
  grab: { H: 12, kw: 204, kf: 175 },
  throw: { H: 40, kw: 180, kf: 175 },
  rip: { H: 18, kw: 228, kf: 200 },
  hurl: { H: 14, kw: 204, kf: 162 },
  bslam: { H: 18, kw: 228, kf: 175 },
  roar: { H: 34, kw: 156, kf: 144 },
  // beam charge (the whole anim is wind-up)
  beamA: { H: 40, kw: 168, kf: 125 },
};

/** wind-up scale of a sim duration authored in original frames */
export const tw = (k: string, u: number): number => Math.round((u * TM[k].kw) / 100);
/** follow-through scale */
export const tf = (k: string, u: number): number => Math.round((u * TM[k].kf) / 100);

/** baked-frame step of an anim after retiming (original step if it was already coarse) */
export const stepOf = (name: string, orig: number): number => (TM[name] ? Math.max(orig, 4) : orig);
export const BEAM_VARIANTS = 3; // low / mid / high beam pitch
export const BV = 4; // baked frames per beam pitch variant

export interface TimedAnim<P> {
  n: number;
  step: number;
  fn: (t: number) => P;
  flip?: (t: number) => boolean;
}

/** time-warp an animation: wind-up stretched by kw, the rest by kf. Poses are unchanged. */
export function retime<P>(an: TimedAnim<P>, tm: Tm): TimedAnim<P> {
  const kw = tm.kw / 100, kf = tm.kf / 100, H = tm.H;
  const L = (an.n - 1) * an.step;
  const L2 = L <= H ? L * kw : H * kw + (L - H) * kf;
  const step = Math.max(an.step, 4);
  const n = Math.ceil(L2 / step) + 1;
  const inv = (t: number) => (t <= H * kw ? t / kw : H + (t - H * kw) / kf);
  const flip = an.flip;
  return { n, step, fn: (t) => an.fn(inv(t)), flip: flip ? (t) => flip(inv(t)) : undefined };
}
