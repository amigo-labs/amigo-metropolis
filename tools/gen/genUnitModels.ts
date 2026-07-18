// Stage B unit-model pipeline (assets.md §1 Stage B, §4 glTF conventions).
//
// Turns the committed raw CC0 downloads in tools/gen/units/raw/ into
// spec-conformant per-archetype meshes at
// packages/client/public/models/units/<key>.glb, driven by units/manifest.ts:
//
//   raw glb -> strip animations/skins -> bake node transforms & material
//   colors (baseColorFactor, and flat-color palette atlases sampled per
//   vertex) into one vertex-colored primitive -> orient +Z forward -> scale
//   to the greybox footprint -> ground-contact origin -> tri-budget check
//   (meshopt simplify as rescue) -> optional color neutralization for the
//   whole-unit instanceColor team tint.
//
// Every output is texture-free by design: one material, COLOR_0 only. The
// Pincel texture-atlas / NearestFilter pipeline is the separate Phase 7 task.
//
// Authoring-time tooling like genBrand.py / genDistrict01.ts: never imported
// by the game; only its committed output ships.
//
// Usage: bun run gen:units   (from the repo root)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { type Document, getBounds, type Mesh, NodeIO, type Primitive } from "@gltf-transform/core";
import {
  dedup,
  flatten,
  join as joinMeshes,
  normals,
  prune,
  simplify,
  transformMesh,
  unweld,
  weld,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { UNIT_MODELS, type UnitModelSpec } from "./units/manifest";

const RAW_DIR = join(import.meta.dir, "units", "raw");
const OUT_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "client",
  "public",
  "models",
  "units",
);

const io = new NodeIO();

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

interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, sRGB-encoded like the source file. */
  readonly pixels: Uint8Array;
}

function decodePng(bytes: Uint8Array): DecodedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(
      bytes[off + 4],
      bytes[off + 5],
      bytes[off + 6],
      bytes[off + 7],
    );
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      bitDepth = bytes[off + 16];
      colorType = bytes[off + 17];
      interlace = bytes[off + 20];
    } else if (type === "PLTE") {
      palette = bytes.subarray(off + 8, off + 8 + len);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(off + 8, off + 8 + len));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, interlace ${interlace})`);
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let w = 0;
  for (const chunk of idat) {
    compressed.set(chunk, w);
    w += chunk.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  const scanlines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x];
      const a = x >= channels ? scanlines[dst + x - channels] : 0;
      const b = y > 0 ? scanlines[dst + x - stride] : 0;
      const c = x >= channels && y > 0 ? scanlines[dst + x - channels - stride] : 0;
      let value: number;
      if (filter === 0) value = cur;
      else if (filter === 1) value = cur + a;
      else if (filter === 2) value = cur + b;
      else if (filter === 3) value = cur + Math.floor((a + b) / 2);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      scanlines[dst + x] = value & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (colorType === 3) {
      if (!palette) throw new Error("indexed PNG without PLTE");
      const p = scanlines[s] * 3;
      pixels.set([palette[p], palette[p + 1], palette[p + 2], 255], i * 4);
    } else if (colorType === 2 || colorType === 6) {
      pixels.set(
        [
          scanlines[s],
          scanlines[s + 1],
          scanlines[s + 2],
          colorType === 6 ? scanlines[s + 3] : 255,
        ],
        i * 4,
      );
    } else {
      const g = scanlines[s];
      pixels.set([g, g, g, colorType === 4 ? scanlines[s + 1] : 255], i * 4);
    }
  }
  return { width, height, pixels };
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
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
 * Desaturates COLOR_0 to luminance and normalizes brightness so the
 * multiplicative instanceColor team tint dominates the read (palette.ts).
 */
function neutralizeColors(prim: Primitive): void {
  const color = prim.getAttribute("COLOR_0");
  if (!color) return;
  const count = color.getCount();
  const lums = new Float32Array(count);
  let maxLum = 0;
  const el: number[] = [1, 1, 1, 1];
  for (let i = 0; i < count; i++) {
    color.getElement(i, el);
    const lum = 0.2126 * el[0] + 0.7152 * el[1] + 0.0722 * el[2];
    lums[i] = lum;
    if (lum > maxLum) maxLum = lum;
  }
  const scale = maxLum > 0 ? 0.9 / maxLum : 1;
  for (let i = 0; i < count; i++) {
    const v = Math.min(1, lums[i] * scale);
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

async function processModel(spec: UnitModelSpec): Promise<Report> {
  const document = await io.read(join(RAW_DIR, spec.raw));
  const root = document.getRoot();

  // Rest pose only: Stage B ships rigid merged meshes; rigs return in Stage C.
  for (const anim of root.listAnimations()) anim.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) {
        if (/^(JOINTS|WEIGHTS)_/.test(semantic) || semantic === "TEXCOORD_1") {
          prim.getAttribute(semantic)?.dispose();
        }
      }
    }
  }

  await document.transform(dedup(), prune(), flatten());

  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  for (const prim of prims) bakeVertexColors(document, prim);
  const unitMat = document.createMaterial("unit").setBaseColorFactor([1, 1, 1, 1]);
  unitMat.setMetallicFactor(0).setRoughnessFactor(1);
  for (const prim of prims) {
    prim.setMaterial(unitMat);
    prim.getAttribute("TEXCOORD_0")?.dispose();
  }
  for (const texture of root.listTextures()) texture.dispose();

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

  // Bake any remaining node transform, then orient / scale / ground the mesh.
  transformMesh(mesh, node.getMatrix() as unknown as Parameters<typeof transformMesh>[1]);
  node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const apply = (m: number[]) =>
    transformMesh(mesh, m as unknown as Parameters<typeof transformMesh>[1]);
  apply(quarterYMatrix(spec.rotateQuarterY));

  let bounds = getBounds(scene);
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const sizeZ = bounds.max[2] - bounds.min[2];
  const footprintScale = spec.footprint / Math.max(sizeX, sizeZ);
  const heightScale =
    spec.maxHeight !== undefined ? spec.maxHeight / sizeY : Number.POSITIVE_INFINITY;
  apply(scaleMatrix(Math.min(footprintScale, heightScale)));

  // Tri budget (assets.md §4), meshopt simplify as the logged rescue path.
  // Flat-shaded sources split nearly every vertex on normal seams, which the
  // simplifier treats as locked borders — so drop normals first, weld by
  // position+color, simplify, then rebuild flat normals from the faces.
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

  bounds = getBounds(scene);
  apply(
    translateMatrix(
      -(bounds.min[0] + bounds.max[0]) / 2,
      -bounds.min[1],
      -(bounds.min[2] + bounds.max[2]) / 2,
    ),
  );

  if (spec.neutralizeColors) {
    for (const prim of mesh.listPrimitives()) neutralizeColors(prim);
  }

  // Exact weld: identical position/normal/color tuples share one index —
  // pure size/VRAM win, flat shading is untouched.
  await document.transform(weld(), prune());
  root.getAsset().generator = "amigo-metropolis gen:units";

  const glb = await io.writeBinary(document);
  const outPath = join(OUT_DIR, `${spec.key}.glb`);
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, glb);

  bounds = getBounds(scene);
  const dims = [0, 1, 2].map((i) => (bounds.max[i] - bounds.min[i]).toFixed(2)).join(" x ");
  return { key: spec.key, tris, simplified, size: dims, bytes: glb.byteLength };
}

const reports: Report[] = [];
for (const spec of UNIT_MODELS) {
  reports.push(await processModel(spec));
}
console.log("key            tris   simplified  dims (x y z)          KB");
for (const r of reports) {
  console.log(
    `${r.key.padEnd(15)}${String(r.tris).padEnd(7)}${String(r.simplified).padEnd(12)}` +
      `${r.size.padEnd(22)}${(r.bytes / 1024).toFixed(0)}`,
  );
}
