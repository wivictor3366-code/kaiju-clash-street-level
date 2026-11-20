// Pure (GL-free) state -> baked-frame mapping, shared by the renderer and the
// headless netcode test so the hitboxes tested are exactly the pixels drawn.
import type { AnimName } from "./art/raster";
import type { Frame } from "./art/atlas";
import * as S from "./sim";

export type FrameTable = Record<AnimName, Frame[]>;

const pick = (a: Frame[], i: number): Frame => a[i < 0 ? 0 : i >= a.length ? a.length - 1 : i];
const cyc = (a: Frame[], i: number): Frame => a[((i % a.length) + a.length) % a.length];

export function animFrame(s: Int32Array, o: number, chars: FrameTable[]): Frame {
  const A = chars[s[o + S.CHAR]], st = s[o + S.ST], t = s[o + S.T], c = S.CH[s[o + S.CHAR]];
  switch (st) {
    case S.ST_WALKF: return cyc(A.walk, (t / 8) | 0);
    case S.ST_WALKB: return cyc(A.walk, 7 - ((t / 8) | 0));
    case S.ST_DASHF: return pick(A.dash, (t / 9) | 0);
    case S.ST_DASHB: return pick(A.bdash, (t / 9) | 0);
    case S.ST_BLOCK: return pick(A.block, t < 7 ? 0 : 1);
    case S.ST_LIGHT: return pick(A.light, (t / 3) | 0);
    case S.ST_HEAVY: return pick(A.heavy, (t / 4) | 0);
    case S.ST_LOW: return pick(A.stomp, (t / 4) | 0);
    case S.ST_SWEEP: return pick(A.sweep, (t / 4) | 0);
    case S.ST_CHARGE: return pick(A.charge, (t / 4) | 0);
    case S.ST_BEAM:
      if (t <= c.beamSu) return pick(A.beamA, ((t * 5) / c.beamSu) | 0);
      if (t <= c.beamSu + c.beamAc) return pick(A.beamB, ((t - c.beamSu) / 11) | 0);
      return pick(A.beamC, ((t - c.beamSu - c.beamAc) / 10) | 0);
    case S.ST_SUPER:
      if (t === 0) return pick(A.beamA, ((S.SUPER_FREEZE - s[S.G_FREEZE]) / 8) | 0);
      if (t <= S.SUPER_SU) return A.beamA[A.beamA.length - 1];
      if (t <= S.SUPER_SU + S.SUPER_AC) return pick(A.beamB, ((t - S.SUPER_SU) / 12) | 0);
      return pick(A.beamC, ((t - S.SUPER_SU - S.SUPER_AC) / 10) | 0);
    case S.ST_GRAB: return pick(A.grab, (t / 7) | 0);
    case S.ST_THROW: return pick(A.throw, (t / 6) | 0);
    case S.ST_ENV: return t < S.ENV_REL ? pick(A.rip, (t / 6) | 0) : pick(A.hurl, ((t - S.ENV_REL) / 5) | 0);
    case S.ST_UPPER: return pick(A.upper, (t / 4) | 0);
    case S.ST_TAIL: return pick(A.sweep, (t / 4) | 0);
    case S.ST_STOMP: return pick(A.stomp, (t / 4) | 0);
    case S.ST_ROAR: return pick(A.roar, (t / 8) | 0);
    case S.ST_HIT: return pick(A.hit, t < 8 ? 0 : 1);
    case S.ST_LAUNCH: return pick(A.launch, s[o + S.VY] > 0 ? 0 : 1);
    case S.ST_HELD: return pick(A.launch, 0);
    case S.ST_DOWN: return pick(A.down, 0);
    case S.ST_GETUP: return pick(A.getup, (t / 8) | 0);
    case S.ST_WIN: {
      const f = (t / 10) | 0;
      return pick(A.win, f < A.win.length ? f : 2 + ((f - 2) % Math.max(1, A.win.length - 2)));
    }
  }
  return cyc(A.idle, (t / 12) | 0);
}

export const makeRig = (getState: () => Int32Array, chars: FrameTable[]) => ({
  fr: (o: number) => animFrame(getState(), o, chars),
});
