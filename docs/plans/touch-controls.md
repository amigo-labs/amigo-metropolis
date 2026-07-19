# Touch / mobile controls — implementation plan

> Status: **LANDED** as PLAN.md Phase 11 (2026-07-19). The approach below was
> executed as written, with these deltas against the code that had landed since
> this plan was drafted:
>
> - **No tap-to-start card / lobby skip** — the Phase 7 title menu is the touch
>   entry point (its taps provide the audio gesture); deep links boot straight
>   in as before.
> - **No `rumble`** — the method left `LocalInputSource` with the splitscreen
>   removal; `input/gamepad.ts` is gone too, so the stick aim math lives in the
>   new pure `touchMapping.ts` instead of being copied from the gamepad device.
> - **Both sticks are camera-relative** via `movement.ts` (`cameraGroundForward`
>   basis refreshed in `updateAim`), matching the keyboard path; aim reuses the
>   `aimAssist.ts` "assist" magnetism exactly like `PlayerOneInput`.
> - The overlay module is `src/touchControls.ts` (flat beside `menu.ts` — no
>   `src/ui/` directory exists) and the section landed as **Phase 11**, not
>   "Phase 8" (Phases 8–10 shipped in the meantime).
> - Verified by `packages/client/test/touchMapping.test.ts` and
>   `bun run e2e:touch` (`tools/replay/src/touchInput.ts`).
>
> Original plan (pre-execution) below, kept for context.

> Status: planned, not started. Pulled forward from the `PLAN.md` backlog at the
> user's request. Independent of Phases 6 (online) and 7 (PWA). Client-only; the
> deterministic sim is untouched.

## Context

Today the client supports keyboard/mouse and gamepad only; there is zero
touch/pointer input, no responsive UI, and no PWA. Touch controls are listed as
post-v1 **backlog** in `PLAN.md` and "out of scope for v1" in `rules.md`.

Good news: the input layer was built device-agnostic in the Phase 5 splitscreen
work. `LocalInputSource` (`packages/client/src/input/types.ts`) already abstracts
every human device; adding touch is a new conformer + an on-screen control
overlay, with **no changes to the sim, snapshot, or netcode** (inputs reach the
sim only as the quantized `PlayerInput` axes/bitfield). Determinism is unaffected,
so **no golden regeneration** is needed.

Outcome: on a phone / coarse-pointer device (or `?touch`), a solo match starts;
the avatar drives with a left on-screen stick, aims with a right stick, and
transforms/jumps/interacts/fires-heavy/fires-special via on-screen buttons. No
page scroll/zoom. Desktop and splitscreen paths stay byte-for-byte unchanged.

## Approach (recommended)

Mirror the existing gamepad pattern exactly: a pure, unit-tested mapping module +
a stateful DOM/pointer source implementing `LocalInputSource`, wired into the
existing single-player boot path.

### Decisions (locked)
- **Entry:** `touchMode = !splitscreen && wantsTouch(params)`, where `wantsTouch`
  = `?touch=1` (force on) / `?touch=0` (force off) / else auto-detect
  `matchMedia("(pointer: coarse)").matches && (navigator.maxTouchPoints ?? 0) > 0`.
  Touch = **single local player (slot 0)**, composes with `?warden`/`?opponent`,
  **skips the lobby**, shows a minimal **tap-to-start** card (user-gesture hook,
  reuses `.lobby-card` styling), and **overrides `?cam=orbit`** (OrbitControls
  would fight the sticks for canvas pointers).
- **Events:** Pointer Events keyed by `pointerId` + `setPointerCapture` (unified
  mouse/touch/pen, multi-touch falls out naturally: left stick + right stick +
  a button held at once). Handle `pointerdown/move/up/cancel`.
- **Scheme:** dual **floating** sticks — left = analog move, right = aim
  (snap-to-unit, hold-last-facing) — each spawning where the finger first lands
  within its screen half. On-screen **buttons** for the non-stick bits: TRANSFORM,
  JUMP, INTERACT (hold-capable for buy/claim/capture), HEAVY (`FIRE2`), SPECIAL
  (`FIRE3`). **Primary fire (`FIRE1`) auto-fires whenever the aim stick is engaged
  past the deadzone** (twin-stick convention; the one documented behavioral
  difference vs desktop, trivially swappable for a dedicated button later).
- **Aim:** world-relative right stick like gamepad → `updateAim()` is a **no-op**
  (camera-independent, allocation-free). Reuses the gamepad aim math and the
  hold-last-facing that clears the sim's aim threshold (`sim.ts:574`,
  `magnitude² > 0.04`). Not tap/drag raycast (would need the camera each tick and
  collide with the button cluster).
- **Rendering:** DOM overlay (matches the existing DOM HUD). CSS classes live in
  `index.html`; elements are created by a new `ui/touchControls.ts` (like the
  `.hud` divs are created in `render/playerView.ts`), so desktop DOM stays clean.
- **Responsive HUD:** toggle `document.body.classList.add("touch")`; add
  `body.touch`-scoped CSS only, so every desktop/splitscreen path is untouched.
- **Zero-alloc:** `sample()` uses module-scope scratch `Vec2`s and a const button
  table (like `gamepad.ts`); reuses `stickWithDeadzone` + `quantizeAxis`.

### Files

**New**
- `packages/client/src/input/touchMapping.ts` — pure, no DOM/three. Reuses
  `stickWithDeadzone`/`STICK_DEADZONE`/`Vec2` from `input/gamepadMapping.ts` (do
  not reimplement); adds geometry constants, `TOUCH_BUTTONS: {id,label,bit}[]`
  (the analogue of `GAMEPAD_BUTTON_MAP`), `applyStick(dx,dy,radius,out)`, and
  `autoFirePrimary(aimEngaged)`. Unit-testable.
- `packages/client/test/touchMapping.test.ts` — mirror
  `test/gamepadMapping.test.ts`: Y-inversion, radius normalization + deadzone,
  `TOUCH_BUTTONS` bit uniqueness/coverage, auto-fire rule.
- `packages/client/src/ui/touchControls.ts` — `createTouchControls()` builds the
  overlay (container, two stick base+knob elements, one button per `TOUCH_BUTTONS`)
  and returns typed handles + `setStick(side, baseX, baseY, knobX, knobY, active)`
  + `dispose()`; `showTapToStart(): Promise<void>` renders the start card and
  resolves on first pointer down.
- `packages/client/src/input/touch.ts` — `class TouchInput implements
  LocalInputSource` (`label`, `hint`, `isConnected()=>true`, `updateAim(){}`,
  `sample(out)`, `rumble()` → optional `navigator.vibrate?.()`). Attaches pointer
  listeners with capture; bookkeeping via `pointerId → role` map, remembered aim
  unit vector (default `(1,0)`), pressed-button bitset; updates knob visuals via
  the handles. Aim/move mapping copied from `gamepad.ts:59-70` (Y-inversion +
  snap-to-unit + hold-last).
- `tools/replay/src/touchInput.ts` — Playwright touch E2E. **Reuses the existing
  `playwright-core` devDep** and the launch pattern from
  `tools/replay/src/browserVerify.ts` (`chromium.launch({ executablePath:
  CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" })`). Builds the client, serves
  `dist/` via a dependency-free `Bun.serve` static server, opens a
  `hasTouch:true,isMobile:true` context at `?touch&debug&seed=1`, taps start,
  then drives the left stick with synthetic `PointerEvent`s via `page.evaluate`
  and asserts `globalThis.metropolisSim` avatar position advances (poll on
  `metropolisSim.tick`, not fixed sleeps).

**Modified**
- `packages/client/src/main.ts` — add `touchMode` detection near the other param
  reads; instantiate `TouchInput` + controls only in touch mode; add
  `if (touchMode) showTapToStart().then(() => startMatch([{slot:0,input:touch}]))`
  as the first boot branch; in `startMatch`, gate the reticle line and the
  OrbitControls block with `!touchMode`; `document.body.classList.add("touch")`.
  No frame-loop/`runTick`/`sample` changes (device-agnostic already).
- `packages/client/index.html` — viewport meta → add
  `maximum-scale=1, user-scalable=no, viewport-fit=cover`; add `.touch`,
  `.touch-stick`, `.touch-knob`, `.touch-btn`, `.touch-start` CSS
  (`touch-action:none`, `user-select:none`, `env(safe-area-inset-*)` anchoring,
  `pointer-events` rules); add `body.touch{cursor:none}` and
  `body.touch .hud{…}` overrides.
- `PLAN.md` — remove "touch controls" from the Backlog line; add
  **"Phase 8 — Touch / mobile controls (pulled forward from backlog at user
  request)"** with a checklist mirroring the above and the DoD (below). Note it
  lands after Phase 5 and is independent of Phases 6–7.
- root `package.json` — add `"e2e:touch": "bun run tools/replay/src/touchInput.ts"`
  (documented, like `replay:verify:browser`, as needing a Chromium binary).

### Reuse (paths)
- `stickWithDeadzone`, `STICK_DEADZONE`, `Vec2` — `input/gamepadMapping.ts`.
- `quantizeAxis`, `BUTTON_FIRE1/2/3`, `BUTTON_TRANSFORM/JUMP/INTERACT`,
  `PlayerInput` — `@metropolis/sim` (`packages/sim/src/inputs.ts`).
- `LocalInputSource`, `Viewport` — `input/types.ts`.
- Aim snap-to-unit + hold-last + Y-inversion — `input/gamepad.ts:59-70`.
- DOM-element-per-view creation — `render/playerView.ts:35-37`.
- Overlay card styling — `.lobby-card` in `index.html`.
- E2E scaffold + `playwright-core` dep — `tools/replay/src/browserVerify.ts`,
  `tools/replay/package.json`.

### Risks / edge cases
- Multi-touch: first pointer into a zone owns that stick until its up/cancel;
  ignore a second pointer in the same zone; always `setPointerCapture` so a
  finger sliding off-screen still delivers `pointerup`; reset role on
  `pointercancel`.
- Scroll/zoom: `touch-action:none` + `preventDefault` on
  `touchstart`/`gesturestart`/`contextmenu` + viewport `user-scalable=no`.
- Allocation-free `sample()` (CLAUDE.md renderer rule): module scratch only.
- INTERACT bit stays set while held so `CONSOLE_HOLD_TICKS`/capture accumulate.
- DOM/three sources can't run under `bun test` (same as gamepad/keyboard); keep
  logic in the pure `touchMapping.ts`; behavioral coverage via the E2E.

## Verification
1. `bun run lint` (Biome) — clean.
2. `bun run typecheck` — new client files + `tools/replay` compile.
3. `bun test` — includes new `touchMapping.test.ts`; all 4 goldens still pass.
4. `bun run replay:verify` — goldens re-simulate identically (**no golden regen**;
   sim untouched).
5. `bun run e2e:touch` — new Playwright touch E2E: taps start, drags the left
   stick, asserts the avatar moves in-sim via the `?debug`→`globalThis.metropolisSim`
   hook. Optionally also assert a right-stick engage changes aim + auto-fires, and
   a JUMP button changes height.
6. Manual smoke: `bun run dev`, open `?touch&debug` in Chrome device-toolbar;
   drive/aim/fire, confirm no scroll/zoom and a readable HUD.

## Phase 8 DoD (for PLAN.md)
On a phone / emulated coarse-pointer device, `?touch` (or auto-detect) starts a
solo match; the avatar drives + aims via on-screen sticks and
fires/transforms/jumps/interacts via buttons; no page scroll/zoom; desktop and
splitscreen unchanged; sim untouched (no golden regen).

## Notes
- The two Copilot review comments this plan originally deferred (guard
  `navigator.getGamepads()` in `gamepad.ts`; exact viewport split + aspect clamp
  in `playerView.ts`) have since been **applied** on the Phase 5 branch — they are
  no longer part of this work.
- A follow-up option while adding the touch E2E: also commit a sibling
  gamepad/splitscreen E2E in `tools/replay/src/`, since the current Phase 5 note
  references a synthetic-gamepad smoke test that was run ad hoc but not committed.
