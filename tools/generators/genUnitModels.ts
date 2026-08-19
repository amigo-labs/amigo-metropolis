// Stage B unit-model pipeline (assets.md §1 Stage B, §4 glTF conventions).
//
// Turns the committed raw downloads/extractions in tools/generators/units/raw/ into
// spec-conformant per-archetype meshes at
// packages/client/public/models/units/<key>.glb, driven by units/manifest.ts:
//
//   raw glb -> strip animations/skins -> bake node transforms into one
//   primitive -> orient +Z forward -> scale to the greybox footprint ->
//   ground-contact origin -> tri-budget check (meshopt simplify as rescue)
//   -> optional color neutralization for the whole-unit instanceColor tint.
//
// Every output is ONE mesh with ONE material, colored one of two ways:
// - textured sources (the FCOP originals): all referenced 256x256 pages are
//   packed side by side into a single atlas with remapped UVs;
// - untextured sources: material colors (baseColorFactor, and flat-color
//   palette atlases sampled per vertex) are baked into COLOR_0.
// The Pincel texture-atlas / NearestFilter pipeline stays a separate Phase 7
// task (it wants stylized re-texturing, not this 1:1 packing).
//
// Authoring-time tooling like genBrand.py / genDistrict01.ts: never imported
// by the game; only its committed output ships.
//
// Usage: bun run gen:units   (from the repo root)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type Document,
  getBounds,
  type Mesh,
  NodeIO,
  type Primitive,
  PropertyType,
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
import { type DecodedImage, decodePng, encodePng } from "./png";
import { FX_MODELS, PROP_MODELS, UNIT_MODELS } from "./units/manifest";

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
  /**
   * Drop FCOP FX attachments (`tex10` searchlight volumes, `facer` additive
   * lines) before the one-material merge. Units only: the InstancedMesh
   * contract is one opaque primitive, so those beams bake into solid cones.
   * Projectiles keep them — there the beam *is* the model.
   */
  readonly dropFxAttachments?: boolean;
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
    neutralizeColors: spec.neutralizeColors,
    centreXZ: true,
    groundY: true,
    dropFxAttachments: true,
  })),
  ...PROP_MODELS.map((spec) => ({
    key: spec.key,
    raw: spec.raw,
    outDir: OUT_PROPS,
    // Scenery is placed in the original's own frame at the original's own
    // positions — re-orienting or rescaling it would misplace the arena.
    rotateQuarterY: 0 as const,
    maxTris: spec.maxTris,
    neutralizeColors: false,
    centreXZ: false,
    groundY: true,
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

/**
 * FCOP Cobj 54/57 bolt the shared FX atlas (`tex10`: light streaks, fire,
 * smoke) and emissive `facer` lines onto the hull. Those were additive
 * billboards in the original; joining them as opaque unit geometry turns the
 * Sky Captain searchlights into the dark cones in warden-iso.png. Material
 * names are the exporter's own (`extract_objects.py`).
 */
const FX_ATTACHMENT_MATERIALS = new Set(["tex10", "facer"]);

function dropFxAttachments(document: Document): void {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const name = prim.getMaterial()?.getName() ?? "";
      if (FX_ATTACHMENT_MATERIALS.has(name)) prim.dispose();
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
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

function triangleCount(mesh: Mesh): number {
  let tris = 0;
  for (const prim of mesh.listPrimitives()) {
    const indices = prim.getIndices();
    const count = indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0);
    tris += count / 3;
  }
  return tris;
}

/**
 * FCOP also bakes additive exhaust / glow as standalone billboard cards on
 * the hull page (Cobj 57's two 4-tri YZ quads under the nacelles). Material
 * drop cannot see them — they share `tex09` with the body — so after join we
 * throw away any connected component whose AABB is thinner than a centimetre.
 */
const BILLBOARD_THICKNESS = 0.02;

function dropPlanarBillboards(document: Document, mesh: Mesh): void {
  for (const prim of mesh.listPrimitives()) dropPlanarBillboardPrim(document, prim);
}

function dropPlanarBillboardPrim(document: Document, prim: Primitive): void {
  const pos = prim.getAttribute("POSITION");
  if (!pos) return;
  const indices = prim.getIndices();
  const triCount = (indices ? indices.getCount() : pos.getCount()) / 3;
  if (triCount === 0) return;

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

  const drop = new Set<number>();
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
    const thin = Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    if (thin < BILLBOARD_THICKNESS) for (const t of tris) drop.add(t);
  }
  if (drop.size === 0) return;

  const remap = new Map<number, number>();
  const newIndex: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (drop.has(t)) continue;
    for (let k = 0; k < 3; k++) {
      const old = vertAt(t, k);
      let neu = remap.get(old);
      if (neu === undefined) {
        neu = remap.size;
        remap.set(old, neu);
      }
      newIndex.push(neu);
    }
  }

  for (const semantic of prim.listSemantics()) {
    const attr = prim.getAttribute(semantic);
    if (!attr) continue;
    const src = attr.getArray();
    if (!src) continue;
    const dim = attr.getElementSize();
    const Ctor = src.constructor as new (n: number) => NonNullable<typeof src>;
    const out = new Ctor(remap.size * dim);
    for (const [old, neu] of remap) {
      out.set(src.subarray(old * dim, old * dim + dim), neu * dim);
    }
    attr.setArray(out);
  }

  const idxOut = newIndex.length <= 65535 ? new Uint16Array(newIndex) : new Uint32Array(newIndex);
  if (indices) {
    indices.setArray(idxOut);
    return;
  }
  prim.setIndices(
    document
      .createAccessor("indices")
      .setType("SCALAR")
      .setArray(idxOut)
      .setBuffer(document.getRoot().listBuffers()[0]),
  );
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
    console.warn(`skip ${spec.key}: missing ${spec.raw}`);
    return null;
  }
  const document = await io.read(rawPath);
  const root = document.getRoot();

  // Rest pose only: Stage B ships rigid merged meshes; rigs return in Stage C.
  // The pose has to be baked into the vertices first — a skinned source keeps it
  // in its joints, and the bind pose it would otherwise ship is not a pose the
  // parts were ever meant to be seen in.
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
  if (spec.dropFxAttachments) {
    dropFxAttachments(document);
    await document.transform(prune());
  }
  assertUnsharedVertexData(document, spec.key);

  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const unitMat = document.createMaterial("unit").setBaseColorFactor([1, 1, 1, 1]);
  unitMat.setMetallicFactor(0).setRoughnessFactor(1);
  // Facer primitives (`Star` / `Billboard` / `Line` in the original's 3DQL,
  // exported in an emissive `facer` material) carry no texture and no UVs — a
  // beam's colour lives in COLOR_0. A model can mix the two: every FCOP
  // projectile body has a facer glow bolted to it. Units drop those
  // attachments above (they cannot render additively on one InstancedMesh);
  // this mix path is for FX_MODELS. This used to demand UVs on EVERY
  // primitive, so one facer dropped the whole model into the vertex-colour
  // path and its atlas was thrown away. That is why fortress.glb used to
  // ship untextured (Cobj 57 carries six lines plus a tex10 volume).
  //
  // So the two are packed together: real pages side by side, plus a small white
  // patch that the facers' synthesised UVs point at, which leaves their COLOR_0
  // to come through the multiply unchanged.
  const texturedPrims = prims.filter((p) => p.getMaterial()?.getBaseColorTexture());
  const facerPrims = prims.filter((p) => !p.getMaterial()?.getBaseColorTexture());
  const textured =
    texturedPrims.length > 0 && texturedPrims.every((p) => p.getAttribute("TEXCOORD_0"));
  /** Width of the white patch, in texels. Only wide enough to sample safely. */
  const WHITE_PATCH = 8;
  if (textured) {
    // Textured path (the FCOP originals): pack all referenced 256x256 pages
    // side by side into ONE atlas and remap each primitive's U into its page's
    // column. Optional desaturation keeps the panel detail while letting the
    // whole-unit instanceColor team tint own the hue (like FCOP's own grey
    // unit variants).
    const pages: DecodedImage[] = [];
    const pageIndex = new Map<unknown, number>();
    for (const prim of texturedPrims) {
      const texture = prim.getMaterial()?.getBaseColorTexture();
      if (!texture) throw new Error(`${spec.key}: textured model with untextured primitive`);
      if (!pageIndex.has(texture)) {
        const image = texture.getImage();
        if (!image) throw new Error(`${spec.key}: texture without image`);
        pageIndex.set(texture, pages.length);
        pages.push(decodePng(new Uint8Array(image)));
      }
    }
    const height = pages[0].height;
    if (pages.some((p) => p.height !== height)) {
      throw new Error(`${spec.key}: texture pages differ in height`);
    }
    const pagesWidth = pages.reduce((n, p) => n + p.width, 0);
    const needWhite = facerPrims.length > 0;
    const width = pagesWidth + (needWhite ? WHITE_PATCH : 0);
    const packed = new Uint8Array(width * height * 4);
    // Per-page x offsets rather than "column idx of n": the white patch is
    // narrower than a page, so equal-width columns no longer hold.
    const offsets: number[] = [];
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
    const atlas = document
      .createTexture("atlas")
      .setImage(encodePng({ width, height, pixels: packed }))
      .setMimeType("image/png");
    unitMat.setBaseColorTexture(atlas);

    // Textured primitives: U into the page's own column, and — only where the
    // model actually mixes in facers — a white COLOR_0, so every primitive
    // carries the same attribute set for joinPrimitives below. A model without
    // facers keeps exactly the vertex layout it had before mixing existed.
    const white = new Float32Array(0);
    for (const prim of texturedPrims) {
      const idx = pageIndex.get(prim.getMaterial()?.getBaseColorTexture()) ?? 0;
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
        const array = new Float32Array(count * 4).fill(1);
        prim.setAttribute(
          "COLOR_0",
          document
            .createAccessor("COLOR_0")
            .setType("VEC4")
            .setArray(array.length > 0 ? array : white)
            .setBuffer(root.listBuffers()[0]),
        );
      }
      prim.setMaterial(unitMat);
    }

    // Facer primitives: keep the colour, borrow the white patch for UVs. The
    // desaturation happens here rather than in the shared pass at the end of
    // this function, which only ever saw the vertex-colour path.
    if (facerPrims.length > 0) {
      const u = (pagesWidth + WHITE_PATCH / 2) / width;
      for (const prim of facerPrims) {
        // Unconditionally, not just when COLOR_0 is missing: the exporter writes
        // facer colour as VEC3 and joinPrimitives needs one encoding across the
        // whole mesh. bakeVertexColors re-emits it as VEC4, folding in the
        // material's baseColorFactor on the way.
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
        prim.setMaterial(unitMat);
      }
    }
    for (const texture of root.listTextures()) {
      if (texture !== atlas) texture.dispose();
    }
  } else {
    // Vertex-color path (untextured packs): bake material colors into COLOR_0.
    for (const prim of prims) bakeVertexColors(document, prim);
    for (const prim of prims) {
      prim.setMaterial(unitMat);
      prim.getAttribute("TEXCOORD_0")?.dispose();
    }
    for (const texture of root.listTextures()) texture.dispose();
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
      transformMesh(nodeMesh, m as unknown as Parameters<typeof transformMesh>[1]);
      n.setMatrix(IDENTITY_MATRIX as unknown as Parameters<typeof n.setMatrix>[0]);
    }
  }

  // One node, one mesh, one primitive: the runtime swaps this into a single
  // InstancedMesh per archetype (renderer hard rule #3).
  await document.transform(joinMeshes({ keepNamed: false }), dedup(), prune());

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const nodes = scene.listChildren().filter((n) => n.getMesh());
  if (nodes.length !== 1) {
    throw new Error(`${spec.key}: expected one joined mesh node, got ${nodes.length}`);
  }
  const node = nodes[0];
  const mesh = node.getMesh();
  if (!mesh) throw new Error(`${spec.key}: joined node has no mesh`);
  node.setName("root");
  mesh.setName("hull");

  // ONE primitive too. joinMeshes() merges meshes, but a mesh that already
  // arrived split across primitives stays split — the scenery barrier (Cobj 28)
  // samples two atlas pages and so comes in as two. They share the packed
  // material and attribute set by now, which is exactly joinPrimitives' domain.
  const splitPrims = mesh.listPrimitives();
  if (splitPrims.length > 1) {
    const joined = joinPrimitives(splitPrims);
    for (const prim of splitPrims) prim.dispose();
    mesh.addPrimitive(joined);
  }

  // Bake any remaining node transform, then orient / scale / ground the mesh.
  transformMesh(mesh, node.getMatrix() as unknown as Parameters<typeof transformMesh>[1]);
  node.setMatrix(IDENTITY_MATRIX as unknown as Parameters<typeof node.setMatrix>[0]);

  const apply = (m: number[]) =>
    transformMesh(mesh, m as unknown as Parameters<typeof transformMesh>[1]);
  apply(quarterYMatrix(spec.rotateQuarterY));

  if (spec.dropFxAttachments) dropPlanarBillboards(document, mesh);

  let bounds = getBounds(scene);
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
  let tris = triangleCount(mesh);
  let simplified = false;
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
  bounds = getBounds(scene);
  apply(
    translateMatrix(
      spec.centreXZ ? -(bounds.min[0] + bounds.max[0]) / 2 : 0,
      spec.groundY ? -bounds.min[1] : 0,
      spec.centreXZ ? -(bounds.min[2] + bounds.max[2]) / 2 : 0,
    ),
  );

  // Vertex-colour path only: on the textured path the desaturation already ran
  // per facer primitive, against the atlas ramp rather than after it.
  if (spec.neutralizeColors && !textured) {
    for (const prim of mesh.listPrimitives()) neutralizeColors(prim);
  }

  // Exact weld: identical position/normal/color tuples share one index —
  // pure size/VRAM win, flat shading is untouched.
  // Skip weld on textured meshes: gltf-transform weld can collapse UV-seamed
  // flat-shaded verts and shred atlas mapping on multi-part FCOP assemblies.
  if (!textured) {
    await document.transform(weld(), prune());
  } else {
    await document.transform(prune());
  }
  root.getAsset().generator = "amigo-metropolis gen:units";

  const glb = await io.writeBinary(document);
  const outPath = join(spec.outDir, `${spec.key}.glb`);
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, glb);

  bounds = getBounds(scene);
  const dims = [0, 1, 2].map((i) => (bounds.max[i] - bounds.min[i]).toFixed(2)).join(" x ");
  return { key: spec.key, tris, simplified, size: dims, bytes: glb.byteLength };
}

const reports: Report[] = [];
for (const spec of PASSES) {
  const report = await processModel(spec);
  if (report) reports.push(report);
}
console.log("key            tris   simplified  dims (x y z)          KB");
for (const r of reports) {
  console.log(
    `${r.key.padEnd(15)}${String(r.tris).padEnd(7)}${String(r.simplified).padEnd(12)}` +
      `${r.size.padEnd(22)}${(r.bytes / 1024).toFixed(0)}`,
  );
}
