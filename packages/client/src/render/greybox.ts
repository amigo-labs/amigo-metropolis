// Greybox archetype meshes (assets.md Stage A): one InstancedMesh per render
// bucket, team tint via instance color. This stays in the repo forever as the
// debug render mode (?render=greybox) once real models exist.
//
// The avatar gets TWO buckets (walker body / hover wedge); the frame loop
// routes each snapshot entity into a bucket via bucketFor().

import { ANIM_HOVER, ARCHETYPE } from "@metropolis/sim";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const TEAM_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0x3b82f6), // team 0: blue
  new THREE.Color(0xef4444), // team 1: red
];
export const NEUTRAL_COLOR = new THREE.Color(0x9ca3af);
const PROJECTILE_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0xffffff),
  new THREE.Color(0xffb020), // heavy: orange
  new THREE.Color(0x7ef2ff), // special: cyan
];

export interface Bucket {
  readonly mesh: THREE.InstancedMesh;
  /** Cached tint key per slot (team or projectile kind) to avoid re-uploads. */
  readonly tintCache: Int8Array;
  count: number;
}

export interface GreyboxMeshes {
  readonly avatarWalker: Bucket;
  readonly avatarHover: Bucket;
  readonly runner: Bucket;
  readonly guardian: Bucket;
  readonly juggernaut: Bucket;
  readonly fortress: Bucket;
  readonly turret: Bucket;
  readonly projectile: Bucket;
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
  // Turret: base cylinder + barrel toward +X.
  const turretBase = new THREE.CylinderGeometry(1.2, 1.4, 1.6, 8);
  turretBase.translate(0, 0.8, 0);
  const barrel = new THREE.CylinderGeometry(0.18, 0.22, 1.6, 6);
  barrel.rotateZ(-Math.PI / 2);
  barrel.translate(1.2, 1.35, 0);
  const turretGeometry = mergeGeometries([turretBase, barrel]);
  // Projectile: small low-poly ball.
  const projectileGeometry = new THREE.SphereGeometry(0.35, 6, 4);
  projectileGeometry.translate(0, 0.35, 0);

  const avatarWalker = bucket(scene, walkerGeometry, 4);
  const avatarHover = bucket(scene, hoverGeometry, 4);
  const runner = bucket(scene, runnerGeometry, 128);
  const guardian = bucket(scene, guardianGeometry, 64);
  const juggernaut = bucket(scene, juggernautGeometry, 4);
  const fortress = bucket(scene, fortressGeometry, 4);
  const turret = bucket(scene, turretGeometry, 64);
  const projectile = bucket(scene, projectileGeometry, 128);
  return {
    avatarWalker,
    avatarHover,
    runner,
    guardian,
    juggernaut,
    fortress,
    turret,
    projectile,
    all: [avatarWalker, avatarHover, runner, guardian, juggernaut, fortress, turret, projectile],
  };
}

/** Routes a snapshot entity to its render bucket (or undefined to skip). */
export function bucketFor(
  greybox: GreyboxMeshes,
  archetype: number,
  animState: number,
): Bucket | undefined {
  if (archetype === ARCHETYPE.AVATAR) {
    return (animState & ANIM_HOVER) !== 0 ? greybox.avatarHover : greybox.avatarWalker;
  }
  if (archetype === ARCHETYPE.RUNNER) return greybox.runner;
  if (archetype === ARCHETYPE.GUARDIAN) return greybox.guardian;
  if (archetype === ARCHETYPE.JUGGERNAUT) return greybox.juggernaut;
  if (archetype === ARCHETYPE.FORTRESS) return greybox.fortress;
  if (archetype === ARCHETYPE.TURRET) return greybox.turret;
  if (archetype === ARCHETYPE.PROJECTILE) return greybox.projectile;
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
