---
name: verify-pin
description: >
  Read the latest fly-mode verification pin (screenshots + pin.json notes) and
  diagnose/fix the reported visual or placement problem, then re-shoot the same
  camera pose to check the fix. Use when the user runs /verify-pin, mentions
  "latest pin", "verification pin", fly-mode pin, or asks you to look at a pin
  they just captured.
---

# /verify-pin — Live verification pin

The user captures pins in fly mode (`P` → problem modal → Enter). Pins land in:

```
docs/verification/pins/latest/pin.json     # structured context
docs/verification/pins/latest/view.png     # what the user was looking at
docs/verification/pins/latest/top.png      # orthographic top-down over the hit
docs/verification/pins/latest/prompt.txt   # the same thing as a brief
docs/verification/pins/index.json          # every stored pin, newest first
```

If those paths are missing, ask whether they ran `bun run pin:serve`, or accept
attached/downloaded `pin-*-pin.json` + `pin-*-view.png` files.

## Steps

1. **Load the pin**
   - Read `docs/verification/pins/latest/pin.json`
   - Read **both** `view.png` and `top.png` with the image reader — you must look
     at the pixels. `top.png` is the one that settles placement questions.
   - Optionally read `prompt.txt`; `index.json` finds older pins by note text.

2. **Treat `notes` as the user request**
   - Non-empty `notes` = the problem statement. Do **not** ask "Was ist das
     Problem?" again.
   - Empty `notes` = ask once what is wrong, then proceed.

3. **Orient from structured fields**
   - `hit.col` / `hit.row`, world `hit.x`/`hit.z`, `camera`, `mapId`
   - `nearby` — map JSON features in range (gameplay truth)
   - `entities` — live sim entities in range, archetypes and anim flags already
     decoded. This is where facing, projectile-origin and unit-placement bugs
     live; a screenshot cannot tell you a yaw.
   - `console` — warnings and errors from the session. `[meshMap] no mesh asset`
     here means the arena silently rendered as greybox, which no screenshot
     shows.
   - `shots[]` — each shot's camera params. `top.png` records the world area it
     covers as `world: [minX, minZ, maxX, maxZ]`, so a pixel maps to a world
     position arithmetically: `x = minX + (px / width) * (maxX - minX)`, and
     `z = minZ + (py / height) * (maxZ - minZ)` (world +Z runs **down** the
     image, matching grid rows).
   - `simHash`, `seed`, `tick`, `client.gpu`, `client.commit` — session context.
     A stale `commit` means the tab predates a fix.
   - Cross-check placement against:
     - `packages/sim/maps/<mapId>.json` (gameplay truth)
     - `docs/renders/fcop-viz/<mapId>/<mapId>-top.png` (layout truth when
       FCOP-derived) — compare it against the pin's `top.png`, not the fly view
     - CLAUDE.md FCOP mesh-alignment rules (`meshMap.ts`, logic centre not grid
       centre)

4. **Report briefly**
   - What you see in the screenshots
   - How it relates to `notes` and the grid/nearby/entities data
   - Likely layer: sim JSON vs mesh offset vs renderer/debug overlay

5. **Act, then verify yourself**
   - Propose a concrete fix (file + change), or implement it if the user wants one
   - Then re-shoot the pin's exact camera pose rather than asking the user to fly
     back: `bun run pin:drive reshoot <id>` (or `latest`). It writes a new pin
     whose `parentId` is the original, so compare the two `top.png`s directly.
   - `bun run verify:arenas` for the whole-arena check on that map.

### Reproduction — do not overclaim

`pin.json` carries `reproduction`:

- `static` — nothing movable was in frame, so map + seed + render + camera pose
  fully determine the image. A reshoot is a real before/after.
- `approximate` — live entities were in frame. No replay is recorded, so a
  reshoot re-runs a **fresh** sim to the same tick: terrain and placement match,
  the units do not. Never present an `approximate` reshoot as proof that a
  unit-behaviour bug is fixed; use it for static geometry only.

## Driving the game yourself

`bun run pin:drive` boots a headless client and a control server on
`127.0.0.1:8788`, and keeps the page (and its sim) alive across calls. Start it
once in the background, then:

```
bun run pin:cmd verbs                                      # what it accepts
bun run pin:cmd goto  '{"map":"la-cantina","render":"mesh"}'
bun run pin:cmd fly   '{"x":120,"y":48,"z":150,"yaw":1.57,"pitch":-0.6}'
bun run pin:cmd step  '{"ticks":300}'
bun run pin:cmd state '{"x":120,"z":150,"radius":40}'
bun run pin:cmd pin   '{"notes":"what I am checking"}'
bun run pin:cmd diagnostics                                # console + asset errors
```

`goto` freezes the sim immediately, so a posed camera holds still. `pin` runs the
client's own capture path, so an agent pin is field-for-field comparable with a
human one.

## Rules

- Pins are **debug-only**. Never put pin logic in the sim tick path — and if a
  pin change moves a golden hash, something leaked into the sim; that commit is
  wrong.
- Do not invent FCOP layout — viz/extract wins over hand-tuned lanes.
- Prefer one high-confidence diagnosis over a long checklist dump.
- Handle v1 pins too: they have no `entities`, `shots`, `console` or
  `reproduction`. Fall back to `view.png` + `nearby` and say what you could not
  check.
- Keep this file and `.grok/skills/verify-pin/SKILL.md` in sync.
