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
  // Re-frozen at SIM_VERSION 18, and it is the ONLY golden that moved: this is
  // the one replay that drives in hover (transform at t=20 s, then north and east
  // across district-01's river), and the hover now judges a climb over its own
  // 2.4 m footprint at a 0.5 limit instead of over a tick's 0.3 m at 0.35
  // (issue #34). 01, 03 and 04 stay byte-identical on the same maps, which is the
  // proof that the walker's half of `slopeBlocks` is unchanged arithmetic.
  "golden-02-combat": { last: 1398668665, count: 2700 },
  "golden-03-match": { last: 3539373696, count: 4500 },
  "golden-04-warden": { last: 2257654512, count: 9000 },
  // Re-frozen at SIM_VERSION 16: produced units follow the Cnet road at a 0.5 m
  // arrival radius instead of cutting corners at 3 m, and urban-jungle's walls
  // moved with it — 283 edited bits instead of 242, including team 0's production
  // console leg, which was walled off from the road entirely (issue #30).
  // (Previously re-frozen at v15 for the ring turrets' imported 6 m reach, and at
  // v14 for the Conft rebuild.) This one is EXPECTED to move; 01-04 are not.
  // Re-frozen at SIM_VERSION 17: urban-jungle's four built-in base guns carry 500 HP
  // instead of the base structure's 3000 (BASE_DEFENCE_HP, issue #31), which is in
  // the tick hash from tick 0. The Warden rungs also changed, but this replay's
  // Warden is not what moves it — the map field alone does.
  "golden-05-fcop": { last: 2668007662, count: 2700 },
  // Frozen at SIM_VERSION 14. layered-test is synthetic and untouched by the FCOP
  // work, so this is a pure no-op pin like 01-04 — it just never had one.
  "golden-06-layered": { last: 873045128, count: 600 },
  // Frozen at SIM_VERSION 13, the Precinct Assault mode. This one is NOT a no-op
  // pin like the others: it is the first golden recorded on a PA arena, so any
  // change to production, graph traversal, turret profiles, pickups, alerts or
  // the core objective moves it — deliberately, and it must be justified.
  // It survived v14's carve fix unchanged even though la-cantina's wall pins
  // moved: the recorded trajectory never touches one of the 33 new open bits.
  // Re-frozen at SIM_VERSION 15: the ring turrets got their imported 6 m
  // engage_range in place of the 28 m global, plus slew, FOV and the original's
  // 500 HP. Visible in the replay's own beats — the Warden-escorted push now
  // reaches an enemy base and trips 16 intrusion alarms where it previously
  // tripped none.
  // Re-frozen again at SIM_VERSION 16: units walk the road rather than cutting
  // across it (0.5 m arrival radius instead of 3), and Mp's walls moved from 99 to
  // 117 edited bits — the corridor the carve opens either side of a road that runs
  // along a lattice line. golden-07's own beats still hold: production, capture and
  // the intrusion alarm are all asserted in golden07.test.ts and none of them
  // needed a new expectation.
  // Re-frozen again at SIM_VERSION 17, for both halves of issue #31's first pass:
  // la-cantina's built-in base guns drop from the core's 3000 HP to the originals'
  // 500 (in the hash from tick 0), and the Warden's goal ladder now reads the
  // arena's rule set — it stops treating the free production stream as a permanent
  // home-defence emergency (63% of ticks on this arena) and stops abandoning a push
  // that has reached the enemy core. That moves this replay's whole trajectory, not
  // just its opening hash. golden07.test.ts's own beats still hold unchanged:
  // production cadence, capture, and the intrusion alarm.
  "golden-07-pa": { last: 2351535758, count: 3600 },
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
