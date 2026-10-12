// Frozen last-hash pins for single-story goldens. 01–04 must stay bit-identical
// when only FCOP feature authoring changes (they do not load those maps).
//
// Re-frozen at SIM_VERSION 27 for the hitbox rescale: ARCHETYPE_RADIUS now
// follows the models, and match01's dead reckoning follows the quantised heading
// the sim actually drives. Every golden that shoots or walks a script moves;
// 05 and 06 do not (05 moved for the pad stamp, in the same version).
// golden-05 (urban-jungle) is re-frozen when that map's features move — see
// SIM_VERSION 12. Do NOT re-freeze 01–04 casually; a drift there means a real
// sim regression on district-01 / test-128.
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
  // All seven re-frozen at SIM_VERSION 51 (a purchase is one key press, R17): the
  // hashed purchase-hold state is gone, so every hash moves; 03, 05 and 07 buy by
  // presses.
  // 04 and 07 re-frozen at SIM_VERSION 46: their Warden is the Sky Captain.
  // All seven re-frozen at SIM_VERSION 45: the entity store gained a float field
  // (timerC, a PA aircraft's cruise countdown), so every hash moves; 07's bought
  // units also target as the original's shooters and aircraft do.
  // Re-frozen at SIM_VERSION 19 (on top of v18 hover cushion): facing-aligned
  // drive, PA ring/console/X1 authoring, and combat script aim aligned with travel.
  "golden-01-drive": { last: 4168274754, count: 1800 },
  "golden-02-combat": { last: 4100754031, count: 2700 },
  // Re-frozen at SIM_VERSION 50 (the original's 37.5 s ring respawn, R16): 03's
  // script was rewritten around it (player 1 is put down at the outpost, the wave
  // goes in inside the ring's window) and runs 200 s.
  "golden-03-match": { last: 3180602161, count: 6000 },
  "golden-04-warden": { last: 3098996875, count: 9000 },
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
  "golden-05-fcop": { last: 4094360672, count: 2700 },
  "golden-06-layered": { last: 1008349113, count: 600 },
  // Re-frozen with Warden soft-target wall pierce (still v24): only golden-07
  // runs a Warden on a core arena, so only its sequence moves.
  // Re-frozen at SIM_VERSION 44 (the original's route followers): 07's bought
  // units drive la-cantina's Cnet by the step chooser at 1.98 m/s.
  // Re-frozen at SIM_VERSION 48: la-cantina's four original outposts.
  // Re-frozen at SIM_VERSION 49: its captain counts each turret twice and roams.
  "golden-07-pa": { last: 2457578559, count: 3600 },
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
