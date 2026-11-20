"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ARTS, startBake, bakeFrame, finishBake, totalFrames } from "@/game/art/atlas";
import { ANIMS } from "@/game/art/raster";
import type { Atlas } from "@/game/art/atlas";
import { Raster } from "@/game/art/raster";
import { Renderer } from "@/game/render";
import { Engine, type EngineOpts } from "@/game/engine";
import { Sfx } from "@/game/audio";
import { Input } from "@/game/input";
import { hostLink, joinLink, type Link, type Cancel } from "@/game/net";

type Screen = "loading" | "menu" | "hosting" | "joining" | "playing" | "result" | "error";
interface MatchRow { id: number; mode: string; p1: string; p2: string; c1: number; c2: number; winner: number; havoc: number }
interface Result { winner: number; havoc: number; names: [string, string]; online: boolean }

const CHAR_NAMES = ["GODZILLA", "KING GHIDORAH"];
const LEVELS = ["EASY", "NORMAL", "HARD", "APEX"];

function Btn({ children, onClick, hot, small, disabled }: { children: React.ReactNode; onClick: () => void; hot?: boolean; small?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`pix-btn ${small ? "px-2 py-1 text-[11px]" : "px-4 py-2 text-sm"} ${hot ? "bg-orange-500 text-black hover:bg-yellow-300" : "bg-[#1b1626] text-orange-100 hover:bg-[#3a2140]"} disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

export default function KaijuGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const sfxRef = useRef<Sfx | null>(null);
  const inputRef = useRef<Input | null>(null);
  const atlasRef = useRef<Atlas | null>(null);
  const linkRef = useRef<Link | null>(null);
  const cancelRef = useRef<Cancel>({ cancelled: false });
  const onlineRef = useRef({ me: 0, peerChar: 0, peerName: "RIVAL", myRematch: false, peerRematch: false });
  const cfgRef = useRef({ c1: 0, c2: 1, level: 1, delay: 2, name: "PLAYER" });
  const lostRef = useRef<() => void>(() => {});

  const [screen, setScreen] = useState<Screen>("loading");
  const [progress, setProgress] = useState(0);
  const [portraits, setPortraits] = useState<string[]>([]);
  const [c1, setC1] = useState(0);
  const [c2, setC2] = useState(1);
  const [level, setLevel] = useState(1);
  const [delay, setDelay] = useState(2);
  const [scan, setScan] = useState(false);
  const [volume, setVolume] = useState(0.6);
  const [name, setName] = useState("PLAYER");
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [board, setBoard] = useState<{ recent: MatchRow[]; total: number; havoc: number } | null>(null);
  const [rematchWait, setRematchWait] = useState(false);
  const [help, setHelp] = useState(false);
  const [hitbox, setHitbox] = useState(false);

  cfgRef.current = { c1, c2, level, delay, name: name.trim() || "PLAYER" };

  const loadBoard = useCallback(() => {
    fetch("/api/matches", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setBoard(j))
      .catch(() => {});
  }, []);

  const launch = useCallback(
    (o: Omit<EngineOpts, "onEnd">) => {
      const r = rendererRef.current, sfx = sfxRef.current, input = inputRef.current;
      if (!r || !sfx || !input) return;
      engineRef.current?.stop();
      const eng = new Engine(r, sfx, input, {
        ...o,
        onLost: () => lostRef.current(),
        onEnd: (res) => {
          setResult({ winner: res.winner, havoc: res.havoc, names: o.names, online: o.mode === "online" });
          setRematchWait(false);
          setScreen("result");
          if (o.mode !== "demo" && (o.mode !== "online" || o.me === 0)) {
            fetch("/api/matches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: o.mode, p1: o.names[0], p2: o.names[1], c1: o.chars[0], c2: o.chars[1], winner: res.winner, havoc: res.havoc, frames: res.frames }) })
              .then(loadBoard)
              .catch(() => {});
          }
        },
      });
      engineRef.current = eng;
      eng.start();
    },
    [loadBoard],
  );

  const demo = useCallback(() => {
    launch({ mode: "demo", chars: [0, 1], names: ["GODZILLA", "KING GHIDORAH"], seed: (Date.now() & 0xffffff) | 1, level: 2, me: 0, link: null, delay: 0 });
  }, [launch]);

  const toMenu = useCallback(
    (m = "") => {
      cancelRef.current.cancelled = true;
      linkRef.current?.close();
      linkRef.current = null;
      setMsg(m);
      setCode("");
      setScreen("menu");
      demo();
      loadBoard();
    },
    [demo, loadBoard],
  );

  lostRef.current = () => toMenu("CONNECTION LOST");

  // ---- boot: bake all pixel art, create GPU renderer, start attract mode
  useEffect(() => {
    let dead = false;
    const sfx = new Sfx();
    sfxRef.current = sfx;
    const input = new Input();
    inputRef.current = input;
    try {
      const saved = localStorage.getItem("kaiju-name");
      if (saved) setName(saved);
      if (localStorage.getItem("kaiju-hitbox") === "1") setHitbox(true);
    } catch {}
    (async () => {
      try {
        // portraits straight from the code-drawn rigs
        const urls = ARTS.map((art) => {
          const r = new Raster(art.w, art.h);
          art.draw(r, art.anims.idle.fn(0));
          const cv = document.createElement("canvas");
          cv.width = art.w;
          cv.height = art.h;
          const img = new ImageData(new Uint8ClampedArray(r.px.buffer.slice(0) as ArrayBuffer), art.w, art.h);
          cv.getContext("2d")!.putImageData(img, 0, 0);
          return cv.toDataURL();
        });
        if (dead) return;
        setPortraits(urls);
        // bake every frame of both rigs, yielding between frames so the progress bar animates
        startBake();
        const total = totalFrames();
        let done = 0;
        for (let ci = 0; ci < ARTS.length; ci++) {
          const art = ARTS[ci];
          for (const name of ANIMS) {
            const n = art.anims[name].n;
            for (let i = 0; i < n; i++) {
              bakeFrame(ci, name, i);
              done++;
              if ((done & 3) === 0) {
                if (dead) return;
                setProgress(done / total);
                await new Promise<void>((res) => setTimeout(res, 0));
              }
            }
          }
        }
        const atlas = finishBake();
        atlasRef.current = atlas;
        if (dead || !canvasRef.current) return;
        setProgress(1);
        rendererRef.current = new Renderer(canvasRef.current, atlas);
        setScreen("menu");
        demo();
        loadBoard();
      } catch (e) {
        if (!dead) {
          setMsg(e instanceof Error ? e.message : String(e));
          setScreen("error");
        }
      }
    })();
    return () => {
      dead = true;
      engineRef.current?.stop();
      linkRef.current?.close();
      input.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.scan = scan;
  }, [scan, screen]);
  useEffect(() => {
    if (rendererRef.current) rendererRef.current.debug = hitbox;
    try {
      localStorage.setItem("kaiju-hitbox", hitbox ? "1" : "0");
    } catch {}
  }, [hitbox, screen]);
  useEffect(() => {
    sfxRef.current?.setVolume(volume);
  }, [volume]);
  useEffect(() => {
    try {
      localStorage.setItem("kaiju-name", name);
    } catch {}
  }, [name]);

  const audio = () => sfxRef.current?.init();
  const seed = () => ((Math.random() * 0x7fffffff) | 0) | 1;

  const playCpu = () => {
    audio();
    const c = cfgRef.current;
    setScreen("playing");
    launch({ mode: "cpu", chars: [c.c1, c.c2], names: [c.name.toUpperCase(), "CPU " + CHAR_NAMES[c.c2]], seed: seed(), level: c.level, me: 0, link: null, delay: 0 });
  };
  const playLocal = () => {
    audio();
    const c = cfgRef.current;
    setScreen("playing");
    launch({ mode: "local", chars: [c.c1, c.c2], names: ["PLAYER 1", "PLAYER 2"], seed: seed(), level: 0, me: 0, link: null, delay: 0 });
  };

  // ---- online: handshake over the reliable control channel, inputs over the unreliable one
  const startOnlineMatch = useCallback(
    (me: number, sd: number, chars: [number, number], names: [string, string], dl: number) => {
      const link = linkRef.current;
      if (!link) return;
      onlineRef.current.myRematch = false;
      onlineRef.current.peerRematch = false;
      setScreen("playing");
      launch({ mode: "online", chars, names, seed: sd, level: 0, me, link, delay: dl });
    },
    [launch],
  );
  const hostBegin = useCallback(() => {
    const link = linkRef.current, c = cfgRef.current, o = onlineRef.current;
    if (!link) return;
    const sd = seed(), chars: [number, number] = [c.c1, o.peerChar], names: [string, string] = [c.name.toUpperCase(), o.peerName];
    link.sendCtl({ t: "start", seed: sd, c0: chars[0], c1: chars[1], n0: names[0], n1: names[1], delay: c.delay });
    startOnlineMatch(0, sd, chars, names, c.delay);
  }, [startOnlineMatch]);
  const wire = useCallback(
    (link: Link, me: number) => {
      linkRef.current = link;
      onlineRef.current = { me, peerChar: 0, peerName: "RIVAL", myRematch: false, peerRematch: false };
      link.onCtl = (m) => {
        const o = onlineRef.current;
        if (m.t === "hello") {
          o.peerChar = m.c === 1 ? 1 : 0;
          o.peerName = (typeof m.n === "string" ? m.n : "RIVAL").toUpperCase().slice(0, 16) || "RIVAL";
          if (me === 0) hostBegin();
        } else if (m.t === "start" && me === 1) {
          startOnlineMatch(1, Number(m.seed) | 1, [m.c0 === 1 ? 1 : 0, m.c1 === 1 ? 1 : 0], [String(m.n0).slice(0, 16), String(m.n1).slice(0, 16)], Math.max(0, Math.min(5, Number(m.delay) | 0)));
        } else if (m.t === "rematch") {
          o.peerRematch = true;
          if (me === 0 && o.myRematch) hostBegin();
          else setMsg("RIVAL WANTS A REMATCH!");
        }
      };
      link.onClose = () => {
        if (linkRef.current === link) toMenu("CONNECTION LOST");
      };
      const c = cfgRef.current;
      link.sendCtl({ t: "hello", c: me === 0 ? c.c1 : c.c1, n: c.name });
    },
    [hostBegin, startOnlineMatch, toMenu],
  );
  const host = async () => {
    audio();
    const cancel: Cancel = { cancelled: false };
    cancelRef.current = cancel;
    setMsg("");
    setCode("");
    setScreen("hosting");
    try {
      const link = await hostLink(setCode, cancel);
      if (cancel.cancelled) return link.close();
      wire(link, 0);
    } catch (e) {
      if (!cancel.cancelled) toMenu(e instanceof Error ? e.message.toUpperCase() : "FAILED TO HOST");
    }
  };
  const join = async () => {
    audio();
    const cancel: Cancel = { cancelled: false };
    cancelRef.current = cancel;
    setMsg("");
    setScreen("joining");
    try {
      const link = await joinLink(joinCode.trim().toUpperCase());
      if (cancel.cancelled) return link.close();
      wire(link, 1);
    } catch (e) {
      if (!cancel.cancelled) toMenu(e instanceof Error ? e.message.toUpperCase() : "FAILED TO JOIN");
    }
  };
  const rematch = () => {
    if (!result) return;
    setMsg("");
    if (result.online) {
      const o = onlineRef.current, link = linkRef.current;
      if (!link) return toMenu("CONNECTION LOST");
      o.myRematch = true;
      if (o.me === 0 && o.peerRematch) hostBegin();
      else {
        link.sendCtl({ t: "rematch" });
        setRematchWait(true);
      }
    } else if (result.names[0] === "PLAYER 1") playLocal();
    else playCpu();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === "Escape" && (screen === "playing" || screen === "result" || screen === "hosting" || screen === "joining")) toMenu();
      if (e.code === "Enter" && screen === "result" && !rematchWait) rematch();
      if (e.code === "F1") {
        e.preventDefault();
        setHitbox((h) => !h);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const Pick = ({ label, value, set }: { label: string; value: number; set: (v: number) => void }) => (
    <div className="flex flex-col items-center gap-1">
      <div className="text-[10px] text-orange-300">{label}</div>
      <div className="flex gap-1">
        {CHAR_NAMES.map((n, i) => (
          <button key={n} onClick={() => { set(i); sfxRef.current?.ui(true); }} className={`pix-btn relative h-[84px] w-[104px] overflow-hidden bg-gradient-to-b from-[#2a1230] to-[#a23a1c] ${value === i ? "outline outline-2 outline-yellow-300" : "opacity-60 hover:opacity-100"}`}>
            {portraits[i] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={portraits[i]} alt={n} className="pix absolute bottom-0 left-1/2 h-[120%] max-w-none -translate-x-[52%]" />
            )}
            <span className="absolute inset-x-0 bottom-0 bg-black/70 text-[9px] text-yellow-200">{n}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <main className="fixed inset-0 flex items-center justify-center overflow-hidden bg-black text-orange-50 select-none">
      <div className="relative" style={{ width: "min(100vw, calc(100vh * 16 / 9))", aspectRatio: "16 / 9" }}>
        <canvas ref={canvasRef} className="block h-full w-full" />

        {screen === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black">
            <div className="title text-3xl text-orange-400">KAIJU CLASH</div>
            <div className="text-xs text-orange-200">DRAWING EVERY PIXEL IN CODE... {Math.round(progress * 100)}%</div>
            <div className="h-3 w-64 border-2 border-orange-300 bg-black p-[1px]">
              <div className="h-full bg-orange-400" style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="flex gap-6">{portraits.map((p, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={p} alt="" className="pix h-28" />
            ))}</div>
          </div>
        )}

        {screen === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black p-8 text-center">
            <div className="title text-2xl text-red-400">CANNOT START</div>
            <div className="text-xs">{msg || "WebGL2 is required."}</div>
          </div>
        )}

        {screen === "menu" && (
          <div className="absolute inset-0 flex flex-col items-center overflow-y-auto bg-gradient-to-b from-black/80 via-black/30 to-black/80 px-4 py-[2%]">
            <h1 className="title text-center text-[clamp(22px,5vw,54px)] leading-none text-orange-400">KAIJU CLASH</h1>
            <div className="mb-2 text-[clamp(8px,1.2vw,12px)] tracking-[0.3em] text-yellow-200">STREET LEVEL — YOU ARE THE ANT</div>
            {msg && <div className="mb-1 bg-red-700 px-3 py-1 text-xs text-white">{msg}</div>}

            <div className="flex flex-wrap items-end justify-center gap-4">
              <Pick label="YOUR KAIJU (P1)" value={c1} set={setC1} />
              <div className="title pb-6 text-2xl text-yellow-300">VS</div>
              <Pick label="CPU / P2 KAIJU" value={c2} set={setC2} />
            </div>

            <div className="mt-3 grid w-full max-w-[640px] grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="pix-panel flex flex-col gap-2 p-2">
                <div className="text-[10px] text-orange-300">SOLO</div>
                <Btn hot onClick={playCpu}>VS CPU</Btn>
                <div className="flex flex-wrap gap-1">{LEVELS.map((l, i) => <Btn key={l} small hot={level === i} onClick={() => setLevel(i)}>{l}</Btn>)}</div>
              </div>
              <div className="pix-panel flex flex-col gap-2 p-2">
                <div className="text-[10px] text-orange-300">COUCH</div>
                <Btn hot onClick={playLocal}>LOCAL 2P</Btn>
                <Btn small onClick={() => setHelp((h) => !h)}>{help ? "HIDE" : "SHOW"} CONTROLS</Btn>
              </div>
              <div className="pix-panel flex flex-col gap-2 p-2">
                <div className="text-[10px] text-orange-300">ONLINE PVP — ROLLBACK NETCODE</div>
                <Btn hot onClick={host}>CREATE ROOM</Btn>
                <div className="flex gap-1">
                  <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 5))} placeholder="CODE" className="pix-input w-20 px-2 text-center text-sm" />
                  <Btn small disabled={joinCode.trim().length < 5} onClick={join}>JOIN</Btn>
                </div>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-center gap-3 text-[10px]">
              <label className="flex items-center gap-1">NAME <input value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 12))} className="pix-input w-28 px-1" /></label>
              <label className="flex items-center gap-1">INPUT DELAY
                {[0, 1, 2, 3, 4].map((d) => <Btn key={d} small hot={delay === d} onClick={() => setDelay(d)}>{d}F</Btn>)}
              </label>
              <Btn small hot={scan} onClick={() => setScan((s) => !s)}>CRT</Btn>
              <Btn small hot={hitbox} onClick={() => setHitbox((h) => !h)}>HITBOXES</Btn>
              <label className="flex items-center gap-1">VOL <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(parseFloat(e.target.value))} className="w-20 accent-orange-400" /></label>
            </div>

            {help && (
              <div className="pix-panel mt-2 grid w-full max-w-[640px] grid-cols-1 gap-x-6 gap-y-1 p-3 text-[10px] leading-relaxed sm:grid-cols-2">
                <div><b className="text-yellow-300">SOLO / ONLINE</b><br />MOVE: A D or ← → (double-tap = DASH) · BLOCK: hold away<br />DEPTH (2.5D): W S or ↑ ↓ walk into / out of the street · double-tap = SIDESTEP<br />LIGHT: J (×3 chain) · HEAVY: K (K again = TAIL SLAM) · BEAM (1 bar): L — hold ↓ / ↑ while it fires to tilt the head<br />RISING JAW: ↑+J · LOW STOMP: ↓+J · TAIL SWEEP: ↓+K · SHOULDER CHARGE: ↑+K · QUAKE STOMP: J after sweep / charge / low / tail slam<br />GRAB/THROW: U · RIP A TOWER: ↓+U → carry → U hurl / J·K club smash · ROAR: ↑+U · SUPER: I<br /><b className="text-cyan-300">DUAL CONTROL — SPOTTER</b>: hold <b>Q / Shift / Space / O</b> and your directions + J / K drive a tiny human on the street (the kaiju keeps L U I). <b>J</b> plants a demolition charge on the nearest tower (stand still, then RUN — the blast wrecks it for you), <b>K</b> paints the enemy for a missile strike. Stay out from under the enemy&apos;s feet, quakes and falling towers!</div>
                <div><b className="text-yellow-300">OBJECTIVES & POWERS</b><br />The city marks a condemned tower (red beacon + arrow): wreck it first for meter, repairs and a power orb. Glowing <b>power-core</b> towers drop orbs too. Orbs grant 18 s of RAGE (+35% dmg), IRON HIDE (−40% dmg taken), ATOMIC SURGE (free +50% beams) or REGEN. Walk into an orb with the kaiju — or run the spotter onto it.</div>

              </div>
            )}

            {board && board.recent.length > 0 && (
              <div className="pix-panel mt-2 w-full max-w-[640px] p-2 text-[10px]">
                <div className="mb-1 flex justify-between text-orange-300"><span>RECENT BATTLES ({board.total})</span><span>TOTAL CITY DAMAGE ¥{(board.havoc / 10).toFixed(1)}B</span></div>
                {board.recent.slice(0, 4).map((m) => (
                  <div key={m.id} className="flex justify-between gap-2 border-t border-white/10 py-[2px]">
                    <span className={m.winner === 1 ? "text-yellow-300" : ""}>{m.p1} ({CHAR_NAMES[m.c1]})</span>
                    <span className="text-white/50">{m.mode.toUpperCase()}</span>
                    <span className={m.winner === 2 ? "text-yellow-300" : ""}>{m.p2} ({CHAR_NAMES[m.c2]})</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(screen === "hosting" || screen === "joining") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 text-center">
            {screen === "hosting" ? (
              <>
                <div className="text-xs text-orange-200">{code ? "SHARE THIS ROOM CODE WITH YOUR RIVAL" : "OPENING PEER-TO-PEER CHANNEL..."}</div>
                <div className="title text-6xl tracking-[0.2em] text-yellow-300">{code || "....."}</div>
                {code && <div className="animate-pulse text-xs">WAITING FOR CHALLENGER...</div>}
              </>
            ) : (
              <div className="animate-pulse text-sm">CONNECTING TO ROOM {joinCode}...</div>
            )}
            <Btn onClick={() => toMenu()}>CANCEL</Btn>
          </div>
        )}

        {screen === "playing" && (
          <div className="absolute bottom-1 right-2 flex items-center gap-2 text-[9px]">
            <button onClick={() => setHitbox((h) => !h)} className={`pointer-events-auto border px-1 ${hitbox ? "border-yellow-300 text-yellow-300" : "border-white/30 text-white/50"}`}>
              HITBOX {hitbox ? "ON" : "OFF"} (F1)
            </button>
            <span className="text-white/40">ESC: QUIT</span>
          </div>
        )}

        {screen === "result" && result && (
          <div className="absolute inset-x-0 bottom-[8%] flex flex-col items-center gap-2">
            <div className="pix-panel flex flex-col items-center gap-2 px-6 py-3">
              <div className="text-xs text-orange-200">CITY DAMAGE ¥{(result.havoc / 10).toFixed(1)} BILLION</div>
              {msg && <div className="text-[10px] text-yellow-300">{msg}</div>}
              <div className="flex gap-2">
                <Btn hot disabled={rematchWait} onClick={rematch}>{rematchWait ? "WAITING FOR RIVAL..." : "REMATCH (ENTER)"}</Btn>
                <Btn onClick={() => toMenu()}>MENU (ESC)</Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
