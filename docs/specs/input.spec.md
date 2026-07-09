# SPEC — Input & Aiming (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/input.spec.md`
> Status: v1 — reconciled with the shipped input model (Phase 0/1/3) plus the
> soft-lock addition; remaining §9 items are explicit future work
> Related: `camera.spec` (supplies the yaw basis), `netcode.spec` (consumes the input frame)

---

## 1. Goal

An input model that (a) fixes the FC weaknesses — **aim decoupled from
facing/camera**, real twin-stick instead of forced lock-on — and (b) fits cleanly
into the deterministic 30 Hz lockstep.

**Core principle:** raw input (mouse/keys/gamepad) is condensed **once per sim
tick** into a **deterministic, quantized `PlayerInput`**. Only this frame is
synchronized and consumed by the sim. Raw floats **never** reach the sim.

---

## 2. The determinism boundary (the most important part)

Aim and movement are derived locally from the camera — and the camera is
**client-local and non-deterministic** across clients (see `camera.spec`). That is
unproblematic, because:

1. The raycast (cursor → ground plane) and the camera-relative conversion run
   **locally in floats**.
2. The **result** (aim direction, movement intent in world coordinates) is
   **quantized** (int8) and written into the `PlayerInput`.
3. This frame is transmitted. **All** client sims process the same quantized
   value identically.

> Mnemonic: *Aim is an input, not a sim computation.* The local, camera-dependent
> path to the value may be non-deterministic — the **transmitted value** is
> canonical.

---

## 3. `PlayerInput` (the shared contract — as shipped)

One flat, fixed-size struct per player per tick (`packages/sim/src/inputs.ts`);
the same 5 bytes are the replay frame and the network frame (`protocol.ts`,
`replay.ts`). No fixed-point/brads — the sim runs on the restricted-float subset
(see `netcode.spec` §2), so axes are int8 and aim is a quantized **direction
vector**, not an angle.

```ts
/** Exactly one input per sim tick, per player. Axes are int8 [-127,127]. */
export interface PlayerInput {
  moveX: number;  // world move intent x, int8 (camera-relative before quantize, §5)
  moveY: number;  // world move intent y, int8
  aimX: number;   // aim direction x, int8 (unit vector, decoupled from movement, §4)
  aimY: number;   // aim direction y, int8
  buttons: number; // u8 HELD bitfield (see §6)
}
```

Wire/replay frame: `i8 moveX, i8 moveY, i8 aimX, i8 aimY, u8 buttons` = 5 bytes,
per player. The tick a frame applies to is positional (frame index = tick), not
a field. Deliberate divergences from the original v0.1 draft, kept because the
shipped model is simpler and already correct:

- **No `edges` field.** The sim derives press edges itself by diffing `buttons`
  against the previous tick's (`state.lastButtons`), so edge-triggered actions
  (jump, transform, target-cycle) need no separate channel (§7).
- **No `deploy` field.** Purchasing is Precinct-Assault console interaction:
  stand on a base/outpost pad and hold **Interact** to buy (rules.md §3,
  `systemBuy`). Which unit spawns is chosen by the pad, not a transmitted enum —
  so no deploy command travels on the wire.
- **No `lockTarget` field.** Soft-lock `lock` mode is resolved entirely in the
  sim from the **Target-Cycle button** (§4.4); the target id is never
  transmitted, so the wire format is unchanged and no client-sent id is trusted.
- **Aim is a direction vector, not 16-bit brads.** Both encode a heading; the
  int8 XY vector is what the sim consumes for facing and weapons.

---

## 4. Aim model

### 4.1 Mouse + keyboard (primary)
- Ray from camera through cursor → intersection with the ground plane
  (`y = groundHeight`) → world target point.
- Aim = the unit→target direction on the ground plane, quantized to the int8
  `aimX/aimY` vector. For a top-down-leaning shooter the ground-plane heading
  suffices as the core.
- The unit orients to the aim vector — **independent of movement direction**
  (this is the FC modernization). Shipped (`systemAvatarMovement`).

### 4.2 Gamepad
- **Right stick = aim direction directly** (twin-stick). Stick vector →
  `aimX/aimY`.
- **Left stick = camera-relative movement** (§5).
- This is the clean two-stick control the PS1 lacked for want of a DualShock.

### 4.3 Vertical targets (helis, superplane) — deferred
- Precinct Assault has flying units. The intended model is **automatic
  elevation**: weapons aim vertically at the locked target while the player
  controls only ground yaw, with the sim computing elevation deterministically
  from the target position.
- **Not yet implemented:** avatar weapons are currently ground-plane only
  (hitscan/projectiles ignore height), so there is no elevation channel to
  drive. Tracked as a v2 item alongside the soft-lock `lock` mode (§4.4).

### 4.4 Soft-lock — configurable, two modes

History: the original had **no** free aiming — it auto-acquired the nearest target
(red aim line), target choice only via a target-switch key. Free-aim is our
modernization; soft-lock is the deliberate, **configurable** callback to the FC
feel.

Setting `aimAssistMode: "off" | "assist" | "lock"` — a LOCAL client setting
(`?aim=`, §8), never synchronized. `off` = pure free-aim.

| Mode | Behavior | What travels | Resolution |
| --- | --- | --- | --- |
| `off` | pure free-aim (mouse raycast / right stick) | `aimX/aimY` | — |
| `assist` | free-aim, magnetically pulled toward the nearest enemy in a cone | `aimX/aimY` (shaped) | **local**, before quantization |
| `lock` | hard lock onto an enemy, facing tracks it; cycle via a key | the **Target-Cycle** button | **in the sim**, every tick |

**Assist (magnetism)** — shipped, `packages/client/src/input/aimAssist.ts`:
- Candidate = nearest enemy whose direction is within `ASSIST_CONE_COS` (25°
  half-cone default) of the current free-aim.
- The free-aim unit vector is interpolated up to `ASSIST_STRENGTH` (0.5 default)
  toward the candidate — a **local input-shaping stage BEFORE quantization**. It
  only shapes the player's own transmitted aim: no sim intervention, no
  cross-client divergence (`netcode.spec` §2). Defaults are playtest-tunable (§9).

**Lock (tracking)** — shipped, in the sim (`systemAvatarMovement`, `cycleLockTarget`):
- The **Target-Cycle** button (bit 6, edge-triggered) acquires the nearest enemy
  or, when already locked, cycles to the next by ascending entity id. The lock is
  per-player sim state (`state.lockTarget`), so it resolves identically on every
  peer — **no target id is transmitted**.
- While a valid lock is held, the sim overrides facing to point at the target
  every tick (perfect tracking). The transmitted `aimX/aimY` is the fallback.
- The lock **releases** when the target dies, leaves `AVATAR_LOCK_RANGE`, or the
  holder dies — falling back to free aim (re-lock via the key).
- **Auto-elevation** for flying targets (§4.3) is deferred: avatar weapons are
  ground-plane only today, so there is no vertical channel to drive yet.

**Determinism consequence:** the *mode* is local config. `off`/`assist` change
only the locally-shaped `aimX/aimY`; `lock` adds one held button bit that fits
the existing u8. **No wire/replay format change** in any mode.

---

## 5. Movement (camera-relative)

- Input intent is a 2D vector in **screen/camera space** (up = away from the
  camera).
- Conversion into world coordinates via the **read-only yaw** from `camera.spec`
  (the camera's ground-forward, `cameraGroundForward`), then **quantized** →
  `moveX/moveY`. Shipped in `movement.ts`, keyboard + gamepad.
- Keyboard (WASD): normalized direction vector, |v| = 1. Analog stick: magnitude
  is preserved (walk/run).
- Here too: the camera-relative conversion happens **locally before
  quantization**; the world intent is what's transmitted.

---

## 6. Actions & buttons

`buttons` = HELD state per tick, `edges` = press edges that occurred in the tick
window (so fast taps between two ticks are not lost). The sim derives release
edges deterministically from the tick-to-tick diff of `buttons`.

Bit assignment (as shipped, `packages/sim/src/inputs.ts`):

| Bit | Constant | Action | Type |
| --- | --- | --- | --- |
| 0 | `BUTTON_FIRE1` | Fire — primary (light hitscan) | held |
| 1 | `BUTTON_FIRE2` | Fire — heavy (also the buy-heavy modifier) | held |
| 2 | `BUTTON_FIRE3` | Fire — special | held |
| 3 | `BUTTON_TRANSFORM` | Transform (walker ↔ hover) | edge |
| 4 | `BUTTON_JUMP` | Jump | edge |
| 5 | `BUTTON_INTERACT` | Action / Interact (hold to buy/claim/capture) | held |
| 6 | `BUTTON_TARGET_CYCLE` | Target-cycle (soft-lock, §4.4) | edge |

Bit 7 is free. Purchase runs through Interact + console-pad presence (rules.md
§3), not a discrete deploy command. (This renumbers the v0.1 draft's proposal —
Transform/Jump were swapped — to match the code, which is the source of truth for
replays and the wire frame.)

---

## 7. Sampling discipline

- Raw input is polled at **render rate**, but **one `PlayerInput` is latched per
  sim tick** (sampled just before the tick advances).
- **Press edges are derived in the sim**, not transmitted: each tick the sim
  computes `buttons & ~lastButtons` to fire edge actions (jump, transform,
  target-cycle), so there is no separate `edges` channel.
- **Quantization is the determinism boundary**: after latching, the int8/u8
  values are canonical. Never a raw float into the sim.
- The input applies to tick `T + inputDelay` (local delay 2, online 3; see
  `netcode.spec`).
- **Deferred refinement:** because only the held state is sampled per tick, a tap
  that both presses and releases *between* two samples can be missed. A future
  sub-tick edge-accumulator (the v0.1 draft's `edges`) would close that gap; at
  30 Hz sampled from a faster render loop it is rarely observable, so it is
  unscheduled.

---

## 8. Local config (never synchronized)

These only affect the production of `raw input → PlayerInput`:
- Keybindings / gamepad mapping
- Mouse sensitivity, stick deadzones, invert
- **`aimAssistMode`** (`off` / `assist` / `lock`) — shipped via `?aim=`
  (`aimAssist.mode`); `assist` uses `ASSIST_CONE_COS` / `ASSIST_STRENGTH`
- (later) further aim-assist fine-tuning

They are applied **before** quantization. Only the finished, quantized input is
ever transmitted → no determinism risk. `lock` mode does **not** transmit a
target — it sends only the Target-Cycle button and the sim resolves the tracking
(§4.4), so it too is protocol-neutral.

---

## 9. Go-Gate — resolved for v1

- [x] **Aim representation:** a quantized int8 direction vector (`aimX/aimY`), not
      brads. Manual air-pitch is out; auto-elevation via lock is deferred (§4.3).
- [x] **Soft-lock modes:** `off` / `assist` / `lock` as shipped (§4.4).
- [x] **Target-acquisition (lock):** nearest within `AVATAR_LOCK_RANGE` on
      acquire, then cycle by ascending entity id; on target loss it releases to
      free-aim and re-locks via the key.
- [~] **`assistConeDeg` / `assistStrength`:** defaults 25° / 0.5 shipped; the feel
      pass stays open like the other playtest passes.
- [ ] **Mode switch:** currently boot-time (`?aim=`); an in-menu / mid-match
      toggle is future UI work.
- [x] **Local view prediction:** v1 has none — the delay is kept low (2/3 ticks)
      and the rollback path (`netcode.spec` §4) defuses it later.
- [x] **`deploy`:** not adopted — purchasing is console-pad + hold-to-buy
      (rules.md §3), so the lane-vs-point question is moot.
- [ ] **Special fire:** held today (bit 2). Tap-to-fire + tap-to-detonate (FC
      plasma-flare behavior) stays a possible future refinement.
