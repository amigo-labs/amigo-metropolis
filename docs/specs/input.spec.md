# SPEC — Input & Aiming (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/input.spec.md`
> Status: Draft v0.1 · Go-Gate open (§9)
> Related: `camera.spec` (supplies the yaw basis), `netcode.spec` (consumes `InputCommand`)

---

## 1. Goal

An input model that (a) fixes the FC weaknesses — **aim decoupled from
facing/camera**, real twin-stick instead of forced lock-on — and (b) fits cleanly
into the deterministic 30 Hz lockstep.

**Core principle:** raw input (mouse/keys/gamepad) is condensed **once per sim
tick** into a **deterministic, quantized `InputCommand`**. Only this command is
synchronized and consumed by the sim. Raw floats **never** reach the sim.

---

## 2. The determinism boundary (the most important part)

Aim and movement are derived locally from the camera — and the camera is
**client-local and non-deterministic** across clients (see `camera.spec`). That is
unproblematic, because:

1. The raycast (cursor → ground plane) and the camera-relative conversion run
   **locally in floats**.
2. The **result** (aim angle, movement intent in world coordinates) is
   **quantized** (fixed-point) and written into the `InputCommand`.
3. This command is transmitted. **All** client sims process the same quantized
   value identically.

> Mnemonic: *Aim is an input, not a sim computation.* The local, camera-dependent
> path to the value may be non-deterministic — the **transmitted value** is
> canonical.

---

## 3. `InputCommand` (the shared contract)

Compact, bit-packable (30 Hz → bandwidth counts). Fixed-point conventions from
`netcode.spec`.

```ts
/** Exactly one command per sim tick, per player. */
export interface InputCommand {
  readonly tick: number;          // sim tick this input applies to (T + delay)
  readonly moveIntent: FixVec2;   // world direction*magnitude, fixed-point, |v| ≤ 1.0
  readonly aimYaw: number;        // 16-bit "brads" (0..65535 = one turn), fixed-point angle
  readonly buttons: number;       // bitmask, HELD state (see §6)
  readonly edges: number;         // bitmask, press edges that occurred in the tick window
  readonly deploy: DeployCommand | null; // Precinct-Assault purchase/deploy, optional
  readonly lockTarget: number | null;    // optional target entity ID (soft-lock, §4.3)
}

export interface DeployCommand {
  readonly unitType: number;      // enum (Hovertank/Dreadnought/Heli/Superplane…)
  readonly lane: number;          // lane index from map.spec OR
  readonly point: FixVec2 | null; // fixed-point target point (if freely placeable)
}
```

`FixVec2` = two fixed-point components (def. in `netcode.spec`). Wire encoding:
bit-packing, only populated fields; `deploy`/`lockTarget` via a flag bit.

---

## 4. Aim model

### 4.1 Mouse + keyboard (primary)
- Ray from camera through cursor → intersection with the ground plane
  (`y = groundHeight`) → world target point.
- Aim = yaw from the unit to the target point (about the up axis), quantized to
  **16-bit brads**. For a top-down-leaning shooter the ground-plane yaw suffices
  as the core.
- The unit orients to `aimYaw` — **independent of movement direction** (this is
  the FC modernization).

### 4.2 Gamepad
- **Right stick = aim direction directly** (twin-stick). Stick vector → yaw →
  brads.
- **Left stick = camera-relative movement** (§5).
- This is the clean two-stick control the PS1 lacked for want of a DualShock.

### 4.3 Vertical targets (helis, superplane)
- Precinct Assault has flying units. **Automatic elevation**: weapons aim
  vertically at the acquired/locked target automatically; the player controls
  only the ground yaw. The sim computes the elevation deterministically from the
  target entity's position.

### 4.4 Soft-lock — configurable, two modes

History: the original had **no** free aiming — it auto-acquired the nearest target
(red aim line), target choice only via a target-switch key. Free-aim is our
modernization; soft-lock is the deliberate, **configurable** callback to the FC
feel.

Setting `aimAssistMode: "off" | "assist" | "lock"` — the two soft-lock modes are
**assist** and **lock**, `off` = pure free-aim.

| Mode | Behavior | Transmitted channel | Resolution |
| --- | --- | --- | --- |
| `off` | pure free-aim (mouse raycast / right stick) | `aimYaw` | — |
| `assist` | free-aim primary, aim is pulled locally toward the nearest target in the cone (magnetism) | `aimYaw` (shaped) | **local**, before quantization |
| `lock` | hard lock onto an entity, aim tracks it automatically; target cycle via key | `lockTarget` (+ `aimYaw` as fallback) | **in the sim**, every tick |

**Assist (magnetism):**
- Candidate = nearest valid target within `assistConeDeg` around the current
  free-aim.
- The free-aim yaw is interpolated up to `assistStrength` toward the candidate — a
  **local input-shaping stage BEFORE quantization**. It only shapes the player's
  own, already-transmitted `aimYaw`. No sim intervention, no cross-client
  divergence.
- `lockTarget = null`. The player keeps control at all times.

**Lock (tracking):**
- The target-cycle key (bit 6) selects/switches the locked entity →
  `lockTarget = entityId` in the command.
- The **sim** computes the aim (yaw + auto-elevation) every tick deterministically
  from the current target position → perfect tracking in sim time.
- **Fallback**: `aimYaw` continues to be sent along. If `lockTarget` is invalid
  (target dead/out of range), the sim uses `aimYaw` and the lock is released
  (re-lock via key).
- Target-acquisition policy (nearest / cone / air priority) → §9.

**Determinism consequence:** the *mode* is local config; **what** is transmitted
differs (`aimYaw` for off/assist, plus `lockTarget` for lock) — but both fields
already exist in the `InputCommand`. **No protocol change.**

---

## 5. Movement (camera-relative)

- Input intent is a 2D vector in **screen/camera space** (up = away from the
  camera).
- Conversion into world coordinates via the **read-only yaw** from `camera.spec`,
  then **quantized** → `moveIntent`.
- Keyboard (WASD): normalized direction vector, |v| = 1. Analog stick: magnitude
  is preserved (walk/run).
- Here too: the camera-relative conversion happens **locally before
  quantization**; the world intent is what's transmitted.

---

## 6. Actions & buttons

`buttons` = HELD state per tick, `edges` = press edges that occurred in the tick
window (so fast taps between two ticks are not lost). The sim derives release
edges deterministically from the tick-to-tick diff of `buttons`.

Bit assignment (proposal):

| Bit | Action | Type |
| --- | --- | --- |
| 0 | Fire — Gun (light) | held |
| 1 | Fire — Heavy | held |
| 2 | Fire — Special | held/edge (manual detonation à la FC plasma flare) |
| 3 | Jump | edge |
| 4 | Transform (walker ↔ pursuit) | edge |
| 5 | Action/Interact | edge |
| 6 | Target-Cycle (soft-lock) | edge |

Purchase/deploy runs through `deploy` (a discrete command), not through bits.

---

## 7. Sampling discipline

- Raw input is polled at **render rate**, but **one command is latched per sim
  tick**.
- Press edges within the tick window are accumulated (OR into `edges`) so a tap
  shorter than one tick does not disappear.
- **Quantization is the determinism boundary**: after latching the value is
  canonical. Never a raw float into the sim.
- The command applies to tick `T + inputDelay` (see `netcode.spec`).

---

## 8. Local config (never synchronized)

These only affect the production of `raw input → InputCommand`:
- Keybindings / gamepad mapping
- Mouse sensitivity, stick deadzones, invert
- **`aimAssistMode`** (`off` / `assist` / `lock`) + parameters: `assistConeDeg`,
  `assistStrength`, target-acquisition policy
- (later) further aim-assist fine-tuning

They are applied **before** quantization. Only the finished, quantized command is
ever transmitted → no determinism risk. The `lock` mode additionally sends
`lockTarget`; the sim resolves the tracking (§4.4).

---

## 9. Open questions (Go-Gate)

- [ ] Aim representation: confirm pure ground yaw (16-bit brads), or do we need a
      pitch channel after all for manual air aiming? (Recommendation: yaw +
      auto-elevation via `lockTarget`.)
- [ ] Soft-lock: confirm the two modes as `assist` + `lock` (alongside `off`) — or
      was a different mode pair meant?
- [ ] Target-acquisition policy for both modes: nearest / in cone / air priority —
      and auto-reacquire after target loss in `lock` mode (recommendation: release
      → free-aim, re-lock via key)?
- [ ] Default values for `assistConeDeg` / `assistStrength` (to be tuned in
      playtest).
- [ ] Mode switch: only in the menu, or also via hotkey mid-match?
- [ ] Local view prediction of the own unit under input delay: v1 without (keep
      delay low) — confirm? (The rollback path defuses this anyway, see
      `netcode.spec`.)
- [ ] `deploy`: lane index vs. free point — depends on `map.spec`.
- [ ] Special fire: held or tap-to-fire + tap-to-detonate (FC behavior)?
