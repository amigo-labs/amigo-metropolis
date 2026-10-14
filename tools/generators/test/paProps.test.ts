// Every pickup and lift model an arena names has its own .glb in the client
// (packages/client/public/models/pa-props/<mapId>/, `bun run gen:paprops`), so
// render/pickups.ts never asks for a file that is not there. The same Cobj id is
// a different file on every arena (its own texture pages), hence the folder.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getMapById } from "@metropolis/sim";
import { FCOP_ARENAS } from "../fcopArenas";
import { paPropPath } from "../fcopPaProps";

const PUBLIC = join(import.meta.dir, "..", "..", "..", "packages", "client", "public");

describe("pa-props", () => {
  for (const arena of FCOP_ARENAS) {
    test(`${arena.mapId}: every pickup's model is committed`, () => {
      const map = getMapById(arena.mapId);
      expect(map.pickups.length).toBeGreaterThan(0);
      for (const p of map.pickups) {
        expect(p.model).toBeGreaterThanOrEqual(0);
        expect(existsSync(join(PUBLIC, paPropPath(arena.mapId, p.model)))).toBe(true);
      }
    });
  }
});
