# SPEC — Camera System (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/camera.spec.md`
> Status: Draft v0.1 · Go-Gate open (see §11)
> Related: `rules`, `architecture`, `input` (TBD)

---

## 1. Goal & guiding idea

A modern, readable camera for a Precinct-Assault successor. The reference is the
**vertical view change** of *Future Cop: L.A.P.D.* (there a `SELECT` cycle over
fixed presets: standard → close-up → side → sky).

Design translation:
- **Keep:** the *idea* of a continuum from "tactically high up" (Precinct-Assault
  overview) to "up close" (action). That is the actual DNA.
- **Discard:** discrete preset steps and the movement-coupled "drunken camera"
  that automatically swings behind the player. That was the PS1 compromise and
  the main weakness.
- **New:** a **stepless pitch-and-zoom rig** with a single control parameter,
  damping-smoothed, with a fixed world orientation as the default.

---

## 2. Architectural principle (non-negotiable)

**The camera is 100 % client-local render state.**

- [ ] Not part of the simulation. The camera never reads from the sim state and
      never writes into it.
- [ ] Not in lockstep. Camera state is **never** serialized, **never** sent over
      the Durable-Object relay, **never** included in snapshots/inputs.
- [ ] Determinism-neutral: two clients with completely different camera state
      (zoom, pan, pitch) must produce a **byte-identical** simulation. The camera
      touches no RNG, no tick, no ordering.
- [ ] No camera-driven gameplay: no visibility/fog, no aim-assist, no hit logic
      that depends on the camera angle. Everything is sim-authoritative.

### Sim/render cadence
- Simulation: fixed **30 Hz tick** (lockstep).
- Render: `requestAnimationFrame`, variable `dt`.
- The camera follows the **interpolated** render transform of the target unit
  (alpha blend between the two most recent sim snapshots) — **never** the raw
  sim position (otherwise 30 Hz stutter).
- The camera update runs per render frame with real `dt`. All damping is
  **framerate-stable** (exponential/spring with `dt`, not a fixed lerp per frame).

---

## 3. Camera model

Orbit-follow rig around a focus point (`focus`), rendered via a
`THREE.PerspectiveCamera`.

Derivable parameters:

| Parameter | Meaning |
| --- | --- |
| `focus: Vec3` | Target point on the ground (interpolated unit position + `focusHeight`) |
| `t: number ∈ [0,1]` | **View continuum**: `0` = ACTION (low, near), `1` = TACTICAL (high, far) |
| `pitch` | interpolated from `t` (elevation above horizon) |
| `distance` | interpolated from `t` (dolly) |
| `fov` | interpolated from `t` |
| `yaw` | azimuth; **default world-fixed (north-up)**, optionally manual |
| `lookAhead: Vec3` | focus offset toward movement/aim |

`t` is the player's only "view" control — the stepless replacement for the
`SELECT` cycle. `pitch`, `distance`, `fov` are pulled together from `t` via
easing (one control, coherent framing).

### Yaw policy
- **Default: world-fixed** (map always oriented the same way, MOBA-typical).
  Solves the FC aim/facing problem: the camera does **not** automatically rotate
  behind the movement.
- **Optional: manual rotation** (key press/drag). Never automatically coupled to
  movement.

---

## 4. Behavior

### 4.1 Follow & damping
- `focus` follows the interpolated unit point via a **critically damped spring**
  (or exponential smoothing), `dt`-based.
- `t`, `yaw` are likewise damped toward their target values (`tTarget`,
  `yawTarget`).
- Small **deadzone** around `focus` to avoid micro-jitter while standing still.

### 4.2 Look-ahead
- Offset of the focus toward the unit velocity (from two interpolated positions)
  and/or aim direction, scaled up to `lookAheadMax` at top speed. Gives the
  player more visibility in the direction of travel.

### 4.3 Transform awareness (walker vs pursuit)
- Additive **bias** on `tTarget`, not an override:
  - **Pursuit/Hover (fast):** slightly toward TACTICAL + more look-ahead
    (speed framing).
  - **Walker (precise):** slightly toward ACTION (nearer, for melee accuracy).
- Player input on `t` always wins against the bias (the bias only shifts the
  resting point).

### 4.4 Tactical free-look (MOBA)
- In the upper `t` range (`t ≥ tFreeLookThreshold`): the focus may be
  **decoupled from the unit** — RTS-style edge-pan / drag / keys, to survey
  lanes, towers and bases (purchases, deploys).
- A **recenter** key snaps `focus` back onto the unit (damped).
- Below the threshold the focus stays hard on the unit.

---

## 5. Input coupling

The camera provides the input/movement layer only a **read-only basis** (yaw
frame). It does not drive any unit movement itself.

- **Movement = camera-relative:** movement input is translated against the camera
  `yaw` into a world direction (screen-relative "up = away from the camera").
- **Aim = independent:** targeting via mouse raycast onto the ground plane (or the
  right stick). **Aim is decoupled from facing/camera** — the central
  modernization vs. FC.
- Boundary: camera → provides `yaw`/basis. Aim & movement → belong to input+sim,
  not to this spec.

---

## 6. Data types (contract)

```ts
// docs/specs/camera — reference types (render layer, NOT in the sim module)
export type Vec3 = { x: number; y: number; z: number };

/** Anchor of one view end; ACTION = t0, TACTICAL = t1. */
export interface ViewAnchor {
  readonly pitchDeg: number;   // elevation above horizon
  readonly distance: number;   // world meters dolly
  readonly fovDeg: number;
}

export interface CameraRigConfig {
  readonly action: ViewAnchor;        // t = 0
  readonly tactical: ViewAnchor;      // t = 1
  readonly focusHeight: number;       // raise of the focus above ground
  readonly yawLocked: boolean;        // default true (north-up)
  readonly followSmoothTime: number;  // s, spring time constant for focus
  readonly paramSmoothTime: number;   // s, for t/pitch/distance/fov
  readonly yawSmoothTime: number;     // s
  readonly lookAheadMax: number;      // world meters at top speed
  readonly tFreeLookThreshold: number;// edge-pan allowed from here up
  readonly transformBias: number;     // +/- on tTarget per mode
  readonly deadzone: number;          // world meters
}

export interface CameraState {
  readonly focus: Vec3;      // damped focus (world)
  readonly t: number;        // current view value [0,1]
  readonly yaw: number;      // rad
  readonly panOffset: Vec3;  // free-look offset from the unit (tactical only)
}

export interface CameraInput {
  readonly zoomDelta: number;    // wheel/pinch → shifts tTarget
  readonly yawDelta: number;     // optional, only when !yawLocked
  readonly panDelta: Vec3;       // edge/drag (tactical only)
  readonly recenter: boolean;    // snaps panOffset → 0
  readonly snapPreset: number | null; // optional tTarget snap
}

/**
 * Per render frame. Reads INTERPOLATED target values (render layer),
 * never raw sim state. No effect on simulation/determinism.
 */
export function updateCamera(
  prev: CameraState,
  input: CameraInput,
  followTargetInterpolated: Vec3,
  followVelocity: Vec3,
  isPursuitMode: boolean,
  cfg: CameraRigConfig,
  dt: number,
): CameraState;
```

The rig output (camera position/rotation) is computed deterministically from
`CameraState` + `cfg` for the renderer and written to the `PerspectiveCamera`.

---

## 7. Default parameters (starting values, to be tuned in playtest)

| Field | Value | Note |
| --- | --- | --- |
| `action.pitchDeg` | 30 | low action angle |
| `action.distance` | 14 | near |
| `action.fovDeg` | 55 | |
| `tactical.pitchDeg` | 62 | high overview, not quite top-down (readability) |
| `tactical.distance` | 34 | far |
| `tactical.fovDeg` | 50 | |
| `focusHeight` | 1.0 | ~unit center |
| `followSmoothTime` | 0.12 | s |
| `paramSmoothTime` | 0.18 | s |
| `yawSmoothTime` | 0.15 | s |
| `lookAheadMax` | 4.0 | world meters |
| `tFreeLookThreshold` | 0.7 | |
| `transformBias` | 0.15 | Pursuit +, Walker − |
| `deadzone` | 0.15 | world meters |

> The numbers are deliberately starting values. Tune `pitch`/`distance`
> together; the `t` curve may use easing (e.g. smoothstep) instead of linear.

---

## 8. Occlusion / collision (later, optional)

With mostly top-down-leaning framing this is secondary. At low `t` (ACTION)
geometry can occlude the unit:
- Option A: soft dolly-in on an occluder raycast camera→unit.
- Option B: fade/dither the occluder.
- Deferred for v1; track as its own ticket.

---

## 9. Non-goals (v1)

- No scripted/cinematic camera.
- No first-person/cockpit view.
- **No** automatic yaw swing behind the movement (deliberately against FC).
- No split-screen (net title over the DO relay → one camera per client).

---

## 10. Test / DoD

- [ ] `updateCamera` unit-tested: damping at 30/60/144 fps `dt` converges the
      same (framerate-stable).
- [ ] Determinism test: identical sim inputs → identical sim hash, independent of
      the camera actions of two clients.
- [ ] No import from the sim module into the camera module (lint boundary /
      dependency rule).
- [ ] The camera reads exclusively interpolated render transforms.
- [ ] Free-look recenter, zoom, transform bias verified visually.

---

## 11. Open questions (Go-Gate)

- [ ] Confirm yaw default **world-fixed** (recommendation: yes); manual rotation
      as an option yes/no?
- [ ] `t` curve linear or smoothstep? (recommendation: smoothstep for softer
      framing)
- [ ] Free-look model: edge-pan, drag, or both?
- [ ] Aim model final: mouse raycast onto the ground plane as primary, right
      stick as the gamepad equivalent — fix it here or split into its own
      `input.spec`?
- [ ] Occlusion in v1 or v2?
