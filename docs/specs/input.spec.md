# SPEC — Input (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/input.spec.md`
> Status: v2 — the original's controls 1:1 (PLAN.md Phase 14, wave 3,
> SIM_VERSION 69–71)
> Related: `camera.spec` (the chase camera follows the hull), `netcode.spec`
> (consumes the input frame), RE `docs/behavior/camera-and-movement.md`
> "Input" (the source of every number here)

---

## 1. Goal

The original's controls, unchanged: **digital, tank-style**, the hull turned
by its turn buttons, the guns pointing where the hull points, the target lock
doing the aiming. Keyboard and gamepad, on the original's bindings and its
three presets, rebindable on the original's controls screen. **No mouse** in a
match — the original has none. **Touch waits for the modernisation**
(PLAN.md Phase 14): it was removed with the mouse look in wave 3 and comes back
only once the original stands.

> **Revision note.** v1 steered by an absolute heading: mouse X (or the right
> stick) turned the hull toward an aim vector, WASD moved camera-relative, the
> stick's length scaled the push, transform had its own key and the lock cycle
> steered the hull. All of that was Metropolis' own and is gone (SIM_VERSION 69).

**Core principle:** raw input is condensed **once per sim tick** into one
`PlayerInput` per player — the original's button word. Only that word is
synchronized and consumed by the sim.

---

## 2. The determinism boundary

The word is a u16 of buttons: nothing in it is a float, nothing depends on the
camera. Which physical key or pad control set a bit is client-local (the
bindings, §5); the bit is canonical. The sim derives every edge from the word
itself (§6).

---

## 3. `PlayerInput` (the shared contract)

```ts
/** Exactly one input per sim tick, per player: the original's button word. */
export interface PlayerInput {
  buttons: number; // u16 (packages/sim/src/inputs.ts)
}
```

The original samples fourteen binding slots into a 32-bit word and permutes it;
every bit the game reads lies in the upper half, so Metropolis' u16 is that word
shifted down sixteen. Wire and replay frame: `u16 LE buttons` = 2 bytes a
player (since protocol v2 and replay format 3; the 5-byte axes of v1 are
refused).

| bit | constant | slot | what it does |
|---|---|---|---|
| 0x4000 | `BTN_FORWARD` | 0 Move Forward | push along the facing |
| 0x8000 | `BTN_BACK` | 1 Move Backward | push against it |
| 0x2000 | `BTN_TURN_RIGHT` | 2 Turn Right | the facing grows (clockwise from above) |
| 0x1000 | `BTN_TURN_LEFT` | 3 Turn Left | the facing shrinks |
| 0x0400 | `BTN_GUN` | 4 Gun Weapon | weapon slot 0, held |
| 0x0200 | `BTN_ACTION` | 5 Action Key | held: the slow row; pressed: use |
| 0x0100 | `BTN_SPECIAL` | 6 Special Weapon | weapon slot 2, from its HELD latch |
| 0x0800 | `BTN_JUMP` | 7 Jump | the walker's jumps; the hover's brake |
| 0x0008 | `BTN_MAP` | 8 Map Key | client: the map screen (solo: with the pause; `render/mapScreen.ts`) |
| 0x0004 | `BTN_CAMERA` | 9 Camera Key | client: the next chase camera (`render/camera.ts`) |
| 0x0010 | `BTN_JINK_LEFT` | 10 Jink Left | strafe left |
| 0x0020 | `BTN_JINK_RIGHT` | 11 Jink Right | strafe right |
| 0x0040 | `BTN_HEAVY` | 12 Heavy Weapon | weapon slot 1, held |
| 0x0080 | `BTN_CHANGE_TARGET` | 13 Change Target | press: the next target in front |
| 0x0001 | `BTN_ESCAPE` | fixed | client: the in-game menu (dialog 0xa6) |

Map, Camera and Escape stay in the client; the sim masks them off
(`SIM_BUTTONS`).

---

## 4. What the word does (the sim)

- **Turning** (`systemAvatarMovement`): Turn Right wins over Turn Left. The
  walker turns 0x20 angle units a step less a term in its speed (105.5°/s at
  rest, 79°/s at a run), on the ground only, no ramp; the hover's rate ramps
  toward ±0x60 and the facing gains half of it a step (158°/s), from zero after
  a release or reversal.
- **The push** comes from the state the bits choose: forward over back, Jink
  Right over Jink Left; a fore/aft state with a jink is the diagonal (181/256 of
  the fore push along F ± R; the walker's not while Jump is held); the hover's
  brake (Jump) beats every direction; both jinks held cancel.
- **The slow row** (the Action Key held): half the push (walker 1.95 m/s fore
  and sideways, hover 4.69 / 1.47 m/s), no jump; Jump without forward or back is
  the walker's crouch. On slow forward, back or Jink Left the walker stops at a
  drop of over 0.1 m.
- **Transform** is a chord: Change Target and Action **held** together, read as
  a level — held through a change it starts the next. While a change runs, and
  on the ramp's last tick, only Gun, Heavy and Special survive.
- **Use** is the Action Key's press: capture, claim, buy one unit, start a lift.
- **The lock** (W2): auto-acquired within 12 m and ±12.5° of the facing every
  tick without one, held within ±25°; Change Target's press takes the next.
  The lock never turns the hull. Weapons fire along the facing or at the lock.

---

## 5. Bindings (client, never synchronized)

`packages/client/src/input/bindings.ts`, `keyboard.ts`, `gamepad.ts`,
`controlsStore.ts`:

- **Fourteen slots per player**, each a device and a code (a Windows virtual
  key, or a joystick control). Player 1's default is the original's keyboard
  preset:

  | Move | Turn | Jink | Gun | Heavy | Special | Jump | Action | Change Target | Map | Camera |
  |---|---|---|---|---|---|---|---|---|---|---|
  | NumPad8 / 5 | NumPad6 / 4 | NumPad7 / 9 | Space | Alt | Ctrl | Z | NumPad2 | NumPad0 | M | Tab |

  The transform chord is NumPad0 + NumPad2. Ctrl and Alt are either key of the
  pair. The browser reports physical keys, so the keypad keys work with NumLock
  off too.
- **Three presets** per player: Keyboard, Sidewinder Gamepad, Gravis Gamepad
  (the original's tables). As in the original, a gamepad plays only once its
  profile is chosen or a slot is bound to it.
- **The joystick**: the first pad's X and Y, each with a dead zone of a quarter
  of its own travel, read for the sign (Left / Right / Up / Down); buttons
  0..16; no second stick, no hat, nothing analogue. A standard pad's d-pad reads
  as the four directions — the original's gamepads reported their pad as X/Y.
- **The controls screen** (PREFERENCES > Controller Configuration, or the
  in-game menu's Controller): the original's dialog 0x71, both players'
  fourteen fields beside the action labels; click a field and press the key or
  pad control (the selected field is drawn inverted; an unnameable key beeps);
  "Select Default Profile" per player; Ok saves both tables, Cancel discards.
- **The bindings file**: localStorage, in the original's `controls.txt` form —
  fourteen lines per player, `<Device>: <name>` — under its rules: an unknown key
  name binds its first character, an unknown joystick name or a mouse line is
  refused, any failure puts both tables back to preset 0, the writer spells only
  digits and capitals itself.
- **Browser limits**: during a match the bound keys are kept from the browser
  (Tab, Alt, Space). Ctrl+Tab and Alt+Tab (Special + Camera on the defaults)
  belong to the browser and the OS and cannot be kept. Without a numeric
  keypad, rebind the movement keys.

The front end is the original's (wave 7, `ui.md` §4): mouse-driven, with the
dialogs taking the keyboard as Windows dialogs do; only a match reads the
bindings.

---

## 6. Sampling discipline

- Raw input is polled at render rate, but **one word is latched per sim tick**,
  just before it advances; the input applies to tick `T + inputDelay` (local
  2, online 3; `netcode.spec`).
- **Edges are derived in the sim**, as the original's four-state button
  trackers do: `pressed = bits & ~lastButtons`, `held = bits & lastButtons`,
  against the word as the latches saw it (filtered while a transform runs).
  `lastButtons` is a u16 and hashed.
- A tap that presses and releases between two samples is missed, as a press
  between two of the original's frames would be.

---

## 7. Go-Gate — v2

- [x] The original's button word, bindings, presets, dead zone and controls
      screen.
- [x] Transform as the chord; the slow row; Special from the held latch.
- [x] Ovmp's slippery ground (the walker's movement mode, SIM_VERSION 71).
- [x] The Camera Key's seven presets and the Map Key's map screen (wave 6;
      fcop-fidelity.md V1, V4). While the map screen is open the movement bits
      pan it and the X1 reads no buttons, as the original's parked view.
- [x] The controls screen's original look, and player 2's column (wave 7,
      fcop-fidelity.md F13): player 2's table is edited and stored, and is
      driven once there is a local second player.
- [ ] Touch, mouse, analogue sticks: modernisation, after the original stands.
