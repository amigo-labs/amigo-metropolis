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
// a second neutral turret model, with a gun and a base bucket of its own. These
// are declared exceptions to "one InstancedMesh per archetype" (assets.md §4):
// the two parts have two transforms in the original too.
//
// Renderer rules: `place` runs per entity per frame and allocates nothing; the
// loaders run at arena build and may.

import { ARCHETYPE, type MapData, TURRET_DEFENSE } from "@metropolis/sim";
import * as THREE from "three";
import {
  ARENA_UNITS,
  type ArenaUnits,
  type ModelPoint,
  type TurretModels,
} from "./arenaUnits.generated";
import { type Bucket, type GreyboxMeshes, tintFor } from "./greybox";
import { loadUnitAsset, type UnitAsset } from "./unitMeshes";

/** The arena whose units a map without an original mission draws (test-128). */
const FALLBACK_ARENA = "la-cantina";

/** The arena's unit table; a map the RE has no mission for draws Mp's. */
export function arenaUnitsFor(mapId: string): ArenaUnits {
  const own = ARENA_UNITS[mapId];
  if (own) return own;
  const fallback = ARENA_UNITS[FALLBACK_ARENA];
  // Team 0 is side 1 everywhere but Mp, so a map of no mission reads that way.
  return { ...fallback, sides: [1, 2] };
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

interface TurretSet {
  readonly gun: Bucket;
  readonly base: Bucket;
  /** The gun's place on the base, in the baked frame. Valid once `ready`. */
  readonly point: THREE.Vector3;
  ready: boolean;
}

export interface ArenaUnitsRenderer {
  /** Points every unit bucket at `map`'s own models. Async, fire and forget. */
  load(map: MapData, cancelled: () => boolean): void;
  /** Zeroes the part buckets. Call before the entity sweep. */
  begin(): void;
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
    archetype: number,
    team: number,
    x: number,
    y: number,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    scale: THREE.Vector3,
  ): void;
  /** Publishes the part buckets' counts and matrices. Call after the sweep. */
  end(): void;
}

// Frame-loop scratch (renderer rule 1).
const UP = new THREE.Vector3(0, 1, 0);
const scratchMatrix = new THREE.Matrix4();
const scratchRest = new THREE.Quaternion();
const scratchAt = new THREE.Vector3();

/** One file per session: its geometry is already turned onto the sim's +x. */
const assets = new Map<string, Promise<UnitAsset>>();

function assetOf(file: string): Promise<UnitAsset> {
  let pending = assets.get(file);
  if (!pending) {
    pending = loadUnitAsset(file).then((asset) => {
      // Models are authored +Z forward (assets.md §4); the sim/greybox frame
      // is +X forward, so bake the quarter turn into the geometry once.
      asset.geometry.rotateY(Math.PI / 2);
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

/** Writes the slot's tint when its team changed (the tint cache's job). */
function colour(bucket: Bucket, slot: number, team: number): void {
  if (bucket.tintCache[slot] === team) return;
  bucket.tintCache[slot] = team;
  bucket.mesh.setColorAt(slot, tintFor(team));
  if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
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
  const parts: Bucket[] = [defense.base, neutral.base, neutralB.gun, neutralB.base];
  let spots: TurretSpots = { restYaw: new Map(), neutralSet: new Map() };

  /** The model each bucket shows, so a swap to the same file is a no-op. */
  const showing = new Map<Bucket, string>();

  function swap(bucket: Bucket, file: string, cancelled: () => boolean): Promise<void> {
    return assetOf(file).then(
      (asset) => {
        if (cancelled() || showing.get(bucket) === file) return;
        const previous = showing.get(bucket);
        // The greybox stand-in is the bucket's own and goes; a model is shared
        // with the session cache and stays.
        if (previous === undefined) {
          bucket.mesh.geometry.dispose();
          (bucket.mesh.material as THREE.Material).dispose();
        }
        bucket.mesh.geometry = asset.geometry;
        bucket.mesh.material = asset.material;
        showing.set(bucket, file);
        // Re-write every instance tint on the next frame.
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
      swap(set.gun, models.gun, cancelled),
      swap(set.base, models.base, cancelled),
    ]).then(() => {
      if (cancelled()) return;
      if (showing.get(set.gun) !== models.gun || showing.get(set.base) !== models.base) return;
      bakedPoint(models.gunPoint, set.point);
      set.ready = true;
    });
  }

  function turretSet(bucket: Bucket): TurretSet | null {
    if (bucket === defense.gun) return defense;
    if (bucket === neutral.gun) return neutral;
    if (bucket === neutralB.gun) return neutralB;
    return null;
  }

  return {
    load(map, cancelled) {
      const units = arenaUnitsFor(map.id);
      spots = turretSpotsOf(map, units);
      swap(greybox.runner, units.tank.model, cancelled);
      swap(greybox.guardian, units.jet.model, cancelled);
      swap(greybox.fortress, units.fortress.model, cancelled);
      swap(greybox.juggernaut, units.dreadnought.hull, cancelled);
      swap(greybox.warden, units.skyCaptain.byLevel[0], cancelled);
      swap(greybox.console, units.console, cancelled);
      swapTurret(defense, units.baseTurret, cancelled);
      swapTurret(neutral, units.neutralTurrets[0], cancelled);
      neutralB.ready = false;
      if (units.neutralTurrets[1]) swapTurret(neutralB, units.neutralTurrets[1], cancelled);
    },
    begin() {
      for (let i = 0; i < parts.length; i++) parts[i].count = 0;
    },
    route(bucket, archetype, aux, x, y) {
      if (archetype !== ARCHETYPE.TURRET || aux === TURRET_DEFENSE || !neutralB.ready)
        return bucket;
      return spots.neutralSet.get(spotKey(x, y)) === 1 ? neutralB.gun : bucket;
    },
    place(bucket, slot, archetype, team, x, y, pos, quat, scale) {
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
          colour(set.base, baseSlot, team);
        }
        scratchAt.copy(set.point).multiply(scale).applyQuaternion(scratchRest).add(pos);
        scratchMatrix.compose(scratchAt, quat, scale);
      } else {
        scratchMatrix.compose(pos, quat, scale);
      }
      bucket.mesh.setMatrixAt(slot, scratchMatrix);
      colour(bucket, slot, team);
    },
    end() {
      for (let i = 0; i < parts.length; i++) {
        const b = parts[i];
        b.mesh.count = b.count;
        b.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
