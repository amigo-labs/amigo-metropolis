// Import the original's presentation data — the chase cameras, the head-up
// display, the radar and the map screen — from a checkout of the RE repo
// (amigo-labs/fcop-reverse-engineering).
//
//   extracted/presentation/camera.json   presets, camera lists, the seven names,
//                                        the steady-state eyes (tests), caption,
//                                        projection
//   extracted/presentation/hud.json      positions, atlas rects, palettes
//   extracted/presentation/radar_markers.json
//                                        the marker byte of every PA actor, per
//                                        arena: which units carry which, and the
//                                        static markers Metropolis has no entity for
//   extracted/fonts/font3.{png,json}     the HUD's font at 640 x 480
//   extracted/textures/GlblData/tex11.png
//                                        the weapon icons, the badge, the radar disc
//   extracted/textures/<Mission>/tex09.png
//                                        the lock reticle (16 x 16 at 0,210)
//   fixtures/missions/<Mission>          the type-35 objective record's eight
//                                        radar contacts (no export carries them yet)
//   fixtures/missions/<Mission>          the 3DBB boxes, frame by frame, of the
//                                        models the map screen draws an arrow
//                                        for (extracted/objects/<Mission>/
//                                        manifest.json checks frame 0)
//
//     -> packages/client/public/hud/{font3.png,tex11.png,reticles.png}
//     -> packages/client/src/render/fcopPresentation.generated.ts
//
// The PNGs are the original's texels; the only change is that pure black, the
// original's transparent texel, gets alpha 0 (tex11, the reticles). The font is
// copied byte for byte.
//
// Usage: bun run gen:presentation --re ../fcop-reverse-engineering
// Authoring-time only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCENERY_PLACEMENTS } from "../../packages/client/src/render/arenaScenery.generated";
import { FCOP_ARENAS } from "./fcopArenas";
import { decodePng, encodePng } from "./png";

const ROOT = join(import.meta.dir, "..", "..");
const PUBLIC_HUD = join(ROOT, "packages", "client", "public", "hud");
const OUT_TS = join(ROOT, "packages", "client", "src", "render", "fcopPresentation.generated.ts");
/** actors.json frame -> Metropolis map frame (enrichArena.ts LOGIC_OFFSET_X / _Z). */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const reArg = argValue("--re") ?? process.env.FCOP_RE_REPO;
if (!reArg) {
  console.error("usage: bun run gen:presentation --re <RE checkout> [--check]");
  process.exit(2);
}
/** --check: regenerate in memory and fail when a committed file differs. */
const CHECK = process.argv.includes("--check");
const stale: string[] = [];
/** Write `bytes` to `path`, or, with --check, note it when the committed file differs. */
function emit(path: string, bytes: Uint8Array): void {
  if (!CHECK) {
    writeFileSync(path, bytes);
    return;
  }
  const was = existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  if (!was || was.length !== bytes.length || was.some((b, i) => b !== bytes[i])) stale.push(path);
}
const RE = resolve(reArg);
const readJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(RE, ...p), "utf8")) as T;

const reCommit = (() => {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: RE });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
})();

// --- camera.json -------------------------------------------------------------

interface CameraJson {
  presets: { index: number; yaw_delta: number; pitch: number; height: number; offset: number[] }[];
  camera_lists: { bytes: number[] }[];
  entries: {
    index: number;
    list_row: number;
    flags: number;
    name: string | null;
  }[];
  camera_names: string[];
  cameras: {
    camera_name: number;
    name: string;
    available_in_pa: boolean;
    steady_state_walker_subject_y0: { eye: number[]; aim_point: number[] };
  }[];
  caption: { ticks: number; position_text320: number[]; colour: number };
  projection: { hfov_deg: number; vfov_deg: number };
}
const camera = readJson<CameraJson>("extracted", "presentation", "camera.json");

// --- hud.json ----------------------------------------------------------------

type Rect = [number, number, number, number];
interface Icon {
  u: number;
  v: number;
  w: number;
  h: number;
}
interface GaugeJson {
  backing_rect640: Rect;
  ticks_rect640: Rect[];
}
interface HudJson {
  font: { at_640x480: { max_glyph_height_px: number } };
  text_colours: { palettes: { rgb: number[] }[] };
  lock: {
    reticle: { u: number; v: number; w: number; h: number; size_px640: number };
    beam: { colour: number[] };
  };
  weapons: {
    slots: {
      icon: Icon;
      icon_box_px640: Rect;
      lower_count_px640: number[];
      upper_count_px640: number[];
    }[];
    extra_icons: { icon: Icon; box_px640: Rect }[];
    lower_count: { colour: number };
    upper_count: { colour_blink: number[] };
    icon_tint: { unlit: number[]; lit: number[] };
  };
  armour_gauge: {
    own: GaugeJson;
    invulnerable_blink: { gauge: GaugeJson; colour: number[] };
    opponent_gauge: { gauge: GaugeJson };
    backing: { colour: { rgb: number[] } };
    ticks: { colour: { rgb: number[] } };
  };
  score: {
    plate_rect640: Rect;
    plate_rect640_four_digits: Rect;
    text_px640: number[];
    text320_four_digits: number[];
    colour: { slot0: number; slot1: number; alarm: number };
    plate: { colour: { rgb: number[] } };
  };
  counts: { plate_rect640: Rect; text_px640: number[] };
  opponent_row: {
    score_plate_rect640: Rect;
    score_text_px640: number[];
    counts_plate_rect640: Rect;
    counts_text_px640: number[];
  };
  level_caption: { text_px640: number[]; colour: number };
  radar: {
    disc: {
      uv: { u0: number; v0: number; u1: number; v1: number };
      box_px640: Rect;
      centre_px640: number[];
    };
    range: { value: number };
    rotation: { scale_px_per_wu: number };
    rim: {
      tick: { inner_radius_px640: number; outer_radius_px640: number };
      white_tick: { colour: number[] };
      contact_arrows: { shape_radial_tangential: number[][] };
    };
    palette: { entries: { index: number; rgb: number[] | null; blinks?: boolean }[] };
  };
  pause_map: {
    pan: { rate_max: number };
    terrain_window: { samples_z: number; samples_x: number; px_per_sample_640: number };
    overview_54: {
      frame_rects_rect640: Rect[];
      border: { rgb: number[] };
      fill: { rgb: number[] };
      window_frame: { colour: { rgb: number[] } };
    };
  };
}
const hud = readJson<HudJson>("extracted", "presentation", "hud.json");

// --- radar_markers.json --------------------------------------------------------

interface MarkerActor {
  actor_id: number;
  resource: string;
  type: number;
  side_byte24: number;
  group_byte25: number;
  marker: number;
  kind: number;
  becomes_live_actor: boolean;
  on_radar_when_live: boolean;
  x: number;
  z: number;
  capture_markers?: { marker_if_team_a_captures: number; marker_if_team_b_captures: number };
}
interface MarkersJson {
  arenas: Record<
    string,
    {
      actors: MarkerActor[];
      claim_orders: { target: number; marker: number }[];
    }
  >;
}
const markers = readJson<MarkersJson>("extracted", "presentation", "radar_markers.json");

/** The marker a unit kind carries per side, checked identical on all six arenas. */
interface UnitMarkers {
  avatar: [number, number];
  captain: number;
  tank: [number, number];
  jet: [number, number];
  fortress: [number, number];
  dreadnought: [number, number];
  turret: [number, number];
  neutralTurret: number;
  capturedTurret: [number, number];
  pickup: number;
}

function sideMarker(
  actors: MarkerActor[],
  pick: (a: MarkerActor) => boolean,
  side: number,
): number {
  const set = new Set(actors.filter((a) => pick(a) && a.side_byte24 === side).map((a) => a.marker));
  if (set.size !== 1) throw new Error(`side ${side}: ${set.size} markers (${[...set]})`);
  return [...set][0];
}

function oneMarker(actors: MarkerActor[], pick: (a: MarkerActor) => boolean): number {
  const set = new Set(actors.filter(pick).map((a) => a.marker));
  if (set.size !== 1) throw new Error(`${set.size} markers (${[...set]})`);
  return [...set][0];
}

function unitMarkersOf(actors: MarkerActor[]): UnitMarkers {
  const csac = (type: number, kind?: number) => (a: MarkerActor) =>
    a.resource === "Csac" && a.type === type && (kind === undefined || a.kind === kind);
  const neutral = actors.filter(csac(36));
  const cap = new Set(
    neutral.map(
      (a) =>
        `${a.capture_markers?.marker_if_team_a_captures},${a.capture_markers?.marker_if_team_b_captures}`,
    ),
  );
  if (cap.size !== 1) throw new Error(`neutral turret capture markers differ: ${[...cap]}`);
  const [capA, capB] = [...cap][0].split(",").map(Number);
  return {
    avatar: [
      sideMarker(actors, (a) => a.resource === "Cact" && a.type === 1, 1),
      sideMarker(actors, (a) => a.resource === "Cact" && a.type === 1, 2),
    ],
    captain: oneMarker(actors, (a) => a.resource === "Cact" && a.type === 37),
    tank: [sideMarker(actors, csac(5), 1), sideMarker(actors, csac(5), 2)],
    // Type 9 is every aircraft: the jets are the sprites, the one diamond per side
    // is the Flying Fortress (its spawner; radar_markers.json summary).
    jet: [sideMarker(actors, csac(9, 0), 1), sideMarker(actors, csac(9, 0), 2)],
    fortress: [sideMarker(actors, csac(9, 2), 1), sideMarker(actors, csac(9, 2), 2)],
    dreadnought: [sideMarker(actors, csac(28), 1), sideMarker(actors, csac(28), 2)],
    turret: [sideMarker(actors, csac(8), 1), sideMarker(actors, csac(8), 2)],
    neutralTurret: oneMarker(actors, csac(36)),
    capturedTurret: [capA, capB],
    pickup: oneMarker(actors, csac(16)),
  };
}

// --- the type-35 objective record (fixtures/missions/<Mission>) ---------------

interface Contact {
  shown: number;
  colour: number;
  x: number;
  y: number;
}

/**
 * The radar contacts of the one type-35 actor of a PA mission: its payload's
 * shown word (+0x24), eight colour bytes and eight {z, x} halfwords << 9
 * (`objective_construct`, RE disasm/map-open.md M3-MS; `hud_radar_contacts`).
 * Read through the RE's own container walker (tools/gfx/fcop.py).
 */
function contactsOf(mission: string): Contact[] {
  const script = [
    "import sys, struct, json",
    `sys.path.insert(0, ${JSON.stringify(join(RE, "tools", "gfx"))})`,
    "from fcop import extract, parse",
    `b, res = parse(${JSON.stringify(join(RE, "fixtures", "missions", mission))})`,
    "out = []",
    "for r in res:",
    "    if r['type'] != 'Cact': continue",
    "    p = extract(b, r)",
    "    if p[0:4] != b'TCAt' or p[12] != 35: continue",
    "    pay = p[12:]",
    "    shown = struct.unpack_from('<I', pay, 0x24)[0]",
    "    cols = list(pay[0x28:0x30])",
    "    at = [list(struct.unpack_from('<2h', pay, 0x30 + 4 * i)) for i in range(8)]",
    "    out.append({'shown': shown, 'colours': cols, 'at': at})",
    "print(json.dumps(out))",
  ].join("\n");
  const r = Bun.spawnSync(["python3", "-I", "-c", script]);
  if (r.exitCode !== 0) throw new Error(`${mission}: type-35 read failed: ${r.stderr.toString()}`);
  const recs = JSON.parse(r.stdout.toString()) as {
    shown: number;
    colours: number[];
    at: [number, number][];
  }[];
  if (recs.length !== 1) throw new Error(`${mission}: ${recs.length} type-35 records, expected 1`);
  const rec = recs[0];
  const out: Contact[] = [];
  for (let i = 0; i < 8; i++) {
    const shown = (rec.shown >>> (3 * i)) & 7;
    if (shown === 0) continue;
    // Halfword 0 is position[2] (actors.json x), halfword 1 position[0] (z).
    const [hz, hx] = rec.at[i];
    out.push({
      shown,
      colour: rec.colours[i] & 0x1f,
      x: round4((hz * 512) / 8192 + LOGIC_OFFSET_X),
      y: round4((hx * 512) / 8192 + LOGIC_OFFSET_Z),
    });
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// --- the live list at load (fixtures/missions/<Mission>) -----------------------

/** One Cact or Csac record, read as `cact_base_construct` reads it. */
interface ActorRecord {
  res: "Cact" | "Csac";
  id: number;
  /** tACT payload +0. */
  type: number;
  /** position[0..2], world units: [0] is the map's y, [2] its x. */
  pos: [number, number, number];
  /** Payload +16, the flags word. */
  flags: number;
  /** Payload +24: the side (1 or 2, 0 nobody's). */
  side: number;
  /** Payload +25: a Csac's spawn class (1 tank, 2 jet, 3 Dreadnought, 4 Fortress). */
  cls: number;
  /** The Cobj ids of the aRSL list, in order, 0 for an empty entry. */
  arsl: number[];
}

/**
 * Every Cact and Csac record of a mission in container order — the order the
 * streaming hands them to `cact_load` (RE game/res/stream.c, a FIFO) — through
 * the RE's own container walker (tools/gfx/fcop.py).
 */
function actorRecordsOf(mission: string): ActorRecord[] {
  const script = [
    "import sys, struct, json",
    `sys.path.insert(0, ${JSON.stringify(join(RE, "tools", "gfx"))})`,
    "from fcop import extract, parse",
    `b, res = parse(${JSON.stringify(join(RE, "fixtures", "missions", mission))})`,
    "out = []",
    "for r in res:",
    "    if r['type'] not in ('Cact', 'Csac'): continue",
    "    p = extract(b, r)",
    "    if p[0:4] != b'TCAt': continue",
    "    pay = p[12:]",
    "    arsl = []",
    "    at = p.find(b'LSRa')",
    "    if at >= 0:",
    "        n = (struct.unpack_from('<I', p, at + 4)[0] - 12) // 8",
    "        arsl = [struct.unpack_from('<II', p, at + 12 + 8 * i)[1] for i in range(n)]",
    "    out.append({'res': r['type'], 'id': r['id'], 'type': pay[0],",
    "                'pos': list(struct.unpack_from('<3i', pay, 4)),",
    "                'flags': struct.unpack_from('<I', pay, 16)[0], 'side': pay[24], 'cls': pay[25],",
    "                'arsl': arsl})",
    "print(json.dumps(out))",
  ].join("\n");
  const r = Bun.spawnSync(["python3", "-I", "-c", script]);
  if (r.exitCode !== 0) throw new Error(`${mission}: actor records: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString()) as ActorRecord[];
}

/**
 * `cact_type_handler` (RE game/actor/factory.c 0x0041a950): the types the
 * factory builds. Any other type below 87 has no handler and `cact_create`
 * builds nothing; 87..99 go to loaders of their own and build no actor
 * (`cact_load` 0x0043af20).
 */
const HANDLED_TYPES = new Set([
  1, 5, 6, 8, 9, 10, 11, 12, 13, 14, 16, 20, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
  0x50,
]);
/** The registry's never-culled bit (`MISSION_FLAG_NO_CULL`, mission_frame.c 0x0043b5fb). */
const FLAG_NO_CULL = 8;
/** The X1-Alpha's construct sets it on the mech and its partner (`PLAYER_FLAGS_BOTH`, player.c 0x00446b44). */
const TYPE_X1 = 1;
/** `OBJECTIVE_FLAGS_SET` 0x20000d, ORed in by `objective_construct` (0x0043102f): bit 8 among them. */
const TYPE_OBJECTIVE = 35;
const OBJECTIVE_FLAGS_SET = 0x20000d;
/** One Sky Captain record per level band, each behind its own load gate. */
const TYPE_CAPTAIN = 37;
const TYPE_PLACED = 11;

/** One actor of the live list at load, in the order `cact_link` appended it. */
interface LoadActor {
  /**
   * `x1` the X1-Alpha of `side`, `partner` its type-0x12 partner, `captain` the
   * Sky Captain, `placed` a type-11 record (`record`, a scenery placement),
   * `fixed` any other actor, standing where its record puts it.
   */
  kind: "x1" | "partner" | "captain" | "placed" | "fixed";
  type: number;
  x: number;
  y: number;
  noCull: boolean;
  side?: number;
  record?: string;
  levels?: number[];
}

interface Spawned {
  noCull: {
    tank: boolean;
    jet: boolean;
    fortress: boolean;
    dreadnought: boolean;
    turret: boolean;
    neutralTurret: boolean;
    pickup: boolean;
  };
  turretParts: number;
  dreadnoughtMounts: number;
}

/**
 * The live list a mission starts with, and what its spawned actors bring.
 *
 * `cact_link` (0x0043ad70) appends at the tail, so the list is in creation
 * order (RE disasm/map-done.md; game/actor/factory.c). At load that is the
 * container order of the Cact records the factory builds — every PA one with an
 * empty load gate, but for the second X1 (the two-player game's) and the Sky
 * Captain (one record per level band, one player). A construct that builds an
 * actor of its own builds it before its own `cact_link`: the X1's partner
 * (`player_partner_create`, from `player_construct` 0x00446b25) stands in front
 * of its X1. The flags are the record's (`cact_base_construct` 0x0041a530);
 * the X1 and its partner get 8 (`PLAYER_FLAGS_BOTH`), the objective 8 with
 * `OBJECTIVE_FLAGS_SET`.
 */
function liveListOf(
  mission: string,
  recs: ActorRecord[],
  placements: readonly { record: string }[],
): { loadActors: LoadActor[]; spawned: Spawned } {
  // The Sky Captain's records and the levels each one's load gate passes
  // (tools/gfx/pa_models.py reads the gates: `(viewports == 1) && (level ...)`).
  const pa = readJson<{
    roles: { sky_captain: { templates: { res: string; id: number }[]; levels: number[] }[] };
  }>("extracted", "logic", mission, "pa_models.json");
  const captainLevels = new Map<number, number[]>();
  for (const c of pa.roles.sky_captain) {
    for (const t of c.templates) if (t.res === "Cact") captainLevels.set(t.id, c.levels);
  }
  const at = (r: ActorRecord) => ({
    x: round4(r.pos[2] / 8192 + LOGIC_OFFSET_X),
    y: round4(r.pos[0] / 8192 + LOGIC_OFFSET_Z),
  });
  const loadActors: LoadActor[] = [];
  for (const r of recs) {
    if (r.res !== "Cact" || !HANDLED_TYPES.has(r.type)) continue;
    const p = at(r);
    if (r.type === TYPE_X1) {
      const side = r.side;
      loadActors.push({ kind: "partner", type: 0x12, ...p, noCull: true, side });
      loadActors.push({ kind: "x1", type: TYPE_X1, ...p, noCull: true, side });
      continue;
    }
    if (r.type === TYPE_CAPTAIN) {
      // The load gate of each passes one level band (pa_models.json).
      const levels = captainLevels.get(r.id);
      if (!levels) throw new Error(`${mission}: Cact ${r.id}, a Sky Captain, has no level band`);
      loadActors.push({
        kind: "captain",
        type: r.type,
        ...p,
        noCull: (r.flags & FLAG_NO_CULL) !== 0,
        levels,
      });
      continue;
    }
    if ([6, 8, 20, 28, 30, 33, 36].includes(r.type)) {
      // Their constructs build parts and mounts of their own; no PA mission
      // places one.
      throw new Error(`${mission}: Cact ${r.id} is a type ${r.type}, which builds sub-actors`);
    }
    const flags = r.type === TYPE_OBJECTIVE ? r.flags | OBJECTIVE_FLAGS_SET : r.flags;
    if (r.type === TYPE_PLACED) {
      const record = `Cact ${r.id}`;
      if (!placements.some((q) => q.record === record)) {
        throw new Error(`${mission}: ${record} is no scenery placement`);
      }
      loadActors.push({
        kind: "placed",
        type: r.type,
        ...p,
        noCull: (flags & FLAG_NO_CULL) !== 0,
        record,
      });
      continue;
    }
    loadActors.push({ kind: "fixed", type: r.type, ...p, noCull: (flags & FLAG_NO_CULL) !== 0 });
  }

  // The spawned kinds: their Csac records' flag 8, which their constructs keep
  // (type 5 and 9 add bits, `turret_construct` adds 0x800000).
  const flagOf = (what: string, pick: (r: ActorRecord) => boolean): boolean => {
    const set = new Set(recs.filter((r) => r.res === "Csac" && pick(r)).map((r) => r.flags & 8));
    if (set.size !== 1) throw new Error(`${mission}: ${what}: flag 8 is ${[...set]}`);
    return [...set][0] !== 0;
  };
  for (const r of recs) {
    if (r.res === "Csac" && r.type === TYPE_PLACED && (r.flags & FLAG_NO_CULL) !== 0) {
      // The client culls every spawned type-11 actor (liveList.ts).
      throw new Error(`${mission}: Csac ${r.id}, a type-11 template, is never culled`);
    }
    if ([6, 30, 33].includes(r.type)) {
      throw new Error(`${mission}: ${r.res} ${r.id} is a type-${r.type} turret`);
    }
  }
  // cact_handler_type28 (mount.c 0x00426080): a mount per non-empty aRSL entry 3..6.
  const mounts = new Set(
    recs
      .filter((r) => r.res === "Csac" && r.type === 28)
      .map((r) => [3, 4, 5, 6].filter((k) => (r.arsl[k] ?? 0) !== 0).length),
  );
  if (mounts.size !== 1) throw new Error(`${mission}: Dreadnought mounts ${[...mounts]}`);
  const spawned: Spawned = {
    noCull: {
      tank: flagOf("tanks", (r) => r.type === 5 && r.cls === 1),
      jet: flagOf("jets", (r) => r.type === 9 && r.cls === 2),
      fortress: flagOf("Fortresses", (r) => r.type === 9 && r.cls === 4),
      dreadnought: flagOf("Dreadnoughts", (r) => r.type === 28),
      turret: flagOf("turrets", (r) => r.type === 8),
      neutralTurret: flagOf("neutral turrets", (r) => r.type === 36),
      pickup: flagOf("pickups", (r) => r.type === 16),
    },
    // turret_construct (turret.c 0x0041bf90): types 8 and 36 build one base part.
    turretParts: 1,
    dreadnoughtMounts: [...mounts][0],
  };
  return { loadActors, spawned };
}

// --- per arena -----------------------------------------------------------------

interface ArenaOut {
  mission: string;
  team0Side: number;
  reticle: number;
  contacts: Contact[];
  staticMarkers: { record: string; marker: number; x: number; y: number }[];
  claimMarkers: { record: string; x: number; y: number; markers: [number, number] }[];
  boxes: Record<number, Box[]>;
  loadActors: LoadActor[];
  spawned: Spawned;
}

/** A 3DBB box as the arrow reads it: centre x and z, half x and z, metres. */
type Box = [number, number, number, number];

interface ObjectManifestEntry {
  id: number;
  bbox: { center: [number, number, number]; half: [number, number, number] } | null;
}

/**
 * Every 3DBB entry of each model in `cobjs`, read out of the mission's Cobj
 * resources: the pause map's arrow takes box 0 of the actor's current frame,
 * `cobj_bbox_frame_box` = the table + 8 + frame x 16 (RE game/object/model.c,
 * pause_map.c 0x004516e0), so entry f is frame f's (f below the 4DGI frame
 * count). [cx, cz, lx, lz] in metres (a halfword is 16 world units, 1/512 m),
 * the Cobj's own x; a model whose frames' boxes are all alike keeps one. Frame 0 is checked against the manifest's
 * box (tools/gfx/obj_mesh.py parse_3dbb, x negated for the glb).
 */
function modelBoxes(mission: string, cobjs: Iterable<number>): ArenaOut["boxes"] {
  const ids = [...new Set(cobjs)].sort((a, b) => a - b);
  const script = [
    "import sys, struct, json",
    `sys.path.insert(0, ${JSON.stringify(join(RE, "tools", "gfx"))})`,
    "from fcop import extract, parse",
    `b, res = parse(${JSON.stringify(join(RE, "fixtures", "missions", mission))})`,
    `want = set(${JSON.stringify(ids)})`,
    "out = {}",
    "for r in res:",
    "    if r['type'] != 'Cobj' or r['id'] not in want: continue",
    "    p = extract(b, r)",
    "    at = 0",
    "    frames = 1",
    "    boxes = None",
    "    while at + 8 <= len(p):",
    "        size = struct.unpack_from('<I', p, at + 4)[0]",
    "        if size < 8 or at + size > len(p): break",
    "        if p[at:at + 4] == b'IGD4':",
    "            frames = max(1, struct.unpack_from('<H', p, at + 12)[0])",
    "        if p[at:at + 4] == b'BBD3':",
    "            amount = struct.unpack_from('<I', p, at + 12)[0]",
    "            boxes = [list(struct.unpack_from('<3h3H', p, at + 16 + 16 * i)) for i in range(amount)]",
    "        at += size",
    "    if boxes is not None: out[r['id']] = {'frames': frames, 'boxes': boxes}",
    "print(json.dumps(out))",
  ].join("\n");
  const r = Bun.spawnSync(["python3", "-I", "-c", script]);
  if (r.exitCode !== 0) throw new Error(`${mission}: 3DBB read failed: ${r.stderr.toString()}`);
  const raw = JSON.parse(r.stdout.toString()) as Record<
    string,
    { frames: number; boxes: number[][] }
  >;
  const manifest = readJson<ObjectManifestEntry[]>(
    "extracted",
    "objects",
    mission,
    "manifest.json",
  );
  const out: ArenaOut["boxes"] = {};
  const m = (v: number) => round4(v / 512);
  for (const id of ids) {
    const read = raw[id];
    // Entry f for frame f, over the model's frames (4DGI): past them the table
    // holds the frames' further boxes (Cobj 28's pole, box 1).
    const entries = read?.boxes.slice(0, read.frames) ?? [];
    if (entries.length === 0) throw new Error(`${mission}: Cobj ${id} has no 3DBB box`);
    if (entries.length !== read.frames) {
      throw new Error(`${mission}: Cobj ${id}: ${entries.length} boxes for ${read.frames} frames`);
    }
    const frames = entries.map((e) => [m(e[0]), m(e[2]), m(e[3]), m(e[5])] as Box);
    const bb = manifest.find((o) => o.id === id)?.bbox;
    const f0 = bb
      ? [round4(-bb.center[0] + 0), round4(bb.center[2]), round4(bb.half[0]), round4(bb.half[2])]
      : null;
    if (!f0 || f0.some((v, i) => v !== frames[0][i])) {
      throw new Error(
        `${mission}: Cobj ${id}'s frame-0 box ${frames[0]} is not the manifest's ${f0}`,
      );
    }
    const alike = frames.every((f) => f.every((v, i) => v === frames[0][i]));
    out[id] = alike ? [frames[0]] : frames;
  }
  return out;
}

let unitMarkers: UnitMarkers | null = null;
const arenas: Record<string, ArenaOut> = {};
FCOP_ARENAS.forEach((arena, reticleIndex) => {
  const m = markers.arenas[arena.mission];
  if (!m) throw new Error(`radar_markers.json has no ${arena.mission}`);
  const units = unitMarkersOf(m.actors);
  if (unitMarkers === null) unitMarkers = units;
  else if (JSON.stringify(unitMarkers) !== JSON.stringify(units)) {
    throw new Error(`${arena.mission}: unit markers differ from the first arena's`);
  }

  // Which original side Metropolis' team 0 holds: the X1Alpha record standing on
  // the map's spawn 0. Side 1 on every arena since SIM_VERSION 79, when
  // enrichArena.ts began ordering the teams by the original's player slot rather
  // than along the field axis (La Cantina's team 0 was side 2); render/sides.ts
  // is the identity on that, and this is the generator's check of it.
  const map = JSON.parse(
    readFileSync(join(ROOT, "packages", "sim", "maps", `${arena.mapId}.json`), "utf8"),
  ) as { spawns: { x: number; y: number }[] };
  const x1 = m.actors.filter((a) => a.resource === "Cact" && a.type === 1);
  const s0 = map.spawns[0];
  let best = x1[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const a of x1) {
    const d = Math.hypot(a.x + LOGIC_OFFSET_X - s0.x, a.z + LOGIC_OFFSET_Z - s0.y);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  if (bestD > 0.5) throw new Error(`${arena.mapId}: no X1Alpha on spawn 0 (nearest ${bestD} m)`);
  if (best.side_byte24 !== 1) {
    throw new Error(`${arena.mapId}: spawn 0's X1Alpha is side ${best.side_byte24}, not 1`);
  }

  // Placed actors that carry a marker and live, which Metropolis draws as no
  // entity: the outposts' green diamonds (their consoles). Types 87..99 build
  // no actor (`cact_load` 0x0043af20 hands each to a loader of its own and
  // returns, RE game/actor/load.c), so the export marks them not live (RE
  // b344262: the type-96 Props of Hk, Joke and Slim lost their markers); a
  // live one here would be an export regression.
  for (const a of m.actors) {
    if (a.resource === "Cact" && a.type >= 87 && a.type <= 99 && a.on_radar_when_live) {
      throw new Error(
        `${arena.mission}: Cact ${a.actor_id} (type ${a.type}) on the radar, but builds no actor`,
      );
    }
  }
  const staticMarkers = m.actors
    .filter(
      (a) =>
        a.resource === "Cact" &&
        a.on_radar_when_live &&
        a.type !== 1 && // the X1-Alpha: an entity
        a.type !== 37, // the Sky Captain: an entity
    )
    .map((a) => ({
      record: `Cact ${a.actor_id}`,
      marker: a.marker,
      x: round4(a.x + LOGIC_OFFSET_X),
      y: round4(a.z + LOGIC_OFFSET_Z),
    }));

  // The outposts' corner posts: marker 0 until the claim script of either side
  // posts its byte onto the group (order 0x3e on group byte 25).
  const claimMarkers: ArenaOut["claimMarkers"] = [];
  for (const a of m.actors) {
    if (a.resource !== "Cact" || a.type !== 11 || a.marker !== 0) continue;
    const posted = [
      ...new Set(m.claim_orders.filter((o) => o.target === a.group_byte25).map((o) => o.marker)),
    ].sort();
    if (posted.length === 0) continue;
    if (posted.length !== 2) throw new Error(`${arena.mission} group ${a.group_byte25}: ${posted}`);
    claimMarkers.push({
      record: `Cact ${a.actor_id}`,
      x: round4(a.x + LOGIC_OFFSET_X),
      y: round4(a.z + LOGIC_OFFSET_Z),
      markers: [posted[0], posted[1]],
    });
  }

  // The models the map screen draws an arrow for: the marked placed actors'
  // (by their scenery record) and the pickups'.
  const placements = SCENERY_PLACEMENTS[arena.mapId]?.placements ?? [];
  const cobjs: number[] = [];
  for (const r of [...staticMarkers, ...claimMarkers]) {
    const p = placements.find((q) => q.record === r.record);
    if (!p)
      throw new Error(`${arena.mapId}: ${r.record} carries a marker and is no scenery record`);
    cobjs.push(p.cobj);
  }
  const pickups = (map as unknown as { pickups?: { model?: number }[] }).pickups ?? [];
  for (const k of pickups) if (typeof k.model === "number" && k.model >= 0) cobjs.push(k.model);

  arenas[arena.mapId] = {
    mission: arena.mission,
    team0Side: best.side_byte24,
    reticle: reticleIndex,
    contacts: contactsOf(arena.mission),
    staticMarkers,
    claimMarkers,
    boxes: modelBoxes(arena.mission, cobjs),
    ...liveListOf(arena.mission, actorRecordsOf(arena.mission), placements),
  };
});

// --- images ----------------------------------------------------------------------

if (!CHECK) mkdirSync(PUBLIC_HUD, { recursive: true });

/** Black is the original's transparent texel: alpha 0, everything else opaque. */
function keyBlack(pixels: Uint8Array): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) pixels[i + 3] = 0;
  }
}

const tex11 = decodePng(
  new Uint8Array(readFileSync(join(RE, "extracted", "textures", "GlblData", "tex11.png"))),
);
const tex11Px = new Uint8Array(tex11.pixels);
keyBlack(tex11Px);
emit(join(PUBLIC_HUD, "tex11.png"), encodePng({ ...tex11, pixels: tex11Px }));

emit(
  join(PUBLIC_HUD, "font3.png"),
  new Uint8Array(readFileSync(join(RE, "extracted", "fonts", "font3.png"))),
);

const ret = hud.lock.reticle;
const strip = new Uint8Array(ret.w * FCOP_ARENAS.length * ret.h * 4);
FCOP_ARENAS.forEach((arena, k) => {
  const page = decodePng(
    new Uint8Array(readFileSync(join(RE, "extracted", "textures", arena.mission, "tex09.png"))),
  );
  for (let y = 0; y < ret.h; y++) {
    for (let x = 0; x < ret.w; x++) {
      const src = ((ret.v + y) * page.width + ret.u + x) * 4;
      const dst = (y * ret.w * FCOP_ARENAS.length + k * ret.w + x) * 4;
      strip.set(page.pixels.subarray(src, src + 4), dst);
    }
  }
});
keyBlack(strip);
emit(
  join(PUBLIC_HUD, "reticles.png"),
  encodePng({ width: ret.w * FCOP_ARENAS.length, height: ret.h, pixels: strip }),
);

// --- font3 -------------------------------------------------------------------------

const font = readJson<{
  glyphs: {
    ascii: number;
    atlas_x: number;
    atlas_y: number;
    width: number;
    height: number;
    advance: number;
    offset_x: number;
    offset_y: number;
  }[];
}>("extracted", "fonts", "font3.json");
const glyphRows: string[] = [];
for (let c = 32; c < 128; c++) {
  const g = font.glyphs.find((x) => x.ascii === c);
  glyphRows.push(
    g
      ? `[${g.atlas_x}, ${g.atlas_y}, ${g.width}, ${g.height}, ${g.advance}, ${g.offset_x}, ${g.offset_y}]`
      : "null",
  );
}

// --- emit ------------------------------------------------------------------------

const j = (v: unknown): string => JSON.stringify(v);
const w = hud.weapons;
const ag = hud.armour_gauge;
const radar = hud.radar;
const pm = hud.pause_map;
const units = unitMarkers as unknown as UnitMarkers;

const ts = `// GENERATED by tools/generators/importFcopPresentation.ts — do not edit by hand.
// Re-run \`bun run gen:presentation --re <RE checkout>\`.
//
// The original's presentation, from amigo-labs/fcop-reverse-engineering
// @ ${reCommit}: extracted/presentation/camera.json, hud.json and
// radar_markers.json (tools/logic/presentation_data.py, every value cited there to
// the decompiled C), extracted/fonts/font3.json, and each PA mission's type-35
// objective record. Positions are in the Metropolis map frame (actors.json x + ${LOGIC_OFFSET_X}).

/** The RE commit the tables were read at. */
export const PRESENTATION_RE_COMMIT = ${j(reCommit)};

// --- cameras (camera.json) -----------------------------------------------------

/** A chase preset: yaw delta and pitch (4096 a turn), plane height and offset (world units). */
export interface ChasePreset {
  readonly yawDelta: number;
  readonly pitch: number;
  /** The preset's height column (the pitch curve's for 0-8; the occlusion probes read it). */
  readonly height: number;
  readonly offset: readonly [number, number, number];
}

/** The nineteen presets at 0x0048c2a8 (view_place.c view_presets). */
export const CHASE_PRESETS: readonly ChasePreset[] = [
${camera.presets.map((p) => `  { yawDelta: ${p.yaw_delta}, pitch: ${p.pitch}, height: ${p.height}, offset: ${j(p.offset)} },`).join("\n")}
];

/** The eight camera-list rows (byte 1 the primary, then fallbacks, -1 ends a row). */
export const CHASE_LISTS: readonly (readonly number[])[] = [
${camera.camera_lists.map((l) => `  ${j(l.bytes)},`).join("\n")}
];

/** A camera entry: its flag word (bit 0 close, 1 side, 2 occlude, 3 closer) and list row. */
export interface ChaseEntry {
  readonly flags: number;
  readonly listRow: number;
}

/** The fifteen entries; the Camera Key cycles entries 0-6, the demo anchor the rest. */
export const CHASE_ENTRIES: readonly ChaseEntry[] = [
${camera.entries.map((e) => `  { flags: ${e.flags}, listRow: ${e.list_row} },`).join("\n")}
];

/** The names the caption shows, by camera (draw_camera_names). */
export const CAMERA_NAMES: readonly string[] = ${j(camera.camera_names)};

/** Whether the camera is reachable in Precinct Assault (5 and 6 need a volume trigger). */
export const CAMERA_IN_PA: readonly boolean[] = ${j(camera.cameras.map((c) => c.available_in_pa))};

/**
 * The converged eye and aim point per camera for a walker standing at height 0
 * facing yaw 0, relative to it, in world units, runtime frame (position[0],
 * position[1], position[2]). Floating point: the game's integers differ by a few units.
 */
export const CAMERA_STEADY_EYES: readonly {
  readonly eye: readonly [number, number, number];
  readonly aimPoint: readonly [number, number, number];
}[] = [
${camera.cameras.map((c) => `  { eye: ${j(c.steady_state_walker_subject_y0.eye)}, aimPoint: ${j(c.steady_state_walker_subject_y0.aim_point)} },`).join("\n")}
];

/** The camera caption: ticks shown, pen in 320 x 240 text space, text colour. */
export const CAMERA_CAPTION = {
  ticks: ${camera.caption.ticks},
  text320: ${j(camera.caption.position_text320)} as readonly [number, number],
  colour: ${camera.caption.colour},
} as const;

/** The original's software projection at 640 x 480 (focal 1024 px). */
export const CAMERA_PROJECTION = {
  hfovDeg: ${camera.projection.hfov_deg},
  vfovDeg: ${camera.projection.vfov_deg},
} as const;

// --- font 3 (the HUD's at 640 x 480) ------------------------------------------------

/**
 * Glyphs by char code - 32: [atlas x, atlas y, width, height, advance, offset x,
 * offset y], px at 640 x 480; null where the font has none.
 */
export const FONT3_GLYPHS: readonly (readonly number[] | null)[] = [
${glyphRows.map((r) => `  ${r},`).join("\n")}
];

/** The tallest glyph, px. */
export const FONT3_HEIGHT = ${hud.font.at_640x480.max_glyph_height_px};

/** The twenty text colours (entry 15 of each 16-step ramp), sRGB. */
export const TEXT_COLOURS: readonly (readonly [number, number, number])[] = ${j(hud.text_colours.palettes.map((p) => p.rgb))};

// --- the HUD (hud.json, px at 640 x 480) -------------------------------------------------

type R = readonly [number, number, number, number];
type P = readonly [number, number];

export const HUD = {
  weapons: [
${w.slots.map((s) => `    { icon: ${j([s.icon.u, s.icon.v, s.icon.w, s.icon.h])} as R, box: ${j(s.icon_box_px640)} as R, lower: ${j(s.lower_count_px640)} as P, upper: ${j(s.upper_count_px640)} as P },`).join("\n")}
  ],
  badge: {
    icon: ${j([w.extra_icons[0].icon.u, w.extra_icons[0].icon.v, w.extra_icons[0].icon.w, w.extra_icons[0].icon.h])} as R,
    own: ${j(w.extra_icons[0].box_px640)} as R,
    opponent: ${j(w.extra_icons[1].box_px640)} as R,
  },
  iconUnlit: ${j(w.icon_tint.unlit)} as readonly number[],
  iconLit: ${j(w.icon_tint.lit)} as readonly number[],
  lowerCountColour: ${w.lower_count.colour},
  upperCountColours: ${j(w.upper_count.colour_blink)} as P,
  gauge: {
    own: { backing: ${j(ag.own.backing_rect640)} as R, ticks: ${j(ag.own.ticks_rect640)} as readonly R[] },
    invulnerable: { backing: ${j(ag.invulnerable_blink.gauge.backing_rect640)} as R, ticks: ${j(ag.invulnerable_blink.gauge.ticks_rect640)} as readonly R[] },
    opponent: { backing: ${j(ag.opponent_gauge.gauge.backing_rect640)} as R, ticks: ${j(ag.opponent_gauge.gauge.ticks_rect640)} as readonly R[] },
    backingRgb: ${j(ag.backing.colour.rgb)} as readonly number[],
    tickRgb: ${j(ag.ticks.colour.rgb)} as readonly number[],
    invulnerableRgb: ${j(ag.invulnerable_blink.colour)} as readonly number[],
  },
  score: {
    plate: ${j(hud.score.plate_rect640)} as R,
    plate4: ${j(hud.score.plate_rect640_four_digits)} as R,
    text: ${j(hud.score.text_px640)} as P,
    text4: ${j([hud.score.text320_four_digits[0] * 2, hud.score.text320_four_digits[1] * 2])} as P,
    colours: ${j([hud.score.colour.slot0, hud.score.colour.slot1])} as P,
    alarm: ${hud.score.colour.alarm},
    plateRgb: ${j(hud.score.plate.colour.rgb)} as readonly number[],
  },
  counts: { plate: ${j(hud.counts.plate_rect640)} as R, text: ${j(hud.counts.text_px640)} as P },
  opponent: {
    scorePlate: ${j(hud.opponent_row.score_plate_rect640)} as R,
    scoreText: ${j(hud.opponent_row.score_text_px640)} as P,
    countsPlate: ${j(hud.opponent_row.counts_plate_rect640)} as R,
    countsText: ${j(hud.opponent_row.counts_text_px640)} as P,
  },
  level: { text: ${j(hud.level_caption.text_px640)} as P, colour: ${hud.level_caption.colour} },
  reticle: { size: ${hud.lock.reticle.size_px640}, texels: ${hud.lock.reticle.w} },
  beamRgb: ${j(hud.lock.beam.colour)} as readonly number[],
  radar: {
    disc: ${j([radar.disc.uv.u0, radar.disc.uv.v0, radar.disc.uv.u1 - radar.disc.uv.u0, radar.disc.uv.v1 - radar.disc.uv.v0])} as R,
    box: ${j(radar.disc.box_px640)} as R,
    centre: ${j(radar.disc.centre_px640)} as P,
    rangeWu: ${radar.range.value},
    pxPerWu: ${radar.rotation.scale_px_per_wu},
    tickInner: ${radar.rim.tick.inner_radius_px640},
    tickOuter: ${radar.rim.tick.outer_radius_px640},
    tickRgb: ${j(radar.rim.white_tick.colour)} as readonly number[],
    arrow: ${j(radar.rim.contact_arrows.shape_radial_tangential)} as readonly P[],
  },
  pauseMap: {
    samples: ${j([pm.terrain_window.samples_z, pm.terrain_window.samples_x])} as P,
    pxPerSample: ${pm.terrain_window.px_per_sample_640},
    panRateMax: ${pm.pan.rate_max},
    frame: ${j(pm.overview_54.frame_rects_rect640)} as readonly R[],
    borderRgb: ${j(pm.overview_54.border.rgb)} as readonly number[],
    fillRgb: ${j(pm.overview_54.fill.rgb)} as readonly number[],
    windowRgb: ${j(pm.overview_54.window_frame.colour.rgb)} as readonly number[],
  },
} as const;

/** The radar's 32 colours (index = marker & 0x1f), sRGB as they reach the screen; 0 none. */
export const RADAR_PALETTE: readonly (readonly [number, number, number] | null)[] = ${j(radar.palette.entries.map((e) => e.rgb))};

// --- markers (radar_markers.json) ----------------------------------------------------------

/** The marker byte each unit kind carries, [side 1, side 2] where it has a side. */
export const UNIT_MARKERS = {
  avatar: ${j(units.avatar)} as P,
  captain: ${units.captain},
  tank: ${j(units.tank)} as P,
  jet: ${j(units.jet)} as P,
  fortress: ${j(units.fortress)} as P,
  dreadnought: ${j(units.dreadnought)} as P,
  turret: ${j(units.turret)} as P,
  neutralTurret: ${units.neutralTurret},
  capturedTurret: ${j(units.capturedTurret)} as P,
  pickup: ${units.pickup},
} as const;

/** One arena's presentation data. */
export interface ArenaPresentation {
  /** The original mission. */
  readonly mission: string;
  /** The original side (1 red, 2 blue) whose X1-Alpha stands on the map's spawn 0: 1 on every arena. */
  readonly team0Side: 1 | 2;
  /** Column of reticles.png (16 px each). */
  readonly reticle: number;
  /** The type-35 record's contacts: shown bits (0 rim arrow, 1 map ring, 2 radar blip), palette index, m. */
  readonly contacts: readonly { readonly shown: number; readonly colour: number; readonly x: number; readonly y: number }[];
  /**
   * Placed actors with a marker that Metropolis has no entity for (the outposts'
   * consoles); \`record\` names their scenery placement (arenaScenery.generated.ts).
   */
  readonly staticMarkers: readonly { readonly record: string; readonly marker: number; readonly x: number; readonly y: number }[];
  /** The outposts' corner posts: [side 1's, side 2's] marker once claimed. */
  readonly claimMarkers: readonly { readonly record: string; readonly x: number; readonly y: number; readonly markers: P }[];
  /**
   * By Cobj, the 3DBB box the map screen's arrow is built on, one per frame (box 0
   * of the actor's current frame, pause_map.c 0x004516e0; one entry where every
   * frame's is alike): centre x and z, half x and z, metres in the model's frame.
   */
  readonly boxes: Readonly<Record<number, readonly (readonly [number, number, number, number])[]>>;
  /**
   * The live list at load, in the order \`cact_link\` appended it (creation order,
   * oldest first): the Cact records the factory builds in container order, an
   * X1's partner in front of its X1. Map frame metres; \`noCull\` is the flag-8
   * bit the registry never culls (render/hud/liveList.ts).
   */
  readonly loadActors: readonly LoadActor[];
  /** What the spawned actors bring: flag 8 by kind, a turret's parts, a Dreadnought's mounts. */
  readonly spawned: SpawnedActors;
}

/** One actor of the live list at load (\`ArenaPresentation.loadActors\`). */
export interface LoadActor {
  /**
   * \`x1\` the X1-Alpha of \`side\`, \`partner\` its type-0x12 partner, \`captain\` the Sky
   * Captain (the record of the level's band loads), \`placed\` a type-11 record (\`record\`,
   * its scenery placement), \`fixed\` any other actor, where its record stands.
   */
  readonly kind: "x1" | "partner" | "captain" | "placed" | "fixed";
  /** The original actor type (0x12 the partner). */
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly noCull: boolean;
  readonly side?: number;
  readonly record?: string;
  /** A Sky Captain record's level band: its load gate passes only these levels. */
  readonly levels?: readonly number[];
}

/** The spawned actors' share of the live list. */
export interface SpawnedActors {
  /** Never culled (their Csac records' flag 8), by kind. */
  readonly noCull: {
    readonly tank: boolean;
    readonly jet: boolean;
    readonly fortress: boolean;
    readonly dreadnought: boolean;
    readonly turret: boolean;
    readonly neutralTurret: boolean;
    readonly pickup: boolean;
  };
  /** The base part \`turret_construct\` builds in front of each turret. */
  readonly turretParts: number;
  /** The mounts \`cact_handler_type28\` builds in front of each Dreadnought. */
  readonly dreadnoughtMounts: number;
}

export const ARENA_PRESENTATION: Readonly<Record<string, ArenaPresentation>> = ${j(arenas)} as unknown as Readonly<Record<string, ArenaPresentation>>;
`;

// Formatted through biome's stdin, so --check compares what a write would leave.
const fmt = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${OUT_TS}`], {
  cwd: ROOT,
  stdin: new TextEncoder().encode(ts),
});
if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
emit(OUT_TS, new Uint8Array(fmt.stdout));
console.log(
  `importFcopPresentation: ${FCOP_ARENAS.length} arenas, RE ${reCommit.slice(0, 8)} -> ${OUT_TS}`,
);
if (CHECK) {
  for (const p of stale) console.error(`stale: ${p}`);
  if (stale.length > 0) process.exit(1);
  console.log("--check: every committed file matches");
}
