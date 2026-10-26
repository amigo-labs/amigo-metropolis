// Frozen last-hash pins for single-story goldens. 01–04 must stay bit-identical
// when only FCOP feature authoring changes (they do not load those maps).
//
// Re-frozen at SIM_VERSION 27 for the hitbox rescale: ARCHETYPE_RADIUS now
// follows the models, and match01's dead reckoning follows the quantised heading
// the sim actually drives. Every golden that shoots or walks a script moves;
// 05 and 06 do not (05 moved for the pad stamp, in the same version).
// golden-05 (urban-jungle) is re-frozen when that map's features move — see
// SIM_VERSION 12. Do NOT re-freeze 01–04 casually; a drift there means a real
// sim regression.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Re-frozen at SIM_VERSION 40 (the original's lock, W2): the per-player lock-steer
// flag is hashed on every map and the lock now auto-acquires, so all seven move
// (hash fields only: nothing fires along the lock until the weapons land).
// Re-frozen at SIM_VERSION 41 (the original's weapon records and 1250-HP mech,
// W1/W2/P1): the hash covers the Gun magazine and the burst counters, so all seven
// move; 02 and 03 run re-timed scripts (they walk up to their targets now), 04's
// patrol downs the Warden once more.
// Re-frozen at SIM_VERSION 42 (the original's world weapons, W3): 05 and 07 run
// imported arenas whose turrets and units fire weapon-3/1/4 rounds now; 01 fires
// Hell Fire over the test map's slope, and a straight round no longer dies on the
// heightfield. 02-04 (district-01) and 06 keep their pins.
// Re-frozen at SIM_VERSION 43 (the original's power-up, P8): the per-slot block-B
// magazines are hashed on every map (the x2 buff timer, hashed only where pickups
// exist, is gone), so all seven move.
// Re-frozen at SIM_VERSION 39 (the original's walker and hover models, P4/P5):
// every golden moves an avatar, so all seven move.
// Re-frozen at SIM_VERSION 38 (the original's 41-tick transformation, P3): only
// 02 transforms.
// Re-frozen at SIM_VERSION 37 (the X1-Alpha's life cycle, P2): a player respawns
// 4 s after a down instead of 8, so every golden whose player goes down moves
// (03, 04, 07; 02 moves mid-sequence and ends on the same hash).
// Re-frozen at SIM_VERSION 36 (alert cues): the per-side turret-alert
// cooldown is hashed on every map with ring turrets (02-05, 07); 01 and 06 keep
// their pins.
// Re-frozen at SIM_VERSION 35 (outpost claim on entering the zone): only 03
// claims an outpost, now on arrival instead of after a hold.
// Re-frozen at SIM_VERSION 34 (the original's instant capture): the per-spot
// capture fields left the hash, so every golden on a map with turret spots moves
// (02-05, 07); 01 and 06 have none and keep their pins.
// Re-frozen at SIM_VERSION 33 (the original's economy): every golden moves,
// because the hash covers the starting balance (20 -> 10) and the per-player
// heavy-unit unlock flag; 03's script and 04's outcome changed with the economy
// (see version.ts v33).
// Re-frozen at SIM_VERSION 32 (the original's PA model): 03 and 04 move from
// their breach tick on, because a breach now plays the 175-tick outro before the
// sim freezes (breach ticks themselves are unchanged — golden03/04 pin them);
// 05 and 07 run imported arenas with no free production and no base guns.
const FROZEN: Record<string, { last: number; count: number }> = {
  // 03, 04 and 07 re-frozen at SIM_VERSION 87: a turret gun whose target is
  // gone turns back to its rest yaw, and a target's death clears the turrets'
  // hashed target at once (03 and 04 move at a tank's down, 07 at its first gun
  // turning back); 01, 02, 05 and 06 hold.
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 86: every PA turret stands
  // at its record's yaw (was pi/2 - a), which its gun points along until it
  // acquires a target; 01 and 06 carry no imported turret.
  // All seven re-frozen at SIM_VERSION 84: the spawn queues' and the spawn
  // guards' hashed countdowns are cfun_tick's, in engine ticks from u32 %
  // period; 02, 03, 04, 05 and 07 buy tanks or field the captain and play
  // differently, 01 and 06 only hash the new units.
  // All seven re-recorded at SIM_VERSION 83: the walker's state machine and its
  // legs are hashed on every map (walker.ts), and every golden's walker plays by
  // it -- the reset's step without control, the push its state asks for, the
  // jumps after their wind-ups, Jump held as a level.
  // 02, 03, 04 and 07 re-frozen at SIM_VERSION 78: every hit radius is the
  // original's (each arena's own models); 01, 05 and 06 hit nothing it moves.
  // All seven re-frozen at SIM_VERSION 76: the results page's figures and the
  // rival-hit flags are hashed on every map (stats.ts), and an X1's rounds carry
  // ROUND_RIVAL. Play is unchanged: with those masked, the v75 goldens replay
  // bit-identically.
  // 01 re-recorded at SIM_VERSION 70: its last seconds walk the slow row and
  // crouch.
  // All seven re-recorded at SIM_VERSION 69: the tick input is the original's
  // button word (inputs.ts), so every replay's frames and scripts are new — the
  // hull turns by the turn buttons and the transform is the chord.
  // All seven re-frozen at SIM_VERSION 61: the spawn queues are hashed on every
  // map and draw their phases at createSim; a bought tank is queued.
  // 02, 03, 04 and 07 re-frozen at SIM_VERSION 62: pickups are collected in the
  // original's box (a mech) and by its 1.5 m touch (the Sky Captain).
  // All seven re-frozen at SIM_VERSION 52 (district-01 and the test maps on the
  // original's rules): the outpost console respawn left the hash and weapon
  // profiles are hashed on every map; 02-04 also play differently on district-01.
  // All seven re-frozen at SIM_VERSION 51 (a purchase is one key press, R17): the
  // hashed purchase-hold state is gone, so every hash moves; 03, 05 and 07 buy by
  // presses.
  // 04 and 07 re-frozen at SIM_VERSION 46: their Warden is the Sky Captain.
  // All seven re-frozen at SIM_VERSION 45: the entity store gained a float field
  // (timerC, a PA aircraft's cruise countdown), so every hash moves; 07's bought
  // units also target as the original's shooters and aircraft do.
  // Re-frozen at SIM_VERSION 19 (on top of v18 hover cushion): facing-aligned
  // drive, PA ring/console/X1 authoring, and combat script aim aligned with travel.
  "golden-01-drive": { last: 158088464, count: 1800 },
  // 02-04 re-recorded at SIM_VERSION 52 when district-01 left the game (wave 2,
  // 2026-10-14): 02 combat on urban-jungle, 03 a two-player match on la-cantina,
  // 04 the Sky Captain (difficulty 3) on urban-jungle, 150 s.
  // 02, 04 and 05 re-frozen at SIM_VERSION 57: urban-jungle's mechs start facing
  // as their X1Alpha records do (along x, not toward the enemy).
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 60: the heavy-zone poll draws
  // its phase from the PRNG at createSim on every imported arena, and is hashed.
  // Re-frozen at SIM_VERSION 67: urban-jungle is layered, with its lifts and
  // its kerbs and spilled walls opened (fcop-fidelity.md P12, P15).
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 80: the heavy-zone poll's
  // hashed countdown is cfun_tick's, in engine ticks from u32 % period (the same
  // PRNG step); no golden's side reaches 50 points, so none plays differently.
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 94: urban-jungle's and
  // la-cantina's ground lattices keep their kerbs and shafts.
  "golden-02-combat": { last: 2883820012, count: 3600 },
  // Re-frozen at SIM_VERSION 50 (the original's 37.5 s ring respawn, R16): 03's
  // script was rewritten around it (player 1 is put down at the outpost, the wave
  // goes in inside the ring's window) and runs 200 s.
  // Re-frozen at SIM_VERSION 64: la-cantina has decks, and the surface tilt is
  // read on the mover's own surface (a deck's edge is no longer a cliff slope).
  // 03 and 07 re-recorded at SIM_VERSION 79: la-cantina's teams take the
  // original's player slots (team 0 is side 1's base, X1Alpha 12), so each
  // script's player starts and buys at the other base.
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 80: the heavy-zone poll's
  // hashed countdown is cfun_tick's, in engine ticks from u32 % period (the same
  // PRNG step); no golden's side reaches 50 points, so none plays differently.
  // 03, 04 and 07 re-frozen at SIM_VERSION 82: the hashed First Death and
  // First Outpost stamps read the frame clock from 0 on the first tick (one
  // frame delta earlier); nothing in the tick reads them.
  // 03 and 04 re-frozen at SIM_VERSION 91: a kill by a round's contact alone
  // credits nobody. 03's second mech down (tick 2564, a blastless round) no
  // longer adds to side 0's Walker Kills; 04's X1 down by the captain's
  // missile (tick 2892) no longer credits the captain, whose rethink is no
  // longer zeroed, so it plays differently from there.
  "golden-03-match": { last: 1029577492, count: 6000 },
  // 04 and 07 re-frozen at SIM_VERSION 54: the captain takes its target without
  // a line of sight and walls stop its gun and missile at ground units too.
  // 03, 04 and 07 re-frozen at SIM_VERSION 55: captures by the octagonal estimate.
  // 03 and 07 re-recorded at SIM_VERSION 56: the scripts walk the last metre
  // straight at their goal, and 07 steers by the live state and buys inside the
  // console's trigger box.
  // Re-frozen at SIM_VERSION 67: urban-jungle is layered, with its lifts and
  // its kerbs and spilled walls opened (fcop-fidelity.md P12, P15).
  // 04 and 05 re-frozen at SIM_VERSION 73: urban-jungle's consoles un-swapped
  // (the captain's jet patrols from the jet shop; the walls by team 0's shops
  // and the road entry follow the tank shop).
  // 04 and 07 re-frozen at SIM_VERSION 75: the captain's credit for a down by
  // its own hit is hashed (SimState.captainHit, its rounds' ROUND_CAPTAIN bit;
  // rivalHit and ROUND_RIVAL since 76);
  // 04's captain rethinks at the player's down instead of at the respawn.
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 80: the heavy-zone poll's
  // hashed countdown is cfun_tick's, in engine ticks from u32 % period (the same
  // PRNG step); no golden's side reaches 50 points, so none plays differently.
  // 04 and 07 re-recorded at SIM_VERSION 81: the hashed rivalHit of the
  // captain's slot follows the X1's hits on the captain (its death reads it for
  // the X1's Walker Kills); the X1 hits it and never brings it down, so neither
  // plays differently, and 07's last tick is back to the same state.
  // 03, 04 and 07 re-frozen at SIM_VERSION 82: the hashed First Death and
  // First Outpost stamps read the frame clock from 0 on the first tick (one
  // frame delta earlier); nothing in the tick reads them.
  // Re-frozen at SIM_VERSION 91: see golden-03 above.
  "golden-04-warden": { last: 577858865, count: 4500 },
  // Re-frozen at SIM_VERSION 27: urban-jungle's two sunken outpost pads were
  // lifted onto the plate the terrain mesh draws over them (8 cells). This is
  // the only single-story golden on that map, and the only one of the seven
  // whose hashes move.
  // Re-frozen at SIM_VERSION 30 (graph jam relief): the stall clock lives in
  // timerB on graph arenas, so 05 and 07 — the two goldens on maps that carry
  // a lane graph — move from the first near-node tick on; 01-04/06 run
  // polyline maps where advanceOnGraph never executes and stay byte-identical.
  // Re-frozen at SIM_VERSION 31 (the original's import scales): 05 and 07 run
  // imported arenas, whose turret profiles and trigger volumes changed.
  // Re-frozen at SIM_VERSION 47: urban-jungle's team-0 ring lost the outpost
  // plate turret the half-cell pad key had leaked into it (9 -> 8).
  // Re-frozen at SIM_VERSION 48: the arena's four original outposts replace its
  // two invented consoles (two more console entities in the store).
  // Re-frozen at SIM_VERSION 67: urban-jungle is layered, with its lifts and
  // its kerbs and spilled walls opened (fcop-fidelity.md P12, P15).
  // Re-frozen at SIM_VERSION 73: its ENE leg crosses team 0's shops, where the
  // wall bit carved for the misplaced ground console's leg now stands.
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 80: the heavy-zone poll's
  // hashed countdown is cfun_tick's, in engine ticks from u32 % period (the same
  // PRNG step); no golden's side reaches 50 points, so none plays differently.
  "golden-05-fcop": { last: 3968233484, count: 2700 },
  "golden-06-layered": { last: 307426003, count: 600 },
  // Re-frozen with Warden soft-target wall pierce (still v24): only golden-07
  // runs a Warden on a core arena, so only its sequence moves.
  // Re-frozen at SIM_VERSION 44 (the original's route followers): 07's bought
  // units drive la-cantina's Cnet by the step chooser at 1.98 m/s.
  // Re-frozen at SIM_VERSION 48: la-cantina's four original outposts.
  // Re-frozen at SIM_VERSION 49: its captain counts each turret twice and roams.
  // Re-frozen at SIM_VERSION 75: the captain's down credit is hashed; its
  // player is never put down here, so nothing plays differently.
  // 02, 03, 04, 05 and 07 re-frozen at SIM_VERSION 80: the heavy-zone poll's
  // hashed countdown is cfun_tick's, in engine ticks from u32 % period (the same
  // PRNG step); no golden's side reaches 50 points, so none plays differently.
  // 03, 04 and 07 re-frozen at SIM_VERSION 82: the hashed First Death and
  // First Outpost stamps read the frame clock from 0 on the first tick (one
  // frame delta earlier); nothing in the tick reads them.
  "golden-07-pa": { last: 525158370, count: 3600 },
  // SIM_VERSION 26 (ten-weapon PA catalog): only golden-02-combat fires special
  // and moves mid-sequence; last-hash pins above stay the same numbers.
};

describe("single-story golden last-hash pins", () => {
  for (const [name, exp] of Object.entries(FROZEN)) {
    it(`${name}: last hash + tick count frozen`, () => {
      const h = JSON.parse(
        readFileSync(join(import.meta.dir, "goldens", `${name}.hashes.json`), "utf8"),
      );
      expect(h.hashes.length).toBe(exp.count);
      expect(h.hashes[h.hashes.length - 1]).toBe(exp.last);
    });
  }
});
