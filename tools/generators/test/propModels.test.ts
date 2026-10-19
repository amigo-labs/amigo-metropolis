// Contract test for the COMMITTED arena scenery models (#28). Sibling of
// unitModels.test.ts, with the one contract inverted that matters: props are
// NOT fitted to a greybox footprint and NOT re-centred, because they are placed
// in the original's own frame at the original's own coordinates. So instead of
// checking a target footprint, this checks the output still measures what the
// raw extraction measures — the assertion that `keepScale` really kept it.
//
// Each arena draws its own mission's Cobjs (manifest.ts ARENA_SCENERY): the
// same id is another model on another arena, so the outputs live in one
// folder per arena and the coverage check runs per arena too.
//
// If PROP_MODELS changes, `bun run gen:units` must be re-run in the same commit.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Document, getBounds, NodeIO } from "@gltf-transform/core";
import { SCENERY_PLACEMENTS } from "../../../packages/client/src/render/arenaScenery.generated";
import { ARENA_SCENERY, EMITTER_PROP_MODELS, PROP_MODELS, sceneryRaw } from "../units/manifest";
import { expectFaceModes, faceBounds, triangles } from "./faceModes";

const REPO = join(import.meta.dir, "..", "..", "..");
const OUT_DIR = join(REPO, "packages", "client", "public", "models", "props");
const RAW_DIR = join(REPO, "tools", "generators", "units", "raw");

const io = new NodeIO();

/** Every POSITION of every primitive, in order: the payload's geometry. */
function positions(document: Document): number[] {
  const out: number[] = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const array = prim.getAttribute("POSITION")?.getArray();
      if (array) out.push(...array);
    }
  }
  return out;
}

describe("committed prop models match the manifest contract", () => {
  for (const spec of PROP_MODELS) {
    test(`${spec.mapId}/${spec.key}`, async () => {
      expect(spec.key).toBe(`prop-${String(spec.cobj).padStart(3, "0")}`);
      expect(spec.raw).toBe(sceneryRaw(spec.mission, spec.cobj));

      const document = await io.read(join(OUT_DIR, spec.mapId, `${spec.key}.glb`));
      const root = document.getRoot();

      // One mesh, a primitive per face mode, the shape render/props.ts swaps
      // into the model's InstancedMesh. The scenery Cobjs are all textured.
      const prims = expectFaceModes(document);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      // Cobj 28 is morph-animated, its cloth: the pipeline keeps its targets
      // (frame k + 1 is target k, render/props.ts steps them). Everything
      // else ships frame 0 and no deltas a renderer would never drive.
      const frames = spec.morph?.frames ?? 1;
      expect(spec.morph === null).toBe(spec.cobj !== 28);
      expect(root.listMeshes()[0].getWeights().length).toBe(frames - 1);
      for (const prim of prims) {
        expect(prim.listTargets().length).toBe(frames - 1);
        expect(prim.getAttribute("TEXCOORD_0")).not.toBeNull();
        expect(prim.getAttribute("NORMAL")).not.toBeNull();
      }

      const tris = prims.reduce((n, p) => n + triangles(p), 0);
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);

      const scene = root.getDefaultScene() ?? root.listScenes()[0];
      const out = getBounds(scene);

      // Ground-contact origin: Y only. render/props.ts stands the origin at the
      // record's height, so minY must be the contact point.
      expect(Math.abs(out.min[1])).toBeLessThanOrEqual(0.02);

      // Original scale kept: the output measures what the raw measures on every
      // axis. This is what would break if the unit fitting path ever caught
      // props by accident.
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      const rawRoot = rawDoc.getRoot();
      const raw = faceBounds(rawDoc);
      expect(tris).toBe(raw.tris);
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

      // The raw is the mission's own export (extract_objects.py names the node
      // `<Mission>_obj_NNN`), so the texels are the mission's — never Mp's file
      // standing in for an id that means something else here.
      const names = rawRoot.listNodes().map((n) => n.getName());
      expect(names).toContain(`${spec.mission}_obj_${String(spec.cobj).padStart(3, "0")}`);

      // The twin the manifest names is real: the same geometry as Mp's model
      // of that id. A model of the mission's own is not Mp's same-numbered one.
      if (spec.mission !== "Mp") {
        const twinId = spec.mpTwin ?? spec.cobj;
        const mp = await io.read(join(RAW_DIR, sceneryRaw("Mp", twinId)));
        if (spec.mpTwin !== null) expect(positions(rawDoc)).toEqual(positions(mp));
        else expect(positions(rawDoc)).not.toEqual(positions(mp));
      } else {
        expect(spec.mpTwin).toBe(spec.cobj);
      }
    });
  }

  // Coverage per arena, not across all of them: an id that one arena places
  // and another arena's folder happens to carry is exactly the bug this
  // replaced (urban-jungle drew Mp's Dreadnought hull and Flying Fortress for
  // its own kiosks 36 and 41).
  test("every arena's placed Cobj ids are exactly its models", () => {
    expect(Object.keys(SCENERY_PLACEMENTS).sort()).toEqual(
      ARENA_SCENERY.map((a) => a.mapId).sort(),
    );
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      const placed = [...new Set(scenery.placements.map((p) => p.cobj))].sort((a, b) => a - b);
      const carried = PROP_MODELS.filter((s) => s.mapId === mapId)
        .map((s) => s.cobj)
        .sort((a, b) => a - b);
      expect({ map: mapId, ids: carried }).toEqual({ map: mapId, ids: placed });
      expect(scenery.mission).toBe(ARENA_SCENERY.find((a) => a.mapId === mapId)?.mission ?? "");
    }
  });

  // The morph each model plays is its own: gen:units kept as many targets as
  // the table's track has frames, less the base.
  test("the scenery table's morphs are the committed models' targets", async () => {
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const [cobj, morph] of Object.entries(scenery.morphs)) {
        const spec = PROP_MODELS.find((s) => s.mapId === mapId && s.cobj === Number(cobj));
        expect(spec?.morph).toEqual(morph);
      }
    }
  });
});

// The type-96 Props' models (fcop-fidelity.md G13): each arena's own export,
// its origin kept on every axis — `snd_emit_build` stands the model's origin
// at the record's height, and a lamp hangs below its own.
describe("committed Prop models keep the raw's frame", () => {
  for (const spec of EMITTER_PROP_MODELS) {
    test(`${spec.mapId}/${spec.key}`, async () => {
      expect(spec.keepOrigin).toBe(true);
      const document = await io.read(join(OUT_DIR, spec.mapId, `${spec.key}.glb`));
      const prims = expectFaceModes(document);
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      const rawRoot = rawDoc.getRoot();
      const raw = faceBounds(rawDoc);
      expect(prims.reduce((n, p) => n + triangles(p), 0)).toBe(raw.tris);
      const names = rawRoot.listNodes().map((n) => n.getName());
      expect(names).toContain(`${spec.mission}_obj_${String(spec.cobj).padStart(3, "0")}`);
      // A model of facers only (render/facers.ts draws them) has no faces.
      if (prims.length === 0) return;
      for (const prim of prims) {
        expect(prim.listTargets().length).toBe((spec.morph?.frames ?? 1) - 1);
      }
      const out = faceBounds(document);
      for (const axis of [0, 1, 2]) {
        expect(Math.abs(out.min[axis] - raw.min[axis])).toBeLessThanOrEqual(0.01);
        expect(Math.abs(out.max[axis] - raw.max[axis])).toBeLessThanOrEqual(0.01);
      }
    });
  }

  test("are every drawn model of every arena's Props, and only those", () => {
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      const drawn = Object.entries(scenery.propModels)
        .filter(([, m]) => m.drawn)
        .map(([c]) => Number(c));
      const carried = EMITTER_PROP_MODELS.filter((s) => s.mapId === mapId).map((s) => s.cobj);
      expect({ mapId, ids: carried.sort((a, b) => a - b) }).toEqual({
        mapId,
        ids: drawn.sort((a, b) => a - b),
      });
    }
  });
});
