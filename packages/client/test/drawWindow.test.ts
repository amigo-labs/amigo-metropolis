// The 5 x 5 block of cells the Props and DCSQuads are drawn in
// (render/drawWindow.ts) against `world_view_focus` (RE draw.c 0x00452880) and
// the two block walkers (snd/emitter.c 0x0042fe20, world/pyro_chain.c 0x00437310).

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  cellXOf,
  cellZOf,
  createDrawWindow,
  DRAW_CELL_M,
  inDrawWindow,
  inView,
  placeDrawWindow,
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
