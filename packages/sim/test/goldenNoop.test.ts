// Frozen last-hash pins for single-story goldens. 01–04 must stay bit-identical
// when only FCOP feature authoring changes (they do not load those maps).
// golden-05 (urban-jungle) is re-frozen when that map's features move — see
// SIM_VERSION 11. Do NOT re-freeze 01–04 casually; a drift there means a real
// sim regression on district-01 / test-128.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FROZEN: Record<string, { last: number; count: number }> = {
  "golden-01-drive": { last: 1396534480, count: 1800 },
  "golden-02-combat": { last: 647416902, count: 2700 },
  "golden-03-match": { last: 3539373696, count: 4500 },
  "golden-04-warden": { last: 2257654512, count: 9000 },
  // Re-frozen at SIM_VERSION 11 after X1Alpha-based urban-jungle re-author.
  "golden-05-fcop": { last: 1733317849, count: 2700 },
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
