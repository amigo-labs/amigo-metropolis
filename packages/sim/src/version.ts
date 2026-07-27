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
// v11: FCOP arena features re-authored from original Cact X1Alpha spawns
//     (interior playable shelves, not outer apron/rim). Heightfields/walls
//     unchanged; spawn/base/lane spots move. golden-05 (urban-jungle) re-records
//     for real hash change; goldens 01–04/06 only re-header for SIM_VERSION.
// v12: FCOP feature connectivity pass — base consoles/rings and midfield
//     turret/outpost spots snapped onto the spawn wall-component so unit buy
//     and neutral capture are reachable (hover/walker share crossesWall*).
//     Heightfields/walls unchanged. golden-05 re-records for real hash change;
//     goldens 01–04/06 only re-header for SIM_VERSION (district-01/test maps).
// v13: Precinct Assault mode (rules.md §9) — per-turret weapon profiles with gun
//     slew and FOV, the original Cnet lane graph traversed via committed next-hop
//     signposts, free base production, destructible base cores as the win
//     condition, power-ups and base-intrusion alerts. Every mechanic is gated on
//     per-arena map data, and hash() appends its new blocks behind the same
//     guards, so on a map without PA features the byte stream is bit-identical to
//     v12 — goldens 01-06 re-header only, none of their hash sequences move
//     (goldenNoop.test.ts is the proof). la-cantina is the only arena carrying
//     the data, and golden-07-pa — added in this same version — is the first
//     golden recorded on it, so it has no earlier sequence to preserve. Any
//     later change to a PA mechanic moves golden-07 and only golden-07.
// v14: the other three single-storey FCOP arenas rebuilt from their own original
//     logic (issue #30 — the same one-Til frame error #26 fixed on la-cantina).
//     urban-jungle (Conft), proving-ground (Slim) and bug-hunt (Joke) now carry
//     the full Precinct Assault data set — capture pads, ring turrets, built-in
//     base defence, weapon profiles, pickups, intrusion volumes, props, both Cnet
//     lane graphs, cores and production — so each adopts rules.md §9 for itself
//     and the picker is deliberately mixed-mode. proving-ground and bug-hunt also
//     stop sharing one hand-authored layout (convert.ts's RIM_* constants): they
//     are different missions with different logic, and importing splits them.
//     NO sim mechanic changed. Terrain did not change either: every heightsPin is
//     byte-identical, and fcop-arenas.test.ts asserts it rather than assuming it.
//     Walls DID change, on all FOUR single-storey arenas, and la-cantina moving is
//     the part that needs saying out loud: stage 2's lane carve deduped its edges
//     as if the Cnet were undirected, and the Cnet is entirely one-way — not one
//     of Mp's 315 edges or Conft's 518 has a reverse twin — so every edge pointing
//     at a lower node index was silently skipped, 69 of Mp's and 186 of Conft's.
//     The roads they run down stayed half-walled, which is how Conft's committed
//     route ended up crossing a wall no produced unit can pass. Carving all
//     directed edges, and adding the bases' own consoles and ring turrets to the
//     reachability repair (without them Conft, Slim and Joke generate clean and
//     play unbuyable), takes Mp from 66 edited bits of 4009 to 99 — 2.5%, and
//     moves la-cantina's wallsVPin/wallsHPin.
//     Only golden-05-fcop (urban-jungle) re-records for real hash change, and
//     goldenNoop.test.ts re-freezes it with that justification. golden-07-pa
//     re-headers only DESPITE la-cantina's walls moving: its recorded 120 s
//     trajectory never touches one of the 33 newly-cleared bits, so its hash
//     array is byte-identical. That is a measured outcome, not a claim that the
//     arena is unchanged — the wall pins in fcop-arenas.test.ts moved.
//     Goldens 01-04 (test-128 / district-01) and golden-06 (the synthetic
//     layered-test) re-header only, byte-identical hash arrays.
//     hollywood-keys and venice-beach are deliberately NOT in this version — see
//     layeredArenas.test.ts for the measurement that blocks them.
// v15: base ring turrets get the original Turret actor's own weapon profile and
//     gun rotation, which v13 imported for the capturable pads and the built-in
//     base guns but not for the ring. spawnBaseTurret left weaponProfile at -1, so
//     32 of la-cantina's 72 turrets fell through to the global TURRET_RANGE of
//     28 m against an imported engage_range of 6 m — 4.7x their reach, with no
//     slew and a 20-tick delay instead of 16. Measured consequence (see
//     paAttribution.test.ts): on an idle match the ring did 100% of the damage
//     that killed produced units, from 16-28 m, entirely outside the 14 m a Runner
//     can shoot back from. The two production streams never even engaged each
//     other. Reach, delay, slew and FOV all come from the extracted data and are
//     identical to the pads' — they intern to the same profile, so `weapons` stays
//     at 2 entries per arena.
//     Turret HP comes from the same data in the same pass, for the ring AND the
//     capturable pads: the original gives both `health` 500, where the sim used
//     ARCHETYPE_MAX_HP[TURRET] — a value its own comment calls a Phase-1 dummy.
//     Together with the 6 m reach that turns a turret from a long-range sniper
//     that dies in 12 s into a short-range emplacement worth 10 s of avatar
//     primary fire (48 dps) from outside its own range, which is the shape the
//     original has. district-01's sandbox dummies keep the placeholder, so no
//     pre-PA arena moves.
//     This is a fidelity fix, not a balance change: no constant in balance.ts
//     moved, and TURRET_DAMAGE stays the one invented number (issue #31).
//     Two golden-07 assertions moved WITH the behaviour rather than against it:
//     pushes now reach an enemy base and trip its intrusion volumes (0 alarms in
//     120 s before, 16 after), and "clear the enemy turret line and the core can
//     be razed" needed its stand-in widened — at 28 m a team's OWN ring shredded
//     the incoming enemy stream for it, so clearing one side's turrets used to be
//     sufficient. At 6 m the enemy's units survive to the mid-line, so the
//     stand-in now also holds that stream back, which is what escorting means.
//     golden-05-fcop (urban-jungle) and golden-07-pa (la-cantina) re-record for
//     real hash change; goldens 01-04 (test-128 / district-01) and golden-06
//     (layered-test) re-header only — none of those arenas has a ring profile.
export const SIM_VERSION = 15;
