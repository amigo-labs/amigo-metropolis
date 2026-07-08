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
export const SIM_VERSION = 6;
