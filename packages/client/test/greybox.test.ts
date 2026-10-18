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
import {
  ARCHETYPE,
  PROJ_HEAVY,
  PROJ_HYPER,
  PROJ_MINE,
  PROJ_MORTAR,
  PROJ_ROUND,
  PROJ_SHOCKWAVE,
  PROJ_SPECIAL,
  PROJ_WARDEN,
} from "@metropolis/sim";
import * as THREE from "three";
import { bucketFor, createGreyboxMeshes, type GreyboxMeshes } from "../src/render/greybox";

/** Max horizontal extent and height of a committed model, in metres. */
async function modelSize(
  key: string,
  dir: "units" | "fx" | "props" = "units",
): Promise<{ footprint: number; height: number }> {
  const path = new URL(`../public/models/${dir}/${key}.glb`, import.meta.url).pathname;
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

/**
 * Bucket name -> model key, for every archetype that has both. The arena's own
 * units load per arena (render/arenaUnits.ts) and differ by mission (Joke's
 * are other models altogether); the stand-ins are la-cantina's, Mp's, which is
 * also what a map with no mission draws. The outpost console is scenery
 * (render/props.ts): its box stands in for Mp's Cobj 29.
 */
const PAIRS: readonly (readonly [keyof GreyboxMeshes, string, ("units" | "props")?])[] = [
  ["avatarWalker", "avatar-walker"],
  ["avatarHover", "avatar-hover"],
  ["runner", "la-cantina/obj_030"],
  ["guardian", "la-cantina/obj_022"],
  ["juggernaut", "la-cantina/obj_036"],
  ["fortress", "la-cantina/obj_041"],
  ["console", "la-cantina/prop-029", "props"],
  ["warden", "la-cantina/obj_054"],
];

describe("greybox stand-ins match the models they stand in for", () => {
  const meshes = createGreyboxMeshes(new THREE.Scene());

  for (const [bucketName, key, dir] of PAIRS) {
    test(`${key}`, async () => {
      const model = await modelSize(key, dir);
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

/**
 * Bucket name -> FX model key, for the projectile kinds that have a mesh, and
 * the world row a PROJ_ROUND came from (0 for the other kinds).
 */
const FX_PAIRS: readonly (readonly [keyof GreyboxMeshes, string, number, number])[] = [
  ["projHeavy", "rocket-helfire", PROJ_HEAVY, 0],
  ["projHyper", "rocket-hyper", PROJ_HYPER, 0],
  ["projMortar", "shell-mortar", PROJ_MORTAR, 0],
  ["projMine", "mine", PROJ_MINE, 0],
  // The Sky Captain's bomb is world row 9: Cobj 49.
  ["projWarden", "round-row9", PROJ_WARDEN, 0],
  // The world rows' rounds that are models, by the row that fired them (the
  // bolts of rows 1, 3 and 6 are render/fx.ts's line facers).
  ["roundRow4", "round-row4", PROJ_ROUND, 4],
  ["roundRow8", "round-row8", PROJ_ROUND, 8],
];

describe("projectile stand-ins match the FX models they stand in for", () => {
  const meshes = createGreyboxMeshes(new THREE.Scene());

  for (const [bucketName, key, kind, row] of FX_PAIRS) {
    test(`${key}`, async () => {
      const model = await modelSize(key, "fx");
      const grey = bucketSize((meshes[bucketName] as { mesh: THREE.InstancedMesh }).mesh);
      const fitted = Math.min(
        Math.abs(grey.footprint - model.footprint),
        Math.abs(grey.height - model.height),
      );
      expect(fitted).toBeLessThan(0.02);
      expect(grey.footprint).toBeLessThanOrEqual(model.footprint + 0.02);
      expect(grey.height).toBeLessThanOrEqual(model.height + 0.02);
      // Each kind routes to its OWN bucket — that is the whole point of the
      // split, and the reason the tint no longer has to carry the kind.
      expect(bucketFor(meshes, ARCHETYPE.PROJECTILE, 0, kind, row)).toBe(meshes[bucketName]);
    });
  }

  test("projectile stand-ins are centred on the pivot, not grounded", () => {
    // The opposite invariant to the units above: a shell has no ground contact,
    // and the FX models keep the centre the original authored (assets.md §4).
    for (const [bucketName] of FX_PAIRS) {
      const g = (meshes[bucketName] as { mesh: THREE.InstancedMesh }).mesh.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      expect(bb).not.toBeNull();
      expect(Math.abs(((bb?.min.y ?? 0) + (bb?.max.y ?? 0)) / 2)).toBeLessThan(1e-6);
    }
  });

  test("the legacy special kind shares the mortar's shell", () => {
    // PROJ_SPECIAL is the old id for the mortar blast and projectileBlast()
    // already treats the two as one; the drawing must agree.
    expect(bucketFor(meshes, ARCHETYPE.PROJECTILE, 0, PROJ_SPECIAL)).toBe(meshes.projMortar);
  });

  test("a kind with no mesh of its own falls back rather than vanishing", () => {
    expect(bucketFor(meshes, ARCHETYPE.PROJECTILE, 0, PROJ_SHOCKWAVE)).toBe(meshes.projectile);
    // A round whose launch the client never saw (row 0) still draws.
    expect(bucketFor(meshes, ARCHETYPE.PROJECTILE, 0, PROJ_ROUND, 0)).toBe(meshes.projectile);
  });

  test("the world rounds wear the original's own colours: no team tint", () => {
    for (const b of [meshes.roundRow4, meshes.roundRow8, meshes.projWarden]) {
      expect(b.untinted).toBe(true);
    }
    expect(meshes.projHeavy.untinted).toBeUndefined();
  });
});
