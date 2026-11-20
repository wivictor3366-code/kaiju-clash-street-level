// Headless sanity run for the slow-motion rework: bakes the atlas, checks each move connects,
// beam rays leave the mouth, CPU-vs-CPU matches are deterministic and objectives / powers / human work.
import { bakeAtlas } from "../src/game/art/atlas";
import { animFrame } from "../src/game/anim";
import * as S from "../src/game/sim";

async function main() {
  const t0 = Date.now();
  const atlas = await bakeAtlas();
  console.log("baked in", Date.now() - t0, "ms; frames/char:", Object.values(atlas.chars[0]).reduce((a, f) => a + f.length, 0), "pages:", atlas.pages.length);
  let cur: Int32Array;
  const rig = { fr: (o: number) => animFrame(cur, o, atlas.chars) };

  // 1) every move connects at close range (both characters)
  const moves: [string, number, number][] = [
    ["LIGHT", S.IN_A, 0], ["LIGHT2 (chain)", S.IN_A, 0], ["HEAVY", S.IN_B, 0], ["LOW", S.IN_A | S.IN_D, 0], ["SWEEP", S.IN_B | S.IN_D, 0],
    ["CHARGE", S.IN_B | S.IN_U, 0], ["UPPER", S.IN_A | S.IN_U, 0], ["SIGNATURE 1", S.IN_Z, 0], ["SIGNATURE 2", S.IN_W, 0],
  ];
  for (let ch = 0; ch < 2; ch++) {
    for (const [name, btn, dist] of moves) {
      const s = new Int32Array(S.STATE_SIZE);
      S.initState(s, 99, ch, 1 - ch);
      s[S.G_PHASE] = S.PH_FIGHT;
      for (let i = 0; i < S.NB; i++) s[S.B0 + i * S.B_N + S.BHP] = 0;
      for (const o of [S.F0, S.F1]) { s[o + S.ST] = S.ST_IDLE; s[o + S.T] = 0; }
      const d = 7500 + dist;
      s[S.F0 + S.X] = -d >> 1; s[S.F1 + S.X] = d >> 1; s[S.F0 + S.FACE] = 1; s[S.F1 + S.FACE] = -1;
      cur = s;
      let hitAt = -1;
      const hp = s[S.F1 + S.HP];
      for (let f = 0; f < 200; f++) {
        S.step(s, f === 0 ? btn : f === 1 ? btn : 0, 0, rig);
        if (s[S.F1 + S.HP] < hp && hitAt < 0) hitAt = f;
      }
      console.log(S.CH[ch].name.padEnd(14), name.padEnd(15), "first hit at frame", hitAt, "(total", S.moveOf(S.F0, s[S.F0 + S.ST], ch)?.total ?? "-", ")");
    }
  }
  // long-string chain (both kaiju): LIGHT > LIGHT2 > RAKE > LIGHT3 > CYCLONE > SIG1 > SIG3, each cancelled on hit
  for (let ch = 0; ch < 2; ch++) {
    const s = new Int32Array(S.STATE_SIZE);
    S.initState(s, 5, ch, 1 - ch);
    s[S.G_PHASE] = S.PH_FIGHT;
    for (let i = 0; i < S.NB; i++) s[S.B0 + i * S.B_N + S.BHP] = 0;
    for (const o of [S.F0, S.F1]) { s[o + S.ST] = S.ST_IDLE; s[o + S.T] = 0; }
    s[S.F0 + S.X] = -3750; s[S.F1 + S.X] = 3750; s[S.F0 + S.FACE] = 1; s[S.F1 + S.FACE] = -1;
    cur = s;
    const script = [S.ST_LIGHT, S.ST_LIGHT2, S.ST_RAKE, S.ST_LIGHT3, S.ST_SPIN, S.ST_SIG1, S.ST_SIG3];
    const btn: Record<number, number> = { [S.ST_LIGHT]: S.IN_A, [S.ST_LIGHT2]: S.IN_A, [S.ST_RAKE]: S.IN_A, [S.ST_LIGHT3]: S.IN_A, [S.ST_SPIN]: S.IN_B, [S.ST_SIG1]: S.IN_Z, [S.ST_SIG2]: S.IN_W, [S.ST_SIG3]: S.IN_Z };
    let idx = 0, log = "", lastAt = 0;
    for (let f = 0; f < 1800 && idx < script.length; f++) {
      let inp = 0;
      const st = s[S.F0 + S.ST];
      if (idx === 0 && f === 0) inp = btn[script[0]];
      else if (idx > 0 && st === script[idx - 1] && (s[S.F0 + S.HITF] === 1 || s[S.F0 + S.HITF] === 3)) inp = f & 1 ? btn[script[idx]] : 0; // tap, tap, tap
      // keep the foe on his feet so the string is testable (the juggle itself is covered by the launch logic)
      if (s[S.F1 + S.ST] === S.ST_DOWN) { s[S.F1 + S.ST] = S.ST_IDLE; s[S.F1 + S.Y] = 0; }
      S.step(s, inp, 0, rig);
      if (s[S.F0 + S.ST] === script[idx]) { log += S.moveOf(S.F0, script[idx], ch)!.nm + "@" + f + " "; lastAt = f; idx++; }
    }
    console.log(S.CH[ch].name.padEnd(14), "string reached", idx + "/" + script.length, "|", log, "| combo hits:", s[S.F1 + S.COMBO], "dmg:", s[S.F1 + S.CDMG], "last@", lastAt);
  }
  // timer: 495 s
  { const s = new Int32Array(S.STATE_SIZE); S.initState(s, 1, 0, 1); console.log("round timer:", s[S.G_TIMER] / 60, "s"); }

  // 2) beam: ray leaves the mouth, pitch variants change the head axis and where the ray lands
  for (let ch = 0; ch < 2; ch++) for (let pitch = 0; pitch < 3; pitch++) {
    const s = new Int32Array(S.STATE_SIZE);
    S.initState(s, 7, ch, 1 - ch);
    s[S.G_PHASE] = S.PH_FIGHT;
    for (let i = 0; i < S.NB; i++) s[S.B0 + i * S.B_N + S.BHP] = 0;
    for (const o of [S.F0, S.F1]) { s[o + S.ST] = S.ST_IDLE; s[o + S.T] = 0; }
    s[S.F0 + S.X] = -5000; s[S.F1 + S.X] = 5000; s[S.F0 + S.METER] = 1000; cur = s;
    let hit = -1, snap = "";
    for (let f = 0; f < 200; f++) {
      const inp = f === 0 ? S.IN_S : f > S.CH[ch].beamSu ? (pitch === 0 ? S.IN_D : pitch === 2 ? S.IN_U : 0) : 0;
      const hp = s[S.F1 + S.HP];
      S.step(s, inp, 0, rig);
      if (s[S.F1 + S.HP] < hp && hit < 0) hit = f;
      if (f === S.CH[ch].beamSu + 40) {
        const fr = animFrame(s, S.F0, atlas.chars);
        snap = `AIMP=${s[S.F0 + S.AIMP]} mouth(px)=${fr.mouths.slice(0, 2).map((v) => v.toFixed(0)).join(",")} slope/1000=${fr.mslope.join(",")}`;
      }
    }
    console.log(S.CH[ch].name.padEnd(14), "pitch", pitch, "startup", S.CH[ch].beamSu, "first hit", hit, snap, "foeHP", s[S.F1 + S.HP]);
  }

  // 2b) spotter: plant a charge, run, the tower is flattened and credited; standing still gets the human killed
  for (const stay of [false, true]) {
    const s = new Int32Array(S.STATE_SIZE);
    S.initState(s, 3, 0, 1);
    s[S.G_PHASE] = S.PH_FIGHT; cur = s;
    s[S.F0 + S.X] = -20000; s[S.F1 + S.X] = 20000;
    const bi = 3, bo = S.B0 + bi * S.B_N;
    s[S.F0 + S.HMX] = s[bo + S.BX] - s[bo + S.BW] - 800; s[S.F0 + S.HMZ] = s[bo + S.BZ];
    const hav = s[S.F0 + S.HAVOC];
    let blast = false, dead = false;
    for (let f = 0; f < 400; f++) {
      let inp = S.IN_Y;
      if (f === 2) inp |= S.IN_A;
      else if (f > 46 && !stay) inp |= S.IN_L;
      S.step(s, inp, 0, rig);
      for (let i = 0; i < S.evN; i++) { if (S.EV[i * S.EVS] === S.EV_BLAST) blast = true; if (S.EV[i * S.EVS] === S.EV_HUMAN) dead = true; }
    }
    console.log("spotter", stay ? "stayed put" : "ran away", "-> blast", blast, "tower hp", s[bo + S.BHP], "human died", dead, "credited wrecks", s[S.F0 + S.HAVOC] - hav);
  }

  // 3) CPU vs CPU: deterministic + objectives/powers
  const run = (seed: number) => {
    const s = new Int32Array(S.STATE_SIZE);
    S.initState(s, seed, 0, 1);
    cur = s;
    const cpu = [S.newCpu(11), S.newCpu(22)];
    let objDone = 0, powers = 0, humans = 0, blasts = 0;
    for (let f = 0; f < 60 * 120; f++) {
      const a = S.cpuInput(s, 0, cpu[0], 2), b = S.cpuInput(s, 1, cpu[1], 2);
      // scripted human behaviour for P1: hold SPOTTER, run to a tower and plant
      let ia = a;
      if (s[S.G_PHASE] === S.PH_FIGHT && f % 600 < 200) ia = (a & ~(S.IN_L | S.IN_R | S.IN_U | S.IN_D | S.IN_A | S.IN_B)) | S.IN_Y | (s[S.F0 + S.HMX] < 0 ? S.IN_R : S.IN_L) | (f % 600 > 150 ? S.IN_A : 0);
      S.step(s, ia, b, rig);
      for (let i = 0; i < S.evN; i++) {
        const t = S.EV[i * S.EVS];
        if (t === S.EV_OBJDONE) objDone++;
        if (t === S.EV_POWER) powers++;
        if (t === S.EV_HUMAN) humans++;
        if (t === S.EV_BLAST) blasts++;
      }
      if (s[S.G_PHASE] === S.PH_END) break;
    }
    return { sum: S.checksum(s), frame: s[S.G_FRAME], hp: [s[S.F0 + S.HP], s[S.F1 + S.HP]], obj: [s[S.F0 + S.OBJS], s[S.F1 + S.OBJS]], objDone, powers, humans, blasts, havoc: s[S.G_HAVOC], phase: s[S.G_PHASE] };
  };
  const r1 = run(1234), r2 = run(1234);
  console.log("match A", JSON.stringify(r1));
  console.log("deterministic:", r1.sum === r2.sum);
  console.log("match B", JSON.stringify(run(777)));
}
main();
