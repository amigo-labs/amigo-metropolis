// Contact sheet for FCOP projectile / weapon-effect Cobj models.
//
//   bun run gen:fxcobj                       # committed raws
//   bun run gen:fxcobj <dir> <out-name>      # any directory of .glb
//
// WHY THIS EXISTS
// The Cpyr contact sheet (fx/particleSheet.ts) exists because "the id->role
// mapping should be argued from the pixels instead of guessed". The projectile
// side has the same problem one level up: the original's weapon effects are Cobj
// MESHES, not sprites, and the FX pool is a dozen unlabelled objects — beams,
// glow stars, small rockets, one 11-frame morph. Which is which cannot be read
// off a filename, and `docs/specs/fcop-fx.md` has to answer it in writing.
//
// So this draws them. A real triangle rasterizer rather than the point cloud
// `tools/determinism/src/turretPreviewPng.ts` uses: at 24 vertices a beam is
// four dots in a point cloud and unreadable, while its silhouette is obvious.
// Textures are deliberately NOT sampled — the atlas pages live in the RE repo,
// not here, and a silhouette settles "rocket vs shell vs glow" on its own.
//
// Facer geometry (Star / Billboard / Line in `3DQL`, exported as an emissive
// `facer` material) is drawn HOT and solid geometry cool, because that split is
// exactly what distinguishes an effect from a projectile body: obj 46 is pure
// facer (a glow), obj 43 is a textured body plus one facer (a rocket with a
// glow at its tail).
//
// Authoring-time only. Writes docs/renders/fcop-fx/<name>.png.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DecodedImage, encodePng } from "../png";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DEFAULT_DIR = join(ROOT, "tools", "generators", "units", "raw", "fcop-fx");
const OUT_DIR = join(ROOT, "docs", "renders", "fcop-fx");

const CELL = 224;
const COLS = 4;
const PAD = 6;
const BG = 18;

interface Tri {
  /** Nine floats: three xyz corners. */
  readonly p: Float32Array;
  readonly facer: boolean;
}

interface Model {
  readonly name: string;
  readonly tris: Tri[];
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly verts: number;
  readonly morphTargets: number;
  readonly materials: string[];
}

/**
 * Triangle soup out of a .glb, flagging every primitive whose material is the
 * exporter's emissive `facer`.
 *
 * Reads POSITION through its accessor/bufferView the same way
 * `turretPreviewPng.ts` does; unindexed primitives (which is what the FCOP
 * export emits) walk vertices in order.
 */
function loadModel(path: string, name: string): Model {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(
    buf
      .subarray(20, 20 + jsonLen)
      .toString("utf8")
      .replace(/\0+$/, ""),
  );
  let off = 20 + jsonLen;
  while (off % 4) off++;
  const binLen = buf.readUInt32LE(off);
  const bin = buf.subarray(off + 8, off + 8 + binLen);

  const tris: Tri[] = [];
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  const materials: string[] = [];
  let verts = 0;
  let morphTargets = 0;

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const acc = json.accessors[prim.attributes.POSITION];
      const bv = json.bufferViews[acc.bufferView];
      const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = bv.byteStride ?? 12;
      const matName =
        prim.material !== undefined
          ? (json.materials[prim.material].name ?? `mat${prim.material}`)
          : "none";
      if (!materials.includes(matName)) materials.push(matName);
      const facer = matName === "facer";
      morphTargets = Math.max(morphTargets, prim.targets?.length ?? 0);

      const xyz = new Float32Array(acc.count * 3);
      for (let i = 0; i < acc.count; i++) {
        const o = start + i * stride;
        xyz[i * 3] = bin.readFloatLE(o);
        xyz[i * 3 + 1] = bin.readFloatLE(o + 4);
        xyz[i * 3 + 2] = bin.readFloatLE(o + 8);
        for (let k = 0; k < 3; k++) {
          const v = xyz[i * 3 + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      verts += acc.count;

      const idx: number[] = [];
      if (prim.indices !== undefined) {
        const ia = json.accessors[prim.indices];
        const ibv = json.bufferViews[ia.bufferView];
        const istart = (ibv.byteOffset ?? 0) + (ia.byteOffset ?? 0);
        // 5121 u8, 5123 u16, 5125 u32 (glTF componentType).
        const size = ia.componentType === 5121 ? 1 : ia.componentType === 5123 ? 2 : 4;
        for (let i = 0; i < ia.count; i++) {
          const o = istart + i * size;
          idx.push(size === 1 ? bin[o] : size === 2 ? bin.readUInt16LE(o) : bin.readUInt32LE(o));
        }
      } else {
        for (let i = 0; i < acc.count; i++) idx.push(i);
      }
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const p = new Float32Array(9);
        for (let c = 0; c < 3; c++) {
          p[c * 3] = xyz[idx[i + c] * 3];
          p[c * 3 + 1] = xyz[idx[i + c] * 3 + 1];
          p[c * 3 + 2] = xyz[idx[i + c] * 3 + 2];
        }
        tris.push({ p, facer });
      }
    }
  }
  return { name, tris, min, max, verts, morphTargets, materials };
}

/** Rasterizes one model into a CELL x CELL RGB block with a Z-buffer. */
function renderCell(m: Model): Uint8Array {
  const px = new Uint8Array(CELL * CELL * 3).fill(BG);
  const zbuf = new Float32Array(CELL * CELL).fill(Number.NEGATIVE_INFINITY);
  if (m.tris.length === 0) return px;

  const c = [0, 1, 2].map((k) => (m.min[k] + m.max[k]) / 2);
  const span = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2], 0.001);
  const scale = (CELL - PAD * 2) / (span * 1.35);

  // 3/4 view, +Z forward pointing right-ish: yaw 35°, pitch 22°. Hardcoded
  // trig, and deliberately so — this is an authoring tool outside the sim, but
  // matching the sim's no-transcendentals habit costs nothing here.
  const cosA = 0.819;
  const sinA = 0.574;
  const cosB = 0.927;
  const sinB = 0.375;

  const project = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - c[0];
    const dy = y - c[1];
    const dz = z - c[2];
    const x1 = dx * cosA - dz * sinA;
    const z1 = dx * sinA + dz * cosA;
    const y1 = dy * cosB - z1 * sinB;
    const depth = dy * sinB + z1 * cosB;
    return [CELL / 2 + x1 * scale, CELL / 2 - y1 * scale, depth];
  };

  for (const t of m.tris) {
    const a = project(t.p[0], t.p[1], t.p[2]);
    const b = project(t.p[3], t.p[4], t.p[5]);
    const d = project(t.p[6], t.p[7], t.p[8]);
    // Screen-space normal for a cheap facing/shade term.
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const area = ux * vy - uy * vx;
    if (area === 0) continue;
    const shade = 0.45 + 0.55 * Math.min(1, Math.abs(area) / (span * scale * span * scale * 0.5));

    let r: number;
    let g: number;
    let bl: number;
    if (t.facer) {
      r = 255 * shade;
      g = 210 * shade;
      bl = 90 * shade;
    } else {
      r = 120 * shade;
      g = 140 * shade;
      bl = 170 * shade;
    }

    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], d[0])));
    const maxX = Math.min(CELL - 1, Math.ceil(Math.max(a[0], b[0], d[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], d[1])));
    const maxY = Math.min(CELL - 1, Math.ceil(Math.max(a[1], b[1], d[1])));
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0])) * inv;
        const w1 = ((x + 0.5 - a[0]) * (d[1] - a[1]) - (y + 0.5 - a[1]) * (d[0] - a[0])) * inv;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const depth = a[2] + (b[2] - a[2]) * w1 + (d[2] - a[2]) * w0;
        const o = y * CELL + x;
        if (depth <= zbuf[o]) continue;
        zbuf[o] = depth;
        px[o * 3] = Math.min(255, r);
        px[o * 3 + 1] = Math.min(255, g);
        px[o * 3 + 2] = Math.min(255, bl);
      }
    }
  }

  // 1 m reference rule along the bottom edge, so scale is readable per cell.
  const ruleLen = Math.min(CELL - PAD * 2, Math.round(1.0 * scale));
  for (let x = 0; x < ruleLen; x++) {
    const o = ((CELL - PAD) * CELL + PAD + x) * 3;
    px[o] = 90;
    px[o + 1] = 200;
    px[o + 2] = 120;
  }
  return px;
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const outName = process.argv[3] ?? "fx-cobj-contact";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".glb"))
    .sort();
  if (files.length === 0) throw new Error(`no .glb in ${dir}`);

  const models = files.map((f) => loadModel(join(dir, f), f.replace(/\.glb$/, "")));
  const rows = Math.ceil(models.length / COLS);
  const width = COLS * CELL;
  const height = rows * CELL;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = BG;
    pixels[i * 4 + 1] = BG;
    pixels[i * 4 + 2] = BG;
    pixels[i * 4 + 3] = 255;
  }

  console.log(`Cobj FX contact sheet — ${models.length} model(s) from ${dir}`);
  console.log("cell order is left-to-right, top-to-bottom; green rule = 1 m\n");

  models.forEach((m, i) => {
    const cell = renderCell(m);
    const cx = (i % COLS) * CELL;
    const cy = Math.floor(i / COLS) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const s = (y * CELL + x) * 3;
        const d = ((cy + y) * width + cx + x) * 4;
        pixels[d] = cell[s];
        pixels[d + 1] = cell[s + 1];
        pixels[d + 2] = cell[s + 2];
      }
    }
    const size = [0, 1, 2].map((k) => (m.max[k] - m.min[k]).toFixed(3)).join(" x ");
    console.log(
      `  ${String(i + 1).padStart(2)}. ${m.name.padEnd(28)} ${size} m` +
        `  verts ${String(m.verts).padStart(4)}  tris ${String(m.tris.length).padStart(4)}` +
        `  morph ${m.morphTargets}  mats ${m.materials.join("+")}`,
    );
  });

  const image: DecodedImage = { width, height, pixels };
  const out = join(OUT_DIR, `${outName}.png`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(image));
  console.log(`\nwrote ${out} (${width}x${height})`);
}

main();
