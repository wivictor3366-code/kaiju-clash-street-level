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
* **2.5D street** — the fight is no longer a single lane: X runs along the street, Z is depth.
  Walk into / out of the street with ↑ ↓, double-tap to **sidestep** (brief intangibility). Attacks
  only connect when both monsters share a lane (each move has its own depth reach; tail swings cover
  more), startups soft-home in depth, **beams sweep across lanes** toward the target (sidestep out of
  them), hurled towers fly in 3D and plough through anything in their path. A top-down **radar**
  shows lots, monsters and a green/red lane line. Fighters in different lanes can walk past each other.
* **Unlimited, destructible city** — 24 lots in three bands (front row, mid-street obstacles, back
  row). Every cleared lot is **rebuilt** (deterministically) ~7 s later: a new tower climbs out of
  scaffolding beside a tower crane. Per-hit damage, collapse debris, burning rubble, city-damage and
  rebuilt counters. Towers you can rip glow with a pulsing outline and rising chevrons.
* **Accurate tower ripping** — `↓+GRAB` locks a tower, the monster lunges so that its gripping hand
  (Godzilla) or near jaw (Ghidorah) meets the tower's near wall *exactly* at the grip frame (offsets
  measured from the baked rig, 0–5 cm error), crouches, tears it out of its foundations (soil and rebar
  raining off the base), heaves it and hoists it overhead. The tower is the real facade box pinned to
  the hand/jaw anchor of the very frame being drawn and rotated rigidly about the grip, so it never
  drifts off the hands. Then **carry** it (walk in any direction), **hurl** it (GRAB) or use it as a
  **club** (LIGHT/HEAVY) that shatters on the street and flattens neighbouring towers. Get hit while
  carrying and you drop it.
* **More moves & combos** — 3-hit LIGHT chain (claw → rising uppercut → lunging bite launcher),
  OTG stomp on a downed opponent, ROAR (meter + makes the army retreat), sidestep attacks, fixed
  tail sweep (↓+K) and shoulder charge (↑+K) which were unreachable before, combo rank callouts and
  best-combo tracking.
* **Human interactions** — civilians stroll the far bank and the near sidewalk, flee from nearby
  monsters, pour out of collapsing towers, get tossed by footsteps / slams / impacts, freeze when a
  monster roars and cheer the survivor. Soldiers hold the line by the tanks until a foot lands next to
  them. The **military** shells whichever monster has wrecked more of the city (helicopter missiles,
  tank fire, jet strafing runs — a little chip damage, a lot of rage meter); beams and flying towers
  swat helicopters out of the sky, reinforcements arrive later.

## Controls

| Action | Solo / Online | Local P1 | Local P2 |
| --- | --- | --- | --- |
| Move / dash (double-tap) | A D or ← → | A D | ← → |
| Walk in depth / sidestep (double-tap) | W S or ↑ ↓ | W S | ↑ ↓ |
| Block | hold away | hold away | hold away |
| Light (×3 chain) | J | F | J |
| Heavy (launcher / tail) | K | G | K |
| Low stomp (hits downed foes) | ↓ + J | S + F | ↓ + J |
| Tail sweep (knockdown) | ↓ + K | S + G | ↓ + K |
| Shoulder charge | ↑ + K | W + G | ↑ + K |
| Beam (1 bar) | L | H | L |
| Grab / throw | U | R | U |
| Rip tower → carry | ↓ + U | S + R | ↓ + U |
| Carrying: hurl / club smash | U / J·K | R / F·G | U / J·K |
| Roar (meter, army retreats) | ↑ + U | W + R | ↑ + U |
| Super (full meter) | I | T | I |
| Show hitboxes | F1 | F1 | F1 |

Gamepads: X light · Y heavy · B beam · A grab · RB super.

### Combo routes
* `LIGHT → LIGHT → LIGHT → HEAVY → CHARGE → BEAM → SUPER` (cancel on hit **or** block; a strict DAG, no infinite loops)
* `LIGHT → LOW → SWEEP → BEAM / SUPER`, then dash in for an OTG stomp
* launchers (LIGHT3, HEAVY, CHARGE, SWEEP) can be juggled by any hit until the juggle limit
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
