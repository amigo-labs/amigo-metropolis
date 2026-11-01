// The X1-Alpha's two gun muzzles per cockpit frame, for the sim's direct shots
// and launched rounds (fcop-fidelity.md T1; `player_fire_direct` 0x004596b0,
// `player_fire_launch` 0x00459158: `cact_model_block_point(gun, 0, ..)`).
//
//   <RE>/fixtures/missions/Mp   Cobj 16 (the cockpit, aRSL entry 2) and Cobj 17
//                               (the gun, aRSL entry 3)
//     -> packages/sim/src/x1Muzzles.generated.ts
//
// The original places the view's two gun blocks on the cockpit skeleton's third
// and fifth records (`player_bone_place` 0x00441eb0: `model_1c4` the third,
// `model_178` the fifth), both bound to the gun model at frame 0, and a shot
// leaves from the gun model's point 0 through its block (for a model without a
// skeleton, the 4DVL vertex the 4DGI's first attach byte names: vertex 32 of
// Mp's Cobj 17). Which gun fires is the low bit of the ammo being spent.
//
// THE POSE. Each bone record's local matrix is the rotation Rz(rz) Ry(rx) Rx(ry)
// (column vectors, the engine's axes; 4096 units a turn) and the translation
// its three offsets x 16 world units, composed with its parent's: the reading of
// FC:MIT's DecodedBone (RE tools/gfx/obj_mesh.py decode_bone, there in the
// x-mirrored glTF frame, here unmirrored). It is checked against the data: the
// posed cockpit's bounds must reproduce the object's own 3DBB box of every
// frame (to POSE_TOLERANCE raw units), or the generator refuses. It is the
// retail order too: `math_matrix_from_angles_b` (0x0043f7f0), which the walk
// (`player_bone_chain`, src/game/actor/player_bone.c) calls, builds Mx My Mz in
// row vectors -- the same matrix. The RE forwarded it to the first builder's
// Mz Mx My until fcop-reverse-engineering#89, which missed frame 0's box by
// about 450 units in x (fcop-fidelity.md T1).
//
// Out, per cockpit frame f and gun g (0 = `model_178`, the fifth record; 1 =
// `model_1c4`, the third): the muzzle in the cockpit's model space, world units
// (x, y, z), and row 2 of the gun's 3x3 in 16.16 -- the axis its recoil kicks
// it along (`player_partner_tick` 0x0044734d).
//
//   bun run gen:x1muzzles [--check] [--re-repo <path>]
//
// Authoring-time only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containerIndex, containerResource } from "./fcopCoarse";
import { requireReRepo } from "./reRepo";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OUT = join(REPO_ROOT, "packages", "sim", "src", "x1Muzzles.generated.ts");

const COCKPIT_COBJ = 16;
const GUN_COBJ = 17;
/** The 4DGI's attach bytes (fcop/object.h COBJ_GI_ATTACH 0x30, from the chunk's tag). */
const GI_ATTACH = 0x30;
/** The cockpit skeleton's records the two guns stand on, by gun (`model_178`, `model_1c4`). */
const GUN_RECORDS = [4, 2] as const;
/** Raw units a posed box may miss the object's own 3DBB by. */
const POSE_TOLERANCE = 2;
const ANGLE = Math.PI / 2048;

interface Chunk {
  readonly tag: string;
  /** Offset of the chunk's tag. */
  readonly at: number;
  readonly size: number;
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function i16(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
}

/** The chunk chain of a Cobj resource; tags read forwards ("4DGI", "3DHY", ...). */
function chunksOf(blob: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  let pos = 0;
  while (pos + 8 <= blob.length) {
    const size = u32(blob, pos + 4);
    if (size < 8 || pos + size > blob.length) break;
    const tag = String.fromCharCode(blob[pos + 3], blob[pos + 2], blob[pos + 1], blob[pos]);
    out.push({ tag, at: pos, size });
    pos += size;
  }
  return out;
}

function chunk(chunks: Chunk[], tag: string): Chunk {
  const c = chunks.find((k) => k.tag === tag);
  if (!c) throw new Error(`no ${tag}`);
  return c;
}

interface Bone {
  readonly level: number;
  readonly start: number;
  readonly stride: number;
  readonly op: number;
  readonly pos: readonly number[];
  readonly rot: readonly number[];
  parent: number;
}

/** 3DHY: 0x14-byte records after a 4-byte header; the parent the nearest earlier record a level up. */
function bonesOf(blob: Uint8Array, c: Chunk): Bone[] {
  const out: Bone[] = [];
  const n = Math.floor((c.size - 12) / 0x14);
  for (let i = 0; i < n; i++) {
    const r = c.at + 12 + i * 0x14;
    out.push({
      level: blob[r],
      start: blob[r + 3],
      stride: blob[r + 4],
      op: blob[r + 7],
      pos: [i16(blob, r + 8), i16(blob, r + 10), i16(blob, r + 12)],
      rot: [i16(blob, r + 14), i16(blob, r + 16), i16(blob, r + 18)],
      parent: -1,
    });
  }
  for (let i = 1; i < n; i++) {
    for (let k = i - 1; k >= 0; k--) {
      if (out[k].level === out[i].level - 1) {
        out[i].parent = k;
        break;
      }
    }
  }
  return out;
}

/** 3DMI: int16 samples after a 4-byte header. */
function animOf(blob: Uint8Array, c: Chunk): Int16Array {
  const n = Math.floor((c.size - 12) / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = i16(blob, c.at + 12 + i * 2);
  return out;
}

/** The first 4DVL's vertices, raw (x, y, z). */
function vertsOf(blob: Uint8Array, c: Chunk): number[][] {
  const count = u32(blob, c.at + 12);
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const v = c.at + 16 + i * 8;
    out.push([i16(blob, v), i16(blob, v + 2), i16(blob, v + 4)]);
  }
  return out;
}

/** A 3x4: rotation rows r[0..8] (column-vector convention), translation t. */
interface Affine {
  readonly r: number[];
  readonly t: number[];
}

function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
}

function apply(m: Affine, v: readonly number[]): number[] {
  return [0, 1, 2].map(
    (i) => m.r[i * 3] * v[0] + m.r[i * 3 + 1] * v[1] + m.r[i * 3 + 2] * v[2] + m.t[i],
  );
}

/** The bones' world matrices at `frame`, world units. */
function pose(bones: Bone[], anim: Int16Array, frame: number): Affine[] {
  const channel = (base: number, constant: boolean): number => {
    if (constant) return base;
    const i = base + frame;
    return i >= 0 && i < anim.length ? anim[i] : base;
  };
  const out: Affine[] = [];
  for (const b of bones) {
    const px = channel(b.pos[0], (b.op & 0x20) !== 0);
    const py = channel(b.pos[1], (b.op & 0x10) !== 0);
    const pz = channel(b.pos[2], (b.op & 0x08) !== 0);
    const rx = channel(b.rot[0], (b.op & 0x04) !== 0) * ANGLE;
    const ry = channel(b.rot[1], (b.op & 0x02) !== 0) * ANGLE;
    const rz = channel(b.rot[2], (b.op & 0x01) !== 0) * ANGLE;
    const Rz = [Math.cos(rz), -Math.sin(rz), 0, Math.sin(rz), Math.cos(rz), 0, 0, 0, 1];
    const Ry = [Math.cos(rx), 0, Math.sin(rx), 0, 1, 0, -Math.sin(rx), 0, Math.cos(rx)];
    const Rx = [1, 0, 0, 0, Math.cos(ry), -Math.sin(ry), 0, Math.sin(ry), Math.cos(ry)];
    const local: Affine = { r: mul3(Rz, mul3(Ry, Rx)), t: [px * 16, py * 16, pz * 16] };
    if (b.parent < 0) {
      out.push(local);
    } else {
      const p = out[b.parent];
      out.push({ r: mul3(p.r, local.r), t: apply(p, local.t) });
    }
  }
  return out;
}

function boneOfVertex(bones: Bone[], v: number): number {
  let j = 0;
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].start > v) break;
    if (bones[i].start + bones[i].stride > v) j = i;
  }
  return j;
}

function build(reRepo: string): string {
  const container = new Uint8Array(readFileSync(join(reRepo, "fixtures", "missions", "Mp")));
  const res = containerIndex(container);
  const blobOf = (id: number): Uint8Array => {
    const at = res.get(`jboC:${id}`);
    if (!at) throw new Error(`Mp has no Cobj ${id}`);
    return containerResource(container, at);
  };
  const cockpit = blobOf(COCKPIT_COBJ);
  const gun = blobOf(GUN_COBJ);
  const cc = chunksOf(cockpit);
  const gc = chunksOf(gun);
  const bones = bonesOf(cockpit, chunk(cc, "3DHY"));
  const anim = animOf(cockpit, chunk(cc, "3DMI"));
  const verts = vertsOf(cockpit, chunk(cc, "4DVL"));
  const bb = chunk(cc, "3DBB");
  const frames = u32(cockpit, chunk(cc, "4DGI").at + 12) & 0xffff;
  const point = gun[chunk(gc, "4DGI").at + GI_ATTACH];
  const gunVerts = vertsOf(gun, chunk(gc, "4DVL"));
  if (point >= gunVerts.length) throw new Error(`gun point 0 names vertex ${point}`);
  const p0 = gunVerts[point].map((v) => v * 16);

  const rows: string[] = [];
  let worst = 0;
  for (let f = 0; f < frames; f++) {
    const m = pose(bones, anim, f);
    // The check: the posed cockpit's bounds against the object's 3DBB box of
    // frame f (entry f, centre and half extents, raw).
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    verts.forEach((v, i) => {
      const w = apply(m[boneOfVertex(bones, i)], [v[0] * 16, v[1] * 16, v[2] * 16]);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], w[k] / 16);
        hi[k] = Math.max(hi[k], w[k] / 16);
      }
    });
    const box = bb.at + 16 + f * 16;
    for (let k = 0; k < 3; k++) {
      const centre = i16(cockpit, box + 2 * k);
      const half = i16(cockpit, box + 6 + 2 * k);
      worst = Math.max(
        worst,
        Math.abs((lo[k] + hi[k]) / 2 - centre),
        Math.abs((hi[k] - lo[k]) / 2 - half),
      );
    }
    const words: number[] = [];
    for (const rec of GUN_RECORDS) {
      const g = m[rec];
      const at = apply(g, p0);
      words.push(...at.map((v) => Math.round(v)));
      // Row 2 of the engine's row-vector 3x3: the image of z, column 2 here.
      words.push(...[0, 1, 2].map((i) => Math.round(g.r[i * 3 + 2] * 65536)));
    }
    rows.push(`  ${words.join(", ")},`);
  }
  if (worst > POSE_TOLERANCE) {
    throw new Error(`the posed cockpit misses its 3DBB by ${worst.toFixed(2)} raw units`);
  }
  return [
    "// GENERATED by tools/generators/fcopX1Muzzles.ts (bun run gen:x1muzzles) from",
    "// the RE's fixtures/missions/Mp, Cobj 16 (the cockpit) and Cobj 17 (the gun). Do",
    "// not edit.",
    "",
    "/** Words per cockpit frame: per gun, its muzzle (x, y, z) and its row 2 (x, y, z). */",
    "export const X1_MUZZLE_WORDS = 12;",
    "",
    "/**",
    " * The two gun muzzles by cockpit frame: gun 0 `model_178` (the cockpit",
    " * skeleton's fifth record), gun 1 `model_1c4` (the third). Each: the gun",
    " * model's point 0 in the cockpit's model space, world units (8192 a metre),",
    " * then row 2 of the gun's 3x3 in 16.16, its recoil's axis.",
    ` * The posed cockpit reproduces its own 3DBB to ${worst.toFixed(2)} raw units.`,
    " */",
    "export const X1_MUZZLES: Int32Array = new Int32Array([",
    ...rows,
    "]);",
    "",
  ].join("\n");
}

/** The output as the formatter writes it, so a re-run and `--check` agree with lint. */
function biomeFormat(text: string, path: string): string {
  const fmt = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${path}`], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(text),
  });
  if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
  return fmt.stdout.toString();
}

function main(): void {
  const reRepo = requireReRepo();
  const text = biomeFormat(build(reRepo), OUT);
  if (process.argv.includes("--check")) {
    const same = existsSync(OUT) && readFileSync(OUT, "utf8") === text;
    console.log(`x1 muzzles: ${same ? "reproduce the committed table" : "PROBLEM differ"}`);
    if (!same) process.exit(1);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`x1 muzzles -> ${OUT}`);
}

if (import.meta.main) main();
