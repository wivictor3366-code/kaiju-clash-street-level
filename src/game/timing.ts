// Single source of truth for "giant" timing. The keyframed art (art/*.ts) and the simulation
// frame data (sim.ts) are BOTH derived from this table, so a hitbox is still exactly the pixels drawn.
//
// Every move is authored in "original" 60 Hz frames. H is the frame where the strike pose begins
// (= startup + active delay). The wind-up part [0, H] is stretched by kw %, everything after the
// strike (impact, follow-through, recovery) by kf %. A 1.7 m human watching a 120 m monster needs
// time to *see* the anticipation, so wind-ups are ~2x slower than the arcade original.
export interface Tm {
  H: number;
  kw: number;
  kf: number;
}

export const TM: Record<string, Tm> = {
  light: { H: 16, kw: 190, kf: 150 },
  light2: { H: 13, kw: 190, kf: 150 },
  light3: { H: 17, kw: 210, kf: 160 },
  heavy: { H: 28, kw: 200, kf: 150 },
  stomp: { H: 22, kw: 185, kf: 150 },
  sweep: { H: 24, kw: 190, kf: 150 },
  charge: { H: 16, kw: 185, kf: 150 },
  // new moves
  upper: { H: 17, kw: 190, kf: 150 },
  tslam: { H: 24, kw: 200, kf: 150 },
  quake: { H: 28, kw: 195, kf: 150 },
  // grabs / tower work
  grab: { H: 12, kw: 170, kf: 140 },
  throw: { H: 40, kw: 150, kf: 140 },
  rip: { H: 18, kw: 190, kf: 160 },
  hurl: { H: 14, kw: 170, kf: 130 },
  bslam: { H: 18, kw: 190, kf: 140 },
  roar: { H: 34, kw: 130, kf: 115 },
  // beam charge (the whole anim is wind-up)
  beamA: { H: 40, kw: 140, kf: 100 },
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
