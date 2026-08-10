// Does the collision floor agree with the floor the player can SEE?
//
// The renderer draws the terrain .glb; the sim collides against the heightfield.
// Nothing forces the two to say the same thing, and where they disagree the
// player walks onto visible art and drops through it — `sim.ts` takes the
// gravity branch on anything more than STEP_SNAP (0.35 m) below.
//
// This is the guard on a fix that was nearly applied backwards. convert.ts
// carried a 20-entry `padHeights` table, unused behind a flag, documented as
// "mesh-raycast pad tops" for pads that "are raised mesh plates above a
// channel". Measured against the committed .glb, 8 of its 80 cells landed within
// 0.3 m of the mesh, and switching it on would have raised the collision floor
// at (88,83) to +1.0 m where the art is at -2.50 — the avatar hovering 3.5 m
// over a pit. The pads had already been fixed by the #26/#30 frame correction,
// which took la-cantina's mesh/heightfield correlation from 0.939 to 0.982.
//
// So the numbers live here now, as a measurement rather than a table.
//
// Lives in tools/ because it reads BOTH packages: the sim's map JSON and the
// client's terrain .glb. packages/sim may not import the client
// (determinismGuard.test.ts pins that), and this needs both sides.

import { describe, expect, test } from "bun:test";
import { getMapById, STEP_SNAP } from "@metropolis/sim";
import { MAP_ALIGN } from "../../../packages/client/src/render/mapAlign.generated";
import { readGlbPositions } from "../genMapAlign";

/** The four arenas whose logic is imported from the original (rules.md §9). */
const ARENAS = ["la-cantina", "urban-jungle", "proving-ground", "bug-hunt"] as const;

/** Reading a 700k-vertex .glb and bucketing it beats bun's 5 s default. */
const BUDGET_MS = 30_000;

/**
 * Highest mesh vertex per grid cell, in the sim's frame. At a turret pad the
 * topmost geometry in the cell IS the pad plate — the turret itself is an
 * entity, not part of the terrain mesh — so this is the surface a player sees
 * themselves standing on.
 */
function meshTopPerCell(id: string, size: number): Float64Array {
  const align = MAP_ALIGN[id];
  if (!align) throw new Error(`${id}: no committed alignment`);
  const path = new URL(`../../../packages/client/public/models/${id}/${id}.glb`, import.meta.url)
    .pathname;
  const mesh = readGlbPositions(path);
  const top = new Float64Array(size * size).fill(Number.NaN);
  const p = mesh.pos;
  for (let i = 0; i < p.length; i += 3) {
    const ci = Math.round(p[i] + align.x);
    const cj = Math.round(p[i + 2] + align.z);
    if (ci < 0 || ci >= size || cj < 0 || cj >= size) continue;
    const k = cj * size + ci;
    // NaN-safe max: `!(v <= top)` is true when top is NaN.
    if (!(p[i + 1] <= top[k])) top[k] = p[i + 1];
  }
  return top;
}

describe("collision agrees with the terrain the player sees", () => {
  for (const id of ARENAS) {
    test(
      `${id}: every FCOP pad is standable`,
      () => {
        const map = getMapById(id);
        const top = meshTopPerCell(id, map.size);
        const spots = [
          ...map.turretSpots.map((s) => [s.x, s.y] as const),
          ...map.outpostSpots.map((s) => [s.x, s.y] as const),
          ...map.dummySpots.map((s) => [s.x, s.y] as const),
        ];
        expect(spots.length).toBeGreaterThan(20);

        const sunk: string[] = [];
        for (const [x, y] of spots) {
          const i = Math.round(x);
          const j = Math.round(y);
          const art = top[j * map.size + i];
          if (!Number.isFinite(art)) continue; // no mesh here: nothing to disagree with
          const floor = map.heights[j * map.size + i];
          // Art ABOVE collision is the fall-through case. The reverse (collision
          // above art) makes the avatar hover, which is ugly but not a trap, and
          // is what a mis-applied stamp table would have produced.
          if (art - floor > STEP_SNAP) {
            sunk.push(`(${i},${j}) art ${art.toFixed(2)} vs floor ${floor.toFixed(2)}`);
          }
        }
        expect(sunk).toEqual([]);
      },
      BUDGET_MS,
    );
  }

  test(
    "no cell traps the walker",
    () => {
      // Falling in is survivable; being unable to climb out is not. A cell is a
      // trap when every one of its four neighbours is a rise steeper than
      // AVATAR_WALKER_MAX_SLOPE and higher than the jump can clear.
      //
      // proving-ground and bug-hunt each keep exactly one, at (148,122): a 2.00 m
      // shaft one cell wide, in the original's own terrain. Pinned rather than
      // fixed — bending the arena to erase a single authored hole is the kind of
      // edit CLAUDE.md's FCOP rules exist to prevent — but pinned as a COUNT, so a
      // regression that opens a hundred of them fails here.
      const KNOWN: Record<string, number> = {
        "la-cantina": 0,
        "urban-jungle": 0,
        "proving-ground": 1,
        "bug-hunt": 1,
      };
      const MAX_SLOPE = 0.6; // AVATAR_WALKER_MAX_SLOPE
      const JUMP = 1.4; // AVATAR_JUMP_SPEED against GRAVITY, rules.md §2

      for (const id of ARENAS) {
        const map = getMapById(id);
        const at = (x: number, y: number) => map.heights[y * map.size + x];
        let traps = 0;
        for (let y = 1; y < map.size - 1; y++) {
          for (let x = 1; x < map.size - 1; x++) {
            const c = at(x, y);
            let lowestWall = Number.POSITIVE_INFINITY;
            let canWalkOut = false;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const rise = at(x + dx, y + dy) - c;
              if (rise / map.cellSize <= MAX_SLOPE) {
                canWalkOut = true;
                break;
              }
              if (rise < lowestWall) lowestWall = rise;
            }
            if (!canWalkOut && lowestWall > JUMP) traps++;
          }
        }
        expect(`${id}:${traps}`).toBe(`${id}:${KNOWN[id]}`);
      }
    },
    BUDGET_MS,
  );
});
