// effects/rounds.ts: which launch each new round in a snapshot came from.

import { describe, expect, test } from "bun:test";
import { ARCHETYPE, PROJ_ROUND, SNAPSHOT_STRIDE } from "@metropolis/sim";
import { ROUND_TOKEN, RoundTracker } from "../src/effects/rounds";

/** A snapshot of [id, archetype, x, y(sim), height, aux] rows. */
function snapshot(rows: [number, number, number, number, number, number][]): Float32Array {
  const s = new Float32Array(rows.length * SNAPSHOT_STRIDE);
  rows.forEach(([id, arch, x, y, h, aux], i) => {
    s.set([id, arch, 0, x, y, h, 0, 0, 1, aux], i * SNAPSHOT_STRIDE);
  });
  return s;
}

function tracker() {
  const t = new RoundTracker();
  const bound: [number, number][] = [];
  t.addListener((token, entity) => bound.push([token, entity]));
  return { t, bound };
}

describe("the round tracker", () => {
  test("a new round is the launch it spawned beside, and wears its row", () => {
    const { t, bound } = tracker();
    const turret = t.launch(10, 10, 3);
    const tank = t.launch(30, 10, 1);
    expect(turret).toBe(ROUND_TOKEN);
    expect(tank).toBe(ROUND_TOKEN - 1);
    const s = snapshot([
      [40, ARCHETYPE.PROJECTILE, 30.2, 10, 0.6, PROJ_ROUND],
      [41, ARCHETYPE.PROJECTILE, 10.3, 10.1, 0.6, PROJ_ROUND],
    ]);
    t.bind(s, 2, SNAPSHOT_STRIDE);
    expect(t.row[40]).toBe(1);
    expect(t.row[41]).toBe(3);
    expect(bound).toContainEqual([tank, 40]);
    expect(bound).toContainEqual([turret, 41]);
  });

  test("a round carries its block's impact and its owner's bank to its death (0x0042b910)", () => {
    const { t } = tracker();
    // The powered Plasma Flare's round: 158 in the partner's bank; the bomb's 43 in 0.
    t.launch(10, 10, 0, 1, 158);
    t.launch(30, 10, 9, 0, 43);
    const s = snapshot([
      [40, ARCHETYPE.PROJECTILE, 10.2, 10, 0.6, 18],
      [41, ARCHETYPE.PROJECTILE, 30.1, 10, 9, 3],
    ]);
    t.bind(s, 2, SNAPSHOT_STRIDE);
    t.impact(10.2, 10, s, 2, SNAPSHOT_STRIDE);
    expect([t.lastImpactBank, t.lastImpactId]).toEqual([1, 158]);
    t.impact(30.1, 10, s, 2, SNAPSHOT_STRIDE);
    expect([t.lastImpactBank, t.lastImpactId]).toEqual([0, 43]);
    // A round no launch named (a burst's fragment) carries none.
    const f = snapshot([[42, ARCHETYPE.PROJECTILE, 50, 50, 1, 6]]);
    t.bind(f, 1, SNAPSHOT_STRIDE);
    t.impact(50, 50, f, 1, SNAPSHOT_STRIDE);
    expect(t.lastImpactId).toBe(0);
  });

  test("a round knows whether its launch fired block B, so it wears B's model", () => {
    const { t } = tracker();
    t.launch(10, 10, 0, 1, 158, true);
    t.launch(30, 10, 0, 1, 153);
    t.bind(
      snapshot([
        [40, ARCHETYPE.PROJECTILE, 10.2, 10, 0.6, 18],
        [41, ARCHETYPE.PROJECTILE, 30.1, 10, 0.6, 18],
        [42, ARCHETYPE.PROJECTILE, 50, 50, 1, 18],
      ]),
      3,
      SNAPSHOT_STRIDE,
    );
    expect([t.powered[40], t.powered[41], t.powered[42]]).toEqual([1, 0, 0]);
  });

  test("a launch whose round never shows is answered with -1", () => {
    const { t, bound } = tracker();
    const token = t.launch(10, 10, 3);
    t.bind(snapshot([]), 0, SNAPSHOT_STRIDE);
    expect(bound).toEqual([[token, -1]]);
    // The next tick's tokens start over.
    expect(t.launch(0, 0, 1)).toBe(ROUND_TOKEN);
  });

  test("a round seen before is not new, and keeps its row", () => {
    const { t } = tracker();
    t.launch(10, 10, 6);
    const s = snapshot([[40, ARCHETYPE.PROJECTILE, 10, 10, 0.6, PROJ_ROUND]]);
    t.bind(s, 1, SNAPSHOT_STRIDE);
    t.launch(10, 10, 3); // another shooter fires from the same spot
    t.bind(s, 1, SNAPSHOT_STRIDE);
    expect(t.row[40]).toBe(6);
  });

  test("an impact forgets the round, so an id taken again in the tick is new", () => {
    const { t } = tracker();
    t.launch(10, 10, 6);
    const before = snapshot([[40, ARCHETYPE.PROJECTILE, 10, 10, 0.6, PROJ_ROUND]]);
    t.bind(before, 1, SNAPSHOT_STRIDE);
    // The round strikes at (20, 10) and its id goes to a new round that tick.
    const flying = snapshot([[40, ARCHETYPE.PROJECTILE, 20, 10, 1.2, PROJ_ROUND]]);
    expect(t.impact(20.1, 10, flying, 1, SNAPSHOT_STRIDE)).toBeCloseTo(1.2, 5);
    t.launch(50, 50, 4);
    t.bind(snapshot([[40, ARCHETYPE.PROJECTILE, 50, 50, 0.6, PROJ_ROUND]]), 1, SNAPSHOT_STRIDE);
    expect(t.row[40]).toBe(4);
  });

  test("an impact with no round near it has no height", () => {
    const { t } = tracker();
    expect(t.impact(0, 0, snapshot([]), 0, SNAPSHOT_STRIDE)).toBeNaN();
  });
});
