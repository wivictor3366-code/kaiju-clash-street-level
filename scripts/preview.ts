// Dev tool: bakes sprite frames to a PNG contact sheet so the code-drawn art can be inspected.
// usage: npx tsx scripts/preview.ts <godzilla|ghidorah|env> <scale> <out.png> [anim:frame ...]
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { Raster, type AnimName, type CharArt } from "../src/game/art/raster";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePng(path: string, w: number, h: number, rgba: Uint8Array) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]));
}

async function main() {
  const [who = "godzilla", scaleS = "2", out = "/tmp/preview.png", ...sel] = process.argv.slice(2);
  const scale = parseFloat(scaleS);
  if (who === "env") {
    const { bakeEnv } = await import("../src/game/art/env");
    const e = bakeEnv();
    const img = new Uint8Array(e.w * scale * e.h * scale * 4);
    for (let y = 0; y < e.h * scale; y++)
      for (let x = 0; x < e.w * scale; x++) {
        const c = e.px[Math.floor(y / scale) * e.w + Math.floor(x / scale)];
        const o = (y * e.w * scale + x) * 4;
        const a = c >>> 24 ? 1 : 0;
        img[o] = a ? c & 255 : 58;
        img[o + 1] = a ? (c >>> 8) & 255 : 30;
        img[o + 2] = a ? (c >>> 16) & 255 : 52;
        img[o + 3] = 255;
      }
    writePng(out, e.w * scale, e.h * scale, img);
    return;
  }
  const art: CharArt<unknown> = who === "ghidorah" ? ((await import("../src/game/art/ghidorah")).GHIDORAH as CharArt<unknown>) : ((await import("../src/game/art/godzilla")).GODZILLA as CharArt<unknown>);
  const frames = sel.length ? sel : ["idle:0"];
  const cols = Math.min(frames.length, parseInt(process.env.COLS || "4", 10));
  const rows = Math.ceil(frames.length / cols);
  const crop = (process.env.CROP || `0,0,${art.w},${art.h}`).split(",").map(Number);
  const cw = Math.floor(crop[2] * scale), chh = Math.floor(crop[3] * scale);
  const W = cols * cw, Hh = rows * chh;
  const img = new Uint8Array(W * Hh * 4);
  const r = new Raster(art.w, art.h);
  const t0 = Date.now();
  frames.forEach((spec, idx) => {
    const [an, fi] = spec.split(":");
    const a = art.anims[an as AnimName];
    r.clear();
    art.draw(r, a.fn(parseInt(fi || "0", 10) * a.step));
    const cx = (idx % cols) * cw, cy = Math.floor(idx / cols) * chh;
    for (let y = 0; y < chh; y++)
      for (let x = 0; x < cw; x++) {
        const sy = Math.floor(y / scale) + crop[1], sx = Math.floor(x / scale) + crop[0];
        const c = r.px[sy * art.w + sx];
        const o = ((cy + y) * W + cx + x) * 4;
        if (c >>> 24) {
          img[o] = c & 255;
          img[o + 1] = (c >>> 8) & 255;
          img[o + 2] = (c >>> 16) & 255;
        } else {
          // dusk-sky gradient backdrop + ground line so contrast can be judged
          const g = sy / art.h;
          img[o] = 30 + g * 150;
          img[o + 1] = 18 + g * 50;
          img[o + 2] = 44 - g * 10;
          if (sy >= art.oy) {
            img[o] = 20;
            img[o + 1] = 16;
            img[o + 2] = 20;
          }
        }
        img[o + 3] = 255;
      }
  });
  writePng(out, W, Hh, img);
  console.log(`baked ${frames.length} frames in ${Date.now() - t0}ms -> ${out} (${W}x${Hh})`);
}
main();
