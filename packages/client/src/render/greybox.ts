// Greybox archetype meshes (assets.md Stage A): one InstancedMesh per render
// bucket, team tint via instance color. This stays in the repo forever as the
// debug render mode (?render=greybox) once real models exist.
//
// The avatar gets TWO buckets (walker body / hover wedge); the frame loop
// routes each snapshot entity into a bucket via bucketFor().

import {
  ANIM_HOVER,
  ARCHETYPE,
  getMapById,
  MAP_REGISTRY,
  PROJ_HEAVY,
  PROJ_HYPER,
  PROJ_MINE,
  PROJ_MORTAR,
  PROJ_SPECIAL,
  PROJ_WARDEN,
  TURRET_BUILTIN,
  TURRET_DEFENSE,
} from "@metropolis/sim";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { NEUTRAL_RAMP, TEAM_RAMPS } from "./palette";

// Colors come from the shared game palette (assets.md §3) — team meshes use the
// ramp's base shade; base structures reach for the dark shade themselves.
export const TEAM_COLORS: readonly THREE.Color[] = TEAM_RAMPS.map(
  (ramp) => new THREE.Color(ramp.base),
);
export const NEUTRAL_COLOR = new THREE.Color(NEUTRAL_RAMP.base);

export interface Bucket {
  readonly mesh: THREE.InstancedMesh;
  /** Cached tint key per slot (team or projectile kind) to avoid re-uploads. */
  readonly tintCache: Int8Array;
  count: number;
  /** Set once if an instance was ever dropped for lack of capacity (see main.ts). */
  overflowed?: boolean;
}

export interface GreyboxMeshes {
  readonly avatarWalker: Bucket;
  readonly avatarHover: Bucket;
  readonly runner: Bucket;
  readonly guardian: Bucket;
  readonly juggernaut: Bucket;
  readonly fortress: Bucket;
  /** Mode "Standard": capturable / dummy turrets. */
  readonly turretStandard: Bucket;
  /** Mode "Defense": base-ring turrets (TURRET_DEFENSE). */
  readonly turretDefense: Bucket;
  /** One bucket per projectile kind — the original has one mesh per kind. */
  readonly projHeavy: Bucket;
  readonly projHyper: Bucket;
  readonly projMortar: Bucket;
  readonly projMine: Bucket;
  readonly projWarden: Bucket;
  /** Kinds with no mesh of their own (the shockwave pulse). */
  readonly projectile: Bucket;
  readonly console: Bucket;
  readonly warden: Bucket;
  readonly all: Bucket[];
}

function bucket(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  capacity: number,
  /** Unlit bright material for projectiles (FCOP-style energy bolts). */
  unlit = false,
): Bucket {
  const material = unlit
    ? new THREE.MeshBasicMaterial({ toneMapped: false })
    : new THREE.MeshStandardMaterial({ flatShading: true });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  return { mesh, tintCache: new Int8Array(capacity).fill(-2), count: 0 };
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/**
 * Instance capacity per bucket, sized so the WHOLE registry fits.
 *
 * These used to be literals, and la-cantina broke them: importing the original
 * Precinct Assault layout puts 32 capturable + 32 ring + 8 built-in base turrets
 * on the map, i.e. 72 turret entities against a cap of 64. renderEntities drops
 * instances past capacity silently (main.ts), so the result was eight turrets
 * that shoot at you and are simply not drawn.
 *
 * Sized from the map registry rather than per-map because createGreyboxMeshes is
 * called once at boot while the arena can be swapped afterwards — a per-map cap
 * would under-allocate on the next, larger arena.
 */
function turretCapacity(): number {
  let worst = 0;
  for (const info of MAP_REGISTRY) {
    const map = getMapById(info.id);
    const n =
      map.bases[0].turrets.length +
      map.bases[1].turrets.length +
      map.bases[0].defence.length +
      map.bases[1].defence.length +
      map.turretSpots.length +
      map.dummySpots.length;
    if (n > worst) worst = n;
  }
  // Headroom for a future arena, and never below the historic 64 so the small
  // maps keep their previous allocation exactly.
  return Math.max(64, Math.ceil(worst * 1.25));
}

/** Outpost consoles are one entity per spot; same reasoning as turrets. */
function consoleCapacity(): number {
  let worst = 0;
  for (const info of MAP_REGISTRY) {
    const n = getMapById(info.id).outpostSpots.length;
    if (n > worst) worst = n;
  }
  return Math.max(8, worst * 2);
}

/**
 * Native size of each modelled archetype, from tools/generators/units/manifest.ts
 * — max horizontal extent and height, in metres, as the FCOP originals author
 * them. The greybox silhouettes below are hand-drawn at whatever proportions
 * read best and then scaled onto these, so the stand-in and the .glb it stands
 * in for are the same size by construction.
 *
 * They used to be hand-matched literals, which is how they came to be matched
 * to models that were themselves stretched 1.02x-2.87x off the original.
 */
const NATIVE: Record<string, { footprint: number; height: number }> = {
  walker: { footprint: 0.8, height: 0.98 },
  hover: { footprint: 1.24, height: 0.48 },
  runner: { footprint: 1.52, height: 0.4 },
  guardian: { footprint: 3.15, height: 0.68 },
  juggernaut: { footprint: 2.22, height: 0.63 },
  // Hull-only: gen:units drops Cobj 57's tex10/facer volumes and the two
  // exhaust billboards, so this is 2.10 x 1.09 rather than the raw 2.67 x 1.89.
  fortress: { footprint: 2.1, height: 1.09 },
  console: { footprint: 1.12, height: 1.47 },
  // Hull-only: Cobj 54's 1 m tex10 searchlights are dropped (raw 2.04 x 0.71).
  warden: { footprint: 1.49, height: 0.42 },
  // Projectiles and bolts, from FX_MODELS (docs/specs/fcop-fx.md). Same rule as
  // above: the stand-in is drawn at whatever proportions read best and then
  // scaled onto the original's size, so swapping the .glb in changes the shape
  // and never the scale.
  projHeavy: { footprint: 0.39, height: 0.15 },
  projHyper: { footprint: 0.23, height: 0.09 },
  projMortar: { footprint: 0.35, height: 0.19 },
  projMine: { footprint: 0.37, height: 0.22 },
  projWarden: { footprint: 0.54, height: 0.2 },
  boltSingle: { footprint: 1.03, height: 0.22 },
  boltTwin: { footprint: 1.09, height: 0.31 },
};

/**
 * Scales an authored silhouette onto its native size and grounds it, applying
 * genUnitModels.ts's own rule: one uniform factor, the tighter of the footprint
 * and the height fit, then bbox minY to 0.
 *
 * `ground: false` centres on Y instead, for the things that fly: the FX models
 * keep the pivot the original authored (roughly their own centre) rather than
 * standing on anything, so a grounded stand-in would sit half its own height
 * above the .glb that replaces it.
 */
function fitNative(
  geometry: THREE.BufferGeometry,
  key: string,
  ground = true,
): THREE.BufferGeometry {
  const n = NATIVE[key];
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb) return geometry;
  const sizeX = bb.max.x - bb.min.x;
  const sizeY = bb.max.y - bb.min.y;
  const sizeZ = bb.max.z - bb.min.z;
  const scale = Math.min(n.footprint / Math.max(sizeX, sizeZ), n.height / sizeY);
  // Read the offset BEFORE scaling: three's applyMatrix4 transforms the cached
  // boundingBox in place, so `bb` is already scaled by the time we shift it.
  const offsetY = ground ? bb.min.y : (bb.min.y + bb.max.y) / 2;
  geometry.scale(scale, scale, scale);
  geometry.translate(0, -offsetY * scale, 0);
  return geometry;
}

export function createGreyboxMeshes(scene: THREE.Scene): GreyboxMeshes {
  // Walker: torso + two legs, reads as "standing mech". +X is forward.
  const walkerGeometry = fitNative(
    mergeGeometries([
      box(1.8, 1.3, 1.6, 0, 1.55, 0), // torso
      box(0.5, 1.0, 0.45, 0.1, 0.5, -0.5), // leg L
      box(0.5, 1.0, 0.45, 0.1, 0.5, 0.5), // leg R
      box(1.0, 0.35, 0.35, 1.2, 1.7, 0), // gun
    ]),
    "walker",
  );
  // Hover: flat wedge with a nose block.
  const hoverGeometry = fitNative(
    mergeGeometries([
      box(2.6, 0.6, 1.8, -0.2, 0.3, 0), // hull
      box(1.0, 0.4, 1.0, 1.3, 0.25, 0), // nose
      box(0.5, 0.5, 2.2, -1.1, 0.5, 0), // tail spoiler
    ]),
    "hover",
  );
  // Runner: squat tank — tracked hull, small turret, stub barrel. +X forward.
  const runnerGeometry = fitNative(
    mergeGeometries([
      box(1.7, 0.6, 1.3, 0, 0.3, 0), // hull
      box(0.8, 0.5, 0.8, -0.1, 0.85, 0), // turret
      box(0.9, 0.2, 0.2, 0.7, 0.95, 0), // barrel
    ]),
    "runner",
  );
  // Guardian: small plane — fuselage, straight wing, tail fin. +X forward.
  const guardianGeometry = fitNative(
    mergeGeometries([
      box(2.2, 0.5, 0.7, 0, 0, 0), // fuselage
      box(0.7, 0.12, 3.2, -0.1, 0.1, 0), // wing
      box(0.5, 0.7, 0.12, -0.95, 0.35, 0), // tail fin
    ]),
    "guardian",
  );
  // Juggernaut: hulking siege tank — twin barrels, high back. +X forward.
  const juggernautGeometry = fitNative(
    mergeGeometries([
      box(3.6, 1.4, 2.6, 0, 0.7, 0), // hull
      box(1.8, 1.0, 1.8, -0.5, 1.9, 0), // casemate
      box(1.6, 0.28, 0.3, 1.5, 2.1, -0.45), // barrel L
      box(1.6, 0.28, 0.3, 1.5, 2.1, 0.45), // barrel R
    ]),
    "juggernaut",
  );
  // Fortress: broad flying wing with a fat body. +X forward.
  const fortressGeometry = fitNative(
    mergeGeometries([
      box(2.8, 0.9, 1.5, 0, 0, 0), // body
      box(1.3, 0.25, 5.0, -0.3, 0.15, 0), // wing
      box(1.0, 0.5, 0.8, 1.6, -0.1, 0), // nose
    ]),
    "fortress",
  );
  // Turret Standard ≈ FCOP Cobj assembly (~1.4 m footprint, ~1.6 m tall).
  const turretBase = new THREE.CylinderGeometry(0.55, 0.65, 0.95, 8);
  turretBase.translate(0, 0.48, 0);
  const barrel = new THREE.CylinderGeometry(0.1, 0.12, 0.9, 6);
  barrel.rotateZ(-Math.PI / 2);
  barrel.translate(0.7, 0.85, 0);
  const turretGeometry = mergeGeometries([turretBase, barrel]);
  // Defense ≈ smaller FCOP ring gun (~0.95 m).
  const defenseScale = 0.65;
  const turretDefenseGeometry = turretGeometry.clone();
  turretDefenseGeometry.scale(defenseScale, defenseScale, defenseScale);
  // Projectiles: one stand-in per kind, because the original has one MESH per
  // kind (docs/specs/fcop-fx.md §3). They used to share a single cylinder that
  // was told apart only by tint, which is why the tint had to carry the kind.
  // Now the shape carries it and the tint is free to say whose it is.
  //
  // All are authored along +X (sim forward) and scaled onto the FCOP size by
  // fitNative, so a stand-in and the .glb that replaces it are the same size.
  /** Pointed shell along +X, in the proportions of the FCOP rocket family. */
  const rocket = (key: string) => {
    const body = new THREE.CylinderGeometry(0.07, 0.05, 0.34, 6);
    body.rotateZ(-Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.07, 0.16, 6);
    nose.rotateZ(-Math.PI / 2);
    nose.translate(0.25, 0, 0);
    return fitNative(mergeGeometries([body, nose]), key, false);
  };
  const projHeavyGeometry = rocket("projHeavy");
  const projHyperGeometry = rocket("projHyper");
  const projWardenGeometry = rocket("projWarden");
  // Mortar: round where the rockets are pointed — that is the silhouette
  // difference in the original too (Cobj 49 against Cobj 43/44).
  const projMortarGeometry = fitNative(new THREE.SphereGeometry(0.18, 8, 6), "projMortar", false);
  // Mine: a flat drum that sits on the floor.
  const projMineGeometry = fitNative(
    new THREE.CylinderGeometry(0.18, 0.18, 0.1, 8),
    "projMine",
    false,
  );
  // Fallback for any kind without a mesh of its own — the shockwave pulse has
  // no flying object in the original either (type-99 row 14 is empty).
  const projectileGeometry = new THREE.CylinderGeometry(0.07, 0.04, 0.5, 6);
  projectileGeometry.rotateZ(-Math.PI / 2);
  projectileGeometry.translate(0, 0.08, 0);
  // Outpost console: slab + pedestal + tilted screen (a live entity — it
  // changes team on claim and respawns — unlike the static base consoles).
  const consoleGeometry = fitNative(
    mergeGeometries([
      box(3.4, 0.25, 3.4, 0, 0.125, 0),
      box(1.0, 1.3, 1.0, 0, 0.9, 0),
      box(1.4, 0.35, 1.0, 0, 1.7, 0),
      box(0.15, 2.4, 0.15, -0.5, 3.0, -0.5),
    ]),
    "console",
  );
  // Warden: the solo-opponent superplane — long fuselage, swept main wing,
  // canards and a twin tail. Clearly bigger than a Guardian. +X forward.
  const wardenGeometry = fitNative(
    mergeGeometries([
      box(3.6, 0.8, 1.1, 0, 0, 0), // fuselage
      box(1.6, 0.2, 4.6, -0.6, 0.15, 0), // main wing
      box(0.8, 0.15, 2.0, 1.2, 0.1, 0), // canards
      box(0.9, 1.0, 0.15, -1.5, 0.6, -0.8), // tail fin L
      box(0.9, 1.0, 0.15, -1.5, 0.6, 0.8), // tail fin R
      box(1.2, 0.5, 0.7, 1.9, 0, 0), // nose
    ]),
    "warden",
  );

  const avatarWalker = bucket(scene, walkerGeometry, 4);
  const avatarHover = bucket(scene, hoverGeometry, 4);
  const runner = bucket(scene, runnerGeometry, 128);
  const guardian = bucket(scene, guardianGeometry, 64);
  const juggernaut = bucket(scene, juggernautGeometry, 4);
  const fortress = bucket(scene, fortressGeometry, 4);
  // Separate InstancedMesh + smaller greybox so Defense stays compact even
  // before / without the Stage B .glb swap. Capacity is registry-sized so PA
  // layouts (72+ turrets) never overflow a single mode bucket.
  const turretCap = turretCapacity();
  const turretStandard = bucket(scene, turretGeometry, turretCap);
  const turretDefense = bucket(scene, turretDefenseGeometry, turretCap);
  // Split from the one 128-slot bucket the kinds used to share. Sized by what
  // can plausibly be in the air at once rather than evenly: the two rockets are
  // the high-cadence weapons, mines are ammo-capped per player, and the Warden
  // is a single aircraft.
  const projHeavy = bucket(scene, projHeavyGeometry, 64, true);
  const projHyper = bucket(scene, projHyperGeometry, 64, true);
  const projMortar = bucket(scene, projMortarGeometry, 32, true);
  const projMine = bucket(scene, projMineGeometry, 32, true);
  const projWarden = bucket(scene, projWardenGeometry, 16, true);
  const projectile = bucket(scene, projectileGeometry, 32, true);
  const consoleBucket = bucket(scene, consoleGeometry, consoleCapacity());
  const warden = bucket(scene, wardenGeometry, 2);
  return {
    avatarWalker,
    avatarHover,
    runner,
    guardian,
    juggernaut,
    fortress,
    turretStandard,
    turretDefense,
    projHeavy,
    projHyper,
    projMortar,
    projMine,
    projWarden,
    projectile,
    console: consoleBucket,
    warden,
    all: [
      avatarWalker,
      avatarHover,
      runner,
      guardian,
      juggernaut,
      fortress,
      turretStandard,
      turretDefense,
      projHeavy,
      projHyper,
      projMortar,
      projMine,
      projWarden,
      projectile,
      consoleBucket,
      warden,
    ],
  };
}

/** Routes a snapshot entity to its render bucket (or undefined to skip). */
export function bucketFor(
  greybox: GreyboxMeshes,
  archetype: number,
  animState: number,
  /** Snapshot aux: projectile kind, or turret mode (DEFENSE / DUMMY / CAPTURABLE→Standard). */
  aux = 0,
): Bucket | undefined {
  if (archetype === ARCHETYPE.AVATAR) {
    return (animState & ANIM_HOVER) !== 0 ? greybox.avatarHover : greybox.avatarWalker;
  }
  if (archetype === ARCHETYPE.RUNNER) return greybox.runner;
  if (archetype === ARCHETYPE.GUARDIAN) return greybox.guardian;
  if (archetype === ARCHETYPE.JUGGERNAUT) return greybox.juggernaut;
  if (archetype === ARCHETYPE.FORTRESS) return greybox.fortress;
  if (archetype === ARCHETYPE.TURRET) {
    // Built-in BaseShooter guns are combat-only (bolted into the base mesh).
    if (aux === TURRET_BUILTIN) return undefined;
    return aux === TURRET_DEFENSE ? greybox.turretDefense : greybox.turretStandard;
  }
  if (archetype === ARCHETYPE.PROJECTILE) {
    // aux is the projectile kind. PROJ_SPECIAL is the legacy id for the mortar
    // blast and shares its shell, exactly as projectileBlast() shares its numbers.
    switch (aux) {
      case PROJ_HEAVY:
        return greybox.projHeavy;
      case PROJ_HYPER:
        return greybox.projHyper;
      case PROJ_MORTAR:
      case PROJ_SPECIAL:
        return greybox.projMortar;
      case PROJ_MINE:
        return greybox.projMine;
      case PROJ_WARDEN:
        return greybox.projWarden;
      default:
        return greybox.projectile;
    }
  }
  if (archetype === ARCHETYPE.CONSOLE) return greybox.console;
  if (archetype === ARCHETYPE.WARDEN) return greybox.warden;
  return undefined;
}

/**
 * Instance tint: the owning team, for everything including projectiles.
 *
 * Projectiles used to be tinted by KIND, and took archetype + aux to work that
 * out, because every kind shared one cylinder and colour was the only thing
 * telling a rocket from a mortar shell. Now each kind has the mesh the original
 * gave it, so the shape says what it is and the colour is free to say whose it
 * is — which is what the original did too: every row of its weapon table names
 * its mesh twice, once per team (docs/specs/fcop-fx.md §2). PROJECTILE_HEX
 * survives as the explosion tint in render/fx.ts, where a blast really is
 * identified by kind and not by owner.
 *
 * The team IS the cache key, so there is no separate tintKey any more.
 */
export function tintFor(team: number): THREE.Color {
  if (team >= 0 && team < TEAM_COLORS.length) return TEAM_COLORS[team];
  return NEUTRAL_COLOR;
}
