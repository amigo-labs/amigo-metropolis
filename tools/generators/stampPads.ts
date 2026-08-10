// STAGE 1.5 of the arena pipeline: lifts sunken FCOP pads onto the floor the
// player can see.
//
//   bun run gen:pads [all | <mapId>] [--check]
//
// THE BUG
// `walk_height` is the collision floor; the terrain .glb is what the player
// sees. Where a pad's plate is drawn above its collision height by more than
// STEP_SNAP (0.35 m), you walk onto visible art and the sim drops you through
// it — `sim.ts` takes the gravity branch. Measured across the four imported
// arenas there are six such pads: four on urban-jungle at 0.78 m and one each on
// proving-ground and bug-hunt at 1.97 m. la-cantina has none; its pads were
// already fixed by the #26/#30 frame correction.
//
// MEASURED, NOT AUTHORED
// convert.ts used to carry a hand-written `padHeights` table for exactly this,
// behind a flag nothing set. It was stale — 8 of its 80 cells landed within
// 0.3 m of the mesh, and applying it would have raised la-cantina's (88,83) to
// +1.0 m where the art sits at -2.50. So this reads the heights out of the
// committed .glb instead. A table cannot rot if there is no table.
//
// WHY ITS OWN STAGE
// Stage 1 (convert.ts) needs a private heightmap dump that is not in this repo,
// so it cannot run here. Same reason enrichArena.ts (stage 2) takes the
// COMMITTED map as its input. This is that, for terrain. Run it BEFORE
// `gen:arena`, which reads the terrain this writes.
//
// IDEMPOTENT: the stamps are absolute quanta read from a fixed mesh, so a second
// run moves nothing. `tools/generators/test/terrainCollision.test.ts` is the
// guard that says the committed maps are already stamped.
//
// Authoring-time only, like convert.ts and enrichArena.ts: any Math.* is fine,
// the committed JSON is the artifact.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMapById, STEP_SNAP } from "@metropolis/sim";
import { MAP_ALIGN } from "../../packages/client/src/render/mapAlign.generated";
import { readGlbPositions } from "./genMapAlign";

/** Keep in sync with packages/sim/src/map.ts HEIGHT_SCALE (1/32 m). */
const HEIGHT_SCALE = 0.03125;

/** The four arenas whose logic is imported from the original (rules.md §9). */
const ARENAS = ["la-cantina", "urban-jungle", "proving-ground", "bug-hunt"];

const MAPS_DIR = new URL("../../packages/sim/maps/", import.meta.url).pathname;

/** Highest mesh vertex per grid cell, in the sim's frame; NaN where none. */
function meshTopPerCell(id: string, size: number): Float64Array {
  const align = MAP_ALIGN[id];
  if (!align) throw new Error(`${id}: no committed alignment`);
  const path = new URL(`../../packages/client/public/models/${id}/${id}.glb`, import.meta.url)
    .pathname;
  const mesh = readGlbPositions(path);
  const top = new Float64Array(size * size).fill(Number.NaN);
  const p = mesh.pos;
  for (let i = 0; i < p.length; i += 3) {
    const ci = Math.round(p[i] + align.x);
    const cj = Math.round(p[i + 2] + align.z);
    if (ci < 0 || ci >= size || cj < 0 || cj >= size) continue;
    const k = cj * size + ci;
    if (!(p[i + 1] <= top[k])) top[k] = p[i + 1]; // NaN-safe max
  }
  return top;
}

interface Change {
  x: number;
  y: number;
  from: number;
  to: number;
}

function stampArena(id: string, check: boolean): boolean {
  const map = getMapById(id);
  const top = meshTopPerCell(id, map.size);
  const path = join(MAPS_DIR, `${id}.json`);
  const json = JSON.parse(readFileSync(path, "utf8")) as { heights: number[][] };

  const spots = [
    ...map.turretSpots.map((s) => [s.x, s.y] as const),
    ...map.outpostSpots.map((s) => [s.x, s.y] as const),
    ...map.dummySpots.map((s) => [s.x, s.y] as const),
  ];

  // Only pads whose OWN cell is sunk, and within such a pad only the cells of
  // the 2x2 that belong to the same plate.
  //
  // Both restrictions are load-bearing. Per-cell max-Y is the plate on a pad
  // cell, but on a cell that also contains a wall or a building edge it is the
  // top of THAT — lifting collision to it would stand the player on a parapet.
  // Requiring the neighbour's art to sit within STEP_SNAP of the pad centre's
  // art keeps the stamp on one flat surface: walls are far above it, and the
  // channel beside the plate, which is genuinely that low, is far below.
  const changed: Change[] = [];
  const seen = new Set<number>();
  for (const [sx, sy] of spots) {
    const ci = Math.round(sx);
    const cj = Math.round(sy);
    if (ci < 0 || ci >= map.size || cj < 0 || cj >= map.size) continue;
    const plate = top[cj * map.size + ci];
    if (!Number.isFinite(plate)) continue;
    if (plate - map.heights[cj * map.size + ci] <= STEP_SNAP) continue; // pad is fine

    const i0 = Math.floor(sx);
    const j0 = Math.floor(sy);
    for (let dj = 0; dj <= 1; dj++) {
      for (let di = 0; di <= 1; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || i >= map.size || j < 0 || j >= map.size) continue;
        const k = j * map.size + i;
        if (seen.has(k)) continue;
        const art = top[k];
        if (!Number.isFinite(art)) continue;
        if (Math.abs(art - plate) > STEP_SNAP) continue; // not this plate
        if (art - map.heights[k] <= STEP_SNAP) continue; // already standable
        seen.add(k);
        const q = Math.round(art / HEIGHT_SCALE);
        if (json.heights[j][i] === q) continue;
        changed.push({ x: i, y: j, from: json.heights[j][i], to: q });
        json.heights[j][i] = q;
      }
    }
  }

  console.log(`${id}: ${spots.length} pads, ${changed.length} cells sunk below the art`);
  for (const c of changed) {
    const from = (c.from * HEIGHT_SCALE).toFixed(3);
    const to = (c.to * HEIGHT_SCALE).toFixed(3);
    console.log(`  (${c.x}, ${c.y})  ${from} -> ${to} m`);
  }
  if (changed.length === 0) return true;
  if (check) {
    console.log(`  --check: ${changed.length} cells would change, writing nothing`);
    return false;
  }
  writeFileSync(path, `${JSON.stringify(json)}\n`);
  console.log("  written — SIM_VERSION and this arena's heightsPin owe a bump");
  return true;
}

function main(): void {
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const check = process.argv.includes("--check");
  const ids = which === "all" ? ARENAS : [which];
  let bad = 0;
  for (const id of ids) if (!stampArena(id, check)) bad++;
  if (bad > 0) process.exit(1);
}

if (import.meta.main) main();
