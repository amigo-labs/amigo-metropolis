// render/props.ts must ask for exactly the files gen:units writes: each arena's
// own folder (tools/generators/units/manifest.ts ARENA_SCENERY), never another
// arena's model for the same Cobj id. The client keeps its own URL builder (it
// must not import tools/ at runtime); this pins it to the committed files for
// every placement of every arena's scenery table (render/arenaScenery.generated.ts).
// Same cross-workspace test import precedent as fxAtlas.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROP_MODELS } from "../../../tools/generators/units/manifest";
import { SCENERY_PLACEMENTS } from "../src/render/arenaScenery.generated";
import { propModelUrl, sceneryOf } from "../src/render/props";

const PUBLIC = join(import.meta.dir, "..", "public");

describe("scenery model URLs", () => {
  test("every placement of every arena resolves to a committed file of its arena", () => {
    let placements = 0;
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const p of scenery.placements) {
        const url = propModelUrl(mapId, p.cobj);
        expect(url.startsWith(`/models/props/${mapId}/`)).toBe(true);
        expect(existsSync(join(PUBLIC, url))).toBe(true);
        placements++;
      }
    }
    expect(placements).toBe(6 * 36);
    // A map of no mission has none.
    expect(sceneryOf("test-128")).toBeNull();
  });

  test("the URL builder names the file each manifest entry is written to", () => {
    for (const spec of PROP_MODELS) {
      expect(propModelUrl(spec.mapId, spec.cobj)).toBe(
        `/models/props/${spec.mapId}/${spec.key}.glb`,
      );
    }
  });
});
