// Each arena's own units (fcop-fidelity.md G1; assets.md §4): the Cobj the
// arena's own mission draws for every role, with that mission's texture pages
// (arenaUnits.generated.ts, `bun run gen:paunits` + `bun run gen:units`).
//
// Until Phase 14 wave 5 the client loaded Mp's units once at boot and every
// arena drew them. A Cobj id is its own container's, though: Hk's tank is
// another model on page 6, Ovmp's units sample its page 4, and every one of
// Joke's is a model of its own. So the models are now loaded per arena — on
// the first arena and on every arena swap (main.ts buildArenaGroup), which is
// also what a match starts on — and swapped into the same greybox buckets as
// before. A file is fetched once per session and kept: two arenas often share
// one (gen:paunits shares where payload and sampled texels are identical), and
// the whole set is 64 small files.
//
// The turrets are two parts, as the original's are: the base stands at the
// record's rest yaw and the gun stands on the base's attach point 0 and turns
// (RE turret.c 769-792, 913-918). One greybox bucket per turret mode keeps
// drawing the gun, and a part bucket per mode draws the base. Hk's 43/44 set is
// a second neutral turret model, with a gun and a base bucket of its own. The
// Dreadnought carries four guns on its hull's attach points 0-3 (RE mount.c
// 526-546), each its own actor in the original, turning on its point by its
// own yaw (the sim's gun snapshot); they draw from a part bucket per gun
// model. The mount reads the point in the hull's current frame every tick, so
// on Joke's walking hull each gun rides the frame the hull shows (gunPointOf).
// A turret's gun is placed once, on frame 0 (RE turret.c 913-918), and no
// base animates. These are declared exceptions to "one InstancedMesh per archetype"
// (assets.md §4): the parts have their own transforms in the original too.
//
// Team colour is the original's: a texture offset per instance onto the side's
// half of the page (render/teamUv.ts, fcop-fidelity.md G4), from the arena's
// table — by the original's side, which gen:paunits pairs with each Metropolis
// team (team N is side N + 1 on every arena, render/sides.ts), and for a NeutralTurret by
// its capture state. The greybox stand-ins (?render=greybox, or a model still
// loading) keep the team tint, which is all a box can show.
//
// The models move as the original's do (fcop-fidelity.md G9): each plays its
// AnmD track 0 from where it was built, by time or by the distance it travels
// (render/unitTracks.ts). The outpost's console has no model here: it is
// scenery the claim destroys (render/props.ts); its entity still reports the
// outpost's owner (`outpostSides`), and its bucket draws only the greybox box.
//
// Renderer rules: `place` runs per entity per frame and allocates nothing; the
// loaders run at arena build and may.

import { ARCHETYPE, type MapData, TURRET_DEFENSE } from "@metropolis/sim";
import * as THREE from "three";
import {
  ARENA_UNITS,
  type ArenaUnits,
  type ModelPoint,
  type SideUv,
  type TurretModels,
  UNIT_MODEL_FILES,
  type UnitMorph,
} from "./arenaUnits.generated";
import type { Bucket, GreyboxMeshes } from "./greybox";
import { SIDE_RAMPS } from "./palette";
import { sideOfTeam } from "./sides";
import { atlasOffset, createTeamUvAttribute, TEAM_UV_ATTR, writeTeamUv } from "./teamUv";
import { loadUnitAsset, type UnitAsset } from "./unitMeshes";
import { TrackClock } from "./unitTracks";

/** The arena whose units a map without an original mission draws (test-128). */
const FALLBACK_ARENA = "la-cantina";

/** The arena's unit table; a map the RE has no mission for draws Mp's. */
export function arenaUnitsFor(mapId: string): ArenaUnits {
  const own = ARENA_UNITS[mapId];
  if (own) return own;
  const fallback = ARENA_UNITS[FALLBACK_ARENA];
  // Team 0 is side 1 on every arena (render/sides.ts), a map of no mission too.
  return { ...fallback, sides: [1, 2] };
}

/** The arena whose units are on screen, and its map id. */
let current: ArenaUnits = arenaUnitsFor(FALLBACK_ARENA);
let currentMap = FALLBACK_ARENA;

/**
 * The original's side a snapshot team plays on the arena on screen: 1 or 2 for
 * a team, 0 (nobody's) for anything neutral (render/sides.ts: team 0 is side 1
 * on every arena). This is the team-colour key.
 */
export function teamSide(team: number): number {
  return sideOfTeam(currentMap, team);
}

/** The greybox stand-ins' tint by side: neutral, red, blue (palette.ts). */
const SIDE_COLORS: readonly THREE.Color[] = SIDE_RAMPS.map((r) => new THREE.Color(r.base));
/** The instance colour of a bucket drawn in its model's own colours. */
const UNTINTED = new THREE.Color(1, 1, 1);

/**
 * Writes an X1-Alpha slot's offset (render/avatarRig.ts): u 128 for side 1,
 * none for side 2 (RE pa_models.json `x1alpha`), on the mesh's own atlas.
 * `cloakV` (texels, -1 for none) replaces the side's v while the cloak runs:
 * the frame clock `>> 2 & 0x3f` (RE player_partner.c 289-293).
 */
export function writeX1Uv(
  mesh: THREE.InstancedMesh,
  slot: number,
  side: number,
  cloakV = -1,
): void {
  const o = current.x1.uv[side];
  const map = (mesh.material as THREE.MeshStandardMaterial).map;
  atlasOffset(map, o.u, cloakV >= 0 ? cloakV : o.v, scratchUv, 0);
  writeTeamUv(mesh, slot, scratchUv[0], scratchUv[1]);
}

/**
 * A point of a model's glb frame (+z forward) in the frame its bucket draws
 * it in: unitMeshes.ts bakes a quarter turn about +y into every unit's
 * geometry (`rotateY(PI / 2)`: x' = z, z' = -x) so +z lands on the sim's +x.
 */
export function bakedPoint(p: ModelPoint, out: THREE.Vector3): THREE.Vector3 {
  return out.set(p[2], p[1], -p[0]);
}

/**
 * Lookup key for a turret by where it stands. Turrets never move, and the
 * snapshot carries no spot index, so the client finds a turret's rest yaw and
 * model set by its position: 1/16 m cells, built from the map at float32 the
 * way the snapshot carries it.
 */
export function spotKey(x: number, y: number): number {
  return Math.round(Math.fround(x) * 16) * 65536 + Math.round(Math.fround(y) * 16);
}

/** The arena's turret placements: rest yaw and neutral model set by spotKey. */
export interface TurretSpots {
  readonly restYaw: Map<number, number>;
  readonly neutralSet: Map<number, number>;
}

export function turretSpotsOf(map: MapData, units: ArenaUnits): TurretSpots {
  const restYaw = new Map<number, number>();
  const neutralSet = new Map<number, number>();
  for (const base of map.bases) {
    for (const t of base.turrets) restYaw.set(spotKey(t.x, t.y), t.yaw);
  }
  for (const plate of map.outpostPlates) {
    for (const t of plate.turrets) restYaw.set(spotKey(t.x, t.y), t.yaw);
  }
  map.turretSpots.forEach((s, k) => {
    restYaw.set(spotKey(s.x, s.y), map.turretYaw[k] ?? 0);
  });
  units.neutralTurrets.forEach((set, i) => {
    for (const k of set.spots) {
      const s = map.turretSpots[k];
      if (s) neutralSet.set(spotKey(s.x, s.y), i);
    }
  });
  return { restYaw, neutralSet };
}

/**
 * Gun i's matrix on its hull: the hull's instance matrix times a translation
 * to the hull's attach point times the gun's `yaw` about +y, so the gun turns
 * about its own origin on the point (RE mount.c 526-546). `yaw` is relative to
 * the hull, radians in the entity yaw's sense (writeGunSnapshot; three turns
 * by -yaw, as main.ts turns the hull). No pitch: render/dreadnoughtGuns.ts.
 */
export function gunMatrix(
  hull: THREE.Matrix4,
  point: THREE.Vector3,
  yaw: number,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  scratchGun.makeRotationY(-yaw).setPosition(point.x, point.y, point.z);
  return out.multiplyMatrices(hull, scratchGun);
}

/**
 * Every gun's point in every frame of its hull's track, in the baked frame
 * (bakedPoint): `[frame][gun][x, y, z]`, frame k at row k. A hull of one frame
 * is one row, the guns' `point`. Built at arena load.
 */
export interface GunPointTable {
  readonly frames: number;
  readonly xyz: Float32Array;
}

export function gunPointTable(guns: ArenaUnits["dreadnought"]["guns"]): GunPointTable {
  const frames = guns[0]?.byFrame?.length ?? 1;
  const xyz = new Float32Array(frames * 4 * 3);
  const at = new THREE.Vector3();
  for (let i = 0; i < guns.length && i < 4; i++) {
    const rows = guns[i].byFrame;
    if ((rows?.length ?? 1) !== frames) throw new Error(`gun ${i}: not ${frames} frames`);
    for (let k = 0; k < frames; k++) {
      bakedPoint(rows ? rows[k] : guns[i].point, at);
      at.toArray(xyz, (k * 4 + i) * 3);
    }
  }
  return { frames, xyz };
}

/**
 * Gun `gun`'s point while its hull shows `frame` (RE `cact_model_point` on the
 * hull's +0x70, read by `cact_mount_step` every tick). The morph steps whole
 * frames, so the point does too; a frame past the table is frame 0's.
 */
export function gunPointOf(
  table: GunPointTable,
  gun: number,
  frame: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const k = frame >= 0 && frame < table.frames ? frame : 0;
  const o = (k * 4 + gun) * 3;
  return out.set(table.xyz[o], table.xyz[o + 1], table.xyz[o + 2]);
}

interface TurretSet {
  readonly gun: Bucket;
  readonly base: Bucket;
  /** The gun's place on the base, in the baked frame. Valid once `ready`. */
  readonly point: THREE.Vector3;
  ready: boolean;
}

export interface ArenaUnitsRenderer {
  /**
   * Takes `map` as the arena on screen (its sides, turret and outpost spots)
   * and, with `models`, points every unit bucket at its own models: async,
   * fire and forget. Without (?render=greybox) the stand-ins stay.
   */
  load(map: MapData, cancelled: () => boolean, models: boolean): void;
  /**
   * Zeroes the part buckets and advances the morph clock by the sim's own
   * time (a paused match stops every morph). Call before the entity sweep.
   */
  begin(simDtSec: number): void;
  /** The bucket an entity draws in: Hk's second neutral set has its own. */
  route(bucket: Bucket, archetype: number, aux: number, x: number, y: number): Bucket;
  /**
   * Writes one instance (and its parts) at three-space `pos`, turned by
   * `quat`, scaled by `scale`, coloured for `team`. `x`/`y`/`yaw` are the
   * entity's sim position and heading.
   */
  place(
    bucket: Bucket,
    slot: number,
    /** The entity id: whose track this is (each starts where it was built). */
    id: number,
    archetype: number,
    team: number,
    x: number,
    y: number,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    scale: THREE.Vector3,
    /**
     * A Juggernaut's gun yaws relative to its hull, one per gun (main.ts
     * interpolates writeGunSnapshot, render/dreadnoughtGuns.ts). Read for a
     * Juggernaut only.
     */
    guns: Float32Array,
  ): void;
  /** Publishes the part buckets' counts and matrices. Call after the sweep. */
  end(): void;
  /**
   * The texture offset `bucket`'s model draws `team` with, atlas units, into
   * `out` (u, v): what a face of it carries when it leaves the model (the
   * shatter, render/fx/shatter.ts). False for a stand-in with no model.
   */
  teamUv(bucket: Bucket, team: number, out: Float32Array): boolean;
  /**
   * Draws the Sky Captain of `level` (0-9, the match's Warden difficulty - 1):
   * one model per level band, as the original loads one record per band (RE
   * pa_models.json `sky_captain` levels; Mp 54 / 56 / 57 / 58). Per frame; a
   * swap only when the level changes.
   */
  setCaptainLevel(level: number): void;
  /**
   * The side (0 nobody's, 1, 2) holding each outpost, by map.outpostSpots
   * index, as the sweep last saw its console. For render/props.ts' flags.
   */
  readonly outpostSides: Int8Array;
}

/**
 * A bucket showing a model: its per-instance offset attribute and the offset
 * per side in atlas units, [nobody's, side 1, side 2] as u, v pairs.
 */
interface UvBinding {
  readonly attr: THREE.InstancedBufferAttribute;
  readonly bySide: Float32Array;
}

/**
 * A bucket showing a morph (RE pa_models.json `anim`): per instance a row of
 * the mesh's morph texture, frame k + 1 being target k at weight 1 (the
 * original steps frames, it does not blend them).
 */
interface MorphBinding {
  readonly texture: THREE.DataTexture;
  /** Floats per row: the base influence, then one per target. */
  readonly len: number;
  readonly track: UnitMorph;
  dirty: boolean;
}

/** The kept morph of each file, from the table. */
const MORPH_OF = new Map(UNIT_MODEL_FILES.map((f) => [f.file, f.morph]));

// Frame-loop scratch (renderer rule 1).
const scratchUv = new Float32Array(2);
const scratchGun = new THREE.Matrix4();
const scratchGunOut = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const scratchMatrix = new THREE.Matrix4();
const scratchRest = new THREE.Quaternion();
const scratchAt = new THREE.Vector3();
const scratchGunPoint = new THREE.Vector3();

/** One file per session: its geometry is already turned onto the sim's +x. */
const assets = new Map<string, Promise<UnitAsset>>();

function assetOf(file: string): Promise<UnitAsset> {
  let pending = assets.get(file);
  if (!pending) {
    pending = loadUnitAsset(file).then((asset) => {
      // Models are authored +Z forward (assets.md §4); the sim/greybox frame
      // is +X forward, so bake the quarter turn into the geometry once — and
      // into a morph's deltas, which BufferGeometry.rotateY leaves alone.
      asset.geometry.rotateY(Math.PI / 2);
      const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2);
      for (const delta of asset.geometry.morphAttributes.position ?? []) delta.applyMatrix4(turn);
      return asset;
    });
    // A failed file may be retried on the next arena build.
    pending.catch(() => assets.delete(file));
    assets.set(file, pending);
  }
  return pending;
}

function partBucket(scene: THREE.Scene, capacity: number): Bucket {
  // Empty until its model lands: a part has no greybox of its own (the gun's
  // bucket draws the whole greybox turret).
  const mesh = new THREE.InstancedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ flatShading: true }),
    capacity,
  );
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  return { mesh, tintCache: new Int8Array(capacity).fill(-2), count: 0 };
}

/**
 * Team colour for one slot, written only when its side changes (the tint
 * cache's job): with a model, the side's texture offset; on a greybox
 * stand-in, the side's tint. A swap clears the cache.
 */
function colour(bucket: Bucket, binding: UvBinding | undefined, slot: number, team: number): void {
  const side = teamSide(team);
  if (bucket.tintCache[slot] === side) return;
  bucket.tintCache[slot] = side;
  if (binding) {
    const a = binding.attr.array as Float32Array;
    a[slot * 2] = binding.bySide[side * 2];
    a[slot * 2 + 1] = binding.bySide[side * 2 + 1];
    binding.attr.needsUpdate = true;
    return;
  }
  // A model drawn in its own colours (a world round, Bucket.untinted) has no side.
  bucket.mesh.setColorAt(slot, bucket.untinted ? UNTINTED : SIDE_COLORS[side]);
  if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
}

/**
 * The model's geometry for one bucket: the cached attributes shared, plus the
 * bucket's own per-instance offset. Two buckets may show one file (Joke's
 * Cobj 21 is both turrets' base), and an instanced attribute is per mesh.
 */
function wrapGeometry(
  source: THREE.BufferGeometry,
  attr: THREE.InstancedBufferAttribute,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(source.attributes)) g.setAttribute(name, source.attributes[name]);
  g.setIndex(source.index);
  g.morphAttributes = source.morphAttributes;
  g.morphTargetsRelative = source.morphTargetsRelative;
  g.setAttribute(TEAM_UV_ATTR, attr);
  return g;
}

/** Claims the next slot of a part bucket, or -1 when it is full (said once). */
function claim(bucket: Bucket, what: string): number {
  const slot = bucket.count;
  if (slot >= bucket.tintCache.length) {
    if (!bucket.overflowed) {
      bucket.overflowed = true;
      console.error(`[arenaUnits] ${what} bucket full at ${bucket.tintCache.length}`);
    }
    return -1;
  }
  bucket.count = slot + 1;
  return slot;
}

export function createArenaUnits(scene: THREE.Scene, greybox: GreyboxMeshes): ArenaUnitsRenderer {
  const turretCap = greybox.turretStandard.tintCache.length;
  const defense: TurretSet = {
    gun: greybox.turretDefense,
    base: partBucket(scene, turretCap),
    point: new THREE.Vector3(),
    ready: false,
  };
  const neutral: TurretSet = {
    gun: greybox.turretStandard,
    base: partBucket(scene, turretCap),
    point: new THREE.Vector3(),
    ready: false,
  };
  // Hk's second NeutralTurret set (43/44). Empty on every other arena.
  const neutralB: TurretSet = {
    gun: partBucket(scene, turretCap),
    base: partBucket(scene, turretCap),
    point: new THREE.Vector3(),
    ready: false,
  };
  // The Dreadnought's guns: one bucket per distinct gun model (two on every
  // arena, guns 0/1 and 2/3), each with room for every gun of every hull.
  const hullCap = greybox.juggernaut.tintCache.length;
  const gunBuckets: Bucket[] = [0, 1, 2, 3].map(() => partBucket(scene, hullCap * 4));
  /** Per gun: its bucket; and every gun's attach point by hull frame. */
  const gunOf = new Int8Array(4).fill(-1);
  let gunPoints: GunPointTable = { frames: 1, xyz: new Float32Array(12) };
  let gunsReady = false;
  const parts: Bucket[] = [defense.base, neutral.base, neutralB.gun, neutralB.base, ...gunBuckets];
  let spots: TurretSpots = { restYaw: new Map(), neutralSet: new Map() };
  /** Outpost index by where its console stands (spotKey). */
  let consoles = new Map<number, number>();
  let outpostSides = new Int8Array(0);
  /** The Sky Captain level on screen, and the latest arena load's guard. */
  let captainLevel = 0;
  let captainEpoch = 0;
  let arenaCancelled: () => boolean = () => false;
  let loadedOnce = false;

  function swapCaptain(): void {
    const epoch = ++captainEpoch;
    const stale = arenaCancelled;
    const level = Math.min(9, Math.max(0, captainLevel));
    swap(
      greybox.warden,
      current.skyCaptain.byLevel[level],
      current.skyCaptain.uv,
      () => epoch !== captainEpoch || stale(),
    );
  }

  /** The model each bucket shows, so a swap to the same file is a no-op. */
  const showing = new Map<Bucket, string>();
  /** Set once a bucket shows a model; the frame loop's colour lookup. */
  const bindings = new Map<Bucket, UvBinding>();
  /** Morphs by bucket, and the same as a list for the frame loop. */
  const morphs = new Map<Bucket, MorphBinding>();
  const morphList: MorphBinding[] = [];
  /** Every entity's track: the morphs' clock. */
  const tracks = new TrackClock();
  /** Per bucket, the wrapped geometry of every file it has shown. */
  const wrapped = new Map<Bucket, Map<string, THREE.BufferGeometry>>();

  function swap(bucket: Bucket, file: string, uv: SideUv, cancelled: () => boolean): Promise<void> {
    return assetOf(file).then(
      (asset) => {
        if (cancelled()) return;
        let binding = bindings.get(bucket);
        if (showing.get(bucket) !== file) {
          // The greybox stand-in is the bucket's own and goes; a model is
          // shared with the session cache and stays.
          if (!showing.has(bucket)) {
            bucket.mesh.geometry.dispose();
            (bucket.mesh.material as THREE.Material).dispose();
          }
          const attr = binding?.attr ?? createTeamUvAttribute(bucket.tintCache.length);
          let byFile = wrapped.get(bucket);
          if (!byFile) {
            byFile = new Map();
            wrapped.set(bucket, byFile);
          }
          let geometry = byFile.get(file);
          if (!geometry) {
            geometry = wrapGeometry(asset.geometry, attr);
            byFile.set(file, geometry);
          }
          bucket.mesh.geometry = geometry;
          bucket.mesh.material = asset.material;
          // A greybox tint must not multiply into the texels.
          bucket.mesh.instanceColor = null;
          bindMorph(bucket, file, asset.geometry);
          showing.set(bucket, file);
          binding = binding ?? { attr, bySide: new Float32Array(6) };
          bindings.set(bucket, binding);
        }
        // Every swap restates the offsets: the same file may sit under another
        // arena's table, and a side may be another team now.
        if (binding) {
          for (let side = 0; side < 3; side++) {
            atlasOffset(asset.material.map, uv[side].u, uv[side].v, binding.bySide, side * 2);
          }
        }
        bucket.tintCache.fill(-2);
      },
      (err) => {
        console.warn(`[arenaUnits] no usable unit model ${file}, keeping the bucket's: ${err}`);
      },
    );
  }

  function swapTurret(set: TurretSet, models: TurretModels, cancelled: () => boolean): void {
    set.ready = false;
    Promise.all([
      swap(set.gun, models.gun, models.uv, cancelled),
      swap(set.base, models.base, models.uv, cancelled),
    ]).then(() => {
      if (cancelled()) return;
      if (showing.get(set.gun) !== models.gun || showing.get(set.base) !== models.base) return;
      bakedPoint(models.gunPoint, set.point);
      set.ready = true;
    });
  }

  /** Points the bucket's morph texture at the file's morph, or clears it. */
  function bindMorph(bucket: Bucket, file: string, geometry: THREE.BufferGeometry): void {
    const morph = MORPH_OF.get(file) ?? null;
    const targets = geometry.morphAttributes.position?.length ?? 0;
    const old = morphs.get(bucket);
    if (!morph || targets !== morph.frames - 1) {
      bucket.mesh.morphTexture = null;
      if (old) morphList.splice(morphList.indexOf(old), 1);
      morphs.delete(bucket);
      return;
    }
    const len = targets + 1;
    const capacity = bucket.tintCache.length;
    let texture = old && old.len === len ? old.texture : null;
    if (!texture) {
      texture = new THREE.DataTexture(
        new Float32Array(len * capacity),
        len,
        capacity,
        THREE.RedFormat,
        THREE.FloatType,
      );
      texture.needsUpdate = true;
    }
    bucket.mesh.morphTexture = texture;
    const binding: MorphBinding = { texture, len, track: morph, dirty: true };
    if (old) morphList.splice(morphList.indexOf(old), 1);
    morphs.set(bucket, binding);
    morphList.push(binding);
  }

  function swapGuns(units: ArenaUnits, cancelled: () => boolean): void {
    gunsReady = false;
    const guns = units.dreadnought.guns;
    const models: string[] = [];
    for (let i = 0; i < guns.length && i < 4; i++) {
      let b = models.indexOf(guns[i].model);
      if (b < 0) {
        b = models.length;
        models.push(guns[i].model);
      }
      gunOf[i] = b;
    }
    gunPoints = gunPointTable(guns);
    Promise.all(models.map((m, b) => swap(gunBuckets[b], m, units.dreadnought.uv, cancelled))).then(
      () => {
        if (cancelled()) return;
        if (models.some((m, b) => showing.get(gunBuckets[b]) !== m)) return;
        if (showing.get(greybox.juggernaut) !== units.dreadnought.hull) return;
        gunsReady = true;
      },
    );
  }

  function turretSet(bucket: Bucket): TurretSet | null {
    if (bucket === defense.gun) return defense;
    if (bucket === neutral.gun) return neutral;
    if (bucket === neutralB.gun) return neutralB;
    return null;
  }

  return {
    load(map, cancelled, models) {
      const units = arenaUnitsFor(map.id);
      current = units;
      currentMap = map.id;
      spots = turretSpotsOf(map, units);
      consoles = new Map(map.outpostSpots.map((s, k) => [spotKey(s.x, s.y), k]));
      outpostSides = new Int8Array(map.outpostSpots.length);
      // A side may be another team now: every stand-in's tint is re-keyed.
      for (const b of greybox.all) b.tintCache.fill(-2);
      // The console is scenery with the models (render/props.ts), a box without.
      greybox.console.mesh.visible = !models;
      if (!models) return;
      // The X1's two forms are every arena's; their offsets are the arena's
      // sides. The rig re-keys on the side too (render/avatarRig.ts).
      swap(greybox.avatarWalker, "avatar-walker", units.x1.uv, cancelled);
      swap(greybox.avatarHover, "avatar-hover", units.x1.uv, cancelled);
      swap(greybox.runner, units.tank.model, units.tank.uv, cancelled);
      swap(greybox.guardian, units.jet.model, units.jet.uv, cancelled);
      swap(greybox.fortress, units.fortress.model, units.fortress.uv, cancelled);
      swap(greybox.juggernaut, units.dreadnought.hull, units.dreadnought.uv, cancelled);
      swapGuns(units, cancelled);
      arenaCancelled = cancelled;
      loadedOnce = true;
      swapCaptain();
      swapTurret(defense, units.baseTurret, cancelled);
      swapTurret(neutral, units.neutralTurrets[0], cancelled);
      neutralB.ready = false;
      if (units.neutralTurrets[1]) swapTurret(neutralB, units.neutralTurrets[1], cancelled);
    },
    begin(simDtSec) {
      tracks.advance(simDtSec);
      for (let i = 0; i < parts.length; i++) parts[i].count = 0;
    },
    route(bucket, archetype, aux, x, y) {
      if (archetype !== ARCHETYPE.TURRET || aux === TURRET_DEFENSE || !neutralB.ready)
        return bucket;
      return spots.neutralSet.get(spotKey(x, y)) === 1 ? neutralB.gun : bucket;
    },
    get outpostSides() {
      return outpostSides;
    },
    setCaptainLevel(level) {
      if (level === captainLevel) return;
      captainLevel = level;
      // Models only once an arena has loaded them (never on ?render=greybox);
      // a load swaps the current level in itself.
      if (loadedOnce) swapCaptain();
    },
    teamUv(bucket, team, out) {
      const binding = bindings.get(bucket);
      if (!binding) return false;
      const side = teamSide(team);
      out[0] = binding.bySide[side * 2];
      out[1] = binding.bySide[side * 2 + 1];
      return true;
    },
    place(bucket, slot, id, archetype, team, x, y, pos, quat, scale, guns) {
      if (archetype === ARCHETYPE.CONSOLE) {
        // The console's team is its outpost's owner (sim claimOutpostSlot).
        const k = consoles.get(spotKey(x, y));
        if (k !== undefined) outpostSides[k] = teamSide(team);
      }
      const set = archetype === ARCHETYPE.TURRET ? turretSet(bucket) : null;
      if (set?.ready) {
        // The base keeps the record's rest yaw; the gun stands on the base's
        // attach point 0 and turns with the entity. A turret the map does not
        // place (a sandbox spawn) turns as one piece.
        const rest = spots.restYaw.get(spotKey(x, y));
        if (rest === undefined) scratchRest.copy(quat);
        else scratchRest.setFromAxisAngle(UP, -rest);
        const baseSlot = claim(set.base, "turret base");
        if (baseSlot >= 0) {
          scratchMatrix.compose(pos, scratchRest, scale);
          set.base.mesh.setMatrixAt(baseSlot, scratchMatrix);
          colour(set.base, bindings.get(set.base), baseSlot, team);
        }
        scratchAt.copy(set.point).multiply(scale).applyQuaternion(scratchRest).add(pos);
        scratchMatrix.compose(scratchAt, quat, scale);
      } else {
        scratchMatrix.compose(pos, quat, scale);
      }
      bucket.mesh.setMatrixAt(slot, scratchMatrix);
      colour(bucket, bindings.get(bucket), slot, team);
      const morph = morphs.get(bucket);
      let frame = 0;
      if (morph) {
        // Frame by frame at the track's period (RE `cact_anim_step`): 10 / 300 s
        // a frame for the rotor, 575 world units walked for Joke's tank.
        frame = tracks.frameOf(id, archetype, morph.track, pos.x, pos.y, pos.z);
        const a = morph.texture.image.data as Float32Array;
        const row = slot * morph.len;
        a[row] = 1; // relative targets: the base always counts in full
        for (let k = 1; k < morph.len; k++) a[row + k] = k === frame ? 1 : 0;
        morph.dirty = true;
      }
      if (archetype === ARCHETYPE.JUGGERNAUT && gunsReady && bucket === greybox.juggernaut) {
        // Each gun at its own yaw on its point in the frame the hull shows;
        // the guns wear the hull's offset (RE mount.c 714-715).
        for (let i = 0; i < 4; i++) {
          const gb = gunBuckets[gunOf[i]];
          const gs = claim(gb, "Dreadnought gun");
          if (gs < 0) continue;
          gunPointOf(gunPoints, i, frame, scratchGunPoint);
          gb.mesh.setMatrixAt(
            gs,
            gunMatrix(scratchMatrix, scratchGunPoint, guns[i], scratchGunOut),
          );
          colour(gb, bindings.get(gb), gs, team);
        }
      }
    },
    end() {
      for (let i = 0; i < parts.length; i++) {
        const b = parts[i];
        b.mesh.count = b.count;
        b.mesh.instanceMatrix.needsUpdate = true;
      }
      for (let i = 0; i < morphList.length; i++) {
        const m = morphList[i];
        if (!m.dirty) continue;
        m.texture.needsUpdate = true;
        m.dirty = false;
      }
    },
  };
}
