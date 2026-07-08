# SPEC — Netcode & Determinism (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/netcode.spec.md`
> Status: Draft v0.1 · Go-Gate open (§9)
> Related: `input.spec` (defines `InputCommand`), `camera.spec` (render-only, never synchronized)

---

## 1. Goal & model

Deterministic **lockstep** over a **Cloudflare Durable Object** relay. The core
setup is 1v1 (Precinct Assault). The sim runs **on the clients**; the DO
coordinates inputs and orders ticks. In lockstep we synchronize **only inputs**,
never world state — which requires **hard determinism**. A desync = a ruined
match, so determinism is decision No. 1.

---

## 2. Determinism substrate (the critical decision)

### Problem
- IEEE-754 base operations (`+ − × ÷ sqrt`) are specified and consistent across
  platforms.
- **Transcendental functions** (`Math.sin/cos/tan/atan2/exp/pow/hypot`) are
  **not** bit-identical across JS engines/OS/CPU — the spec allows
  implementation-defined results. This is exactly where lockstep titles desync
  silently.

### Recommendation: **fixed-point integer simulation**
The only approach with a **hard** cross-platform guarantee.

- Sim state entirely in **integers** (no float in the sim path).
- Representation: **Q16.16** (32-bit) as the default. Multiplication needs a
  64-bit intermediate → `BigInt` **or** a high/low split; addition/subtraction in
  `| 0` range, `Math.imul` where sensible. Document value ranges/overflow
  explicitly.
- **Angles as 16-bit brads** (0..65535 = one turn) — matches `aimYaw` from
  `input.spec`.
- Deterministic math lib:
  - `sqrt`: integer Newton-Raphson.
  - `sin/cos`: **LUT** with fixed-point interpolation (identical table on all
    clients).
  - `atan2`: fixed-point approximation/LUT.
- **RNG**: a seeded integer PRNG (PCG/xorshift), **part of the sim state**,
  advanced only in the sim tick. No `Math.random` in the sim.

### Strong alternative: **Rust → WASM as the sim core**
Recommended to evaluate, because it fits your stack excellently:
- Integer fixed-point in Rust is trivially deterministic, portable and fast.
- Reusable in the DO (Workers support WASM) for a later **server-side shadow sim**
  (anti-cheat).
- Synergy with `amigo-engine` (a deterministic Rust sim, your existing muscle).
- Trade-off: WASM/JS bridge + build complexity vs. a pure TS sim. With a "TS sim",
  fixed-point stays mandatory.

### Determinism hygiene (applies to both paths)
- No `Date.now()`/`performance.now()`/locale/async ordering in the sim path.
- **Stable iteration order**: only arrays with deterministic sorting; entity IDs
  assigned deterministically; no ordering over unsorted structures.
- Cosmetics (particles, audio, UI) use a **separate** non-sim RNG so they can
  never disturb the sim.

---

## 3. Sim/render loop (client)

- **Fixed 30 Hz accumulator** for the sim. Render via `rAF` with variable `dt`.
- Render **interpolates** between the two most recent sim snapshots (alpha) — the
  camera follows the interpolated state (`camera.spec`).
- The sim **never** runs directly on the `rAF` `dt`.

---

## 4. Lockstep procedure

### Recommendation: **delay-based lockstep, rollback-ready** (v1)
- All clients advance tick `N` only once the inputs of **all** players for `N` are
  available.
- **Input delay** `D` (ticks) hides latency: local input for now applies to tick
  `T + D`. Start: **D = 2–3** (≈ 66–100 ms). Adaptive later possible.
- Rationale: Precinct Assault is action, but not frame-1 twitch, and the core is
  1v1 — delay-based is easier to get **correct** than rollback and feels
  acceptable at low `D`.

### Rollback-ready from day 1
Even if v1 does not roll back, the sim **must** support from the start:
- **Save/restore** of the complete sim state in O(compact) — trivially
  serializable with fixed-point integer state.
- **Re-simulation** from a snapshot over an input log.

That makes the upgrade to **GGPO-style rollback** (predict remote inputs → on
divergence roll back + re-simulate) a later additive step, not a rewrite. It also
defuses the input delay then.

---

## 5. Role of the Durable Object

The DO is an **authoritative relay + input orderer + tick barrier**, **not** a
full sim server (the sim stays on the clients, the DO stays cheap).

Responsible for:
- Match/session lifecycle, membership, **seed and config distribution** (both
  clients start bit-identical).
- Receiving the per-tick `InputCommand`s, ordering/stamping, **broadcasting the
  confirmed input set** per tick.
- Tick cadence/laggard handling (input timeout → defined fallback: "repeat the
  last input" or pause briefly).
- **Desync detection** (§7): collect and compare periodic state hashes.
- **Input log** for reconnect/late-join (§8).

Transport: **WebSocket** to the DO (evaluate the Hibernation API for cost).

### Security trade-off (deliberate)
- A pure relay means a client could send illegal inputs. v1 accepts this (trust
  model).
- Upgrade path: the DO validates input **ranges** (lightweight) or runs a
  **shadow sim** with the same deterministic core (WASM in the DO). This is also
  why the Rust→WASM core (§2) is attractive here.

---

## 6. What is synchronized — and what is not

| Synchronized (deterministic, lockstep) | Local (never synchronized) |
| --- | --- |
| `InputCommand`s (see `input.spec`) | Camera (`camera.spec`) |
| Seed, match config | Audio, particles, cosmetic RNG |
| Tick numbers | UI, local config/keybindings |
| periodic state hashes | View prediction (if any, render-only) |

---

## 7. Desync detection & recovery

- Every **N ticks** (start: N = 30 ≈ 1 s) each client computes a **hash of the
  complete sim state** (fixed-point → stable hash, e.g. FNV-1a/xxhash over the
  serialized integer state) and sends it to the DO.
- The DO compares. **Mismatch → desync**: abort the match, dump both states for
  diffing (dev tooling).
- Cheap but essential — the only reliable safeguard against silent determinism
  drift.

---

## 8. Reconnect / late-join

- Since the sim is deterministic and the DO holds **seed + config + input log**, a
  returning client catches up by **fast-forwarding** the input log from the last
  **checkpoint snapshot** (fast-forward).
- Periodic checkpoints (state snapshot every K seconds) bound the replay length.
- Spectator late-join analogous.

---

## 9. Open questions (Go-Gate)

- [ ] Substrate final: **TS fixed-point** or **Rust→WASM core**? (Recommendation:
      evaluate Rust→WASM — determinism guarantee, DO reuse, `amigo-engine`
      synergy.)
- [ ] Lockstep: confirm delay-based v1 with `D = 2–3`; plan rollback as v2?
- [ ] Laggard fallback: input repetition vs. pause?
- [ ] Fixed-point format: is Q16.16 sufficient, or do large maps/precision need a
      bigger Q or 64-bit?
- [ ] Fix the checkpoint interval K and the hash interval N.
- [ ] Anti-cheat: accept a pure trust relay in v1, shadow sim as v2?
