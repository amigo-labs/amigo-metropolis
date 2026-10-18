# ui.md — Menu, HUD and overlay architecture

Status: v2 (PLAN.md Phase 14 wave 7: the original's front end)

## 0. One paragraph

The client has **two UI worlds, and they never mix**. The menu is an
application: the original's front-end screen, its dialogs, the lobby — it
renders declaratively with Preact and may allocate freely, because no sim is
being drawn while it is up. The HUD and the in-match overlays are part of the
frame loop's budget: raw DOM, written only when a value changes, zero
allocations per frame. The one in-match dialog, the original's in-game menu, is
a Preact island that the frame loop never calls (§1). Putting a diffing
renderer on the frame loop would trade a real frame-time guarantee for
convenience the menu already has.

## 1. The boundary

| | Menu world | Frame-loop world |
|---|---|---|
| Renders with | Preact (`.tsx`) | `document.createElement`, raw |
| Lives in | `src/menu/` | `src/render/hud/`, `src/*.ts` |
| Allocation | free | **zero per frame** |
| Update model | state → re-render | write-on-change |
| Active when | no match running | match running |

Frame-loop world, exhaustively: `render/hud/`, `touchControls.ts`,
`debug/sandboxPanel.ts`, `debug/pinModal.ts`, the net-status card, the
match-end card, the debug label, the fly crosshair, the fade cover and the
reticle.

**The in-game menu is a Preact island** (`menu/inGame.tsx`). Escape mounts it,
it renders only on its own input events, and closing it unmounts it; nothing in
it runs per frame and the frame loop never calls into it, so rule 1 of the
renderer is untouched. It is the original's dialog 0xa6 and it reuses the
menu's Audio and Controller dialogs, which is why it is not raw DOM: two copies
of the controls screen would drift.

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
  home: points per slot, unit counts, outpost ownership, respawn timer, avatar
  ammo, the lock, power-ups, winner, and the post-breach outro. (Capture/buy
  progress and core HP were listed here before they were actually written — they
  landed with `MATCH_SLOT_BUY_FRAC` / `MATCH_SLOT_CAPTURE_FRAC` /
  `MATCH_SLOT_CORE_FRAC`, stride 8 → 11. Core HP left with the core (SIM_VERSION
  32), capture progress with the capture timer (SIM_VERSION 34: a capture is
  instant) and buy progress with the purchase hold (SIM_VERSION 51: one unit per
  key press, the original's); the HUD's progress bar went with it, and a
  purchase is answered by its accept or refuse sound.)

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

### The in-match HUD is the original's

`render/hud/` draws Future Cop: L.A.P.D.'s Precinct Assault HUD from the RE's
`hud.json` (`bun run gen:presentation`): the radar top left, the camera caption
under it, the armour gauge, the FUTURE COP badge and the three weapon icons with
their magazine counts bottom left, the score and tanks/jets plates and the
opponent's row top right, the opponent's (or the Sky Captain's) gauge, badge and
`L%02d` level bottom right, the lock beam and reticle over the view. Its art is the
original's atlas page 11, its text font 3 in the original's text colours.

**Layout.** The original lays it out on a 640 x 480 screen. Metropolis scales that
by `s = min(width / 640, height / 480)`, the 4:3 box that fits, and anchors the
left half of the 640 space to the left edge and the right half to the right edge
(likewise top and bottom), so a wide window keeps the HUD's height and moves its
two columns out with the view instead of stretching it (`hudLayout.ts`). Each
group is a canvas drawn at a whole multiple of the original's pixels with
smoothing off.

There is no centre crosshair (the original has none: the gun fires at the lock),
no objective ticker and no breach banner; those were Metropolis' own.

## 3. The front end: the original's

The owner's rule (PLAN.md Phase 14): only the original counts. The menu is
Future Cop's own front end, read from the RE repo's `extracted/frontend/`
(`screens.json`, `dialogs.json`, `ui_sounds.json`; every block cites the
decompiled C in `src/game/frontend/`) and imported unchanged by
`bun run gen:frontend` (`assets.md` §6). The ledger's "Front end" rows
(`fcop-fidelity.md` F1–F22) say what is adopted, refused and open.

### The screen

A 640 x 480 bitmap screen (`menu/frontend/`), drawn on a stage scaled to the
viewport — a whole-number scale when that keeps 80 % of the fit, letterboxed in
black, the bitmaps pixelated. It is composed exactly as `frontend_first_frame`
draws it: one **screen set** of four groups (main, left, right, radio), each its
backdrop at its origin, its extra, its panels, then its menus.

- **Solo:** the set `pa_1p` — the dossier (NEW GAME, LOAD GAME, SAVE GAME, HOST
  GAME, JOIN GAME, PREFERENCES, HELP, QUIT; PRECINCT ASSAULT and 1 PLAYER with
  their buttons; START), player 1's column (three weapon slots with rank arrows,
  the red walker, HARD / NORMAL / EASY), the Sky Captain (level 1-10 and its
  taunt) and the Precinct Assault map.
- **Online:** the set `net_pa` — CANCEL, PREFERENCES, the mode plate, START, the
  "Connected To:" caption, both players' columns and the map.

Everything on it is the model in `menu/frontend/model.ts`, pure and tested
without a DOM: the panels' kinds (0 lights while held and fires on the release
over it, 4 is a radio button firing on the press), the hover/held/hidden/
disabled bits, the gate (BRIEFING disabled in PA, the film strip and COMPLETED
on a finished map, Bug Hunt once the first five are finished), the menus and
the one shared countdown (0x42 ms) that steps the animated strips, the loadout
arrows' skip rule, the chevrons, the level limit, and a won level's progress
(`frame_step_game`, 0x00409630). The config (picks, levels, loadouts) is kept in
localStorage (`menu/frontend/progress.ts`), and SAVE GAME / LOAD GAME are the
original's twenty named slots.

START shows the map's loading screen with the bar (`launch.c`) and then hands
the deep link to `main.ts`. There is no live arena behind the menu: the frame
loop draws nothing while it is up.

### The dialogs

The original's dialogs are native Win32 templates, so Metropolis rebuilds them
in HTML/CSS with the Windows 9x chrome (`menu/win9x/`): every control at its
template rectangle, converted from dialog units with the dialog font's base
units as `MapDialogRect` does (`win9x/dlu.ts`), the modal frame, the caption bar
for WS_CAPTION, the client edge for WS_EX_CLIENTEDGE, the system grey 3D look.
PREFERENCES → options (0x65), Controller Configuration → the controls screen
(0x71, both players), Select Default Profile → 0xa5, Audio → 0x98 (applied on
Ok), LOAD / SAVE GAME → 0xa3, NEW GAME → its MessageBox, HOST / JOIN → the
host and join dialogs (0xa8 / 0xa7) dressing Metropolis' lobby.

### Platform exceptions on the screen

Outside the 640 x 480 screen, in the page's bottom-right corner, small links:
Install (the PWA, once the browser offers it) and, on localhost only, Fly and
Sandbox. In the options dialog the HD textures check box, marked "(Metropolis)",
and the "Spielregeln (Metropolis)" group with the owner's "Kampagnenwaffen"
rule (`fcop-fidelity.md` F23): off by default, the original's Precinct Assault;
on, the loadout arrows also land on each slot's fifth weapon, the original's
rule with Crime War's option bytes set. Solo it is kept with the front end's
config; in the networked lobby it is the host's, sent to the joiner, whose box
shows it greyed.
In the host and join dialogs the lobby's password and listing, and the room
code, marked the same way.

### UI sounds

The nine slots of `ui_sounds.json` on the original's call sites
(`menu/frontend/uiSound.ts`): every fired panel plays slot 0 before its
callback, START slot 1, the level chevrons 2, a refused or empty press 3, the
difficulty chevrons 4, a loadout arrow 5 (8 when nothing else is allowed).
PlaySound is one sound at a time, so a new one cuts the last; there is no back
sound.

### Colours and names

Red and blue are **team colours**. They are the original's sides: side 1 red,
side 2 blue (its radar markers 0x31 / 0x32 and HUD text colours 1 / 3). A
Metropolis team takes the side of the base it stands on, which is a property of
the arena (`render/sides.ts`): team 0 is red on five arenas and blue on La
Cantina. What a player reads names things as the original does: the
**X1-Alpha**, the **tank**, the **jet**, the **Dreadnought**, the **Flying
Fortress**, the **Sky Captain**. The code's identifiers keep the older names
(`RUNNER`, `GUARDIAN`, `JUGGERNAUT`, `FORTRESS`, `WARDEN`, `AVATAR`; rules.md
opens with the map).

## 4. Input: the mouse

The original's front end is mouse-driven and so is this one: a pointer move
walks every panel (hover), a press and a release act on the panel under them,
and that is all. The keyboard and gamepad navigation layer the invented menu
had (`ui/navFocus.ts`) is gone. Dialogs take the keyboard as Windows dialogs
do (Tab between controls, Enter on a focused button); the controls screen's
keyboard hook writes every key into the selected field.

In a match, Escape opens the in-game menu (Resume Game, Abort Game, Audio,
Controller). Its procedure ignores IDCANCEL, so Escape does not close it. Solo
the sim stops under it; online the lockstep runs on (`fcop-fidelity.md` F16).

## 5. Deep links stay authoritative

`?play=`, `?warden=`, `?online=`, `?p2p=`, `?map=`, `?gun=&heavy=&special=`,
`?cam=fly`, `?sandbox=`, `?debug=` bypass the menu entirely (`main.ts`
`explicitMode`). The menu's job is to *produce* such a query and hand it to
`main.ts`; it is never the only way to reach a mode. The mapping lives in
`menu/routing.ts` as pure functions, unit-tested without a DOM — keep it that
way, because it is what the test harnesses drive.
