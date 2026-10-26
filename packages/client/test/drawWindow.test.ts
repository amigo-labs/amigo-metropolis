// The 5 x 5 block of cells the Props and DCSQuads are drawn in
// (render/drawWindow.ts) against `world_view_focus` (RE draw.c 0x00452880) and
// the two block walkers (snd/emitter.c 0x0042fe20, world/pyro_chain.c 0x00437310).

import { describe, expect, test } from "bun:test";
import { getMapById, sampleHeight } from "@metropolis/sim";
import * as THREE from "three";
import { SCENERY_PLACEMENTS } from "../src/render/arenaScenery.generated";
import {
  cellXOf,
  cellZOf,
  createDrawWindow,
  createLeafView,
  DRAW_CELL_M,
  emitterDrawn,
  inDrawWindow,
  inView,
  type LeafTree,
  leafMask,
  placeDrawWindow,
  updateLeafView,
} from "../src/render/drawWindow";

function cameraAt(x: number, y: number, z: number, tx: number, ty: number, tz: number) {
  const c = new THREE.PerspectiveCamera(26.38, 4 / 3, 0.1, 2000);
  c.position.set(x, y, z);
  c.lookAt(tx, ty, tz);
  c.updateMatrixWorld();
  return c;
}

describe("the cells (>> 17 of the original's world, origin at the map's (16, 0))", () => {
  test("16 m cells from the original's origin", () => {
    expect(DRAW_CELL_M).toBe(16);
    expect(cellZOf(16)).toBe(0);
    expect(cellZOf(15.99)).toBe(-1);
    expect(cellZOf(16 + 16 * 3 + 0.5)).toBe(3);
    expect(cellXOf(47.9)).toBe(2);
  });
});

describe("world_view_focus: the block about the ground focus", () => {
  test("the camera's axis meets the plane at height 0; the block starts two cells back", () => {
    // Looking down at (100, 0, 60): cells z 5 ((100-16)/16), x 3 (60/16).
    const cam = cameraAt(100, 10, 50, 100, 0, 60);
    const win = createDrawWindow();
    expect(placeDrawWindow(win, cam.matrixWorld.elements, 0)).toBe(true);
    expect(win.cellZ).toBe(5 - 2);
    expect(win.cellX).toBe(3 - 2);
    // Unchanged: nothing to write.
    expect(placeDrawWindow(win, cam.matrixWorld.elements, 0)).toBe(false);
    expect(inDrawWindow(win, 3, 1)).toBe(true);
    expect(inDrawWindow(win, 7, 5)).toBe(true);
    expect(inDrawWindow(win, 8, 3)).toBe(false);
    expect(inDrawWindow(win, 5, 0)).toBe(false);
  });

  test("the plane is the player's height only below zero", () => {
    const cam = cameraAt(100, 10, 50, 100, 0, 60);
    const high = createDrawWindow();
    placeDrawWindow(high, cam.matrixWorld.elements, 5);
    const low = createDrawWindow();
    placeDrawWindow(low, cam.matrixWorld.elements, -20);
    expect(high.cellX).toBe(1);
    // At -20 the axis runs on to z = 50 + 3 * 10 = 80: cell 5.
    expect(low.cellX).toBe(5 - 2);
  });

  test("unplaced, everything is drawn", () => {
    expect(inDrawWindow(createDrawWindow(), 99, -99)).toBe(true);
  });
});

describe("inView: a sphere against the frustum", () => {
  test("ahead in, behind out, beside by its radius", () => {
    const cam = cameraAt(0, 2, 0, 10, 2, 0);
    cam.updateProjectionMatrix();
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    expect(inView(m.elements, 20, 2, 0, 0.5)).toBe(true);
    expect(inView(m.elements, -20, 2, 0, 0.5)).toBe(false);
    // 20 m ahead the half-height is ~4.7 m: 8 m up is out, unless the sphere reaches.
    expect(inView(m.elements, 20, 10, 0, 0.5)).toBe(false);
    expect(inView(m.elements, 20, 10, 0, 4)).toBe(true);
  });
});

describe("the quadtree's leaves on screen (world_build_tile_block, draw_node_visible)", () => {
  /**
   * A tree whose cell and children reach everything and whose leaves are 0.1 m:
   * 21 (radius, height) pairs, pair k tree bit k (the cell 0, children 1..4,
   * child n's leaves 4 n + 1..4 n + 4).
   */
  function tree(cz: number, cx: number, leafHeight = 0): LeafTree {
    const big = 20 * 512; // 20 m in 16-unit halfwords
    const spheres: number[] = [];
    for (let k = 0; k < 5; k++) spheres.push(big, 0);
    for (let k = 0; k < 16; k++) spheres.push(51, leafHeight);
    return { cz, cx, spheres };
  }
  function looking(x: number, y: number) {
    // Straight down from 5 m: about 1.2 m of ground either way.
    const cam = new THREE.PerspectiveCamera(26.38, 1, 0.1, 100);
    cam.position.set(x, 5, y);
    cam.up.set(1, 0, 0);
    cam.lookAt(x, 0, y);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      .elements;
  }

  test("leaf (x, z) is bit 0x8000 >> (4 x + z): x along the map's y, z along its x", () => {
    // Cell (cz 2, cx 3): map x 48..64, y 48..64. Leaf x 1, z 2: map x 58, y 54.
    expect(leafMask(looking(58, 54), tree(2, 3))).toBe(0x8000 >> 6);
    // Leaf x 3, z 0: map x 50, y 62.
    expect(leafMask(looking(50, 62), tree(2, 3))).toBe(0x8000 >> 12);
    // Leaf x 0, z 3: map x 62, y 50 — the transpose of the one above.
    expect(leafMask(looking(62, 50), tree(2, 3))).toBe(0x8000 >> 3);
  });

  test("each leaf reads its own pair: child n's leaf p is pair 4 n + 1 + p", () => {
    // Leaf (x 1, z 2) is in child 2 (x half 0, z half 1); within it, it is
    // (x 1, z 0), so p = 2 and the pair is 4 * 2 + 1 + 2 = 11.
    const t = tree(2, 3);
    const lifted = { ...t, spheres: [...t.spheres] };
    lifted.spheres[2 * 11 + 1] = 0x1000; // 8 m up: above the camera
    expect(leafMask(looking(58, 54), lifted)).toBe(0);
    // Any other leaf's pair lifted leaves it on screen.
    for (let pair = 5; pair <= 20; pair++) {
      if (pair === 11) continue;
      const other = { ...t, spheres: [...t.spheres] };
      other.spheres[2 * pair + 1] = 0x1000;
      expect(leafMask(looking(58, 54), other), `pair ${pair}`).toBe(0x8000 >> 6);
    }
  });

  test("a sphere stands at its height: lifted out of the view it is off", () => {
    // 0x1000 halfwords: (0x1000 >> 4) x 256 units, 8 m up, above the camera.
    expect(leafMask(looking(58, 54), tree(2, 3, 0x1000))).toBe(0);
  });

  test("the cell's sphere and its child's gate their leaves", () => {
    const t = tree(2, 3);
    const offCell = { ...t, spheres: [1, 0x3000, ...t.spheres.slice(2)] };
    expect(leafMask(looking(58, 54), offCell)).toBe(0);
    // Child 2 (x half 0, z half 1), pair 2, holds leaf (1, 2).
    const offChild = { ...t, spheres: [...t.spheres] };
    offChild.spheres[2 * 2] = 1;
    offChild.spheres[2 * 2 + 1] = 0x3000;
    expect(leafMask(looking(58, 54), offChild)).toBe(0);
    // Child 3 (x half 1, z half 0) does not.
    const offOther = { ...t, spheres: [...t.spheres] };
    offOther.spheres[2 * 3] = 1;
    offOther.spheres[2 * 3 + 1] = 0x3000;
    expect(leafMask(looking(58, 54), offOther)).toBe(0x8000 >> 6);
  });

  test("snd_emit_draw_block: in the block, and the footprint meets a leaf on screen", () => {
    const win = createDrawWindow();
    const view = createLeafView(1);
    // Unplaced: everything.
    expect(emitterDrawn(win, view, 2, 3, 0, 0x8000)).toBe(true);
    win.placed = true;
    win.cellZ = 0;
    win.cellX = 1;
    // No camera yet: the block alone.
    expect(emitterDrawn(win, view, 2, 3, 0, 0x8000)).toBe(true);
    updateLeafView(view, [tree(2, 3)], win, looking(58, 54));
    expect(view.masks[0]).toBe(0x8000 >> 6);
    expect(emitterDrawn(win, view, 2, 3, 0, 0x8000 >> 6)).toBe(true);
    expect(emitterDrawn(win, view, 2, 3, 0, 0x8000)).toBe(false);
    // A cell with no section, or outside the block, is not drawn.
    expect(emitterDrawn(win, view, 2, 3, -1, 0xffff)).toBe(false);
    expect(emitterDrawn(win, view, 9, 3, 0, 0xffff)).toBe(false);
    // A tree outside the block answers nothing.
    win.cellZ = 3;
    updateLeafView(view, [tree(2, 3)], win, looking(58, 54));
    expect(view.masks[0]).toBe(0);
  });

  test("every arena's leaves stand at its ground, x along the map's y", () => {
    // The shipped trees' leaf heights, read at the quarter the walk puts them
    // in, against the sim's own heightfield: the x-major reading agrees, the
    // transposed one does not as well.
    let arenas = 0;
    for (const [id, s] of Object.entries(SCENERY_PLACEMENTS)) {
      if (s.leafTrees.length === 0) continue;
      arenas++;
      const map = getMapById(id);
      let err = 0;
      let swapped = 0;
      let n = 0;
      for (const t of s.leafTrees) {
        for (let child = 0; child < 4; child++) {
          for (let leaf = 0; leaf < 4; leaf++) {
            const qx = (child >> 1) * 2 + (leaf >> 1);
            const qz = (child & 1) * 2 + (leaf & 1);
            const pair = 4 * (child + 1) + 1 + leaf;
            const h = ((t.spheres[2 * pair + 1] >> 4) * 256) / 8192;
            err += Math.abs(
              h - sampleHeight(map, 16 + t.cz * 16 + qz * 4 + 2, t.cx * 16 + qx * 4 + 2),
            );
            swapped += Math.abs(
              h - sampleHeight(map, 16 + t.cz * 16 + qx * 4 + 2, t.cx * 16 + qz * 4 + 2),
            );
            n++;
          }
        }
      }
      expect(err / n, id).toBeLessThan(1.5);
      expect(err, id).toBeLessThan(swapped);
    }
    expect(arenas).toBe(4);
  });
});
