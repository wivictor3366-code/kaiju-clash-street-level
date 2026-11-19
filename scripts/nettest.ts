// Headless verification:
//  1. every strike connects exactly where the drawn limb volume is (visual hitboxes)
//  2. two Sessions exchanging packets over a lossy/jittery link stay bit-identical (rollback)
import { Session } from "../src/game/net";
import { bakeAtlas } from "../src/game/art/atlas";
import { animFrame } from "../src/game/anim";
import type { Frame } from "../src/game/art/atlas";
import * as S from "../src/game/sim";

const { } = S;
let atlas: Awaited<ReturnType<typeof bakeAtlas>>;
const rigFor = (get: () => Int32Array) => ({ fr: (o: number) => animFrame(get(), o, atlas.chars) });

/** put both fighters in a neutral, fighting state at a given distance */
function setup(dist: number, c0: number, c1: number) {
  const s = new Int32Array(S.STATE_SIZE);
  S.initState(s, 424242, c0, c1);
  s[S.G_PHASE] = S.PH_FIGHT;
  s[S.G_PT] = 0;
  s[S.F0 + S.ST] = S.ST_IDLE;
  s[S.F1 + S.ST] = S.ST_IDLE;
  s[S.F0 + S.T] = 0;
  s[S.F1 + S.T] = 0;
  s[S.F0 + S.X] = -dist >> 1;
  s[S.F1 + S.X] = dist >> 1;
  s[S.F0 + S.FACE] = 1;
  s[S.F1 + S.FACE] = -1;
  s[S.F0 + S.PREV] = 0;
  s[S.F1 + S.PREV] = 0;
  // clear the spawn lane so buildings do not interfere with the measurement
  for (let i = 0; i < S.NB; i++) s[S.B0 + i * S.B_N + S.BHP] = 0;
  return s;
}

function connects(move: number, dist: number, c0: number, c1: number): boolean {
  const s = setup(dist, c0, c1);
  const rig = rigFor(() => s);
  const hp0 = s[S.F1 + S.HP];
  for (let f = 0; f < 80; f++) {
    const buf = f === 0 ? move : 0;
    S.step(s, buf, 0, rig);
    if (s[S.F1 + S.HP] < hp0) return true;
  }
  return false;
}

function maxRange(move: number, c: number) {
  let lo = 0, hi = 30000;
  while (hi - lo > 50) {
    const mid = (lo + hi) >> 1;
    if (connects(move, mid, c, 1 - c)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function run(latency: number, jitter: number, loss: number, delay: number) {
  let clock = 0;
  const now = () => clock;
  type Pkt = { at: number; to: number; buf: ArrayBuffer };
  let q: Pkt[] = [];
  let rs = 12345;
  const rand = () => ((rs = (Math.imul(rs, 1103515245) + 12345) | 0) >>> 0) / 4294967296;
  const mk = (me: number) =>
    new Session(
      me, 777, 0, 1, delay,
      (b) => {
        if (rand() < loss) return;
        q.push({ at: clock + latency + rand() * jitter, to: 1 - me, buf: b });
      },
      () => {},
      { fr: (o) => animFrame(me === 0 ? A.s : B.s, o, atlas.chars) },
      now,
    );
  let A: Session, B: Session;
  A = mk(0);
  B = mk(1);
  const cpuA = S.newCpu(99), cpuB = S.newCpu(4242);
  const inA: number[] = [], inB: number[] = [];
  for (let i = 0; i < 60 * 200; i++) {
    clock += 1000 / 60;
    const due = q.filter((p) => p.at <= clock);
    q = q.filter((p) => p.at > clock);
    for (const p of due) (p.to === 0 ? A : B).onPacket(p.buf);
    const ia = S.cpuInput(A.s, 0, cpuA, 2), ib = S.cpuInput(B.s, 1, cpuB, 2);
    const fa = A.frame, fb = B.frame;
    if (A.tick(ia)) inA[fa + delay] = ia;
    if (i >= 3) {
      if (B.tick(ib)) inB[fb + delay] = ib;
    }
    if (A.s[S.G_PHASE] === S.PH_END && B.s[S.G_PHASE] === S.PH_END) break;
  }
  for (let i = 0; i < 150; i++) {
    clock += 1000 / 60;
    const due = q.filter((p) => p.at <= clock);
    q = q.filter((p) => p.at > clock);
    for (const p of due) (p.to === 0 ? A : B).onPacket(p.buf);
    A.tick(0);
    B.tick(0);
  }
  const n = Math.min(A.frame, B.frame, A.remoteLast + 1, B.remoteLast + 1);
  const ref = new Int32Array(S.STATE_SIZE);
  S.initState(ref, 777, 0, 1);
  for (let f = 0; f < n; f++) S.step(ref, inA[f] || 0, inB[f] || 0, { fr: (o) => animFrame(ref, o, atlas.chars) });
  // compare the peers' stored snapshot *at frame n* with an offline replay of the confirmed inputs
  const snapA = A.snapshotAt(n), snapB = B.snapshotAt(n);
  const cs = S.checksum(ref);
  const where: number[] = [];
  if (snapA && snapB) for (let i = 0; i < S.STATE_SIZE; i++) if (snapA[i] !== ref[i] || snapB[i] !== ref[i]) where.push(i);
  console.log(
    `net lat=${latency}ms jit=${jitter} loss=${(loss * 100) | 0}% delay=${delay} | A=${A.frame}f B=${B.frame}f n=${n}f` +
      ` | rtt~${A.stats.rtt.toFixed(0)}ms rbPeak A=${A.stats.rbPeak} B=${B.stats.rbPeak} | desync=${A.stats.desync || B.stats.desync}` +
      ` | snapshots=${snapA && snapB ? "ok" : "missing"} diffFields=${where.length} [${where.slice(0, 10).join(",")}] A/B=${where.slice(0, 5).map((i) => (snapA ? snapA[i] : -1) + ":" + (snapB ? snapB[i] : -1) + ":" + ref[i]).join(" ")}` +
      ` | havoc=${ref[S.G_HAVOC]} round=${ref[S.G_ROUND]} hp=${ref[S.F0 + S.HP]}/${ref[S.F1 + S.HP]} phase=${ref[S.G_PHASE]} cs=${cs.toString(16)}`,
  );
}

(async () => {
  atlas = await bakeAtlas();
  console.log("frames baked:", Object.values(atlas.chars[0]).reduce((a, f) => a + (f as Frame[]).length, 0) * 2);
  const moves: [string, number][] = [["light", S.IN_A], ["low", S.IN_D | S.IN_A], ["heavy", S.IN_B], ["sweep", S.IN_D | S.IN_B], ["charge", S.IN_U | S.IN_B]];
  for (let c = 0; c < 2; c++) {
    const parts = moves.map(([n, b]) => `${n}=${maxRange(b, c)}`);
    console.log(`reach(cm) ${S.CH[c].name}: ${parts.join(" ")}`);
  }
  console.log("light connects at 4.5m:", connects(S.IN_A, 4500, 0, 1), "| light at 14m:", connects(S.IN_A, 14000, 0, 1));
  run(0, 0, 0, 0);
  run(40, 10, 0.02, 2);
  run(90, 30, 0.1, 2);
  run(150, 60, 0.2, 3);
})();
