// Bumped on ANY change that alters the hash sequence of an existing replay
// (see docs/specs/architecture.md §7 — the DO rejects mismatched rooms).
// v2: Phase 1 state layout (weapon/timer/aim fields, per-player state) and
//     the walker/hover movement model.
// v3: Phase 1 combat — weapons, projectiles, damage/death/respawn, sandbox
//     dummy turrets, points stub (hash covers dummy spot state).
// v4: hover traction split into accel/brake/coast (stick-dependent grip).
// v5: Phase 2 — base ring turrets (60 s respawn), ammo/repair pad, console
//     unit purchases, unit movement/targeting, win check; dummies neutral;
//     hash covers winner, lane counters and ring turret slots.
// v6: Phase 3 — points economy (starting balance, trickle, earn table,
//     hold-to-buy costs), capturable neutral turrets, outposts with claim /
//     forward spawn / console destruction; hash covers the new ledgers.
//     (Phase 4's Warden did NOT bump this: its state is hashed only in
//     matches that enable it, so every existing replay's hash sequence is
//     unchanged — goldens 1–3 prove it. Warden config travels in the replay
//     header, format 2, and in the online handshake.)
//     (Phase 6's online lockstep did NOT bump this either: protocol.ts is pure
//     byte (de)serialization of inputs/hashes and never touches the tick, so
//     every golden's hash sequence is unchanged. The wire framing has its own
//     PROTOCOL_VERSION; SIM_VERSION is what the DO checks to reject mismatched
//     rooms — a hash-affecting change bumps it and desyncs are impossible by
//     construction between matched peers.)
// v7: soft-lock aiming (input.spec §4.4 "lock") — a per-player target held in
//     the sim, acquired/cycled by the new BUTTON_TARGET_CYCLE and hashed. The
//     button fits the existing u8 (no wire/replay format change), so goldens are
//     re-recorded only for the new hash sequence; their input scripts never
//     press the bit, so the trajectories (and the golden 02/03/04 event beats)
//     are byte-for-byte unchanged — only the hash bytes differ.
// v8: wall collision (FCOP arenas stage 2) — edge blockers on grid lines
//     (map wallsV/wallsH) gate every axis move of avatars and ground units
//     (collision.ts). Wall-free maps are provably untouched: the helpers
//     early-out on empty wall arrays, so goldens 01–04 keep byte-identical
//     hash arrays (re-recorded only for this header version). Peers on
//     opposite sides of this bump would diverge on any walled arena.
// v9: line of sight (FCOP arenas stage 3) — segmentBlocked (grid DDA over the
//     same wall lattice) gates hitscan rays, turret/unit target acquisition,
//     the soft-lock and projectile flight (shells burst on the near side).
//     Same no-op invariant as v8: empty wall arrays early-out, so goldens
//     01–04 keep byte-identical hash arrays; golden-05 (urban-jungle, walled)
//     legitimately re-records — its shots now stop at walls.
// v10: layered movement (FCOP arenas stage 5) — N stacked walkable surfaces per
//     (x,y) via MapData layerHeights/layerMask + a per-entity layer side array,
//     resolveHeight/resolveWalker, per-deck ground-unit separation. Single-story
//     maps are a proven No-op: empty layer arrays early-out and entLayer is
//     hashed only on layered maps, so goldens 01–05 keep BYTE-IDENTICAL hash
//     arrays (headers re-recorded only — see goldenNoop.test.ts). golden-06 is
//     new (the synthetic 3-deck layered-test map). Peers across this bump would
//     diverge on any layered arena, so the DO gate rejects the mismatch.
export const SIM_VERSION = 10;
