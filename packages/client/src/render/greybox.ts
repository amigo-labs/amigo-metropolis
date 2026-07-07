// Greybox archetype meshes (assets.md Stage A): one InstancedMesh per entity
// archetype, team tint via instance color. This stays in the repo forever as
// the debug render mode (?render=greybox) once real models exist.

import { ARCHETYPE } from "@metropolis/sim";
import * as THREE from "three";

export const TEAM_COLORS: readonly THREE.Color[] = [
  new THREE.Color(0x3b82f6), // team 0: blue
  new THREE.Color(0xef4444), // team 1: red
];
export const NEUTRAL_COLOR = new THREE.Color(0x9ca3af);

export interface GreyboxMeshes {
  /** Indexed by archetype id; archetypes without a mesh yet are undefined. */
  byArchetype: (THREE.InstancedMesh | undefined)[];
  /** Per archetype: team id cached per instance slot to avoid re-uploads. */
  teamCache: Int8Array[];
}

const AVATAR_INSTANCES = 4;

export function createGreyboxMeshes(scene: THREE.Scene): GreyboxMeshes {
  const byArchetype: (THREE.InstancedMesh | undefined)[] = new Array(8).fill(undefined);
  const teamCache: Int8Array[] = [];
  for (let i = 0; i < 8; i++) teamCache.push(new Int8Array(0));

  // Avatar walker: box torso, origin at ground contact (assets.md Stage A).
  const avatarGeometry = new THREE.BoxGeometry(2, 2, 2);
  avatarGeometry.translate(0, 1, 0);
  const material = new THREE.MeshStandardMaterial({ flatShading: true });
  const avatar = new THREE.InstancedMesh(avatarGeometry, material, AVATAR_INSTANCES);
  avatar.count = 0;
  avatar.frustumCulled = false;
  avatar.matrixAutoUpdate = false;
  avatar.updateMatrix();
  scene.add(avatar);
  byArchetype[ARCHETYPE.AVATAR] = avatar;
  teamCache[ARCHETYPE.AVATAR] = new Int8Array(AVATAR_INSTANCES).fill(-2); // -2 = unset

  return { byArchetype, teamCache };
}
