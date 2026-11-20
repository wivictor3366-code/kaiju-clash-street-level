// All sound is synthesised with WebAudio (no assets): roars, stomps, impacts, beams, collapses.
// Everything is synthesised at runtime (oscillators + filtered noise), so there are no audio files and nothing to license:
// the score is a synthesised remix built on the Godzilla main-theme motif (C-B-A ...); the theme itself is (c) Toho / Akira Ifukube's estate.
const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private pump: GainNode | null = null;
  private roarBus: GainNode | null = null;
  private musicTimer = 0;
  private nextBeat = 0;
  private step = 0;
  musicOn = true;
  /** 0 calm .. 1 full battle: drives the drums / brass layers (set by the engine) */
  intensity = 0.4;
  private noise: AudioBuffer | null = null;
  volume = 0.6;

  /** must be called from a user gesture */
  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC({ latencyHint: "interactive" });
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicOn ? 0.42 : 0;
      this.musicBus.connect(this.master);
      // bass / pads / arps go through `pump`, which dips on every kick
      this.pump = ctx.createGain();
      this.pump.connect(this.musicBus);
      // roars: dry + a big synthetic hall
      this.roarBus = ctx.createGain();
      this.roarBus.gain.value = 1.15;
      this.roarBus.connect(this.sfxBus);
      const conv = ctx.createConvolver(), wet = ctx.createGain();
      conv.buffer = this.makeIR(ctx, 2.8);
      wet.gain.value = 0.5;
      this.roarBus.connect(conv);
      conv.connect(wet);
      wet.connect(this.sfxBus);
      const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = n.getChannelData(0);
      let b = 0;
      for (let i = 0; i < d.length; i++) {
        b = b * 0.6 + (Math.random() * 2 - 1) * 0.4; // slightly brown
        d[i] = b * 1.6;
      }
      this.noise = n;
      // burning-city ambience
      const src = ctx.createBufferSource();
      src.buffer = n;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start();
      this.startMusic();
      window.addEventListener("keydown", (e) => { if (e.code === "KeyM") this.setMusic(!this.musicOn); });
    } catch {
      this.ctx = null;
    }
  }
  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }
  setIntensity(k: number) {
    this.intensity += (Math.max(0, Math.min(1, k)) - this.intensity) * 0.02;
  }
  private tone(type: OscillatorType, f: number[], dur: number, gain: number, delay = 0, vib = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f[0], t);
    for (let i = 1; i < f.length; i++) o.frequency.exponentialRampToValueAtTime(Math.max(20, f[i]), t + (dur * i) / (f.length - 1));
    if (vib) {
      const l = ctx.createOscillator(), lg = ctx.createGain();
      l.frequency.value = vib;
      lg.gain.value = f[0] * 0.06;
      l.connect(lg);
      lg.connect(o.frequency);
      l.start(t);
      l.stop(t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.03, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.sfxBus ?? this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  private burst(dur: number, gain: number, f0: number, f1: number, type: BiquadFilterType = "lowpass", delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = type === "bandpass" ? 1.2 : 0.7;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.sfxBus ?? this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }
  thud(p = 1) {
    this.burst(0.45 * p + 0.15, 0.9 * p, 160, 35);
    this.tone("sine", [70, 28], 0.4, 0.8 * p);
  }
  hit(p = 1) {
    this.burst(0.22, 0.9 * p, 1400, 180, "bandpass");
    this.tone("sine", [150, 42], 0.3, 0.9 * p);
    this.tone("square", [220, 60], 0.08, 0.25 * p);
  }
  block() {
    this.burst(0.12, 0.5, 2400, 900, "bandpass");
    this.tone("triangle", [320, 180], 0.1, 0.3);
  }
  swing() {
    this.burst(0.2, 0.22, 300, 1500, "bandpass");
  }
  collapse() {
    this.burst(1.6, 0.9, 500, 50);
    this.burst(0.5, 0.4, 3000, 400, "bandpass", 0.05);
    this.tone("sine", [55, 24], 1.1, 0.6);
  }
  beam(ch: number, big: boolean) {
    const d = big ? 1.6 : 0.95;
    if (ch === 0) {
      this.tone("sawtooth", [70, 120, 90], d, 0.3, 0.3);
      this.burst(d, 0.5, 900, 5000, "bandpass", 0.3);
      this.tone("square", [900, 1400, 700], d, 0.07, 0.3, 30);
    } else {
      for (let i = 0; i < 3; i++) this.tone("square", [1200 + i * 310, 500 + i * 120, 1500], d, 0.06, 0.3 + i * 0.03, 45);
      this.burst(d, 0.45, 4000, 1500, "highpass", 0.3);
    }
  }

  // ------------------------------------------------------------------ music
  // "GOJIRA RISING" — a battle remix built on the 15-note Godzilla main-theme motif (C-B-A x3, A-B-C, C-B-A, "Go-ji-ra"),
  // all synthesised live (no samples). 148 bpm, A minor. A 16-bar cycle: footsteps intro -> brass build -> supersaw drop -> fury (theme a 4th up) + riser.
  setMusic(on: boolean) {
    this.musicOn = on;
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(on ? 0.42 : 0, this.ctx.currentTime, 0.15);
  }
  private startMusic() {
    if (!this.ctx || this.musicTimer) return;
    this.nextBeat = this.ctx.currentTime + 0.15;
    this.step = 0;
    this.musicTimer = window.setInterval(() => this.schedule(), 90);
  }
  /** pump: bass / pads / arps duck on every kick (fake sidechain) */
  private duck(t: number, depth = 0.3) {
    const g = this.pump?.gain;
    if (!g) return;
    g.cancelScheduledValues(t);
    g.setValueAtTime(depth, t);
    g.linearRampToValueAtTime(1, t + 0.2);
  }
  private mtone(type: OscillatorType, freq: number, t: number, dur: number, gain: number, lp = 1200, atk = 0.02, out?: AudioNode, det = 0) {
    const ctx = this.ctx;
    const dest = out ?? this.musicBus;
    if (!ctx || !dest) return;
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = det;
    f.type = "lowpass";
    f.frequency.setValueAtTime(lp, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, lp * 0.35), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  private mnoise(t: number, dur: number, gain: number, f0: number, type: BiquadFilterType, out?: AudioNode, f1?: number) {
    const ctx = this.ctx;
    const dest = out ?? this.musicBus;
    if (!ctx || !dest || !this.noise) return;
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise;
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(f1 ? 0.0001 : gain, t);
    if (f1) g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(dest);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }
  private kick(t: number, g: number) {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    og.gain.setValueAtTime(g, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(og);
    og.connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.36);
    this.mnoise(t, 0.03, g * 0.5, 3000, "highpass");
    this.duck(t);
  }
  private snare(t: number, g: number) {
    this.mnoise(t, 0.2, g, 1900, "bandpass");
    this.mnoise(t, 0.09, g * 0.6, 6000, "highpass");
    this.mtone("triangle", 190, t, 0.1, g * 0.6, 900, 0.002);
  }
  private timpani(t: number, g: number) {
    this.mtone("sine", 58, t, 0.7, g, 400, 0.005);
    this.mtone("sine", 87, t, 0.14, g * 0.5, 600, 0.003);
    this.mnoise(t, 0.08, g * 0.5, 200, "lowpass");
  }
  /** big orchestral/synth brass: three detuned saws with a slow filter swell (Ifukube's trombones & horns, remixed) */
  private brass(midi: number, t: number, dur: number, g: number, bright = 1, out?: AudioNode) {
    const f = NOTE(midi);
    this.mtone("sawtooth", f, t, dur, g, (1100 + 1400 * bright), 0.035, out, -11);
    this.mtone("sawtooth", f, t, dur, g, (1100 + 1400 * bright), 0.035, out, 0);
    this.mtone("sawtooth", f, t, dur, g * 0.9, (1100 + 1400 * bright), 0.035, out, 11);
  }
  private bassNote(midi: number, t: number, dur: number, g: number, lp: number) {
    this.mtone("sawtooth", NOTE(midi), t, dur, g, lp, 0.008, this.pump ?? undefined);
    this.mtone("square", NOTE(midi - 12), t, dur, g * 0.7, 300, 0.008, this.pump ?? undefined);
    this.mtone("sine", NOTE(midi - 24), t, dur * 1.05, g * 0.9, 200, 0.008, this.pump ?? undefined);
  }
  private tamtam(t: number, g: number) {
    this.mnoise(t, 2.6, g, 900, "bandpass", undefined, 260);
    this.mtone("sine", 96, t, 1.6, g * 0.5, 300, 0.01);
    this.mtone("sine", 142, t, 1.2, g * 0.3, 400, 0.01);
  }
  /** 16th-note sequencer, 4 sections x 4 bars (256 steps) */
  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const spb = 60 / 148 / 4; // seconds per 16th
    // the 15-note theme: five 8-step cells of [eighth, eighth, quarter]; cell 4 is the rising mirror (A-B-C)
    const CELL_DN = [72, 71, 69], CELL_UP = [69, 71, 72];
    while (this.nextBeat < ctx.currentTime + 0.25) {
      const t = this.nextBeat, st = this.step % 256, sec = st >> 6, ps = st & 63, bar = (ps >> 4) & 3, p = st & 15, k = this.intensity;
      const lift = sec === 3 ? 5 : 0; // fury section: the theme climbs a fourth
      const root = 33 + lift; // bass root (A1 / D2)
      const beat4 = p % 4 === 0;
      // ---------------------------------------------------------------- the theme itself
      if (ps < 40 && (ps & 7) < 5 && ((ps & 7) === 0 || (ps & 7) === 2 || (ps & 7) === 4)) {
        const cell = ps >> 3, i = (ps & 7) >> 1, n = (cell === 3 ? CELL_UP : CELL_DN)[i] + lift;
        const len = i === 2 ? 4 : 2, dur = spb * len * 0.94;
        if (sec === 0) {
          // intro: lone low brass over the footsteps
          this.brass(n - 24, t, dur, 0.2, 0.3);
          this.mtone("sine", NOTE(n - 36), t, dur, 0.4, 300, 0.01);
        } else if (sec === 1) {
          this.brass(n - 12, t, dur, 0.17 + k * 0.05, 0.7);
          this.brass(n, t, dur, 0.1 + k * 0.05, 0.8);
        } else {
          // drop / fury: octave-stacked supersaw lead
          this.brass(n, t, dur, 0.15 + k * 0.05, 1.1);
          this.brass(n + 12, t, dur, 0.1 + k * 0.04, 1.5);
          this.brass(n - 12, t, dur, 0.12, 0.8);
        }
        // the bass shadows the theme rhythm
        if (sec >= 1) this.bassNote(n - 36 + (n - 36 < 28 ? 12 : 0), t, dur, 0.42, 420 + k * 380);
      } else if (sec >= 1 && ps < 40 && beat4) {
        this.bassNote(root, t, spb * 3.2, 0.34, 360);
      }
      // ---------------------------------------------------------------- the tail of each 4-bar phrase (steps 40..63)
      if (ps === 40) {
        for (const n of [57 + lift, 58 + lift, 64 + lift]) this.brass(n, t, spb * 8, 0.12 + k * 0.06, 0.8); // Ifukube minor-second cluster
        if (sec !== 2) this.tamtam(t, 0.28);
      }
      if (ps >= 48 && ps < 56 && sec !== 0 && (ps & 3) === 0) this.bassNote(root + (ps === 52 ? 3 : 0), t, spb * 3.2, 0.36, 500);
      if (ps >= 56 && (sec === 1 || sec === 3)) {
        // rising run into the next section
        const RUN = [57, 60, 62, 64, 65, 67, 69, 71];
        const n = RUN[ps - 56] + lift;
        this.brass(n, t, spb * 0.95, 0.13, 1.2);
      }
      // ---------------------------------------------------------------- drums
      if (sec === 0) {
        // giant footsteps: boom ... boom
        if (p === 0 || (p === 8 && bar !== 3)) {
          this.kick(t, 0.9);
          this.timpani(t, 0.55);
        }
        if (bar === 3 && ps >= 56 && p % 2 === 0) this.snare(t, 0.12 + (ps - 56) * 0.02);
      } else {
        const hot = sec >= 2 || k > 0.35;
        if (beat4) this.kick(t, 0.85 + (sec >= 2 ? 0.1 : 0));
        if (sec >= 2 && (p === 10 || (bar === 3 && p === 14))) this.kick(t, 0.6);
        if (p === 4 || p === 12) this.snare(t, 0.28 + k * 0.08);
        if (sec === 1 || sec === 3) {
          if (p === 0 && bar === 0) this.timpani(t, 0.45 + k * 0.2);
          if (p === 8 && bar !== 0) this.timpani(t, 0.35);
        }
        if (hot && p % 2 === 0) this.mnoise(t, 0.04, 0.06 + (p % 4 === 2 ? 0.04 : 0), 8000, "highpass");
        if (sec >= 2 && p % 2 === 1) this.mnoise(t, 0.025, 0.035, 9000, "highpass");
        // snare roll + riser into the next section
        if (bar === 3 && ps >= 56 && (sec === 1 || sec === 3)) this.snare(t, 0.1 + (ps - 56) * 0.03);
        if (ps === 48 && (sec === 1 || sec === 3)) this.mnoise(t, spb * 16, 0.22, 500, "highpass", undefined, 9000);
        if (ps === 0 && sec === 2) this.mnoise(t, 0.9, 0.35, 5000, "bandpass", undefined, 400); // impact sweep
      }
      // ---------------------------------------------------------------- harmony: pad + 16th arps through the pump
      if (p === 0) {
        const CH = [[45, 52, 57, 60], [45, 52, 57, 60], [41, 48, 53, 57], [40, 47, 52, 56]][bar].map((n) => n + lift);
        for (const n of CH) this.mtone("sawtooth", NOTE(n), t, spb * 15.5, sec === 0 ? 0.05 : 0.06, 700 + sec * 150, 0.25, this.pump ?? undefined);
        if (sec >= 2) {
          // arp figure for this bar
          (this as unknown as { arp: number[] }).arp = CH.map((n) => n + 12);
        }
      }
      if (sec >= 2 && k >= 0.2) {
        const A = (this as unknown as { arp?: number[] }).arp;
        if (A) {
          const n = A[[0, 1, 2, 3, 2, 1, 3, 2][p & 7]] + (p >= 8 ? 12 : 0);
          this.mtone("sawtooth", NOTE(n), t, spb * 1.8, 0.05 + k * 0.03, 2600, 0.004, this.pump ?? undefined);
        }
      }
      this.nextBeat += spb;
      this.step++;
    }
  }

  // ------------------------------------------------------------------ roars
  // Godzilla: a "bowed double-bass" roar — noise rubbed through a resonating string (feedback delay whose pitch glides) + a shouted
  // formant voice, deep sub, and a screaming top layer, all through distortion and a big convolution hall.
  // Ghidorah: three heads, each a warbling metallic shriek with its own pitch and vowel sweep, over a lion-dragon body and static crackle.
  private curve(pts: number[][], n = 96, inv = false, lo = 0, hi = 1e9): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      let j = 0;
      while (j < pts.length - 2 && u > pts[j + 1][0]) j++;
      const a = pts[j], b = pts[j + 1];
      const k = Math.min(1, Math.max(0, (u - a[0]) / (b[0] - a[0] || 1)));
      const f = Math.min(hi, Math.max(lo, a[1] * Math.pow(b[1] / a[1], k)));
      out[i] = inv ? 1 / f : f;
    }
    return out;
  }
  private drive(amount: number): Float32Array {
    const n = 512, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      c[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return c;
  }
  private makeIR(ctx: AudioContext, secs: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * secs), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const u = i / len;
        lp += ((Math.random() * 2 - 1) - lp) * (0.9 - 0.8 * u); // the tail gets darker
        d[i] = lp * Math.pow(1 - u, 2.6) * (i < 400 ? i / 400 : 1);
      }
    }
    return buf;
  }
  /** one shaped voice: saw (+ square sub) with pitch contour, vibrato, growl AM, distortion, vowel formants */
  private rv(t0: number, dur: number, pitch: number[][], gain: number, o: { wave?: OscillatorType; sub?: number; vib?: number; vibC?: number; am?: number; amD?: number; drv?: number; form?: number[][]; q?: number; air?: number; atk?: number } = {}) {
    const ctx = this.ctx, bus = this.roarBus;
    if (!ctx || !bus || !this.noise) return;
    const t = ctx.currentTime + t0, f = this.curve(pitch);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), subG = ctx.createGain(), mix = ctx.createGain();
    o1.type = o.wave ?? "sawtooth";
    o2.type = "square";
    o1.frequency.setValueCurveAtTime(f, t, dur);
    o2.frequency.setValueCurveAtTime(f.map((v) => v * 0.5), t, dur);
    subG.gain.value = o.sub ?? 0.5;
    o1.connect(mix);
    o2.connect(subG);
    subG.connect(mix);
    const stops: AudioScheduledSourceNode[] = [o1, o2];
    if (o.vib) {
      const l = ctx.createOscillator(), lg = ctx.createGain();
      l.frequency.value = o.vib;
      lg.gain.value = o.vibC ?? 40;
      l.connect(lg);
      lg.connect(o1.detune);
      lg.connect(o2.detune);
      stops.push(l);
    }
    const am = ctx.createGain();
    am.gain.value = 1 - (o.amD ?? 0);
    if (o.am && o.amD) {
      const l = ctx.createOscillator(), lg = ctx.createGain();
      l.type = "square";
      l.frequency.value = o.am;
      lg.gain.value = o.amD;
      l.connect(lg);
      lg.connect(am.gain);
      stops.push(l);
    }
    const sh = ctx.createWaveShaper();
    sh.curve = this.drive(o.drv ?? 2) as Float32Array<ArrayBuffer>;
    const env = ctx.createGain(), atk = (o.atk ?? 0.1) * dur;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + atk);
    env.gain.setValueAtTime(gain, t + dur * 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mix.connect(am);
    am.connect(sh);
    if (o.form) {
      const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(), g2 = ctx.createGain();
      f1.type = f2.type = "bandpass";
      f1.Q.value = f2.Q.value = o.q ?? 3;
      f1.frequency.setValueCurveAtTime(this.curve(o.form), t, dur);
      f2.frequency.setValueCurveAtTime(this.curve(o.form).map((v) => Math.min(9000, v * 2.35)), t, dur);
      g2.gain.value = 0.6;
      sh.connect(f1);
      sh.connect(f2);
      f2.connect(g2);
      f1.connect(env);
      g2.connect(env);
      if (o.air) {
        const n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
        n.buffer = this.noise;
        n.loop = true;
        nf.type = "bandpass";
        nf.Q.value = 1.4;
        nf.frequency.setValueCurveAtTime(this.curve(o.form).map((v) => Math.min(9000, v * 1.6)), t, dur);
        ng.gain.value = o.air;
        n.connect(nf);
        nf.connect(ng);
        ng.connect(env);
        stops.push(n);
      }
    } else sh.connect(env);
    env.connect(bus);
    for (const x of stops) {
      x.start(t);
      x.stop(t + dur + 0.05);
    }
  }
  /** bowed-string rasp: looping noise "rubbed" through a resonating feedback delay whose pitch glides along the contour */
  private bowed(t0: number, dur: number, pitch: number[][], gain: number) {
    const ctx = this.ctx, bus = this.roarBus;
    if (!ctx || !bus || !this.noise) return;
    const t = ctx.currentTime + t0;
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ing = ctx.createGain();
    src.buffer = this.noise;
    src.loop = true;
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 0.5;
    ing.gain.setValueAtTime(0.0001, t);
    ing.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.06);
    ing.gain.setValueAtTime(0.5, t + dur * 0.7);
    ing.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const dl = ctx.createDelay(0.05), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
    dl.delayTime.setValueCurveAtTime(this.curve(pitch, 96, true, 1 / 330, 1 / 40), t, dur);
    fb.gain.value = 0.93;
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    const sh = ctx.createWaveShaper();
    sh.curve = this.drive(3) as Float32Array<ArrayBuffer>;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain * 3, t + dur * 0.08);
    out.gain.setValueAtTime(gain * 3, t + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(ing);
    ing.connect(dl);
    dl.connect(lp);
    lp.connect(fb);
    fb.connect(dl);
    lp.connect(sh);
    sh.connect(out);
    out.connect(bus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
  /** big roar */
  roar(ch: number) {
    if (!this.ctx || !this.roarBus) return;
    if (ch === 0) {
      // GODZILLA — ~3.6 s. Launch up to the scream, long ragged descending wail, groan out.
      const P = [[0, 85], [0.1, 190], [0.2, 420], [0.34, 360], [0.5, 300], [0.68, 210], [0.85, 130], [1, 62]];
      this.bowed(0, 3.6, P, 1);
      this.rv(0, 3.6, P, 0.5, { sub: 0.9, vib: 6.5, vibC: 38, am: 34, amD: 0.55, drv: 3.5, form: [[0, 500], [0.2, 1250], [0.5, 900], [1, 420]], q: 3, air: 0.12 });
      this.rv(0.05, 3.5, P.map(([u, f]) => [u, f * 0.5]), 0.55, { sub: 1, am: 22, amD: 0.6, drv: 4, form: [[0, 260], [0.3, 520], [1, 220]], q: 2 });
      this.rv(0.06, 1.7, [[0, 700], [0.16, 1700], [0.5, 1250], [1, 520]], 0.2, { vib: 9, vibC: 80, am: 55, amD: 0.4, drv: 2.5, form: [[0, 1900], [0.4, 2300], [1, 1300]], q: 4, air: 0.1 });
      this.rv(0, 4, [[0, 34], [0.18, 62], [0.6, 40], [1, 28]], 0.85, { wave: "sine", sub: 0, am: 7, amD: 0.3, drv: 1.5, atk: 0.12 });
      this.burst(0.5, 0.45, 3500, 300, "bandpass");
      this.burst(2.6, 0.18, 1800, 200, "bandpass", 0.5);
      this.thud(0.7);
    } else {
      // KING GHIDORAH — ~3 s. Three heads shriek in turn: warbling, metallic, each in a different register, over a lion-dragon body.
      const heads = [900, 1250, 1650];
      heads.forEach((c, i) => {
        const d = i * 0.27;
        this.rv(d, 1.9, [[0, c * 0.55], [0.1, c * 1.65], [0.28, c * 1.25], [0.45, c * 1.55], [0.7, c * 1.1], [1, c * 0.5]], 0.2 - i * 0.015, { vib: 11 + i * 3, vibC: 95, am: 60 + i * 17, amD: 0.35, drv: 1.8, form: [[0, c * 0.9], [0.15, c * 1.9], [1, c]], q: 4, air: 0.14, atk: 0.06 });
        this.rv(d + 0.6, 1.2, [[0, c * 1.3], [0.3, c * 0.8], [1, c * 1.5]], 0.1, { vib: 15, vibC: 130, drv: 2, form: [[0, c * 1.6], [1, c * 1.1]], q: 5, atk: 0.1 });
      });
      this.rv(0, 2.9, [[0, 140], [0.2, 270], [0.55, 190], [1, 100]], 0.42, { sub: 0.8, vib: 5, vibC: 30, am: 28, amD: 0.5, drv: 3, form: [[0, 650], [0.3, 900], [1, 480]], q: 2.5, air: 0.1 });
      this.rv(0, 3, [[0, 45], [0.2, 70], [1, 36]], 0.6, { wave: "sine", sub: 0, am: 9, amD: 0.3, atk: 0.12 });
      // static crackle: the gravity bolts
      for (let i = 0; i < 9; i++) this.burst(0.05 + Math.random() * 0.07, 0.22, 7000, 2500, "highpass", 0.6 + i * 0.22 + Math.random() * 0.1);
      this.tone("sawtooth", [3200, 400], 0.5, 0.08, 0.5);
      this.burst(0.4, 0.4, 4500, 900, "bandpass");
      this.thud(0.5);
    }
  }
  /** short effort-roar when a heavy / signature move starts */
  grunt(ch: number, big = 0.7) {
    if (!this.ctx || !this.roarBus) return;
    if (ch === 0) {
      const P = [[0, 90], [0.25, 230], [0.6, 170], [1, 75]];
      this.bowed(0.02, 0.85, P, 0.55 * big);
      this.rv(0.02, 0.9, P, 0.5 * big, { sub: 0.9, vib: 7, vibC: 30, am: 32, amD: 0.5, drv: 3.5, form: [[0, 520], [0.3, 1000], [1, 420]], q: 3, air: 0.1 });
      this.rv(0.02, 0.9, P.map(([u, f]) => [u, f * 0.5]), 0.4 * big, { sub: 1, am: 22, amD: 0.5, drv: 3, form: [[0, 280], [1, 240]], q: 2 });
    } else {
      this.rv(0, 0.7, [[0, 700], [0.2, 1900], [0.6, 1400], [1, 650]], 0.22 * big, { vib: 12, vibC: 90, am: 60, amD: 0.35, drv: 1.8, form: [[0, 1500], [0.2, 2900], [1, 1600]], q: 4, air: 0.14, atk: 0.06 });
      this.rv(0.14, 0.6, [[0, 950], [0.2, 2300], [1, 900]], 0.18 * big, { vib: 14, vibC: 100, am: 70, amD: 0.35, drv: 1.8, form: [[0, 1900], [0.2, 3200], [1, 2000]], q: 4, air: 0.12, atk: 0.06 });
      this.rv(0, 0.7, [[0, 150], [0.3, 240], [1, 110]], 0.3 * big, { sub: 0.8, am: 28, amD: 0.5, drv: 3, form: [[0, 650], [1, 480]], q: 2.5 });
    }
  }
  // ------------------------------------------------------------------ extra action sfx
  whip() {
    // tail crack: air rush then a sharp snap
    this.burst(0.28, 0.5, 400, 3500, "bandpass");
    this.burst(0.05, 1, 5000, 1200, "highpass", 0.24);
    this.tone("square", [1800, 200], 0.06, 0.35, 0.24);
    this.thud(0.4);
  }
  gale(n = 0) {
    this.burst(0.9, 0.7, 250, 1400, "bandpass", n * 0.02);
    this.burst(0.7, 0.5, 900, 200, "lowpass", 0.2);
    this.tone("sine", [90, 50], 0.5, 0.5, 0.05);
  }
  pulse() {
    this.tone("sine", [40, 150, 35], 1.6, 0.9);
    this.tone("sawtooth", [90, 700, 60], 1.3, 0.25);
    this.burst(1.4, 0.7, 4000, 90, "lowpass");
    this.burst(0.4, 0.5, 3000, 600, "bandpass", 0.05);
  }
  frenzy(i = 0) {
    this.burst(0.14, 0.45, 800, 3000, "bandpass");
    this.tone("sawtooth", [900 + i * 220, 1700 + i * 220, 800], 0.28, 0.14);
    this.tone("square", [220, 70], 0.1, 0.3);
  }
  squash() {
    this.tone("sine", [300, 90], 0.12, 0.4);
    this.burst(0.1, 0.5, 900, 200, "bandpass");
    this.tone("square", [1100, 1700], 0.05, 0.15, 0.1);
  }
  heliGrab() {
    this.burst(0.5, 0.45, 300, 900, "bandpass");
    this.tone("sawtooth", [180, 60], 0.5, 0.25);
  }
  heliCrush() {
    this.burst(0.9, 0.9, 3000, 150, "lowpass");
    this.burst(0.25, 0.7, 5000, 800, "bandpass");
    this.tone("sawtooth", [400, 40], 0.7, 0.4);
    this.thud(0.6);
  }
  ko() {
    this.tone("sine", [90, 22], 1.8, 0.9);
    this.burst(2.2, 0.8, 800, 40);
  }
  ui(hi = false) {
    this.tone("square", hi ? [660, 990] : [440, 330], 0.09, 0.12);
  }
}
