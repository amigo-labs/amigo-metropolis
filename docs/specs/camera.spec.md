# SPEC — Camera System (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/camera.spec.md`
> Status: v2 — the original's seven chase cameras and the Camera Key (PLAN.md
> Phase 14, wave 6; ledger `fcop-fidelity.md` V1)
> Related: `rules`, `architecture`, `input` (owns the button word), `ui` (the caption)

---

## 1. Goal

The camera is Future Cop: L.A.P.D.'s Precinct Assault chase camera, number for
number. The RE reads it out of `view_player_camera_tick` (0x004456a0) and its
helpers in `src/game/frame/view_place.c`; `extracted/presentation/camera.json`
carries every table and rule with its source line, and
`bun run gen:presentation` copies the tables into
`packages/client/src/render/fcopPresentation.generated.ts`. The rules live in
`packages/client/src/render/camera.ts`.

> **Revision note.** v1 shipped one invented framing — 26° pitch, a 6 m dolly,
> a 58° FOV — under exponential damping with velocity look-ahead and a dead
> zone, on the plumbing of an earlier stepless pitch-and-zoom rig (`t`, two
> anchors, free-look pan). The owner's rule of 2026-10-13 (only the original
> counts) retired all of it: none of those numbers or behaviours is the
> original's.

## 2. Architectural principle (non-negotiable)

**The camera is 100 % client-local render state.**

- Not part of the simulation: it never reads the sim and never writes into it.
  It reads the interpolated avatar pose (`main.ts` `avatarPoses`) and the
  arena's static heightfield (`render/cameraTrace.ts`), nothing else.
- Not in lockstep: never serialized, never sent, never in a snapshot or input.
  The Camera Key's bit (`BTN_CAMERA`, `inputs.ts`) is cut before the sim sees
  the word, exactly as the Map Key's.
- Determinism-neutral: two clients on different cameras produce byte-identical
  simulations; the golden replays pass unchanged.
- No camera-driven gameplay.

### Time

The engine runs the camera once a frame with `dt` = the frame's 300 Hz ticks (at
least 8, at most 60) and `half_dt` = `(dt + carry) >> 1`. Metropolis runs it once a
render frame with the frame's real ticks (`dtSec × 300`, capped at 60), every
rule written as its continuous equivalent: the 1/32 turn per half tick composes
to `(31/32)^(ticks/2)` however the time is cut, and the rate caps, the retract,
the offset walk and the sink are linear in ticks. The subject is the
interpolated avatar, so 30 Hz sim steps never show.

## 3. The seven cameras

The Camera Key (binding slot 9, default Tab) steps `camera_name` by one on a
fresh press; 7 wraps to 0. Each name is a camera entry: a flag word and a row of
presets (the primary, then the fallbacks).

| # | Name | Flags | Presets | Pitch | Plane (wu) | Offset (wu) |
|---|---|---|---|---|---|---|
| 0 | Standard Camera | occlude | 0; 1, 2 | 330 (29.0°) | 55296 | (0, 16384, 0) |
| 1 | Close-Up Camera | close, occlude | 0; 1, 2 | 330 | 55296 | × 0.5 at the retract cap |
| 2 | Standard Side Camera | side, occlude | 0; 1, 2 | 330 | 55296 | (0, 16384, 0) |
| 3 | Close-Up Side Camera | close, side, occlude | 0; 1, 2 | 330 | 55296 | × 0.5 |
| 4 | Sky Camera | occlude | 5; 2 | 430 (37.8°) | 95344 | (0, 20480, 0) |
| 5 | Crowd Control Camera | closer | 18 | 255 (22.4°) | 36864 | (0, 22528, 0) × 0.414 |
| 6 | Crowd Control Side Camera | closer, side | 18 | 255 | 36864 | × 0.414 |

- **Side**: the base yaw is the fixed world yaw −0x400 (looking along map −y),
  whatever the mech faces; otherwise it is the hull's facing.
- **Close / closer**: the retract grows a unit a tick to 0x100 (close) or
  0x12c (closer), else shrinks to 0. It scales the offset by
  `(256 − retract/2)/256` and pulls the eye `retract × 128` wu along the view axis.
- **Crowd Control** holds only inside a type-95 trigger with the volume bit;
  anywhere else the name drops to 0 in the same frame, so the caption reads
  "Standard Camera". No Precinct Assault arena has such a trigger
  (camera.json `pa_volume_triggers`), so in Metropolis the key cycles
  Standard → Close-Up → Standard Side → Close-Up Side → Sky → Standard. Both
  Crowd Control cameras are defined and tested; they are unreachable by design.
- **Caption**: a press (and the view's construct) shows the camera's name for
  900 ticks (3 s), pen at text (2, 60) = (4, 120) at 640 × 480, font 3, text
  colour 8 (`render/hud/caption.ts`). A press while the view is paused (the map
  screen) does nothing.

## 4. A frame (`stepChaseCamera`)

1. **Sink**: the transform's progress, 0 walker … 0x10000 hover, ramped 160 a
   tick toward the form being entered; it lowers the aim point by `sink·21/256`
   (5376 wu on the hover).
2. **Height follower** (`view_track_height`): a cubic spring on the subject's
   height — `accel = Δ³ / 2^26`, the rate cleared when its sign disagrees,
   `rate += accel · half_dt`, a step of `(rate >> 14) · dt`, dropped under 256 wu
   a frame (held here as under 32 wu a tick, the engine's 8-tick frame), never
   past the gap. Small bumps are ignored; a storey is followed.
3. **Retract** and **caption** as above.
4. **Occlusion** (entries with the occlude bit): the live preset's eye is traced
   from the mech to the eye (`view_trace`: an anchor below 4 m pulls a higher
   eye toward it by midpoints first, then a terrain segment test with floors).
   Blocked, or a fallback live, for more than 120 ticks: a live fallback retries
   the primary first; otherwise the next fallback is probed (past the row's end,
   back to the first fallback) and goes live if clear. Metropolis traces the
   map's heightfield and decks (`render/cameraTrace.ts`) from 0.5 m above the
   feet, eye → anchor first as the original; a first hit on a see-through plate
   (material bit 7, `gen:viewterrain`: la-cantina's catwalks) is retraced from
   the anchor, and a second such hit, or none, is clear.
5. **Turn**: yaw toward base + the preset's yaw delta, pitch toward the preset's
   pitch, each `half_dt` steps of `(31·from + to)/32` the short way round, with
   the original's linear unit-a-step guarantee for small gaps; pitch capped at 2
   units a tick, yaw at 4. Time constant 63 ticks (0.21 s).
6. **Offset walk**: the smoothed offset moves 80 wu a tick toward the preset's.
7. **Place** (`view_chase_position`): the plane is `pitch_curve(turned pitch)` plus
   **half** the subject's (followed) height; the eye stands on it, pulled back
   from the aim point (the offset turned by the base yaw) along the turned yaw by
   `|cot(pitch)| × (plane − aim height)`, then pulled in by the retract.
   For a walker at height 0 this gives the converged eyes camera.json lists
   (Standard: 6.75 m up, 8.57 m behind; Close-Up 4.81 / 6.87; Sky 11.64 / 11.78).

8. **Shake** (`render/cameraShake.ts`, ledger V1): while the view's second damage
   meter (`meter_2`) is non-zero, the eye moves along the camera's up and then its
   right row by `((rand & (span − 1)) − span/2) << 3` world units, `span` the top
   bit of min(meter, 0xff), and the frame's ticks are spent from the meter. A hit
   adds a quarter of its share (`amount·5 << 10 / max` plus the first meter,
   clamped to 0x200, halved in Precinct Assault), an effect with +0x32 bit 4 or 13
   a quarter of 300 or 1000 within 16 m; nothing once the meter is above 0xff.

Not modelled: the transform's random shoulder camera
(word 23 is 1 in Precinct Assault, so it never fires), the locker's forced
preset 17 (no type-32 locker in a PA arena), the demo anchor.

## 5. Projection

The original projects in software with a focal of 1024 px at 640 × 480:
34.708° × 26.381° (tan = 5/16 × 15/64). Metropolis keeps the **vertical** field
of view, 26.381°, on every aspect ratio (three's `fov` is vertical): a 4:3
window sees exactly the original's frame, a wider one sees more to the sides,
never less height.

## 6. The debug cameras

`?cam=fly` (the free-fly camera, `render/flyCamera.ts`) and `?cam=orbit` stay:
they are debug tools (PLAN.md Phase 14's platform exceptions). Neither has a
caption.

## 7. Test / DoD

- [x] `packages/client/test/camera.test.ts`: the pitch curve against
      camera.json's table; the converged eye of all seven cameras against
      camera.json's `steady_state_walker_subject_y0` (within 8 wu); the plane's
      half-height rule; the sink; the vertical FOV.
- [x] The Camera Key cycles five cameras in Precinct Assault (Crowd Control
      drops to Standard), reaches seven inside a volume trigger, arms the caption
      for 900 ticks, does nothing while paused.
- [x] The turn: short way round, the 63-tick time constant, the 4/2-unit caps;
      30, 60 and 144 fps arrive at the same camera.
- [x] The occlusion machine: a blocked primary hands over to its first fallback
      after 120 ticks and comes back once clear.
- [x] Determinism: the golden replays pass unchanged.
- [ ] The owner's look against the original, side by side.
