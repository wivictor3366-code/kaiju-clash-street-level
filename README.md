# KAIJU CLASH — Street Level

A pixel-art kaiju fighting game seen **from the street**. You are 1.7 m tall. They are 90–160 m tall.
Godzilla and King Ghidorah fight through a live city while the camera sits at human eye level, pitched
up into a burning sky — tiny people sprint past the lamp posts, power lines sag across the frame and
every building in the lane can be smashed or **ripped out of the ground and thrown**.

![match](docs/screenshot.png)

## Highlights

* **Every pixel drawn in code** — no spritesheets, no AI imagery. Each kaiju is a skeletal rig
  (spine/tail chain, IK legs, FK arms, hinged jaws, three independent necks for Ghidorah, membrane
  wings, dorsal plates) rasterised to pixel art at boot with an outline/shading pass, then uploaded
  once to a GPU **texture array**.
* **Street-level perspective** — a real 3D scene (perspective camera, depth buffer, alpha cut-out)
  rendered into a 640×360 framebuffer and upscaled with a sharp-bilinear pass. Facades, sky,
  smoke, beams and lightning are procedural shaders, so the whole game ships with ~400 kB of JS and
  no image downloads.
* **Visual hitboxes** — strike volumes are measured from the same joints the sprite is drawn from and
  baked per animation frame (`Frame.parts`). The simulation tests those boxes, so the hitbox *is* the
  visible limb (plus a 0.9 m forgiving skin). Press **F1** in-game to see the exact boxes.
* **Rollback netcode (GGPO-style)** over WebRTC data channels with UDP semantics, predicted inputs,
  redundant input packets, frame-advantage time sync, checksum desync detection and a server relay
  fallback when NAT traversal fails. Whole game state = one `Int32Array`, so a rollback is a single
  typed-array copy.
* **Deterministic 60 Hz simulation** — integer-only maths (centimetres), no `Math.sin` in gameplay
  code, fixed-point conversions. Verified headless at 0–150 ms latency with 20 % packet loss
  (`scripts/nettest.ts`): peers converge to a bit-identical state.
* **Destructible city** — 18 lane buildings with per-hit damage, collapse debris, permanent burning
  rubble, city-damage scoreboard. Buildings you can rip glow with a pulsing outline and rising chevrons.

## Controls

| Action | Solo / Online | Local P1 | Local P2 |
| --- | --- | --- | --- |
| Move / dash (double-tap) | A D or ← → | A D | ← → |
| Block | hold away | hold away | hold away |
| Light | J | F | J |
| Heavy (launcher / tail) | K | G | K |
| Low stomp | ↓ + J | S + F | ↓ + J |
| Tail sweep (knockdown) | ↓ + K | S + G | ↓ + K |
| Shoulder charge | ↑ + K | W + G | ↑ + K |
| Beam (1 bar) | L | H | L |
| Grab / throw | U | R | U |
| Rip building + hurl | ↓ + U | S + R | ↓ + U |
| Super (full meter) | I | T | I |
| Show hitboxes | F1 | F1 | F1 |

Gamepads: X light · Y heavy · B beam · A grab · RB super.

### Combo routes
* `LIGHT → HEAVY → BEAM → SUPER` (cancel on hit **or** block)
* `LOW → SWEEP → SUPER`
* `SWEEP / CHARGE → SUPER`
* simultaneous active limbs **clash**: both fighters recoil, both build meter
* launch the opponent *through* a tower for bonus damage; the ground slam shatters nearby blocks
* if both players stall, the burning city "roars" and hands out meter to keep the match moving

## Stack

* Next.js (App Router, React 19) + Tailwind for the shell/menus
* WebGL2 renderer written from scratch (`src/game/render.ts`) — 4 batched draw streams +
  procedural shaders, GPU texture array for all sprite frames
* Deterministic simulation (`src/game/sim.ts`), pure animation mapping (`src/game/anim.ts`)
* Rollback session + WebRTC signalling (`src/game/net.ts`, `/api/rooms`, `/api/relay`)
* Drizzle ORM + PostgreSQL for rooms and the match/havoc leaderboard
* WebAudio synthesised SFX (`src/game/audio.ts`) — roars, stomps, beams, collapsing towers

## Run locally

```bash
npm install
cp .env.example .env          # point DATABASE_URL at a local PostgreSQL
npx drizzle-kit push          # create `rooms` + `matches`
npm run dev
```

Open the app, pick your kaiju, and fight. **VS CPU** and **LOCAL 2P** work offline; **CREATE ROOM**
gives you a 5-letter code for a friend (WebRTC P2P, automatic relay fallback).

### Dev tools

```bash
npx tsx scripts/nettest.ts          # hitbox reach table + rollback determinism at 0-150 ms / 20 % loss
npx tsx scripts/preview.ts godzilla 3 out.png idle:0 light:5 heavB:0
CROP=150,24,120,110 npx tsx scripts/preview.ts ghidorah 5 head.png idle:0   # zoom into the art
```
