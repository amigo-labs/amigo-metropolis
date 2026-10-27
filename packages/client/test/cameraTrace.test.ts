// The chase camera's line of sight (render/cameraTrace.ts) and the original's
// see-through plates (`view_trace` 0x00445df0, RE M3-GD): a plate whose
// material carries bit 7 does not block, opaque ones do.

import { describe, expect, test } from "bun:test";
import { getMapById, sampleHeight, sampleLayerHeight } from "@metropolis/sim";
import { makeTerrainHit, makeTerrainTrace, terrainHitAt } from "../src/render/cameraTrace";
import { VIEW_TERRAIN } from "../src/render/viewTerrain.generated";

const map = getMapById("la-cantina");
const cells = map.size - 1;
const deck = 0;
const see = new Set(VIEW_TERRAIN["la-cantina"].seeThrough[deck + 1]);

/** A cell centre where deck 0 is present at all four corners, see-through or not. */
function deckCell(wantSee: boolean): { x: number; y: number } {
  const mask = map.layerMask[deck];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (see.has(j * cells + i) !== wantSee) continue;
      if (
        mask[j * map.size + i] !== 1 ||
        mask[j * map.size + i + 1] !== 1 ||
        mask[(j + 1) * map.size + i] !== 1 ||
        mask[(j + 1) * map.size + i + 1] !== 1
      )
        continue;
      const x = i + 0.5;
      const y = j + 0.5;
      // Room under the deck for an anchor above the ground.
      if (sampleLayerHeight(map, deck, x, y) - sampleHeight(map, x, y) < 1.5) continue;
      return { x, y };
    }
  }
  throw new Error(`no ${wantSee ? "see-through" : "opaque"} deck cell`);
}

describe("view_trace's see-through plates", () => {
  const trace = makeTerrainTrace(map);
  const hit = makeTerrainHit(map);

  test("la-cantina's catwalks are see-through; no other arena's surfaces are", () => {
    expect(see.size).toBeGreaterThan(0);
    for (const [id, t] of Object.entries(VIEW_TERRAIN)) {
      if (id === "la-cantina") continue;
      for (const cellsOf of t.seeThrough) expect(cellsOf.length).toBe(0);
    }
  });

  test("a see-through deck is hit, flagged, and seen through", () => {
    const { x, y } = deckCell(true);
    const top = sampleLayerHeight(map, deck, x, y);
    expect(hit(x, top - 0.5, y, x, top + 3, y)).toBeLessThan(1);
    expect(terrainHitAt.seeThrough).toBe(true);
    expect(trace(x, top - 0.5, y, x, top + 3, y)).toBe(false);
  });

  test("an opaque deck still blocks", () => {
    const { x, y } = deckCell(false);
    const top = sampleLayerHeight(map, deck, x, y);
    expect(trace(x, top - 0.5, y, x, top + 3, y)).toBe(true);
    expect(terrainHitAt.seeThrough).toBe(false);
  });

  test("the ground blocks", () => {
    const { x, y } = deckCell(true);
    const ground = sampleHeight(map, x, y);
    expect(trace(x, ground + 0.5, y, x + 8, ground - 4, y)).toBe(true);
  });
});
