// The chase camera's line of sight (render/cameraTrace.ts) and the original's
// see-through plates (`view_trace` 0x00445df0, RE M3-GD): on the plates of the
// terrain trace (fcop-fidelity.md T1), a plate whose material carries bit 7
// does not block, opaque ones do.

import { describe, expect, test } from "bun:test";
import {
  getMapById,
  type MapData,
  newTraceScratch,
  sampleHeight,
  sampleLayerHeight,
  TRACE_PASSTHROUGH,
  traceHit,
  traceLine,
} from "@metropolis/sim";
import { makeTerrainHit, makeTerrainTrace, terrainHitAt } from "../src/render/cameraTrace";

const map = getMapById("la-cantina");
const deck = 0;

/**
 * A cell centre on deck 0 with room under it whose deck plate, met from under
 * it by the trace, is see-through or not: (x, y, the deck's height there).
 */
function deckSpot(m: MapData, wantSee: boolean): { x: number; y: number; top: number } | null {
  const s = m.size;
  const mask = m.layerMask[deck];
  for (let j = 1; j < s - 2; j++) {
    for (let i = 1; i < s - 2; i++) {
      if (mask[j * s + i] !== 1 || mask[j * s + i + 1] !== 1) continue;
      if (mask[(j + 1) * s + i] !== 1 || mask[(j + 1) * s + i + 1] !== 1) continue;
      const x = i + 0.5;
      const y = j + 0.5;
      const top = sampleLayerHeight(m, deck, x, y);
      if (top - sampleHeight(m, x, y) < 1.5) continue;
      const r = traceLine(m, newTraceScratch(), x, y, top - 0.5, x, y, top + 0.5, 1);
      if (r === 0) continue;
      if (Math.abs(traceHit.h - (top + 0.5)) > 0.6) continue;
      if (((r & TRACE_PASSTHROUGH) !== 0) === wantSee) return { x, y, top };
    }
  }
  return null;
}

describe("view_trace's see-through plates", () => {
  const trace = makeTerrainTrace(map);
  const hit = makeTerrainHit(map);

  test("la-cantina's catwalks are see-through plates; its other decks are not", () => {
    expect(deckSpot(map, true)).not.toBeNull();
    expect(deckSpot(map, false)).not.toBeNull();
  });

  test("a see-through deck is hit, flagged, and seen through", () => {
    const spot = deckSpot(map, true);
    if (spot === null) throw new Error("no see-through deck");
    const { x, y, top } = spot;
    expect(hit(x, top - 0.5, y, x, top + 3, y)).toBeLessThan(1);
    expect(terrainHitAt.seeThrough).toBe(true);
    expect(trace(x, top - 0.5, y, x, top + 3, y)).toBe(false);
  });

  test("an opaque deck still blocks", () => {
    const spot = deckSpot(map, false);
    if (spot === null) throw new Error("no opaque deck");
    const { x, y, top } = spot;
    expect(trace(x, top - 0.5, y, x, top + 3, y)).toBe(true);
    expect(terrainHitAt.seeThrough).toBe(false);
  });

  test("the ground blocks", () => {
    const spot = deckSpot(map, true);
    if (spot === null) throw new Error("no deck");
    const ground = sampleHeight(map, spot.x, spot.y);
    expect(trace(spot.x, ground + 0.5, spot.y, spot.x + 8, ground - 4, spot.y)).toBe(true);
  });

  test("a clear line answers 1, a stopped one the fraction to where it stopped", () => {
    const spot = deckSpot(map, false);
    if (spot === null) throw new Error("no deck");
    const { x, y, top } = spot;
    expect(hit(x, top + 1, y, x + 0.25, top + 3, y)).toBe(1);
    const f = hit(x, top - 1, y, x, top + 3, y);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
  });

  test("a map with no plates samples its heightfield, nothing see-through", () => {
    const flat = getMapById("test-128");
    expect(flat.trace).toBeNull();
    const h = makeTerrainHit(flat);
    const g = sampleHeight(flat, 40, 40);
    expect(h(40, g + 1, 40, 40, g - 1, 40)).toBeLessThan(1);
    expect(terrainHitAt.seeThrough).toBe(false);
    expect(h(40, g + 1, 40, 44, g + 1, 40)).toBe(1);
  });
});
