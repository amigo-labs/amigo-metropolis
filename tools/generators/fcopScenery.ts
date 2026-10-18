// Each arena's scenery as the original places it, out of the private RE repo.
//
// 1. The models, copied unchanged:
//
//      <RE>/extracted/objects/<Mission>/obj_NNN.glb
//        -> tools/generators/units/raw/fcop-props/<Mission>/obj_NNN.glb
//
//    for every Cobj that units/manifest.ts ARENA_SCENERY lists for the arena,
//    in its own mission's numbering. The RE exports them as
//    tools/gfx/extract_objects.py does every Cobj (all frames, the mission's own
//    texture pages embedded); `bun run gen:units` then builds
//    packages/client/public/models/props/<mapId>/prop-NNN.glb from these raws.
//    The same Cobj id is a different model on another arena, and an identical
//    payload still samples each mission's own pages, so nothing here is shared
//    across missions (manifest.ts says how the twins were matched).
//
// 2. Where and when each one stands, written to
//    packages/client/src/render/arenaScenery.generated.ts:
//
//    - every type-11 record (DynamicProp) of the mission, placed (Cact) or
//      spawned by a script (Csac), read out of fixtures/missions/<Mission>
//      through the RE's own container walker (tools/gfx/fcop.py);
//    - its height, as its construct takes it (RE turret_part.c 0x0041cf70,
//      `turret_part_construct`): the layer byte at payload +0x20 remapped
//      0 -> topmost, 1 -> lowest, n -> layer n - 2, `terrain_height_at`
//      (RE world/height.c 0x004545d0) at the record's position on that layer,
//      plus the whole word at +0x24. The terrain query is the RE's independent
//      model of the plates (tests/surface_model.py `World`, `plate_height`),
//      over the mission's own bytes — so a flag on a deck stands on the deck;
//    - its yaw, the halfword at +0x22 (`My(yaw)`, 4096 a turn);
//    - when it stands, from the outposts' scripts
//      (extracted/data/<Mission>/actor_scripts.json, RE
//      docs/behavior/precinct-assault.md "Outposts"): an activation spot's
//      enable script spawns the outpost's two terminals (op 0x3c) and destroys
//      its console (order 0x3c, `CACT_ORDER_OP14`: damage of the record's
//      health + 1, RE mission_frame.c 975-1056), and the claim spot's posts
//      order 0x44 to its four flags' group (op 0x39). Anything else a tFUN
//      function spawns stands from the start (the base terminals of fn 30/31);
//    - the morph each model plays: a type-11 actor steps its AnmD track with
//      the frame delta it is handed at operation 6 (RE turret_part.c
//      0x0041cee2, mission_frame.c 1326), so mode 1 and mode 2 alike run on the
//      300 Hz clock, track 0 from frame 0 at load.
//
//   bun run gen:scenery [all | <mapId> | <Mission>] [--check] [--re-repo <path>]
//
// The positional picks whose raws are copied; the table is always written for
// all six arenas. `--check` compares the committed raws and the table with what
// the RE gives and exits 1 on any difference. Authoring-time only.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FCOP_ARENAS, type FcopArena, selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";
import { ARENA_SCENERY, sceneryRaw } from "./units/manifest";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RAW_DIR = join(import.meta.dir, "units", "raw");
const OUT_TS = join(REPO_ROOT, "packages", "client", "src", "render", "arenaScenery.generated.ts");
/** enrichArena.ts LOGIC_OFFSET_X / _Z: the actor frame's shift onto the sim grid. */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;
/** World units a metre (and a grid cell): `>> 13` is the terrain sample. */
const WU_PER_M = 8192;
/** The DynamicProp. */
const TYPE_DYNAMIC_PROP = 11;
/** Order 0x3c: damage of max(health + 1, 0) when the parameter is 0 or 1 (a kill). */
const ORDER_OP14 = 0x3c;
/** Order 0x44: set the texture offset bytes, the flags' recolouring. */
const ORDER_SET_UV = 0x44;

// --- the records, read by the RE's own tools -------------------------------

interface PropRecord {
  readonly res: "Cact" | "Csac";
  readonly id: number;
  readonly cobj: number;
  /** position[0..2], world units: [0] is the game's x (the sim's y), [2] its z. */
  readonly pos: readonly [number, number, number];
  readonly layer: number;
  readonly flags: number;
  readonly yaw: number;
  readonly heightOffset: number;
  readonly group: number;
  /** terrain_height_at(pos, remapped layer), world units. */
  readonly terrain: number;
}

/**
 * The python half: the container walker and the plate model are the RE's, and
 * the query is `terrain_height_at` transcribed over them line for line. `-B`
 * so nothing is written into the RE checkout.
 */
const READER = String.raw`
import json, pathlib, struct, sys
RE = sys.argv[1]
sys.path.insert(0, RE + "/tools/gfx")
sys.path.insert(0, RE + "/tests")
from fcop import extract, parse
import surface_model as sm

LAYER_LOWEST, LAYER_HIGHEST = -2, -1

def terrain_height_at(world, point, layer):
    # RE src/game/world/height.c 0x004545d0.
    x, z = point[0], point[2]
    if z < 0 or x < 0:
        return 0
    gx, gz = x >> 17, z >> 17
    if gz >= world.width - 1 or gx >= world.height - 1:
        return 0
    sect = world.section_for(gx, gz)
    if sect is None:
        return 0
    u, v = (x >> 13) & 0xF, (z >> 13) & 0xF
    cell = u * 16 + v
    index = struct.unpack_from("<H", sect, sm.SECT_CELL_INDEX + cell * 2)[0]
    remaining = index & 0xF
    if remaining == 0:
        return 0
    plate = sm.SECT_PLATES + (index >> 4)
    base = sm.SECT_HEIGHTMAP + 3 * (sm.SAMPLES * u + v)
    heights = []
    while remaining > 0 and len(heights) < 16:
        word = struct.unpack_from("<I", sect, plate)[0]
        plate += 4
        kind = (word >> 15) & 0x7F
        if kind > sm.LAST_FLOOR_TYPE:
            break
        h = sm.plate_height(sect, base, kind, (z & 0x1FFF) << 3, (x & 0x1FFF) << 3)
        if h is not None:
            heights.append(h)
        remaining -= 1
    if not heights:
        return 0
    heights.sort()
    if layer in (0, 1, 2):
        return heights[layer] if layer < len(heights) else 0
    if layer == LAYER_LOWEST:
        return heights[0]
    if layer == LAYER_HIGHEST:
        return heights[-1]
    return 0

out = {}
for mission in sys.argv[2:]:
    path = RE + "/fixtures/missions/" + mission
    world = sm.World(pathlib.Path(path))
    blob, resources = parse(path)
    recs = []
    for r in resources:
        if r["type"] not in ("Cact", "Csac"):
            continue
        p = extract(blob, r)
        if p[0:4] != b"TCAt" or p[12] != ${TYPE_DYNAMIC_PROP}:
            continue
        pay = p[12:]
        pos = list(struct.unpack_from("<3i", pay, 4))
        sel = struct.unpack_from("<b", pay, 0x20)[0]
        # turret_part_construct's remap: 0 -> -1, 1 -> -2, n -> n - 2.
        layer = LAYER_HIGHEST if sel == 0 else (LAYER_LOWEST if sel == 1 else sel - 2)
        cobjs = []
        at = p.find(b"LSRa")
        if at >= 0:
            n = (struct.unpack_from("<I", p, at + 4)[0] - 12) // 8
            for i in range(n):
                tag, rid = struct.unpack_from("<II", p, at + 12 + 8 * i)
                if tag == 0x436F626A:
                    cobjs.append(rid)
        recs.append({
            "res": r["type"], "id": r["id"], "cobj": cobjs[0] if cobjs else -1, "pos": pos,
            "layer": sel, "flags": pay[0x21], "yaw": struct.unpack_from("<h", pay, 0x22)[0],
            "heightOffset": struct.unpack_from("<i", pay, 0x24)[0], "group": pay[25],
            "terrain": terrain_height_at(world, pos, layer),
        })
    out[mission] = recs
print(json.dumps(out))
`;

function readRecords(reRepo: string, missions: readonly string[]): Record<string, PropRecord[]> {
  const r = Bun.spawnSync(["python3", "-I", "-B", "-c", READER, reRepo, ...missions]);
  if (r.exitCode !== 0) throw new Error(`reading the type-11 records failed: ${r.stderr}`);
  return JSON.parse(r.stdout.toString()) as Record<string, PropRecord[]>;
}

// --- the scripts ------------------------------------------------------------

interface ScriptOp {
  readonly kind: string;
  readonly name?: string;
  readonly args?: readonly (number | null)[];
}
interface ActorScripts {
  readonly refs: readonly {
    readonly res_type: string;
    readonly actor_id: number;
    readonly act_type: number;
    readonly x: number;
    readonly z: number;
    readonly slot: string;
    readonly offset: number;
  }[];
  readonly scripts: readonly { readonly offset: number; readonly code: readonly ScriptOp[] }[];
}
interface FunCode {
  readonly functions: readonly { readonly index: number; readonly code: readonly ScriptOp[] }[];
}
interface MapOutposts {
  readonly outposts: readonly {
    readonly tankPad: readonly number[];
    readonly jetPad: readonly number[];
  }[];
}

/** One op's three arguments, all known, or null. */
function args3(op: ScriptOp): [number, number, number] | null {
  const a = op.args;
  if (op.kind !== "op" || !a || a.length !== 3) return null;
  if (a.some((v) => typeof v !== "number")) return null;
  return [a[0] as number, a[1] as number, a[2] as number];
}

/** The enable (reloc_2c) script of every type-14 zone the test picks. */
function zoneScripts(
  scripts: ActorScripts,
  pick: (ref: ActorScripts["refs"][number]) => boolean,
): ScriptOp[][] {
  const out: ScriptOp[][] = [];
  for (const ref of scripts.refs) {
    if (ref.act_type !== 14 || ref.slot !== "reloc_2c" || !pick(ref)) continue;
    const script = scripts.scripts.find((s) => s.offset === ref.offset);
    if (!script) throw new Error(`zone ${ref.actor_id}: no script at ${ref.offset}`);
    out.push([...script.code]);
  }
  return out;
}

/** Order 0x7a with 1: enable the zone (the activation turning its claim spot on). */
const ORDER_ENABLE = 0x7a;
/** How far a slot's zone may stand from the spot the map keeps (Hk's are 6 cm apart). */
const ZONE_REACH = 0.25;

interface OutpostScripts {
  /** Per outpost: the records its activation spawns and the ones it destroys. */
  readonly spawns: Set<number>[];
  readonly kills: Set<number>[];
  /** Per outpost: the groups its claim recolours. */
  readonly groups: Set<number>[];
}

function outpostScripts(scripts: ActorScripts, map: MapOutposts, mapId: string): OutpostScripts {
  const spawns: Set<number>[] = [];
  const kills: Set<number>[] = [];
  const groups: Set<number>[] = [];
  map.outposts.forEach((o, k) => {
    // The two slots' activation spots stand on the map's tank pad; each one's
    // enable script turns its claim spot on (order 0x7a), which is how the
    // claim scripts are found, not by where they stand.
    const activation = zoneScripts(
      scripts,
      (ref) =>
        Math.hypot(ref.x + LOGIC_OFFSET_X - o.tankPad[0], ref.z + LOGIC_OFFSET_Z - o.tankPad[1]) <
        ZONE_REACH,
    );
    const claimIds = new Set<number>();
    for (const code of activation) {
      for (const op of code) {
        const a = args3(op);
        if (a && op.name === "entity_38" && a[1] === ORDER_ENABLE && a[2] === 1) claimIds.add(a[0]);
      }
    }
    const claim = zoneScripts(scripts, (ref) => claimIds.has(ref.actor_id));
    // One activation and one claim spot per slot: two each.
    if (activation.length !== 2 || claim.length !== 2) {
      throw new Error(
        `${mapId} outpost ${k}: ${activation.length} activation and ${claim.length} claim scripts`,
      );
    }
    const s = new Set<number>();
    const d = new Set<number>();
    for (const code of activation) {
      for (const op of code) {
        const a = args3(op);
        if (!a) continue;
        if (op.name === "spawn_actor") s.add(a[0]);
        if (op.name === "entity_38" && a[1] === ORDER_OP14 && a[2] <= 1) d.add(a[0]);
      }
    }
    const g = new Set<number>();
    for (const code of claim) {
      for (const op of code) {
        const a = args3(op);
        if (a && op.name === "entity_39" && a[1] === ORDER_SET_UV) g.add(a[0]);
      }
    }
    spawns.push(s);
    kills.push(d);
    groups.push(g);
  });
  return { spawns, kills, groups };
}

/** The tFUN functions that spawn a record, by index. */
function functionSpawns(fun: FunCode, id: number): number[] {
  return fun.functions
    .filter((f) => f.code.some((op) => op.name === "spawn_actor" && args3(op)?.[0] === id))
    .map((f) => f.index);
}

// --- pa_models.json: what a scenery model animates --------------------------

interface PaModels {
  readonly models: Readonly<
    Record<
      string,
      {
        readonly anim?: {
          readonly kind: string;
          readonly frames: number;
          readonly tracks?: readonly {
            readonly track: number;
            readonly from: number;
            readonly to: number;
            readonly mode: number;
            readonly end: number;
            readonly link: number;
            readonly period: number;
          }[];
        } | null;
      }
    >
  >;
}

interface Morph {
  frames: number;
  period: number;
}

/**
 * Track 0 of the model's AnmD, as the construct starts it (`cact_anim_init`
 * with index 0): frames from..to, looping on itself, one frame per `period`
 * units of the 300 Hz frame delta. Null for a model that does not move.
 */
function morphOf(pa: PaModels, cobj: number, mapId: string): Morph | null {
  const a = pa.models[String(cobj)]?.anim;
  if (!a || a.kind === "static") return null;
  if (a.kind !== "morph") throw new Error(`${mapId} Cobj ${cobj}: a ${a.kind} scenery model`);
  const t = a.tracks?.[0];
  if (!t || (t.mode !== 1 && t.mode !== 2)) throw new Error(`${mapId} Cobj ${cobj}: track 0 holds`);
  if (t.from !== 0 || t.to !== a.frames - 1 || t.end !== 0 || t.link !== t.track) {
    throw new Error(`${mapId} Cobj ${cobj}: track 0 is not a loop over every frame`);
  }
  return { frames: a.frames, period: t.period };
}

// --- the table ---------------------------------------------------------------

type Show = "always" | "unclaimed" | "claimed";

interface Placement {
  record: string;
  cobj: number;
  x: number;
  y: number;
  h: number;
  yaw: number;
  show: Show;
  outpost: number;
}

interface ArenaTable {
  mission: string;
  placements: Placement[];
  morphs: [number, Morph][];
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function arenaTable(arena: FcopArena, records: readonly PropRecord[], reRepo: string): ArenaTable {
  const { mapId, mission } = arena;
  const readRe = <T>(...p: string[]): T =>
    JSON.parse(readFileSync(join(reRepo, ...p), "utf8")) as T;
  const scripts = readRe<ActorScripts>("extracted", "data", mission, "actor_scripts.json");
  const fun = readRe<FunCode[]>("extracted", "data", mission, "fun_code.json");
  if (fun.length !== 1) throw new Error(`${mapId}: ${fun.length} Cfun resources`);
  const pa = readRe<PaModels>("extracted", "logic", mission, "pa_models.json");
  const map = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "sim", "maps", `${mapId}.json`), "utf8"),
  ) as MapOutposts;
  const op = outpostScripts(scripts, map, mapId);

  const placements: Placement[] = [];
  for (const r of records) {
    const what = `${mapId} ${r.res} ${r.id}`;
    if (r.cobj < 0) throw new Error(`${what}: no model`);
    // Bit 0 lays the model onto the ground's slope (math_matrix_from_up);
    // no Precinct Assault record sets it, and the table has no tilt to say so.
    if ((r.flags & 1) !== 0) throw new Error(`${what}: laid on the slope`);
    let show: Show = "always";
    let outpost = -1;
    const claimedAt = op.spawns.findIndex((s) => s.has(r.id));
    const killedAt = op.kills.findIndex((s) => s.has(r.id));
    const flagOf = op.groups.findIndex((g) => g.has(r.group));
    if (r.res === "Csac") {
      if (claimedAt >= 0) {
        show = "claimed";
        outpost = claimedAt;
      } else if (functionSpawns(fun[0], r.id).length === 0) {
        throw new Error(`${what}: spawned by nothing the table knows`);
      }
    } else if (killedAt >= 0) {
      show = "unclaimed";
      outpost = killedAt;
    }
    if (r.group !== 0 && flagOf >= 0) {
      if (outpost >= 0 && outpost !== flagOf) throw new Error(`${what}: two outposts`);
      outpost = flagOf;
    }
    placements.push({
      record: `${r.res} ${r.id}`,
      cobj: r.cobj,
      // position[2] runs along the sim's x, position[0] along its y.
      x: round4(r.pos[2] / WU_PER_M + LOGIC_OFFSET_X),
      y: round4(r.pos[0] / WU_PER_M + LOGIC_OFFSET_Z),
      h: round4((r.terrain + r.heightOffset) / WU_PER_M),
      yaw: r.yaw,
      show,
      outpost,
    });
  }
  placements.sort((a, b) => {
    const [ra, ia] = a.record.split(" ");
    const [rb, ib] = b.record.split(" ");
    return ra === rb ? Number(ia) - Number(ib) : ra < rb ? -1 : 1;
  });
  const morphs: [number, Morph][] = [];
  for (const cobj of [...new Set(placements.map((p) => p.cobj))].sort((a, b) => a - b)) {
    const m = morphOf(pa, cobj, mapId);
    if (m) morphs.push([cobj, m]);
  }
  return { mission, placements, morphs };
}

function format(tables: readonly [string, ArenaTable][], reCommit: string): string {
  const lines: string[] = [
    "// GENERATED by tools/generators/fcopScenery.ts (bun run gen:scenery) — do not edit by hand.",
    "//",
    "// Every type-11 record (DynamicProp) of each arena's mission, as the original",
    "// places it: its model, the height its construct takes off the terrain on the",
    "// record's layer (RE turret_part.c 0x0041cf70), its yaw, and when it stands —",
    "// an outpost's console until the outpost is claimed, its two terminals from",
    "// then on (the activation script, RE docs/behavior/precinct-assault.md",
    '// "Outposts"). Read from the mission bytes, the outposts\' scripts and',
    `// pa_models.json at RE ${reCommit}.`,
    "",
    "/** When a placement stands: always, until its outpost is claimed, or from then on. */",
    'export type SceneryShow = "always" | "unclaimed" | "claimed";',
    "",
    "export interface SceneryPlacement {",
    "  /** The record: `Cact` placed at load, `Csac` spawned by a script. */",
    "  readonly record: string;",
    "  /** The model, a Cobj id in the arena's own mission. */",
    "  readonly cobj: number;",
    "  /** The model's origin in the sim frame, metres; `h` is its height. */",
    "  readonly x: number;",
    "  readonly y: number;",
    "  readonly h: number;",
    "  /** The record's yaw (payload +0x22, `My(yaw)`), 4096 a turn. */",
    "  readonly yaw: number;",
    "  readonly show: SceneryShow;",
    "  /** The outpost (map.outposts index) that claims, recolours or spawns it; -1 none. */",
    "  readonly outpost: number;",
    "}",
    "",
    "/** A looping morph over every frame of the model, one frame per `period` / 300 s. */",
    "export interface SceneryMorph {",
    "  readonly frames: number;",
    "  readonly period: number;",
    "}",
    "",
    "export interface ArenaScenery {",
    "  readonly mission: string;",
    "  readonly placements: readonly SceneryPlacement[];",
    "  /** By Cobj: the models that move. */",
    "  readonly morphs: Readonly<Record<number, SceneryMorph>>;",
    "}",
    "",
    "export const SCENERY_PLACEMENTS: Readonly<Record<string, ArenaScenery>> = {",
  ];
  for (const [mapId, t] of tables) {
    lines.push(`  ${JSON.stringify(mapId)}: {`, `    mission: ${JSON.stringify(t.mission)},`);
    lines.push("    placements: [");
    for (const p of t.placements) {
      lines.push(
        `      { record: ${JSON.stringify(p.record)}, cobj: ${p.cobj}, x: ${p.x}, y: ${p.y}, h: ${p.h}, yaw: ${p.yaw}, show: ${JSON.stringify(p.show)}, outpost: ${p.outpost} },`,
      );
    }
    lines.push("    ],");
    lines.push(
      `    morphs: { ${t.morphs.map(([c, m]) => `${c}: { frames: ${m.frames}, period: ${m.period} }`).join(", ")} },`,
    );
    lines.push("  },");
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** The table as the formatter writes it, so a re-run and `--check` agree with lint. */
function biomeFormat(text: string): string {
  const fmt = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${OUT_TS}`], {
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
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  let stale = 0;
  for (const arena of selectArenas(positional || "all")) {
    const scenery = ARENA_SCENERY.find((a) => a.mapId === arena.mapId);
    if (!scenery) throw new Error(`${arena.mapId}: no ARENA_SCENERY entry`);
    if (scenery.mission !== arena.mission) {
      throw new Error(`${arena.mapId}: scenery says ${scenery.mission}, arena is ${arena.mission}`);
    }
    const src = join(reRepo, "extracted", "objects", arena.mission);
    const out = join(RAW_DIR, "fcop-props", arena.mission);
    if (!check) {
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
    }
    for (const [cobj] of scenery.props) {
      const name = `obj_${String(cobj).padStart(3, "0")}.glb`;
      const from = join(src, name);
      const to = join(RAW_DIR, sceneryRaw(arena.mission, cobj));
      if (!check) {
        copyFileSync(from, to);
        continue;
      }
      if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) {
        console.log(`${to} is not ${from}`);
        stale++;
      }
    }
    console.log(
      `${arena.mapId} (${arena.mission}): ${scenery.props.map(([c]) => c).join(", ")}` +
        (check ? " checked" : " copied"),
    );
  }

  const records = readRecords(
    reRepo,
    FCOP_ARENAS.map((a) => a.mission),
  );
  const commit = Bun.spawnSync(["git", "-C", reRepo, "rev-parse", "--short", "HEAD"]);
  const reCommit = commit.exitCode === 0 ? commit.stdout.toString().trim() : "unknown";
  const tables = FCOP_ARENAS.map(
    (a) => [a.mapId, arenaTable(a, records[a.mission] ?? [], reRepo)] as [string, ArenaTable],
  );
  for (const [mapId, t] of tables) {
    const scenery = ARENA_SCENERY.find((a) => a.mapId === mapId);
    const placed = [...new Set(t.placements.map((p) => p.cobj))].sort((a, b) => a - b);
    const carried = (scenery?.props ?? []).map(([c]) => c).sort((a, b) => a - b);
    if (placed.join(",") !== carried.join(",")) {
      throw new Error(`${mapId}: the records place ${placed}, ARENA_SCENERY carries ${carried}`);
    }
    const shows = (s: Show) => t.placements.filter((p) => p.show === s).length;
    console.log(
      `${mapId}: ${t.placements.length} placements (${shows("unclaimed")} until claimed, ` +
        `${shows("claimed")} once claimed), morphs ${t.morphs.map(([c]) => c).join(", ") || "none"}`,
    );
  }
  const text = biomeFormat(format(tables, reCommit));
  if (check) {
    const committed = existsSync(OUT_TS) ? readFileSync(OUT_TS, "utf8") : "";
    // The RE commit in the header is provenance, not content.
    const strip = (s: string) => s.replace(/at RE [0-9a-f]+\./, "at RE <commit>.");
    if (strip(committed) !== strip(text)) {
      console.log(`${OUT_TS} is stale`);
      stale++;
    }
  } else {
    writeFileSync(OUT_TS, text);
  }
  if (stale > 0) {
    console.error(`${stale} stale scenery raw(s) or table: run bun run gen:scenery`);
    process.exit(1);
  }
}

if (import.meta.main) main();
