// Contract test for the COMMITTED Stage B unit models (assets.md §4): every
// manifest entry must have a matching glb under
// packages/client/public/models/units/ that still satisfies the pipeline's
// output guarantees. Guards against hand-edited or stale assets — if the
// manifest changes, `bun run gen:units` must be re-run in the same commit.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getBounds, NodeIO, type Primitive } from "@gltf-transform/core";
import { UNIT_MODELS } from "../units/manifest";

const OUT_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "client",
  "public",
  "models",
  "units",
);

const io = new NodeIO();

/**
 * Largest empty horizontal slab inside the mesh, in world units: sorts the
 * triangles by their vertical span and measures how far the covered range ever
 * jumps. Triangle spans rather than vertex heights, so a tall flat wall with
 * vertices only at its ends still counts as covered.
 */
function largestVerticalGap(prim: Primitive): number {
  const pos = prim.getAttribute("POSITION");
  if (!pos) return 0;
  const indices = prim.getIndices();
  const count = indices ? indices.getCount() : pos.getCount();
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const spans: number[][] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    pos.getElement(indices ? indices.getScalar(i) : i, a);
    pos.getElement(indices ? indices.getScalar(i + 1) : i + 1, b);
    pos.getElement(indices ? indices.getScalar(i + 2) : i + 2, c);
    spans.push([Math.min(a[1], b[1], c[1]), Math.max(a[1], b[1], c[1])]);
  }
  if (spans.length === 0) return 0;
  spans.sort((p, q) => p[0] - q[0]);
  let reach = spans[0][1];
  let gap = 0;
  for (const [lo, hi] of spans) {
    if (lo > reach) gap = Math.max(gap, lo - reach);
    if (hi > reach) reach = hi;
  }
  return gap;
}

describe("committed unit models match the manifest contract", () => {
  for (const spec of UNIT_MODELS) {
    test(spec.key, async () => {
      const document = await io.read(join(OUT_DIR, `${spec.key}.glb`));
      const root = document.getRoot();

      // One single-material primitive under a "root" node — the shape
      // render/unitMeshes.ts swaps into the archetype's InstancedMesh. Color
      // comes either from ONE packed atlas texture (FCOP originals) or from
      // baked vertex colors (untextured packs) — never both, never several.
      const material = root.listMaterials()[0];
      expect(root.listMaterials().length).toBe(1);
      expect(material.getMetallicFactor()).toBe(0);
      expect(material.getRoughnessFactor()).toBe(1);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      const meshes = root.listMeshes();
      expect(meshes.length).toBe(1);
      const prims = meshes[0].listPrimitives();
      expect(prims.length).toBe(1);
      const texCount = root.listTextures().length;
      if (texCount > 0) {
        expect(texCount).toBe(1);
        expect(material.getBaseColorTexture()).not.toBeNull();
        expect(prims[0].getAttribute("TEXCOORD_0")).not.toBeNull();
        expect(prims[0].getAttribute("COLOR_0")).toBeNull();
      } else {
        expect(prims[0].getAttribute("COLOR_0")).not.toBeNull();
      }
      expect(prims[0].getAttribute("NORMAL")).not.toBeNull();
      expect(root.listNodes().some((n) => n.getName() === "root")).toBe(true);

      // Tri budget (assets.md §4).
      const indices = prims[0].getIndices();
      const tris =
        (indices ? indices.getCount() : (prims[0].getAttribute("POSITION")?.getCount() ?? 0)) / 3;
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);

      // Ground-contact center origin and size contract.
      const scene = root.getDefaultScene() ?? root.listScenes()[0];
      const { min, max } = getBounds(scene);
      expect(Math.abs(min[1])).toBeLessThanOrEqual(0.02);
      expect(Math.abs(min[0] + max[0])).toBeLessThanOrEqual(0.04);
      expect(Math.abs(min[2] + max[2])).toBeLessThanOrEqual(0.04);
      const sizeX = max[0] - min[0];
      const sizeY = max[1] - min[1];
      const sizeZ = max[2] - min[2];
      const footprint = Math.max(sizeX, sizeZ);
      if (spec.nativeScale) {
        // Authored FCOP size kept; footprint/maxHeight are soft upper bounds only.
        expect(footprint).toBeLessThanOrEqual(spec.footprint * 1.05);
        if (spec.maxHeight !== undefined) {
          expect(sizeY).toBeLessThanOrEqual(spec.maxHeight * 1.05);
        }
      } else {
        expect(footprint).toBeLessThanOrEqual(spec.footprint * 1.02);
      }
      // No floating parts: a unit is one solid silhouette, so its triangles
      // must cover the full height without an empty slab. Catches assemblies
      // that ship a pose the parts were never posed in — the skinned X1 rest
      // poses came out with the cockpit sunk into the legs and the guns and
      // beacon hovering above them (genUnitModels.ts bakeSkinRestPose).
      expect(largestVerticalGap(prims[0])).toBeLessThanOrEqual(sizeY * 0.02);

      if (!spec.nativeScale && spec.maxHeight === undefined) {
        expect(footprint).toBeGreaterThanOrEqual(spec.footprint * 0.98);
      } else if (!spec.nativeScale && spec.maxHeight !== undefined) {
        // Height-capped models trade footprint for the cap.
        expect(sizeY).toBeLessThanOrEqual(spec.maxHeight * 1.02);
        const capped = sizeY >= spec.maxHeight * 0.98;
        const full = footprint >= spec.footprint * 0.98;
        expect(capped || full).toBe(true);
      }
    });
  }
});
