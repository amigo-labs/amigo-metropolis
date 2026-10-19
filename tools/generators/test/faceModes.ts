// What every committed model's materials and primitives must say about the
// original's face draw modes (genUnitModels.ts; RE docs/formats/objects.md
// "Face draw modes"), and the raw's geometry the output is held to.
//
// A model is one mesh with one primitive per (mode, tint) key — opaque, then
// half, then add by tint — each with its own material on the model's single
// atlas: MASK at 0.25 for opaque, BLEND for half and add, `extras.fcop` naming
// the mode and an add face's raw 3DTL tint.

import { expect } from "bun:test";
import type { Document, Material, Primitive } from "@gltf-transform/core";

export type FaceMode = "opaque" | "half" | "add";

interface FcopExtras {
  mode?: FaceMode;
  tint?: number[];
  standin?: boolean;
}

export function fcopOf(material: Material | null): FcopExtras {
  return (material?.getExtras() as { fcop?: FcopExtras } | undefined)?.fcop ?? {};
}

const ORDER: Record<FaceMode, number> = { opaque: 0, half: 1, add: 2 };

/**
 * Asserts the face-mode contract on `document` and returns its primitives in
 * order (none for a model of facers only). `textured`: every material samples
 * the one atlas.
 */
export function expectFaceModes(document: Document, textured = true): Primitive[] {
  const root = document.getRoot();
  const meshes = root.listMeshes();
  expect(meshes.length).toBeLessThanOrEqual(1);
  if (meshes.length === 0) {
    expect(root.listMaterials().length).toBe(0);
    return [];
  }
  const prims = meshes[0].listPrimitives();
  expect(prims.length).toBeGreaterThan(0);
  const materials = prims.map((p) => p.getMaterial());
  // One primitive per material, and every material used.
  expect(new Set(materials).size).toBe(prims.length);
  expect(root.listMaterials().length).toBe(prims.length);
  const atlas = root.listTextures();
  if (textured) expect(atlas.length).toBe(1);
  let last = -1;
  const seen = new Set<string>();
  for (const material of materials) {
    if (!material) throw new Error("a primitive without its material");
    const fcop = fcopOf(material);
    const mode = fcop.mode ?? "opaque";
    expect(["opaque", "half", "add"]).toContain(mode);
    expect(ORDER[mode]).toBeGreaterThanOrEqual(last);
    last = ORDER[mode];
    const key = `${mode}:${fcop.tint?.join(",") ?? ""}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    expect(material.getMetallicFactor()).toBe(0);
    expect(material.getRoughnessFactor()).toBe(1);
    if (textured) {
      expect(material.getBaseColorTexture()).toBe(atlas[0]);
      if (mode === "opaque") {
        expect(material.getAlphaMode()).toBe("MASK");
        expect(material.getAlphaCutoff()).toBe(0.25);
      } else {
        expect(material.getAlphaMode()).toBe("BLEND");
      }
    }
    if (mode === "add") {
      // The raw bytes, 0x80 unity; the factor is the RE's, clamped.
      expect(fcop.tint?.length).toBe(3);
      const factor = material.getBaseColorFactor();
      fcop.tint?.forEach((c, i) => {
        expect(Math.abs(factor[i] - Math.min(1, (2 * c) / 255))).toBeLessThan(1e-6);
      });
    } else {
      expect(fcop.tint).toBeUndefined();
    }
  }
  return prims;
}

export function triangles(prim: Primitive): number {
  const indices = prim.getIndices();
  return (indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0)) / 3;
}

/**
 * Bounds and triangle count of `document`'s faces but the RE's stand-ins for
 * the facers, which the pipeline drops; `body` also leaves out the additive
 * faces, which the pipeline grounds and sizes without (light, not body).
 */
export function faceBounds(
  document: Document,
  body = false,
): { min: number[]; max: number[]; tris: number } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let tris = 0;
  const el = [0, 0, 0];
  const all = document
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .filter((p) => !fcopOf(p.getMaterial()).standin);
  const kept = body ? all.filter((p) => fcopOf(p.getMaterial()).mode !== "add") : all;
  for (const prim of all) tris += triangles(prim);
  for (const prim of kept.length > 0 ? kept : all) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      for (let a = 0; a < 3; a++) {
        if (el[a] < min[a]) min[a] = el[a];
        if (el[a] > max[a]) max[a] = el[a];
      }
    }
  }
  return { min, max, tris };
}
