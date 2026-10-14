// The menu demo battle reuses the Phase 3 feeder script, for either slot: it
// walks to its ground console on the original's buttons and buys runners there.

import { describe, expect, test } from "bun:test";
import {
  BTN_ACTION,
  BTN_FORWARD,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  createSim,
  getMapById,
  LA_CANTINA_ID,
  type PlayerInput,
  type SimState,
} from "@metropolis/sim";
import { createDemoSim, demoFeeder, zeroPlayerInput } from "../src/menuWorld";

describe("demoFeeder", () => {
  test("turns toward its ground console, walks once facing it, then buys", () => {
    const sim = createSim(getMapById(LA_CANTINA_ID), 1);
    const out: PlayerInput = { buttons: 9 };
    const a = sim.avatarId[0];
    const c = sim.map.bases[0].groundConsole;
    // Facing away from the console: it turns, and does not walk yet.
    faceAway(sim, a, c.x, c.y);
    demoFeeder(sim, 0, out);
    expect(out.buttons & (BTN_TURN_LEFT | BTN_TURN_RIGHT)).not.toBe(0);
    expect(out.buttons & BTN_FORWARD).toBe(0);
    // Facing it: straight on.
    faceAt(sim, a, c.x, c.y);
    demoFeeder(sim, 0, out);
    expect(out.buttons).toBe(BTN_FORWARD);
    // On it: one press of the Action Key every 0.5 s in a burst, then a pause.
    sim.ent.posX[a] = c.x;
    sim.ent.posY[a] = c.y;
    (sim as { tick: number }).tick = 15;
    demoFeeder(sim, 0, out);
    expect(out.buttons).toBe(BTN_ACTION);
    (sim as { tick: number }).tick = 16;
    demoFeeder(sim, 0, out);
    expect(out.buttons).toBe(0); // released: the next press is a new edge
    (sim as { tick: number }).tick = 300;
    demoFeeder(sim, 0, out);
    expect(out.buttons).toBe(0); // the 20 s pause
  });
});

function faceAt(sim: SimState, id: number, x: number, y: number): void {
  const dx = x - sim.ent.posX[id];
  const dy = y - sim.ent.posY[id];
  const d = Math.hypot(dx, dy);
  sim.ent.aimX[id] = dx / d;
  sim.ent.aimY[id] = dy / d;
}

function faceAway(sim: SimState, id: number, x: number, y: number): void {
  faceAt(sim, id, x, y);
  sim.ent.aimX[id] = -sim.ent.aimX[id];
  sim.ent.aimY[id] = -sim.ent.aimY[id];
}

describe("zeroPlayerInput", () => {
  test("clears the word", () => {
    const out: PlayerInput = { buttons: 0xffff };
    zeroPlayerInput(out);
    expect(out).toEqual({ buttons: 0 });
  });
});

describe("createDemoSim", () => {
  test("builds a Warden-on-slot-1 sim on the given map", () => {
    const sim = createDemoSim(getMapById(LA_CANTINA_ID));
    expect(sim.wardenPlayer).toBe(1);
    expect(sim.wardenDifficulty).toBe(5);
    expect(sim.tick).toBe(0);
  });
});
