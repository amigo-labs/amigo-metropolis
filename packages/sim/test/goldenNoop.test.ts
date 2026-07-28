// Frozen last-hash pins for single-story goldens. 01–04 must stay bit-identical
// when only FCOP feature authoring changes (they do not load those maps).
// golden-05 (urban-jungle) is re-frozen when that map's features move — see
// SIM_VERSION 12. Do NOT re-freeze 01–04 casually; a drift there means a real
// sim regression on district-01 / test-128.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FROZEN: Record<string, { last: number; count: number }> = {
  "golden-01-drive": { last: 1396534480, count: 1800 },
  "golden-02-combat": { last: 647416902, count: 2700 },
  "golden-03-match": { last: 3539373696, count: 4500 },
  "golden-04-warden": { last: 2257654512, count: 9000 },
  // Re-frozen at SIM_VERSION 14: urban-jungle rebuilt from the original Conft
  // logic (issue #30). Features moved one Til east, the lane carve opened the
  // original one-way roads, and the arena gained the full §9 data set — 70-odd
  // more turret entities, free production and a real Cnet graph. This one is
  // EXPECTED to move; 01-04 are not.
  "golden-05-fcop": { last: 3007168406, count: 2700 },
  // Frozen at SIM_VERSION 14. layered-test is synthetic and untouched by the FCOP
  // work, so this is a pure no-op pin like 01-04 — it just never had one.
  "golden-06-layered": { last: 873045128, count: 600 },
  // Frozen at SIM_VERSION 13, the Precinct Assault mode. This one is NOT a no-op
  // pin like the others: it is the first golden recorded on a PA arena, so any
  // change to production, graph traversal, turret profiles, pickups, alerts or
  // the core objective moves it — deliberately, and it must be justified.
  // It survived v14's carve fix unchanged even though la-cantina's wall pins
  // moved: the recorded trajectory never touches one of the 33 new open bits.
  "golden-07-pa": { last: 2273753231, count: 3600 },
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
