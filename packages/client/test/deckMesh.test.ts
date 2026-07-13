// buildDeckMeshes turns the sim's layerHeights/layerMask arrays into one Tier-1
// render mesh per extra deck. Pure THREE geometry (no WebGL/DOM), so it runs in
// bun — a deterministic stand-in for the flaky headless screenshot.
import { describe, expect, it } from "bun:test";
import { DISTRICT_01_ID, getMapById, HOLLYWOOD_KEYS_ID, LAYERED_TEST_ID } from "@metropolis/sim";
import { buildDeckMeshes } from "../src/render/terrain";

describe("buildDeckMeshes", () => {
  it("returns no meshes for a single-story map", () => {
    expect(buildDeckMeshes(getMapById(DISTRICT_01_ID)).length).toBe(0);
  });

  it("builds one non-empty mesh per extra deck of a layered map", () => {
    const meshes = buildDeckMeshes(getMapById(LAYERED_TEST_ID));
    expect(meshes.length).toBeGreaterThanOrEqual(1);
    for (const m of meshes) {
      const pos = m.geometry.getAttribute("position");
      const idx = m.geometry.getIndex();
      expect(pos.count).toBeGreaterThan(0);
      expect(idx).not.toBeNull();
      expect(idx?.count).toBeGreaterThan(0);
      expect(m.matrixAutoUpdate).toBe(false); // renderer rule: static, no per-frame matrix
    }
  });

  it("renders decks for Hollywood Keys at the collision-authored heights", () => {
    const map = getMapById(HOLLYWOOD_KEYS_ID);
    const meshes = buildDeckMeshes(map);
    expect(meshes.length).toBe(2); // layer 1 (deck) + layer 2 (roof)
    // Deck vertex y-values must come straight from map.layerHeights (single
    // source of truth with collision), never the base terrain.
    const pos = meshes[0].geometry.getAttribute("position");
    let maxY = -Infinity;
    for (let v = 0; v < pos.count; v++) maxY = Math.max(maxY, pos.getY(v));
    let maxLayer = -Infinity;
    for (const h of map.layerHeights[0]) maxLayer = Math.max(maxLayer, h);
    expect(maxY).toBeCloseTo(maxLayer, 5);
  });
});
