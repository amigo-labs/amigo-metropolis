// What the client's view needs of the original's terrain beyond the sim's map:
//
//   <RE>/fixtures/missions/<Mission>   its Cptc (GRDB) and Ctil sections
//   packages/sim/maps/<mapId>.json     the sim's ground and decks
//     -> packages/client/src/render/viewTerrain.generated.ts
//
// 1. **The world** the map screen's window stays inside
//    (`world_clamp_map_centre` 0x00452710 over the bounds `cptc_load` 0x00451510
//    sets): grid cells `margin` .. `width - margin - 1` on the original's z (the
//    sim's x), `margin` .. `height - margin - 1` on its x (the sim's y), 0x20000
//    world units (16 m) a cell, the origins 0 in all six (GRDB words 3-5). In
//    the sim's frame, as every actor moves (enrichArena.ts LOGIC_OFFSET_X): 16 m
//    more on x.
// 2. **The see-through surfaces** of the chase camera's line of sight
//    (`view_trace` 0x00445df0): a hit on a plate whose material byte carries bit
//    7 is retraced from the anchor, and a second such hit is clear (RE M3-GD).
//    Per sim cell and surface -- the ground, then each deck -- whether the plate
//    the surface stands for is see-through: the plate under the cell's centre
//    (`platesOf`, the original's height query with each plate's material) whose
//    height is nearest the surface's there, within MATCH_M.
// 3. **The load order** of the placed type-11 records the radar registers
//    (render/hud/radar.ts): `res_dispatch_chunks` (0x004063c0) hands the
//    container's resources to their loaders in the order they arrive, and
//    `cact_load` (0x0043af20) builds a `Cact`'s actor there and then, so the
//    live list starts with the Cact actors in file order -- not by id, which
//    differs on all six arenas. A `Csac` only registers a spawner
//    (`csac_load` 0x0044eff0); its actor comes later.
//
//   bun run gen:viewterrain [--check] [--re-repo <path>]
//
// `--check` rebuilds from the RE's containers and the committed maps and exits 1
// if the committed output differs. Authoring-time only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIC_OFFSET_X, LOGIC_OFFSET_Z } from "./enrichArena";
import { FCOP_ARENAS } from "./fcopArenas";
import { containerIndex, containerResource } from "./fcopCoarse";
import { argOf } from "./fcopLogic";
import { platesOf } from "./fcopTerrain";

const REPO_ROOT = join(import.meta.dir, "..", "..");
export const VIEW_TERRAIN_OUT = join(
  REPO_ROOT,
  "packages",
  "client",
  "src",
  "render",
  "viewTerrain.generated.ts",
);

/** GRDB payload words (RE fcop/grid.h), after its 8-byte chunk header and one word. */
const GRID_BASE = 12;
const GRID_WORD_WIDTH = 1;
const GRID_WORD_HEIGHT = 2;
const GRID_WORD_ORIGIN_X = 3;
const GRID_WORD_ORIGIN_Y = 4;
const GRID_WORD_ORIGIN_Z = 5;
const GRID_WORD_MARGIN = 6;
/** One grid cell, metres (0x20000 world units, `cptc_load`). */
const GRID_CELL_M = 16;
/** World units a metre. */
const WU = 8192;
/** The sim's height step, metres (map.ts HEIGHT_SCALE). */
const HEIGHT_SCALE = 0.03125;
/** A plate stands for a surface within this of the surface's height at the cell's centre, m. */
const MATCH_M = 0.25;
/** `view_trace`'s see-through bit: bit 15 of the packed trace result, bit 7 of the material. */
const SEE_THROUGH = 0x80;

interface SimLayer {
  heights: number[][];
  mask: (string | number[])[];
}
interface SimMap {
  size: number;
  heights: number[][];
  layers?: SimLayer[];
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export interface ViewTerrain {
  /** [minX, maxX, minY, maxY], sim metres: the map window's world. */
  world: [number, number, number, number];
  /** Per surface (0 the ground, k the k-th deck): the see-through cells, `row * cells + col`. */
  seeThrough: number[][];
  /** The type-11 `Cact` records' ids in the container's file order: their load order. */
  cactLoad: number[];
}

/** The tACT payload in a resource's bytes (fcopLogic.ts TACT_PAYLOAD): its type byte. */
const TACT_PAYLOAD = 12;
/** DynamicProp, the placed scenery the radar registers. */
const TYPE_DYNAMIC_PROP = 11;

function maskAt(layer: SimLayer, r: number, c: number): boolean {
  const row = layer.mask[r];
  return typeof row === "string" ? row[c] === "1" : row[c] === 1;
}

export function buildViewTerrain(container: Uint8Array, map: SimMap): ViewTerrain {
  const res = containerIndex(container);
  const gridAt = res.get("ctpC:1") ?? [...res.entries()].find(([k]) => k.startsWith("ctpC:"))?.[1];
  if (!gridAt) throw new Error("no Cptc in the container");
  const grid = containerResource(container, gridAt);
  const word = (w: number): number => u32(grid, GRID_BASE + 4 * w);
  for (const w of [GRID_WORD_ORIGIN_X, GRID_WORD_ORIGIN_Y, GRID_WORD_ORIGIN_Z]) {
    if (word(w) !== 0) throw new Error(`GRDB word ${w} is ${word(w)}, not 0`);
  }
  const width = word(GRID_WORD_WIDTH);
  const height = word(GRID_WORD_HEIGHT);
  const margin = word(GRID_WORD_MARGIN);
  const world: [number, number, number, number] = [
    margin * GRID_CELL_M + LOGIC_OFFSET_X,
    (width - margin - 1) * GRID_CELL_M + LOGIC_OFFSET_X,
    margin * GRID_CELL_M + LOGIC_OFFSET_Z,
    (height - margin - 1) * GRID_CELL_M + LOGIC_OFFSET_Z,
  ];

  const plates = platesOf(container);
  const layers = map.layers ?? [];
  const cells = map.size - 1;
  const seeThrough: number[][] = Array.from({ length: layers.length + 1 }, () => []);
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      // The cell's centre in the original's frame: its x is the sim's y, its z
      // the sim's x less the logic offset.
      const ox = r - LOGIC_OFFSET_Z + 0.5;
      const oz = c - LOGIC_OFFSET_X + 0.5;
      if (ox < 0 || oz < 0) continue;
      const stack = plates(Math.round(ox * WU), Math.round(oz * WU));
      if (!stack.some((p) => (p.material & SEE_THROUGH) !== 0)) continue;
      const surfaces: (number | null)[] = [
        (map.heights[r][c] +
          map.heights[r][c + 1] +
          map.heights[r + 1][c] +
          map.heights[r + 1][c + 1]) /
          4,
      ];
      for (const layer of layers) {
        let sum = 0;
        let n = 0;
        for (const [dr, dc] of [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
        ]) {
          if (!maskAt(layer, r + dr, c + dc)) continue;
          sum += layer.heights[r + dr][c + dc];
          n++;
        }
        surfaces.push(n > 0 ? sum / n : null);
      }
      surfaces.forEach((q, k) => {
        if (q === null) return;
        const at = q * HEIGHT_SCALE;
        let best: { h: number; material: number } | null = null;
        for (const p of stack) {
          const d = Math.abs(p.h / WU - at);
          if (d <= MATCH_M && (best === null || d < Math.abs(best.h / WU - at))) best = p;
        }
        if (best && (best.material & SEE_THROUGH) !== 0) seeThrough[k].push(r * cells + c);
      });
    }
  }
  const cactLoad: number[] = [];
  for (const [key, at] of res) {
    if (!key.startsWith("tcaC:")) continue;
    const blob = containerResource(container, at);
    if (blob[TACT_PAYLOAD] === TYPE_DYNAMIC_PROP) cactLoad.push(Number(key.slice(5)));
  }
  return { world, seeThrough, cactLoad };
}

function render(entries: readonly [string, ViewTerrain][]): string {
  const lines = [
    "// Generated by `bun run gen:viewterrain` (tools/generators/fcopViewTerrain.ts). Do not edit.",
    "//",
    "// Per arena, from the original's containers and the sim's maps: the world the",
    "// map screen's window stays inside (`world_clamp_map_centre` 0x00452710 over",
    "// `cptc_load`'s bounds), and the see-through surfaces of the chase camera's",
    "// line of sight (`view_trace` 0x00445df0, a plate material's bit 7), and the",
    "// load order of the placed type-11 records.",
    "",
    "export interface ViewTerrain {",
    "  /** [minX, maxX, minY, maxY], metres: the terrain grid less its margin. */",
    "  readonly world: readonly [number, number, number, number];",
    "  /**",
    "   * Per surface (0 the ground, k the k-th deck): the cells whose surface is a",
    "   * see-through plate, `row * (size - 1) + col`, ascending.",
    "   */",
    "  readonly seeThrough: readonly (readonly number[])[];",
    "  /**",
    "   * The type-11 `Cact` records' ids in the container's file order, which is",
    "   * the order the load makes their actors (`res_dispatch_chunks` 0x004063c0,",
    "   * `cact_load` 0x0043af20).",
    "   */",
    "  readonly cactLoad: readonly number[];",
    "}",
    "",
    "export const VIEW_TERRAIN: Readonly<Record<string, ViewTerrain>> = {",
  ];
  for (const [id, t] of entries) {
    lines.push(`  "${id}": {`);
    lines.push(`    world: [${t.world.join(", ")}],`);
    lines.push(`    seeThrough: [${t.seeThrough.map((s) => `[${s.join(", ")}]`).join(", ")}],`);
    lines.push(`    cactLoad: [${t.cactLoad.join(", ")}],`);
    lines.push("  },");
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** The output as the formatter writes it, so a re-run and `--check` agree with lint. */
function biomeFormat(text: string, path: string): string {
  const fmt = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${path}`], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(text),
  });
  if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
  return fmt.stdout.toString();
}

function main(): void {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  const check = process.argv.includes("--check");
  const entries: [string, ViewTerrain][] = [];
  for (const a of FCOP_ARENAS) {
    const container = new Uint8Array(readFileSync(join(reRepo, "fixtures", "missions", a.mission)));
    const map = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "sim", "maps", `${a.mapId}.json`), "utf8"),
    ) as SimMap;
    const t = buildViewTerrain(container, map);
    entries.push([a.mapId, t]);
    console.log(
      `${a.mapId}: world [${t.world.join(", ")}], see-through cells ${t.seeThrough.map((s) => s.length).join(" / ")}`,
    );
  }
  const text = biomeFormat(render(entries), VIEW_TERRAIN_OUT);
  if (check) {
    const same = existsSync(VIEW_TERRAIN_OUT) && readFileSync(VIEW_TERRAIN_OUT, "utf8") === text;
    console.log(
      same ? "viewTerrain.generated.ts reproduces" : "PROBLEM viewTerrain.generated.ts differs",
    );
    if (!same) process.exit(1);
    return;
  }
  writeFileSync(VIEW_TERRAIN_OUT, text);
}

if (import.meta.main) main();
