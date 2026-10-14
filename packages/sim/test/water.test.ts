// The original's water (fcop-fidelity.md P13): surface code 1 on Hk and Ovmp,
// imported per cell with each cell's own surface. Metropolis plays NORMAL: a
// walker that enters water changes to hover on its own, a hover rides on the
// water, and on water a transform is refused in either form. HARD's sinking
// and drowning are not modelled.

import { describe, expect, it } from "bun:test";
import { HOVER_CLEARANCE, TRANSFORM_LOCK_TICKS } from "../src/balance";
import { EV_TRANSFORM_REFUSED, EVENT_STRIDE } from "../src/events";
import { createTickInputs, TRANSFORM_CHORD } from "../src/inputs";
import {
  getMapById,
  HOLLYWOOD_KEYS_ID,
  isWater,
  LA_CANTINA_ID,
  type MapData,
  resolveHeight,
  VENICE_BEACH_ID,
  waterHeightAt,
} from "../src/map";
import { createSim, MODE_HOVER, type SimState, step } from "../src/sim";

const idle = createTickInputs();

function refused(state: SimState): boolean {
  for (let i = 0; i < state.events.count; i++) {
    if (state.events.data[i * EVENT_STRIDE] === EV_TRANSFORM_REFUSED) return true;
  }
  return false;
}

function waterCells(map: MapData): number {
  let n = 0;
  for (const w of map.waterMask) n += w;
  return n;
}

describe("water", () => {
  it("lies on Hk and Ovmp only, at the original's levels", () => {
    const hk = getMapById(HOLLYWOOD_KEYS_ID);
    const ovmp = getMapById(VENICE_BEACH_ID);
    expect(waterCells(hk)).toBeGreaterThan(40000);
    expect(waterCells(ovmp)).toBeGreaterThan(10000);
    expect(hk.waterLevel).toBe(-0.96875);
    expect(ovmp.waterLevel).toBe(-2.5);
    expect(waterCells(getMapById(LA_CANTINA_ID))).toBe(0);
  });

  it("carries Hk's mechs hovering on it from the spawn, and refuses their transform", () => {
    const map = getMapById(HOLLYWOOD_KEYS_ID);
    const state = createSim(map, 1);
    const a0 = state.avatarId[0];
    const s0 = map.spawns[0];
    expect(isWater(map, s0.x, s0.y)).toBe(true);
    for (let t = 0; t < 30; t++) step(state, idle);
    expect(state.ent.mode[a0]).toBe(MODE_HOVER);
    const surface = waterHeightAt(map, state.ent.posX[a0], state.ent.posY[a0]);
    expect(state.ent.height[a0]).toBeCloseTo(surface + HOVER_CLEARANCE, 1);

    const press = createTickInputs();
    press.players[0].buttons = TRANSFORM_CHORD;
    step(state, press);
    expect(refused(state)).toBe(true);
    expect(state.ent.mode[a0]).toBe(MODE_HOVER);
  });

  it("turns a walker that enters it into a hover (NORMAL)", () => {
    const map = getMapById(VENICE_BEACH_ID);
    const state = createSim(map, 1);
    const a0 = state.avatarId[0];
    // The water cell nearest team 0's spawn.
    const s0 = map.spawns[0];
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < map.waterMask.length; k++) {
      if (map.waterMask[k] !== 1) continue;
      const i = k % map.size;
      const j = (k - i) / map.size;
      const d = (i + 0.5 - s0.x) ** 2 + (j + 0.5 - s0.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const x = (best % map.size) + 0.5;
    const y = Math.floor(best / map.size) + 0.5;
    expect(state.ent.mode[a0]).not.toBe(MODE_HOVER);
    state.ent.posX[a0] = x;
    state.ent.posY[a0] = y;
    state.ent.height[a0] = resolveHeight(map, x, y, 0);
    step(state, idle);
    expect(state.ent.mode[a0]).toBe(MODE_HOVER);
    for (let t = 0; t < TRANSFORM_LOCK_TICKS + 30; t++) step(state, idle);
    expect(state.ent.height[a0]).toBeGreaterThan(waterHeightAt(map, x, y));
  });

  it("reads the water plate, imported as deck 1, as water", () => {
    // Hk and Ovmp carry the water surface as deck 1 at the water level; a
    // walker that walks onto it stands on that deck. Until SIM_VERSION 63 only
    // the ground surface counted, and a walker could walk on the water.
    const map = getMapById(VENICE_BEACH_ID);
    const state = createSim(map, 1);
    const a0 = state.avatarId[0];
    let k = 0;
    while (!(map.waterMask[k] === 1 && map.layerMask[0][k] === 1)) k++;
    const x = (k % map.size) + 0.5;
    const y = Math.floor(k / map.size) + 0.5;
    state.ent.posX[a0] = x;
    state.ent.posY[a0] = y;
    state.ent.height[a0] = resolveHeight(map, x, y, 1);
    state.ent.entLayer[a0] = 1;
    expect(state.ent.height[a0]).toBeCloseTo(waterHeightAt(map, x, y), 3);
    step(state, idle);
    expect(state.ent.mode[a0]).toBe(MODE_HOVER);
  });
});
