// Bakes every animation frame of both kaiju (cropped + shelf-packed) and the
// environment sheet into square pages that are uploaded once as a GPU texture array.
import { Raster, ANIMS, type AnimName, type CharArt } from "./raster";
import { GODZILLA } from "./godzilla";
import { GHIDORAH } from "./ghidorah";
import { bakeEnv } from "./env";
import { PX_M } from "../units";

export { PX_M };

export const PAGE = 2048;

export interface Frame {
  l: number; // page (texture layer)
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number; // crop left relative to sprite origin (px, +x = facing dir)
  oy: number; // crop top relative to ground (px, +y = up)
  flip: boolean;
  mouths: number[]; // [dx, dy, ...] relative to origin, y up
  /** rise per run (x1000, integer) of each mouth's axis: the beam leaves the mouth along exactly this line */
  mslope: number[];
  hand: number[];
  /** strike volumes per part: [x0, y0, x1, y1] x4 per PARTS slot, sprite px, y up */
  parts: number[];
}
export interface Atlas {
  pages: Uint32Array[];
  env: Record<string, number[]>;
  chars: Record<AnimName, Frame[]>[];
  names: string[];
}

export const ARTS: CharArt<unknown>[] = [GODZILLA as CharArt<unknown>, GHIDORAH as CharArt<unknown>];

export async function bakeAtlas(onProgress?: (f: number) => void, yieldFn?: () => Promise<void>): Promise<Atlas> {
  const pages: Uint32Array[] = [new Uint32Array(PAGE * PAGE)];
  let cx = 0, cy = 0, rowH = 0;
  const alloc = (w: number, h: number): number[] => {
    if (cx + w + 1 > PAGE) {
      cx = 0;
      cy += rowH + 1;
      rowH = 0;
    }
    if (cy + h + 1 > PAGE) {
      pages.push(new Uint32Array(PAGE * PAGE));
      cx = cy = rowH = 0;
    }
    const res = [pages.length - 1, cx, cy];
    cx += w + 1;
    if (h > rowH) rowH = h;
    return res;
  };

  // environment sheet -> page 0 top-left
  const env = bakeEnv();
  const [, ex, ey] = alloc(env.w, env.h);
  for (let y = 0; y < env.h; y++) pages[0].set(env.px.subarray(y * env.w, (y + 1) * env.w), (ey + y) * PAGE + ex);
  const envSprites: Record<string, number[]> = {};
  for (const k in env.sprites) envSprites[k] = [env.sprites[k][0] + ex, env.sprites[k][1] + ey, env.sprites[k][2], env.sprites[k][3]];

  let total = 0, done = 0;
  for (const a of ARTS) for (const n of ANIMS) total += a.anims[n].n;
  const chars: Record<AnimName, Frame[]>[] = [];
  let last = Date.now();
  for (const art of ARTS) {
    const r = new Raster(art.w, art.h);
    const table = {} as Record<AnimName, Frame[]>;
    for (const name of ANIMS) {
      const an = art.anims[name];
      const frames: Frame[] = [];
      for (let i = 0; i < an.n; i++) {
        r.clear();
        const t = i * an.step;
        const anc = art.draw(r, an.fn(t));
        // crop to opaque bounds
        let x0 = art.w, y0 = art.h, x1 = -1, y1 = -1;
        for (let y = 0; y < art.h; y++) {
          const row = y * art.w;
          for (let x = 0; x < art.w; x++)
            if (r.px[row + x] >>> 24) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
        }
        if (x1 < 0) x0 = y0 = x1 = y1 = 0;
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const [l, ax, ay] = alloc(w, h);
        const pg = pages[l];
        for (let y = 0; y < h; y++) pg.set(r.px.subarray((y0 + y) * art.w + x0, (y0 + y) * art.w + x0 + w), (ay + y) * PAGE + ax);
        const rel = (a: number[]) => a.map((v, k) => (k & 1 ? art.oy - v : v - art.ox));
        frames.push({ l, x: ax, y: ay, w, h, ox: x0 - art.ox, oy: art.oy - y0, flip: an.flip ? an.flip(t) : false, mouths: rel(anc.mouths), mslope: anc.dirs.map((a) => Math.round(Math.tan(a) * 1000)), hand: rel(anc.hand), parts: anc.parts });
        done++;
        if (yieldFn && Date.now() - last > 12) {
          onProgress?.(done / total);
          await yieldFn();
          last = Date.now();
        }
      }
      table[name] = frames;
    }
    chars.push(table);
  }
  onProgress?.(1);
  return { pages, env: envSprites, chars, names: ARTS.map((a) => a.name) };
}

// ------------------------------------------------------------------ chunked baking (UI friendly)
interface Baker {
  pages: Uint32Array[];
  cx: number; cy: number; rowH: number;
  chars: Record<AnimName, Frame[]>[];
  env: Record<string, number[]>;
  ras: Raster[];
}
let baker: Baker | null = null;

function alloc(b: Baker, w: number, h: number): number[] {
  if (b.cx + w + 1 > PAGE) { b.cx = 0; b.cy += b.rowH + 1; b.rowH = 0; }
  if (b.cy + h + 1 > PAGE) { b.pages.push(new Uint32Array(PAGE * PAGE)); b.cx = b.cy = b.rowH = 0; }
  const res = [b.pages.length - 1, b.cx, b.cy];
  b.cx += w + 1;
  if (h > b.rowH) b.rowH = h;
  return res;
}

export function totalFrames(): number {
  let n = 0;
  for (const a of ARTS) for (const k of ANIMS) n += a.anims[k].n;
  return n;
}

export function startBake(): void {
  const pages = [new Uint32Array(PAGE * PAGE)];
  const env = bakeEnv();
  const b: Baker = { pages, cx: 0, cy: 0, rowH: 0, chars: [], env: {}, ras: ARTS.map((a) => new Raster(a.w, a.h)) };
  const [, ex, ey] = alloc(b, env.w, env.h);
  for (let y = 0; y < env.h; y++) pages[0].set(env.px.subarray(y * env.w, (y + 1) * env.w), (ey + y) * PAGE + ex);
  for (const k in env.sprites) b.env[k] = [env.sprites[k][0] + ex, env.sprites[k][1] + ey, env.sprites[k][2], env.sprites[k][3]];
  for (let i = 0; i < ARTS.length; i++) b.chars.push({} as Record<AnimName, Frame[]>);
  baker = b;
}

/** bake exactly one frame; callers can await a macrotask between frames to keep the UI alive */
export function bakeFrame(ci: number, name: AnimName, i: number, table?: Record<AnimName, Frame[]>): void {
  const b = baker;
  if (!b) return;
  const art = ARTS[ci], an = art.anims[name], r = b.ras[ci];
  r.clear();
  const t = i * an.step;
  const anc = art.draw(r, an.fn(t));
  let x0 = art.w, y0 = art.h, x1 = -1, y1 = -1;
  for (let y = 0; y < art.h; y++) {
    const row = y * art.w;
    for (let x = 0; x < art.w; x++)
      if (r.px[row + x] >>> 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  }
  if (x1 < 0) x0 = y0 = x1 = y1 = 0;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const [l, ax, ay] = alloc(b, w, h);
  const pg = b.pages[l];
  for (let y = 0; y < h; y++) pg.set(r.px.subarray((y0 + y) * art.w + x0, (y0 + y) * art.w + x0 + w), (ay + y) * PAGE + ax);
  const rel = (a: number[]) => a.map((v, k) => (k & 1 ? art.oy - v : v - art.ox));
  (table ?? b.chars[ci])[name] = (table ?? b.chars[ci])[name] ?? [];
  (table ?? b.chars[ci])[name].push({ l, x: ax, y: ay, w, h, ox: x0 - art.ox, oy: art.oy - y0, flip: an.flip ? an.flip(t) : false, mouths: rel(anc.mouths), mslope: anc.dirs.map((a) => Math.round(Math.tan(a) * 1000)), hand: rel(anc.hand), parts: anc.parts });
}

export function finishBake(): Atlas {
  const b = baker!;
  baker = null;
  return { pages: b.pages, env: b.env, chars: b.chars, names: ARTS.map((a) => a.name) };
}
