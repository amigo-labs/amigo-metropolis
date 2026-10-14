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
// v20: the Warden suppresses what is stopping its push instead of only escorting
//     it (issue #31, item 5 — "the Warden has never been tuned against a
//     base-destruction objective"). WGOAL_SUPPRESS, one rung inside the existing
//     commit gate: when a push has arrived, the Warden first asks what is in the
//     way (`emplacementBlocking`, the live enemy turret nearest the push tip within
//     WARDEN_SUPPRESS_RADIUS) and closes to WARDEN_SUPPRESS_DISTANCE on it; escort
//     stays the goal when the way is clear.
//     What the measurement found, which is not what PLAN.md and paAttribution
//     recorded: the Warden was NOT stuck fighting an attrition war near its own
//     base. Over ten-minute difficulty-8 matches against an idle player it already
//     arrived — 64-86% of its ticks on ESCORT, a mean 34-43 m from the enemy core,
//     its push tip at 75-82% of the lane, i.e. inside WARDEN_PUSH_COMMIT_RANGE the
//     whole time. It simply could not shoot: it held a target for 1-18% of the
//     match and landed 1.6-9.3k damage where its own cooldowns allow ~66k.
//     The reason is geometry, and it rules out both cheaper fixes. A base
//     emplacement sat inside its 42 m cannon range for 60-89% of the match and was
//     VISIBLE for 0-7% of it (bug-hunt: 0% of 18000 ticks). Sampling 64 directions
//     around every defending emplacement on all four arenas, one is shootable from
//     8-17% of them at 8 m and from ~0% at 20 m and beyond — the arenas' wall
//     lattice is dense city geometry, so no standoff position exists for ANY
//     shooter. That kills "move the Warden somewhere with line of sight" (there is
//     nowhere) and it kills "let a flying entity see over walls" (that deletes the
//     arenas' cover model for everything that flies, and since an emplacement's own
//     reach is 6 m it would make the Warden unanswerable). What is left is what a
//     player does: come down the street the turret guards and trade inside its
//     reach.
//     Outcome over five seeds x ten minutes, difficulty 8 vs an idle player, core
//     hits and defending emplacements destroyed: la-cantina 24 -> 300 hits and the
//     core razed on 5/5 seeds (it resolved on none before), bug-hunt 0 -> 9 hits
//     with 5 -> 40 defenders, proving-ground 5 -> 37 defenders, urban-jungle
//     unchanged within noise (0 -> 2 hits, 17 -> 16 defenders). So issue #31's
//     bug-hunt throughput gap moves by 8x and its "resolves nothing in ten minutes
//     on any of the four" becomes "on three of the four" — both gaps still open on
//     proving-ground and urban-jungle, where the Warden now clears defenders faster
//     than before and the ring's 60 s respawn still replaces them faster than that.
//     The cost is real and shows up as RETREAT going 0-18% -> 2-19%: point-blank
//     means inside the emplacement's own reach, so the Warden trades hp for the
//     kill and cycles home to repair, and it stops body-blocking the enemy stream
//     at the mid-line (enemy ground deaths 99-117 -> 33-119). That trade is why
//     urban-jungle is a wash rather than a gain.
//     No balance constant was turned and no map data moved; the two new constants
//     are the goal's own geometry. golden-07-pa (la-cantina, difficulty-8 Warden)
//     is the ONLY replay whose hash sequence moves, and it is the only one that
//     runs a Warden on an arena carrying a core: golden-04-warden is district-01,
//     where the rung sits inside `hasCore(enemy)` and is unreachable, and
//     golden-05-fcop is urban-jungle with no Warden at all. Goldens 01-06 re-header
//     only, byte-identical hash arrays.
// v21: the avatar's weapon catalog adopts the original's numbers (rules.md §2).
//     Seven of the nine weapons exist in Future Cop, and their damage and cadence
//     now come from the game's own front-end panels — one 134x40 bitmap per
//     weapon in `febmp.bin`, a firing-rate bar and a damage bar in a 55 px
//     trough, bar length = value. Read independently of the RE handoff by
//     counting green and red pixel runs; all 15 panels reproduce its table, and
//     the five Special-slot panels are 134x39, which is why a naive size filter
//     finds only ten.
//     Anchored PER SLOT, because the bars are ratios: each slot's index-0 weapon
//     keeps its existing numbers and the rest scale against it inside that slot.
//     A global anchor was tried and rejected — it puts Hell Fire's cooldown at 7
//     ticks instead of 24. Within a slot the ratios land on what this game
//     already had, so only the gun slot really moves: Gatling Laser 12/6 -> 8/5,
//     Flamethrower 14/3 -> 24/5, Concussion Beam 110 -> 127 damage, Mortar
//     Launcher 72 -> 60 tick cooldown and 120 -> 119 damage.
//     NO GOLDEN'S HASH SEQUENCE MOVES, and that is a consequence of the anchors
//     rather than luck: the anchors are the historic PRIMARY_/HEAVY_/SPECIAL_
//     constants, loadouts never enter a replay file or the wire, and every golden
//     runs the default kit. All seven re-header only — byte-identical hash arrays,
//     goldenNoop.test.ts unchanged.
//     What DOES force the bump is the Concussion Beam moving from the Special
//     slot to the Heavy slot, where the original files it (`Beam Cannon`, id
//     0x12; the high nibble is the slot). Loadout indices are positional, so the
//     same index means a different weapon across this bump — `special: 2` used to
//     be the beam and now clamps to the Mortar Launcher, `heavy: 3` used to clamp
//     to the Rail Cannon and is now the beam. Two peers on opposite sides of the
//     bump, given a non-default kit, would run different weapons off identical
//     inputs. That is exactly the desync the DO's version gate exists to refuse.
//     (Separate finding, not fixed here: loadouts are client-local URL params and
//     travel in neither the replay header nor the online handshake, so two peers
//     with DIFFERENT kits desync within one version too. That is its own issue.)
// v22: la-cantina becomes the multi-deck arena its source terrain always
//     described, and walls are attributed to the deck they stand on (issue #29).
//     Two changes, one of which turns out to be inert:
//     (a) PER-LAYER WALL LATTICES. MapJson's `layers[]` may now carry their own
//         wallsV/H, MapData exposes layerWallsV/H, and crossesWallX/Y +
//         segmentBlocked take a trailing `layer` that defaults to 0. The
//         `layer === 0 || layerWallsV.length === 0` early-out is the no-op
//         invariant, same shape as resolveHeight's since v10: every map without
//         per-deck lattices runs the pre-existing code path untouched.
//     (b) la-cantina emits its decks (2398 cells over the roads, 108 above
//         those) and its GROUND lattice instead of the union over all decks. 632
//         of its 4009 wall bits stand on a bridge or a plinth; charging them to
//         the road underneath is what stage 2 then had to carve back open, so the
//         carve drops from 56 bits to 37 and the ring repair from 10 to 2.
//     Only ONE golden runs on la-cantina and only its hash sequence moves:
//     golden-07-pa. Goldens 01-06 re-header only, byte-identical hash arrays.
//     WHAT ACTUALLY MOVES THE HASH is narrower than the change: measured against
//     the escort scenario, the thinner ground lattice changes nothing to the tick,
//     and the per-deck lattices change nothing either, because barely anything
//     ever stands on a deck here. Zeroing the deck masks reproduces the old arena
//     exactly. The delta is resolveWalker selecting a deck at all — one produced
//     unit spends 30 ticks on a bridge and comes back down, which cascades. That
//     is the movement change #29 called for, and it is why this is a version bump
//     rather than a data-only commit.
//     Nothing was lost in the split: union(ground, decks) is bit-for-bit the
//     lattice mp-walls.json carried before it, pinned in
//     tools/generators/test/fcopWalls.test.ts. la-cantina's heightsPin does NOT
//     move — no height changed — and the terrain .glb's independent correlation
//     against the heightfield IMPROVED, 0.939 to 0.982, because the art has
//     always had geometry at those deck heights and now has somewhere to match.
// v23: feature `layer` on map features (issue #33) + Cnet ground_cast on lane
//     nodes, with units snapping onto a node's surface when close. hollywood-
//     keys and venice-beach adopt stage 2. Single-storey wall lattices rebuild
//     with a few bits moved (road carve); la-cantina's 26 bridge nodes carry
//     layer 1. Default layer 0 is a no-op on district-01 / test maps.
// v24: issue #31 balance close-out.
//     (a) BASE_TURRET_RESPAWN_TICKS 60→120 s — the ring no longer regenerates as
//         fast as one superplane clears it.
//     (b) On §9 arenas a living ground tip always outranks CAPTURE for
//         suppress/escort (commit-range alone left urban-jungle capturing 34% of
//         ticks with tip mid-map).
//     (c) Warden soft-target wall pierce: hitscan and target acquisition may
//         hit enemy ground units through the lattice (superplane altitude), but
//         emplacements still need LOS — cover stays real for the standoff case
//         that motivated WGOAL_SUPPRESS. urban-jungle's mid-map free-production
//         stream was 80% LOS-blocked; silencing that stream alone razed the
//         core in ~200 s, and with (c) all four arenas resolve 5/5 seeds.
// v25: catalog drop-ins (issue #48). Append-only; default loadout / goldens
//     header-only.
// v26: catalog locked to the ten Precinct Assault weapons (rules.md §2):
//     4 guns / 3 heavies / 3 specials. Default kit Mini-Gun · Hell Fire · Mortar.
//     SPECIAL_* is Mortar; Pop-Up Mines + Shockwave Generator as specials 1–2
//     (place / self-centred pulse). Loadout indices renumber — peers on opposite
//     sides of the bump with a non-default kit would desync. Bump mandatory;
//     only golden-02-combat hash sequence moves (fires special).
// v27: sunken FCOP pads lifted onto the floor the player can see (gen:pads).
//     Six pads across three arenas had their collision floor more than STEP_SNAP
//     below the plate the terrain .glb draws over them, so walking onto visible
//     art put the avatar in the gravity branch: urban-jungle's two outpost pads
//     at x 86/153, y 120-121 (0.78 m), and the turret pad at (86-87, 135-136) on
//     proving-ground and bug-hunt alike (1.97 m). 16 cells total, each lifted to
//     its own mesh height. la-cantina had none.
//     MEASURED, NOT AUTHORED. convert.ts carried a hand-written `padHeights`
//     table for this, behind a flag nothing ever set. It was checked before being
//     switched on and it was stale: 8 of its 80 cells landed within 0.3 m of the
//     mesh, and it would have raised la-cantina's (88,83) to +1.0 m where the art
//     sits at -2.50 — the avatar hovering 3.5 m over a pit. The table is gone;
//     tools/generators/stampPads.ts reads the heights out of the committed .glb
//     and tools/generators/test/terrainCollision.test.ts pins the result.
//     Three heightsPins move (urban-jungle, proving-ground, bug-hunt) and
//     golden-05-fcop, which runs on urban-jungle, moves with them. la-cantina's
//     pin does not.
//     ALSO IN v27: hitboxes follow the models. ARCHETYPE_RADIUS was half the
//     model footprint by convention, against models stretched 1.02x-2.87x off
//     the FCOP originals; the models came down to the size the original authored
//     (assets.md §4) and these came with them — the avatar's disc was 2.4 m
//     across against a 0.80 m mech, wider than the catwalks it walks. Only hit
//     detection reads them (AoE, projectile contact, mine triggers); wall
//     collision treats every mover as a point, so nothing opened. HOVER_CLEARANCE
//     0.8 -> 0.3 (a 0.48 m skimmer floating higher than it is tall) and
//     MUZZLE_OFFSET 2 -> 0.6 with it.
//     HOVER_CUSHION_SPAN deliberately does NOT follow, though it was documented
//     as 2 x the avatar radius: it is a cushion length measured against the
//     original's kerbs, which are terrain and did not shrink. Taking it to 0.8
//     costs the whole issue-#34 fix — hover-blocked road edges 0->10 on
//     la-cantina, 20->49 on urban-jungle, and three arenas lose a team that can
//     drive its own network. Same for AoE radii, which are sized against the
//     SPACING of what they engulf: the Warden's bomb at 2 m instead of 6 ends
//     the escort outright on urban-jungle. Both measured, both left alone.
//     Goldens 01/02/03/07 move: smaller targets change what the scripted snipes
//     connect with. match01's dead reckoning was also corrected to follow the
//     QUANTISED heading the sim drives — it was 2.9 m out by the ring, which the
//     old 1.5 m turret disc hid and a 0.7 m one does not.
// v28: TRANSFORM_LOCK_TICKS 15 -> 24 (~0.5 s -> ~0.8 s). The walker/hover change
//     grew a presentation — collapse, discharge, unfold (assets.md §4) — and the
//     window it plays in is sim state, so the lock grew with it. 0.3 s longer
//     defenceless is a balance change, not polish, and it is deliberate.
//     ONE golden moves: golden-02-combat, the only script that presses
//     BUTTON_TRANSFORM. The other six are header-only. It moves for two reasons,
//     and the second one is a script edit, not the sim: combat01's transform
//     "mash" pressed for a whole four-second phase, and because a press can only
//     land once the previous lock expires, the form it ended in was
//     phaseLength/lockLength parity — five toggles (hover) at 15, four (walker)
//     at 24. golden02.test.ts caught it as a collapsed hover phase (1080 ->
//     144 ticks). The mash now runs for strictly less than one lock, so exactly
//     one press can land however the respawn tick drifts, and the phase ends in
//     the form the script asks for at any lock length.
//     The EV_TRANSFORM event added in the same commit is NOT why this bumped.
//     Events are transient and never hashed (events.ts). Verified rather than
//     asserted: re-recording all seven goldens with the pushEvent call removed
//     produces byte-identical .hashes.json files. Nothing from the presentation
//     leaked into the tick.
// v29: the Mortar lobs. It is the one weapon the original arcs, and the one the
//     blurb here has always called an "arcing shell" while it flew dead flat —
//     spawnProjectile set velX/velY and nothing vertical, so a mortar was a slow
//     rocket. It now launches with a vertical velocity carried in timerB (the
//     field entities.ts already documents as "vertical velocity (jump/fall) or
//     secondary timer", and which only the mine used, for its arming delay) and
//     integrates GRAVITY each tick, semi-implicit: velocity first, then height.
//     No new entity field, so the hashable layout is untouched.
//     MORTAR_LAUNCH_SPEED is DERIVED, not tuned: it is the speed at which the
//     shell falls back to launch height exactly as its TTL runs out, so on level
//     ground the arc lands on the same tick and at the same distance the flat
//     shell reached when it expired — 110 ticks, 36.7 m. No balance number
//     moves; only the path between the two ends. On rising ground it now lands
//     EARLIER (the ground comes up to meet it) and on falling ground later,
//     which is what an arc is for.
//     The apex is ~34 m, which is steep. That is the direct consequence of the
//     existing pair — 10 m/s over 3.67 s — and flattening it means raising
//     SPECIAL_SPEED and lowering SPECIAL_TTL_TICKS together, a balance decision
//     deliberately not taken here.
//     Walls are unchanged: segmentBlocked is a 2D lattice with no height, so a
//     shell still stops at a wall it is flying 30 m above. Making the mortar
//     clear walls needs a height model the lattice does not have.
//     Only golden-02-combat moves — it is the one replay that fires a mortar,
//     and it is the same one v28 moved, for its own unrelated reason.
//     MUZZLE_OFFSET/MUZZLE_HEIGHT also moved from sim.ts to balance.ts, where
//     the constants rule says they belong; render/fx.ts imports them now instead
//     of keeping the hand-copied duplicate its comment warned about. Values
//     identical, no behaviour change.
// v30: graph jam relief — the last open item of issue #31 (PLAN Phase 13).
//     What PLAN recorded as "proving-ground and urban-jungle do not resolve in
//     ten minutes ... a respawn-versus-clearance race" was measured again from
//     scratch (tools/balance/paResolve.ts) and is neither of those things at
//     v29: three arenas resolve in 141-175 s, and urban-jungle FREEZES on 2 of
//     5 seeds — 8 produced units plus a Juggernaut at full HP displacing
//     under 0.5 m per 10 s, wedged where fresh production (heading to entry
//     node 237, the road's own endpoint 6.6 m INSIDE the base) crosses
//     outbound traffic (237→257→238 passes back through the spawn area).
//     UNIT_SEPARATION holds the mill stable, production sticks at the alive
//     limit, and the match is frozen from minute ~3. The same signature jams
//     bug-hunt's escorted push mid-route (10 units on one contested node).
//     The fix is a bounded relief in advanceOnGraph, not a knob and not
//     pathfinding: a unit that has spent GRAPH_JAM_TICKS (8 s) within
//     GRAPH_JAM_RADIUS (8 m) of its target node without entering the 0.5 m
//     advance disc reads the SAME next-hop signpost that arrival would have
//     read — but only in the two measured deadlock shapes: a wall bit across
//     its straight step to the disc (separation pushed it off the validated
//     road), or milling inside its own base pocket (GRAPH_JAM_HOME_RADIUS).
//     Open-field queues behind a combat front are deliberately NOT relieved:
//     a variant without these gates let the unescorted free trickle spread
//     into a firing line and raze proving-ground and bug-hunt, which
//     paAttribution pins as a pillar-1 violation. With the gates, d8-vs-idle
//     resolves 5/5 seeds on ALL FOUR arenas (worst 175 s), the trickle still
//     fails on its own (it now reaches the doorstep in better order — 60/14
//     core hits in 5 min against the 300 a raze needs — so that pin's loose
//     bound moved 50 → 150 with its story updated), and the escorted push
//     resolves everywhere. Alternatives measured and rejected: a pure timer
//     (breaks the trickle pins), wall-relief at any distance (same), and a
//     generator entry re-pick joining the road forward (skips 27-68 m of the
//     original streets — the road IS the arena content, rules.md §6).
//     The stall clock lives BELOW the GRAPH_MODE sentinel in timerB (graph
//     membership is now timerB <= GRAPH_MODE), so the entity layout is
//     untouched. Goldens: only 05 and 07 run graph arenas and only their
//     hash bytes move; 01-04 and 06 run polyline maps where advanceOnGraph
//     never executes, and stay byte-identical (re-headered only).
// v31: the original's import scales (docs/specs/fcop-fidelity.md I1-I5, I8),
//     read from the retail executable instead of inferred from geometry
//     (docs/specs/fcop-re/ranges-turrets-capture.md Q1/Q3). engage_range is
//     `raw << 4` world units, so 6144 is 12 m, not 6: every imported turret and
//     base-gun profile doubles its reach. targeting_delay is 1/16 s, not 1/60 s:
//     turret cadence 16 -> 60 ticks (2.0 s, which is also weapon 3's refire),
//     base guns 8 -> 30. turn_speed is the retail /218 rate block, 2457 -> 11
//     units per 1/300 s = 290°/s (was 216°/s). Trigger volumes are half-extent
//     raw/1024 m (was full raw/8192: 16x too small) and the sim's containment
//     test now grows them by the intruder's ARCHETYPE_RADIUS, as the original's
//     does — so Mp's base zone is 40 x 24 m and a gate 4.8 x 3.6 m. Turret damage
//     stays 15 (weapons package). The "invincibility" grant imports as INVULN
//     instead of throwing; no PA pickup carries it, so no map moves for it.
//     Goldens: 05 (urban-jungle) and 07 (la-cantina) run imported arenas and
//     move; 01-04 and 06 run maps with no weapon profiles or trigger volumes and
//     stay byte-identical (re-headered only). paAttribution's trickle/escort
//     numbers were re-measured and re-pinned; d8-vs-idle still resolves 5/5 seeds
//     on all four arenas (worst 190/402/234/250 s).
// v32: the original's Precinct Assault model (docs/specs/fcop-fidelity.md I6,
//     I7, R1; fcop-re/ranges-turrets-capture.md top + Q4, ai-and-rules.md §0/§5).
//     Actor type 28 is the Dreadnought, not a team base, and the original has no
//     destructible core. Removed: coreHp and the core-raze win, systemCoreAttack,
//     free base production (productionTicks/Limit, systemProduction — the "1
//     Runner per 5 s" was the Dreadnought spawner's period, and the spawner is
//     shut in PA) and the four "built-in base guns" on the core (they were the
//     Dreadnought's hull guns). The win is §1's gate rule with the original's
//     specifics: an enemy Runner (tank) or Juggernaut (Dreadnought) inside the
//     gate box — on the imported arenas the original's gate trigger (Mp 2457 x
//     1843 raw = 4.8 x 3.6 m, grown by the intruder's radius) — starts a
//     MATCH_OUTRO_TICKS (175 = the original's 1750 at 300 Hz) countdown; the match
//     plays on and `winner` is set when it ends. Jets and avatars never breach.
//     The PA Juggernaut takes the Dreadnought record: it spawns there (node 0 of
//     its Cnet by the HQ), with 3000 HP and four hull guns of weapon 3 (100 dmg,
//     60-tick refire, 12 m), modelled as four shooters at the hull. The Warden
//     defends on the one §1 radius everywhere and gates its push/suppress rung on
//     the arena carrying the original road graph instead of on a core.
//     State: baseDefence/coreHp/productionTimer arrays gone; outroTimer and
//     outroWinner hashed only while an outro runs. Goldens: 05 and 07 re-record
//     (imported arenas: no production, no base guns, gate-box win, regenerated
//     roads); 03 and 04 re-record from their breach on (district-01's breach now
//     plays the outro); 01, 02 and 06 never breach and stay byte-identical
//     (re-headered only). balance:pa d8 vs idle: 5/5 seeds resolve on all four
//     arenas, worst 79/98/96/83 s (the idle side fields nothing now).
// v33: the original's economy (docs/specs/fcop-fidelity.md R2-R7, R9, R10;
//     fcop-re/ai-and-rules.md §2, §8). Applied on every arena: none of these
//     rules reads PA-only data. STARTING_POINTS 20 -> 10. No trickle (was 1 per
//     10 s). A death pays the OTHER side, whoever caused it (the original pays
//     from the dying actor's death script, not the kill credit): Runner/Guardian
//     +1 (was +1 to the killer), Juggernaut/Fortress +5 (was +1), a base turret or
//     an enemy-captured pad +1 (was +2 to the killer), capture +1 (was +3). An
//     avatar going down pays the other side 10 and costs the downed side 10,
//     floored at 0 (was +10 to the killer, no loss): a player's at its respawn,
//     the Warden's when it falls, as the original's two scripts do. Alive caps:
//     20 Runners and 20 Guardians per side (were uncapped). The Juggernaut and
//     Fortress purchases open the first time a side holds 50 points
//     (`heavyUnlocked`, hashed, sticky). The Warden's difficulty income
//     multiplier went with the trickle (`wardenIncomeAcc` no longer hashed): the
//     Sky Captain's budget is its Current Points. Goldens: every one re-records,
//     because the hash covers the starting balance and the new per-player flag.
//     01, 02, 05 and 06 play the same moves; 02's beat test now pins the avatar
//     down payment. 03's script (district-01) could no longer afford its outpost
//     from the ring bounty: it now downs player 1's avatar twice for the 20
//     points and breaches at tick 3716 (was 2959). 04 (d8 Warden on district-01)
//     no longer breaches in its 300 s: the Warden saves for a Juggernaut it can
//     no longer fund, because each of its falls costs it 10 (re-pinned; the Sky
//     Captain port, U3, replaces this AI). 07 replays the same script against
//     the new economy. balance:pa d8 vs idle still resolves 5/5 seeds on all four
//     arenas, worst 166/352/664/621 s (was 79/98/96/83 s).
// v34: the original's capture (docs/specs/fcop-fidelity.md R12;
//     fcop-re/ranges-turrets-capture.md Q2). A neutral turret flips INSTANTLY,
//     with no timer and no contest, to an avatar whose action key (Interact)
//     goes down within the capture range plus its own radius (3D), to a Runner
//     that comes that close (3D, no button), or to the Warden flying over it
//     (flat, no button — the Sky Captain's type 0x25). Guardians, Juggernauts and
//     Fortresses never capture. Was: an avatar standing 3 s within 5 m,
//     uncontested. The range is imported per arena as MapData.captureRange, the
//     original's (raw + 1024) / 512 m from the NeutralTurret record's last
//     halfword: 4.0 m on Mp/Conft/Ovmp, 5.2 on Slim/Joke, 5.6 on Hk; district-01
//     keeps CAPTURE_RADIUS 5 m. A destroyed pad respawns neutral after 25 s
//     (was 45 s). State: captureTeam/captureProgress are gone from the hash; the
//     transient capturePress is cleared within the tick and never hashed.
//     Goldens: every one on a map with turret spots re-records, because the
//     per-spot capture fields left the hash (02, 03, 04, 05, 07); 01 (test-128)
//     and 06 (layered-test) have none and stay byte-identical (re-headered only).
// v35: the original's outpost claim (docs/specs/fcop-fidelity.md R14;
//     fcop-re/ai-and-rules.md §2). Entering an unowned outpost's claim zone
//     (OUTPOST_CLAIM_RADIUS around its console) with 30 points claims it on the
//     spot: no button, no hold (was a 0.5 s interact hold at the console). A
//     player's avatar trips the zone; the Warden claims only while its goal is
//     to (the Sky Captain's claim is a script decision, not a fly-over — a
//     difficulty-8 Warden saving for its Juggernaut otherwise spent its 30 on
//     every outpost pad it captured, and three arenas stopped resolving). On the
//     imported arenas a claim is permanent, as the original's is: an outpost
//     console takes no damage and no unit or Warden targets it. district-01
//     keeps console destruction reverting the outpost (outposts as a menu, a
//     deliberate deviation). Goldens: 03 re-records (its avatar claims on
//     arrival instead of after a hold); the others never claim or shoot an
//     outpost console and stay byte-identical (re-headered only).
// v36: the original's alert cues (docs/specs/fcop-fidelity.md R15;
//     fcop-re/ai-and-rules.md §6). New events EV_TURRET_UNDER_FIRE (a ring
//     turret was hit; per side, at most once per TURRET_ALERT_COOLDOWN_TICKS =
//     300, the original's 10 s) and EV_TURRET_LOST (a ring turret died). Base
//     intrusion keeps EV_ALARM but follows the original: the cooldown is per
//     BASE (every volume guarding it re-arms together) and 250 ticks, the
//     original's 2500 engine ticks = 8.3 s (was 90 per volume), and the watched
//     enemy units are its ground units (tank, Dreadnought), not its jets.
//     State: `turretAlert` per side, hashed on maps with ring turrets only.
//     Goldens: every one on a map with ring turrets re-records for the new hash
//     field (02, 03, 04, 05, 07); 07 also trips the alarm on the new cadence.
//     01 and 06 have no ring turrets and stay byte-identical (re-headered only).
// v37: the X1-Alpha's life cycle (docs/specs/fcop-fidelity.md P2, P6, P7, P9;
//     fcop-re/player-and-weapons.md §1, §6). A player's avatar respawns 4.0 s
//     after going down (RESPAWN_TICKS 240 -> 120, `player_op4`'s 0x4b0 at
//     300 Hz); the Warden keeps 8 s (WARDEN_RESPAWN_TICKS, U3's to change). Going
//     down drops the power-up (`player_respawn` clears block B); the cloak and
//     invulnerability timers keep running. A spawn record may ask for hover form
//     (MapSpawn.hover: both of Hk's), and the avatar spawns and respawns in it.
//     Health pickup: full heal (was +100). Cloak 1350 ticks (was 300), and the
//     Warden's hunt skips a cloaked or invulnerable avatar as the original
//     commander's target search does. Invulnerability 600 ticks (was 300; no PA
//     pickup carries it). Pickup re-arm 50/100 s is the imported data, unchanged.
//     Goldens: 02, 03 and 04 re-record (district-01: the player respawns 4 s
//     sooner after each down). 07 (la-cantina) re-records: its player goes down
//     too. 01, 05 and 06 never lose an avatar and stay byte-identical
//     (re-headered only).
// v38: the original's transformation (docs/specs/fcop-fidelity.md P3;
//     fcop-re/player-and-weapons.md §2). TRANSFORM_LOCK_TICKS 24 -> 41 (the
//     original's 409.6 engine units). The weapons fire through it (they were
//     locked); drive, turn (the facing is frozen), jump and the lock cycle stay
//     locked. The hull runs hover physics for the whole ramp in both directions,
//     so a walker coming out of hover coasts instead of stopping dead, and the
//     ride height ramps 0 -> clearance into hover and back out of it. Refused on
//     water in either form (was: only hover -> walker over water). Goldens: 02
//     re-records (it transforms twice); the others never transform and stay
//     byte-identical (re-headered only).
// v39: the X1-Alpha's two movement models are the original's
//     (docs/specs/fcop-fidelity.md P4, P5; fcop-re/player-and-weapons.md §3-§5),
//     run at 30 Hz as 1.25 of its 37.5 Hz steps in closed form (balance.ts
//     "X1-Alpha movement"). Walker 5 -> 4.69 m/s with drag 0.375 a step (95 %
//     in 0.17 s), strafe 3.13; hover traction knobs -> push 0x6666 against drag
//     0.05 a step (9 -> 9.38 m/s, 95 % in 1.56 s), strafe 2.93, brake 0.15 on
//     the jump button, idle drag ramp, 10.7 m/s cap, stop-dead thresholds. The
//     stick strafes across the facing (it was a throttle along it), read as
//     eight 45° sectors; the hull TURNS toward the aim/lock at 105°·(1 - v/18.75)
//     (walker, not in the air) or 158°/s after a 0.26 s ramp (hover) instead of
//     snapping. Gravity 20 -> 26.1 m/s² with a 14.06 m/s terminal fall in both
//     forms; the hover rides 0.5 m (was 0.3) and falls off ledges; landings over
//     10.78 m/s hurt (1000 f(x) HP x AVATAR_HP / 1250, interim). The jump is
//     the original's three (leap / high jump with lunge / hop), no air control.
//     Downhill slope push in both forms; the walker's gate 0.6 -> 1.04, where
//     that push stops the original's walk (it has no hard gate). A walker in
//     water transforms to hover (NORMAL). Transform no longer needs the ground.
//     New hashed per-player state: avatarTurnRate, avatarIdle, avatarLunge.
//     Goldens: all seven re-record (every one moves an avatar). 03's script now
//     turns on the spot before each leg and snipe and aims at player 1's
//     measured stand; it breaches at 4002 (was 3701). 04's patrol is downed once
//     (was twice) and ends on 90 points.
// v40: the X1-Alpha's lock is the original's (docs/specs/fcop-fidelity.md W2;
//     fcop-re/player-and-weapons.md §7, `player_target_acquire` 0x0045a240 and
//     `player_target_hold` 0x0045a2a0). 12 m horizontal (AVATAR_LOCK_RANGE 44 ->
//     12), acquired inside +-12.5° of the hull's facing and held inside +-25°;
//     auto-acquired every tick while there is no lock (it was taken only by the
//     Target-Cycle press, in any direction); the press takes the nearest OTHER
//     target in the acquire cone, or keeps the lock (it stepped through every
//     enemy by ascending id). No line-of-sight test (the original has none).
//     Enemy turrets and units are lockable as well as avatars; uncaptured neutral
//     turrets and the imported arenas' consoles are not. Only a lock the player
//     took with the press turns the hull (new hashed per-player `lockSteer`); an
//     auto-acquired one aims the weapons alone. Goldens: all seven re-record for
//     the new hash field and the auto-acquired locks; none presses Target-Cycle,
//     and nothing fires along the lock yet, so no trajectory moves.
// v41: the X1-Alpha's weapons are the original's records and its health the
//     original's 1250 (docs/specs/fcop-fidelity.md P1, W1, W2, W4;
//     fcop-re/player-and-weapons.md §5, §7, player-weapons.json). AVATAR_HP
//     300 -> 1250 (NORMAL); landing damage loses its interim AVATAR_HP / 1250.
//     The ten catalogue weapons carry their block-A records (balance.ts
//     WEAPON_RECORDS): damage, NORMAL ammo (every slot finite, the Gun's too, with
//     its own ammo pickup kind), gaps added to a cooldown that decays 10 engine
//     units a tick floored at zero (gap 0 = every tick), burst counters, reach,
//     missile launch/top speed and acceleration, flight range, ballistic speed and
//     gravity, blast radii with linear falloff over horizontal distance. Hitscan
//     damages only the lock; Hell Fire homes on it; the HVR leads it; the Mortar
//     solves the original's lob to it (or 8 m ahead); mines spring at 2 m and blow
//     1 s later; a homing round drops a cloaked avatar within 4 m. The Flamethrower,
//     Concussion Beam and Shockwave keep Metropolis' time profile with the
//     original's damage and radius. The Warden's harass closes in when the avatar
//     is hidden from its stand and nothing else is in sight, and suppresses the
//     nearest emplacement when even contact is blind (it parked for good behind a
//     wall once a first pass no longer killed); a health pickup fills its taker to
//     its own maximum (it set the Warden to the avatar's). New hashed per-player
//     state: gunAmmo, burstLeft. The arena JSONs re-import reload_gun as the new
//     PICKUP_GUN_AMMO. Goldens: all seven re-record (the new hash fields; every
//     arena's avatars have 1250 HP). 02 and 03 run re-timed scripts — the avatar
//     walks up to its targets and fires on the lock (02 ends its crossfire hold at
//     30 s and lobs mortars over the ford; 03 takes the ring from inside its reach
//     and breaches at 4262, was 4002, over 160 s, was 150); 04's patrol downs the
//     Warden 10 times (was 9) and ends on 100 points.
// v42: every shooter on an imported PA arena fires its original catalogue
//     weapon (docs/specs/fcop-fidelity.md W3; fcop-re/ranges-turrets-capture.md
//     Q3). balance.ts WORLD_WEAPONS holds the type-98 entries the PA actors name
//     (identical on all six maps): turrets, neutral turrets and Dreadnought guns
//     weapon 3 (100 dmg every 601 engine units, a 7.62 m/s lead-aimed round
//     flying 12 m; was 15 dmg, instant, every 60 ticks), tanks and jets 1/6 (50
//     dmg every 300 units), the Flying Fortress 4 (guided, 100 dmg every 150 units,
//     flies 24 m). Runners, Guardians and Fortresses take their spawner records'
//     150/150/2000 HP and these weapons on a PA arena (was 60/50/500 and the
//     instant UNIT_* table; MapBase.runner/guardian/fortress) and engage at 12 m
//     (was 14/18/30). Rounds are projectile entities (PROJ_ROUND) on the
//     original's rate machine; PA turrets re-search on their targeting delay while
//     a round waits, team turrets hold their target and prefer Dreadnought > tank >
//     X1, and every turret fires only within 22.5° of its slewing barrel with a
//     clear line, else retries 0-0.85 s later (sim PRNG). A straight round (any
//     shooter's, the X1's missiles too) no longer dies on the heightfield; only
//     walls, its range and a strike stop it. district-01 and the sandbox keep the
//     instant-hit tables. The arena JSONs carry the new MapWeapon fields and unit
//     profiles. Goldens: 05 and 07 (imported arenas) re-record; 01 re-records
//     (its Hell Fire rounds cross the test map's slope instead of dying on it);
//     02-04 (district-01) and 06 stay byte-identical (re-headered only).
// v43: the power-up is the original's (docs/specs/fcop-fidelity.md P8;
//     fcop-re/player-and-weapons.md §6, §7). Each slot has its own pickup kind
//     (PICKUP_POWER_GUN 5, _HEAVY 7, _SPECIAL 8; the arenas re-import
//     power_up_*). A pickup fills that slot's block-B magazine (new hashed
//     per-player-and-slot `powerAmmo`, the original's ammo_b) to its NORMAL
//     ceiling; the slot fires its block B — the record's powered weapon — until
//     the magazine is empty, then block A; a down loses it. The x2 damage for 15 s
//     (`buffPower`, PICKUP_POWER_TICKS, PICKUP_POWER_MULTIPLIER) is gone. Goldens:
//     all seven re-record for the new hash field (the buff timer, hashed only on
//     pickup arenas, left the hash); 07 takes a Special power pickup, which now
//     fills a block-B magazine instead of doubling its taker's damage.
// v44: ground units on the imported arenas are the original's route followers
//     (docs/specs/fcop-fidelity.md U1, U2; fcop-re/ai-and-rules.md §4, route.c
//     `cnet_route_next`, route_tick.c, route_near.c). Each side's Runners and
//     Juggernaut drive their own side's Cnet (MapLaneGraph.net, labelled at
//     load). At every node the step chooser scores up to four links: a Runner
//     (the PA tank) seeks the nearest enemy-team actor within 16 m on 60 % of
//     steps (wander 1638/4096 is random) and scores each link by the octave of
//     its dot product with the target (32 + floor log2, below 32 for a step
//     away), a Juggernaut (the Dreadnought) scores at random; a positive score
//     halves per follower already heading to that node; the node just left is
//     refused and the one before is the last resort; ties are a coin flip, links
//     scanned backwards. Was: the committed signposts with a seeded 50/50 coin
//     at a fork. They walk each leg to its full length at 1.98 m/s (route block
//     1024 raw; was RUNNER_SPEED 4, JUGGERNAUT_SPEED 2.5), on the road (no walls,
//     no separation push, no arrival radius, so the v30 jam relief is gone), and
//     never halt to fight — the guns fire on the move. Traffic is the original's
//     1 s holds: behind a follower of their net heading for the same node with
//     less leg left they take half its speed, a non-follower within 2 m dead
//     ahead stops them, a nearer one slows them; the Juggernaut ignores traffic
//     (route flag 0x8). A forward (outpost) spawn joins its own side's net (it
//     took the nearest node of either). Jets and Flying Fortresses fly at the
//     records' 4.0 / 4.8 m/s on these arenas (was 7 / 6). New hashed unit-field
//     reuse: prev-of-prev node in ammoB, commanded speed in aimX, the hold in
//     timerB. Goldens: 07 (la-cantina, bought units) re-records; the others field
//     no ground unit on a graph arena and stay byte-identical (re-headered only).
// v45: PA units target as the original's shooters and aircraft do
//     (docs/specs/fcop-fidelity.md U1/U2 targeting, I2, W3's kept note;
//     fcop-re/ranges-turrets-capture.md Q3, ai-and-rules.md §4, aircraft.c). A
//     unit keeps its target while it lives, stays hostile and in its 12 m reach,
//     and re-searches only when a due round has none, on its shooter's targeting
//     delay (tank and jet 601 units = 2.0 s, Dreadnought and Fortress 300 = 1.0
//     s; the records hold no target and prefer no priority); a round with no clear
//     line is put back for 0-0.85 s. Was: the nearest enemy in reach every tick.
//     Jets and Flying Fortresses on the imported arenas are the original's
//     aircraft: a target search every 900 + rand 0..511 engine units within the
//     record's detection range (56 / 63.2 m, I2), flight at the target inside the
//     patrol leash (±24 x ±20 / ±30 x ±28 m about the spawner they were built at;
//     outside it a 4.0-10.8 s cruise to a destination in half the leash), a 1 m
//     standoff reverse held 0.5-0.9 s, no halting, and a gun that fires only while
//     engaging. Was: §4's base-core orbit / enemy-core assault, halting in reach.
//     Turrets still never target turrets (the original's "by team" search is not
//     read for that). New entity field timerC (a PA aircraft's cruise countdown);
//     outpost-built PA Guardians carry mode 1 + outpost index. Goldens: all seven
//     re-record for the new field; 07 also fields bought units under the new
//     targeting.
// v46: the Warden is the original's Sky Captain (docs/specs/fcop-fidelity.md U3;
//     fcop-re/ai-and-rules.md §1, dispatch.c / aircraft.c). Difficulty 1-10 plays
//     level 0-9: health 250-1250, speed 2.72-4.51 m/s, rethink every 848 - 80 L
//     engine units (+0..255, or -0..31 defending), respawn (14 - L) * 150 units.
//     The decision pass scans from home, the player's base and itself (octagonal
//     distances, a (9 - L) * 0.5 m penalty) and runs the defend / attack / roam
//     machine, its aim (inside 12 m) and move targets, then the spend blocks;
//     retreat below maxHP/2 - rand 63 (halved defending/attacking), restore at
//     home or from a health pickup. Weapons 7/8/9 (gun 2 per 18 units, guided
//     missile 25 per 150, bomb 200 in 3.2 m with falloff per 601) on the
//     shooters' rate machine with the level's arcs; flight at its target with a
//     1 m standoff reverse. Its budget is its Current Points from 0, plus a free
//     opening order of ten base units from level 1; requests pay at once and
//     spawn from queues (a tank per 3.4 s, a jet per 0.97 s); outposts are
//     claimed by decision; every engine credit zeroes its rethink. Was:
//     Metropolis' goal ladder, 450 HP, 10 m/s, a 42 m cannon, pad repair, 8 s
//     respawn, 10 starting points. SimState's wardenGoal/Slot/Think become the
//     hashed `captain` block. Goldens: 04 (district-01, d8) and 07 (la-cantina,
//     d8; its scripted capture press moves a phase earlier, to tick 555, since the
//     captain chasing the player flies over that pad at 557) re-record; 01-03,
//     05, 06 have no Warden and are byte-identical (re-headered).
// v47: the base rings are the original's 8 (Mp/Conft/Ovmp) or 6 (Slim/Joke/Hk)
//     per side (fcop-re/outposts.md Q1). enrichArena.ts drops the type-8 records
//     that stand on an outpost's turret plates by their membership in
//     outposts.json instead of by a half-cell pad key, which leaked on three
//     arenas: urban-jungle's team 0 ring 9 -> 8 (Csac217, outpost 3's), and
//     proving-ground's and bug-hunt's team 1 rings 7 -> 6. Walls, spots and
//     every other feature are unchanged. Goldens: 05 (urban-jungle) re-records,
//     one turret fewer; 01-04, 06 and 07 (la-cantina, whose rings were already
//     8/8) are byte-identical (re-headered).
// v48: the original's outposts on the imported arenas (fcop-fidelity.md R14;
//     fcop-re/outposts.md). Each arena carries the original's four outposts
//     (MapData.outposts/outpostPlates, imported from outposts.json) instead of
//     two invented mid-field consoles: a 1.2 m type-14 claim zone (the console
//     marker stands at its centre), a tank pad and a jet pad (2 points a unit,
//     the owner's only), and two turret plates on a NeutralTurret each. A claim
//     kills both plates' neutral turrets, unscored, whoever held them, and shuts
//     their spawners (respawn -1); the claimer's own plate turret spawns at that
//     tick's spawner pass and returns 750 ticks (25 s) after every death, for
//     the rest of the match (new hashed plateTurretEntity/Respawn). On every
//     arena a claim now needs the action key's rising edge inside the zone
//     (the zone's op-10 gate bit 0x04), not just entering it; district-01 keeps
//     its 3 m zone, its consoles and their destruction. The Sky Captain no
//     longer adds 2 per owned outpost to its turret count: the plate turrets
//     are real type-8 turrets now. Its outpost queues spawn at the pads.
//     Goldens: 03 (district-01) claims at its press, a few ticks later than on
//     entry; 05 (urban-jungle) and 07 (la-cantina) have new outpost consoles in
//     the entity store; 01, 02, 04 and 06 are byte-identical (re-headered).
// v49: the Sky Captain counts each of its live team turrets twice
//     (fcop-fidelity.md U3; fcop-re/outposts.md Q2): the original's type-8
//     turret is two type-8 actors in the live list, the turret and its base
//     part built from the same record, and its scan counts both against the
//     defend threshold of 10. So it defends while fewer than 5 of its team
//     turrets stand (ring + owned outpost plates; captured neutrals never
//     count), or when an enemy tank is within 64 m / a Dreadnought within 72 m
//     of home. On the imported arenas its ring of 8 or 6 counts 16 or 12: it
//     roams from the first decision, claims outposts and buys Juggernauts and
//     Runners. Was: each turret once, which kept it in defend all match.
//     Goldens: 07 (la-cantina, d8) re-records, the captain roaming; 04
//     (district-01, ring 4 = 8 < 10) still defends all match and is
//     byte-identical, as are 01-03, 05 and 06 (no Warden); re-headered.
// v50: a base ring turret comes back 37.5 s after it dies, the original's ring
//     spawner period (tSAC -2250; fcop-fidelity.md R16, fcop-re/outposts.md Q1),
//     on every arena, instead of Metropolis' 120 s. The imported arenas carry it
//     as data (MapBase.turretRespawnTicks, 1125 ticks, read from the ring
//     records' own spawner by enrichArena.ts and checked against outposts.json);
//     district-01 and the test maps fall back to BASE_TURRET_RESPAWN_TICKS, the
//     same 1125. Goldens: 03 (district-01) re-records with a new script — the old
//     one cleared base East's ring and fought player 1 inside it for ~40 s, and
//     the ring came back and put player 0 down; player 1 now walks out to the
//     outpost to be put down, and the wave is bought after the ring's north pair
//     is cleared and breaches inside its 37.5 s (tick 4262 -> 5640, 160 -> 200 s).
//     01, 02 and 04-07 are byte-identical (no ring turret of theirs is down when
//     the old and the new period differ); re-headered.
// v51: a purchase is one press of the action key (fcop-fidelity.md R17;
//     fcop-re/ai-and-rules.md §2): every purchase spot — base consoles, an
//     imported outpost's tank and jet pads, Metropolis' outpost consoles —
//     sells one unit on the tick Interact goes down, as the original's trigger
//     zones answer its Action Key, instead of one per 0.5 s held. A press the spot
//     refuses (points short, 20 alive, a claim under 30) emits the new
//     EV_PURCHASE_REFUSED (the original's refuse sound; events are not hashed); a
//     closed heavy zone (not yet unlocked, or its unit alive) stays silent. A
//     press that claims an outpost buys nothing more. SimState loses the hashed
//     buyTarget/buyProgress, so every golden's hash moves; the match snapshot
//     loses MATCH_SLOT_BUY_FRAC (stride 12 -> 11). Golden scripts press every
//     0.5 s where they held: 03's player 1 buys its three feeders on three
//     presses and player 0 its wave on six (breach 5640 -> 5602), 05 and 07 buy
//     their waves the same way.
// v52: district-01 and the test maps play the original's rules on their own
//     geometry (owner's call; fcop-fidelity.md W3, U1-U4, R12, R14 and the
//     district-01 row). A map that imports no profiles loads the original's
//     (balance.ts ORIGINAL_WEAPON_PROFILES / ORIGINAL_UNIT_PROFILES /
//     ORIGINAL_TURRET_HP, the imported arenas' own table): ring and capture
//     turrets on weapon 3 (100 a round every 61 ticks, 12 m, 7.62 m/s lead round,
//     ±22.5° arc, 2.0 s re-search, 290°/s slew; 500 HP), tanks and jets 150 HP on
//     weapon 1/6, the Fortress 2000 HP on weapon 4, the Juggernaut 3000 HP with four
//     guns (rolling out at the ground console); Metropolis' dummies keep their
//     avatar-only role on the neutral turret's gun. Units everywhere are the
//     original's: polyline-lane tanks drive at 1.98 m/s and never stop to fight,
//     aircraft are the original's leashed aircraft at 4.0/4.8 m/s. Capture range
//     4.0 m (was 5), an outpost claim zone is the record's 1.2 m + the avatar's
//     radius in 3D (was a flat 3 m), and an outpost console takes no damage on
//     any arena (the destruction revert and SimState.outpostRespawn are gone).
//     Metropolis' TURRET_*, UNIT_*, patrol/assault and console-respawn tables are
//     removed. Every golden's hash moves (outpostRespawn left the hash, weapon
//     profiles are hashed on every map); 02 (dummies now 500 HP: the mech holds
//     fire until one puts it down, 90 -> 120 s), 03 (a new choreography, breach
//     5602 -> 4610) and 04 (the captain's opening Runners breach at 2824; was no
//     breach) change behaviour on district-01.
// v53: no pad refills or repairs a mech (fcop-fidelity.md P1, R14): the
//     original has neither a base pad nor an outpost refill. MapBase.pad, its
//     15 hp/s repair (PAD_REPAIR_HP_PER_TICK) and the 4 m outpost ammo refill
//     (OUTPOST_PAD_RADIUS) are gone; ammo comes back from the ammo pickups and a
//     respawn, health from the health pickup and a respawn.
// v54: the Sky Captain shoots as the original's does (fcop-fidelity.md U3,
//     `discharge.c` / `dispatch.c`): it takes its target by distance alone, with
//     no line of sight (was: line of sight, except to ground units); its gun
//     fires anyway but damages only along a clear terrain line; its missile is
//     put back on a blocked line whatever the target. The v24 "superplane"
//     pierce, which let its gun and missile reach ground units through walls,
//     is gone. The bomb is unchanged: no arc, no checks.
// v55: a capture is measured as the original measures it (fcop-fidelity.md
//     R12, `turret_op10` 0x0041c920): in world units with its octagonal
//     estimate, flat first, then once more with the height difference folded in
//     (flat only for the Sky Captain). Was: the Euclidean distance.
// v56: a base purchase spot is its type-95 trigger box (fcop-fidelity.md R17):
//     the trigger's half extents about the console (Mp: 1.6 x 1.2 m), widened by
//     the buyer's radius, imported per console (MapBase.groundBuy / airBuy). Was
//     Metropolis' 3 m circle (CONSOLE_RADIUS). district-01's consoles-as-a-menu
//     purchase path is gone with it: an arena with outpost spots must carry the
//     original's outposts.
// v57: each mech spawns facing as its X1Alpha record says (fcop-fidelity.md
//     P10, the record's facing at blob 44: 4096 a turn, forward (cos, sin) in
//     the actors frame), and in hover form where that facing is negative (Hk).
//     Was: the field axis toward the enemy base, which the record agrees with on
//     Mp, Slim, Joke and Ovmp; urban-jungle (Conft) now starts along +x / -x,
//     hollywood-keys (Hk) along -z / +z. Map data only; the sim is unchanged.
// v58: the ground hurts the enemy mech where the original's does
//     (fcop-fidelity.md P11): each base's floor (surface codes 14/15, imported
//     per surface as MapData.floorMasks) deals 1 damage a movement step (37.5 a
//     second) to the other team's mech within 0.54 m of its feet, walker or
//     hover, crediting no one; Hk's two spawn guards (MapData.spawnGuards) deal
//     25 instead, then wait for a latch reset polled every second from a random
//     phase (SimState.guardLatch / guardTimer, hashed off Hk only). Hk's guard
//     boxes are no longer imported as intrusion-alert volumes.
// v59: Hk and Ovmp carry the original's water (fcop-fidelity.md P13): surface
//     code 1 imported per cell with each cell's own level (MapJson.waterLevels;
//     `water` digits index them), the arena's `waterLevel` its commonest level
//     (Hk -0.97 m, Ovmp -2.5 m). isWater reads the cell (was the nearest
//     vertex), a hover rides on the cell's own surface, and the walker's water
//     rules (the NORMAL auto-hover, the refused transform) apply on the ground
//     surface within SURFACE_REACH of it, not on a deck over it. Hk's spawn
//     guards stand on the water. No other arena has water; their hashes stay.
// v60: the Dreadnought and the Flying Fortress are bought at their own type-14
//     zones (fcop-fidelity.md R10), imported per base as MapBase.heavyZones
//     (radius r/512 m + the mech's; Conft's Dreadnought zones 1.0 m, every
//     other 0.8 m), not by FIRE2 at the consoles. The zones open for good at
//     the first poll of the original's fn30/fn31 that sees 50 points: every
//     `pollTicks` (150/153, Joke/Slim 75/77) from a random phase
//     (SimState.heavyPoll, hashed where a base has zones; its draw at
//     createSim moves the PRNG stream of every such arena). A closed zone is
//     silent; an open one refuses short points and a living unit out loud. The
//     Fortress, the human's and the captain's, leaves its own spawner
//     (MapBase.fortressSpawn), not the air console. A base without zones (the
//     test maps) sells no heavy unit.
// v61: a tank is queued, as the original's are (fcop-fidelity.md R18): a
//     human's base or outpost tank purchase is accepted at the press and joins
//     its side's spawn queue (SimState.unitQueue / unitQueueTimer, hashed on
//     every map), which spawns one unit a period from a phase drawn at
//     createSim — the original's mission functions fn07..fn21, periods per
//     arena and slot (MapBase / MapOutpost queueTicks: base tanks 98-102 ticks,
//     outpost tanks 98-103, the captain's jets 23-29). Queued units count
//     against the 20 from the purchase. Jets still come at once. Every unit
//     leaves its spawner's Csac position (MapBase tankSpawn / jetSpawn,
//     MapOutpost tankSpawn / jetSpawn per team), not the console or the pad.
//     The Sky Captain's requests use the same queues (CaptainState.queue and
//     its own timers are gone); a queue now runs from a random phase and keeps
//     its period between purchases (was: a fresh 0 countdown).
// v62: a pickup is collected as the original's is (fcop-fidelity.md P9): a
//     mech strictly inside the record's box, 4.0 m along x, 1.6 m along y and
//     1.6 m in height about the pickup standing 0.16 m above the ground
//     (MapPickup.halfW/halfL/halfH/lift; was a 2.5 m circle at any height);
//     the Sky Captain by the pickup's own flat 1.5 m octagonal touch, which
//     heals it at a health pickup and spends any other for nothing (was: any
//     kind within 2.5 m, granted). MATCH_PICKUPS reports the standing pickups
//     (renderer only; no hash).
// v63: the hover rides the decks (fcop-fidelity.md P14): it asks for its
//     surface from HOVER_PROBE_LIFT (0.4 m) above itself, as the original's
//     `terrain_surface_at` is asked, and rides the highest deck at or below
//     that point (sim.ts hoverSurface; units.ts surfaceBelow, which the
//     walker's resolveWalker now calls at STEP_SNAP, bit-identically). Its
//     entLayer follows the deck and its walls are that deck's (was: layer 0's
//     surface and walls under every deck). A hover spawn on a deck starts on
//     it. Water is read by height alone: Hk and Ovmp import the water plate as
//     deck 1 at the water level, so a walker that walked onto it stood on a dry
//     deck (inWater tested layer 0 only); bridges stand >= 0.59 m above it.
//     No golden replay leaves the ground surface in hover form; their hashes
//     stay.
// v64: the original's lifts (fcop-fidelity.md P12): MapLift (`lifts`, no
//     arena carries one yet) and systemLifts right after the mechs move. A
//     lift moves only its height between its stops (raw << 4 wu above its
//     ground) at its own speeds up and down (wu per sim tick, 10 engine
//     ticks), parks at a stop whose dwell is 0 until a mech standing on its
//     top presses the Action Key (capturePress), dwells at the others, and
//     turns round at either end of its table; EV_LIFT_START / EV_LIFT_ARRIVE.
//     Its top is ground to a mech (avatarSurface: the walker's and the
//     hover's probes answer it within LIFT_RIM_SLACK of its face, a rim within
//     STEP_SNAP is stepped onto), its riders move with it (SimState.avatarLift,
//     the carrier), a rider reads the walls of its nearer stop's surface, and
//     a tagged top hurts the enemy mech as its base's floor does. State
//     liftWu / liftStop / liftDir / liftPhase / liftTimer and avatarLift,
//     hashed on arenas with lifts only. writeLiftSnapshot for the renderer.
//     The surface tilt is read on the mover's own surface: a probe over a
//     deck's edge, into a hole or onto a lift reads as the centre's height
//     (was: the drop, a cliff of gradient that pushed walker and hover off
//     every deck edge and kept a hover off a deck its probe reaches). Moves
//     the layered goldens (03 on la-cantina, 06); single-surface arenas stay.
// v65: proving-ground (Slim) and bug-hunt (Joke) as the multi-deck arenas they
//     are, with their spawn lifts (fcop-fidelity.md P12) and their kerbs
//     (P15). Stage 1 emits both decks and the ground's own lattice (the union
//     of ground and decks is the old single-storey lattice bit for bit); the
//     turret pad at (86-87, 135-136) stands on its deck, so its ground stamp is
//     gone (stampPads reads decks). Stage 2 imports the two lifts under the
//     spawns from the rules artifact (stops 0 / 1.80 m, 130 / 210 wu a tick,
//     45 ticks at the top, tags 15 / 14), opens their shafts (the cells between
//     the lift's own, and at the top the edges onto the platform), and opens
//     424 kerb bits: faces between two floors at most KERB_STEP apart with
//     nothing standing above them in the original's mesh. A mech now leaves its
//     spawn as the original's does: up the lift onto the base's platform and
//     down the ramp to the consoles (until now the shaft held it). reach.ts'
//     flood rides lifts. No golden plays these arenas; their hashes stay.
// v66: a lift's top is found by the walker's own probe (LIFT_STEP_UP, 0x0ccc =
//     0.4 m; was STEP_SNAP 0.35): Conft's lifts park 0.39 m above their pit's
//     floor. The import (fcop-fidelity.md P12, P15) opens the walls between
//     every cell a lift's face reaches into, lays the original's floor where a
//     lift lands and the point heightfield bends it (landLifts), and opens a
//     wall bit with no face of the original's mesh within half a tile of it
//     standing above its floors (the extractor's spill onto a tile's far
//     edge), not only kerbs. On proving-ground and bug-hunt only the decks'
//     lattices change (deck 1: 3364 -> 2365 bits on Slim); the ground's and
//     every height stay. reach.ts boards a lift at LIFT_STEP_UP. No golden
//     plays these arenas; their hashes stay.
// v67: urban-jungle (Conft) as the multi-deck arena it is, with its four pit
//     lifts (fcop-fidelity.md P12) and its kerbs (P15). Stage 1 emits both
//     decks and the ground's own lattice (the union is the old lattice bit
//     for bit); the two sunken outpost pads stand on their -2.41 m deck, so
//     their 8 stamped ground cells are gone. Stage 2 imports the lifts around
//     the central platform (stops 0.16 / 1.80 m above the -1.81 m ring, 100 /
//     210 wu a tick, 45 ticks at the top, untagged), lays the platform's floor
//     at the south and east landings (4 cells), opens their shafts and 2855
//     kerb and spill bits. A mech in the ring now rides up onto the platform
//     as the original's does. Moves goldens 02, 04 and 05 (urban-jungle).
// v68: a lift's top carries a mech LIFT_RIM_SLACK = 0x500 (0.156 m) past its
//     face (was 0x400, one walker step): Conft's platform ends 0.145 m short
//     of each lift's face in the original's mesh, and a walk off a raised lift
//     whose step crossed the face 2 cm past the old slack dropped the mech 2 m
//     into that slot, where it stood against the platform's wall. The original's
//     mech is broader than the slot (fcop-fidelity.md P12).
export const SIM_VERSION = 68;
