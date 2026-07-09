# SPEC — Netcode & Determinism (amigo-metropolis)

> Target repo: `amigo-metropolis` · Location: `docs/specs/netcode.spec.md`
> Status: v1 — matches the shipped netcode (Phase 6); remaining §9 items are explicit v2 upgrades
> Related: `input.spec` (defines `InputCommand`), `camera.spec` (render-only, never synchronized)

---

## 1. Goal & model

Deterministic **lockstep** over a **Cloudflare Durable Object** relay. The core
setup is 1v1 (Precinct Assault). The sim runs **on the clients**; the DO
coordinates inputs and orders ticks. In lockstep we synchronize **only inputs**,
never world state — which requires **hard determinism**. A desync = a ruined
match, so determinism is decision No. 1.

---

## 2. Determinism substrate (the critical decision — resolved)

### The hazard
- IEEE-754 base operations (`+ − × ÷`, `sqrt`) **are** specified as correctly
  rounded (round-to-nearest-even) and are bit-identical across JS engines/OS/CPU.
- **Transcendental functions** (`Math.sin/cos/tan/atan2/exp/pow/hypot`) are the
  real danger: ECMAScript leaves them implementation-defined, so they differ
  across engines and silently desync lockstep titles.

### Decision (shipped): pure-TS float64 over a restricted, IEEE-exact op subset
`packages/sim` is a **pure-TypeScript** simulation — no Rust, no WASM, no
fixed-point (CLAUDE.md: *"TypeScript only … The sim is portable pure TS."*).
Determinism is guaranteed not by integer state but by **restricting which float
operations the sim may use** to exactly the ones IEEE-754 pins:

- **Allowed arithmetic:** `+ − × ÷`, `Math.sqrt`, `Math.floor/ceil/abs/min/max/sign`,
  `Math.imul` and integer bitwise ops — all correctly-rounded / exactly-specified
  and identical on V8/JSC/SpiderMonkey. JS additionally has **no FMA contraction**
  and **no x87 extended-precision** intermediates, so `a*b + c` rounds the same
  everywhere.
- **Banned in the sim:** every engine-dependent `Math.*` transcendental.
  Trigonometry comes from `simMath.ts` — a committed **sine lookup table**
  (`sinTable.ts`, `sinLUT`/`cosLUT`) and a **polynomial `atan2`**, identical on
  every client. Prefer direction vectors + normalize over angles wherever possible.
- **Angles:** radians as doubles, quantized through the LUT. There is no brad
  representation in the sim; the `input.spec` aim field is a quantized direction
  vector (see that spec).
- **RNG:** seeded **mulberry32**, stored in the sim state and advanced only inside
  the tick. Never `Math.random` in the sim.
- **Hash:** a 32-bit **FNV-1a** over the canonical serialized state every tick
  (`hash.ts`). Golden-replay tests assert the full hash sequence and run across
  browsers — the empirical proof that the restricted-float approach stays
  bit-identical in practice, not just in theory.

### Determinism hygiene (enforced)
- No `Date.now()`/`performance.now()`/locale/async ordering in the sim path.
- **Stable iteration order:** entity storage is a dense array indexed by entity
  id, iterated in id order; never over unsorted `Map`/`Set`/object keys.
- Cosmetics (particles, audio, UI) use a **separate** non-sim RNG so they can
  never disturb the sim.

### Deferred alternatives (considered, NOT adopted)
Kept on record; neither is planned, because the shipped approach already passes
cross-browser golden replays:
- **Fixed-point integers (Q16.16 …)** — a "harder" guarantee in theory, but in JS
  it needs `BigInt` or hi/lo-split multiplies, adding complexity and bug surface
  for no real gain over the restricted-float subset that already works. Revisit
  only if goldens ever drift on a target platform.
- **Rust → WASM sim core** — would add a build toolchain + a JS↔WASM bridge and a
  rewrite of the working TS sim, and contradicts the repo's TypeScript-only
  charter. Its one unique upside is a **server-side shadow sim** in the Durable
  Object for anti-cheat (§5) — a speculative v2+ concern, not a v1 need.

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

Transport: **WebSocket** to the DO via the **Hibernation API** (shipped — keeps
an idle room cheap).

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

## 9. Go-Gate — resolved for v1

- [x] **Substrate:** pure-TS float64 over the restricted IEEE-exact op subset +
      LUT trig (shipped; §2). Fixed-point / Rust→WASM explicitly deferred.
- [x] **Lockstep:** delay-based, confirmed. Local input delay is 2 ticks; online
      input is sent 3 ticks ahead and only server-confirmed frames are stepped
      (Phase 6). Rollback stays a v2 upgrade — the sim is already save/restore +
      re-simulate capable (§4).
- [x] **Laggard fallback:** the relay stalls the tick barrier and the client
      shows a "waiting for opponent" overlay; no last-input repetition in v1.
- [x] **Fixed-point format:** moot — no fixed-point (see §2).
- [x] **Hash interval:** N = 30 ticks (shipped). Reconnect fast-forwards the DO's
      confirmed-frame log (§8); a separate periodic checkpoint-snapshot cadence K
      stays a later optimization, not required for correctness.
- [ ] **Anti-cheat (v2):** v1 is a pure trust relay. A DO shadow sim remains the
      one strong reason to revisit a Rust→WASM core; unscheduled.
