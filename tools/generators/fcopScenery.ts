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
import { requireReRepo } from "./reRepo";
import {
  type BoxHalfwords,
  type DecalRect,
  type PropRecord as EmitterRecord,
  emitterAnchor,
  GameRand,
  type QuadRecord,
  RETAIL_SEED,
  resolveProp,
  resolveQuad,
} from "./sceneryProps";
import { ARENA_SCENERY, sceneryRaw } from "./units/manifest";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RAW_DIR = join(import.meta.dir, "units", "raw");
const DECAL_DIR = join(REPO_ROOT, "packages", "client", "public", "models", "decals");
const OUT_TS = join(REPO_ROOT, "packages", "client", "src", "render", "arenaScenery.generated.ts");
/** enrichArena.ts LOGIC_OFFSET_X / _Z: the actor frame's shift onto the sim grid. */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;
/** World units a metre (and a grid cell): `>> 13` is the terrain sample. */
const WU_PER_M = 8192;
/** The DynamicProp. */
const TYPE_DYNAMIC_PROP = 11;
/** The Prop: a model the original builds as a permanent sound emitter. */
const TYPE_PROP = 96;
/** The DCSQuad: one decal quad, a pyro block that never expires. */
const TYPE_DCS_QUAD = 97;
/** The turret types that build a base part (turret_construct's 8, 33 and 36 arm). */
const TURRET_TYPES = [8, 33, 36];
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
  /** The record's flags dword (payload +16), the instance's +0x24 at load. */
  readonly actorFlags: number;
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

def arsl(p):
    # The aRSL list's Cobj ids, in order.
    out = []
    at = p.find(b"LSRa")
    if at >= 0:
        n = (struct.unpack_from("<I", p, at + 4)[0] - 12) // 8
        for i in range(n):
            tag, rid = struct.unpack_from("<II", p, at + 12 + 8 * i)
            if tag == 0x436F626A:
                out.append(rid)
    return out

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
    turrets = []
    props96 = []
    quads = []
    rects = []
    for seq, r in enumerate(resources):
        if r["type"] == "Cdcs":
            # The decal rects (tools/gfx/extract_decals.py parse_cdcs): u, v,
            # w, h, the Cbmp page, two pads, the id a DCSQuad names.
            c = extract(blob, r)
            for i in range(struct.unpack_from("<I", c, 8)[0]):
                e = c[12 + 8 * i: 20 + 8 * i]
                rects.append({"res": r["id"], "u": e[0], "v": e[1], "w": e[2], "h": e[3], "page": e[4], "id": e[7]})
        if r["type"] not in ("Cact", "Csac"):
            continue
        p = extract(blob, r)
        if p[0:4] != b"TCAt":
            continue
        pay = p[12:]
        if p[12] in (${TURRET_TYPES.join(", ")}):
            # turret_construct's base part (aRSL 2) is built from the same
            # record by turret_part_construct, whose turret layout reads its
            # yaw at +0x42 (0x0041cfed); the gun's own is +0x34 (0x0041c222).
            turrets.append({
                "res": r["type"], "id": r["id"], "type": p[12], "team": pay[0x18],
                "pos": list(struct.unpack_from("<3i", pay, 4)),
                "base": struct.unpack_from("<h", pay, 0x42)[0],
                "gun": struct.unpack_from("<h", pay, 0x34)[0],
            })
            continue
        rec = p[8:]  # the record the loaders hand on: the payload less four
        if p[12] == ${TYPE_PROP}:
            # cact_load_type96 (0x0042fc80) -> snd_emit_build (0x0042f6c0):
            # snd_emit_record, every field the build reads.
            sel = struct.unpack_from("<b", rec, 0x1c)[0]
            # 0x0042f80e: -99 no ground; 0 -> highest, 1 -> lowest, n -> n - 2.
            layer = None if sel == -99 else (LAYER_HIGHEST if sel == 0 else (LAYER_LOWEST if sel == 1 else sel - 2))
            pos = list(struct.unpack_from("<3i", rec, 8))
            props96.append({
                "seq": seq, "res": r["type"], "id": r["id"], "cobjs": arsl(p), "pos": pos,
                "angleY": struct.unpack_from("<h", rec, 0x14)[0],
                "angleZ": struct.unpack_from("<h", rec, 0x16)[0],
                "angleX": struct.unpack_from("<h", rec, 0x18)[0],
                "height": struct.unpack_from("<h", rec, 0x1a)[0],
                "layer": sel, "flags": rec[0x1d], "rate": rec[0x1e],
                "scale": list(struct.unpack_from("<3b", rec, 0x1f)),
                "spin": struct.unpack_from("<b", rec, 0x22)[0], "heading": rec[0x23],
                "ground": None if layer is None else terrain_height_at(world, pos, layer),
            })
            continue
        if p[12] == ${TYPE_DCS_QUAD}:
            # cact_load_type97 (0x004372d0) -> pyro_spawn (0x00437050): the
            # PYRO_REC_* fields of the record.
            sel = struct.unpack_from("<b", rec, 0x22)[0]
            # 0x00437135: -3 no ground; 0 -> highest, 1 -> lowest, n -> n - 2.
            layer = None if sel == -3 else (LAYER_HIGHEST if sel == 0 else (LAYER_LOWEST if sel == 1 else sel - 2))
            pos = list(struct.unpack_from("<3i", rec, 8))
            quads.append({
                "seq": seq, "res": r["type"], "id": r["id"], "pos": pos,
                "flags": rec[0x14], "kind": struct.unpack_from("<b", rec, 0x15)[0],
                "lift": struct.unpack_from("<h", rec, 0x16)[0],
                "spanZ": struct.unpack_from("<h", rec, 0x18)[0],
                "spanX": struct.unpack_from("<h", rec, 0x1a)[0],
                "angleY": struct.unpack_from("<h", rec, 0x1c)[0],
                "angleX": struct.unpack_from("<h", rec, 0x1e)[0],
                "angleZ": struct.unpack_from("<h", rec, 0x20)[0],
                "layer": sel, "colour": list(rec[0x23:0x26]),
                "ground": 0 if layer is None else terrain_height_at(world, pos, layer),
            })
            continue
        if p[12] != ${TYPE_DYNAMIC_PROP}:
            continue
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
            "actorFlags": struct.unpack_from("<I", pay, 16)[0],
            "terrain": terrain_height_at(world, pos, layer),
        })
    # Every cell's visibility quadtree: its Ctil section's 21 (radius, height)
    # pairs from +0x374 (RE game/frame/draw.c DRAW_TILE_TREE_OFFSET, added at
    # 0x00452e27), pair k at +4k being tree bit k of draw_node_visible
    # (0x00452de0): the node's, its children's, then child n's four leaves at
    # +16n+4. Keyed "x>>17,z>>17", the grid's own (cptc_cell_raw) order.
    trees = {}
    for gx in range(world.height):
        for gz in range(world.width):
            sect = world.section_for(gx, gz)
            if sect is not None:
                trees["%d,%d" % (gx, gz)] = list(struct.unpack_from("<42h", sect, 0x374))
    out[mission] = {"props": recs, "turrets": turrets, "props96": props96, "quads": quads, "rects": rects,
                    "trees": trees}
print(json.dumps(out))
`;

/** A turret record (types 8, 33 and 36): its gun, and the base part built from it. */
interface TurretRecord {
  readonly res: "Cact" | "Csac";
  readonly id: number;
  readonly type: number;
  /** The base entity's team byte (payload +0x18): the side, 0 for a NeutralTurret. */
  readonly team: number;
  readonly pos: readonly [number, number, number];
  /** The base part's yaw, payload +0x42 (turret_part_construct's turret layout). */
  readonly base: number;
  /** The gun's own yaw, payload +0x34 (turret_construct, the turret's rest yaw). */
  readonly gun: number;
}

interface MissionRecords {
  readonly props: PropRecord[];
  readonly turrets: TurretRecord[];
  /** The type-96 Props and type-97 DCSQuads, and the Cdcs rects they name. */
  readonly props96: EmitterRecord[];
  readonly quads: QuadRecord[];
  readonly rects: DecalRect[];
  /** By cell "x>>17,z>>17": its Ctil section's quadtree, 21 (radius, height) pairs. */
  readonly trees: Record<string, number[]>;
}

function readRecords(reRepo: string, missions: readonly string[]): Record<string, MissionRecords> {
  const r = Bun.spawnSync(["python3", "-I", "-B", "-c", READER, reRepo, ...missions]);
  if (r.exitCode !== 0) throw new Error(`reading the type-11 records failed: ${r.stderr}`);
  return JSON.parse(r.stdout.toString()) as Record<string, MissionRecords>;
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
  /** Flag 8 (never culled) from the record's flags, which a type-11 keeps. */
  keep: boolean;
}

interface TurretBase {
  record: string;
  type: number;
  side: number;
  x: number;
  y: number;
  yaw: number;
}

interface PropRow {
  record: string;
  cobj: number;
  x: number;
  y: number;
  h: number;
  yaw: number;
  pitch: number;
  roll: number;
  scale: readonly number[];
  spin: number;
  swing: number;
  park: number;
  anim: string;
  period: number;
  sound: number;
  quad: number;
  leaf: number;
}

/** A cell's visibility quadtree, as the client tests it (render/drawWindow.ts). */
interface LeafTree {
  /** The cell: `z >> 17` (along the map's x) and `x >> 17` (its y). */
  cz: number;
  cx: number;
  /** 21 (radius, height) halfword pairs: pair k is tree bit k. */
  spheres: number[];
}

interface QuadRow {
  record: string;
  decal: number;
  x: number;
  y: number;
  h: number;
  yaw: number;
  pitch: number;
  roll: number;
  halfX: number;
  halfZ: number;
  tint: readonly number[];
  blend: number;
  twoSided: boolean;
}

interface DecalFile {
  /** Under public/models/decals/<mapId>/. */
  file: string;
  /** The RE's crop it is copied from, under extracted/decals/. */
  from: string;
  w: number;
  h: number;
}

interface ArenaTable {
  mission: string;
  placements: Placement[];
  morphs: [number, Morph][];
  turretBases: TurretBase[];
  props: PropRow[];
  /** By Cobj: its frame count, whether it is drawn and its box's centre (see emitterTables). */
  propModels: [number, PropModelRow][];
  /** The quadtrees of the cells the Props hang in. */
  leafTrees: LeafTree[];
  quads: QuadRow[];
  decals: [number, DecalFile][];
}

interface ObjectManifest {
  readonly objects?: readonly {
    id: number;
    glb: string | null;
    frames_actual: number;
    tris: number;
    quads: number;
    /** Its camera-facing billboards, lines and stars (RE objects.md "Facers"). */
    facers?: number;
    /** The 3DBB box 0 of frame 0, metres in the glb's frame (the Cobj's x negated). */
    bbox?: { center: [number, number, number]; half: [number, number, number] } | null;
  }[];
}

/** A Prop model's row: frames, drawn, and its box's centre in the glb's frame. */
interface PropModelRow {
  frames: number;
  drawn: boolean;
  centre: [number, number, number];
}

interface DecalManifest {
  readonly decals: readonly {
    container: string;
    dcs_id: number;
    sprite_id: number;
    file?: string;
    w: number;
    h: number;
  }[];
}

/**
 * The arena's type-96 Props and type-97 DCSQuads, built in the order the
 * mission loads them, their random angles and scales drawn from one
 * `game_rand` stream. The stream's seed is a guess: the original reseeds from
 * the wall clock at every mission load (RE mission/session.c 0x004060ba) and
 * other loads draw from it in between; the image's own fixed seed 0x457 (the
 * maths init's) stands in, so every load of an arena is one of the original's.
 */
function emitterTables(
  mapId: string,
  mission: string,
  own: MissionRecords,
  reRepo: string,
): Pick<ArenaTable, "props" | "propModels" | "leafTrees" | "quads" | "decals"> {
  const objects = JSON.parse(
    readFileSync(join(reRepo, "extracted", "objects", mission, "manifest.json"), "utf8"),
  ) as ObjectManifest | NonNullable<ObjectManifest["objects"]>;
  const list = (Array.isArray(objects) ? objects : (objects as ObjectManifest).objects) ?? [];
  const byId = new Map(list.map((o) => [o.id, o]));
  const frames = (cobj: number): number => byId.get(cobj)?.frames_actual ?? 1;
  const rand = new GameRand(RETAIL_SEED);
  const loads = [
    ...own.props96.map((r) => ({ seq: r.seq, prop: r, quad: null })),
    ...own.quads.map((r) => ({ seq: r.seq, prop: null, quad: r })),
  ].sort((a, b) => a.seq - b.seq);
  const props: PropRow[] = [];
  const quads: QuadRow[] = [];
  const leafTrees: LeafTree[] = [];
  /** The quadtree of cell (cz, cx) in `leafTrees`, -1 for a cell with no section. */
  const leafOf = (cz: number, cx: number): number => {
    const at = leafTrees.findIndex((t) => t.cz === cz && t.cx === cx);
    if (at >= 0) return at;
    const tree = own.trees[`${cx},${cz}`];
    if (!tree) return -1;
    leafTrees.push({ cz, cx, spheres: tree });
    return leafTrees.length - 1;
  };
  for (const load of loads) {
    if (load.prop) {
      const p = resolveProp(load.prop, rand, frames);
      if (!byId.has(p.cobj)) throw new Error(`${mapId} ${p.record}: Cobj ${p.cobj} not exported`);
      // The footprint `snd_emit_draw_block` ands with the cell's leaves on
      // screen (0x0042feb8), from box 0 of frame 0 in exact halfwords.
      const anchor = emitterAnchor(p, boxHalfwords(mapId, p.cobj, byId.get(p.cobj)?.bbox));
      props.push({
        record: p.record,
        cobj: p.cobj,
        x: round4(p.pos[2] / WU_PER_M + LOGIC_OFFSET_X),
        y: round4(p.pos[0] / WU_PER_M + LOGIC_OFFSET_Z),
        h: round4(p.pos[1] / WU_PER_M),
        yaw: p.yaw,
        pitch: p.pitch,
        roll: p.roll,
        scale: p.scale,
        spin: p.spin,
        swing: p.swing,
        park: p.park,
        anim: p.anim,
        period: p.period,
        sound: p.sound,
        quad: anchor.quad,
        leaf: leafOf(anchor.cellZ, anchor.cellX),
      });
    } else if (load.quad) {
      const q = resolveQuad(load.quad, rand, own.rects);
      if (!q) continue;
      quads.push({
        record: q.record,
        decal: q.decal,
        x: round4(q.pos[2] / WU_PER_M + LOGIC_OFFSET_X),
        y: round4(q.pos[0] / WU_PER_M + LOGIC_OFFSET_Z),
        h: round4(q.pos[1] / WU_PER_M),
        yaw: q.yaw,
        pitch: q.pitch,
        roll: q.roll,
        halfX: round4(q.halfX / WU_PER_M),
        halfZ: round4(q.halfZ / WU_PER_M),
        tint: q.tint,
        blend: q.blend,
        twoSided: q.twoSided,
      });
    }
  }
  props.sort(byRecord);
  quads.sort(byRecord);
  // A model is drawn where the RE exports it with faces or facers of its own:
  // the camera-facing billboards, lines and stars are the glb's records now
  // (RE objects.md "Facers"), which render/facers.ts turns to the camera, so
  // the five Props of facers only (Hk 65, Slim 63 / 83, Joke 62 / 82) draw
  // too. The RE's static white stand-ins for them are dropped by gen:units.
  // Its box's centre: `snd_emit_build` hangs the Prop in the cell of that
  // centre placed by its orientation (0x0042f942..0x0042fa88), not its origin.
  const propModels: [number, PropModelRow][] = [...new Set(props.map((p) => p.cobj))]
    .sort((a, b) => a - b)
    .map((cobj) => {
      const o = byId.get(cobj);
      const drawn = !!o?.glb && (o.tris + o.quads > 0 || (o.facers ?? 0) > 0);
      const c = o?.bbox?.center;
      if (!c) throw new Error(`${mapId}: Prop Cobj ${cobj} has no 3DBB box in the manifest`);
      const centre: [number, number, number] = [round4(c[0]), round4(c[1]), round4(c[2])];
      return [cobj, { frames: frames(cobj), drawn, centre }];
    });
  const manifest = JSON.parse(
    readFileSync(join(reRepo, "extracted", "decals", "manifest.json"), "utf8"),
  ) as DecalManifest;
  const decals: [number, DecalFile][] = [...new Set(quads.map((q) => q.decal))]
    .sort((a, b) => a - b)
    .map((id) => {
      const rect = own.rects.find((r) => r.id === id);
      const crop = manifest.decals.find(
        (d) => d.container === mission && d.dcs_id === rect?.res && d.sprite_id === id,
      );
      if (!rect || !crop?.file) throw new Error(`${mapId}: no crop of Cdcs rect ${id}`);
      if (crop.w !== rect.w || crop.h !== rect.h) {
        throw new Error(
          `${mapId}: Cdcs rect ${id} is ${rect.w}x${rect.h}, its crop ${crop.w}x${crop.h}`,
        );
      }
      return [id, { file: decalFile(id), from: crop.file, w: rect.w, h: rect.h }];
    });
  // The trees in the order of their cells, so the table does not move with
  // the Props' load order; each Prop's `leaf` follows its tree.
  const order = leafTrees
    .map((_, i) => i)
    .sort((a, b) => leafTrees[a].cz - leafTrees[b].cz || leafTrees[a].cx - leafTrees[b].cx);
  const renumber = new Map(order.map((from, to) => [from, to]));
  for (const p of props) if (p.leaf >= 0) p.leaf = renumber.get(p.leaf) ?? -1;
  return { props, propModels, leafTrees: order.map((i) => leafTrees[i]), quads, decals };
}

/**
 * A Prop model's 3DBB box 0 of frame 0 as the mission stores it: halfwords of
 * 16 world units, the Cobj's x (the manifest's glb frame negates it). The
 * manifest's metres are those halfwords / 512 exactly; anything else is a
 * manifest this reader does not know.
 */
function boxHalfwords(
  mapId: string,
  cobj: number,
  bbox: { center: [number, number, number]; half: [number, number, number] } | null | undefined,
): BoxHalfwords {
  if (!bbox?.half) throw new Error(`${mapId}: Prop Cobj ${cobj} has no 3DBB box in the manifest`);
  const hw = [-bbox.center[0], bbox.center[1], bbox.center[2], ...bbox.half].map((m) => m * 512);
  if (hw.some((v) => !Number.isInteger(v))) {
    throw new Error(`${mapId}: Prop Cobj ${cobj}'s box is not in whole halfwords: ${hw}`);
  }
  return [hw[0], hw[1], hw[2], hw[3], hw[4], hw[5]];
}

/** A decal's file name in the arena's folder. */
function decalFile(id: number): string {
  return `dcs-${String(id).padStart(2, "0")}.png`;
}

/** Records in resource order: Cact before Csac, each by id. */
function byRecord(a: { record: string }, b: { record: string }): number {
  const [ra, ia] = a.record.split(" ");
  const [rb, ib] = b.record.split(" ");
  return ra === rb ? Number(ia) - Number(ib) : ra < rb ? -1 : 1;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function arenaTable(arena: FcopArena, own: MissionRecords, reRepo: string): ArenaTable {
  const records = own.props;
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
      // cact_base_construct copies the record's flags; a type-11 actor's
      // construct leaves them alone (RE turret_part.c 0x0041cf9a), so bit 3 --
      // never culled by the registry (0x0043b61b, RE M3-OP) -- is the record's.
      keep: (r.actorFlags & 8) !== 0,
    });
  }
  placements.sort(byRecord);
  const morphs: [number, Morph][] = [];
  for (const cobj of [...new Set(placements.map((p) => p.cobj))].sort((a, b) => a - b)) {
    const m = morphOf(pa, cobj, mapId);
    if (m) morphs.push([cobj, m]);
  }
  const turretBases = own.turrets
    .map((t) => ({
      record: `${t.res} ${t.id}`,
      type: t.type,
      side: t.team,
      x: round4(t.pos[2] / WU_PER_M + LOGIC_OFFSET_X),
      y: round4(t.pos[0] / WU_PER_M + LOGIC_OFFSET_Z),
      yaw: t.base,
    }))
    .sort(byRecord);
  const emitters = emitterTables(mapId, mission, own, reRepo);
  const overlap = emitters.props.filter((p) => placements.some((q) => q.cobj === p.cobj));
  if (overlap.length > 0) throw new Error(`${mapId}: a Cobj both a DynamicProp and a Prop`);
  return { mission, placements, morphs, turretBases, ...emitters };
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
    '// "Outposts"). And the yaw of every turret\'s base part, which its construct',
    "// reads off the turret's record (RE turret_part.c 0x0041cf70); every type-96",
    "// Prop as `snd_emit_build` stands it (RE snd/emitter.c) and every type-97",
    "// DCSQuad as `pyro_spawn` does (RE world/pyro_chain.c), their random angles",
    "// drawn from `game_rand` seeded 0x457 (a stand-in for the original's wall",
    "// clock), with its footprint and the visibility quadtree of the cell it hangs",
    "// in (RE game/frame/draw.c 0x00452de0). Read from the mission bytes, the",
    "// outposts' scripts, pa_models.json",
    `// and the object and decal manifests at RE ${reCommit}.`,
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
    "  /** Flag 8: the registry keeps it at any distance (RE 0x0043b61b); absent, false. */",
    "  readonly keep?: true;",
    "}",
    "",
    "/** A looping morph over every frame of the model, one frame per `period` / 300 s. */",
    "export interface SceneryMorph {",
    "  readonly frames: number;",
    "  readonly period: number;",
    "}",
    "",
    "/** A turret record's base part (types 8, 33, 36): where it stands and its own yaw. */",
    "export interface SceneryTurretBase {",
    "  readonly record: string;",
    "  /** The actor type: 8 a team's Turret, 36 a NeutralTurret. */",
    "  readonly type: number;",
    "  /** The record's side (its team byte): 1 or 2, 0 for a NeutralTurret. */",
    "  readonly side: number;",
    "  /** The record's position in the sim frame, metres. */",
    "  readonly x: number;",
    "  readonly y: number;",
    "  /** The base part's yaw (payload +0x42, not the gun's +0x34), 4096 a turn. */",
    "  readonly yaw: number;",
    "}",
    "",
    "/** How a Prop steps its model's frames: not, looping, or there and back. */",
    'export type SceneryPropAnim = "none" | "loop" | "boomerang";',
    "",
    "/**",
    " * A type-96 Prop: a model the original builds as a permanent sound emitter",
    " * (RE snd/emitter.c `cact_load_type96` -> `snd_emit_build`).",
    " */",
    "export interface SceneryProp {",
    "  readonly record: string;",
    "  /** The model, a Cobj id in the arena's own mission (its first aRSL entry). */",
    "  readonly cobj: number;",
    "  /** The model's origin in the sim frame, metres; `h` is its height. */",
    "  readonly x: number;",
    "  readonly y: number;",
    "  readonly h: number;",
    "  /** `math_matrix_from_angles(yaw, pitch, roll)`, 4096 a turn, random ones drawn. */",
    "  readonly yaw: number;",
    "  readonly pitch: number;",
    "  readonly roll: number;",
    "  /** The orientation's three rows scaled by these / 64. */",
    "  readonly scale: readonly [number, number, number];",
    "  /** A turn of `clock * spin` (12-bit) every frame; 0 keeps the built orientation. */",
    "  readonly spin: number;",
    "  /** With a spin: the swing's amplitude about `park` (12-bit); 0 a plain spin. */",
    "  readonly swing: number;",
    "  readonly park: number;",
    "  readonly anim: SceneryPropAnim;",
    "  /** Engine ticks (1/300 s) a frame. */",
    "  readonly period: number;",
    "  /** The table-A sound the emitter plays where it stands, 0 none. */",
    "  readonly sound: number;",
    "  /**",
    "   * Its footprint: the quarter-cells of its anchor's cell its unturned box",
    "   * spans (`world_cell_quad_mask` 0x0042f600 from `snd_emit_build` 0x0042fa7f),",
    "   * quarter (x, z) at bit 0x8000 >> (4 x + z), x along the map's y.",
    "   */",
    "  readonly quad: number;",
    "  /** Its cell's quadtree in `leafTrees`, -1 for a cell with no section. */",
    "  readonly leaf: number;",
    "}",
    "",
    "/**",
    " * A cell's visibility quadtree: its Ctil section's 21 (radius, height) pairs",
    " * from +0x374, each halfword 16 world units (RE game/frame/draw.c",
    " * `draw_node_visible` 0x00452de0). Pair k is tree bit k: the cell's at 0, its",
    " * four 8 m children's at 1..4 (child (x, z) half at 1 + 2 x + z), then child",
    " * n's four 4 m leaves at 4 n + 1..4 n + 4 (leaf (x, z) at 2 x + z within it).",
    " */",
    "export interface SceneryLeafTree {",
    "  /** The cell: `z >> 17` (along the map's x) and `x >> 17` (its y). */",
    "  readonly cz: number;",
    "  readonly cx: number;",
    "  readonly spheres: readonly number[];",
    "}",
    "",
    "/**",
    " * A Prop model: its frame count, whether it is drawn — every model the",
    " * RE exports with faces or camera-facing facers (render/facers.ts) — and the",
    " * centre of its 3DBB box 0 of frame 0, metres in the glb's frame: the point",
    " * the Prop hangs in the cell of, once placed (render/emitterProps.ts).",
    " */",
    "export interface SceneryPropModel {",
    "  readonly frames: number;",
    "  readonly drawn: boolean;",
    "  readonly centre: readonly [number, number, number];",
    "}",
    "",
    "/**",
    " * A type-97 DCSQuad: one decal quad, its corners (+-halfX, 0, +-halfZ) turned",
    " * by `math_matrix_from_angles(yaw, pitch, roll)` (RE world/pyro_chain.c).",
    " */",
    "export interface SceneryQuad {",
    "  readonly record: string;",
    "  /** The Cdcs rect drawn (`decals`). */",
    "  readonly decal: number;",
    "  /** The quad's centre in the sim frame, metres. */",
    "  readonly x: number;",
    "  readonly y: number;",
    "  readonly h: number;",
    "  readonly yaw: number;",
    "  readonly pitch: number;",
    "  readonly roll: number;",
    "  /** Half extents along the quad's own x and z, metres. */",
    "  readonly halfX: number;",
    "  readonly halfZ: number;",
    "  /** The colour the texture is modulated by, 0..255 a channel. */",
    "  readonly tint: readonly [number, number, number];",
    "  /** The driver's blend: 1 the default, 2 additive, 3 the third pair. */",
    "  readonly blend: 1 | 2 | 3;",
    "  readonly twoSided: boolean;",
    "}",
    "",
    "/** A Cdcs rect's crop, copied to public/models/decals/<mapId>/<file>. */",
    "export interface SceneryDecal {",
    "  readonly file: string;",
    "  readonly w: number;",
    "  readonly h: number;",
    "}",
    "",
    "export interface ArenaScenery {",
    "  readonly mission: string;",
    "  readonly placements: readonly SceneryPlacement[];",
    "  /** By Cobj: the models that move. */",
    "  readonly morphs: Readonly<Record<number, SceneryMorph>>;",
    "  readonly turretBases: readonly SceneryTurretBase[];",
    "  /** The type-96 Props, their models, the type-97 DCSQuads and their decals. */",
    "  readonly props: readonly SceneryProp[];",
    "  readonly propModels: Readonly<Record<number, SceneryPropModel>>;",
    "  /** The quadtrees of the cells the Props hang in. */",
    "  readonly leafTrees: readonly SceneryLeafTree[];",
    "  readonly quads: readonly SceneryQuad[];",
    "  readonly decals: Readonly<Record<number, SceneryDecal>>;",
    "}",
    "",
    "export const SCENERY_PLACEMENTS: Readonly<Record<string, ArenaScenery>> = {",
  ];
  for (const [mapId, t] of tables) {
    lines.push(`  ${JSON.stringify(mapId)}: {`, `    mission: ${JSON.stringify(t.mission)},`);
    lines.push("    placements: [");
    for (const p of t.placements) {
      lines.push(
        `      { record: ${JSON.stringify(p.record)}, cobj: ${p.cobj}, x: ${p.x}, y: ${p.y}, h: ${p.h}, yaw: ${p.yaw}, show: ${JSON.stringify(p.show)}, outpost: ${p.outpost}${p.keep ? ", keep: true" : ""} },`,
      );
    }
    lines.push("    ],");
    lines.push(
      `    morphs: { ${t.morphs.map(([c, m]) => `${c}: { frames: ${m.frames}, period: ${m.period} }`).join(", ")} },`,
    );
    lines.push("    turretBases: [");
    for (const b of t.turretBases) {
      lines.push(
        `      { record: ${JSON.stringify(b.record)}, type: ${b.type}, side: ${b.side}, x: ${b.x}, y: ${b.y}, yaw: ${b.yaw} },`,
      );
    }
    lines.push("    ],");
    lines.push("    props: [");
    for (const p of t.props) {
      lines.push(
        `      { record: ${JSON.stringify(p.record)}, cobj: ${p.cobj}, x: ${p.x}, y: ${p.y}, h: ${p.h}, yaw: ${p.yaw}, pitch: ${p.pitch}, roll: ${p.roll}, scale: [${p.scale.join(", ")}], spin: ${p.spin}, swing: ${p.swing}, park: ${p.park}, anim: ${JSON.stringify(p.anim)}, period: ${p.period}, sound: ${p.sound}, quad: ${p.quad}, leaf: ${p.leaf} },`,
      );
    }
    lines.push("    ],");
    lines.push(
      `    propModels: { ${t.propModels.map(([c, m]) => `${c}: { frames: ${m.frames}, drawn: ${m.drawn}, centre: [${m.centre.join(", ")}] }`).join(", ")} },`,
    );
    lines.push("    leafTrees: [");
    for (const l of t.leafTrees) {
      lines.push(`      { cz: ${l.cz}, cx: ${l.cx}, spheres: [${l.spheres.join(", ")}] },`);
    }
    lines.push("    ],");
    lines.push("    quads: [");
    for (const q of t.quads) {
      lines.push(
        `      { record: ${JSON.stringify(q.record)}, decal: ${q.decal}, x: ${q.x}, y: ${q.y}, h: ${q.h}, yaw: ${q.yaw}, pitch: ${q.pitch}, roll: ${q.roll}, halfX: ${q.halfX}, halfZ: ${q.halfZ}, tint: [${q.tint.join(", ")}], blend: ${q.blend}, twoSided: ${q.twoSided} },`,
      );
    }
    lines.push("    ],");
    lines.push(
      `    decals: { ${t.decals.map(([id, d]) => `${id}: { file: ${JSON.stringify(d.file)}, w: ${d.w}, h: ${d.h} }`).join(", ")} },`,
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
  const reRepo = requireReRepo();
  const check = process.argv.includes("--check");
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  let stale = 0;
  const records = readRecords(
    reRepo,
    FCOP_ARENAS.map((a) => a.mission),
  );
  const empty: MissionRecords = {
    props: [],
    turrets: [],
    props96: [],
    quads: [],
    rects: [],
    trees: {},
  };
  const own = (mission: string): MissionRecords => records[mission] ?? empty;
  /** Copies `from` to `to`, or under --check counts it stale where they differ. */
  const copy = (from: string, to: string): void => {
    if (!check) {
      copyFileSync(from, to);
      return;
    }
    if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) {
      console.log(`${to} is not ${from}`);
      stale++;
    }
  };
  for (const arena of selectArenas(positional || "all")) {
    const scenery = ARENA_SCENERY.find((a) => a.mapId === arena.mapId);
    if (!scenery) throw new Error(`${arena.mapId}: no ARENA_SCENERY entry`);
    if (scenery.mission !== arena.mission) {
      throw new Error(`${arena.mapId}: scenery says ${scenery.mission}, arena is ${arena.mission}`);
    }
    const src = join(reRepo, "extracted", "objects", arena.mission);
    const out = join(RAW_DIR, "fcop-props", arena.mission);
    const decals = join(DECAL_DIR, arena.mapId);
    if (!check) {
      for (const dir of [out, decals]) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
      }
    }
    // The type-11 models ARENA_SCENERY lists, and every type-96 model drawn.
    const t = arenaTable(arena, own(arena.mission), reRepo);
    const props96 = t.propModels.filter(([, m]) => m.drawn).map(([c]) => c);
    for (const cobj of [...scenery.props.map(([c]) => c), ...props96]) {
      const name = `obj_${String(cobj).padStart(3, "0")}.glb`;
      copy(join(src, name), join(RAW_DIR, sceneryRaw(arena.mission, cobj)));
    }
    for (const [, d] of t.decals) {
      copy(join(reRepo, "extracted", "decals", d.from), join(decals, d.file));
    }
    console.log(
      `${arena.mapId} (${arena.mission}): ${scenery.props.map(([c]) => c).join(", ")}; ` +
        `Props ${props96.join(", ") || "none"}; decals ${t.decals.map(([id]) => id).join(", ") || "none"}` +
        (check ? " checked" : " copied"),
    );
  }

  const commit = Bun.spawnSync(["git", "-C", reRepo, "rev-parse", "--short", "HEAD"]);
  const reCommit = commit.exitCode === 0 ? commit.stdout.toString().trim() : "unknown";
  const tables = FCOP_ARENAS.map(
    (a) => [a.mapId, arenaTable(a, own(a.mission), reRepo)] as [string, ArenaTable],
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
        `${shows("claimed")} once claimed), morphs ${t.morphs.map(([c]) => c).join(", ") || "none"}, ` +
        `${t.turretBases.length} turret bases, ${t.props.length} Props, ${t.quads.length} DCSQuads`,
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
