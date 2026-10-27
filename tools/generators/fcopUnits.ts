// Reads each arena's Precinct Assault units out of the private RE repo: which
// of the arena's OWN Cobjs draws every role, and what the original does with
// them that a .glb does not carry.
//
//   <RE>/extracted/logic/<Mission>/pa_models.json   (RE docs/formats/pa-models.md)
//   <RE>/extracted/objects/<Mission>/obj_NNN.glb
//     -> tools/generators/units/raw/fcop-units/<Mission>/obj_NNN.glb   (unchanged)
//     -> packages/client/src/render/arenaUnits.generated.ts
//
// A Cobj id is a resource id of its own container: Hk's tank is 30 like Mp's
// but another model (texture page 6), Joke's is 31, Conft's Flying Fortress is
// 42. So every role is read from the arena's own file, never from Mp's numbers.
//
// What a role needs beyond its model, all off the same file:
// - the team colour: a per-actor offset onto the other half of the texture
//   page, in texels (`team_uv.by_side`), and a neutral turret's offset after a
//   capture (`capture[].uv_after_capture`); the RE checks that no unit's offset
//   carries or wraps, so it is a plain (+du/256, +dv/256) in glTF texcoords;
// - which original side (1 = red, 2 = blue on all six) each Metropolis team is:
//   enrichArena.ts makes team N the original's player slot N, side N + 1, on
//   every arena (SIM_VERSION 79; Mp's team 0 was side 2 before). Read off the
//   Dreadnought records here and checked against the map's base cores;
// - the turret's gun on its base's attach point 0, the Dreadnought's four guns
//   on its hull's attach points 0-3 (the glb frame, metres). The mount reads
//   the hull's point in the hull's current frame every tick, so a hull that
//   animates (Joke's) gives each gun its point per frame (`hull_point.by_frame`,
//   RE mount.c 526-530); the construct places a turret's gun once, on frame 0
//   (RE `gun_point_frame`, turret.c 913-918), and no base animates anyway;
// - Hk's two neutral turret sets (32/33 and 43/44), by the spot's record;
// - the Sky Captain's model by level (one record per level band);
// - each model's AnmD track 0 the client plays: the jet's rotor and Joke's
//   Fortress and Sky Captain step by time, Joke's tank and Dreadnought hull by
//   the distance they travel (RE type5.c 469-472), and Joke's jet is a skeleton
//   whose frames gen:units bakes into morph targets.
//
// Sharing. Every mission embeds its own texture pages, and the pages differ,
// so a file is shared between arenas only where the payload is identical
// (`sha256_16`) AND every texel the model can sample is: its UV triangles'
// texel boxes, under every offset its role applies. The first arena in
// SHARE_ORDER that has a model keeps the file; the others point at it.
//
// The weapons' models ride along: every `raw/fcop-fx/mp-objNNN-<what>.glb`
// (units/manifest.ts FX_MODELS and the evidence raws beside them) is Mp's
// export of Cobj NNN, copied unchanged.
//
//   bun run gen:paunits [--check] [--re-repo <path>]
//
// `--check` re-derives everything from the RE and exits 1 if a committed raw
// or the generated table differs. Authoring-time only.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NodeIO, type Texture } from "@gltf-transform/core";
import { FCOP_ARENAS, type FcopArena, logicFile } from "./fcopArenas";
import { argOf } from "./fcopLogic";
import { decodePng } from "./png";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RAW_DIR = join(import.meta.dir, "units", "raw");
const OUT_TS = join(REPO_ROOT, "packages", "client", "src", "render", "arenaUnits.generated.ts");
/** enrichArena.ts LOGIC_OFFSET_X / _Z: the actor frame's shift onto the sim grid. */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;
/** Which arena keeps a shared file: Mp first, the arena the others mostly match. */
const SHARE_ORDER = [
  "la-cantina",
  "urban-jungle",
  "proving-ground",
  "hollywood-keys",
  "venice-beach",
  "bug-hunt",
];

// --- pa_models.json (the fields read here) -------------------------------

interface Uv {
  readonly u: number;
  readonly v: number;
}
interface Wrap {
  readonly carry_u: boolean;
  readonly wrap_v: boolean;
}
interface PaRole {
  readonly templates?: readonly { readonly res: string; readonly id: number }[];
  readonly parts: readonly { readonly part: string; readonly cobj: number }[];
  readonly team_uv?: {
    readonly by_side: Readonly<Record<string, readonly Uv[]>>;
    readonly per_model?: Readonly<Record<string, Readonly<Record<string, Wrap>>>>;
    /** The outpost flags: the offset order 0x44 sets once a side claims. */
    readonly after_claim?: Readonly<Record<string, Uv>>;
  } | null;
  readonly levels?: readonly number[];
  readonly gun_point?: { readonly glb_xyz: readonly number[] };
  readonly guns?: readonly {
    readonly gun: number;
    readonly cobj: number;
    readonly hull_point: {
      readonly glb_xyz: readonly number[];
      /** The point in each of the hull's frames (RE `cact_model_point`), frames > 1. */
      readonly by_frame?: readonly (readonly number[] | null)[];
    };
  }[];
  readonly capture?: readonly {
    readonly uv_after_capture: Readonly<Record<string, Uv>>;
    readonly per_model?: Readonly<Record<string, Readonly<Record<string, Wrap>>>>;
  }[];
}
interface PaModel {
  readonly sha256_16: string;
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
      readonly driven_by: string | null;
    }[];
  } | null;
}
interface PaModels {
  readonly map: string;
  readonly roles: Readonly<Record<string, readonly PaRole[]>>;
  readonly models: Readonly<Record<string, PaModel>>;
}

// --- committed inputs read alongside -------------------------------------

interface LogicRecord {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly team?: number;
}
interface Logic {
  readonly dreadnoughts: readonly LogicRecord[];
  readonly neutrals: readonly LogicRecord[];
}
interface MapBits {
  readonly bases: readonly { readonly core: readonly number[] }[];
  readonly turretSpots: readonly (readonly number[] | { readonly x: number; readonly y: number })[];
}

// --- what this writes ----------------------------------------------------

type Vec3 = readonly [number, number, number];
/** Offset per original side: [nobody's (0), side 1, side 2], in page texels. */
type SideUv = readonly [Uv, Uv, Uv];
/**
 * How gen:units treats the file. A `unit` is grounded and centred like every
 * unit before it; a `part` keeps the origin the original authored, because
 * something stands on its attach points or it pivots about it.
 */
type Treatment = "unit" | "part";

/**
 * Track 0 of the model's AnmD, looping over every frame: one frame per
 * `period` units of the delta its actor hands `cact_anim_step` — 1/300 s for
 * `time`, a world unit (1/8192 m) travelled for `distance`. A `skeleton` model's
 * frames are joint poses, which gen:units bakes into morph targets.
 */
interface Morph {
  frames: number;
  period: number;
  drivenBy: "time" | "distance";
  source: "morph" | "skeleton";
}

interface ModelFile {
  file: string;
  mission: string;
  cobj: number;
  treatment: Treatment;
  raw: string;
  payload: string;
  morph: Morph | null;
  /** Arenas that draw this file. */
  usedBy: string[];
}

interface Turret {
  gun: string;
  base: string;
  gunPoint: Vec3;
  uv: SideUv;
}

interface ArenaUnits {
  mission: string;
  sides: readonly [number, number];
  tank: { model: string; uv: SideUv };
  jet: { model: string; uv: SideUv };
  fortress: { model: string; uv: SideUv };
  dreadnought: {
    hull: string;
    uv: SideUv;
    guns: { model: string; point: Vec3; byFrame: Vec3[] | null }[];
  };
  baseTurret: Turret;
  neutralTurrets: (Turret & { spots: number[] })[];
  skyCaptain: { byLevel: string[]; uv: SideUv };
  x1: { uv: SideUv };
  outpostFlag: { cobj: number; uv: SideUv };
}

/** One use of a Cobj by a role: how it is treated and every offset it is drawn under. */
interface Use {
  cobj: number;
  treatment: Treatment;
  offsets: Uv[];
}

const ZERO: Uv = { u: 0, v: 0 };

function only<T>(list: readonly T[] | undefined, what: string): T {
  if (list?.length !== 1)
    throw new Error(`${what}: expected exactly one, got ${list?.length ?? 0}`);
  return list[0];
}

function partCobj(role: PaRole, part: string, what: string): number {
  return only(
    role.parts.filter((p) => p.part === part),
    `${what} part ${part}`,
  ).cobj;
}

/** One offset per side, and none that carries u into v or wraps v (RE: none does). */
function sideUv(role: PaRole, what: string): SideUv {
  const t = role.team_uv;
  if (!t) throw new Error(`${what}: no team_uv`);
  const one = (side: string): Uv => {
    const list = t.by_side[side];
    if (!list) return ZERO;
    const distinct = new Set(list.map((o) => `${o.u},${o.v}`));
    if (distinct.size !== 1) throw new Error(`${what}: side ${side} has ${distinct.size} offsets`);
    return list[0];
  };
  for (const [cobj, bySide] of Object.entries(t.per_model ?? {})) {
    for (const [side, w] of Object.entries(bySide)) {
      if (w.carry_u || w.wrap_v)
        throw new Error(`${what}: Cobj ${cobj} side ${side} carries or wraps`);
    }
  }
  return [one("0"), one("1"), one("2")];
}

function vec3(xyz: readonly number[], what: string): Vec3 {
  if (xyz.length !== 3) throw new Error(`${what}: not a point`);
  return [xyz[0], xyz[1], xyz[2]];
}

/**
 * Metropolis team -> original side. enrichArena.ts makes team N the original's
 * player slot N (SIM_VERSION 79), whose Dreadnought record carries side N + 1:
 * [1, 2] on every arena, which the map's own cores are held to below. (Until 79
 * the teams ran along the field axis, and La Cantina read [2, 1].)
 */
function sidesOf(arena: FcopArena, logic: Logic, map: MapBits): readonly [number, number] {
  const d = logic.dreadnoughts;
  if (d.length !== 2) throw new Error(`${arena.mapId}: ${d.length} Dreadnought records`);
  const sorted = [...d].sort((p, q) => (p.team ?? 0) - (q.team ?? 0));
  const sides = [sorted[0].team ?? 0, sorted[1].team ?? 0] as const;
  if (sides[0] !== 1 || sides[1] !== 2) {
    throw new Error(`${arena.mapId}: Dreadnought sides ${sides.join("/")} are not 1 and 2`);
  }
  // The map's own word for it: each team's core stands on its Dreadnought record.
  for (let team = 0; team < 2; team++) {
    const core = map.bases[team].core;
    const rec = sorted[team];
    const dist = Math.hypot(core[0] - (rec.x + LOGIC_OFFSET_X), core[1] - (rec.z + LOGIC_OFFSET_Z));
    if (dist > 20) {
      throw new Error(
        `${arena.mapId}: team ${team}'s core is ${dist.toFixed(1)} m from its record`,
      );
    }
  }
  return sides;
}

/** Which turretSpots each neutral turret set stands on, by the spot's record id. */
function neutralSpots(arena: FcopArena, role: PaRole, logic: Logic, map: MapBits): number[] {
  const ids = new Set((role.templates ?? []).filter((t) => t.res === "Csac").map((t) => t.id));
  const spots: number[] = [];
  if (logic.neutrals.length !== map.turretSpots.length) {
    throw new Error(
      `${arena.mapId}: ${logic.neutrals.length} NeutralTurret records, ${map.turretSpots.length} spots`,
    );
  }
  logic.neutrals.forEach((rec, k) => {
    // The spot list is the record list in order (enrichArena.ts); hold it to that.
    const s = map.turretSpots[k];
    const [x, y] = Array.isArray(s) ? s : [(s as { x: number }).x, (s as { y: number }).y];
    if (Math.hypot(x - (rec.x + LOGIC_OFFSET_X), y - (rec.z + LOGIC_OFFSET_Z)) > 0.01) {
      throw new Error(`${arena.mapId}: turret spot ${k} is not NeutralTurret record ${rec.id}`);
    }
    if (ids.has(rec.id)) spots.push(k);
  });
  return spots;
}

/**
 * The outpost flags (type 11, groups 11-14): drawn as scenery by
 * render/props.ts, and set to the claimer's offset by order 0x44 from the claim
 * zone's script (RE mission_frame.c 1102-1107). One model and one pair of
 * offsets on every flag of the arena.
 */
function outpostFlagOf(pa: PaModels, mapId: string): { cobj: number; uv: SideUv } {
  const roles = pa.roles.outpost_flag ?? [];
  if (roles.length === 0) throw new Error(`${mapId}: no outpost flags`);
  const cobjs = new Set(roles.map((r) => partCobj(r, "flag", `${mapId} outpost flag`)));
  // Each group's entry also names the script that posts it; the offsets agree.
  const claims = new Set(
    roles.map((r) =>
      ["1", "2"]
        .map((side) => {
          const o = r.team_uv?.after_claim?.[side];
          return o ? `${o.u},${o.v}` : "-";
        })
        .join("|"),
    ),
  );
  if (cobjs.size !== 1 || claims.size !== 1) {
    throw new Error(`${mapId}: the outpost flags differ in model or claim offset`);
  }
  const role = roles[0];
  const neutral = sideUv(role, `${mapId} outpost flag`)[0];
  const after = role.team_uv?.after_claim;
  if (!after) throw new Error(`${mapId}: outpost flag without after_claim`);
  return { cobj: [...cobjs][0], uv: [neutral, after["1"] ?? ZERO, after["2"] ?? ZERO] };
}

/**
 * The track the actor plays, which the client plays too, else null. Units
 * start track 0 at construct and loop it; who passes which delta is the RE's
 * `driven_by` (time on aircraft, turrets and mounts; distance on a type-5 or
 * type-28 actor's mode-2 track). A track that holds, or a model whose track 0
 * is not a loop over every frame (the X1's), keeps frame 0.
 */
function morphOf(model: PaModel, what: string): Morph | null {
  const a = model.anim;
  if (!a || (a.kind !== "morph" && a.kind !== "skeleton")) return null;
  const track = a.tracks?.[0];
  if (!track || (track.mode !== 1 && track.mode !== 2)) return null;
  if (track.from !== 0 || track.to !== a.frames - 1) return null;
  // End action 0 follows the link; a chain of like tracks back to track 0 (Mp's
  // rotor is 0 -> 1 -> 0, both frames 0-2 at period 10) is one loop, since a
  // link keeps the clock and starts the next track at its first frame.
  const tracks = a.tracks ?? [];
  let at = track;
  for (let hops = 0; ; hops++) {
    const same =
      at.from === track.from &&
      at.to === track.to &&
      at.mode === track.mode &&
      at.period === track.period &&
      at.end === 0;
    if (!same || hops > tracks.length) {
      throw new Error(`${what}: track 0 runs over every frame but does not loop`);
    }
    const next = tracks.find((t) => t.track === at.link);
    if (!next) throw new Error(`${what}: track ${at.track} links to a missing track`);
    if (next.track === track.track) break;
    at = next;
  }
  if (track.driven_by !== "time" && track.driven_by !== "distance") {
    throw new Error(`${what}: nobody says what steps track 0`);
  }
  return { frames: a.frames, period: track.period, drivenBy: track.driven_by, source: a.kind };
}

function cobjName(cobj: number): string {
  return `obj_${String(cobj).padStart(3, "0")}`;
}

// --- texel fingerprint ----------------------------------------------------

const io = new NodeIO();

/**
 * Hash of every texel the model can sample under `offsets`: per triangle, the
 * texel box its UVs span (one texel of margin), shifted by each offset, on each
 * page it samples. Conservative — a box covers at least the triangle — so two
 * models that hash equal draw identically under every offset of the role.
 *
 * Every face counts, in whatever mode it draws (genUnitModels.ts keeps them
 * all), and so does every textured facer, whose corners take the same offset
 * (`cact_model_shade_face` adds it to every (u, v), RE model_shade.c
 * 0x00427f0d); only the RE's stand-ins for the facers (`extras.fcop.standin`)
 * sample nothing, since the pipeline drops them.
 */
async function texelFingerprint(path: string, offsets: readonly Uv[]): Promise<string> {
  const document = await io.read(path);
  const hasher = new Bun.CryptoHasher("sha256");
  const pages = new Map<
    unknown,
    { pixels: Uint8Array; width: number; height: number; mask: Uint8Array }
  >();
  const pageOf = (texture: Texture) => {
    let page = pages.get(texture);
    if (!page) {
      const image = texture.getImage();
      if (!image) throw new Error(`${path}: texture without image`);
      const decoded = decodePng(new Uint8Array(image));
      page = { ...decoded, mask: new Uint8Array(decoded.width * decoded.height) };
      pages.set(texture, page);
    }
    return page;
  };
  /** Marks the texel box of the (u, v) corners, under every offset. */
  const mark = (page: ReturnType<typeof pageOf>, corners: readonly (readonly number[])[]) => {
    let u0 = Number.POSITIVE_INFINITY;
    let u1 = Number.NEGATIVE_INFINITY;
    let v0 = Number.POSITIVE_INFINITY;
    let v1 = Number.NEGATIVE_INFINITY;
    for (const t of corners) {
      // obj_mesh writes (texel + 0.5) / 256.
      const tu = t[0] * page.width - 0.5;
      const tv = t[1] * page.height - 0.5;
      u0 = Math.min(u0, tu);
      u1 = Math.max(u1, tu);
      v0 = Math.min(v0, tv);
      v1 = Math.max(v1, tv);
    }
    for (const o of offsets) {
      const x0 = Math.max(0, Math.floor(u0) - 1 + o.u);
      const x1 = Math.min(page.width - 1, Math.ceil(u1) + 1 + o.u);
      const y0 = Math.max(0, Math.floor(v0) - 1 + o.v);
      const y1 = Math.min(page.height - 1, Math.ceil(v1) + 1 + o.v);
      for (let y = y0; y <= y1; y++)
        page.mask.fill(1, y * page.width + x0, y * page.width + x1 + 1);
    }
  };
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      const fcop = (material?.getExtras() as { fcop?: { standin?: boolean } } | undefined)?.fcop;
      if (fcop?.standin) continue;
      const texture = material?.getBaseColorTexture();
      const uv = prim.getAttribute("TEXCOORD_0");
      if (!texture || !uv) continue;
      const page = pageOf(texture);
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : uv.getCount();
      for (let i = 0; i + 2 < count; i += 3) {
        const corners = [0, 1, 2].map((k) => {
          const t = [0, 0];
          uv.getElement(indices ? indices.getScalar(i + k) : i + k, t);
          return t;
        });
        mark(page, corners);
      }
    }
  }
  const node = document.getRoot().listNodes()[0];
  const facers =
    (node?.getExtras() as { fcop?: { facers?: { texture?: number | null; uv?: number[][] }[] } })
      ?.fcop?.facers ?? [];
  const textures = document.getRoot().listTextures();
  for (const f of facers) {
    if (f.texture === null || f.texture === undefined || !f.uv) continue;
    const texture = textures[f.texture];
    if (!texture) throw new Error(`${path}: a facer names texture ${f.texture}`);
    mark(pageOf(texture), f.uv);
  }
  for (const page of pages.values()) {
    hasher.update(`${page.width}x${page.height}|`);
    for (let i = 0; i < page.mask.length; i++) {
      if (page.mask[i] === 0) continue;
      hasher.update(`${i}:`);
      hasher.update(page.pixels.subarray(i * 4, i * 4 + 4));
    }
  }
  return hasher.digest("hex").slice(0, 16);
}

// --- main -----------------------------------------------------------------

interface ArenaRead {
  arena: FcopArena;
  pa: PaModels;
  /** Roles with Cobj ids still in the arena's own numbering. */
  units: ArenaUnits;
  uses: Map<number, Use>;
}

function readArena(arena: FcopArena, reRepo: string): ArenaRead {
  const { mapId, mission } = arena;
  const pa = JSON.parse(
    readFileSync(join(reRepo, "extracted", "logic", mission, "pa_models.json"), "utf8"),
  ) as PaModels;
  if (pa.map !== mission) throw new Error(`${mapId}: pa_models is ${pa.map}`);
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as Logic;
  const map = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "sim", "maps", `${mapId}.json`), "utf8"),
  ) as MapBits;

  const uses = new Map<number, Use>();
  const use = (cobj: number, treatment: Treatment, uv: SideUv): string => {
    const prev = uses.get(cobj);
    if (prev && prev.treatment !== treatment) {
      throw new Error(`${mapId}: Cobj ${cobj} is both a ${prev.treatment} and a ${treatment}`);
    }
    const entry = prev ?? { cobj, treatment, offsets: [] };
    for (const o of uv) {
      if (!entry.offsets.some((p) => p.u === o.u && p.v === o.v)) entry.offsets.push(o);
    }
    uses.set(cobj, entry);
    // Rewritten to the shared file once every arena is read.
    return `${mission}:${cobj}`;
  };

  const sided = (name: string) => {
    const role = only(pa.roles[name], `${mapId} ${name}`);
    const uv = sideUv(role, `${mapId} ${name}`);
    return { role, uv };
  };

  const tank = sided("tank");
  const jet = sided("jet");
  const fortress = sided("flying_fortress");
  const dread = sided("dreadnought");
  const hull = partCobj(dread.role, "hull", `${mapId} dreadnought`);
  // The hull's frames, as its track counts them (morphOf): by_frame[k] is the
  // point while the hull shows frame k, k the client's morph frame.
  const hullFrames = pa.models[String(hull)]?.anim?.frames ?? 1;
  const guns = (dread.role.guns ?? []).map((g, i) => {
    if (g.gun !== i) throw new Error(`${mapId}: Dreadnought gun ${g.gun} out of order`);
    const what = `${mapId} gun ${i}`;
    const point = vec3(g.hull_point.glb_xyz, what);
    const frames = g.hull_point.by_frame;
    if ((frames?.length ?? 1) !== hullFrames) {
      throw new Error(`${what}: ${frames?.length ?? 1} point frames, the hull has ${hullFrames}`);
    }
    const byFrame = frames
      ? frames.map((p, k) => {
          if (!p) throw new Error(`${what}: no point in hull frame ${k}`);
          return vec3(p, `${what} frame ${k}`);
        })
      : null;
    if (byFrame?.[0].some((c, j) => c !== point[j])) {
      throw new Error(`${what}: frame 0 is not the point`);
    }
    return { model: use(g.cobj, "part", dread.uv), point, byFrame };
  });
  if (guns.length !== 4) throw new Error(`${mapId}: ${guns.length} Dreadnought guns`);

  const turret = (role: PaRole, uv: SideUv, what: string): Turret => {
    if (!role.gun_point) throw new Error(`${what}: no gun point`);
    return {
      gun: use(partCobj(role, "gun", what), "part", uv),
      base: use(partCobj(role, "base", what), "part", uv),
      gunPoint: vec3(role.gun_point.glb_xyz, `${what} gun point`),
      uv,
    };
  };
  const base = sided("base_turret");
  const neutralRoles = pa.roles.neutral_turret ?? [];
  const neutralTurrets = neutralRoles.map((role, i) => {
    const what = `${mapId} neutral turret ${i}`;
    const capture = only(role.capture, `${what} capture`);
    for (const [cobj, bySide] of Object.entries(capture.per_model ?? {})) {
      for (const [side, w] of Object.entries(bySide)) {
        if (w.carry_u || w.wrap_v)
          throw new Error(`${what}: Cobj ${cobj} side ${side} carries or wraps`);
      }
    }
    const neutral = sideUv(role, what)[0];
    const after = capture.uv_after_capture;
    const uv: SideUv = [neutral, after["1"] ?? ZERO, after["2"] ?? ZERO];
    return { ...turret(role, uv, what), spots: neutralSpots(arena, role, logic, map) };
  });
  const covered = neutralTurrets.flatMap((t) => t.spots).sort((a, b) => a - b);
  if (covered.length !== map.turretSpots.length || covered.some((k, i) => k !== i)) {
    throw new Error(
      `${mapId}: the neutral turret sets cover ${covered.length} of ${map.turretSpots.length} spots`,
    );
  }

  const captains = pa.roles.sky_captain ?? [];
  const byLevel: string[] = [];
  let captainUv: SideUv | null = null;
  for (const role of captains) {
    const uv = sideUv(role, `${mapId} sky captain`);
    if (captainUv && JSON.stringify(captainUv) !== JSON.stringify(uv)) {
      throw new Error(`${mapId}: the Sky Captain's levels differ in their offset`);
    }
    captainUv = uv;
    const body = use(partCobj(role, "body", `${mapId} sky captain`), "unit", uv);
    for (const level of role.levels ?? []) byLevel[level] = body;
  }
  for (let level = 0; level < 10; level++) {
    if (!byLevel[level]) throw new Error(`${mapId}: no Sky Captain for level ${level}`);
  }

  const units: ArenaUnits = {
    mission,
    sides: sidesOf(arena, logic, map),
    tank: { model: use(partCobj(tank.role, "body", "tank"), "unit", tank.uv), uv: tank.uv },
    jet: { model: use(partCobj(jet.role, "body", "jet"), "unit", jet.uv), uv: jet.uv },
    fortress: {
      model: use(partCobj(fortress.role, "body", "fortress"), "unit", fortress.uv),
      uv: fortress.uv,
    },
    dreadnought: { hull: use(hull, "part", dread.uv), uv: dread.uv, guns },
    baseTurret: turret(base.role, base.uv, `${mapId} base turret`),
    neutralTurrets,
    skyCaptain: { byLevel, uv: captainUv ?? [ZERO, ZERO, ZERO] },
    x1: { uv: sideUv(only(pa.roles.x1alpha, `${mapId} x1alpha`), `${mapId} x1alpha`) },
    outpostFlag: outpostFlagOf(pa, mapId),
  };
  return { arena, pa, units, uses };
}

function format(files: readonly ModelFile[], arenas: readonly ArenaRead[]): string {
  const json = (v: unknown): string => JSON.stringify(v);
  const uvs = (uv: SideUv): string => `[${uv.map((o) => `{ u: ${o.u}, v: ${o.v} }`).join(", ")}]`;
  const vec = (p: Vec3): string => `[${p.join(", ")}]`;
  const lines: string[] = [];
  lines.push(
    "// GENERATED by tools/generators/fcopUnits.ts (bun run gen:paunits) — do not edit by hand.",
    "//",
    "// Each arena's Precinct Assault units as the original draws them, read from",
    "// the RE's extracted/logic/<Mission>/pa_models.json (RE docs/formats/pa-models.md):",
    "// the arena's own Cobj for every role, the team-colour offsets, the attach",
    "// points, Hk's second neutral turret set, the Sky Captain by level and the",
    "// AnmD track each model plays. Files live under /models/units/<file>.glb",
    "// (gen:units); arenas whose model and sampled texels are identical share one.",
    "",
    "/** A texture offset in texels of the 256 x 256 page (RE `draw_set_uv_offset`). */",
    "export interface TexelUv {",
    "  readonly u: number;",
    "  readonly v: number;",
    "}",
    "",
    "/** Offset by the original's side: [nobody's, side 1 (red), side 2 (blue)]. */",
    "export type SideUv = readonly [TexelUv, TexelUv, TexelUv];",
    "",
    "/** A point in the model's own glb frame (metres, +z forward). */",
    "export type ModelPoint = readonly [number, number, number];",
    "",
    "/**",
    " * The role's kind: a `unit` (tank, jet, Flying Fortress, Sky Captain) drops",
    " * its FX attachments; a `part` is placed by attach points and turns about its",
    " * own origin. gen:units keeps the original's origin for both: a part's attach",
    " * points and pivot are measured from it, and a unit's is the sim's position.",
    " */",
    'export type UnitTreatment = "unit" | "part";',
    "",
    "/**",
    " * Track 0 of the model's AnmD, looping over every frame (RE `cact_anim_step`):",
    " * one frame per `period` units of the delta the actor steps it by — 1/300 s",
    " * when `time`, one world unit (1/8192 m) travelled when `distance` (RE type5.c",
    " * 469-472). A `skeleton` model's frames are joint poses gen:units bakes into",
    " * morph targets; a `morph` model's are its own targets. Frame k + 1 is target k.",
    " */",
    "export interface UnitMorph {",
    "  readonly frames: number;",
    "  readonly period: number;",
    '  readonly drivenBy: "time" | "distance";',
    '  readonly source: "morph" | "skeleton";',
    "}",
    "",
    "export interface UnitModelFile {",
    "  /** Under /models/units/, without `.glb`: `<mapId of its first arena>/obj_NNN`. */",
    "  readonly file: string;",
    "  readonly mission: string;",
    "  readonly cobj: number;",
    "  readonly treatment: UnitTreatment;",
    "  /** Relative to tools/generators/units/raw/. */",
    "  readonly raw: string;",
    "  /** The RE's payload hash (`sha256_16`). */",
    "  readonly payload: string;",
    "  /** The track the client plays, else null (frame 0). */",
    "  readonly morph: UnitMorph | null;",
    "  /** The arenas that draw it. */",
    "  readonly usedBy: readonly string[];",
    "}",
    "",
    "export interface TurretModels {",
    "  readonly gun: string;",
    "  readonly base: string;",
    "  /** The base's attach point 0, where the gun stands (RE turret.c 913-918). */",
    "  readonly gunPoint: ModelPoint;",
    "  readonly uv: SideUv;",
    "}",
    "",
    "export interface ArenaUnits {",
    "  readonly mission: string;",
    "  /** The original's side (1 or 2) of Metropolis team 0 and team 1. */",
    "  readonly sides: readonly [number, number];",
    "  readonly tank: { readonly model: string; readonly uv: SideUv };",
    "  readonly jet: { readonly model: string; readonly uv: SideUv };",
    "  readonly fortress: { readonly model: string; readonly uv: SideUv };",
    "  readonly dreadnought: {",
    "    readonly hull: string;",
    "    readonly uv: SideUv;",
    "    /**",
    "     * Gun i on the hull's attach point i (RE mount.c 526-546), read in the",
    "     * hull's current frame every tick: `byFrame[k]` while the hull shows",
    "     * frame k of its track, `point` (frame 0) when it has one frame (null).",
    "     */",
    "    readonly guns: readonly {",
    "      readonly model: string;",
    "      readonly point: ModelPoint;",
    "      readonly byFrame: readonly ModelPoint[] | null;",
    "    }[];",
    "  };",
    "  readonly baseTurret: TurretModels;",
    "  /** By capture state: [neutral, taken by side 1, taken by side 2] (RE turret.c 1319-1342). */",
    "  readonly neutralTurrets: readonly (TurretModels & { readonly spots: readonly number[] })[];",
    "  /** The model per level 0-9 (one record per level band). */",
    "  readonly skyCaptain: { readonly byLevel: readonly string[]; readonly uv: SideUv };",
    "  readonly x1: { readonly uv: SideUv };",
    "  /**",
    "   * The outpost flags (scenery, render/props.ts): [unclaimed, claimed by side 1,",
    "   * claimed by side 2] — set, not added, by the claim script (RE mission_frame.c 1102-1107).",
    "   */",
    "  readonly outpostFlag: { readonly cobj: number; readonly uv: SideUv };",
    "}",
    "",
    "export const UNIT_MODEL_FILES: readonly UnitModelFile[] = [",
  );
  for (const f of files) {
    lines.push(
      `  { file: ${json(f.file)}, mission: ${json(f.mission)}, cobj: ${f.cobj}, treatment: ${json(f.treatment)}, raw: ${json(f.raw)}, payload: ${json(f.payload)}, morph: ${
        f.morph
          ? `{ frames: ${f.morph.frames}, period: ${f.morph.period}, drivenBy: ${json(f.morph.drivenBy)}, source: ${json(f.morph.source)} }`
          : "null"
      }, usedBy: ${json(f.usedBy)} },`,
    );
  }
  lines.push("];", "", "export const ARENA_UNITS: Readonly<Record<string, ArenaUnits>> = {");
  for (const { arena, units: u } of arenas) {
    const turret = (t: Turret) =>
      `gun: ${json(t.gun)}, base: ${json(t.base)}, gunPoint: ${vec(t.gunPoint)}, uv: ${uvs(t.uv)}`;
    lines.push(
      `  ${json(arena.mapId)}: {`,
      `    mission: ${json(u.mission)},`,
      `    sides: [${u.sides.join(", ")}],`,
      `    tank: { model: ${json(u.tank.model)}, uv: ${uvs(u.tank.uv)} },`,
      `    jet: { model: ${json(u.jet.model)}, uv: ${uvs(u.jet.uv)} },`,
      `    fortress: { model: ${json(u.fortress.model)}, uv: ${uvs(u.fortress.uv)} },`,
      "    dreadnought: {",
      `      hull: ${json(u.dreadnought.hull)},`,
      `      uv: ${uvs(u.dreadnought.uv)},`,
      "      guns: [",
      ...u.dreadnought.guns.map(
        (g) =>
          `        { model: ${json(g.model)}, point: ${vec(g.point)}, byFrame: ${
            g.byFrame ? `[${g.byFrame.map(vec).join(", ")}]` : "null"
          } },`,
      ),
      "      ],",
      "    },",
      `    baseTurret: { ${turret(u.baseTurret)} },`,
      "    neutralTurrets: [",
      ...u.neutralTurrets.map((t) => `      { ${turret(t)}, spots: ${json(t.spots)} },`),
      "    ],",
      `    skyCaptain: { byLevel: ${json(u.skyCaptain.byLevel)}, uv: ${uvs(u.skyCaptain.uv)} },`,
      `    x1: { uv: ${uvs(u.x1.uv)} },`,
      `    outpostFlag: { cobj: ${u.outpostFlag.cobj}, uv: ${uvs(u.outpostFlag.uv)} },`,
      "  },",
    );
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

async function main(): Promise<void> {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  const check = process.argv.includes("--check");
  const ordered = SHARE_ORDER.map((id) => {
    const a = FCOP_ARENAS.find((x) => x.mapId === id);
    if (!a) throw new Error(`SHARE_ORDER names unknown arena ${id}`);
    return a;
  });
  if (ordered.length !== FCOP_ARENAS.length) throw new Error("SHARE_ORDER misses an arena");
  const reads = ordered.map((a) => readArena(a, reRepo));

  // Share: payload hash + texel fingerprint under the role's offsets.
  const files: ModelFile[] = [];
  const byKey = new Map<string, ModelFile>();
  const fileOf = new Map<string, string>(); // `${mission}:${cobj}` -> file
  for (const read of reads) {
    const { mapId, mission } = read.arena;
    for (const use of [...read.uses.values()].sort((a, b) => a.cobj - b.cobj)) {
      const model = read.pa.models[String(use.cobj)];
      if (!model) throw new Error(`${mapId}: no model entry for Cobj ${use.cobj}`);
      const glb = join(reRepo, "extracted", "objects", mission, `${cobjName(use.cobj)}.glb`);
      const offsets = [...use.offsets].sort((a, b) => a.u - b.u || a.v - b.v);
      const key = [
        model.sha256_16,
        use.treatment,
        offsets.map((o) => `${o.u},${o.v}`).join(";"),
        await texelFingerprint(glb, offsets),
      ].join("|");
      let file = byKey.get(key);
      if (!file) {
        file = {
          file: `${mapId}/${cobjName(use.cobj)}`,
          mission,
          cobj: use.cobj,
          treatment: use.treatment,
          raw: `fcop-units/${mission}/${cobjName(use.cobj)}.glb`,
          payload: model.sha256_16,
          morph: morphOf(model, `${mapId} Cobj ${use.cobj}`),
          usedBy: [],
        };
        byKey.set(key, file);
        files.push(file);
      }
      file.usedBy.push(mapId);
      fileOf.set(`${mission}:${use.cobj}`, file.file);
    }
  }

  // Rewrite every role's `<Mission>:<cobj>` to its file.
  const resolve = (ref: string): string => {
    const f = fileOf.get(ref);
    if (!f) throw new Error(`unresolved model ${ref}`);
    return f;
  };
  for (const { units: u } of reads) {
    u.tank.model = resolve(u.tank.model);
    u.jet.model = resolve(u.jet.model);
    u.fortress.model = resolve(u.fortress.model);
    u.dreadnought.hull = resolve(u.dreadnought.hull);
    for (const g of u.dreadnought.guns) g.model = resolve(g.model);
    for (const t of [u.baseTurret, ...u.neutralTurrets]) {
      t.gun = resolve(t.gun);
      t.base = resolve(t.base);
    }
    u.skyCaptain.byLevel = u.skyCaptain.byLevel.map(resolve);
  }

  const text = biomeFormat(format(files, reads));
  let stale = 0;
  if (check) {
    const committed = existsSync(OUT_TS) ? readFileSync(OUT_TS, "utf8") : "";
    if (committed !== text) {
      console.log(`${OUT_TS} is stale`);
      stale++;
    }
  } else {
    rmSync(join(RAW_DIR, "fcop-units"), { recursive: true, force: true });
    writeFileSync(OUT_TS, text);
  }
  for (const f of files) {
    const from = join(reRepo, "extracted", "objects", f.mission, `${cobjName(f.cobj)}.glb`);
    const to = join(RAW_DIR, f.raw);
    if (!check) {
      mkdirSync(join(to, ".."), { recursive: true });
      copyFileSync(from, to);
    } else if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) {
      console.log(`${to} is not ${from}`);
      stale++;
    }
  }
  // The weapons' models: Mp's exports under the names manifest.ts gives them.
  let weapons = 0;
  for (const name of readdirSync(join(RAW_DIR, "fcop-fx")).sort()) {
    const m = /^mp-obj(\d{3})-.+\.glb$/.exec(name);
    if (!m) continue;
    weapons++;
    const from = join(reRepo, "extracted", "objects", "Mp", `obj_${m[1]}.glb`);
    const to = join(RAW_DIR, "fcop-fx", name);
    if (!check) copyFileSync(from, to);
    else if (!readFileSync(to).equals(readFileSync(from))) {
      console.log(`${to} is not ${from}`);
      stale++;
    }
  }
  for (const { arena, units: u } of reads) {
    console.log(
      `${arena.mapId} (${arena.mission}): sides ${u.sides.join("/")}, ` +
        `${files.filter((f) => f.usedBy[0] === arena.mapId).length} own file(s), ` +
        `${files.filter((f) => f.usedBy.includes(arena.mapId) && f.usedBy[0] !== arena.mapId).length} shared`,
    );
  }
  console.log(
    `${files.length} unit model files and ${weapons} weapon models${check ? " checked" : " written"}`,
  );
  if (stale > 0) {
    console.error(`${stale} stale unit raw(s) or table: run bun run gen:paunits`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
