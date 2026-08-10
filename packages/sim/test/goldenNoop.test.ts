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

const FROZEN: Record<string, { last: number; count: number }> = {
  // Re-frozen at SIM_VERSION 19 (on top of v18 hover cushion): facing-aligned
  // drive, PA ring/console/X1 authoring, and combat script aim aligned with travel.
  "golden-01-drive": { last: 113035764, count: 1800 },
  "golden-02-combat": { last: 813398019, count: 2700 },
  // Re-frozen at SIM_VERSION 24 (issue #31): BASE_TURRET_RESPAWN 60→120 s is
  // global, so scripts that kill a base emplacement and live past the old timer
  // move (03/04). golden-07-pa also moves from the §9 escort/capture ladder.
  // 01/02/05/06 header-only.
  "golden-03-match": { last: 1287878021, count: 4500 },
  "golden-04-warden": { last: 4033123080, count: 9000 },
  // Re-frozen at SIM_VERSION 27: urban-jungle's two sunken outpost pads were
  // lifted onto the plate the terrain mesh draws over them (8 cells). This is
  // the only single-story golden on that map, and the only one of the seven
  // whose hashes move.
  "golden-05-fcop": { last: 3353300176, count: 2700 },
  "golden-06-layered": { last: 3787894536, count: 600 },
  // Re-frozen with Warden soft-target wall pierce (still v24): only golden-07
  // runs a Warden on a core arena, so only its sequence moves.
  "golden-07-pa": { last: 2801867636, count: 3600 },
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
