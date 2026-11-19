// All sound is synthesised with WebAudio (no assets): roars, stomps, impacts, beams, collapses.
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
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
    } catch {
      this.ctx = null;
    }
  }
  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
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
    g.connect(this.master);
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
    g.connect(this.master);
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
  roar(ch: number) {
    if (ch === 0) {
      // the classic rising-then-falling metallic screech
      this.tone("sawtooth", [260, 880, 760, 240], 1.5, 0.3, 0, 22);
      this.tone("sawtooth", [130, 450, 380, 120], 1.5, 0.22, 0, 18);
      this.burst(1.4, 0.35, 700, 2200, "bandpass");
    } else {
      // three cackling heads
      for (let i = 0; i < 3; i++) {
        this.tone("square", [520 + i * 90, 1250 + i * 160, 430], 0.9, 0.11, i * 0.16, 38);
        this.tone("sawtooth", [900, 1600, 700], 0.5, 0.06, 0.3 + i * 0.16, 50);
      }
      this.burst(1.2, 0.25, 2500, 900, "bandpass");
    }
  }
  ko() {
    this.tone("sine", [90, 22], 1.8, 0.9);
    this.burst(2.2, 0.8, 800, 40);
  }
  ui(hi = false) {
    this.tone("square", hi ? [660, 990] : [440, 330], 0.09, 0.12);
  }
}
