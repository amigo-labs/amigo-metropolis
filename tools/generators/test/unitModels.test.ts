// Contract test for the COMMITTED Stage B unit models (assets.md §4): every
// manifest entry must have a matching glb under
// packages/client/public/models/units/ that still satisfies the pipeline's
// output guarantees. Guards against hand-edited or stale assets — if the
// manifest changes, `bun run gen:units` must be re-run in the same commit.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getBounds, NodeIO, type Primitive } from "@gltf-transform/core";
import { getMapById } from "@metropolis/sim";
import {
  ARENA_UNITS,
  UNIT_MODEL_FILES,
} from "../../../packages/client/src/render/arenaUnits.generated";
import { ARENA_UNIT_MODELS, FX_MODELS, UNIT_MODELS } from "../units/manifest";
import { expectFaceModes, faceBounds, fcopOf, triangles } from "./faceModes";

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

      // One primitive under a "root" node — the shape render/unitMeshes.ts
      // swaps into the archetype's InstancedMesh: the X1's parts come through
      // the RE's old path, opaque throughout (fcop-fidelity.md G13). Color
      // comes either from ONE packed atlas texture (FCOP originals) or from
      // baked vertex colors (untextured packs) — never both, never several.
      const texCount = root.listTextures().length;
      const prims = expectFaceModes(document, texCount > 0);
      expect(prims.length).toBe(1);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      if (texCount > 0) {
        expect(prims[0].getAttribute("TEXCOORD_0")).not.toBeNull();
        // COLOR_0 alongside the atlas means vertex-coloured faces (the white
        // patch). Where it is present it must cover every vertex, or the two
        // would drift apart.
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

      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      expect(root.listTextures().length).toBeLessThanOrEqual(1);
      // The bolts are line facers only (render/fx/ribbons.ts draws them), Cobj
      // 46 a star (render/facers.ts): no mesh, the records on the root node,
      // the atlas a textured one's page is on.
      const prims = expectFaceModes(document);
      const facers = (root.listNodes()[0].getExtras() as { fcop?: { facers?: { kind: string }[] } })
        .fcop?.facers;
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      // Each 3DAL animation rides the facer of its primitive, and nothing else does.
      const anims = (facers ?? []).flatMap((f) => {
        const a = (f as { prim?: number; colour_anim?: unknown }).colour_anim;
        return a ? [{ face: (f as { prim?: number }).prim, ...(a as object) }] : [];
      });
      expect(anims).toEqual((spec.colorAnims ?? []).map((a) => ({ ...a })));
      if (prims.length === 0) {
        expect(facers?.length).toBeGreaterThan(0);
        expect(facers?.every((f) => f.kind === "line" || f.kind === "star")).toBe(true);
        expect(faceBounds(rawDoc).tris).toBe(0);
        return;
      }
      for (const prim of prims) expect(prim.getAttribute("NORMAL")).not.toBeNull();
      const tris = prims.reduce((n, p) => n + triangles(p), 0);
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);
      // Every face of the raw but the facers' stand-ins.
      expect(tris).toBe(faceBounds(rawDoc).tris);

      // A kept morph (the K-9 Drone's run) is the raw's frames, unmoved:
      // frame k + 1 is target k. Every other FX model ships frame 0 alone.
      const frames = spec.morphFrames ?? 1;
      for (const prim of prims) expect(prim.listTargets().length).toBe(frames - 1);
      if (frames > 1) {
        const rawPrims = rawDoc
          .getRoot()
          .listMeshes()
          .flatMap((m) => m.listPrimitives())
          .filter((p) => !fcopOf(p.getMaterial()).standin);
        const motion = (list: Primitive[], k: number) => {
          let sum = 0;
          const d = [0, 0, 0];
          for (const p of list) {
            const a = p.listTargets()[k].getAttribute("POSITION");
            for (let i = 0; i < (a?.getCount() ?? 0); i++) {
              a?.getElement(i, d);
              sum += Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]);
            }
          }
          return sum;
        };
        for (let k = 0; k < frames - 1; k++) {
          expect(motion(prims, k)).toBeGreaterThan(0);
          expect(motion(prims, k)).toBeCloseTo(motion(rawPrims, k), 3);
        }
      }

      const scene = root.getDefaultScene() ?? root.listScenes()[0];
      const { min, max } = getBounds(scene);

      // The authored pivot AND the authored size, both kept, asserted the only
      // way that actually proves it: against the raw's own box. Not "the origin
      // is inside the model" — the Hyper Velocity Rocket's origin sits 5 cm below its
      // body, and that is the original's choice, not damage. Grounding a
      // projectile (minY -> 0) would lift every bolt off the line it travels
      // along, which is why FX_MODELS opts out of it in the generator.
      const raw = faceBounds(rawDoc);
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
// following fails here. The Sky Captain's box holds its searchlight volume, an
// additive face the drawn unit is grounded without: it is held to its raw, the
// Cobj as shipped.
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
      const prims = expectFaceModes(document);
      expect(root.listAnimations().length).toBe(0);
      expect(root.listSkins().length).toBe(0);
      for (const prim of prims) {
        expect(prim.getAttribute("TEXCOORD_0")).not.toBeNull();
        // Every unit face is textured: no vertex colour rides along.
        expect(prim.getAttribute("COLOR_0")).toBeNull();
      }

      // The raw is the mission's own export of that Cobj.
      const rawDoc = await io.read(join(RAW_DIR, spec.raw));
      const rawRoot = rawDoc.getRoot();
      const names = rawRoot.listNodes().map((n) => n.getName());
      expect(names).toContain(`${spec.mission}_obj_${String(spec.cobj).padStart(3, "0")}`);

      // Every face of the raw but the facers' stand-ins, and the body (all
      // but the additive faces) placed as the raw's.
      const kept = faceBounds(rawDoc, true);
      const out = faceBounds(document, true);
      const tris = prims.reduce((n, p) => n + triangles(p), 0);
      expect(tris).toBeGreaterThan(0);
      expect(tris).toBeLessThanOrEqual(spec.maxTris);
      expect(tris).toBe(kept.tris);
      if (spec.treatment === "part") {
        // Origin and bounds are the raw's, triangle for triangle.
        for (const axis of [0, 1, 2]) {
          expect(Math.abs(out.min[axis] - kept.min[axis])).toBeLessThanOrEqual(0.002);
          expect(Math.abs(out.max[axis] - kept.max[axis])).toBeLessThanOrEqual(0.002);
        }
      } else {
        // The body grounded and centred, at the raw's own size.
        expect(Math.abs(out.min[1])).toBeLessThanOrEqual(0.02);
        expect(Math.abs(out.min[0] + out.max[0])).toBeLessThanOrEqual(0.04);
        expect(Math.abs(out.min[2] + out.max[2])).toBeLessThanOrEqual(0.04);
        // A skinned raw (Joke's jet) holds its bind pose; gen:units bakes its
        // frame 0, so its vertices are not the raw's to measure against.
        if (rawRoot.listSkins().length > 0) return;
        for (const axis of [0, 1, 2]) {
          const size = out.max[axis] - out.min[axis];
          expect(Math.abs(size - (kept.max[axis] - kept.min[axis]))).toBeLessThanOrEqual(0.002);
        }
      }
    });
  }

  // A kept morph (the jet's rotor, Joke's tank and hull) must be the raw's
  // frames, moved only by the grounding: frame k + 1 is target k at weight 1.
  // A skeleton's are its poses (below). Every other file ships frame 0 alone.
  test("the morphs kept are the raw's frames; nothing else keeps targets", async () => {
    for (const spec of ARENA_UNIT_MODELS) {
      const doc = await io.read(join(OUT_DIR, `${spec.file}.glb`));
      const prims = doc.getRoot().listMeshes()[0].listPrimitives();
      if (!spec.morph) {
        for (const prim of prims) {
          expect({ file: spec.file, targets: prim.listTargets().length }).toEqual({
            file: spec.file,
            targets: 0,
          });
        }
        continue;
      }
      for (const prim of prims) expect(prim.listTargets().length).toBe(spec.morph.frames - 1);
      if (spec.morph.source === "skeleton") continue;
      const raw = await io.read(join(RAW_DIR, spec.raw));
      const rawPrims = raw
        .getRoot()
        .listMeshes()
        .flatMap((m) => m.listPrimitives())
        .filter((p) => !fcopOf(p.getMaterial()).standin);
      // Match each output vertex to its raw vertex by frame-0 position (the
      // output is the raw shifted by the grounding offset), over every
      // primitive on both sides: a model's faces come in one per draw mode.
      const outMin = [0, 1, 2].map((a) =>
        Math.min(...prims.map((p) => p.getAttribute("POSITION")?.getMin([0, 0, 0])[a] as number)),
      );
      const shift = [0, 1, 2].map((a) => outMin[a] - faceBounds(raw).min[a]);
      const key = (p: number[]) => p.map((v) => Math.round(v * 1000)).join(",");
      // Within one face key: a face of another mode may share a position.
      const modeOf = (p: Primitive) => {
        const f = fcopOf(p.getMaterial());
        return `${f.mode ?? "opaque"}:${f.tint?.join(",") ?? ""}|`;
      };
      // Two vertices may share a position and not a motion: any of them will do.
      const rawIndex = new Map<string, [Primitive, number][]>();
      const e = [0, 0, 0];
      for (const rp of rawPrims) {
        const rawBase = rp.getAttribute("POSITION");
        if (!rawBase) throw new Error("no positions");
        for (let i = 0; i < rawBase.getCount(); i++) {
          rawBase.getElement(i, e);
          const at = modeOf(rp) + key([e[0] + shift[0], e[1] + shift[1], e[2] + shift[2]]);
          const list = rawIndex.get(at);
          if (list) list.push([rp, i]);
          else rawIndex.set(at, [[rp, i]]);
        }
      }
      const d = [0, 0, 0];
      const rd = [0, 0, 0];
      const moves = (prim: Primitive, i: number, [rp, r]: [Primitive, number]) =>
        prim.listTargets().every((t, k) => {
          t.getAttribute("POSITION")?.getElement(i, d);
          rp.listTargets()[k].getAttribute("POSITION")?.getElement(r, rd);
          return [0, 1, 2].every((a) => Math.abs(d[a] - rd[a]) < 1e-5);
        });
      for (const prim of prims) {
        const out = prim.getAttribute("POSITION");
        if (!out) throw new Error("no positions");
        let matched = 0;
        for (let i = 0; i < out.getCount(); i++) {
          out.getElement(i, e);
          const hits = rawIndex.get(modeOf(prim) + key(e));
          if (hits === undefined) continue;
          matched++;
          expect({ file: spec.file, i, moves: hits.some((h) => moves(prim, i, h)) }).toEqual({
            file: spec.file,
            i,
            moves: true,
          });
        }
        expect(matched).toBe(out.getCount());
      }
    }
  });

  // A skeleton's frames (Joke's jet, RE pa_models.json `anim.kind` skeleton)
  // are its joint poses: frame k is the raw's skin with every joint at the
  // `full` clip's keyframe k, which gen:units bakes into target k - 1. Checked
  // here through gltf-transform's own node world matrices, vertex by vertex
  // (matched by frame-0 position, less the grounding).
  test("a skeleton's targets are its skin at every keyframe", async () => {
    const skeletons = ARENA_UNIT_MODELS.filter((s) => s.morph?.source === "skeleton");
    expect(skeletons.map((s) => s.file)).toEqual(["bug-hunt/obj_022"]);
    for (const spec of skeletons) {
      const frames = spec.morph?.frames ?? 0;
      const out = await io.read(join(OUT_DIR, `${spec.file}.glb`));
      const prims = out.getRoot().listMeshes()[0].listPrimitives();
      const raw = await io.read(join(RAW_DIR, spec.raw));
      const node = raw
        .getRoot()
        .listNodes()
        .find((n) => n.getSkin());
      const skin = node?.getSkin();
      // A model's faces come in one primitive per draw mode, on both sides.
      const rawPrims = node?.getMesh()?.listPrimitives() ?? [];
      const clip = raw
        .getRoot()
        .listAnimations()
        .find((a) => a.getName() === "full");
      if (!skin || rawPrims.length === 0 || !clip) throw new Error("not a skeleton");
      const ibm = skin.getInverseBindMatrices();
      if (!ibm) throw new Error("no skin data");
      const posed: number[][][] = [];
      for (let f = 0; f < frames; f++) {
        for (const ch of clip.listChannels()) {
          const v: number[] = [];
          ch.getSampler()?.getOutput()?.getElement(f, v);
          const n = ch.getTargetNode();
          if (ch.getTargetPath() === "rotation")
            n?.setRotation(v as [number, number, number, number]);
          if (ch.getTargetPath() === "translation")
            n?.setTranslation(v as [number, number, number]);
          if (ch.getTargetPath() === "scale") n?.setScale(v as [number, number, number]);
        }
        const joints = skin
          .listJoints()
          .map((j, k) => mul4(Array.from(j.getWorldMatrix()), ibm.getElement(k, [])));
        const frame: number[][] = [];
        const p = [0, 0, 0];
        const id = [0, 0, 0, 0];
        const w = [0, 0, 0, 0];
        for (const rawPrim of rawPrims) {
          const pos = rawPrim.getAttribute("POSITION");
          const ids = rawPrim.getAttribute("JOINTS_0");
          const wts = rawPrim.getAttribute("WEIGHTS_0");
          if (!pos || !ids || !wts) throw new Error("no skin data");
          for (let i = 0; i < pos.getCount(); i++) {
            pos.getElement(i, p);
            ids.getElement(i, id);
            wts.getElement(i, w);
            const q = [0, 0, 0];
            let total = 0;
            for (let k = 0; k < 4; k++) {
              if (w[k] === 0) continue;
              const m = joints[id[k]];
              for (let a = 0; a < 3; a++) {
                q[a] += w[k] * (m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a]);
              }
              total += w[k];
            }
            frame.push(q.map((v) => v / total));
          }
        }
        posed.push(frame);
      }
      // The grounding shift: frame 0's box against the output's.
      const lo = [0, 1, 2].map((a) => Math.min(...posed[0].map((v) => v[a])));
      const outLo = [0, 1, 2].map((a) =>
        Math.min(...prims.map((q) => q.getAttribute("POSITION")?.getMin([0, 0, 0])[a] as number)),
      );
      const shift = [0, 1, 2].map((a) => outLo[a] - lo[a]);
      const key = (v: number[]) => v.map((c) => Math.round(c * 1000)).join(",");
      const rawAt = new Map(posed[0].map((v, i) => [key(v.map((c, a) => c + shift[a])), i]));
      const e = [0, 0, 0];
      const d = [0, 0, 0];
      let most = 0;
      for (const prim of prims) {
        const base = prim.getAttribute("POSITION");
        if (!base) throw new Error("no positions");
        const targets = prim.listTargets();
        let matched = 0;
        for (let i = 0; i < base.getCount(); i++) {
          base.getElement(i, e);
          const r = rawAt.get(key(e));
          if (r === undefined) continue;
          matched++;
          for (let f = 1; f < frames; f++) {
            targets[f - 1].getAttribute("POSITION")?.getElement(i, d);
            for (let a = 0; a < 3; a++) {
              expect(Math.abs(d[a] - (posed[f][r][a] - posed[0][r][a]))).toBeLessThan(1e-4);
            }
          }
        }
        expect(matched).toBe(base.getCount());
        // The wings beat: some vertex moves a hand's breadth or more.
        for (const t of targets) {
          const a = t.getAttribute("POSITION")?.getArray() ?? [];
          for (const v of a) most = Math.max(most, Math.abs(v));
        }
      }
      expect(most).toBeGreaterThan(0.1);
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

/** Column-major 4x4 product a * b. */
function mul4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
  }
  return out;
}
