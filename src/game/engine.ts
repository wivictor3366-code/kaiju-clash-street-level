// Main loop: fixed 60 Hz simulation (accumulator), input sampled right before each tick,
// one render per display refresh. Offline modes tick locally; online ticks the rollback session.
import { Session, type Link, type NetStats } from "./net";
import { Renderer } from "./render";
import { Sfx } from "./audio";
import { Input } from "./input";
import * as S from "./sim";
import { animFrame } from "./anim";

export interface EngineOpts {
  mode: "demo" | "cpu" | "local" | "online";
  chars: [number, number];
  names: [string, string];
  seed: number;
  level: number;
  me: number;
  link: Link | null;
  delay: number;
  onEnd: (r: { winner: number; havoc: number; frames: number }) => void;
  onLost?: () => void;
}

const STEP = 1000 / 60;

export class Engine {
  sess: Session;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private ended = false;
  private running = false;
  private cpu = [S.newCpu(0x1234567), S.newCpu(0x7654321)];
  banner = "";

  constructor(private r: Renderer, private sfx: Sfx, private input: Input, private o: EngineOpts) {
    const online = o.mode === "online" && o.link;
    const rig: S.RigCtx = { fr: (off) => animFrame(this.sess.s, off, this.r.atlas.chars) };
    this.sess = new Session(online ? o.me : -1, o.seed, o.chars[0], o.chars[1], online ? o.delay : 0, online ? (b) => o.link!.sendInput(b) : null, this.onEvent, rig);
    if (online) {
      o.link!.onInput = (b) => this.sess.onPacket(b);
      this.sess.stats.relay = o.link!.relayed;
    }
    this.cpu[0].rng = (o.seed * 31 + 7) | 1;
    this.cpu[1].rng = (o.seed * 17 + 3) | 1;
  }

  private onEvent = (type: number, a: number, b: number, c: number, d: number) => {
    this.r.event(type, a, b, c, d);
    if (this.o.mode === "demo") return;
    const sfx = this.sfx, ch = this.o.chars;
    switch (type) {
      case S.EV_STEP: sfx.thud(0.4); break;
      case S.EV_HIT: sfx.hit(Math.min(1, 0.5 + c / 160)); break;
      case S.EV_BLOCK: sfx.block(); break;
      case S.EV_COLLAPSE: case S.EV_RIP: case S.EV_CHUNK: sfx.collapse(); break;
      case S.EV_CRASH: sfx.collapse(); sfx.hit(0.8); break;
      case S.EV_SLAM: sfx.thud(1); break;
      case S.EV_SUPER: sfx.roar(ch[a]); sfx.beam(ch[a], true); break;
      case S.EV_BEAM: sfx.beam(ch[a], false); break;
      case S.EV_KO: sfx.ko(); break;
      case S.EV_FIGHT: sfx.ui(true); break;
      case S.EV_ROUND: sfx.roar(ch[0]); setTimeout(() => this.running && sfx.roar(ch[1]), 650); break;
      case S.EV_GRAB: sfx.hit(0.4); break;
      case S.EV_SWING: case S.EV_DASH: sfx.swing(); break;
      case S.EV_END: if (a === 1 || a === 2) sfx.roar(ch[a - 1]); break;
      case S.EV_CLASH: sfx.block(); sfx.thud(0.7); break;
      case S.EV_ROAR: sfx.roar(ch[a & 1]); break;
      case S.EV_ARMY: sfx.thud(0.35); sfx.swing(); break;
      case S.EV_BSMASH: sfx.collapse(); sfx.hit(1); sfx.thud(1); break;
      case S.EV_SIDE: sfx.swing(); break;
      case S.EV_REBUILD: sfx.ui(false); break;
      case S.EV_OBJ: sfx.ui(false); break;
      case S.EV_OBJDONE: case S.EV_POWER: sfx.ui(true); sfx.thud(0.5); break;
      case S.EV_BLAST: sfx.collapse(); sfx.thud(0.9); break;
      case S.EV_PLANT: sfx.ui(false); break;
      case S.EV_STRIKE: sfx.swing(); break;
      case S.EV_HUMAN: sfx.hit(0.3); break;
    }
  };

  get net(): NetStats | null {
    return this.o.mode === "online" ? this.sess.stats : null;
  }

  start() {
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick() {
    const o = this.o, s = this.sess.s;
    let advanced = true;
    if (o.mode === "online") advanced = this.sess.tick(this.input.solo());
    else if (o.mode === "local") this.sess.tickLocal(this.input.p1(), this.input.p2());
    else if (o.mode === "cpu") this.sess.tickLocal(this.input.solo(), S.cpuInput(s, 1, this.cpu[1], o.level));
    else this.sess.tickLocal(S.cpuInput(s, 0, this.cpu[0], 2), S.cpuInput(s, 1, this.cpu[1], 2));
    this.input.flush();
    if (o.mode === "online" && !this.ended && this.sess.stats.silentMs > 10000) {
      this.ended = true;
      o.onLost?.();
    }
    if (advanced) this.r.update(s);
    if (s[S.G_PHASE] === S.PH_END) {
      if (o.mode === "demo") {
        if (s[S.G_PT] > 240) {
          // attract mode loops forever
          this.sess = new Session(-1, (s[S.G_FRAME] * 2654435761) | 0, o.chars[0], o.chars[1], 0, null, this.onEvent, { fr: (off) => animFrame(this.sess.s, off, this.r.atlas.chars) });
        }
      } else if (!this.ended && s[S.G_PT] > 90 && (o.mode !== "online" || this.sess.remoteLast >= this.sess.frame - 1)) {
        this.ended = true;
        o.onEnd({ winner: s[S.G_WINNER], havoc: s[S.G_HAVOC], frames: s[S.G_FRAME] });
      }
    }
  }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    let dt = now - this.last;
    this.last = now;
    if (dt > 250) dt = STEP; // tab was hidden
    if (Math.abs(dt - STEP) < 1.2) dt = STEP; // snap vsync jitter on 60 Hz panels -> exactly one tick per refresh
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP - 0.01 && n < 4) {
      this.tick();
      this.acc -= STEP;
      n++;
    }
    if (n === 4) this.acc = 0;
    this.r.act(dt);
    this.r.resize();
    this.r.draw(this.sess.s, { names: this.o.names, net: this.net, demo: this.o.mode === "demo", banner: this.banner });
  };
}
