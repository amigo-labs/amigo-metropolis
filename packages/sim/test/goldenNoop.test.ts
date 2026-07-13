// No-op regression for the SIM_VERSION 10 (layered movement) bump. Layered code
// is a proven No-op on single-story maps, so these hash ARRAYS must not change
// across the bump — only the .hashes.json `simVersion` headers are re-recorded.
// Values frozen from the SIM_VERSION 9 goldens (pre-layered). A changed last
// hash or tick count here means the layered code stopped being a No-op on
// single-story maps — do NOT re-freeze; find the divergence.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FROZEN: Record<string, { last: number; count: number }> = {
  "golden-01-drive": { last: 1396534480, count: 1800 },
  "golden-02-combat": { last: 647416902, count: 2700 },
  "golden-03-match": { last: 3539373696, count: 4500 },
  "golden-04-warden": { last: 2257654512, count: 9000 },
  "golden-05-fcop": { last: 3410887904, count: 2700 },
};

describe("single-story goldens unchanged by the layered (v10) bump", () => {
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
