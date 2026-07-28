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
// v16: produced units follow the original Cnet road instead of cutting across it
//     — GRAPH_WAYPOINT_RADIUS, 0.5 m, split off from the hand-authored polylines'
//     WAYPOINT_RADIUS of 3 (issue #30). On a 1 m wall lattice a 3 m arrival radius
//     makes a unit leave the one path stage 2 validates, and the corner it cuts is
//     whatever the original built there: 32% and 35% of all ground-unit ticks on
//     proving-ground and bug-hunt were spent jammed against a wall, and units that
//     could not clear their own base apron never left it.
//     The map data moved with it, on all four single-storey arenas: stage 2 now
//     validates and opens the two legs it always generated but never checked — the
//     production console to the graph entry node, and the road's far end to the
//     enemy gate — and walks every segment the way a unit steps (0.1333 m for a
//     Runner, 0.0833 m for a Juggernaut, 5 cm either side of the centre line)
//     instead of in fixed 0.25 m slices. That ruler matters: `crossesWallX/Y` judge
//     a diagonal from the position at the START of the axis move, so sample spacing
//     decides which cell row the test lands in, and a road running exactly along a
//     lattice line — which the Cnet does constantly — comes out walled by the bit
//     one column over. Wall edits go from 99 to 117 bits on Mp, 242 to 283 on
//     Conft, 304 to 328 on Slim, 311 to 335 on Joke; every heightsPin is unchanged.
//     Slim's and Joke's team 1 also joins the road at a different node (#294/#305
//     instead of #292/#303): the Cnet's own base node is inside the base
//     structure's walls, and where a unit cannot walk to it, stage 2 picks the
//     nearest node on the same chain rather than deleting an extracted wall.
//     One consequence has to be said out loud, because a pinned test moved with
//     it: a difficulty-8 Warden no longer razes la-cantina's core against an idle
//     player. That win was waypoint skipping — at 3 m a unit at Mp's node #46
//     chained through #47 and #48 in one tick and beelined the core from 10 m out,
//     past the emplacements the road runs between. Same committed walls, radius 3
//     scores 128 core hits in three minutes and radius 0.5 scores none. The
//     objective itself is unchanged and still reachable: golden-07 still razes a
//     core once the defence is beaten, and paAttribution.test.ts now measures how
//     close an escorted push gets on each arena. What stops it is combat, and it is
//     quantified for issue #31 rather than papered over.
//     golden-05-fcop (urban-jungle) and golden-07-pa (la-cantina) re-record for
//     real hash change — new walls AND new movement. Goldens 01-04 (test-128 /
//     district-01) and golden-06 (layered-test) re-header only: no lane graph, so
//     GRAPH_WAYPOINT_RADIUS is never read on them.
// v17: the Warden plays the §9 objective, and a base's built-in guns stop carrying
//     the core's health (issue #31). Two rungs of the goal ladder were written for
//     the §1 loss condition and mis-fire when the loss condition is a core:
//       - WGOAL_DEFEND fired on any enemy ground unit within 55 m of its own gate.
//         Under §1 that unit IS the loss condition, so it outranks everything; under
//         §9 both bases emit a free Runner every 5 s, so it is the steady state and
//         not an emergency. Measured over ten-minute difficulty-8 matches, the
//         Warden spent 63%, 89% and 91% of its ticks on home defence on la-cantina,
//         urban-jungle and bug-hunt and never pushed at all. WARDEN_CORE_DEFEND_
//         RADIUS tightens it to 16 m — a ground unit's own reach, inside which
//         something is already shooting the base — and leaves the rest to the 20
//         emplacements that exist for it.
//       - WGOAL_CAPTURE outranked WGOAL_ESCORT unconditionally, so a Warden whose
//         push had arrived at the enemy core would leave it there and fly off for
//         its 30th pad: 67-75% of ticks capturing against 9% escorting. Under §9
//         arrival is where the work starts (300 unit-shots into 3000 HP with the
//         base answering), so WARDEN_PUSH_COMMIT_RANGE adds a rung above capture for
//         a push already inside the enemy base's envelope. Under §1 there is nothing
//         to escort — a unit that reaches the gate has already won — so both rungs
//         are gated on the arena carrying a core, exactly like every other §9
//         mechanic, and district-01 behaves as before.
//     Escort went from 0% of ticks to 34-80%, and home defence to 0.0%.
//     The map data moved in one field: BASE_DEFENCE_HP. A base's built-in guns had
//     `hp: base.health`, i.e. the core's 3000, because BaseShooter carries no health
//     of its own — a modelling choice of ours, like their position. Four 3000 HP guns
//     standing ON the core gate it at a unit's own 14 m reach: the unit halts, chips
//     at 8 dps and can never close to CORE_ATTACK_RADIUS while one lives. They now
//     take the 500 every Turret actor in the originals carries; coreHp keeps the
//     3000, which IS extracted. Only `bases[].defence[].hp` changed — 8 fields per
//     arena, verified structurally; every heights and walls pin is untouched.
//     Measured together, over ten minutes with the enemy stream off the field, core
//     damage went from 90 to 320 on la-cantina, 4 to 1073 on urban-jungle and 20 to
//     40 on proving-ground; an escorted push now reaches and damages the core on
//     three of the four arenas where before only la-cantina did.
//     No balance constant was turned. Two were measured and rejected, so a later
//     pass does not spend budget on them: BASE_TURRET_RESPAWN_TICKS is not monotone
//     (120 s wins urban-jungle outright but drops la-cantina from 320 to 130 mean
//     core damage) and CORE_DAMAGE_PER_SHOT scales an arriving siege linearly while
//     changing arrival not at all. A movement rule that let a unit close on a core
//     inside its own reach instead of halting was tried and reverted: it fixed
//     arrival on the two stuck arenas and cost more than it bought elsewhere
//     (la-cantina 320 to 10, urban-jungle 1073 to 5), because a unit that walks is a
//     unit that is not shooting.
//     golden-05-fcop (urban-jungle) and golden-07-pa (la-cantina) re-record for real
//     hash change — the guns' hp is in the tick hash from tick 0, and the Warden's
//     goals move golden-07's whole trajectory. Goldens 01-04 (test-128 / district-01)
//     and golden-06 (layered-test) re-header only: no core, so neither rung fires and
//     no base carries a `defence` list.
// v18: the hover judges a climb over its own footprint instead of over the 0.3 m
//     it covers in a tick, and its slope limit is validated against the geometry
//     it has to drive (issue #34). Two halves, both in `slopeBlocks`:
//       - HOVER_CUSHION_SPAN, 2.4 m — the avatar's footprint diameter. A step
//         steeper than the limit now blocks only if the ground a span further on
//         is over the limit too. Per tick the two readings are the same thing: on
//         a bilinear heightfield a 0.17 m kerb IS a 0.58-gradient wall while you
//         are on it, and a diagonal crossing of one cell is quadratic, so the
//         original's streets read as walls at 30 cm resolution. Measured on the
//         four arenas' Cnet edges, that blocked 68/518, 72/640, 32/315 and 75/661
//         — including 32 on la-cantina, the one arena whose roads the WALKER finds
//         clean, where 67 of the 70 blocking sub-steps were flat again within
//         2.4 m.
//       - AVATAR_HOVER_MAX_SLOPE, 0.35 -> 0.5. Never validated against the
//         original's terrain, per the issue. Over the span, la-cantina's road
//         network contains no sustained climb above 0.40, while on the other three
//         the sustained climbs run 0.35-1.5 with their mass at 0.50 and up — the
//         arenas' 1.3-3 m terrain steps, not their roads. So the old value sat
//         below the roads themselves and the new one admits the roads' own ramps
//         while still rejecting the terrain. The walker's 0.6 is clear above it.
//     Outcome, measured after the fact rather than tuned for (fcop-arenas.test.ts
//     pins all of it): hover-impassable edges 68->20 on urban-jungle, 72->44 on
//     proving-ground, 32->0 on la-cantina, 75->45 on bug-hunt; teams that can
//     drive their own road network end to end in hover 2 -> 7 of 8 (it was
//     la-cantina's two and neither team on any other arena); blocking steps
//     on the committed shortest road 19->1, 7->5, 0->0, 7->5. Ground the hover now
//     owns and the walker cannot take even with a jump: 2 edges each on
//     proving-ground and bug-hunt, which is rules.md §2's asymmetry appearing in
//     the original's terrain instead of only in a design note. The hover's step
//     ceiling is span × limit = 1.2 m, deliberately under the walker's 1.4 m jump.
//     What this does NOT do is make the original's roads uniformly drivable: the
//     1.3-3 m terrain steps issue #34 found are still there, still walls for a
//     form with no jump, and still pinned. "Transform or route around" survives as
//     an arena feature; it just stops applying to kerbs.
//     Nothing else moved: no map data, no walker rule. `slopeBlocks` computes the
//     walker's branch with the same operations in the same order as the inline
//     gate it replaces, and the goldens prove it — golden-02-combat is the ONLY
//     replay whose hash sequence changes, because it is the only one that drives
//     in hover (district-01, transform at t=20 s). Goldens 01, 03, 04 (walker on
//     test-128/district-01), 05 (urban-jungle), 06 (layered-test) and 07
//     (la-cantina) re-header only, byte-identical hash arrays.
// v19: Mid dual-team mid type-8 pads no longer join both rings AND capturable
//     spots (no triple stacks); BaseShooter guns are TURRET_BUILTIN; consoles face
//     pad/arena centre; real X1-Alpha walker/hover assemblies replace the
//     Quaternius stand-in; avatar drive is facing-aligned only (no strafe).
export const SIM_VERSION = 19;
