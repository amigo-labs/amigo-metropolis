// Greybox archetype meshes (assets.md Stage A): one InstancedMesh per render
// bucket, team tint via instance color. This stays in the repo forever as the
// debug render mode (?render=greybox) once real models exist.
//
// The avatar gets TWO buckets (walker body / hover wedge); the frame loop
// routes each snapshot entity into a bucket via bucketFor().

import { ANIM_HOVER, ARCHETYPE, TURRET_DEFENSE, getMapById, MAP_REGISTRY } from "@metropolis/sim";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { NEUTRAL_RAMP, PROJECTILE_HEX, TEAM_RAMPS } from "./palette";

// Colors come from the shared game palette (assets.md §3) — team meshes use the
// ramp's base shade; base structures reach for the dark shade themselves.
export const TEAM_COLORS: readonly THREE.Color[] = TEAM_RAMPS.map(
  (ramp) => new THREE.Color(ramp.base),
);
export const NEUTRAL_COLOR = new THREE.Color(NEUTRAL_RAMP.base);
const PROJECTILE_COLORS: readonly THREE.Color[] = PROJECTILE_HEX.map((hex) => new THREE.Color(hex));

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
  readonly projectile: Bucket;
  readonly console: Bucket;
  readonly warden: Bucket;
  readonly all: Bucket[];
}

function bucket(scene: THREE.Scene, geometry: THREE.BufferGeometry, capacity: number): Bucket {
  const material = new THREE.MeshStandardMaterial({ flatShading: true });
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

export function createGreyboxMeshes(scene: THREE.Scene): GreyboxMeshes {
  // Walker: torso + two legs, reads as "standing mech". +X is forward.
  const walkerGeometry = mergeGeometries([
    box(1.8, 1.3, 1.6, 0, 1.55, 0), // torso
    box(0.5, 1.0, 0.45, 0.1, 0.5, -0.5), // leg L
    box(0.5, 1.0, 0.45, 0.1, 0.5, 0.5), // leg R
    box(1.0, 0.35, 0.35, 1.2, 1.7, 0), // gun
  ]);
  // Hover: flat wedge with a nose block.
  const hoverGeometry = mergeGeometries([
    box(2.6, 0.6, 1.8, -0.2, 0.3, 0), // hull
    box(1.0, 0.4, 1.0, 1.3, 0.25, 0), // nose
    box(0.5, 0.5, 2.2, -1.1, 0.5, 0), // tail spoiler
  ]);
  // Runner: squat tank — tracked hull, small turret, stub barrel. +X forward.
  const runnerGeometry = mergeGeometries([
    box(1.7, 0.6, 1.3, 0, 0.3, 0), // hull
    box(0.8, 0.5, 0.8, -0.1, 0.85, 0), // turret
    box(0.9, 0.2, 0.2, 0.7, 0.95, 0), // barrel
  ]);
  // Guardian: small plane — fuselage, straight wing, tail fin. +X forward.
  const guardianGeometry = mergeGeometries([
    box(2.2, 0.5, 0.7, 0, 0, 0), // fuselage
    box(0.7, 0.12, 3.2, -0.1, 0.1, 0), // wing
    box(0.5, 0.7, 0.12, -0.95, 0.35, 0), // tail fin
  ]);
  // Juggernaut: hulking siege tank — twin barrels, high back. +X forward.
  const juggernautGeometry = mergeGeometries([
    box(3.6, 1.4, 2.6, 0, 0.7, 0), // hull
    box(1.8, 1.0, 1.8, -0.5, 1.9, 0), // casemate
    box(1.6, 0.28, 0.3, 1.5, 2.1, -0.45), // barrel L
    box(1.6, 0.28, 0.3, 1.5, 2.1, 0.45), // barrel R
  ]);
  // Fortress: broad flying wing with a fat body. +X forward.
  const fortressGeometry = mergeGeometries([
    box(2.8, 0.9, 1.5, 0, 0, 0), // body
    box(1.3, 0.25, 5.0, -0.3, 0.15, 0), // wing
    box(1.0, 0.5, 0.8, 1.6, -0.1, 0), // nose
  ]);
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
  // Projectile: small low-poly ball.
  const projectileGeometry = new THREE.SphereGeometry(0.35, 6, 4);
  projectileGeometry.translate(0, 0.35, 0);
  // Outpost console: slab + pedestal + tilted screen (a live entity — it
  // changes team on claim and respawns — unlike the static base consoles).
  const consoleGeometry = mergeGeometries([
    box(3.4, 0.25, 3.4, 0, 0.125, 0),
    box(1.0, 1.3, 1.0, 0, 0.9, 0),
    box(1.4, 0.35, 1.0, 0, 1.7, 0),
    box(0.15, 2.4, 0.15, -0.5, 3.0, -0.5),
  ]);
  // Warden: the solo-opponent superplane — long fuselage, swept main wing,
  // canards and a twin tail. Clearly bigger than a Guardian. +X forward.
  const wardenGeometry = mergeGeometries([
    box(3.6, 0.8, 1.1, 0, 0, 0), // fuselage
    box(1.6, 0.2, 4.6, -0.6, 0.15, 0), // main wing
    box(0.8, 0.15, 2.0, 1.2, 0.1, 0), // canards
    box(0.9, 1.0, 0.15, -1.5, 0.6, -0.8), // tail fin L
    box(0.9, 1.0, 0.15, -1.5, 0.6, 0.8), // tail fin R
    box(1.2, 0.5, 0.7, 1.9, 0, 0), // nose
  ]);

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
  const projectile = bucket(scene, projectileGeometry, 128);
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
    return aux === TURRET_DEFENSE ? greybox.turretDefense : greybox.turretStandard;
  }
  if (archetype === ARCHETYPE.PROJECTILE) return greybox.projectile;
  if (archetype === ARCHETYPE.CONSOLE) return greybox.console;
  if (archetype === ARCHETYPE.WARDEN) return greybox.warden;
  return undefined;
}

/** Instance tint: team color, or payload color for projectiles. */
export function tintFor(archetype: number, team: number, aux: number): THREE.Color {
  if (archetype === ARCHETYPE.PROJECTILE) {
    return PROJECTILE_COLORS[aux] ?? PROJECTILE_COLORS[0];
  }
  if (team >= 0 && team < TEAM_COLORS.length) return TEAM_COLORS[team];
  return NEUTRAL_COLOR;
}

/** Cache key mirroring tintFor's inputs. */
export function tintKey(archetype: number, team: number, aux: number): number {
  return archetype === ARCHETYPE.PROJECTILE ? 16 + aux : team;
}
