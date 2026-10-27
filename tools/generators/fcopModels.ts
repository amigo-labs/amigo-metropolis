// Reads what the sim needs from each Precinct Assault arena's MODELS out of the
// private RE repo and writes it into this repo as a committed, deterministic
// artifact (tools/generators/fcop/<mission>-models.json), next to the logic and
// rules extractions.
//
// The RE side (tools/gfx/pa_models.py -> extracted/logic/<Mission>/
// pa_models.json, docs/formats/pa-models.md) names the Cobj each role draws and
// carries what the glb does not: the attach points. The Dreadnought's gun i
// stands on its hull's attach point i (vertex 4DGI[0x30 + i], `mount.c`
// 526-546), turns `((word_48 << 8) / 218) >> 4` angle units per 1/300 s
// (`mount.c` 1136) and fires only inside its front sector (`discharge.c`
// 949-977); its round leaves from the gun model's own point 0. A hull that
// walks (Joke's, Cobj 35: 20 frames, one per 775 world units) carries its AnmD
// track and each point frame by frame: the gun stands on the point of the frame
// the hull shows (`mount.c` 1019-1030, `cact_model_point` on +0x70).
//
// And every role's hit radius: an actor's `radius_68` is the halfword at +12 of
// its model's 3DBB box for the frame it is on, << 4 world units
// (`cact_model_block_init` 0x00426e00, `cact_model_select` 0x004297e0), read
// here from the shipped Cobjs in the RE's fixtures/missions/<Mission> (no export
// carries the halfword; the bbox the exports give is the box's half extents).
//
//   bun run gen:pamodels [all | <mapId> | <Mission>] [--re-repo <path>]
//
// FRAME: every point is in its model's glb frame as the RE writes it (Cobj i16 /
// 512 with x negated, y up, +z forward, metres). The sim turns it into the hull's
// frame (map.ts MapGunMount). Authoring-time only: enrichArena.ts is the reader.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { UNIT_MODEL_FILES } from "../../packages/client/src/render/arenaUnits.generated";
import { type FcopArena, logicFile, modelsFile, selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";
import { requireReRepo } from "./reRepo";

const REPO_ROOT = join(import.meta.dir, "..", "..");

interface ReGunSide {
  shooter: { weapon_id: number; front_sector_only: boolean };
  word_48: number;
  home_yaw_word_4a: number;
  mount_flags: number;
  turn_rate_per_tick: number;
}
interface ReGun {
  gun: number;
  cobj: number;
  point_index: number;
  hull_point: { index: number; vertex: number; glb_xyz: number[]; by_frame?: number[][] };
  by_side: Record<string, ReGunSide>;
}
interface RePart {
  part: string;
  cobj: number;
}
interface ReRole {
  parts: RePart[];
  templates?: { res: string; id: number }[];
  levels?: number[];
  /** A turret's: its base's attach point 0, where the gun stands (turret.c 913-918). */
  gun_point?: { index: number; glb_xyz: number[] };
}
interface ReModels {
  roles: {
    dreadnought: { parts: RePart[]; guns: ReGun[] }[];
    x1alpha: ReRole[];
    tank: ReRole[];
    jet: ReRole[];
    flying_fortress: ReRole[];
    base_turret: ReRole[];
    neutral_turret: ReRole[];
    sky_captain: ReRole[];
  };
  /** The type-98 catalogue rows: a world weapon's id and its round's Cobj (aRSL slot 0). */
  world_weapons: { weapon_id: number; kind: number; cobj: number | null }[];
  /** The type-99 rows: a loadout code (`key`) and the Cobjs in aRSL slots 0 and 3. */
  player_weapons: { key: number; cobj_a: number | null; cobj_b: number | null }[];
  models: Record<
    string,
    {
      sha256_16: string;
      attach?: { frames?: number; points: { index: number; glb_xyz: number[] }[] };
      anim?: { kind: string; frames: number; tracks?: number | ReTrack[] };
    }
  >;
}
/** One AnmD track as pa_models.json lists it (`models.<cobj>.anim.tracks`). */
interface ReTrack {
  track: number;
  from: number;
  to: number;
  mode: number;
  end: number;
  link: number;
  link_b: number;
  link_c: number;
  flags: number;
  period: number;
  event_code: number;
  event_frame: number;
  driven_by: string;
}

/** One gun as the sim reads it. */
export interface ModelsGun {
  readonly gun: number;
  readonly cobj: number;
  /** The hull's attach point the gun stands on, hull glb frame (its frame 0). */
  readonly point: readonly number[];
  /**
   * The same point in each frame of a hull that walks, frame k at row k; absent
   * for a static hull.
   */
  readonly pointByFrame?: readonly (readonly number[])[];
  /** The gun model's point 0, its muzzle, gun glb frame. */
  readonly muzzle: readonly number[];
  /** Angle units (4096 a turn) per 1/300 s. */
  readonly turnPerTick: number;
  readonly frontSectorOnly: boolean;
}

/**
 * Each role's `radius_68`, raw (/ 512 m): the Cobj and frame it is read at. The
 * mech's legs (the type-1 actor's own model) at the walker's pose and the
 * hover's; a turret's gun (the actor that aims; its base is the part at +0x104);
 * a neutral per turret spot, in the record order enrichArena keeps; the Sky
 * Captain per level 0..9.
 */
export interface ModelsRadii {
  readonly x1: { readonly cobj: number; readonly walker: number; readonly hover: number };
  readonly tank: number;
  readonly jet: number;
  readonly fortress: number;
  /** The hull at frame 0, where the construct leaves it. */
  readonly dreadnought: number;
  /**
   * A hull that walks (Joke's): its radius in each frame of the walk, frame k at
   * row k (`cact_model_select` re-reads the box each frame the walk shows,
   * `type5_model_select`, type5.c 137-145). Absent on a static hull.
   */
  readonly dreadnoughtByFrame?: readonly number[];
  readonly baseTurret: number;
  readonly neutral: readonly number[];
  readonly skyCaptain: readonly number[];
}

/**
 * A turret's gun as the sim aims and fires it (fcop-fidelity.md G12): the gun is
 * the turret actor, standing on its base's attach point 0 (`turret_construct`,
 * turret.c 913-918, once, frame 0: no shipped base animates); its round leaves
 * from the gun model's point 0 (`cact_weapon_discharge` 0x0044d98d reads the
 * point the shooter's +0x23 names, 0 from `cact_shooter_init` 0x0044ea00 and
 * never toggled: no PA turret's bitfield has ALTERNATE 0x20), placed through the
 * gun's matrix `math_matrix_from_angles(yaw, pitch, 0)` (0x0041c7a9).
 */
export interface ModelsTurretGun {
  readonly gun: number;
  readonly base: number;
  /** The base's attach point 0, base glb frame. */
  readonly stand: readonly number[];
  /** The gun model's point 0, gun glb frame. */
  readonly muzzle: readonly number[];
}

/**
 * One model's whole 3DBB table, as the shipped Cobj holds it (RE
 * docs/formats/objects.md "3DBB: the boxes per frame"): `perFrame` boxes in each
 * of `frames` frames, box-major -- box i of frame f is row i * frames + f -- each
 * row the box's eight halfwords: its centre x, y, z, its half extents x, y, z,
 * the 3D radius (+0x0c, `radius_68` >> 4) and the horizontal one (+0x0e,
 * `half_h`). The model's own axes (x NOT negated, unlike a glb), 1/512 m.
 * `cact_pair_test` 0x00450190 reads box 0 of the frame for its sphere and
 * cylinder, and `cact_hit_boxes` 0x0044f640 every box of the frame (box 0 only
 * when it is the frame's one).
 */
export interface ModelsShapeTable {
  /** The first Cobj read with this table (others may share it). */
  readonly cobj: number;
  readonly perFrame: number;
  readonly frames: number;
  readonly boxes: readonly (readonly number[])[];
}

/**
 * A turret's two actors: its gun (the actor that aims and is placed on the
 * base) and its base part (turret.c, the part at +0x104, which forwards a
 * contact to the gun; turret_part.c op 0x0b), and the base's attach point 0
 * the gun stands on (turret.c 914-917), glb frame (x negated), metres.
 */
export interface ModelsTurretShape {
  readonly gun: number;
  readonly base: number;
  readonly point: readonly number[];
}

/**
 * A unit (gen:units' `unit` treatment: the tank, the jet, the Flying Fortress,
 * the Sky Captain): its table, and the raw's grounding -- where its model's own
 * origin stands from its body faces' footprint (`-centre x, -min y, -centre z`
 * of the raw's body faces, the additive ones left out). The client draws the
 * model at its origin; the sim reads the lift's y only for a tank standing on
 * the ground off the road graph. The model's own axes (x not negated), metres.
 */
export interface ModelsUnitShape {
  readonly table: number;
  readonly lift: readonly number[];
  /**
   * The model's points 0 and 1 at frame 0, glb frame (metres, +z forward, x
   * the model's negated), as far as it has them: where `cact_weapon_discharge`
   * (0x0044d98d) puts the round of a shooter whose +0x23 is 0 or 1 -- 0 for
   * the tank and the jet, either for an ALTERNATE shooter (the Flying
   * Fortress, the Sky Captain's gun and missile). Empty for a model with none.
   */
  readonly muzzles: readonly (readonly number[])[];
}

/**
 * Every body's and every round's 3DBB table, by index into `tables` (one per
 * distinct table): the colliders `cact_pair_test` tests (fcop-fidelity.md G1). The mech's
 * legs and cockpit are not here: they are the same models on every arena and
 * gen:x1 carries them (packages/sim/src/x1Shapes.generated.ts).
 */
export interface ModelsShapes {
  readonly tables: readonly ModelsShapeTable[];
  readonly tank: ModelsUnitShape;
  readonly jet: ModelsUnitShape;
  readonly fortress: ModelsUnitShape;
  /** The hull, every frame (Joke's walks). */
  readonly dreadnought: number;
  /** Gun i's model (mount.c: each forwards a contact to the hull). */
  readonly dreadnoughtGuns: readonly number[];
  readonly baseTurret: ModelsTurretShape;
  /** Per turret spot, in the record order enrichArena keeps. */
  readonly neutral: readonly ModelsTurretShape[];
  /** By level 0..9. */
  readonly skyCaptain: readonly ModelsUnitShape[];
  /** A world weapon's round, by the catalogue's weapon id (those with a Cobj). */
  readonly worldRounds: Readonly<Record<string, number>>;
  /** A player weapon's round, by loadout code (aRSL slot 0; slot 3's table is the same). */
  readonly playerRounds: Readonly<Record<string, number>>;
}

export interface ModelsArtifact {
  readonly mission: string;
  readonly source: { readonly repo: string; readonly commit: string; readonly tool: string };
  readonly radii: ModelsRadii;
  /**
   * Each role's box-0 centre y, raw, at the same model and frame as its radius:
   * the height its reference point stands above its position (the box's
   * centre placed through the orientation, `math_matrix_place_point`
   * 0x00458850, unshifted — 1/512 units added as world units).
   */
  readonly refs: ModelsRadii;
  /**
   * Each role's box Y half-extent, raw (16 wu, the halfword at +8), at the same
   * model and frame as its radius: an aircraft's `word_6c` (`cact_model_select`
   * 0x004297e0), whose `<< 4` raises its flight floor (RE aircraft.c 0x00420a31).
   */
  readonly halves: ModelsRadii;
  /** The Sky Captain's record (its Cact id) per level 0..9. */
  readonly skyCaptainTemplates: readonly number[];
  readonly dreadnought: {
    readonly hull: number;
    readonly hullSha: string;
    /**
     * The hull's AnmD track 0 when its model animates (Joke's), else absent: the
     * walk `cact_handler_type5` op 6 steps by `velocity_84 * dt` (type5.c
     * 469-472), the record pa_models.json lists.
     */
    readonly walk?: ModelsTrack;
    readonly guns: readonly ModelsGun[];
  };
  /** The type-8 turret's gun, and a neutral's per turret spot (the radii's order). */
  readonly turrets: {
    readonly baseTurret: ModelsTurretGun;
    readonly neutral: readonly ModelsTurretGun[];
  };
  /** Every body's and round's 3DBB table (the pair test's colliders). */
  readonly shapes: ModelsShapes;
}

/** An AnmD track: the block.c fields, the event packed `code << 10 | frame`. */
export interface ModelsTrack {
  readonly from: number;
  readonly to: number;
  readonly mode: number;
  readonly end: number;
  readonly link: number;
  readonly linkB: number;
  readonly linkC: number;
  readonly flags: number;
  readonly period: number;
  readonly event: number;
}

// --- the shipped Cobjs (RE tools/gfx/fcop.py parse / extract, obj_mesh.py) ----------

/** The container's write block: no chunk crosses a 0x6000 boundary. */
const BLOCK = 0x6000;

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function tagAt(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function lettersAt(b: Uint8Array, o: number): boolean {
  for (let i = 0; i < 4; i++) {
    const c = b[o + i];
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  }
  return true;
}

/** fcop.py `parse`: every Cobj's header chunk, by id. */
function cobjIndex(b: Uint8Array): Map<number, { pos: number; size: number; total: number }> {
  const out = new Map<number, { pos: number; size: number; total: number }>();
  let pos = 0;
  while (pos < b.length) {
    const rem = BLOCK - (pos % BLOCK);
    if (rem < 8 || pos + 8 > b.length) {
      pos += rem;
      continue;
    }
    const size = u32(b, pos + 4);
    if (size < 8 || size > rem || !lettersAt(b, pos)) {
      pos += rem;
      continue;
    }
    if (
      tagAt(b, pos) === "COHS" &&
      tagAt(b, pos + 16) === "RDHS" &&
      tagAt(b, pos + 24) === "jboC"
    ) {
      out.set(u32(b, pos + 28), { pos, size, total: u32(b, pos + 32) });
    }
    pos += size;
  }
  return out;
}

/** fcop.py `extract`: the resource's TADS fragments, concatenated. */
function extractCobj(b: Uint8Array, at: { pos: number; size: number; total: number }): Uint8Array {
  const out = new Uint8Array(at.total);
  let len = 0;
  let pos = at.pos + at.size;
  while (pos < b.length && len < at.total) {
    const rem = BLOCK - (pos % BLOCK);
    if (rem < 8 || pos + 8 > b.length) {
      pos += rem;
      continue;
    }
    const size = u32(b, pos + 4);
    if (size < 8 || size > rem || !lettersAt(b, pos)) {
      pos += rem;
      continue;
    }
    if (tagAt(b, pos) === "COHS") {
      const sub = tagAt(b, pos + 16);
      if (sub === "RDHS") break;
      if (sub === "TADS") {
        const piece = b.subarray(pos + 20, Math.min(pos + size, pos + 20 + at.total - len));
        out.set(piece, len);
        len += piece.length;
      }
    }
    pos += size;
  }
  return out.subarray(0, len);
}

/** 3DBB box fields (RE fcop/model.h): the centre's y, and the `radius_68` halfword. */
const BOX_CY = 2;
const BOX_HALF_Y = 8;
const BOX_RADIUS = 12;

/**
 * The i16 at `off` of 3DBB box `frame` (`bbox_at`, object/model.c: header 8, a
 * box every 16 bytes): +12 the model's `radius_68`, +2 its centre's y.
 */
function boxRaw(cobj: Uint8Array, frame: number, off: number, what: string): number {
  let pos = 0;
  while (pos + 8 <= cobj.length) {
    const size = u32(cobj, pos + 4);
    if (size < 8 || pos + size > cobj.length) break;
    const tag = String.fromCharCode(cobj[pos + 3], cobj[pos + 2], cobj[pos + 1], cobj[pos]);
    if (tag === "3DBB") {
      const box = pos + 8 + 8 + frame * 16;
      if (box + 16 > pos + size) throw new Error(`${what}: no 3DBB box for frame ${frame}`);
      const v = cobj[box + off] | (cobj[box + off + 1] << 8);
      return v >= 0x8000 ? v - 0x10000 : v;
    }
    pos += size;
  }
  throw new Error(`${what}: no 3DBB chunk`);
}

/** The 4DGI flags word's hit-box bit (RE fcop/object.h COBJ_FLAG_HIT_BOXES, 0x0044f661). */
const HIT_BOXES = 0x08000000;

/**
 * A Cobj's whole 3DBB table (ModelsShapeTable). The 4DGI's flags word (+4 of
 * its payload: the frame count in its low half) must carry the hit-box bit --
 * every Precinct Assault model does -- and the table must hold boxes per frame
 * x frames rows, the layout `bbox_at` (object/model.c) reads.
 */
function shapeTable(cobj: Uint8Array, id: number, what: string): ModelsShapeTable {
  let flags = -1;
  let table: ModelsShapeTable | undefined;
  let pos = 0;
  while (pos + 8 <= cobj.length) {
    const size = u32(cobj, pos + 4);
    if (size < 8 || pos + size > cobj.length) break;
    const tag = String.fromCharCode(cobj[pos + 3], cobj[pos + 2], cobj[pos + 1], cobj[pos]);
    if (tag === "4DGI") flags = u32(cobj, pos + 8 + 4);
    if (tag === "3DBB") {
      const perFrame = u32(cobj, pos + 8);
      const total = u32(cobj, pos + 12);
      const boxes: number[][] = [];
      for (let at = pos + 16; at + 16 <= pos + size; at += 16) {
        const row: number[] = [];
        for (let k = 0; k < 8; k++) {
          const v = cobj[at + 2 * k] | (cobj[at + 2 * k + 1] << 8);
          row.push(v >= 0x8000 ? v - 0x10000 : v);
        }
        boxes.push(row);
      }
      if (perFrame < 1 || boxes.length !== total || total % perFrame !== 0) {
        throw new Error(
          `${what}: 3DBB holds ${boxes.length} of ${total} boxes, ${perFrame} a frame`,
        );
      }
      table = { cobj: id, perFrame, frames: total / perFrame, boxes };
    }
    pos += size;
  }
  if (!table) throw new Error(`${what}: no 3DBB chunk`);
  if (flags < 0 || (flags & HIT_BOXES) === 0) throw new Error(`${what}: no hit-box bit in 4DGI`);
  if ((flags & 0xffff) !== table.frames) {
    throw new Error(`${what}: 4DGI says ${flags & 0xffff} frames, 3DBB ${table.frames}`);
  }
  return table;
}

/** Six decimals: the lift prints the same on every machine. */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

/**
 * Where a `unit`'s model origin stands from the position the client draws it
 * at (ModelsUnitShape.lift): gen:units' grounding of its raw (genUnitModels.ts
 * `bodyBounds`, the non-additive faces). A skinned raw (Joke's jet) is posed
 * by its bake, so its frame-0 box 0 stands in for the bounds.
 */
async function unitLift(
  arena: FcopArena,
  payload: string,
  cobj: number,
  box0: readonly number[],
): Promise<number[]> {
  // The file the arena draws it from: shared files are another arena's copy of
  // the same payload.
  const file = UNIT_MODEL_FILES.find(
    (f) => f.payload === payload && f.usedBy.includes(arena.mapId),
  );
  if (file?.treatment !== "unit") {
    throw new Error(`${arena.mission}: Cobj ${cobj} is not a unit gen:units grounds`);
  }
  const doc = await new NodeIO().read(
    join(REPO_ROOT, "tools", "generators", "units", "raw", file.raw),
  );
  const root = doc.getRoot();
  if (
    root.listSkins().length > 0 ||
    root.listNodes().some((n) => n.getMesh() && !isIdentity(n.getMatrix()))
  ) {
    const [cx, cy, cz, , hy] = box0;
    return [r6(-cx / 512), r6((hy - cy) / 512), r6(-cz / 512)];
  }
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const el = [0, 0, 0];
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const mode = (p: (typeof prims)[number]) =>
    (p.getMaterial()?.getExtras() as { fcop?: { mode?: string } } | undefined)?.fcop?.mode;
  const body = prims.filter((p) => mode(p) !== "add");
  for (const prim of body.length > 0 ? body : prims) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      for (let a = 0; a < 3; a++) {
        if (el[a] < min[a]) min[a] = el[a];
        if (el[a] > max[a]) max[a] = el[a];
      }
    }
  }
  // The glb's x is the model's negated: its centre's offset comes back unnegated.
  return [r6((min[0] + max[0]) / 2), r6(-min[1]), r6(-(min[2] + max[2]) / 2)];
}

function isIdentity(m: readonly number[]): boolean {
  return m.every((v, i) => v === (i % 5 === 0 ? 1 : 0));
}

/** Every body's and round's 3DBB table on `arena` (ModelsShapes). */
async function buildShapes(arena: FcopArena, re: ReModels, reRepo: string): Promise<ModelsShapes> {
  const container = new Uint8Array(
    readFileSync(join(reRepo, "fixtures", "missions", arena.mission)),
  );
  const index = cobjIndex(container);
  const tables: ModelsShapeTable[] = [];
  const read = (cobj: number, what: string): ModelsShapeTable => {
    const entry = index.get(cobj);
    if (!entry) throw new Error(`${arena.mission}: no Cobj ${cobj} (${what})`);
    return shapeTable(extractCobj(container, entry), cobj, `${arena.mission} Cobj ${cobj}`);
  };
  // One table per distinct box set: Mp's tank round (Cobj 12) and the second
  // side's (53) are the same payload, so their profiles stay one.
  const key = (t: ModelsShapeTable) => JSON.stringify([t.perFrame, t.frames, t.boxes]);
  const at = (cobj: number, what: string): number => {
    const t = read(cobj, what);
    const have = tables.findIndex((x) => key(x) === key(t));
    if (have >= 0) return have;
    tables.push(t);
    return tables.length - 1;
  };
  const part = (role: ReRole, name: string, what: string): number => {
    const p = role.parts.find((x) => x.part === name);
    if (!p) throw new Error(`${arena.mission}: the ${what} has no ${name}`);
    return p.cobj;
  };
  const unit = async (cobj: number, what: string): Promise<ModelsUnitShape> => {
    const table = at(cobj, what);
    const payload = re.models[String(cobj)]?.sha256_16;
    if (!payload) throw new Error(`${arena.mission}: no payload hash for Cobj ${cobj}`);
    const points = re.models[String(cobj)]?.attach?.points ?? [];
    const muzzles: number[][] = [];
    for (let k = 0; k < 2; k++) {
      const p = points.find((x) => x.index === k);
      if (!p) break;
      muzzles.push([...p.glb_xyz]);
    }
    return {
      table,
      lift: await unitLift(arena, payload, cobj, tables[table].boxes[0]),
      muzzles,
    };
  };
  const one = (roles: ReRole[], name: string, what: string): Promise<ModelsUnitShape> => {
    if (roles.length !== 1) throw new Error(`${arena.mission}: ${roles.length} ${what} model sets`);
    return unit(part(roles[0], name, what), what);
  };
  const point0 = (cobj: number, what: string): number[] => {
    const p = re.models[String(cobj)]?.attach?.points.find((x) => x.index === 0);
    if (!p) throw new Error(`${arena.mission}: the ${what}'s base ${cobj} has no point 0`);
    return p.glb_xyz;
  };
  const turret = (role: ReRole, what: string): ModelsTurretShape => {
    const base = part(role, "base", what);
    return {
      gun: at(part(role, "gun", what), what),
      base: at(base, what),
      point: point0(base, what),
    };
  };
  if (re.roles.base_turret.length !== 1) {
    throw new Error(`${arena.mission}: ${re.roles.base_turret.length} base turret model sets`);
  }
  // A neutral per spot, as buildRadii pairs them: the NeutralTurret records in order.
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as { neutrals: { id: number }[] };
  const neutral = logic.neutrals.map((rec) => {
    const role = re.roles.neutral_turret.find((r) =>
      (r.templates ?? []).some((t) => t.res === "Csac" && t.id === rec.id),
    );
    if (!role) throw new Error(`${arena.mission}: NeutralTurret ${rec.id} is in no model set`);
    return turret(role, "neutral turret");
  });
  const skyCaptain: ModelsUnitShape[] = [];
  for (const role of re.roles.sky_captain) {
    const body = await unit(part(role, "body", "Sky Captain"), "Sky Captain");
    for (const level of role.levels ?? []) skyCaptain[level] = body;
  }
  for (let level = 0; level < 10; level++) {
    if (skyCaptain[level] === undefined)
      throw new Error(`${arena.mission}: no Sky Captain ${level}`);
  }
  const hull = re.roles.dreadnought[0];
  if (!hull) throw new Error(`${arena.mission}: no Dreadnought`);
  const worldRounds: Record<string, number> = {};
  for (const w of re.world_weapons) {
    if (w.cobj !== null) worldRounds[String(w.weapon_id)] = at(w.cobj, `weapon ${w.weapon_id}`);
  }
  const playerRounds: Record<string, number> = {};
  for (const w of re.player_weapons) {
    if (w.cobj_a === null) continue;
    const a = at(w.cobj_a, `loadout 0x${w.key.toString(16)}`);
    // The shot's model is slot 0, or slot 3 after the swap (player_fire.c
    // 0x0045904e); the shipped two are the same table, so either is the shape.
    if (w.cobj_b !== null && w.cobj_b !== w.cobj_a) {
      const b = read(w.cobj_b, `loadout 0x${w.key.toString(16)}`);
      if (JSON.stringify(b.boxes) !== JSON.stringify(tables[a].boxes)) {
        throw new Error(`${arena.mission}: loadout 0x${w.key.toString(16)}'s two models differ`);
      }
    }
    playerRounds[String(w.key)] = a;
  }
  const tank = await one(re.roles.tank, "body", "tank");
  const jet = await one(re.roles.jet, "body", "jet");
  const fortress = await one(re.roles.flying_fortress, "body", "Flying Fortress");
  return {
    tables,
    tank,
    jet,
    fortress,
    dreadnought: at(part(hull, "hull", "Dreadnought"), "Dreadnought hull"),
    dreadnoughtGuns: hull.guns.map((g) => at(g.cobj, `Dreadnought gun ${g.gun}`)),
    baseTurret: turret(re.roles.base_turret[0], "base turret"),
    neutral,
    skyCaptain,
    worldRounds,
    playerRounds,
  };
}

/**
 * Each role's 3DBB halfword at `off`, at the frame the role is read at:
 * BOX_RADIUS its `radius_68`, BOX_CY its box-0 centre's y.
 */
function buildRadii(
  arena: FcopArena,
  re: ReModels,
  reRepo: string,
  hullFrames: number,
  off: number,
): ModelsRadii {
  const container = new Uint8Array(
    readFileSync(join(reRepo, "fixtures", "missions", arena.mission)),
  );
  const index = cobjIndex(container);
  const at = (cobj: number, frame: number, what: string): number => {
    const entry = index.get(cobj);
    if (!entry) throw new Error(`${arena.mission}: no Cobj ${cobj} (${what})`);
    return boxRaw(extractCobj(container, entry), frame, off, `${arena.mission} Cobj ${cobj}`);
  };
  const one = (roles: ReRole[], part: string, what: string): number => {
    if (roles.length !== 1) throw new Error(`${arena.mission}: ${roles.length} ${what} model sets`);
    const p = roles[0].parts.find((x) => x.part === part);
    if (!p) throw new Error(`${arena.mission}: the ${what} has no ${part}`);
    return at(p.cobj, 0, what);
  };
  // The mech's two poses (RE extracted/x1/tracks.json): the walker ends on legs
  // track 0, the hover holds legs frame `hover.legs.hold_frame`.
  const tracks = JSON.parse(
    readFileSync(join(reRepo, "extracted", "x1", "tracks.json"), "utf8"),
  ) as {
    parts: { legs: { tracks: { track: number; from: number }[] } };
    hover: { legs: { hold_frame: number } };
  };
  const walkerFrame = tracks.parts.legs.tracks.find((t) => t.track === 0)?.from;
  if (walkerFrame === undefined) throw new Error("tracks.json: no legs track 0");
  const legs = re.roles.x1alpha[0]?.parts.find((p) => p.part === "legs");
  if (!legs) throw new Error(`${arena.mission}: the X1 has no legs part`);
  // A neutral per spot: the spots are the NeutralTurret records in order.
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as { neutrals: { id: number }[] };
  const neutralSets = re.roles.neutral_turret.map((role) => {
    const gun = role.parts.find((p) => p.part === "gun");
    if (!gun) throw new Error(`${arena.mission}: a neutral turret with no gun`);
    const ids = new Set((role.templates ?? []).filter((t) => t.res === "Csac").map((t) => t.id));
    return { ids, radius: at(gun.cobj, 0, "neutral turret") };
  });
  const neutral = logic.neutrals.map((rec) => {
    const set = neutralSets.find((n) => n.ids.has(rec.id));
    if (!set) throw new Error(`${arena.mission}: NeutralTurret ${rec.id} is in no model set`);
    return set.radius;
  });
  const skyCaptain: number[] = [];
  for (const role of re.roles.sky_captain) {
    const body = role.parts.find((p) => p.part === "body");
    if (!body) throw new Error(`${arena.mission}: a Sky Captain with no body`);
    for (const level of role.levels ?? []) skyCaptain[level] = at(body.cobj, 0, "Sky Captain");
  }
  for (let level = 0; level < 10; level++) {
    if (skyCaptain[level] === undefined) {
      throw new Error(`${arena.mission}: no Sky Captain for level ${level}`);
    }
  }
  const hull = re.roles.dreadnought[0]?.parts.find((p) => p.part === "hull");
  if (!hull) throw new Error(`${arena.mission}: the Dreadnought has no hull`);
  const hullByFrame: number[] = [];
  for (let k = 0; k < hullFrames && hullFrames > 1; k++) {
    hullByFrame.push(at(hull.cobj, k, `Dreadnought hull frame ${k}`));
  }
  return {
    x1: {
      cobj: legs.cobj,
      walker: at(legs.cobj, walkerFrame, "X1 walker"),
      hover: at(legs.cobj, tracks.hover.legs.hold_frame, "X1 hover"),
    },
    tank: one(re.roles.tank, "body", "tank"),
    jet: one(re.roles.jet, "body", "jet"),
    fortress: one(re.roles.flying_fortress, "body", "Flying Fortress"),
    dreadnought: at(hull.cobj, 0, "Dreadnought hull"),
    ...(hullByFrame.length > 0 ? { dreadnoughtByFrame: hullByFrame } : {}),
    baseTurret: one(re.roles.base_turret, "gun", "base turret"),
    neutral,
    skyCaptain,
  };
}

/** Each level's Sky Captain record: the one Cact template of its level band's role. */
function skyCaptainTemplates(arena: FcopArena, re: ReModels): number[] {
  const out: number[] = [];
  for (const role of re.roles.sky_captain) {
    const t = (role.templates ?? []).filter((x) => x.res === "Cact");
    if (t.length !== 1)
      throw new Error(`${arena.mission}: a Sky Captain band with ${t.length} records`);
    for (const level of role.levels ?? []) out[level] = t[0].id;
  }
  for (let level = 0; level < 10; level++) {
    if (out[level] === undefined)
      throw new Error(`${arena.mission}: no Sky Captain record for level ${level}`);
  }
  return out;
}

/**
 * The hull's walk: its model's one AnmD track when the model animates. The sim
 * plays it as `cact_anim_step` does, so it must be closed -- one track whose
 * links are itself -- and step by distance (mode 2: `velocity_84 * dt`), over
 * exactly the model's frames, all of which carry the attach points.
 */
function hullWalk(
  arena: FcopArena,
  re: ReModels,
  cobj: number,
): { walk: ModelsTrack | undefined; frames: number } {
  const model = re.models[String(cobj)];
  const anim = model?.anim;
  if (!anim || anim.kind === "static") return { walk: undefined, frames: 1 };
  const tracks = anim.tracks;
  if (!Array.isArray(tracks) || tracks.length !== 1) {
    throw new Error(`${arena.mission}: hull ${cobj} has ${String(tracks)} tracks, want one`);
  }
  const t = tracks[0];
  if (
    t.link !== 0 ||
    t.link_b !== 0 ||
    t.link_c !== 0 ||
    t.mode !== 2 ||
    t.driven_by !== "distance"
  ) {
    throw new Error(`${arena.mission}: hull ${cobj}'s track is not a closed distance walk`);
  }
  if (t.from !== 0 || t.to !== anim.frames - 1 || model.attach?.frames !== anim.frames) {
    throw new Error(`${arena.mission}: hull ${cobj}'s track does not cover its frames`);
  }
  const walk: ModelsTrack = {
    from: t.from,
    to: t.to,
    mode: t.mode,
    end: t.end,
    link: t.link,
    linkB: t.link_b,
    linkC: t.link_c,
    flags: t.flags,
    period: t.period,
    event: t.event_code !== 0 ? (t.event_code << 10) | t.event_frame : 0,
  };
  return { walk, frames: anim.frames };
}

/** One turret role's gun: where it stands on its base and its muzzle. */
function turretGunOf(arena: FcopArena, re: ReModels, role: ReRole, what: string): ModelsTurretGun {
  const gun = role.parts.find((p) => p.part === "gun");
  const base = role.parts.find((p) => p.part === "base");
  if (!gun || !base) throw new Error(`${arena.mission}: the ${what} has no gun or no base`);
  const stand = re.models[String(base.cobj)]?.attach?.points.find((p) => p.index === 0);
  if (!stand) throw new Error(`${arena.mission}: ${what} base ${base.cobj} has no point 0`);
  if (role.gun_point && JSON.stringify(role.gun_point.glb_xyz) !== JSON.stringify(stand.glb_xyz)) {
    throw new Error(`${arena.mission}: the ${what}'s gun point is not its base's point 0`);
  }
  const muzzle = re.models[String(gun.cobj)]?.attach?.points.find((p) => p.index === 0);
  if (!muzzle) throw new Error(`${arena.mission}: ${what} gun ${gun.cobj} has no point 0`);
  return { gun: gun.cobj, base: base.cobj, stand: stand.glb_xyz, muzzle: muzzle.glb_xyz };
}

/** The turrets' guns: the type-8 one, and a neutral per turret spot (buildRadii's order). */
function buildTurrets(arena: FcopArena, re: ReModels): ModelsArtifact["turrets"] {
  if (re.roles.base_turret.length !== 1) {
    throw new Error(`${arena.mission}: ${re.roles.base_turret.length} base turret model sets`);
  }
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as { neutrals: { id: number }[] };
  const sets = re.roles.neutral_turret.map((role) => ({
    ids: new Set((role.templates ?? []).filter((t) => t.res === "Csac").map((t) => t.id)),
    gun: turretGunOf(arena, re, role, "neutral turret"),
  }));
  const neutral = logic.neutrals.map((rec) => {
    const set = sets.find((n) => n.ids.has(rec.id));
    if (!set) throw new Error(`${arena.mission}: NeutralTurret ${rec.id} is in no model set`);
    return set.gun;
  });
  return { baseTurret: turretGunOf(arena, re, re.roles.base_turret[0], "base turret"), neutral };
}

async function buildModels(
  arena: FcopArena,
  re: ReModels,
  source: ModelsArtifact["source"],
  reRepo: string,
) {
  const roles = re.roles.dreadnought;
  if (roles.length !== 1)
    throw new Error(`${arena.mission}: ${roles.length} Dreadnought model sets`);
  const role = roles[0];
  const hull = role.parts.find((p) => p.part === "hull");
  if (!hull) throw new Error(`${arena.mission}: the Dreadnought has no hull part`);
  const { walk, frames: walkFrames } = hullWalk(arena, re, hull.cobj);
  const guns = role.guns.map((g, i): ModelsGun => {
    if (g.gun !== i || g.point_index !== i || g.hull_point.index !== i) {
      throw new Error(`${arena.mission}: gun ${i} does not stand on hull point ${i}`);
    }
    const sides = Object.values(g.by_side);
    const key = (s: ReGunSide) =>
      JSON.stringify([
        s.word_48,
        s.home_yaw_word_4a,
        s.mount_flags,
        s.turn_rate_per_tick,
        s.shooter.weapon_id,
        s.shooter.front_sector_only,
      ]);
    if (sides.length !== 2 || key(sides[0]) !== key(sides[1])) {
      throw new Error(`${arena.mission}: gun ${i}'s two sides disagree`);
    }
    const s = sides[0];
    // The home yaw 0 is the hull's forward and no flag limits the traverse or
    // animates the fire: the sim models exactly that mount (mount.c 270-394).
    if (s.home_yaw_word_4a !== 0 || s.mount_flags !== 0) {
      throw new Error(`${arena.mission}: gun ${i} has a home yaw or mount flags`);
    }
    if (((s.word_48 << 8) / 218) >> 4 !== s.turn_rate_per_tick) {
      throw new Error(`${arena.mission}: gun ${i}'s turn rate is not word_48's`);
    }
    const muzzle = re.models[String(g.cobj)]?.attach?.points.find((p) => p.index === 0);
    if (!muzzle) throw new Error(`${arena.mission}: gun model ${g.cobj} has no point 0`);
    const byFrame = walk ? g.hull_point.by_frame : undefined;
    if (walk && byFrame?.length !== walkFrames) {
      throw new Error(`${arena.mission}: gun ${i}'s point is not carried over the hull's frames`);
    }
    if (byFrame && JSON.stringify(byFrame[0]) !== JSON.stringify(g.hull_point.glb_xyz)) {
      throw new Error(`${arena.mission}: gun ${i}'s frame-0 point is not its point`);
    }
    return {
      gun: i,
      cobj: g.cobj,
      point: g.hull_point.glb_xyz,
      ...(byFrame ? { pointByFrame: byFrame } : {}),
      muzzle: muzzle.glb_xyz,
      turnPerTick: s.turn_rate_per_tick,
      frontSectorOnly: s.shooter.front_sector_only,
    };
  });
  const artifact: ModelsArtifact = {
    mission: arena.mission,
    source,
    radii: buildRadii(arena, re, reRepo, walkFrames, BOX_RADIUS),
    refs: buildRadii(arena, re, reRepo, walkFrames, BOX_CY),
    halves: buildRadii(arena, re, reRepo, walkFrames, BOX_HALF_Y),
    skyCaptainTemplates: skyCaptainTemplates(arena, re),
    dreadnought: {
      hull: hull.cobj,
      hullSha: re.models[String(hull.cobj)].sha256_16,
      ...(walk ? { walk } : {}),
      guns,
    },
    turrets: buildTurrets(arena, re),
    shapes: await buildShapes(arena, re, reRepo),
  };
  return artifact;
}

async function main(): Promise<void> {
  const reRepo = requireReRepo();
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  const named = positional || argOf("map", argOf("mission", "all"));
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", reRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    console.warn(`[gen:pamodels] could not read the RE repo commit at ${reRepo}`);
  }
  for (const arena of selectArenas(named)) {
    const src = join(reRepo, "extracted", "logic", arena.mission, "pa_models.json");
    const re = JSON.parse(readFileSync(src, "utf8")) as ReModels;
    const models = await buildModels(
      arena,
      re,
      {
        repo: "amigo-labs/fcop-reverse-engineering",
        commit,
        tool: "tools/gfx/pa_models.py; fixtures/missions (3DBB)",
      },
      reRepo,
    );
    const out = join(REPO_ROOT, "tools", "generators", "fcop", modelsFile(arena));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(models, null, 2)}\n`);
    // The repo's formatter has the last word on layout, so a re-run is a no-op.
    const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", out], { cwd: REPO_ROOT });
    if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
    console.log(`wrote ${out}: Dreadnought hull ${models.dreadnought.hull}, 4 guns`);
  }
}

if (import.meta.main) await main();
