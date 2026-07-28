// Answers docs/specs/fcop-logic.md §3.1: what is a Cnet node's `ground_cast`, and
// where does a node's elevation actually come from?
//
// WHY THIS EXISTS
// The multi-deck arena work (issues #29, #33) stalled on one question: the decks
// in the FCOP arenas have no steppable route on — 0 of 101334 deck cells across
// all six arenas are within STEP_SNAP of an adjacent walk floor, with a floor of
// +0.594 m (19/32 m) that is identical on every arena. So either the originals
// have ramps the extractor drops, or the X1Alpha simply hovers onto them.
//
// Both readings were wrong. The road network is AUTHORED on the decks: each Cnet
// node carries a 2-bit `ground_cast` that selects which of the stacked surfaces at
// its cell the node's Y resolves to. Nothing climbs, because nothing needs to.
//
// That also explains why every elevation field in the extract reads zero — actor
// `height` on all 7506 actors, Cnet `height_offset` on all 174 graphs. §3 has
// always said node Y is not stored but raycast against terrain; `ground_cast` is
// that raycast's mode, and the numbers below are the evidence.
//
// This is a REPORT, not a generator — it writes nothing. It reads the private RE
// dumps, which is why the conclusion is committed as prose in fcop-logic.md and as
// a pin on the carried field in test/groundCast.test.ts rather than as CI. Run it
// when you doubt either.
//
// Usage: bun run tools/generators/analyzeGroundCast.ts [all | <mapId> | <Mission>]
//                                                      [--re-repo <path>]
// Default RE repo path: $FCOP_RE_REPO, else ../fcop-reverse-engineering.
//
// Authoring-time only, like convert.ts and enrichArena.ts: any Math.* is fine.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crossesWallX, crossesWallY, loadMapFromJson, type MapJson } from "@metropolis/sim";
import { LOGIC_OFFSET_X, LOGIC_OFFSET_Z } from "./enrichArena";
import { type FcopArena, selectArenas, wallsFile } from "./fcopArenas";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HEIGHT_SCALE = 0.03125; // 1/32 m — mirrors convert.ts and packages/sim/src/map.ts

/** `ground_cast` values, as decoded by the RE extractor. */
const CAST = ["HIGH", "LOW", "NONE", "MIDDLE"] as const;
const HIGH = 0;

/**
 * Nets a base actually produces onto, per arena.
 *
 * Mirrors enrichArena.ts's `ownedNets`: Hk carries a third net of 41 nodes no base
 * drives, a campaign leftover. It matters here beyond bookkeeping — those 41 nodes
 * are the ONLY LOW nodes on Hk, and reading them as part of the arena is what made
 * `ground_cast` look like noise (#33's "41 LOW is an outlier, so it may well be a
 * casting mode"). They are not an outlier; they are a different net.
 */
const OWNED_NETS: Record<string, readonly number[]> = { Hk: [1, 2] };

interface RawNode {
  i: number;
  x: number;
  z: number;
  ground_cast: number;
  neighbours: number[];
}
interface RawNet {
  res_id: number;
  nodes: RawNode[];
}
interface Terrain {
  size: [number, number];
  walk_height: number[][];
  uses_bridges: boolean;
  layers: { heights: number[][]; mask: string[] }[];
}

function reRepo(): string {
  const at = process.argv.indexOf("--re-repo");
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return process.env.FCOP_RE_REPO ?? join(REPO_ROOT, "..", "fcop-reverse-engineering");
}

function nets(root: string, arena: FcopArena): RawNet[] {
  const p = join(root, "extracted", "logic", arena.mission, "nets.json");
  const all = JSON.parse(readFileSync(p, "utf8")) as RawNet[];
  const owned = OWNED_NETS[arena.mission];
  return owned ? all.filter((n) => owned.includes(n.res_id)) : all;
}

function terrain(root: string, arena: FcopArena): Terrain {
  const p = join(root, "extracted", "heightmaps", `${arena.mission}_terrain.json`);
  return JSON.parse(readFileSync(p, "utf8")) as Terrain;
}

/**
 * Every surface at one cell, in metres, ascending.
 *
 * `walk_height` first because it IS the bottom — measured, not assumed: section 1
 * of the report re-checks that on every deck cell of every arena. The sim frame
 * flattens an arena to exactly this entry, which is the whole problem.
 */
function stack(t: Terrain, col: number, row: number): number[] {
  const out = [t.walk_height[row][col] * HEIGHT_SCALE];
  for (const L of t.layers) {
    if (L.mask[row][col] === "1") out.push(L.heights[row][col] * HEIGHT_SCALE);
  }
  return out.sort((a, b) => a - b);
}

/** The surface `cast` selects out of a stack. */
function resolve(cast: number, surfaces: number[]): number {
  if (surfaces.length === 1) return surfaces[0];
  if (cast === HIGH) return surfaces[surfaces.length - 1];
  if (cast === 1) return surfaces[0]; // LOW
  if (cast === 3) return surfaces[Math.floor((surfaces.length - 1) / 2)]; // MIDDLE
  return surfaces[surfaces.length - 1]; // NONE — no cast; topmost is the engine default
}

/** Node cell in the sim heightfield frame. */
const cellOf = (n: RawNode): [number, number] => [
  Math.floor(n.x) + LOGIC_OFFSET_X,
  Math.floor(n.z) + LOGIC_OFFSET_Z,
];

// ---------------------------------------------------------------------------
// 1. Is `walk_height` the bottom of the stack?
// ---------------------------------------------------------------------------

/**
 * The claim the rest of the report rests on: on a cell carrying decks, the base
 * heightfield holds the LOWEST surface. If that ever fails, "LOW" and "the sim's
 * heightfield" stop being the same thing and every conclusion below needs redoing.
 */
function surfaceModel(root: string, arenas: readonly FcopArena[]): void {
  console.log("\n1. walk_height vs the deck surfaces above it");
  console.log("   (a deck cell is one where some layer's presence mask is set)\n");
  for (const arena of arenas) {
    const t = terrain(root, arena);
    const [W, H] = t.size;
    let cells = 0;
    let below = 0;
    let ties = 0;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const s = stack(t, c, r);
        if (s.length === 1) continue;
        cells++;
        const walk = t.walk_height[r][c] * HEIGHT_SCALE;
        if (walk < s[1]) below++;
        else if (walk === s[1]) ties++;
      }
    }
    const verdict = below === cells ? "walk is the bottom on ALL" : `NOT always the bottom`;
    console.log(
      `   ${arena.mapId.padEnd(16)} ${String(cells).padStart(6)} deck cells — ` +
        `${verdict}${ties ? ` (${ties} tie)` : ""}   bridges=${t.uses_bridges}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Does `ground_cast` track the decks, and only at the right frame?
// ---------------------------------------------------------------------------

/**
 * The discriminating test, and the frame control that makes it one.
 *
 * The marginal distribution says nothing: ~10-13 LOW per arena on single-storey
 * arenas too, which is what made this look like a casting mode. The conditional
 * distribution is decisive — on a single-storey cell LOW and HIGH select the same
 * surface, so LOW there is free noise, and the question is whether LOW lands on
 * cells that actually carry a deck.
 *
 * The control: correlation this strong at +16 and nowhere else is independent
 * confirmation of the frame offset issue #30 established, from a different channel
 * than the wall-blocking measurement that established it. A shift that scrambles
 * the mapping cannot preserve it, so a high score at some other offset would mean
 * the offset — not the reading — is what is wrong.
 */
function castByDeck(root: string, arenas: readonly FcopArena[]): void {
  console.log("\n2. ground_cast conditioned on whether the node's cell carries a deck");
  console.log("   owned nets only. deck% = share of that cast's nodes on a deck cell.\n");
  for (const arena of arenas) {
    const t = terrain(root, arena);
    const [W, H] = t.size;
    const ns = nets(root, arena);
    const decked = (c: number, r: number): boolean =>
      c >= 0 && c < W && r >= 0 && r < H && stack(t, c, r).length > 1;

    let gridDeck = 0;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (decked(c, r)) gridDeck++;

    const at = (dx: number): Map<number, [number, number]> => {
      const tally = new Map<number, [number, number]>();
      for (const net of ns) {
        for (const n of net.nodes) {
          const [c, r] = cellOf(n);
          const slot = tally.get(n.ground_cast) ?? [0, 0];
          slot[decked(c + dx - LOGIC_OFFSET_X, r) ? 0 : 1]++;
          tally.set(n.ground_cast, slot);
        }
      }
      return tally;
    };

    const pct = (t2: Map<number, [number, number]>, cast: number): string => {
      const s = t2.get(cast);
      if (!s) return "   -  ";
      const n = s[0] + s[1];
      return `${((100 * s[0]) / n).toFixed(1).padStart(5)}%`;
    };

    const here = at(LOGIC_OFFSET_X);
    const casts = [...here.keys()].sort((a, b) => a - b);
    console.log(
      `   ${arena.mapId} — grid is ${((100 * gridDeck) / (W * H)).toFixed(1)}% decked, ` +
        `layered=${arena.layered}`,
    );
    for (const cast of casts) {
      const s = here.get(cast) as [number, number];
      console.log(
        `     ${CAST[cast].padEnd(6)} ${String(s[0] + s[1]).padStart(4)} nodes  ` +
          `${pct(here, cast)} on a deck cell`,
      );
    }
    const shifts = [-16, -8, 0, 8, 16, 24, 32];
    const nonHigh = casts.filter((c) => c !== HIGH);
    if (nonHigh.length > 0) {
      const line = shifts
        .map((dx) => {
          const t2 = at(dx);
          const mark = dx === LOGIC_OFFSET_X ? "*" : " ";
          return `+${String(dx).padStart(3)}${mark}${nonHigh.map((c) => pct(t2, c)).join("")}`;
        })
        .join("  ");
      const which = nonHigh.map((c) => CAST[c]).join("/");
      console.log(`     frame control (${which} deck%, * = in use):`);
      console.log(`       ${line}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. What the flattening costs the road network
// ---------------------------------------------------------------------------

/**
 * Ties the reading back to the symptom issue #29 opened on: original lane edges
 * that the pristine wall lattice blocks.
 *
 * If `ground_cast` is a surface selector, a HIGH node on a deck cell belongs on
 * TOP of that deck — and the sim, having flattened the arena to `walk_height`,
 * put it underneath, where the deck's own footprint walls it in. So the blocked
 * edges should be concentrated on nodes whose cast disagrees with the surface the
 * sim gave them. That is a different fix from "carve the walls": the walls are
 * right, the elevation is wrong.
 *
 * Edge walking is copied from enrichArena.ts's `--probe` so both report the same
 * number for the same lattice.
 */
function laneEdges(root: string, arenas: readonly FcopArena[]): void {
  console.log("\n3. Original lane edges the pristine lattice blocks, by node cast\n");
  for (const arena of arenas) {
    const mapPath = join(REPO_ROOT, "packages", "sim", "maps", `${arena.mapId}.json`);
    const raw = JSON.parse(readFileSync(mapPath, "utf8")) as MapJson;
    const pristine = JSON.parse(
      readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", wallsFile(arena)), "utf8"),
    ) as { wallsV: string[]; wallsH: string[] };
    const map = loadMapFromJson({ ...raw, wallsV: pristine.wallsV, wallsH: pristine.wallsH });
    const t = terrain(root, arena);
    const [W, H] = t.size;
    const ns = nets(root, arena);

    // A node the flattening misplaces: its cast selects a surface above the
    // heightfield the sim actually gave it.
    const misplaced = (n: RawNode): boolean => {
      const [c, r] = cellOf(n);
      if (c < 0 || c >= W || r < 0 || r >= H) return false;
      const s = stack(t, c, r);
      return s.length > 1 && resolve(n.ground_cast, s) !== s[0];
    };

    let blocked = 0;
    let blockedMisplaced = 0;
    let edges = 0;
    for (const net of ns) {
      for (const n of net.nodes) {
        for (const nb of n.neighbours) {
          const other = net.nodes[nb];
          if (nb < 0 || !other) continue;
          edges++;
          const x0 = n.x + LOGIC_OFFSET_X;
          const x1 = other.x + LOGIC_OFFSET_X;
          const z0 = n.z + LOGIC_OFFSET_Z;
          const z1 = other.z + LOGIC_OFFSET_Z;
          const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 4);
          let px = x0;
          let py = z0;
          for (let s = 1; s <= steps; s++) {
            const tt = s / steps;
            const cx = x0 + (x1 - x0) * tt;
            const cy = z0 + (z1 - z0) * tt;
            if (crossesWallX(map, px, cx, py) || crossesWallY(map, cx, py, cy)) {
              blocked++;
              if (misplaced(n) || misplaced(other)) blockedMisplaced++;
              break;
            }
            px = cx;
            py = cy;
          }
        }
      }
    }
    const share = blocked > 0 ? `${((100 * blockedMisplaced) / blocked).toFixed(0)}%` : "n/a";
    console.log(
      `   ${arena.mapId.padEnd(16)} ${String(blocked).padStart(4)}/${String(edges).padEnd(5)} ` +
        `blocked — ${String(blockedMisplaced).padStart(4)} (${share.padStart(4)}) touch a node ` +
        `the flattening drops off its deck`,
    );
  }
}

const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
const arenas = selectArenas(positional);
const root = reRepo();
console.log(`ground_cast report — RE dumps at ${root}`);
surfaceModel(root, arenas);
castByDeck(root, arenas);
laneEdges(root, arenas);
console.log(
  "\nReading: HIGH takes the topmost surface at the node's cell, LOW the bottommost\n" +
    "(== walk_height == the sim's heightfield), MIDDLE the one between. See\n" +
    "docs/specs/fcop-logic.md §3.1.",
);
