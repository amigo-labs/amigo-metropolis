# Verification pins (fly mode ↔ agent)

Live visual co-debug: fly to a spot, press **P**, type what is wrong, save a
pin. The agent reads the same pin via `/verify-pin` — and can re-shoot the same
camera pose itself after a fix, instead of asking you to fly back.

## Workflow

1. Terminal A: `bun run dev`
2. Terminal B: `bun run pin:serve` (writes pins here; optional — without it the
   browser downloads the files as `pin-<id>-*`)
3. Menu → **Fly** (or `?play=1&cam=fly&map=<id>`)
4. Aim the center crosshair → **P**
5. Modal: **Was ist das Problem?** → Enter
6. Chat: `/verify-pin` (or "schau den letzten Pin an")

### Hotkeys

| Key | Action |
|-----|--------|
| `P` | Capture frame + open problem modal |
| `Shift+P` | Same, and leave the sim paused after saving |
| Enter (in modal) | Save pin |
| Esc (in modal) | Cancel |

## Layout

```
docs/verification/pins/
  README.md          # this file
  index.json         # every stored pin, newest first (gitignored)
  latest/            # always the most recent pin (gitignored)
    pin.json
    view.png
    top.png
    prompt.txt
  <id>/              # one folder per pin (gitignored by default)
    …
```

Pins beyond the newest 50 are pruned automatically. Commit a pin only when you
want it as a durable bug report; day-to-day pins stay local.

## pin.json (version 2)

v2 is additive over v1 — every v1 field kept its name and meaning.

| Field | Meaning |
|-------|---------|
| `mapId` | Arena id |
| `camera` | Fly cam position + yaw/pitch |
| `hit` | Heightfield ray hit: world x/y/z, grid col/row, source |
| `nearby` | Closest map features (turrets, bases, lanes, …) — gameplay truth |
| `notes` | **Your problem text from the modal** (agent prompt) |
| `entities` | Live sim entities near the hit, archetype/anim decoded to names |
| `shots` | Per-shot camera params; the top-down records the world area it covers |
| `console` | Tail of console output — catches silent greybox fallbacks |
| `simHash` | FNV-1a state hash of the pinned tick |
| `client` | Viewport, DPR, GPU, texture variant, build commit |
| `reproduction` | `static` or `approximate` — see below |
| `parentId` / `origin` | Reshoot chain, and whether a human or an agent shot it |
| `render` / `seed` / `tick` / `url` | Session context |

`notes` is the primary instruction for the agent. If empty, the agent should
ask what the problem is.

### Two shots, not one

`view.png` is your fly view. `top.png` is an orthographic top-down over the same
hit, because a mesh/logic-centre offset is not readable from a perspective view —
that gets decided by comparing top-down against the map JSON and
`docs/renders/fcop-viz/<map>/<map>-top.png`.

`shots[]` records each shot's camera params, and the top-down carries
`world: [minX, minZ, maxX, maxZ]`, so a pixel maps back to a world position
arithmetically. World +Z runs **down** the image, matching grid rows.

### `reproduction` — what a reshoot proves

No replay is recorded, so:

- **`static`** — nothing movable was in frame. Map + seed + render + camera pose
  fully determine the image, and a reshoot is a real before/after. This covers
  the pin's main job: terrain, mesh placement, turret and base spots.
- **`approximate`** — live entities were in frame. A reshoot re-runs a *fresh*
  sim to the same tick: terrain and placement match, the units do not. Not
  evidence on its own for a unit-behaviour fix.

## Agent-driven pins

`bun run pin:drive` boots a headless client plus a control server on
`127.0.0.1:8788` and keeps the page (and its sim) alive across calls, so an
agent can steer the game itself:

```bash
bun run pin:drive &                                        # start once
bun run pin:cmd verbs                                      # what it accepts
bun run pin:cmd goto  '{"map":"la-cantina","render":"mesh"}'
bun run pin:cmd fly   '{"x":120,"y":48,"z":150,"yaw":1.57,"pitch":-0.6}'
bun run pin:cmd step  '{"ticks":300}'
bun run pin:cmd state '{"x":120,"z":150,"radius":40}'
bun run pin:cmd pin   '{"notes":"what I am checking"}'
bun run pin:cmd diagnostics                                # console + asset errors
```

`goto` freezes the sim immediately so a posed camera holds still. `pin` runs the
client's own capture path through `metropolisPin`, so an agent pin is
field-for-field comparable with a human one — which is what makes the
before/after comparison meaningful.

To check a fix against an existing pin:

```bash
bun run pin:drive reshoot latest     # or reshoot <id>
```

It restores the arena, seed, render mode and tick, puts the camera back on the
recorded pose, and writes a new pin whose `parentId` is the original.

`bun run pin:drive --selftest` boots, drives `goto → fly → pin`, and asserts a
pin landed with both shots and decoded entities. It is deliberately not in CI —
`ci.yml` has no browser step.

## Privacy

Both servers bind to `127.0.0.1` only. Nothing is uploaded remotely.
