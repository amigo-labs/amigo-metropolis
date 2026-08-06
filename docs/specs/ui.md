# ui.md — Menu, HUD and overlay architecture

Status: v1

## 0. One paragraph

The client has **two UI worlds, and they never mix**. The menu is an
application: screens, forms, lobby lists, settings — it renders declaratively
with Preact and may allocate freely, because no sim is being drawn while it is
up. The HUD and the in-match overlays are part of the frame loop's budget: raw
DOM, written only when a value changes, zero allocations per frame. Putting a
diffing renderer on the second one would trade a real frame-time guarantee for
convenience the menu already has.

## 1. The boundary

| | Menu world | Frame-loop world |
|---|---|---|
| Renders with | Preact (`.tsx`) | `document.createElement`, raw |
| Lives in | `src/menu/`, `src/ui/` | `src/render/hud/`, `src/*.ts` |
| Allocation | free | **zero per frame** |
| Update model | state → re-render | write-on-change |
| Active when | no match running | match running |

Frame-loop world, exhaustively: `render/hud/`, `touchControls.ts`,
`debug/sandboxPanel.ts`, `debug/pinModal.ts`, the net-status card, the debug
label, the fly crosshair, the fade cover and the reticle.

**Forbidden, and why:**

- **No Preact inside the frame loop.** CLAUDE.md renderer rule 1 is a hard
  budget; a scheduler that batches and diffs cannot promise it.
- **No react-three-fiber.** It would own the scene graph and allocate per
  frame, against renderer rules 1-3.
- **No canvas-owning UI framework** (Lightning.js and relatives). They render
  into their own WebGL context and would fight Three for it.
- **No `dangerouslySetInnerHTML`.** Lobby names are other players' text. JSX
  escapes children; that escape is the only thing standing between a lobby list
  and stored XSS.

## 2. How the HUD reads the sim

The renderer reads sim state **only** through snapshot functions
(`architecture.md` §3, renderer rule 4). The HUD is part of the renderer and is
bound by this — historically it was not, and that exception is retired.

Two buffers, both written once per tick:

- `writeSnapshot(state, out) → count` — per-entity, stride 10. Health bars and
  the radar come from here (`hpFrac`, `teamId`, `x`, `y`, `archetype`).
- `writeMatchSnapshot(state, out)` — per-match scalars that have no per-entity
  home: points per slot, unit counts, outpost ownership, capture progress, buy
  progress, respawn timer, avatar ammo, winner.

Both are pure reads of sim state into caller-owned buffers. They never mutate
and are therefore invisible to `hashState` — adding a field to either cannot
move a golden hash. Adding a field to *sim state* can, and that is a different
change with a different rule (CLAUDE.md hard rule 6).

### The debug text HUD is a separate, load-bearing thing

`globalThis.metropolisHud()` returns the HUD text lines. The e2e and
verification-pin harnesses assert against that string, so its format is a
contract, not a detail. It survives the graphical HUD as a hidden element and
**must not be reformatted** casually — a change there is a tooling change and
belongs in the same commit as the harness updates it forces.

## 3. Visual language

Modelled on the original's cockpit console. Reference shots live in
`docs/renders/fcop-ui/` (`weapons-screen.png`, `load-zone-screen.png`,
`hud-in-match.png`); provenance is in `CREDITS.md`. The title menu also
tracks the Precinct Assault main-console layout (left pill column, centre
map panel, START, bottom loadout strip with rate/damage bars).

- Heavy metal/circuit bezel framing a dark screen
- Faint green grid on near-black, drawn as a `repeating-linear-gradient` — a
  gradient, never an image, so it costs nothing to ship and scales cleanly
- Thin cyan panel borders; cyan text in a chunky rounded techno face
- Lavender reserved for the confirming action ("Ready" / "Start") — one accent,
  one meaning
- Red and blue are **team colours** and are never used for chrome
- Loadout strip bars: **green = rate**, **red = damage**, scaled within each
  hardpoint's catalog (same relative idea as the original's front-end panels)

### Title menu layout

The title screen is a **console frame** over the live 3D arena backdrop (the
arena still previews the picked map). Inside the frame:

| Zone | Content |
|------|---------|
| Left | Pill buttons: Solo, Online, Preferences, How to play (+ Install / debug) |
| Centre | Mode title, large arena preview, arena strip, mode panel / drawer, **Start** |
| Bottom | Three hardpoints stacked with ◀ ▶ to cycle weapons and rate/damage bars |

There is **no separate weapons screen** — the loadout is fitted on the console
strip. Preferences combines Sound and Graphics (one drawer). Online uses
Host/Join in its panel — Start is disabled there because a net match is not a
single button.

Tokens live in `src/ui/cockpit.css` as custom properties and are the only thing
the two UI worlds share. The font is self-hosted: the PWA has to work offline.

## 4. Navigation (keyboard and gamepad)

`src/ui/navFocus.ts`, deliberately framework-free so the raw-DOM overlays can
use it later.

The menu is a **one-dimensional** column, and so is the original's weapons
screen (its own footer reads `Select Hardpoint: ↑↓`). Up/down therefore walks
the focusable elements in DOM order. Only inside a `[data-grid]` container (the
arena picker) does it group elements into visual rows via
`getBoundingClientRect()` and hold the column index across rows — that handles
`repeat(auto-fill, …)` changing its column count on resize, which DOM order
alone cannot.

This is why there is **no spatial-navigation dependency**. `@bbc/tv-lrud-spatial`
and `@noriginmedia/norigin-spatial-navigation-core` both solve geometric
neighbour search in free-form 2D layouts, plus container grouping and focus
memory for deep TV menu trees. A single column has neither problem, and both
libraries still need their conventions in the markup. If a genuinely
two-dimensional screen ever lands, the resolver is one file behind one
interface — swap it there.

Gamepad input is nobody's framework feature: `navigator.getGamepads()` polled
on `requestAnimationFrame`, with deadzone and repeat-delay, reusing the axis
math in `input/gamepadMapping.ts`. Arrow keys and stick directions converge on
the same handler.

A visible `:focus-visible` ring is a functional requirement here, not styling.
Without it, gamepad navigation is unusable.

## 5. Deep links stay authoritative

`?play=`, `?warden=`, `?online=`, `?p2p=`, `?map=`, `?gun=&heavy=&special=`,
`?cam=fly`, `?sandbox=`, `?debug=` bypass the menu entirely (`main.ts`
`explicitMode`). The menu's job is to *produce* such a query and hand it to
`main.ts`; it is never the only way to reach a mode. The mapping lives in
`menu/routing.ts` as pure functions, unit-tested without a DOM — keep it that
way, because it is what the test harnesses drive.
