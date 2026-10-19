// Stage B unit-model pipeline (assets.md §1 Stage B, §4 glTF conventions).
//
// Turns the committed raw downloads/extractions in tools/generators/units/raw/ into
// spec-conformant per-archetype meshes at
// packages/client/public/models/units/<key>.glb, driven by units/manifest.ts:
//
//   raw glb -> strip animations/skins -> drop the facers' stand-ins ->
//   bake node transforms into one primitive per face draw mode -> orient +Z
//   forward -> scale to the greybox footprint -> ground-contact origin ->
//   tri-budget check (meshopt simplify as rescue) -> optional color
//   neutralization (projectiles only, for their tint) -> the facers' records,
//   moved with the mesh, onto the root node.
//
// Units keep the original's texels: their team colour is the original's
// per-instance texture offset (packages/client/src/render/teamUv.ts), and the
// X1's beacon, which the offset skips, is marked in a `_TEAMUV` attribute.
//
// Every output is ONE mesh, a primitive and a material per face draw mode
// (opaque, half, add by tint: "Face draw modes and facers" below), colored one
// of two ways:
// - textured sources (the FCOP originals): every 256x256 page a face or a
//   facer samples is packed side by side into a single atlas with remapped UVs;
// - untextured sources: material colors (baseColorFactor, and flat-color
//   palette atlases sampled per vertex) are baked into COLOR_0.
// A model of camera-facing facers only has no mesh: its root node carries the
// records and the glb the atlas they sample.
// The Pincel texture-atlas / NearestFilter pipeline stays a separate Phase 7
// task (it wants stylized re-texturing, not this 1:1 packing).
//
// Authoring-time tooling like genBrand.py / genDistrict01.ts: never imported
// by the game; only its committed output ships.
//
// Reproducible across environments: the one thing a rebuild does not
// reproduce byte for byte is a PNG's deflate stream (the same pixels encode to
// other bytes under another zlib or encoder). So an atlas whose decoded pixels
// equal the committed file's keeps the committed file's PNG bytes
// (`keepCommittedImages`), and an unchanged model rebuilds to the same bytes.
//
// Usage: bun run gen:units [--check]   (from the repo root)
//
// `--check` builds every model in memory and exits 1 if any differs from the
// committed file (by its pixels for the atlas, by its bytes for the rest).

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type Document,
  getBounds,
  type Material,
  type Mesh,
  type Node,
  NodeIO,
  type Primitive,
  PropertyType,
  type Texture,
} from "@gltf-transform/core";
import {
  dedup,
  flatten,
  join as joinMeshes,
  joinPrimitives,
  normals,
  prune,
  simplify,
  transformMesh,
  unweld,
  weld,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { type DecodedImage, decodePng, encodePng, samePixels } from "./png";
import {
  ARENA_UNIT_MODELS,
  EMITTER_PROP_MODELS,
  FX_MODELS,
  PROP_MODELS,
  UNIT_MODELS,
} from "./units/manifest";

const RAW_DIR = join(import.meta.dir, "units", "raw");
const MODELS_DIR = join(import.meta.dir, "..", "..", "packages", "client", "public", "models");
const OUT_UNITS = join(MODELS_DIR, "units");
const OUT_PROPS = join(MODELS_DIR, "props");
const OUT_FX = join(MODELS_DIR, "fx");

/**
 * One model to build. Flattened from the manifest's two arrays so the pipeline
 * below stays a single function: the only behavioural difference is whether the
 * mesh is fitted to its greybox silhouette (gameplay archetypes) or keeps the
 * source's own scale — arena scenery carries no `footprint` at all, and FCOP
 * Cobj assemblies already authored in map meters opt out via `nativeScale`.
 */
interface ModelPass {
  readonly key: string;
  /** Report name where `key` alone repeats (scenery: `<mapId>/<key>`). */
  readonly label?: string;
  readonly raw: string;
  readonly outDir: string;
  readonly rotateQuarterY: 0 | 1 | 2 | 3;
  readonly maxTris: number;
  /** Target max horizontal extent; absent = do not rescale at all. */
  readonly footprint?: number;
  readonly maxHeight?: number;
  /**
   * Keep the raw's authored size (orient + ground only) despite a `footprint`:
   * `footprint` / `maxHeight` then act as loose upper bounds for the test.
   */
  readonly nativeScale?: boolean;
  readonly neutralizeColors: boolean;
  /** Move the origin to the bbox centre in XZ (see the grounding step below). */
  readonly centreXZ: boolean;
  /**
   * Drop the origin onto the mesh's lowest point. True for anything that stands
   * on the ground; FALSE for projectiles, which are positioned by their own
   * centre in flight and whose authored origin already is that centre.
   */
  readonly groundY: boolean;
  /** Write `_TEAMUV`: 0 on these nodes' faces, 1 elsewhere (manifest.ts). */
  readonly teamUvExclude?: readonly string[];
  /**
   * Keep the morph frames: the track the client plays
   * (packages/client/src/render/arenaUnits.ts, render/props.ts). A `skeleton`
   * model's frames are its joint poses, baked here into morph targets. Every
   * other model ships frame 0 and no targets.
   */
  readonly keepMorph?: "morph" | "skeleton";
  /** The frames a kept morph has, base included: what the bake must produce. */
  readonly morphFrames?: number;
}

const PASSES: readonly ModelPass[] = [
  ...UNIT_MODELS.map((spec) => ({
    key: spec.key,
    raw: spec.raw,
    outDir: OUT_UNITS,
    rotateQuarterY: spec.rotateQuarterY,
    maxTris: spec.maxTris,
    footprint: spec.footprint,
    maxHeight: spec.maxHeight,
    nativeScale: spec.nativeScale,
    // The original's team colour is a texture offset (render/teamUv.ts): the
    // texels stay the original's.
    neutralizeColors: false,
    teamUvExclude: spec.teamUvExclude,
    centreXZ: true,
    groundY: true,
  })),
  // Each arena's own units (fcop-fidelity.md G1). A `part` keeps the raw's
  // origin and bounds: the gun stands on the base's attach point, the
  // Dreadnought's guns on the hull's, and both turn about their own origin.
  ...ARENA_UNIT_MODELS.map((spec) => ({
    key: spec.file.slice(spec.file.indexOf("/") + 1),
    label: spec.file,
    raw: spec.raw,
    outDir: join(OUT_UNITS, spec.file.slice(0, spec.file.indexOf("/"))),
    rotateQuarterY: 0 as const,
    maxTris: spec.maxTris,
    nativeScale: true,
    neutralizeColors: false,
    centreXZ: spec.treatment !== "part",
    groundY: spec.treatment !== "part",
    keepMorph: spec.morph?.source,
    morphFrames: spec.morph?.frames,
  })),
  ...[...PROP_MODELS, ...EMITTER_PROP_MODELS].map((spec) => ({
    key: spec.key,
    label: `${spec.mapId}/${spec.key}`,
    raw: spec.raw,
    // One folder per arena: the same Cobj id is another model on another
    // arena, and even a shared payload wears the mission's own texels.
    outDir: join(OUT_PROPS, spec.mapId),
    // Scenery is placed in the original's own frame at the original's own
    // positions — re-orienting or rescaling it would misplace the arena.
    rotateQuarterY: 0 as const,
    maxTris: spec.maxTris,
    neutralizeColors: false,
    centreXZ: false,
    // A Prop's origin is the record's point, whatever hangs below it.
    groundY: !spec.keepOrigin,
    // The flag's cloth and the Props' frames (render/props.ts plays them).
    keepMorph: spec.morph ? ("morph" as const) : undefined,
    morphFrames: spec.morph?.frames,
  })),
  ...FX_MODELS.map((spec) => ({
    key: spec.key,
    raw: spec.raw,
    outDir: OUT_FX,
    rotateQuarterY: spec.rotateQuarterY,
    maxTris: spec.maxTris,
    footprint: spec.footprint,
    maxHeight: spec.maxHeight,
    // Cobj assemblies in map meters, exactly like the units.
    nativeScale: true,
    neutralizeColors: spec.neutralizeColors,
    // A projectile keeps the origin the original authored, on both axes: it
    // flies about its own centre rather than standing on anything.
    centreXZ: false,
    groundY: false,
  })),
];

const io = new NodeIO();
const CHECK = process.argv.includes("--check");

/**
 * Gives each texture of `document` the committed file's PNG bytes where both
 * decode to the same pixels: the deflate stream is the encoder's, not the
 * model's, and differs between environments for identical pixels.
 */
async function keepCommittedImages(document: Document, outPath: string): Promise<void> {
  if (!(await Bun.file(outPath).exists())) return;
  const committed = (await io.read(outPath)).getRoot().listTextures();
  document
    .getRoot()
    .listTextures()
    .forEach((texture, i) => {
      const now = texture.getImage();
      const then = committed[i]?.getImage();
      if (!now || !then || committed[i].getMimeType() !== texture.getMimeType()) return;
      if (texture.getMimeType() === "image/png" && samePixels(now, then)) texture.setImage(then);
    });
}

const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major rotation matrix for q exact quarter-turns around +Y. */
function quarterYMatrix(q: 0 | 1 | 2 | 3): number[] {
  const c = [1, 0, -1, 0][q];
  const s = [0, 1, 0, -1][q];
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function scaleMatrix(s: number): number[] {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}

function translateMatrix(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Column-major 4x4 product a*b, matching the helpers above. */
function multiply4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function transformPoint(m: readonly number[], p: readonly number[]): number[] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Rotates a direction by m's 3x3 part and renormalizes. */
function transformDirection(m: readonly number[], v: readonly number[]): number[] {
  const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2];
  const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2];
  const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2];
  const len = Math.sqrt(x * x + y * y + z * z);
  return len > 0 ? [x / len, y / len, z / len] : [0, 1, 0];
}

/** Stash name of a kept morph target's POSITION delta (see processModel). */
const MORPH_PREFIX = "_MORPH";

/** Column-major TRS matrix, as glTF composes a node's local transform. */
function composeTrs(t: readonly number[], q: readonly number[], s: readonly number[]): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0],
    (xy + wz) * s[0],
    (xz - wy) * s[0],
    0,
    (xy - wz) * s[1],
    (1 - (xx + zz)) * s[1],
    (yz + wx) * s[1],
    0,
    (xz + wy) * s[2],
    (yz - wx) * s[2],
    (1 - (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

/**
 * A skeleton's frames as morph targets: Joke's jet is a skinned bug whose wing
 * beat is its AnmD track over the skeleton (RE pa_models.json `anim.kind`
 * `skeleton`), which an InstancedMesh cannot play bone by bone. The original
 * steps frames, it does not blend them (`cact_anim_step` hands the model an
 * integer frame), so each frame is one rigid pose: the RE's `full` clip holds
 * one keyframe per frame, and frame k is every joint at keyframe k. The skin is
 * evaluated at each (jointWorld * inverseBind, blended by weight, as
 * bakeSkinRestPose does for one pose); POSITION and NORMAL become frame 0 and
 * frame k's POSITION, less frame 0's, is stashed as `_MORPH{k - 1}` for the
 * pipeline to carry and restore. The skin is then dropped.
 */
function bakeSkinFrames(document: Document, frames: number, key: string): void {
  const root = document.getRoot();
  const clip = root.listAnimations().find((a) => a.getName() === "full");
  if (!clip) throw new Error(`${key}: a skeleton without its full clip`);
  /** Per joint node: its local TRS at each frame. */
  const local = new Map<Node, { t: number[][]; r: number[][]; s: number[][] }>();
  const at = (node: Node) => {
    let entry = local.get(node);
    if (!entry) {
      const t = node.getTranslation();
      const r = node.getRotation();
      const sc = node.getScale();
      entry = {
        t: Array.from({ length: frames }, () => [...t]),
        r: Array.from({ length: frames }, () => [...r]),
        s: Array.from({ length: frames }, () => [...sc]),
      };
      local.set(node, entry);
    }
    return entry;
  };
  for (const channel of clip.listChannels()) {
    const node = channel.getTargetNode();
    const sampler = channel.getSampler();
    const path = channel.getTargetPath();
    if (!node || !sampler || (path !== "translation" && path !== "rotation" && path !== "scale")) {
      throw new Error(`${key}: a skeleton channel on ${path}`);
    }
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (sampler.getInterpolation() === "CUBICSPLINE" || !input || !output) {
      throw new Error(`${key}: a skeleton channel that is not one key a frame`);
    }
    if (input.getCount() !== frames || output.getCount() !== frames) {
      throw new Error(`${key}: ${input.getCount()} keys for ${frames} frames`);
    }
    const entry = at(node);
    const list = path === "translation" ? entry.t : path === "rotation" ? entry.r : entry.s;
    for (let f = 0; f < frames; f++) output.getElement(f, list[f]);
  }
  /** World matrix of a node at frame f, from the per-frame locals. */
  const world = (node: Node, f: number): number[] => {
    const entry = local.get(node);
    const m = entry ? composeTrs(entry.t[f], entry.r[f], entry.s[f]) : Array.from(node.getMatrix());
    const parent = node.getParentNode();
    return parent ? multiply4(world(parent, f), m) : m;
  };
  for (const node of root.listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (node.getParentNode() !== null) {
      throw new Error(`skinned mesh node "${node.getName()}" is not a scene child`);
    }
    const inverseBind = skin.getInverseBindMatrices();
    const joints = skin.listJoints();
    const perFrame = Array.from({ length: frames }, (_, f) =>
      joints.map((joint, index) => {
        const w = world(joint, f);
        return inverseBind ? multiply4(w, inverseBind.getElement(index, new Array<number>(16))) : w;
      }),
    );
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      const jointIds = prim.getAttribute("JOINTS_0");
      const weights = prim.getAttribute("WEIGHTS_0");
      if (!position || !jointIds || !weights) continue;
      const normal = prim.getAttribute("NORMAL");
      const count = position.getCount();
      const posed = Array.from({ length: frames }, () => new Float32Array(count * 3));
      const p = [0, 0, 0];
      const n = [0, 0, 0];
      const ids = [0, 0, 0, 0];
      const w = [0, 0, 0, 0];
      const skinMatrix = new Array<number>(16);
      const normals = normal ? new Float32Array(count * 3) : null;
      for (let i = 0; i < count; i++) {
        jointIds.getElement(i, ids);
        weights.getElement(i, w);
        position.getElement(i, p);
        for (let f = 0; f < frames; f++) {
          skinMatrix.fill(0);
          let total = 0;
          for (let k = 0; k < 4; k++) {
            if (w[k] === 0) continue;
            const jm = perFrame[f][ids[k]];
            if (!jm) throw new Error(`vertex references joint ${ids[k]} outside the skin`);
            for (let e = 0; e < 16; e++) skinMatrix[e] += jm[e] * w[k];
            total += w[k];
          }
          const q =
            total === 0
              ? p
              : transformPoint(
                  skinMatrix.map((v) => v / total),
                  p,
                );
          posed[f].set(q, i * 3);
          if (f === 0 && normals && normal) {
            normal.getElement(i, n);
            const m =
              total === 0
                ? null
                : transformDirection(
                    skinMatrix.map((v) => v / total),
                    n,
                  );
            normals.set(m ?? n, i * 3);
          }
        }
      }
      position.setArray(posed[0]);
      if (normal && normals) normal.setArray(normals);
      for (let f = 1; f < frames; f++) {
        const delta = new Float32Array(count * 3);
        for (let e = 0; e < delta.length; e++) delta[e] = posed[f][e] - posed[0][e];
        prim.setAttribute(
          `${MORPH_PREFIX}${f - 1}`,
          document
            .createAccessor()
            .setType("VEC3")
            .setArray(delta)
            .setBuffer(root.listBuffers()[0]),
        );
      }
    }
    // The vertices are absolute and posed now: no skin to apply, no node
    // transform to apply twice (glTF ignores a skinned node's own).
    node.setSkin(null);
    node.setMatrix(IDENTITY_MATRIX as unknown as Parameters<typeof node.setMatrix>[0]);
  }
}

/**
 * Bakes the skin's rest pose into POSITION/NORMAL, so dropping the skin keeps
 * the pose the source was authored in.
 *
 * The X1-Alpha assemblies (extract_x1.py) carry their pose in the joints, not in
 * the vertex data: their bind pose has the legs folded flat around the origin
 * with the cockpit inside them, while the rigid unskinned parts (guns, beacon)
 * already sit at their posed height. Discarding the skins without evaluating
 * them therefore ships that bind pose — a collapsed body with parts hovering
 * above it. Blending skinMatrix = jointWorld * inverseBind by vertex weight is
 * what a viewer does for the rest pose, so this reproduces the authored figure.
 *
 * Normals use the same matrix's rotation part: these poses are rigid
 * (rotation + translation per joint), so no inverse-transpose is needed.
 */
function bakeSkinRestPose(document: Document): void {
  for (const node of document.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (node.getParentNode() !== null) {
      // Joint world matrices are absolute, so the baked vertices are too — a
      // parent transform would be applied a second time further down.
      throw new Error(`skinned mesh node "${node.getName()}" is not a scene child`);
    }
    const inverseBind = skin.getInverseBindMatrices();
    const jointMatrices = skin.listJoints().map((joint, index) => {
      const world = Array.from(joint.getWorldMatrix());
      if (!inverseBind) return world;
      return multiply4(world, inverseBind.getElement(index, new Array<number>(16)));
    });
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      const jointIds = prim.getAttribute("JOINTS_0");
      const weights = prim.getAttribute("WEIGHTS_0");
      if (!position || !jointIds || !weights) continue;
      const normal = prim.getAttribute("NORMAL");
      const p = [0, 0, 0];
      const n = [0, 0, 0];
      const ids = [0, 0, 0, 0];
      const w = [0, 0, 0, 0];
      const skinMatrix = new Array<number>(16);
      for (let i = 0; i < position.getCount(); i++) {
        jointIds.getElement(i, ids);
        weights.getElement(i, w);
        skinMatrix.fill(0);
        let total = 0;
        for (let k = 0; k < 4; k++) {
          if (w[k] === 0) continue;
          const jointMatrix = jointMatrices[ids[k]];
          if (!jointMatrix) throw new Error(`vertex references joint ${ids[k]} outside the skin`);
          for (let e = 0; e < 16; e++) skinMatrix[e] += jointMatrix[e] * w[k];
          total += w[k];
        }
        // An unweighted vertex is not driven by the rig; leave it as authored.
        if (total === 0) continue;
        // Exporters do not always normalize the four weights.
        for (let e = 0; e < 16; e++) skinMatrix[e] /= total;
        position.getElement(i, p);
        position.setElement(i, transformPoint(skinMatrix, p));
        if (normal) {
          normal.getElement(i, n);
          normal.setElement(i, transformDirection(skinMatrix, n));
        }
      }
    }
    // glTF ignores a skinned mesh node's own transform; the bake made the
    // vertices absolute, so clear it rather than let the node bake re-apply it.
    node.setMatrix(IDENTITY_MATRIX as unknown as Parameters<typeof node.setMatrix>[0]);
  }
}

// --- Face draw modes and facers (RE docs/formats/objects.md) ----------------
//
// The RE keys each Cobj's faces by draw mode (`cact_model_shade_face`
// 0x00428c70 on the primitive's op0): `opaque`; `half`, op bit 3, whose bit-15
// texels average with the frame buffer (Glide constant alpha 0x80 and
// `grAlphaCombine` arm 0x00439e97 under SRC_ALPHA / ONE_MINUS_SRC_ALPHA); and
// `add`, material 6, `grAlphaBlendFunction(ONE, ONE, ONE, ZERO)` (arm
// 0x00439ee5) tinted by the 3DTL colour, 0x80 unity. Its materials are named
// `texNN` per page and carry `extras.fcop` {mode, tint}; one page may be
// several materials. Here a model keeps one atlas of its pages and one
// material per (mode, tint), in that order, each its own primitive: what
// render/fcopModel.ts turns into one InstancedMesh with a group per material.
//
// The camera-facing primitives (`cobj_prim_emit` 0x00428690 arms 5..8:
// billboard, rect, line; star, `draw_disc_fan` 0x004271c0) are not geometry:
// the original builds them on the screen every frame. The RE writes them into
// `nodes[0].extras.fcop.facers`, frame by frame, and keeps its old white
// stand-in geometry for them in a material marked `extras.fcop.standin`,
// which is dropped here. The records ride into the output's `root` node
// extras, moved by everything the mesh is moved by, their (u, v) remapped onto
// the atlas, which also packs the pages only a facer samples (those are
// referenced from the extras alone, so they are read before any prune).

/** A face's draw mode, as the RE's export names it. */
type FaceMode = "opaque" | "half" | "add";

/** What a model's faces are keyed by: the mode, and an `add` face's 3DTL tint. */
interface FaceKey {
  readonly mode: FaceMode;
  /** The raw 3DTL bytes (0x80 unity) of an `add` face; null otherwise. */
  readonly tint: readonly number[] | null;
}

interface FcopMaterialExtras {
  readonly mode?: string;
  readonly tint?: readonly number[];
  readonly layer?: number;
  readonly standin?: boolean;
}

function fcopOf(material: Material | null): FcopMaterialExtras {
  const extras = material?.getExtras() as { fcop?: FcopMaterialExtras } | undefined;
  return extras?.fcop ?? {};
}

/**
 * The key of a primitive's face. A material without a mode (the X1 parts,
 * which the RE still exports through its old path) is opaque; a non-zero
 * layer (op1 bits 4..6, only the X1's Cobj 15 / 16 carry one) is refused,
 * since nothing here would honour the caller's layer mask.
 */
function faceKeyOf(prim: Primitive, key: string): FaceKey {
  const fcop = fcopOf(prim.getMaterial());
  if (fcop.layer) throw new Error(`${key}: a face on layer ${fcop.layer}`);
  if (fcop.mode === "add") return { mode: "add", tint: fcop.tint ?? [0x80, 0x80, 0x80] };
  if (fcop.mode === "half") return { mode: "half", tint: null };
  return { mode: "opaque", tint: null };
}

const MODE_ORDER: Readonly<Record<FaceMode, number>> = { opaque: 0, half: 1, add: 2 };

function faceKeyName(k: FaceKey): string {
  if (!k.tint) return k.mode;
  return `${k.mode}-${k.tint.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Opaque, then half, then add by tint: the primitives' (and groups') order. */
function compareFaceKeys(a: FaceKey, b: FaceKey): number {
  return MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || faceKeyName(a).localeCompare(faceKeyName(b));
}

/**
 * The output material of one key, on the model's atlas (null on the
 * vertex-colour path): MASK at 0.25 for opaque (the key texels, alpha 0, cut
 * out; bit-15 texels, 128, kept), BLEND for half and add, as the RE writes
 * them; an add face's baseColorFactor is min(1, 2c / 255) and its tint stays
 * raw in the extras (render/fcopModel.ts doubles it, unclamped).
 */
function createFaceMaterial(document: Document, k: FaceKey, atlas: Texture | null): Material {
  const name = k.mode === "opaque" ? "unit" : `unit-${faceKeyName(k)}`;
  const tint = k.tint ?? [0x80, 0x80, 0x80];
  const factor = k.mode === "add" ? tint.map((c) => Math.min(1, (2 * c) / 255)) : [1, 1, 1];
  const material = document
    .createMaterial(name)
    .setBaseColorFactor([factor[0], factor[1], factor[2], 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setExtras({ fcop: k.tint ? { mode: k.mode, tint: [...k.tint] } : { mode: k.mode } });
  if (atlas) {
    material.setBaseColorTexture(atlas);
    if (k.mode === "opaque") material.setAlphaMode("MASK").setAlphaCutoff(0.25);
    else material.setAlphaMode("BLEND");
  }
  return material;
}

/** Disposes the RE's white stand-ins for the facers (`extras.fcop.standin`). */
function dropStandins(document: Document): void {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (fcopOf(prim.getMaterial()).standin) prim.dispose();
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
}

type Vec3 = [number, number, number];

/** One facer as the RE writes it (the fields read here). */
interface RawFacer {
  readonly prim: number;
  readonly kind: "billboard" | "rect" | "line" | "star";
  readonly mode: FaceMode;
  readonly page?: number;
  readonly rgb?: readonly number[];
  readonly uv?: readonly (readonly number[])[];
  readonly texture?: number | null;
  readonly at?: readonly Vec3[];
  readonly from?: readonly Vec3[];
  readonly to?: readonly Vec3[];
  readonly half?: readonly (number | readonly number[])[];
  readonly radius?: readonly number[];
  readonly centre_rgb?: readonly number[];
  readonly rim_rgb?: readonly number[];
  readonly wedge_cap?: number;
}

/** A model's facers, read before anything is pruned: the records and each page's PNG. */
interface FacerSource {
  readonly records: readonly RawFacer[];
  readonly frames: number;
  /** By the raw's texture index: the page's encoded image. */
  readonly pages: ReadonlyMap<number, Uint8Array>;
}

function readFacers(document: Document, key: string): FacerSource | null {
  const root = document.getRoot();
  const node = root.listScenes()[0]?.listChildren()[0] ?? root.listNodes()[0];
  const extras = node?.getExtras() as
    | { fcop?: { facers?: RawFacer[]; frames?: number } }
    | undefined;
  const records = extras?.fcop?.facers ?? [];
  if (records.length === 0) return null;
  const m = node.getMatrix();
  if (m.some((v, i) => Math.abs(v - IDENTITY_MATRIX[i]) > 1e-9)) {
    throw new Error(`${key}: facers on a node that is not at the identity`);
  }
  const textures = root.listTextures();
  const pages = new Map<number, Uint8Array>();
  for (const f of records) {
    if (f.texture === null || f.texture === undefined) continue;
    const image = textures[f.texture]?.getImage();
    if (!image)
      throw new Error(`${key}: facer ${f.prim} names texture ${f.texture}, not in the glb`);
    pages.set(f.texture, image);
  }
  return { records, frames: extras?.fcop?.frames ?? 1, pages };
}

/** Six decimals: a facer moved by the grounding prints the same on every machine. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6 || 0;
}

/**
 * The facers as the output carries them: `placed` (every transform the mesh
 * took after the raw's frame) applied to their points and its scale to their
 * lengths, (u, v) onto the atlas page `slot` names, frame 0 alone unless the
 * model keeps its frames.
 */
function placeFacers(
  source: FacerSource,
  placed: readonly number[],
  keepFrames: boolean,
  slot: (texture: number) => { offset: number; width: number; atlasWidth: number },
): { facers: Record<string, unknown>[]; frames: number } {
  const frames = keepFrames ? source.frames : 1;
  const scale = Math.hypot(placed[0], placed[1], placed[2]);
  const point = (p: readonly number[]) => transformPoint(placed, p).map(round6);
  const points = (list: readonly Vec3[] | undefined) => list?.slice(0, frames).map(point);
  const length = (v: number | readonly number[]): number | number[] =>
    typeof v === "number" ? round6(v * scale) : v.map((x) => round6(x * scale));
  const facers = source.records.map((f) => {
    const out: Record<string, unknown> = { prim: f.prim, kind: f.kind, mode: f.mode };
    if (f.kind === "star") {
      out.at = points(f.at);
      out.radius = f.radius?.slice(0, frames).map((r) => length(r));
      out.centre_rgb = f.centre_rgb;
      out.rim_rgb = f.rim_rgb;
      out.wedge_cap = f.wedge_cap;
      out.texture = null;
      return out;
    }
    if (f.kind === "line") {
      out.from = points(f.from);
      out.to = points(f.to);
    } else {
      out.at = points(f.at);
    }
    out.half = f.half?.slice(0, frames).map(length);
    out.rgb = f.rgb;
    out.page = f.page;
    if (f.texture === null || f.texture === undefined || !f.uv) {
      out.texture = null;
      return out;
    }
    const s = slot(f.texture);
    out.uv = f.uv.map(([u, v]) => [round6((s.offset + u * s.width) / s.atlasWidth), v]);
    // The atlas: the glb's one image (its one texture, where a face samples it).
    out.texture = 0;
    return out;
  });
  return { facers, frames };
}
/**
 * Fails the build if any mesh or vertex attribute has more than one owner.
 *
 * The stages that follow edit vertex data in place, once per primitive (atlas UV
 * remap) and once per node (transform bake), so shared data would silently take
 * those edits twice. Loud failure beats a model that quietly moves.
 */
function assertUnsharedVertexData(document: Document, key: string): void {
  const meshUsers = new Map<Mesh, number>();
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) meshUsers.set(mesh, (meshUsers.get(mesh) ?? 0) + 1);
  }
  for (const [mesh, count] of meshUsers) {
    if (count > 1) {
      throw new Error(`${key}: mesh "${mesh.getName()}" is shared by ${count} nodes`);
    }
  }
  const attributeUsers = new Map<unknown, number>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) {
        const attribute = prim.getAttribute(semantic);
        if (attribute) attributeUsers.set(attribute, (attributeUsers.get(attribute) ?? 0) + 1);
      }
    }
  }
  for (const count of attributeUsers.values()) {
    if (count > 1) throw new Error(`${key}: a vertex attribute is shared by ${count} primitives`);
  }
}

/**
 * Turns the stashed `_MORPHk` attributes back into morph targets, in order,
 * with zero weights: frame k + 1 is target k at weight 1, as the RE's glb
 * animates it. On every primitive: a model's faces come one per draw mode.
 */
function restoreMorphTargets(document: Document, mesh: Mesh, key: string, frames: number): void {
  for (const prim of mesh.listPrimitives()) {
    const names = prim
      .listSemantics()
      .filter((s) => s.startsWith(MORPH_PREFIX))
      .sort((a, b) => Number(a.slice(MORPH_PREFIX.length)) - Number(b.slice(MORPH_PREFIX.length)));
    if (names.length !== frames - 1) {
      throw new Error(`${key}: ${names.length} morph targets for ${frames} frames`);
    }
    for (const name of names) {
      const stash = prim.getAttribute(name);
      const delta = stash?.getArray();
      if (!stash || !delta) throw new Error(`${key}: ${name} lost`);
      const target = document
        .createPrimitiveTarget()
        .setAttribute(
          "POSITION",
          document
            .createAccessor()
            .setType("VEC3")
            .setArray(new Float32Array(delta))
            .setBuffer(document.getRoot().listBuffers()[0]),
        );
      prim.setAttribute(name, null);
      prim.addTarget(target);
    }
  }
  mesh.setWeights(Array.from({ length: frames - 1 }, () => 0));
}

/**
 * Marks which faces take the team texture offset (render/teamUv.ts): a 0/1
 * `_TEAMUV` per vertex, 0 on the meshes of the named nodes. Every primitive
 * gets one, so the merge below keeps a single attribute set.
 */
function writeTeamUvMask(document: Document, exclude: readonly string[], key: string): void {
  const root = document.getRoot();
  const excluded = new Set<Mesh>();
  for (const name of exclude) {
    const node = root.listNodes().find((n) => n.getName() === name);
    const mesh = node?.getMesh();
    if (!mesh) throw new Error(`${key}: no mesh node "${name}" to keep off the team offset`);
    excluded.add(mesh);
  }
  for (const mesh of root.listMeshes()) {
    const value = excluded.has(mesh) ? 0 : 1;
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getAttribute("POSITION")?.getCount() ?? 0;
      prim.setAttribute(
        "_TEAMUV",
        document
          .createAccessor("_TEAMUV")
          .setType("SCALAR")
          .setArray(new Float32Array(count).fill(value))
          .setBuffer(root.listBuffers()[0]),
      );
    }
  }
}

function triangleCount(mesh: Mesh): number {
  let tris = 0;
  for (const prim of mesh.listPrimitives()) {
    const indices = prim.getIndices();
    const count = indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0);
    tris += count / 3;
  }
  return tris;
}

// --- Minimal PNG decode (8-bit, non-interlaced) --------------------------
// The palette atlases on these low-poly packs are tiny flat-color PNGs
// (e.g. the Quaternius mech ships a 32x32 Atlas.png), so a nearest-texel
// per-vertex sample IS the authored color — no image library needed.

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Nearest-texel sample with repeat wrapping, returning linear RGB. */
function sampleTexel(image: DecodedImage, u: number, v: number, out: number[]): void {
  const x = Math.min(image.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * image.height)));
  const p = (y * image.width + x) * 4;
  out[0] = srgbToLinear(image.pixels[p] / 255);
  out[1] = srgbToLinear(image.pixels[p + 1] / 255);
  out[2] = srgbToLinear(image.pixels[p + 2] / 255);
}

/**
 * Bakes the primitive's material color into a COLOR_0 attribute —
 * baseColorFactor, an existing COLOR_0, and (for palette-atlas models) a
 * nearest-texel sample of the baseColorTexture — so all primitives can share
 * one white vertex-color material and join into a single draw.
 */
function bakeVertexColors(document: Document, prim: Primitive): void {
  const material = prim.getMaterial();
  const factor = material ? material.getBaseColorFactor() : [1, 1, 1, 1];
  const position = prim.getAttribute("POSITION");
  if (!position) return;
  const vertexCount = position.getCount();
  const existing = prim.getAttribute("COLOR_0");
  const uv = prim.getAttribute("TEXCOORD_0");
  const textureImage = material?.getBaseColorTexture()?.getImage();
  const image = textureImage && uv ? decodePng(new Uint8Array(textureImage)) : null;
  const out = new Float32Array(vertexCount * 4);
  const el: number[] = [1, 1, 1, 1];
  const uvEl: number[] = [0, 0];
  const tex: number[] = [1, 1, 1];
  for (let i = 0; i < vertexCount; i++) {
    let r = factor[0];
    let g = factor[1];
    let b = factor[2];
    if (existing) {
      existing.getElement(i, el);
      r *= el[0];
      g *= el[1];
      b *= el[2];
    }
    if (image && uv) {
      uv.getElement(i, uvEl);
      sampleTexel(image, uvEl[0], uvEl[1], tex);
      r *= tex[0];
      g *= tex[1];
      b *= tex[2];
    }
    out[i * 4 + 0] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 1;
  }
  const color = document
    .createAccessor("COLOR_0")
    .setType("VEC4")
    .setArray(out)
    .setBuffer(document.getRoot().listBuffers()[0]);
  prim.setAttribute("COLOR_0", color);
}

/**
 * Desaturates COLOR_0 to a high-contrast greyscale ramp so multiplicative
 * instanceColor team tint (red / blue / neutral) stays sharp.
 */
function neutralizeColors(prim: Primitive): void {
  const color = prim.getAttribute("COLOR_0");
  if (!color) return;
  const count = color.getCount();
  const lums = new Float32Array(count);
  const el: number[] = [1, 1, 1, 1];
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < count; i++) {
    color.getElement(i, el);
    const lum = 0.2126 * el[0] + 0.7152 * el[1] + 0.0722 * el[2];
    lums[i] = lum;
    if (lum < lo) lo = lum;
    if (lum > hi) hi = lum;
  }
  if (hi <= lo) {
    lo = 0;
    hi = 1;
  }
  const outLo = 0.1;
  const outHi = 0.95;
  const span = hi - lo;
  for (let i = 0; i < count; i++) {
    const t = outLo + ((lums[i] - lo) / span) * (outHi - outLo);
    const v = Math.min(1, Math.max(0, t));
    color.setElement(i, [v, v, v, 1]);
  }
}

interface Report {
  key: string;
  tris: number;
  simplified: boolean;
  size: string;
  bytes: number;
}

async function processModel(spec: ModelPass): Promise<Report | null> {
  const rawPath = join(RAW_DIR, spec.raw);
  if (!(await Bun.file(rawPath).exists())) {
    console.warn(`skip ${spec.label ?? spec.key}: missing ${spec.raw}`);
    return null;
  }
  const document = await io.read(rawPath);
  const root = document.getRoot();
  // Before anything is pruned: a page only a facer samples is referenced from
  // the extras alone.
  const facerSource = readFacers(document, spec.label ?? spec.key);

  // Rest pose only: Stage B ships rigid merged meshes; rigs return in Stage C.
  // The pose has to be baked into the vertices first — a skinned source keeps it
  // in its joints, and the bind pose it would otherwise ship is not a pose the
  // parts were ever meant to be seen in.
  if (spec.keepMorph === "skeleton") bakeSkinFrames(document, spec.morphFrames ?? 0, spec.key);
  for (const anim of root.listAnimations()) anim.dispose();
  bakeSkinRestPose(document);
  for (const skin of root.listSkins()) skin.dispose();
  for (const mesh of root.listMeshes()) {
    // Morph targets outlive their animation (the FCOP scenery barrier is a
    // morph-animated Cobj). Frame 0 is the base geometry, so dropping the
    // targets keeps the pose and leaves one attribute set for the merge the
    // runtime does — otherwise the InstancedMesh geometry carries deltas it
    // will never drive.
    mesh.setWeights([]);
    for (const prim of mesh.listPrimitives()) {
      // A kept morph rides the pipeline as plain vertex attributes, so every
      // vertex edit below (FX drop, billboard drop, merge) carries it along,
      // and becomes targets again just before the write. The deltas need no
      // translation, which is all the grounding does.
      if (spec.keepMorph === "morph") {
        prim.listTargets().forEach((target, k) => {
          const delta = target.getAttribute("POSITION")?.getArray();
          if (!delta) throw new Error(`${spec.key}: morph target ${k} without POSITION`);
          prim.setAttribute(
            `${MORPH_PREFIX}${k}`,
            document
              .createAccessor()
              .setType("VEC3")
              .setArray(new Float32Array(delta))
              .setBuffer(root.listBuffers()[0]),
          );
        });
      }
      for (const target of prim.listTargets()) {
        prim.removeTarget(target);
        target.dispose();
      }
      for (const semantic of prim.listSemantics()) {
        if (/^(JOINTS|WEIGHTS)_/.test(semantic) || semantic === "TEXCOORD_1") {
          prim.getAttribute(semantic)?.dispose();
        }
      }
    }
  }

  // Textures and materials only. Everything below rewrites vertex data IN PLACE
  // — the atlas UV remap once per primitive, the node-transform bake once per
  // node — so two owners of one accessor take every rewrite twice and land where
  // nothing was ever authored. Deduplicating meshes and accessors here is what
  // created exactly that: the X1's twin guns are mirror images, so their vertex
  // data merged, and the bake then applied both node offsets to it — one gun at
  // double the offset, hovering clear of the hull. A source with genuinely
  // instanced meshes would have to be un-shared (clone mesh + attributes per
  // node) before this point; assertUnsharedVertexData below refuses to guess.
  await document.transform(
    dedup({ propertyTypes: [PropertyType.TEXTURE, PropertyType.MATERIAL] }),
    prune(),
    flatten(),
  );
  // The facers' stand-ins go on every model: the facers are drawn from their
  // records (render/facers.ts). Every other face is the original's and stays,
  // in its own mode — the Sky Captain's searchlight volumes (`tex10`, add) and
  // the exhaust cards under its nacelles (`tex09`, half) included, which the
  // one-opaque-material pipeline used to cut out because it could only draw
  // them solid.
  dropStandins(document);
  await document.transform(prune());
  assertUnsharedVertexData(document, spec.key);
  if (spec.teamUvExclude) writeTeamUvMask(document, spec.teamUvExclude, spec.key);

  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const keys = new Map<Primitive, FaceKey>();
  for (const prim of prims) keys.set(prim, faceKeyOf(prim, spec.key));
  // The original's faces are textured but for a few vertex-coloured ones
  // (the X1's beacon, Joke 75 / Slim 76's `untextured` faces): their colour
  // lives in COLOR_0, and they sample a small white patch packed beside the
  // pages so one atlas serves the whole model.
  const texturedPrims = prims.filter((p) => p.getMaterial()?.getBaseColorTexture());
  const untexturedPrims = prims.filter((p) => !p.getMaterial()?.getBaseColorTexture());
  /** Width of the white patch, in texels. Only wide enough to sample safely. */
  const WHITE_PATCH = 8;

  // The atlas: every page a face or a facer samples, side by side, keyed by
  // the image's bytes (a facer's page may be a face's too, or no face's).
  const pages: DecodedImage[] = [];
  const pageOf = new Map<string, number>();
  const pageSlot = (image: Uint8Array): number => {
    const k = Buffer.from(image).toString("base64");
    let slot = pageOf.get(k);
    if (slot === undefined) {
      slot = pages.length;
      pageOf.set(k, slot);
      pages.push(decodePng(new Uint8Array(image)));
    }
    return slot;
  };
  const primPage = new Map<Primitive, number>();
  for (const prim of texturedPrims) {
    const image = prim.getMaterial()?.getBaseColorTexture()?.getImage();
    if (!image) throw new Error(`${spec.key}: texture without image`);
    if (!prim.getAttribute("TEXCOORD_0")) throw new Error(`${spec.key}: textured face without UVs`);
    primPage.set(prim, pageSlot(image));
  }
  const facerPage = new Map<number, number>();
  for (const [texture, image] of facerSource?.pages ?? []) facerPage.set(texture, pageSlot(image));

  const textured = pages.length > 0;
  let atlas: Texture | null = null;
  const offsets: number[] = [];
  let width = 0;
  if (textured) {
    // Textured path (the FCOP originals): pack the pages side by side into ONE
    // atlas and remap each primitive's U into its page's column. Optional
    // desaturation (projectiles only) keeps the panel detail while letting
    // their per-instance tint own the hue. The alpha is the RE's: 0 on the
    // key, 128 on a bit-15 texel, 255 elsewhere (render/fcopModel.ts reads it
    // per mode).
    const height = pages[0].height;
    if (pages.some((p) => p.height !== height)) {
      throw new Error(`${spec.key}: texture pages differ in height`);
    }
    const pagesWidth = pages.reduce((n, p) => n + p.width, 0);
    const needWhite = untexturedPrims.length > 0;
    width = pagesWidth + (needWhite ? WHITE_PATCH : 0);
    const packed = new Uint8Array(width * height * 4);
    // Per-page x offsets rather than "column idx of n": the white patch is
    // narrower than a page, so equal-width columns no longer hold.
    let xOff = 0;
    for (const page of pages) {
      offsets.push(xOff);
      for (let y = 0; y < height; y++) {
        packed.set(
          page.pixels.subarray(y * page.width * 4, (y + 1) * page.width * 4),
          (y * width + xOff) * 4,
        );
      }
      xOff += page.width;
    }
    if (spec.neutralizeColors) {
      // Desaturate to greyscale albedo so instanceColor owns hue (3 colors:
      // team0 / team1 / neutral). Preserve panel contrast: mean-push on the
      // whole FCOP sheet (dark padding + tiny UV islands) washed details out.
      // Stretch only the used (non-near-black) luminance into a sharp ramp.
      // Only the real pages: the white patch is painted after this ramp, so it
      // neither skews lo/hi nor comes out at 0.95 instead of white.
      const lums = new Float32Array(width * height);
      for (let i = 0; i < width * height; i++) {
        if (i % width >= pagesWidth) continue;
        lums[i] =
          0.2126 * srgbToLinear(packed[i * 4] / 255) +
          0.7152 * srgbToLinear(packed[i * 4 + 1] / 255) +
          0.0722 * srgbToLinear(packed[i * 4 + 2] / 255);
      }
      const bg = 0.035; // ignore atlas padding / unused sheet
      let lo = 1;
      let hi = 0;
      for (let i = 0; i < lums.length; i++) {
        if (lums[i] < bg) continue;
        if (lums[i] < lo) lo = lums[i];
        if (lums[i] > hi) hi = lums[i];
      }
      if (hi <= lo) {
        lo = 0;
        hi = 1;
      }
      const outLo = 0.1;
      const outHi = 0.95;
      const span = hi - lo;
      for (let i = 0; i < width * height; i++) {
        if (i % width >= pagesWidth) continue;
        const t = lums[i] < bg ? 0.05 : outLo + ((lums[i] - lo) / span) * (outHi - outLo);
        const v = Math.round(linearToSrgb(Math.min(1, Math.max(0, t))) * 255);
        packed[i * 4] = v;
        packed[i * 4 + 1] = v;
        packed[i * 4 + 2] = v;
      }
    }
    if (needWhite) {
      for (let y = 0; y < height; y++) {
        for (let x = pagesWidth; x < width; x++) {
          const o = (y * width + x) * 4;
          packed[o] = 255;
          packed[o + 1] = 255;
          packed[o + 2] = 255;
          packed[o + 3] = 255;
        }
      }
    }
    // A model of facers only lost its buffer with its last accessor.
    if (root.listBuffers().length === 0) document.createBuffer();
    atlas = document
      .createTexture("atlas")
      .setImage(encodePng({ width, height, pixels: packed }))
      .setMimeType("image/png");

    // Textured primitives: U into the page's own column, and — only where the
    // model mixes in vertex-coloured faces — a white COLOR_0, so every
    // primitive of a mode carries the same attribute set for the join below.
    for (const prim of texturedPrims) {
      const idx = primPage.get(prim) ?? 0;
      const uv = prim.getAttribute("TEXCOORD_0");
      if (uv) {
        const el: number[] = [0, 0];
        const off = offsets[idx];
        const pw = pages[idx].width;
        for (let i = 0; i < uv.getCount(); i++) {
          uv.getElement(i, el);
          uv.setElement(i, [(off + el[0] * pw) / width, el[1]]);
        }
      }
      prim.getAttribute("COLOR_0")?.dispose();
      if (needWhite) {
        const count = prim.getAttribute("POSITION")?.getCount() ?? 0;
        prim.setAttribute(
          "COLOR_0",
          document
            .createAccessor("COLOR_0")
            .setType("VEC4")
            .setArray(new Float32Array(count * 4).fill(1))
            .setBuffer(root.listBuffers()[0]),
        );
      }
    }

    // Vertex-coloured primitives: keep the colour, borrow the white patch.
    const u = (pagesWidth + WHITE_PATCH / 2) / width;
    for (const prim of untexturedPrims) {
      // Unconditionally, not just when COLOR_0 is missing: the exporter writes
      // the colour as VEC3 and joinPrimitives needs one encoding across a
      // mode. bakeVertexColors re-emits it as VEC4, folding in the material's
      // baseColorFactor on the way.
      bakeVertexColors(document, prim);
      if (spec.neutralizeColors) neutralizeColors(prim);
      const count = prim.getAttribute("POSITION")?.getCount() ?? 0;
      const uvArray = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        uvArray[i * 2] = u;
        uvArray[i * 2 + 1] = 0.5;
      }
      prim.setAttribute(
        "TEXCOORD_0",
        document
          .createAccessor("TEXCOORD_0")
          .setType("VEC2")
          .setArray(uvArray)
          .setBuffer(root.listBuffers()[0]),
      );
    }
  } else {
    // Vertex-color path (untextured packs): bake material colors into COLOR_0.
    for (const prim of prims) {
      bakeVertexColors(document, prim);
      prim.getAttribute("TEXCOORD_0")?.dispose();
    }
  }
  // One material per face key, on the atlas, created in the keys' order.
  const materials = new Map<string, { key: FaceKey; material: Material }>();
  const distinct = new Map<string, FaceKey>();
  for (const k of keys.values()) distinct.set(faceKeyName(k), k);
  for (const k of [...distinct.values()].sort(compareFaceKeys)) {
    materials.set(faceKeyName(k), { key: k, material: createFaceMaterial(document, k, atlas) });
  }
  for (const prim of prims) {
    const entry = materials.get(faceKeyName(keys.get(prim) ?? { mode: "opaque", tint: null }));
    if (entry) prim.setMaterial(entry.material);
  }
  for (const texture of root.listTextures()) {
    if (texture !== atlas) texture.dispose();
  }

  // Bake every mesh-node's local transform into its vertex data BEFORE join.
  // Multi-part assets (turret hull + gun) store placement in node matrices;
  // joinMeshes merges geometry in local space and would drop those offsets,
  // which shreds the silhouette and UV alignment of assembled FCOP parts.
  for (const n of root.listNodes()) {
    const nodeMesh = n.getMesh();
    if (!nodeMesh) continue;
    const m = n.getMatrix();
    const isIdentity = m.every((v, i) => Math.abs(v - IDENTITY_MATRIX[i]) < 1e-6);
    if (!isIdentity) {
      // The stashed deltas are not transformed with the mesh.
      if (spec.keepMorph) throw new Error(`${spec.key}: a kept morph on a transformed node`);
      if (facerSource) throw new Error(`${spec.key}: facers on a model of transformed parts`);
      transformMesh(nodeMesh, m as unknown as Parameters<typeof transformMesh>[1]);
      n.setMatrix(IDENTITY_MATRIX as unknown as Parameters<typeof n.setMatrix>[0]);
    }
  }

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  /** Everything the mesh is moved by from here on: the facers take it too. */
  let placed: number[] = [...IDENTITY_MATRIX];
  let tris = 0;
  let simplified = false;
  let node: Node;
  if (prims.length === 0) {
    // Facers only (the bolts, Hk 65, Slim 63 / 83, Joke 62 / 82): a node and
    // its records, the atlas their pages are on, no mesh.
    for (const n of root.listNodes()) n.dispose();
    node = document.createNode("root");
    scene.addChild(node);
  } else {
    // One node, one mesh: the runtime swaps this into a single InstancedMesh
    // per archetype (renderer hard rule #3), a primitive per face key.
    await document.transform(joinMeshes({ keepNamed: false }), dedup(), prune());
    const nodes = scene.listChildren().filter((n) => n.getMesh());
    if (nodes.length !== 1) {
      throw new Error(`${spec.key}: expected one joined mesh node, got ${nodes.length}`);
    }
    node = nodes[0];
    const mesh = node.getMesh();
    if (!mesh) throw new Error(`${spec.key}: joined node has no mesh`);
    node.setName("root");
    mesh.setName("hull");

    // One primitive per face key too, in the keys' order. joinMeshes() merges
    // meshes, but a mesh that already arrived split across primitives of one
    // key stays split — the scenery barrier (Cobj 28) samples two atlas pages
    // and so comes in as two. They share a material and attribute set by now,
    // which is exactly joinPrimitives' domain.
    const byKey = new Map<Material, Primitive[]>();
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      if (!material) throw new Error(`${spec.key}: a primitive without its material`);
      const list = byKey.get(material);
      if (list) list.push(prim);
      else byKey.set(material, [prim]);
    }
    const order = [...materials.values()]
      .sort((a, b) => compareFaceKeys(a.key, b.key))
      .map((e) => e.material);
    for (const prim of mesh.listPrimitives()) mesh.removePrimitive(prim);
    for (const material of order) {
      const list = byKey.get(material);
      if (!list) continue;
      if (list.length === 1) {
        mesh.addPrimitive(list[0]);
        continue;
      }
      const joined = joinPrimitives(list);
      for (const prim of list) prim.dispose();
      mesh.addPrimitive(joined);
    }

    // Bake any remaining node transform, then orient / scale / ground the mesh.
    const apply = (m: number[]) => {
      transformMesh(mesh, m as unknown as Parameters<typeof transformMesh>[1]);
      placed = multiply4(m, placed);
    };
    apply(Array.from(node.getMatrix()));
    node.setMatrix(IDENTITY_MATRIX as unknown as Parameters<typeof node.setMatrix>[0]);
    if (spec.keepMorph && spec.rotateQuarterY !== 0) {
      throw new Error(`${spec.key}: a kept morph on a turned model`);
    }
    apply(quarterYMatrix(spec.rotateQuarterY));

    // The body: what the model stands on and is sized by. An additive face is
    // light, not body — the Sky Captain's searchlight cones reach a metre
    // below its hull — so the grounding and the fitting leave the add faces
    // out, which keeps every unit where it stood when they were not drawn.
    let bounds = bodyBounds(mesh);
    // FCOP Cobj assemblies are already in map meters — only orient + ground.
    // Everything else stretches to the greybox footprint / height cap.
    if (spec.footprint !== undefined && !spec.nativeScale) {
      const sizeX = bounds.max[0] - bounds.min[0];
      const sizeY = bounds.max[1] - bounds.min[1];
      const sizeZ = bounds.max[2] - bounds.min[2];
      const footprintScale = spec.footprint / Math.max(sizeX, sizeZ);
      const heightScale =
        spec.maxHeight !== undefined ? spec.maxHeight / sizeY : Number.POSITIVE_INFINITY;
      apply(scaleMatrix(Math.min(footprintScale, heightScale)));
    }

    // Tri budget (assets.md §4), meshopt simplify as the logged rescue path.
    // Flat-shaded sources split nearly every vertex on normal seams, which the
    // simplifier treats as locked borders — so drop normals first, weld by
    // position+color, simplify, then rebuild flat normals from the faces.
    // Prefer authored density under maxTris for textured units: aggressive
    // simplify on subdivided UVs shreds atlas mapping (see turret assemblies).
    tris = triangleCount(mesh);
    if (tris > spec.maxTris) {
      await MeshoptSimplifier.ready;
      for (const prim of mesh.listPrimitives()) prim.getAttribute("NORMAL")?.dispose();
      for (const error of [0.05, 0.25, 1]) {
        await document.transform(
          weld(),
          simplify({ simplifier: MeshoptSimplifier, ratio: (spec.maxTris / tris) * 0.98, error }),
        );
        tris = triangleCount(mesh);
        if (tris <= spec.maxTris) break;
      }
      await document.transform(unweld(), normals({ overwrite: true }));
      simplified = true;
      tris = triangleCount(mesh);
      if (tris > spec.maxTris) {
        throw new Error(`${spec.key}: ${tris} tris after simplify, budget ${spec.maxTris}`);
      }
    }

    // Ground-contact origin. Units are also XZ-centered, because their origin is
    // the entity position and a lopsided hull would sit off its own collision
    // circle. Scenery is NOT: the original placed each actor at its Cobj's own
    // origin, so re-centering would slide it off the spot it was authored on —
    // Cobj 28's bbox centre alone is 0.32 m off in Z. Their minY is already 0, so
    // the Y term is a no-op there and only states the invariant.
    // Projectiles keep BOTH: they are drawn about the centre they were authored
    // on, in the air, so neither term applies (`groundY: false`).
    bounds = bodyBounds(mesh);
    apply(
      translateMatrix(
        spec.centreXZ ? -(bounds.min[0] + bounds.max[0]) / 2 : 0,
        spec.groundY ? -bounds.min[1] : 0,
        spec.centreXZ ? -(bounds.min[2] + bounds.max[2]) / 2 : 0,
      ),
    );

    // Vertex-colour path only: on the textured path the desaturation already ran
    // per vertex-coloured primitive, against the atlas ramp rather than after it.
    if (spec.neutralizeColors && !textured) {
      for (const prim of mesh.listPrimitives()) neutralizeColors(prim);
    }

    if (spec.keepMorph) restoreMorphTargets(document, mesh, spec.key, spec.morphFrames ?? 0);
  }

  if (facerSource) {
    const slot = (texture: number) => {
      const s = facerPage.get(texture);
      if (s === undefined) throw new Error(`${spec.key}: facer texture ${texture} not packed`);
      return { offset: offsets[s], width: pages[s].width, atlasWidth: width };
    };
    const { facers, frames } = placeFacers(facerSource, placed, spec.keepMorph !== undefined, slot);
    node.setExtras({ fcop: { facers, frames } });
  }

  // Exact weld: identical position/normal/color tuples share one index —
  // pure size/VRAM win, flat shading is untouched.
  // Skip weld on textured meshes: gltf-transform weld can collapse UV-seamed
  // flat-shaded verts and shred atlas mapping on multi-part FCOP assemblies.
  // The atlas stays even where no face samples it (a model of facers only):
  // the facers' records name it.
  // (and its buffer, which a glb with no accessors still needs for the image).
  const keep = (PROPERTY_TYPES as string[]).filter(
    (t) => t !== PropertyType.TEXTURE && t !== PropertyType.BUFFER,
  );
  if (!textured) {
    // A node of facers alone is a leaf, and kept for its records.
    await document.transform(weld(), prune({ keepLeaves: prims.length === 0 }));
  } else {
    // A node of facers alone is a leaf, and kept for its records.
    await document.transform(prune({ propertyTypes: keep, keepLeaves: prims.length === 0 }));
  }
  root.getAsset().generator = "amigo-metropolis gen:units";

  const outPath = join(spec.outDir, `${spec.key}.glb`);
  await keepCommittedImages(document, outPath);
  const glb = await io.writeBinary(document);
  if (CHECK) {
    const file = Bun.file(outPath);
    const committed = (await file.exists()) ? await file.bytes() : null;
    if (!committed || !Buffer.from(glb).equals(Buffer.from(committed))) {
      stale.push(spec.label ?? spec.key);
    }
  } else {
    await mkdir(dirname(outPath), { recursive: true });
    await Bun.write(outPath, glb);
  }

  const bounds = getBounds(scene);
  const dims =
    prims.length === 0
      ? "facers only"
      : [0, 1, 2].map((i) => (bounds.max[i] - bounds.min[i]).toFixed(2)).join(" x ");
  return { key: spec.label ?? spec.key, tris, simplified, size: dims, bytes: glb.byteLength };
}

/** The prune's property types: every one gltf-transform knows. */
const PROPERTY_TYPES = Object.values(PropertyType);

/** Bounds over the mesh's non-additive faces (all of them where every face adds). */
function bodyBounds(mesh: Mesh): { min: number[]; max: number[] } {
  const all = mesh.listPrimitives();
  const body = all.filter((p) => fcopOf(p.getMaterial()).mode !== "add");
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const el = [0, 0, 0];
  for (const prim of body.length > 0 ? body : all) {
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
  return { min, max };
}

const reports: Report[] = [];
const stale: string[] = [];
for (const spec of PASSES) {
  const report = await processModel(spec);
  if (report) reports.push(report);
}
console.log(`${"key".padEnd(28)}tris   simplified  dims (x y z)          KB`);
for (const r of reports) {
  console.log(
    `${r.key.padEnd(28)}${String(r.tris).padEnd(7)}${String(r.simplified).padEnd(12)}` +
      `${r.size.padEnd(22)}${(r.bytes / 1024).toFixed(0)}`,
  );
}
if (CHECK) {
  if (stale.length > 0) {
    console.error(`gen:units --check: ${stale.length} stale: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`gen:units --check: ${reports.length} models match`);
}
