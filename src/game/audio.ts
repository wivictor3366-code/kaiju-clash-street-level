// All sound is synthesised with WebAudio (no assets): roars, stomps, impacts, beams, collapses.
// Everything is synthesised at runtime (oscillators + filtered noise), so there are no audio files and nothing to license:
// the score below is an original composition, not a sample or a transcription of any film theme.
const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
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
  private mtone(type: OscillatorType, freq: number, t: number, dur: number, gain: number, lp = 1200, atk = 0.02) {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    f.type = "lowpass";
    f.frequency.setValueAtTime(lp, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, lp * 0.35), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(this.musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  private mnoise(t: number, dur: number, gain: number, f0: number, type: BiquadFilterType) {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.noise) return;
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise;
    f.type = type;
    f.frequency.value = f0;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.musicBus);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }
  private timpani(t: number, g: number) {
    this.mtone("sine", 64, t, 0.55, g, 400, 0.005);
    this.mtone("sine", 96, t, 0.12, g * 0.5, 600, 0.003);
    this.mnoise(t, 0.08, g * 0.5, 200, "lowpass");
  }
  /** 16th-note sequencer, 4 bars (64 steps) per cycle, "Marching Ruin" in A phrygian-minor @ 88 bpm */
  private schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const spb = 60 / 88 / 4; // seconds per 16th
    while (this.nextBeat < ctx.currentTime + 0.25) {
      const t = this.nextBeat, st = this.step % 64, bar = (st >> 4) & 3, p = st & 15, k = this.intensity;
      // --- bass ostinato: low, heavy, plodding
      const BASS = [
        [33, 0, 0, 33, 0, 0, 36, 0, 33, 0, 0, 34, 0, 33, 0, 0],
        [33, 0, 0, 33, 0, 0, 36, 0, 38, 0, 0, 36, 0, 34, 0, 0],
        [31, 0, 0, 31, 0, 0, 34, 0, 31, 0, 0, 32, 0, 31, 0, 0],
        [33, 0, 0, 33, 0, 36, 0, 38, 39, 0, 38, 0, 36, 0, 34, 0],
      ][bar];
      if (BASS[p]) {
        const n = BASS[p];
        this.mtone("sawtooth", NOTE(n), t, spb * 2.4, 0.5, 520 + k * 500);
        this.mtone("square", NOTE(n - 12), t, spb * 2.6, 0.32, 260);
      }
      // --- timpani: 1, the "and" of 2, 3 (+ rolls in the last bar when it heats up)
      if (p === 0 || p === 6 || p === 8 || (bar === 3 && k > 0.5 && (p === 12 || p === 14))) this.timpani(t, 0.55 + k * 0.3);
      // --- brass stabs: minor-second cluster that lands on bar 1 and answers on bar 3
      if ((bar === 0 || bar === 2) && p === 0) {
        for (const n of bar === 0 ? [57, 58, 64] : [55, 56, 62]) this.mtone("sawtooth", NOTE(n), t, spb * 5, 0.14 + k * 0.08, 900 + k * 900, 0.04);
      }
      if (bar === 1 && p === 8) for (const n of [60, 61, 67]) this.mtone("sawtooth", NOTE(n), t, spb * 4, 0.12 + k * 0.06, 800 + k * 700, 0.04);
      // --- rising 4-note menace motif on the last beat of bar 4
      if (bar === 3 && p >= 12) this.mtone("sawtooth", NOTE([57, 58, 60, 61][p - 12]), t, spb * 1.6, 0.16 + k * 0.1, 1400, 0.01);
      // --- dark string pad on the first step of every bar (open fifth + flat 9th)
      if (p === 0) for (const n of [45, 52, 58]) this.mtone("triangle", NOTE(n), t, spb * 15, 0.1, 700, 0.5);
      // --- snare / metal on 2 and 4 + 8th hats once the fight is hot
      if (k > 0.35 && (p === 4 || p === 12)) this.mnoise(t, 0.16, 0.22 * k, 1800, "bandpass");
      if (k > 0.6 && p % 2 === 0) this.mnoise(t, 0.04, 0.07, 7000, "highpass");
      this.nextBeat += spb;
      this.step++;
    }
  }

  // ------------------------------------------------------------------ roars (formant-filtered growl, per monster)
  private growl(t0: number, dur: number, f0: number, f1: number, gain: number, rasp: number, formant: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noise) return;
    const t = ctx.currentTime + t0;
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
    const fl = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = "sawtooth";
    o2.type = "square";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o2.frequency.setValueAtTime(f0 * 0.5, t);
    o2.frequency.exponentialRampToValueAtTime(f1 * 0.5, t + dur);
    mod.frequency.value = rasp; // amplitude "growl" flutter
    mg.gain.value = 0.45;
    const am = ctx.createGain();
    am.gain.value = 0.55;
    mod.connect(mg);
    mg.connect(am.gain);
    fl.type = "bandpass";
    fl.Q.value = 2.2;
    fl.frequency.setValueAtTime(formant, t);
    fl.frequency.linearRampToValueAtTime(formant * 1.7, t + dur * 0.4);
    fl.frequency.linearRampToValueAtTime(formant * 0.8, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(am);
    o2.connect(am);
    am.connect(fl);
    fl.connect(g);
    g.connect(this.sfxBus);
    for (const x of [o, o2, mod]) {
      x.start(t);
      x.stop(t + dur + 0.05);
    }
    // breath
    const n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
    n.buffer = this.noise;
    nf.type = "bandpass";
    nf.frequency.value = formant * 1.4;
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(gain * 0.5, t + dur * 0.2);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(this.sfxBus);
    n.start(t, Math.random());
    n.stop(t + dur + 0.05);
  }
  /** big roar (ch 0 Godzilla: long, descending, metallic-reverberant; ch 1 Ghidorah: three overlapping shrieks) */
  roar(ch: number) {
    if (ch === 0) {
      this.growl(0, 2.1, 140, 520, 0.9, 19, 520);
      this.growl(0.05, 2.1, 70, 260, 0.6, 14, 330);
      this.growl(0.55, 1.5, 520, 150, 0.5, 23, 800);
      this.burst(1.6, 0.25, 900, 250, "bandpass");
    } else {
      for (let i = 0; i < 3; i++) {
        this.growl(i * 0.2, 1.1, 620 + i * 130, 1500 + i * 220, 0.4, 31 + i * 5, 1500 + i * 300);
        this.growl(0.5 + i * 0.18, 0.8, 1700, 700, 0.28, 42, 2200);
      }
      this.burst(1.3, 0.2, 3000, 1000, "bandpass");
    }
  }
  /** short effort-roar when a heavy / signature move starts */
  grunt(ch: number, big = 0.7) {
    if (ch === 0) this.growl(0.02, 0.55, 120, 260, 0.55 * big, 24, 480);
    else {
      this.growl(0.0, 0.4, 900, 1700, 0.3 * big, 40, 1700);
      this.growl(0.12, 0.38, 1100, 1900, 0.26 * big, 46, 2000);
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
