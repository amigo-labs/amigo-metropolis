// Contract test for the COMMITTED arena scenery models (#28). Sibling of
// unitModels.test.ts, with the one contract inverted that matters: props are
// NOT fitted to a greybox footprint and NOT re-centred, because they are placed
// in the original's own frame at the original's own coordinates. So instead of
// checking a target footprint, this checks the output still measures what the
// raw extraction measures — the assertion that `keepScale` really kept it.
//
// If PROP_MODELS changes, `bun run gen:units` must be re-run in the same commit.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getBounds, NodeIO } from "@gltf-transform/core";
import laCantina from "../../../packages/sim/maps/la-cantina.json";
import { PROP_MODELS } from "../units/manifest";

const REPO = join(import.meta.dir, "..", "..", "..");
const OUT_DIR = join(REPO, "packages", "client", "public", "models", "props");
const RAW_DIR = join(REPO, "tools", "generators", "units", "raw");

const io = new NodeIO();

describe("committed prop models match the manifest contract", () => {
  for (const spec of PROP_MODELS) {
    test(spec.key, async () => {
      expect(spec.key).toBe(`prop-${String(spec.cobj).padStart(3, "0")}`);

      const document = await io.read(join(OUT_DIR, `${spec.key}.glb`));
      const root = document.getRoot();

      // One single-material primitive, the shape render/props.ts swaps into the
      // model's InstancedMesh. The scenery Cobjs are all textured.
      expect(root.listMaterials().length).toBe(1);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      const meshes = root.listMeshes();
      expect(meshes.length).toBe(1);
      const prims = meshes[0].listPrimitives();
      expect(prims.length).toBe(1);
      // Cobj 28 is morph-animated; the pipeline keeps frame 0 and must not
      // leave the morph deltas behind for a renderer that never drives them.
      expect(prims[0].listTargets().length).toBe(0);
      expect(meshes[0].getWeights().length).toBe(0);
      expect(root.listTextures().length).toBe(1);
      expect(root.listMaterials()[0].getBaseColorTexture()).not.toBeNull();
      expect(prims[0].getAttribute("TEXCOORD_0")).not.toBeNull();
      expect(prims[0].getAttribute("NORMAL")).not.toBeNull();

      const indices = prims[0].getIndices();
      const tris =
        (indices ? indices.getCount() : (prims[0].getAttribute("POSITION")?.getCount() ?? 0)) / 3;
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);

      const scene = root.getDefaultScene() ?? root.listScenes()[0];
      const out = getBounds(scene);

      // Ground-contact origin: Y only. render/props.ts adds sampleHeight, so
      // minY must be the contact point.
      expect(Math.abs(out.min[1])).toBeLessThanOrEqual(0.02);

      // Original scale kept: the output measures what the raw measures on every
      // axis. This is what would break if the unit fitting path ever caught
      // props by accident.
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      const rawRoot = rawDoc.getRoot();
      const raw = getBounds(rawRoot.getDefaultScene() ?? rawRoot.listScenes()[0]);
      for (const axis of [0, 1, 2]) {
        const outSize = out.max[axis] - out.min[axis];
        const rawSize = raw.max[axis] - raw.min[axis];
        expect(Math.abs(outSize - rawSize)).toBeLessThanOrEqual(0.01);
      }

      // Original origin kept in XZ: unlike units, the prop is NOT re-centred,
      // so its horizontal offset from the placement point survives. Cobj 28's
      // is 0.32 m in Z and carries its barrier off the kerb if dropped.
      for (const axis of [0, 2]) {
        expect(Math.abs(out.min[axis] - raw.min[axis])).toBeLessThanOrEqual(0.01);
      }
    });
  }

  test("every Cobj id placed in la-cantina has a model", () => {
    const placed = new Set(laCantina.props.map((p) => p.model));
    const known = new Set(PROP_MODELS.map((s) => s.cobj));
    expect([...placed].filter((id) => !known.has(id))).toEqual([]);
    // And nothing is carried that the arena never places.
    expect([...known].filter((id) => !placed.has(id))).toEqual([]);
  });
});
