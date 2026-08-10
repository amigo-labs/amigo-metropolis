// The greybox stand-ins have to be the same SIZE as the .glb they stand in for,
// or the avatar visibly pops the moment the model finishes loading — and
// `?render=greybox` stops being a usable debug view of the real game.
//
// That agreement used to be hand-maintained: greybox.ts carried box literals
// authored to match whatever the models happened to measure. It drifted, because
// the models themselves were stretched by a per-unit factor (1.02x-2.87x off the
// FCOP originals) and the boxes were matched to the stretched result. Both sides
// now derive from the same native sizes, and this is the test that says so.
//
// Read off the committed .glb rather than off greybox.ts's own table, so a
// regenerated model that changes size fails here instead of silently
// disagreeing with its fallback.

import { describe, expect, test } from "bun:test";
import { NodeIO } from "@gltf-transform/core";
import * as THREE from "three";
import { createGreyboxMeshes, type GreyboxMeshes } from "../src/render/greybox";

/** Max horizontal extent and height of a committed unit model, in metres. */
async function modelSize(key: string): Promise<{ footprint: number; height: number }> {
  const path = new URL(`../public/models/units/${key}.glb`, import.meta.url).pathname;
  const doc = await new NodeIO().read(path);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const min = pos.getMin([0, 0, 0]);
      const max = pos.getMax([0, 0, 0]);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], min[k]);
        hi[k] = Math.max(hi[k], max[k]);
      }
    }
  }
  return { footprint: Math.max(hi[0] - lo[0], hi[2] - lo[2]), height: hi[1] - lo[1] };
}

function bucketSize(mesh: THREE.InstancedMesh): { footprint: number; height: number } {
  const g = mesh.geometry;
  g.computeBoundingBox();
  const bb = g.boundingBox;
  if (!bb) throw new Error("no bounding box");
  return {
    footprint: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z),
    height: bb.max.y - bb.min.y,
  };
}

/** Bucket name -> model key, for every archetype that has both. */
const PAIRS: readonly (readonly [keyof GreyboxMeshes, string])[] = [
  ["avatarWalker", "avatar-walker"],
  ["avatarHover", "avatar-hover"],
  ["runner", "runner"],
  ["guardian", "guardian"],
  ["juggernaut", "juggernaut"],
  ["fortress", "fortress"],
  ["console", "console"],
  ["warden", "warden"],
];

describe("greybox stand-ins match the models they stand in for", () => {
  const meshes = createGreyboxMeshes(new THREE.Scene());

  for (const [bucketName, key] of PAIRS) {
    test(`${key}`, async () => {
      const model = await modelSize(key);
      const grey = bucketSize((meshes[bucketName] as { mesh: THREE.InstancedMesh }).mesh);
      // One axis is fitted exactly and the other is whatever the authored
      // silhouette's aspect gives, so only the BINDING dimension can be tight.
      // 2 cm covers the looser one on every pair here.
      const fitted = Math.min(
        Math.abs(grey.footprint - model.footprint),
        Math.abs(grey.height - model.height),
      );
      expect(fitted).toBeLessThan(0.02);
      // Neither dimension may overshoot the model: a stand-in that is bigger
      // than the real thing is the failure mode this test exists for.
      expect(grey.footprint).toBeLessThanOrEqual(model.footprint + 0.02);
      expect(grey.height).toBeLessThanOrEqual(model.height + 0.02);
    });
  }

  test("every stand-in stands on the ground plane", () => {
    for (const [bucketName] of PAIRS) {
      const g = (meshes[bucketName] as { mesh: THREE.InstancedMesh }).mesh.geometry;
      g.computeBoundingBox();
      expect(Math.abs(g.boundingBox?.min.y ?? 1)).toBeLessThan(1e-6);
    }
  });
});
