// Environment sprites + 5x7 bitmap font, all drawn in code into one small sheet.
import { Raster, rgb, hash2, bayer } from "./raster";

export const FONT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .!-:/'%+?$,><";
// 7 rows x 5 bits per glyph, hex pairs
const FONT_HEX =
  "0E11111F111111" + "1E11111E11111E" + "0E11101010110E" + "1E11111111111E" + "1F10101E10101F" + "1F10101E101010" + "0E11101711110F" + "1111111F111111" + "0E04040404040E" + "0702020202120C" +
  "11121418141211" + "1010101010101F" + "111B1515111111" + "11191513111111" + "0E11111111110E" + "1E11111E101010" + "0E11111115120D" + "1E11111E141211" + "0F10100E01011E" + "1F040404040404" +
  "1111111111110E" + "11111111110A04" + "1111111515 1B11".replace(" ", "") + "11110A040A1111" + "11110A04040404" + "1F01020408101F" +
  "0E11131519110E" + "040C040404040E" + "0E11010204081F" + "1E01010E01011E" + "02060A121F0202" + "1F101E0101110E" + "0608101E11110E" + "1F010204080808" + "0E11110E11110E" + "0E11110F01020C" +
  "00000000000000" + "00000000000C0C" + "04040404040004" + "0000001F000000" + "000C0C000C0C00" + "01010204081010" + "04040800000000" + "18190204081303" + "0004041F040400" + "0E110102040004" +
  "110A1F041F0404" + "00000000 0C0408".replace(" ", "") + "08040201020408" + "02040810080402";

export interface EnvSheet {
  w: number;
  h: number;
  px: Uint32Array;
  sprites: Record<string, number[]>; // name -> [x,y,w,h]
}

export function bakeEnv(): EnvSheet {
  const r = new Raster(256, 128);
  const sp: Record<string, number[]> = {};
  const map = (name: string, X: number, Y: number, rows: string[], pal: Record<string, number>) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = pal[row[x]];
        if (c) r.sdot(X + x, Y + y, c);
      }
    });
    sp[name] = [X, Y, rows[0].length, rows.length];
  };
  const W = rgb(0xffffff);

  // ---- font (two rows of 25 glyphs, 6x8 cells)
  for (let i = 0; i < FONT_CHARS.length; i++) {
    const gx = (i % 40) * 6, gy = Math.floor(i / 40) * 8;
    for (let y = 0; y < 7; y++) {
      const bits = parseInt(FONT_HEX.substr(i * 14 + y * 2, 2), 16);
      for (let x = 0; x < 5; x++) if (bits & (16 >> x)) r.sdot(gx + x, gy + y, W);
    }
  }
  sp.font = [0, 0, 6, 8];

  // ---- fleeing humans (2 run frames). 'b' is white so vertex tint colours the clothes.
  const HP = { "#": rgb(0x1c1418), s: rgb(0xe0b088), b: W, p: rgb(0x555a70) };
  map("manA", 0, 18, ["....##....", "...####...", "...#ss#...", "....ss....", "..bbbbbs..", ".bbbbbb.s.", "sb.bbbb...", "s..bbbb...", "...bbbb...", "...pppp...", "..ppppp...", "..pp.ppp..", ".pp...pp..", ".pp....pp.", "pp.....pp.", "pp......pp", "##......##", ".........#"], HP);
  map("manB", 12, 18, ["....##....", "...####...", "...#ss#...", "....ss....", "...bbbb...", "..sbbbbs..", "..sbbbbs..", "...bbbb...", "...bbbb...", "...pppp...", "...pppp...", "...pppp...", "...pp.pp..", "...pp.pp..", "..pp..pp..", "..pp..pp..", "..##..##..", ".........."], HP);

  // ---- car
  map("car", 24, 18, ["........cccccccccc........", "......ccwwwwcwwwwwcc......", ".....ccwwwwwcwwwwwwcc.....", "..cccccccccccccccccccccc..", ".cccccccccccccccccccccccc.", "ycccccccccccccccccccccccr.", "ccccccccccccccccccccccccc.", ".cc####cccccccccc####ccc..", "...####..........####.....", "....##............##......"], { c: W, w: rgb(0x1a2a3c), y: rgb(0xfff0a0, 250), r: rgb(0xff3020, 250), "#": rgb(0x14141a) });

  // ---- tank
  {
    const X = 52, Y = 18, o1 = rgb(0x3c4a30), o2 = rgb(0x56663e), o3 = rgb(0x262e20), d = rgb(0x121410);
    r.rect(X + 2, Y + 9, 30, 5, d);
    for (let i = 0; i < 6; i++) r.rect(X + 4 + i * 5, Y + 10, 3, 3, o3);
    r.rect(X + 3, Y + 6, 28, 4, o1);
    r.rect(X + 3, Y + 6, 28, 1, o2);
    r.rect(X + 10, Y + 2, 13, 4, o1);
    r.rect(X + 10, Y + 2, 13, 1, o2);
    r.rect(X + 23, Y + 3, 13, 2, o3);
    r.rect(X + 23, Y + 3, 13, 1, o1);
    sp.tank = [X, Y, 36, 14];
  }
  // ---- helicopter (2 rotor frames)
  for (let f = 0; f < 2; f++) {
    const X = 90 + f * 32, Y = 18, b1 = rgb(0x2a3038), b2 = rgb(0x48525c), d = rgb(0x101216);
    r.rect(X + 14, Y + 1, 2, 3, d);
    if (f === 0) r.rect(X, Y, 30, 1, rgb(0x889098));
    else r.rect(X + 9, Y, 12, 1, rgb(0x889098));
    r.rect(X + 8, Y + 4, 12, 6, b1);
    r.rect(X + 9, Y + 3, 10, 1, b2);
    r.rect(X + 6, Y + 5, 3, 4, rgb(0x9ad0e8));
    r.rect(X + 20, Y + 5, 9, 2, b1);
    r.rect(X + 27, Y + 2, 2, 4, b2);
    r.rect(X + 7, Y + 11, 13, 1, d);
    r.rect(X + 10, Y + 10, 1, 1, d);
    r.rect(X + 17, Y + 10, 1, 1, d);
    r.sdot(X + 28, Y + 3, rgb(0xff3020, 250));
    sp["heli" + f] = [X, Y, 30, 12];
  }
  // ---- debris chunks, spark
  const deb = (name: string, X: number, Y: number, w: number, h: number, seed: number) => {
    const C = [0x8c8678, 0x5e5a50, 0x3a3832].map((v) => rgb(v));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5;
        if (Math.abs(dx) + Math.abs(dy) * 0.9 + hash2(x + seed, y) * 0.25 < 0.62) r.sdot(X + x, Y + y, C[y < h * 0.35 ? 0 : hash2(x, y + seed) > 0.5 ? 1 : 2]);
      }
    sp[name] = [X, Y, w, h];
  };
  deb("deb0", 154, 18, 6, 6, 1);
  deb("deb1", 162, 18, 9, 8, 7);
  deb("deb2", 173, 18, 4, 4, 13);
  r.rect(180, 18, 3, 3, W);
  sp.spark = [180, 18, 3, 3];

  // ---- lamp post (0.16 m/px), power pole
  {
    const X = 0, Y = 40, g1 = rgb(0x30343c), g2 = rgb(0x50565e);
    r.rect(X + 3, Y + 4, 1, 50, g1);
    r.rect(X + 2, Y + 50, 3, 6, g1);
    r.rect(X + 3, Y + 3, 4, 1, g2);
    r.rect(X + 5, Y + 4, 3, 2, rgb(0xffe8a0, 250));
    sp.lamp = [X, Y, 9, 56];
    const PX = 10;
    r.rect(PX + 7, Y + 2, 1, 68, rgb(0x2a2420));
    r.rect(PX + 1, Y + 5, 13, 1, rgb(0x3a322a));
    r.rect(PX + 3, Y + 10, 9, 1, rgb(0x3a322a));
    for (const ix of [1, 5, 9, 13]) r.sdot(PX + ix, Y + 4, rgb(0x9098a0));
    sp.pole = [PX, Y, 15, 70];
  }
  // ---- tree
  {
    const X = 28, Y = 40, G = [0x0e1c14, 0x183222, 0x244a2c, 0x34663a].map((v) => rgb(v));
    r.rect(X + 9, Y + 15, 2, 11, rgb(0x241a14));
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++) {
        const dx = (x - 9.5) / 10, dy = (y - 9) / 9.5;
        const d = dx * dx + dy * dy + (hash2(x >> 1, y >> 1) - 0.5) * 0.35;
        if (d < 0.9) r.sdot(X + x, Y + y, G[Math.max(0, Math.min(3, Math.floor(1.6 - dy * 1.6 - dx * 0.5 + (bayer(x, y) - 0.5))))]);
      }
    sp.tree = [X, Y, 20, 26];
  }
  // ---- dust/smoke puffs (greyscale, tinted at draw time)
  const puff = (name: string, X: number, Y: number, s: number, seed: number) => {
    const C = [0x6a6a6a, 0x9a9a9a, 0xc8c8c8, 0xf2f2f2].map((v) => rgb(v));
    const blobs: number[] = [];
    for (let i = 0; i < 6; i++) blobs.push(0.25 + hash2(i, seed) * 0.5, 0.3 + hash2(i + 9, seed) * 0.45, 0.16 + hash2(i + 5, seed) * 0.16);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        let best = 9, by = 0;
        for (let i = 0; i < blobs.length; i += 3) {
          const d = Math.hypot((x + 0.5) / s - blobs[i], (y + 0.5) / s - blobs[i + 1]) / blobs[i + 2];
          if (d < best) {
            best = d;
            by = ((y + 0.5) / s - blobs[i + 1]) / blobs[i + 2];
          }
        }
        if (best < 1) r.sdot(X + x, Y + y, C[Math.max(0, Math.min(3, Math.floor(2.1 - by * 1.7 + (bayer(x, y) - 0.5) * 0.9)))]);
      }
    sp[name] = [X, Y, s, s];
  };
  puff("puff0", 50, 40, 20, 3);
  puff("puff1", 72, 40, 20, 11);
  puff("puff2", 94, 40, 14, 23);
  // ---- flames
  for (let f = 0; f < 3; f++) {
    const X = 110 + f * 14, Y = 40, C = [rgb(0xc02a10, 250), rgb(0xff7a1c, 250), rgb(0xffc840, 250), rgb(0xfff6c0, 250)];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 12; x++) {
        const t = y / 15; // 0 top .. 1 bottom
        const wob = (hash2(y + f * 7, f) - 0.5) * 0.3 * (1 - t);
        const half = 0.08 + 0.42 * Math.pow(t, 0.7);
        const dx = Math.abs((x + 0.5) / 12 - 0.5 - wob) / half;
        if (dx < 1) r.sdot(X + x, Y + y, C[Math.max(0, Math.min(3, Math.floor((1 - dx) * 2.2 + t * 1.9 - 0.3 + (hash2(x, y + f * 31) - 0.5) * 0.8)))]);
      }
    sp["flame" + f] = [X, Y, 12, 16];
  }
  // ---- torn-off building chunk (thrown projectile)
  {
    const X = 152, Y = 40, w = 40, h = 52;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const jag = h - 4 - hash2(x >> 1, 5) * 7, top = hash2(x >> 2, 9) * 3;
        if (y > jag || y < top) continue;
        const cx = x % 6, cy = y % 7;
        const win = cx >= 1 && cx <= 3 && cy >= 2 && cy <= 4;
        const lit = hash2(Math.floor(x / 6), Math.floor(y / 7)) > 0.6;
        r.sdot(X + x, Y + y, win ? (lit ? rgb(0xffd070, 250) : rgb(0x101822)) : rgb(x < 3 ? 0x8a8e96 : hash2(x, y) > 0.9 ? 0x555a62 : 0x6c727a));
      }
    for (let i = 0; i < 6; i++) r.rect(X + 4 + i * 6, Y + h - 5, 1, 5, rgb(0x3a2a22));
    sp.chunk = [X, Y, w, h];
  }
  // ---- rubble mound
  {
    const X = 50, Y = 64, w = 48, h = 16, C = [0x15151a, 0x26262c, 0x3a3a40, 0x55555a].map((v) => rgb(v));
    for (let x = 0; x < w; x++) {
      const e = Math.sin(((x + 0.5) / w) * Math.PI);
      const top = h - Math.floor(e * (7 + hash2(x >> 1, 3) * 8) + hash2(x, 1) * 2);
      for (let y = Math.max(0, top); y < h; y++) r.sdot(X + x, Y + y, C[y === top ? 3 : hash2(x >> 1, y >> 1) > 0.6 ? 2 : hash2(x, y) > 0.5 ? 1 : 0]);
      if (hash2(x, 77) > 0.86) r.rect(X + x, Math.max(0, Y + top - 3), 1, 3, rgb(0x4a2a1c));
    }
    sp.rubble = [X, Y, w, h];
  }
  r.flush(0);
  return { w: r.w, h: r.h, px: r.px, sprites: sp };
}
