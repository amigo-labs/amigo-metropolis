// Contract test for the COMMITTED Stage B unit models (assets.md §4): every
// manifest entry must have a matching glb under
// packages/client/public/models/units/ that still satisfies the pipeline's
// output guarantees. Guards against hand-edited or stale assets — if the
// manifest changes, `bun run gen:units` must be re-run in the same commit.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Document, getBounds, NodeIO, type Primitive } from "@gltf-transform/core";
import { getMapById } from "@metropolis/sim";
import {
  ARENA_UNITS,
  UNIT_MODEL_FILES,
} from "../../../packages/client/src/render/arenaUnits.generated";
import { ARENA_UNIT_MODELS, FX_MODELS, UNIT_MODELS } from "../units/manifest";

const MODELS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "client",
  "public",
  "models",
);
const OUT_DIR = join(MODELS_DIR, "units");
const FX_DIR = join(MODELS_DIR, "fx");
const RAW_DIR = join(import.meta.dir, "..", "units", "raw");

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
        // COLOR_0 alongside the atlas means leftover facer verts (FX_MODELS
        // keep them; units drop tex10/facer before the merge). Where it is
        // present it must cover every vertex, or the two would drift apart.
        const mixed = prims[0].getAttribute("COLOR_0");
        if (mixed) {
          expect(mixed.getType()).toBe("VEC4");
          expect(mixed.getCount()).toBe(prims[0].getAttribute("POSITION")?.getCount() ?? 0);
        }
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
      // beacon hovering above them (genUnitModels.ts bakeSkinRestPose). A gap
      // the original authored is named in the manifest, and only that one is let
      // through (the jet's mast-less rotor).
      expect(largestVerticalGap(prims[0])).toBeLessThanOrEqual(
        Math.max(sizeY * 0.02, (spec.authoredGap ?? 0) + 0.001),
      );

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

// Projectiles and weapon effects (docs/specs/fcop-fx.md). Same one-mesh /
// one-material contract as the units, and the same native-size rule, but the
// ORIGIN contract is the opposite one: these fly about the centre the original
// authored, so instead of the ground-contact and XZ-centring assertions above,
// the built box is held against the raw's box — pivot and scale in one check.
describe("committed FX models match the manifest contract", () => {
  for (const spec of FX_MODELS) {
    test(spec.key, async () => {
      const document = await io.read(join(FX_DIR, `${spec.key}.glb`));
      const root = document.getRoot();

      expect(root.listMaterials().length).toBe(1);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      const meshes = root.listMeshes();
      expect(meshes.length).toBe(1);
      const prims = meshes[0].listPrimitives();
      expect(prims.length).toBe(1);
      expect(prims[0].getAttribute("NORMAL")).not.toBeNull();
      expect(root.listTextures().length).toBeLessThanOrEqual(1);

      const indices = prims[0].getIndices();
      const tris =
        (indices ? indices.getCount() : (prims[0].getAttribute("POSITION")?.getCount() ?? 0)) / 3;
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);

      const scene = root.getDefaultScene() ?? root.listScenes()[0];
      const { min, max } = getBounds(scene);

      // The authored pivot AND the authored size, both kept, asserted the only
      // way that actually proves it: against the raw's own box. Not "the origin
      // is inside the model" — the Hyper Velocity Rocket's origin sits 5 cm below its
      // body, and that is the original's choice, not damage. Grounding a
      // projectile (minY -> 0) would lift every bolt off the line it travels
      // along, which is why FX_MODELS opts out of it in the generator.
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      const rawScene = rawDoc.getRoot().getDefaultScene() ?? rawDoc.getRoot().listScenes()[0];
      const raw = getBounds(rawScene);
      for (const axis of [0, 1, 2]) {
        expect(Math.abs(min[axis] - raw.min[axis])).toBeLessThanOrEqual(0.002);
        expect(Math.abs(max[axis] - raw.max[axis])).toBeLessThanOrEqual(0.002);
      }

      // Native FCOP size: the manifest's numbers are soft upper bounds measured
      // off the raw, never targets to stretch to (same rule as the units).
      const sizeX = max[0] - min[0];
      const sizeY = max[1] - min[1];
      const sizeZ = max[2] - min[2];
      expect(Math.max(sizeX, sizeZ)).toBeLessThanOrEqual(spec.footprint * 1.05);
      expect(sizeY).toBeLessThanOrEqual(spec.maxHeight * 1.05);
      // And not collapsed: a model that lost its scale would pass the bound above.
      expect(Math.max(sizeX, sizeY, sizeZ)).toBeGreaterThan(0.05);
    });
  }
});

// Every body's hit radius is the original's radius_68 of the model its arena
// draws: the halfword at +12 of its 3DBB box, the box's half-diagonal (sim
// MapData.radii from tools/generators/fcop/<mission>-models.json;
// fcop-fidelity.md G1). The drawn mesh's own box lands within the 1/512
// quantisation of it, so a model swapped for another without its radius
// following fails here. The Sky Captain's box holds its searchlight volume,
// which the drawn unit leaves out (see the hull-only test below): it is held to
// its raw, the Cobj as shipped.
describe("hit radii follow the models each arena draws", () => {
  const rawOf = (file: string): string => {
    const spec = UNIT_MODEL_FILES.find((f) => f.file === file);
    if (!spec) throw new Error(`${file} is not in UNIT_MODEL_FILES`);
    return join(RAW_DIR, spec.raw);
  };
  const halfDiagonal = async (file: string, raw = false): Promise<number> => {
    const document = await io.read(raw ? rawOf(file) : join(OUT_DIR, `${file}.glb`));
    const root = document.getRoot();
    const { min, max } = getBounds(root.getDefaultScene() ?? root.listScenes()[0]);
    const hx = (max[0] - min[0]) / 2;
    const hy = (max[1] - min[1]) / 2;
    const hz = (max[2] - min[2]) / 2;
    return Math.sqrt(hx * hx + hy * hy + hz * hz);
  };
  for (const [mapId, units] of Object.entries(ARENA_UNITS)) {
    const radii = getMapById(mapId).radii;
    const bodies: [string, string, number, boolean?][] = [
      ["tank", units.tank.model, radii.tank],
      ["jet", units.jet.model, radii.jet],
      ["fortress", units.fortress.model, radii.fortress],
      ["dreadnought hull", units.dreadnought.hull, radii.dreadnought],
      ["base turret gun", units.baseTurret.gun, radii.baseTurret],
      ...units.neutralTurrets.map((t, i): [string, string, number] => [
        `neutral gun ${i}`,
        t.gun,
        radii.neutral[t.spots[0]],
      ]),
      ...units.skyCaptain.byLevel.map((file, level): [string, string, number, boolean] => [
        `Sky Captain level ${level}`,
        file,
        radii.skyCaptain[level],
        true,
      ]),
    ];
    for (const [what, file, radius, raw] of bodies) {
      test(`${mapId} ${what}: its radius is its box's half-diagonal`, async () => {
        expect(Math.abs((await halfDiagonal(file, raw)) - radius)).toBeLessThan(0.01);
      });
    }
  }
});

// Each arena's own units (fcop-fidelity.md G1): the files gen:paunits names in
// arenaUnits.generated.ts, built by gen:units. Same one-mesh / one-material
// contract; the size is the raw's own, measured over what the pipeline keeps
// (FX attachments go), and a `part` keeps the raw's origin and bounds exactly,
// because its attach points and its pivot are measured in that frame.
describe("committed arena unit models match the table", () => {
  for (const spec of ARENA_UNIT_MODELS) {
    test(spec.file, async () => {
      const document = await io.read(join(OUT_DIR, `${spec.file}.glb`));
      const root = document.getRoot();
      expect(root.listMaterials().length).toBe(1);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      const meshes = root.listMeshes();
      expect(meshes.length).toBe(1);
      const prims = meshes[0].listPrimitives();
      expect(prims.length).toBe(1);
      expect(root.listTextures().length).toBe(1);
      expect(prims[0].getAttribute("TEXCOORD_0")).not.toBeNull();
      // FX attachments are gone, so no facer colour rides along.
      expect(prims[0].getAttribute("COLOR_0")).toBeNull();

      // The raw is the mission's own export of that Cobj.
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      const rawRoot = rawDoc.getRoot();
      const names = rawRoot.listNodes().map((n) => n.getName());
      expect(names).toContain(`${spec.mission}_obj_${String(spec.cobj).padStart(3, "0")}`);

      const kept = keptBounds(rawDoc);
      const scene = root.getDefaultScene() ?? root.listScenes()[0];
      const out = getBounds(scene);
      const tris = triangles(prims[0]);
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);
      if (spec.treatment === "part") {
        // Origin and bounds are the raw's, triangle for triangle.
        for (const axis of [0, 1, 2]) {
          expect(Math.abs(out.min[axis] - kept.min[axis])).toBeLessThanOrEqual(0.002);
          expect(Math.abs(out.max[axis] - kept.max[axis])).toBeLessThanOrEqual(0.002);
        }
        expect(tris).toBe(kept.tris);
      } else {
        // Grounded and centred; never larger than what the raw keeps (the Sky
        // Captain's exhaust cards are dropped too), and the same height or
        // footprint where nothing is dropped.
        expect(Math.abs(out.min[1])).toBeLessThanOrEqual(0.02);
        expect(Math.abs(out.min[0] + out.max[0])).toBeLessThanOrEqual(0.04);
        expect(Math.abs(out.min[2] + out.max[2])).toBeLessThanOrEqual(0.04);
        // No zero-thickness card survives the planar-billboard drop.
        expect(thinnestComponent(prims[0])).toBeGreaterThan(0.02 - 1e-6);
        // A skinned raw (Joke's jet) holds its bind pose; gen:units bakes the
        // rest pose, so its vertices are not the raw's to measure against.
        if (rawRoot.listSkins().length > 0) return;
        const size = [0, 1, 2].map((a) => out.max[a] - out.min[a]);
        const rawSize = [0, 1, 2].map((a) => kept.max[a] - kept.min[a]);
        expect(size[1]).toBeLessThanOrEqual(rawSize[1] + 0.002);
        expect(Math.max(size[0], size[2])).toBeLessThanOrEqual(
          Math.max(rawSize[0], rawSize[2]) + 0.002,
        );
        if (tris === kept.tris) {
          // Nothing dropped: the same box (a half turn keeps the axes).
          for (const axis of [0, 1, 2]) {
            expect(Math.abs(size[axis] - rawSize[axis])).toBeLessThanOrEqual(0.002);
          }
        }
      }
    });
  }

  // A kept morph (the jet's rotor) must be the raw's frames, moved only by the
  // grounding: frame k + 1 is target k at weight 1. Every other file ships
  // frame 0 alone.
  test("the morphs kept are the raw's frames; nothing else keeps targets", async () => {
    for (const spec of ARENA_UNIT_MODELS) {
      const doc = await io.read(join(OUT_DIR, `${spec.file}.glb`));
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      if (!spec.morph) {
        expect({ file: spec.file, targets: prim.listTargets().length }).toEqual({
          file: spec.file,
          targets: 0,
        });
        continue;
      }
      const targets = prim.listTargets();
      expect(targets.length).toBe(spec.morph.frames - 1);
      const raw = await io.read(join(RAW_DIR, spec.raw));
      const rawPrims = raw
        .getRoot()
        .listMeshes()
        .flatMap((m) => m.listPrimitives())
        .filter((p) => !["tex10", "facer"].includes(p.getMaterial()?.getName() ?? ""));
      // Match each output vertex to its raw vertex by frame-0 position (the
      // output is the raw shifted by the grounding offset).
      const out = prim.getAttribute("POSITION");
      const rawBase = rawPrims[0].getAttribute("POSITION");
      if (!out || !rawBase) throw new Error("no positions");
      const shift = [0, 1, 2].map(
        (a) => (out.getMin([0, 0, 0])[a] as number) - keptBounds(raw).min[a],
      );
      const key = (p: number[]) => p.map((v) => Math.round(v * 1000)).join(",");
      const rawIndex = new Map<string, number>();
      const e = [0, 0, 0];
      for (let i = 0; i < rawBase.getCount(); i++) {
        rawBase.getElement(i, e);
        rawIndex.set(key([e[0] + shift[0], e[1] + shift[1], e[2] + shift[2]]), i);
      }
      const d = [0, 0, 0];
      const rd = [0, 0, 0];
      let matched = 0;
      for (let i = 0; i < out.getCount(); i++) {
        out.getElement(i, e);
        const r = rawIndex.get(key(e));
        if (r === undefined) continue;
        matched++;
        targets.forEach((t, k) => {
          t.getAttribute("POSITION")?.getElement(i, d);
          rawPrims[0].listTargets()[k].getAttribute("POSITION")?.getElement(r, rd);
          for (let a = 0; a < 3; a++) expect(Math.abs(d[a] - rd[a])).toBeLessThan(1e-5);
        });
      }
      expect(matched).toBe(out.getCount());
    }
  });

  // The guns' attach points are hull vertices outside every face (RE
  // cact_model_point), measured in the hull's raw frame; the hull keeps that
  // frame (`part`), so each point must sit on the committed hull's box.
  test("every Dreadnought gun stands on its hull", async () => {
    for (const [mapId, u] of Object.entries(ARENA_UNITS)) {
      const hull = await io.read(join(OUT_DIR, `${u.dreadnought.hull}.glb`));
      const { min, max } = getBounds(hull.getRoot().listScenes()[0]);
      for (const g of u.dreadnought.guns) {
        for (const axis of [0, 1, 2]) {
          const inside = g.point[axis] >= min[axis] - 0.01 && g.point[axis] <= max[axis] + 0.01;
          expect({ mapId, axis, inside }).toEqual({ mapId, axis, inside: true });
        }
      }
    }
  });

  test("every role of every arena names a committed file", () => {
    const files = new Set(ARENA_UNIT_MODELS.map((s) => s.file));
    for (const [mapId, u] of Object.entries(ARENA_UNITS)) {
      const refs = [
        u.tank.model,
        u.jet.model,
        u.fortress.model,
        u.dreadnought.hull,
        ...u.dreadnought.guns.map((g) => g.model),
        u.baseTurret.gun,
        u.baseTurret.base,
        ...u.neutralTurrets.flatMap((t) => [t.gun, t.base]),
        ...u.skyCaptain.byLevel,
      ];
      for (const ref of refs) {
        expect({ mapId, ref, known: files.has(ref) }).toEqual({ mapId, ref, known: true });
        const spec = ARENA_UNIT_MODELS.find((s) => s.file === ref);
        expect(spec?.usedBy).toContain(mapId);
      }
    }
  });
});

/** Bounds and triangle count over what the pipeline keeps (no tex10 / facer). */
function keptBounds(document: Document): { min: number[]; max: number[]; tris: number } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let tris = 0;
  const el = [0, 0, 0];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const name = prim.getMaterial()?.getName() ?? "";
      if (name === "tex10" || name === "facer") continue;
      tris += triangles(prim);
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
  }
  return { min, max, tris };
}

function triangles(prim: Primitive): number {
  const indices = prim.getIndices();
  return (indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0)) / 3;
}

/** Smallest AABB dimension across position-welded connected components. */
function thinnestComponent(prim: Primitive): number {
  const pos = prim.getAttribute("POSITION");
  const indices = prim.getIndices();
  if (!pos) return 0;
  const triCount = (indices ? indices.getCount() : pos.getCount()) / 3;
  const vertAt = (t: number, k: number): number =>
    indices ? indices.getScalar(t * 3 + k) : t * 3 + k;
  const parent = Array.from({ length: pos.getCount() }, (_, i) => i);
  const find = (x: number): number => {
    let i = x;
    while (parent[i] !== i) i = parent[i];
    let j = x;
    while (j !== i) {
      const next = parent[j];
      parent[j] = i;
      j = next;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const quant = (i: number): string => {
    const e = [0, 0, 0];
    pos.getElement(i, e);
    return `${Math.round(e[0] * 1000)},${Math.round(e[1] * 1000)},${Math.round(e[2] * 1000)}`;
  };
  const firstAt = new Map<string, number>();
  for (let i = 0; i < pos.getCount(); i++) {
    const key = quant(i);
    const seen = firstAt.get(key);
    if (seen === undefined) firstAt.set(key, i);
    else union(i, seen);
  }
  for (let t = 0; t < triCount; t++) {
    union(vertAt(t, 0), vertAt(t, 1));
    union(vertAt(t, 1), vertAt(t, 2));
  }
  const comps = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = find(vertAt(t, 0));
    const list = comps.get(root);
    if (list) list.push(t);
    else comps.set(root, [t]);
  }
  let thin = Number.POSITIVE_INFINITY;
  const el = [0, 0, 0];
  for (const tris of comps.values()) {
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        pos.getElement(vertAt(t, k), el);
        for (let a = 0; a < 3; a++) {
          if (el[a] < min[a]) min[a] = el[a];
          if (el[a] > max[a]) max[a] = el[a];
        }
      }
    }
    thin = Math.min(thin, max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }
  return thin;
}
