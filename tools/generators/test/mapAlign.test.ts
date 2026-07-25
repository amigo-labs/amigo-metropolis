// Contract test for the COMMITTED terrain alignment (render/mapAlign.generated.ts):
// re-derives every offset straight from the committed .glb + map JSON and asserts
// the generated file still says the same thing.
//
// This is the guard on a bug that shipped once already: the renderer used to
// bbox-centre each arena mesh on worldExtent/2 and lift it by -box.min.y, which
// put the textured terrain 8 cells and 2.5 m away from the sim's collision and
// entities. The offsets are measured, not derived, so nothing but a test can
// keep them honest — if an arena .glb or heightfield is regenerated,
// `bun run gen:mapalign` must be re-run in the same commit.

import { describe, expect, test } from "bun:test";
import { MAP_REGISTRY } from "@metropolis/sim";
import { MAP_ALIGN } from "../../../packages/client/src/render/mapAlign.generated";
import { measureArena } from "../genMapAlign";

/** Mirrors the generator's acceptance thresholds. */
const MIN_MATCH = 0.9;
const MIN_MARGIN = 0.05;

describe("committed terrain alignment matches the heightfields", () => {
  for (const info of MAP_REGISTRY) {
    test(info.id, () => {
      const committed = MAP_ALIGN[info.id];
      expect(committed).toBeDefined();

      const { record, scan } = measureArena(info.id);

      // The measured offset must be exactly what the renderer applies.
      expect(record.x).toBe(committed.x);
      expect(record.y).toBe(committed.y);
      expect(record.z).toBe(committed.z);

      // Y is never translated: the .glb is authored in the sim's height frame.
      expect(committed.y).toBe(0);

      // Every arena so far places its mesh min corner one Til (16 cells) east of
      // grid cell 0 on X and exactly on it in Z. This is a property of the
      // private extractor's grid padding, not a law — if a new arena breaks it,
      // that is worth a human look rather than a silent pass.
      expect(scan.shiftX).toBe(16);
      expect(scan.shiftZ).toBe(0);

      // The recorded bounds are the drift guard meshMap.ts checks at load time.
      expect(record.minX).toBe(committed.minX);
      expect(record.minY).toBe(committed.minY);
      expect(record.minZ).toBe(committed.minZ);
      expect(record.maxX).toBe(committed.maxX);
      expect(record.maxY).toBe(committed.maxY);
      expect(record.maxZ).toBe(committed.maxZ);

      // The fit must stay good, and no rival location may come close (the
      // margin excludes the winner's own correlation shoulders).
      expect(scan.match).toBeGreaterThanOrEqual(MIN_MATCH);
      expect(scan.margin).toBeGreaterThanOrEqual(MIN_MARGIN);
      expect(record.match).toBe(committed.match);
    });
  }
});
