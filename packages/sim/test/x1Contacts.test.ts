// The X1-Alpha against walls, ceilings and the slow row's ledge (fcop-fidelity.md
// P4, P5): the wall contact's push and the facing snap (`player_ground_push`
// 0x00443490, `player_apply_impulse` 0x00443370, `player_snap_facing`
// 0x004437d0), the walker's head-height ceiling (`player_walk_tick`
// 0x004448a6), and the hover's ledge on the slow row (0x00442cea..0x00442d47),
// read along the plane the hover rides.
import { describe, expect, it } from "bun:test";
import {
  HOVER_CLEARANCE,
  HOVER_LEDGE_DROP,
  TRANSFORM_LOCK_TICKS,
  WALKER_HEAD_HEIGHT,
  WALL_PUSH,
} from "../src/balance";
import {
  BTN_ACTION,
  BTN_FORWARD,
  BTN_JUMP,
  createTickInputs,
  TRANSFORM_CHORD,
} from "../src/inputs";
import { loadMapFromJson, type MapJson, sampleHeight } from "../src/map";
import { ANIM_AIRBORNE, createSim, MODE_HOVER, type SimState, step } from "../src/sim";
import { snapFacing, snapTarget } from "../src/walker";
import { face } from "./drive";

const SIZE = 32;
const UNIT = (2 * Math.PI) / 4096;

interface Opts {
  /** Column of a wall line (wallsV) across every row, or -1. */
  wallCol?: number;
  /** A deck over columns 4..9 at this many 1/32 m, or 0. */
  deckQ?: number;
  /** Per-column ground heights (1/32 m), else flat. */
  cols?: number[];
}

function mapJson(o: Opts): MapJson {
  const cols = o.cols ?? new Array(SIZE).fill(0);
  const heights = Array.from({ length: SIZE }, () => [...cols]);
  const none = "0".repeat(SIZE);
  const wallsV = Array.from({ length: SIZE }, () =>
    o.wallCol !== undefined && o.wallCol >= 0
      ? Array.from({ length: SIZE }, (_, i) => (i === o.wallCol ? "1" : "0")).join("")
      : none,
  );
  const json: MapJson = {
    id: "x1-contacts",
    size: SIZE,
    cellSize: 1,
    waterLevel: -100,
    heights,
    water: Array.from({ length: SIZE }, () => none),
    wallsV,
    wallsH: Array.from({ length: SIZE }, () => none),
    spawns: [
      { x: 5, y: 5, yaw: 0 },
      { x: 5, y: 26, yaw: 0 },
    ],
    basePlots: [
      { x: 5, y: 5, radius: 1 },
      { x: 5, y: 26, radius: 1 },
    ],
    bases: [
      {
        gate: { x: 1, y: 1, radius: 1 },
        core: [1, 2],
        groundConsole: [2, 2],
        airConsole: [2, 3],
        turrets: [],
      },
      {
        gate: { x: 30, y: 30, radius: 1 },
        core: [30, 29],
        groundConsole: [29, 29],
        airConsole: [29, 28],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
  if (o.deckQ) {
    const deck = Array.from({ length: SIZE }, () => new Array(SIZE).fill(o.deckQ));
    const mask = Array.from({ length: SIZE }, () =>
      Array.from({ length: SIZE }, (_, i) => (i >= 4 && i <= 9 ? "1" : "0")).join(""),
    );
    json.layers = [{ heights: deck, mask }];
  }
  return json;
}

const inputs = createTickInputs();
const p0 = inputs.players[0];
function reset(): void {
  for (const p of inputs.players) p.buttons = 0;
}

function place(sim: SimState, x: number, y: number, yaw: number, hover: boolean): void {
  sim.ent.posX[0] = x;
  sim.ent.posY[0] = y;
  sim.ent.height[0] = sampleHeight(sim.map, x, y) + (hover ? HOVER_CLEARANCE : 0);
  sim.ent.velX[0] = 0;
  sim.ent.velY[0] = 0;
  face(sim, 0, yaw);
}

function toHover(sim: SimState): void {
  p0.buttons = TRANSFORM_CHORD;
  step(sim, inputs);
  p0.buttons = 0;
  for (let i = 0; i < TRANSFORM_LOCK_TICKS + 1; i++) step(sim, inputs);
  expect(sim.ent.mode[0]).toBe(MODE_HOVER);
}

describe("the facing snap (player_snap_facing 0x004437d0)", () => {
  it("steers toward the direction the wall runs in, unwrapped", () => {
    // Kind 1, a wall across y: 0 / 0x800 / 0x1000 (not 0: above 0xc00 it steps up).
    expect(snapTarget(1, 0x3ff)).toBe(0);
    expect(snapTarget(1, 0x400)).toBe(0x800);
    expect(snapTarget(1, 0xc00)).toBe(0x800);
    expect(snapTarget(1, 0xc01)).toBe(0x1000);
    // Kind 2, a wall across x: 0x400 or 0xc00, split at 0x800.
    expect(snapTarget(2, 0x7ff)).toBe(0x400);
    expect(snapTarget(2, 0x800)).toBe(0xc00);
    // The diagonals, and state 3's -1.
    expect(snapTarget(3, 0x1ff)).toBe(-1);
    expect(snapTarget(3, 0x200)).toBe(0x600);
    expect(snapTarget(3, 0xa01)).toBe(0xe00);
    expect(snapTarget(4, 0x5ff)).toBe(0x200);
    expect(snapTarget(4, 0xe00)).toBe(0xa00);
    expect(snapTarget(4, 0xe01)).toBe(0x1000);
    // Anything else, the actor contact's 0x10 among them: 0.
    expect(snapTarget(0x10, 0x900)).toBe(0);
    // At most 8 a step, masked into a turn after.
    expect(snapFacing(2, 0x100, 1)).toBe(0x108);
    expect(snapFacing(2, 0x3fc, 1)).toBe(0x400);
    expect(snapFacing(1, 0xffc, 1)).toBe(0);
    expect(snapFacing(1, 0x10, 2)).toBe(0);
  });
});

describe("a wall contact (player_ground_push 0x00443490)", () => {
  it("pushes the walker back off the wall and snaps it along the wall", () => {
    reset();
    const sim = createSim(loadMapFromJson(mapJson({ wallCol: 10 })), 1);
    place(sim, 8.5, 5, 0.3, false);
    p0.buttons = BTN_FORWARD;
    let contact = -1;
    for (let t = 0; t < 30 && contact < 0; t++) {
      step(sim, inputs);
      if (sim.avatarSnap[0] !== 0) contact = t;
    }
    expect(contact).toBeGreaterThanOrEqual(0);
    // A wall across x: kind 2, its push along -x, away from it.
    expect(sim.avatarSnap[0]).toBe(2);
    expect(sim.avatarImpulse[0]).toBe(-WALL_PUSH);
    expect(sim.avatarImpulse[1]).toBe(0);
    const yaw0 = sim.ent.yaw[0];
    step(sim, inputs);
    // Spent: the velocity takes the push back off the wall, and the facing
    // turns at most 8 units a step toward 0x400 (+y, along the wall).
    expect(sim.ent.velX[0]).toBeLessThan(0);
    const turned = (sim.ent.yaw[0] - yaw0) / UNIT;
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThan(2 * 8 + 1);
    // Held against it, the walker comes round to run along the wall, and never
    // crosses it.
    for (let t = 0; t < 300; t++) {
      step(sim, inputs);
      expect(sim.ent.posX[0]).toBeLessThan(10);
    }
    expect(sim.ent.yaw[0]).toBeGreaterThan(1.2);
    expect(sim.ent.posY[0]).toBeGreaterThan(8);
  });

  it("halves the push in the hover and turns it at an eighth while it snaps", () => {
    reset();
    const sim = createSim(loadMapFromJson(mapJson({ wallCol: 10 })), 1);
    toHover(sim);
    place(sim, 8.5, 5, 0.3, true);
    p0.buttons = BTN_FORWARD;
    let t = 0;
    for (; t < 60 && sim.avatarSnap[0] === 0; t++) step(sim, inputs);
    expect(sim.avatarSnap[0]).toBe(2);
    step(sim, inputs);
    // Half of WALL_PUSH in the hover: the velocity it is left with is under
    // the walker's push back.
    expect(sim.ent.velX[0]).toBeLessThan(0);
    expect(sim.ent.velX[0]).toBeGreaterThan(-(WALL_PUSH / 65536) * 1.171875);
  });
});

describe("the walker's head (player_walk_tick 0x004448a6)", () => {
  const apex = (x: number, deckQ: number): number => {
    reset();
    const sim = createSim(loadMapFromJson(mapJson({ deckQ })), 1);
    place(sim, x, 5, 0, false);
    for (let i = 0; i < 5; i++) step(sim, inputs);
    p0.buttons = BTN_JUMP;
    step(sim, inputs);
    p0.buttons = 0;
    let top = 0;
    for (let i = 0; i < 60; i++) {
      step(sim, inputs);
      top = Math.max(top, sim.ent.height[0]);
    }
    return top;
  };

  it("stops the rise at a deck its head meets", () => {
    // A deck at 1.59 m: the hop's 0.71 m apex would put the head at 1.86 m.
    const open = apex(20, 51);
    expect(open).toBeGreaterThan(0.6);
    const under = apex(6, 51);
    expect(under).toBeLessThan(open);
    // The head passes the deck in the tick it stops, by that tick's rise only.
    expect(under + WALKER_HEAD_HEIGHT).toBeGreaterThan(51 / 32);
    expect(under + WALKER_HEAD_HEIGHT).toBeLessThan(51 / 32 + 0.3);
  });
});

describe("the hover's slow-row ledge (0x00442cea), read along its plane", () => {
  // Flat to x = 10, then down 0.40625 m a metre: a crease at x = 10.
  const cols = Array.from({ length: SIZE }, (_, i) => (i <= 10 ? 0 : -13 * (i - 10)));
  const run = (x: number, buttons: number, ticks: number) => {
    reset();
    const sim = createSim(loadMapFromJson(mapJson({ cols })), 1);
    toHover(sim);
    place(sim, x, 5, 0, true);
    p0.buttons = buttons;
    let air = 0;
    let held = 0;
    for (let i = 0; i < ticks; i++) {
      const moving = sim.ent.velX[0] > 0.5;
      step(sim, inputs);
      if ((sim.ent.animState[0] & ANIM_AIRBORNE) !== 0) air++;
      if (moving && sim.ent.velX[0] === 0) held++;
    }
    return { x: sim.ent.posX[0], air, held };
  };

  it("rides a uniform slope on the ground, both rows", () => {
    expect(run(12, BTN_FORWARD, 25).air).toBe(0);
    expect(run(12, BTN_ACTION | BTN_FORWARD, 40).air).toBe(0);
  });

  it("holds the slow row at a small drop and lets the fast row leave", () => {
    expect(HOVER_LEDGE_DROP).toBeCloseTo(0.1, 3);
    const slow = run(5, BTN_ACTION | BTN_FORWARD, 150);
    expect(slow.air).toBe(0);
    expect(slow.held).toBeGreaterThan(0);
    expect(slow.x).toBeGreaterThan(11); // and creeps over it from rest
    const fast = run(5, BTN_FORWARD, 60);
    expect(fast.air).toBeGreaterThan(0);
    expect(fast.held).toBe(0);
  });
});
