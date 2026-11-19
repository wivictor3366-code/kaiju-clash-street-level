// Netcode: peer-to-peer rollback (GGPO-style) over WebRTC.
//  * Transport: RTCDataChannel {ordered:false, maxRetransmits:0}  == UDP semantics, no
//    head-of-line blocking. Every packet redundantly carries all un-acked inputs, so a
//    lost packet costs nothing.
//  * Both peers simulate immediately with a *predicted* remote input (repeat-last);
//    when the real input arrives and differs we restore a snapshot and re-simulate.
//  * Snapshots are flat Int32Array copies into a ring -> zero GC during play.
//  * Frame-advantage time sync keeps both peers on the same frame so rollbacks are
//    split evenly; 28-byte header binary packets; periodic checksum desync detection.
import { STATE_SIZE, step, checksum, initState, EV, evN, type RigCtx, EV_COLLAPSE, EV_RIP, EV_SWING, EV_BEAM, EV_SUPER, EV_DASH } from "./sim";

const RING = 128, MASK = RING - 1;
export const MAX_PRED = 8;
const FRAME_MS = 1000 / 60;
const EVK = 12;

export interface NetStats {
  rtt: number;
  rollback: number; // frames re-simulated on the last correction
  rbPeak: number;
  stalls: number;
  adv: number;
  desync: boolean;
  silentMs: number;
  delay: number;
  relay: boolean;
}
export type EventSink = (type: number, a: number, b: number, c: number) => void;

export class Session {
  s = new Int32Array(STATE_SIZE);
  frame = 0;
  remoteLast = -1;
  stats: NetStats = { rtt: 0, rollback: 0, rbPeak: 0, stalls: 0, adv: 0, desync: false, silentMs: 0, delay: 0, relay: false };
  private snaps = new Int32Array(RING * STATE_SIZE);
  private local = new Uint16Array(RING);
  private remote = new Uint16Array(RING);
  private used = new Uint16Array(RING);
  private fired = new Int32Array(RING * EVK);
  private firedN = new Uint8Array(RING);
  private firedMax = -1;
  private firstBad = -1;
  private peerAck = -1;
  private peerFrame = 0;
  private peerFrameAt = 0;
  private peerAdv = 0;
  private cool = 0;
  private echo = 0;
  private echoAt = 0;
  private lastRecv = 0;
  private csFrame = 0;
  private cs = 0;
  private myCs = new Uint32Array(16);
  private myCsF = new Int32Array(16).fill(-1);
  private out = new ArrayBuffer(28 + 2 * 64);
  private dv = new DataView(this.out);

  constructor(
    public me: number, // 0 | 1 online, -1 offline
    seed: number,
    c0: number,
    c1: number,
    public delay: number,
    private send: ((b: ArrayBuffer) => void) | null,
    private sink: EventSink,
    private rig: RigCtx,
    private now: () => number = () => performance.now(),
  ) {
    initState(this.s, seed, c0, c1);
    this.stats.delay = delay;
    this.lastRecv = this.now();
    this.fire(-1);
  }

  /** dispatch presentation events exactly once per (frame,event) even across re-simulation */
  private fire(f: number) {
    const slot = f & MASK;
    if (f > this.firedMax) {
      this.firedMax = f;
      this.firedN[slot] = 0;
    }
    for (let i = 0; i < evN; i++) {
      const type = EV[i * 4], a = EV[i * 4 + 1];
      const key = type * 256 + (type === EV_COLLAPSE || type === EV_RIP || type === EV_SWING || type === EV_BEAM || type === EV_SUPER || type === EV_DASH ? a & 255 : 0);
      let seen = false;
      const n = this.firedN[slot];
      for (let j = 0; j < n; j++) if (this.fired[slot * EVK + j] === key) seen = true;
      if (seen) continue;
      if (n < EVK) this.fired[slot * EVK + this.firedN[slot]++] = key;
      this.sink(type, a, EV[i * 4 + 2], EV[i * 4 + 3]);
    }
  }

  /** offline: both inputs are local */
  tickLocal(in0: number, in1: number) {
    step(this.s, in0, in1, this.rig);
    this.frame++;
    for (let i = 0; i < evN; i++) this.sink(EV[i * 4], EV[i * 4 + 1], EV[i * 4 + 2], EV[i * 4 + 3]);
  }

  private sim(f: number) {
    const s = this.s;
    this.snaps.set(s, (f & MASK) * STATE_SIZE);
    const li = this.local[f & MASK];
    const ri = f <= this.remoteLast ? this.remote[f & MASK] : this.remoteLast >= 0 ? this.remote[this.remoteLast & MASK] : 0;
    this.used[f & MASK] = ri;
    if (this.me === 0) step(s, li, ri, this.rig);
    else step(s, ri, li, this.rig);
    this.fire(f);
  }

  /** online tick. returns true if the simulation advanced a frame. */
  tick(input: number): boolean {
    const now = this.now();
    // 1. rollback + re-simulate if a prediction was wrong
    if (this.firstBad >= 0 && this.firstBad < this.frame) {
      const from = this.firstBad;
      this.s.set(this.snaps.subarray((from & MASK) * STATE_SIZE, (from & MASK) * STATE_SIZE + STATE_SIZE));
      for (let f = from; f < this.frame; f++) this.sim(f);
      this.stats.rollback = this.frame - from;
      if (this.stats.rollback > this.stats.rbPeak) this.stats.rbPeak = this.stats.rollback;
    }
    this.firstBad = -1;
    // 2. checksum of the newest fully-confirmed state (desync detection)
    const conf = Math.min(this.remoteLast + 1, this.frame) & ~63;
    if (conf > this.csFrame && conf > this.frame - RING + 2) {
      this.csFrame = conf;
      this.cs = conf === this.frame ? checksum(this.s) : checksum(this.snaps.subarray((conf & MASK) * STATE_SIZE, (conf & MASK) * STATE_SIZE + STATE_SIZE));
      this.myCs[(conf >> 6) & 15] = this.cs;
      this.myCsF[(conf >> 6) & 15] = conf;
    }
    // 3. time sync: if we are running ahead of the peer, give back a frame
    const peerNow = this.peerFrame + (now - this.peerFrameAt) / FRAME_MS + this.stats.rtt / FRAME_MS / 2;
    const adv = this.peerFrameAt ? this.frame - peerNow : 0;
    this.stats.adv = adv;
    this.stats.silentMs = now - this.lastRecv;
    let stall = false;
    if (this.cool > 0) this.cool--;
    else if ((adv - this.peerAdv) / 2 >= 0.9) {
      stall = true;
      this.cool = 5;
    }
    // 4. prediction barrier
    if (this.frame - this.remoteLast - 1 >= MAX_PRED) stall = true;
    if (!stall) this.local[(this.frame + this.delay) & MASK] = input;
    this.sendInputs(now, stall ? this.frame + this.delay - 1 : this.frame + this.delay);
    if (stall) {
      this.stats.stalls++;
      return false;
    }
    this.sim(this.frame);
    this.frame++;
    return true;
  }

  private sendInputs(now: number, lastLocal: number) {
    if (!this.send) return;
    const dv = this.dv;
    const start = Math.max(0, this.peerAck + 1, lastLocal - 63);
    const count = Math.max(0, lastLocal - start + 1);
    dv.setUint8(0, 1);
    dv.setUint8(1, count);
    dv.setInt8(2, Math.max(-127, Math.min(127, Math.round(this.stats.adv * 4))));
    dv.setUint8(3, Math.max(0, Math.min(255, Math.round(now - this.echoAt))));
    dv.setUint32(4, this.frame, true);
    dv.setUint32(8, start, true);
    dv.setInt32(12, this.remoteLast, true);
    dv.setUint16(16, Math.floor(now) & 0xffff, true);
    dv.setUint16(18, this.echo, true);
    dv.setUint32(20, this.csFrame, true);
    dv.setUint32(24, this.cs, true);
    for (let i = 0; i < count; i++) dv.setUint16(28 + i * 2, this.local[(start + i) & MASK], true);
    this.send(this.out.slice(0, 28 + count * 2));
  }

  /** test/debug helper: the rollback snapshot for a confirmed frame (copy) */
  snapshotAt(f: number): Int32Array | null {
    if (f < this.frame - RING + 2) return null;
    return this.snaps.slice((f & MASK) * STATE_SIZE, (f & MASK) * STATE_SIZE + STATE_SIZE);
  }

  onPacket(buf: ArrayBuffer) {
    if (buf.byteLength < 28) return;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 1) return;
    const now = this.now();
    this.lastRecv = now;
    const count = dv.getUint8(1), pf = dv.getUint32(4, true), start = dv.getUint32(8, true), ack = dv.getInt32(12, true);
    if (pf >= this.peerFrame) {
      this.peerFrame = pf;
      this.peerFrameAt = now;
      this.peerAdv = dv.getInt8(2) / 4;
      this.echo = dv.getUint16(16, true);
      this.echoAt = now;
      // RTT from echoed timestamp minus the time the peer held it
      if (this.frame > 0) {
        const sample = ((Math.floor(now) & 0xffff) - dv.getUint16(18, true) - dv.getUint8(3)) & 0xffff;
        if (sample < 3000) this.stats.rtt = this.stats.rtt ? this.stats.rtt * 0.9 + sample * 0.1 : sample;
      }
    }
    if (ack > this.peerAck) this.peerAck = ack;
    for (let i = 0; i < count && 28 + i * 2 + 1 < buf.byteLength; i++) {
      const f = start + i;
      if (f !== this.remoteLast + 1) continue;
      const v = dv.getUint16(28 + i * 2, true);
      this.remote[f & MASK] = v;
      this.remoteLast = f;
      if (f < this.frame && this.used[f & MASK] !== v && (this.firstBad < 0 || f < this.firstBad)) this.firstBad = f;
    }
    const cf = dv.getUint32(20, true);
    if (cf > 0 && this.myCsF[(cf >> 6) & 15] === cf && this.myCs[(cf >> 6) & 15] !== dv.getUint32(24, true)) this.stats.desync = true;
  }
}

// ------------------------------------------------------------------ WebRTC link + HTTP signalling
export interface CtlMsg {
  t: string;
  [k: string]: unknown;
}
export interface Link {
  relayed: boolean;
  sendInput(b: ArrayBuffer): void;
  sendCtl(m: CtlMsg): void;
  close(): void;
  onInput: (b: ArrayBuffer) => void;
  onCtl: (m: CtlMsg) => void;
  onClose: () => void;
}
const ICE: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function waitIce(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((res) => {
    if (pc.iceGatheringState === "complete") return res();
    const t = setTimeout(res, ms);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        res();
      }
    });
  });
}
function waitOpen(ch: RTCDataChannel, ms: number): Promise<void> {
  return new Promise((res, rej) => {
    if (ch.readyState === "open") return res();
    const t = setTimeout(() => rej(new Error("Connection timed out (NAT/firewall may be blocking peer-to-peer)")), ms);
    ch.addEventListener("open", () => {
      clearTimeout(t);
      res();
    });
  });
}
function makeLink(pc: RTCPeerConnection, ctl: RTCDataChannel, inp: RTCDataChannel): Link {
  inp.binaryType = "arraybuffer";
  const link: Link = {
    relayed: false,
    sendInput(b) {
      if (inp.readyState === "open" && inp.bufferedAmount < 8192) inp.send(b);
    },
    sendCtl(m) {
      if (ctl.readyState === "open") ctl.send(JSON.stringify(m));
    },
    close() {
      pc.onconnectionstatechange = null;
      try {
        ctl.close();
        inp.close();
        pc.close();
      } catch {}
    },
    onInput: () => {},
    onCtl: () => {},
    onClose: () => {},
  };
  inp.onmessage = (e) => link.onInput(e.data as ArrayBuffer);
  ctl.onmessage = (e) => {
    try {
      link.onCtl(JSON.parse(e.data as string) as CtlMsg);
    } catch {}
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") link.onClose();
  };
  ctl.onclose = () => link.onClose();
  return link;
}

export interface Cancel {
  cancelled: boolean;
}

const P2P_WAIT = 9000;
const forceRelay = () => typeof location !== "undefined" && location.search.includes("relay=1");

/** Fallback when NAT traversal fails: packets go client -> server (POST) -> client (SSE). */
export function relayLink(code: string, role: number): Promise<Link> {
  return new Promise((res, rej) => {
    const es = new EventSource(`/api/relay/${code}?role=${role}`);
    const url = `/api/relay/${code}?role=${role}&ch=`;
    let closed = false, inflight = 0, opened = false;
    const link: Link = {
      relayed: true,
      sendInput(b) {
        if (closed || inflight > 8) return; // congestion: drop, inputs are redundant anyway
        inflight++;
        fetch(url + "i", { method: "POST", body: b }).catch(() => {}).finally(() => inflight--);
      },
      sendCtl(m) {
        if (!closed) fetch(url + "c", { method: "POST", body: JSON.stringify(m) }).catch(() => {});
      },
      close() {
        closed = true;
        es.close();
      },
      onInput: () => {},
      onCtl: () => {},
      onClose: () => {},
    };
    es.onopen = () => {
      opened = true;
      res(link);
    };
    es.onmessage = (e) => {
      const d = e.data as string;
      if (d.length < 2) return;
      const bin = atob(d.slice(1));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      if (d[0] === "i") link.onInput(u8.buffer);
      else
        try {
          link.onCtl(JSON.parse(new TextDecoder().decode(u8)) as CtlMsg);
        } catch {}
    };
    es.onerror = () => {
      if (!opened) {
        es.close();
        rej(new Error("Relay unavailable"));
      } else if (es.readyState === 2 && !closed) link.onClose();
    };
  });
}

export async function hostLink(onCode: (code: string) => void, cancel: Cancel): Promise<Link> {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const ctl = pc.createDataChannel("ctl", { ordered: true });
  const inp = pc.createDataChannel("inp", { ordered: false, maxRetransmits: 0 });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc, 2500);
    const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer: pc.localDescription?.sdp }) });
    if (!res.ok) throw new Error("Could not create room");
    const { code } = (await res.json()) as { code: string };
    onCode(code);
    for (let i = 0; ; i++) {
      if (cancel.cancelled) throw new Error("cancelled");
      if (i > 450) throw new Error("Room expired");
      await sleep(800);
      const r = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
      if (!r.ok) continue;
      const j = (await r.json()) as { answer?: string | null };
      if (j.answer) {
        await pc.setRemoteDescription({ type: "answer", sdp: j.answer });
        break;
      }
    }
    try {
      if (forceRelay()) throw new Error("relay forced");
      await Promise.all([waitOpen(ctl, P2P_WAIT), waitOpen(inp, P2P_WAIT)]);
      return makeLink(pc, ctl, inp);
    } catch {
      pc.close();
      return relayLink(code, 0);
    }
  } catch (e) {
    pc.close();
    throw e;
  }
}

export async function joinLink(code: string): Promise<Link> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(code)}`, { cache: "no-store" });
  if (!r.ok) throw new Error("Room not found");
  const { offer } = (await r.json()) as { offer: string };
  const pc = new RTCPeerConnection({ iceServers: ICE });
  try {
    const chans: Record<string, RTCDataChannel> = {};
    const got = new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("Connection timed out (NAT/firewall may be blocking peer-to-peer)")), P2P_WAIT);
      pc.ondatachannel = (e) => {
        chans[e.channel.label] = e.channel;
        if (chans.ctl && chans.inp) {
          clearTimeout(t);
          res();
        }
      };
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc, 2500);
    const a = await fetch(`/api/rooms/${encodeURIComponent(code)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: pc.localDescription?.sdp }) });
    if (!a.ok) throw new Error("Room is no longer available");
    got.catch(() => {});
    try {
      if (forceRelay()) throw new Error("relay forced");
      await got;
      await Promise.all([waitOpen(chans.ctl, P2P_WAIT), waitOpen(chans.inp, P2P_WAIT)]);
      return makeLink(pc, chans.ctl, chans.inp);
    } catch {
      pc.close();
      return relayLink(code.toUpperCase(), 1);
    }
  } catch (e) {
    pc.close();
    throw e;
  }
}
