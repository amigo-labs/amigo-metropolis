// Frozen last-hash pins for single-story goldens. 01–04 must stay bit-identical
// when only FCOP feature authoring changes (they do not load those maps).
// golden-05 (urban-jungle) is re-frozen when that map's features move — see
// SIM_VERSION 12. Do NOT re-freeze 01–04 casually; a drift there means a real
// sim regression on district-01 / test-128.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FROZEN: Record<string, { last: number; count: number }> = {
  // Re-frozen at SIM_VERSION 19 (on top of v18 hover cushion): facing-aligned
  // drive, PA ring/console/X1 authoring, and combat script aim aligned with travel.
  "golden-01-drive": { last: 3720970189, count: 1800 },
  "golden-02-combat": { last: 26623427, count: 2700 },
  // Re-frozen at SIM_VERSION 23 with 03/04/07: BASE_TURRET_RESPAWN_TICKS 60→120 s
  // is global, so any script that kills a base emplacement and lives past the
  // old timer sees a different world. 01/02/05/06 still byte-identical (header
  // only) — none of those scripts hold a dead ring turret long enough for the
  // timer to matter.
  "golden-03-match": { last: 789235038, count: 4500 },
  "golden-04-warden": { last: 4033123080, count: 9000 },
  "golden-05-fcop": { last: 2751040396, count: 2700 },
  "golden-06-layered": { last: 3787894536, count: 600 },
  "golden-07-pa": { last: 115691331, count: 3600 },
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
