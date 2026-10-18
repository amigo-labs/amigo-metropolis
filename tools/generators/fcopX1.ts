// The X1-Alpha as the original animates it: the legs' and the cockpit's
// skeletons baked into one bone-matrix table, and the five parts merged into one
// mesh that a vertex shader poses by two frame numbers per instance
// (packages/client/src/render/avatarRig.ts; assets.md §4; fcop-fidelity.md G11).
//
//   <RE>/extracted/x1/x1_{legs,cockpit,weapon,beacon_lights}.glb, tracks.json
//     -> tools/generators/units/raw/fcop-x1/                      (unchanged)
//   (and x1_alpha_transform.glb, the RE's assembled transform, which only the
//   test reads: tools/generators/test/x1Rig.test.ts)
//   <RE>/fixtures/missions/Mp, Cobj 15 and 16 (the legs and the cockpit), 3DHS
//     -> tools/generators/units/raw/fcop-x1/channels.json         (the mount points)
//   raws
//     -> packages/client/public/models/units/avatar-x1.glb        (bind pose, one primitive)
//     -> packages/client/public/models/units/avatar-x1.anim.bin   (the bone table)
//     -> packages/client/src/render/x1Rig.generated.ts            (the bone table's layout)
//     -> packages/sim/src/x1Tracks.generated.ts                    (the AnmD tracks)
//
// The assembly is the original's (RE tools/gfx/extract_x1.py, player.c 1621,
// player_partner.c 1611-1739, player_bone.c): the legs stand at the actor's
// origin; the cockpit rides on the legs' model point 0 -- 3DHS channel 0 of the
// legs' frame, which moves frame by frame (the cockpit bobs with the stride and
// drops into the hover); the two guns ride on the cockpit skeleton's records 2
// and 4; the beacon lights on the cockpit's model point 2, in the cockpit's
// orientation. The pilot is not drawn with the mech.
//
// The glbs' skins are rigid (one joint per vertex, weight 1), so a skin matrix
// per joint per frame is the whole animation: the legs' 371 frames by 8 joints,
// the cockpit's 30 by 7, plus the two guns and the beacon per cockpit frame.
// Read off each glb's `full` clip, which keys frame f at f / 15 s -- an index,
// not a time: the game's timing is the AnmD tracks' (tracks.json), which the
// sim's walker machine steps (packages/sim/src/walker.ts; the legs' tracks hold
// and launch the walker's states, fcop-fidelity.md G11, P4). The clip seconds
// in the RE manifest are not used for anything.
//
//   bun run gen:x1 [--import] [--check] [--re-repo <path>]
//
// `--import` refreshes the raws from the RE first. `--check` rebuilds from the
// committed raws and exits 1 if a committed output differs. Authoring-time only.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Accessor, Document, type Node, NodeIO, type Primitive } from "@gltf-transform/core";
import { argOf } from "./fcopLogic";

const REPO_ROOT = join(import.meta.dir, "..", "..");
export const X1_RAW_DIR = join(import.meta.dir, "units", "raw", "fcop-x1");
const MODELS = join(REPO_ROOT, "packages", "client", "public", "models", "units");
export const X1_OUT_GLB = join(MODELS, "avatar-x1.glb");
export const X1_OUT_BIN = join(MODELS, "avatar-x1.anim.bin");
export const X1_OUT_TS = join(
  REPO_ROOT,
  "packages",
  "client",
  "src",
  "render",
  "x1Rig.generated.ts",
);
export const X1_OUT_SIM_TS = join(REPO_ROOT, "packages", "sim", "src", "x1Tracks.generated.ts");

/** The parts the RE exports, by their file under extracted/x1/. */
const PART_FILES = ["x1_legs.glb", "x1_cockpit.glb", "x1_weapon.glb", "x1_beacon_lights.glb"];
/** The Cobj each part is in Mp's container, by the RE manifest (`cobj_id_by_map.Mp`). */
const CHANNEL_PARTS = ["legs", "cockpit"] as const;

/** int16 vertex units to metres, x mirrored: obj_mesh.FIXED_POINT and channel_pos. */
const FIXED_POINT = 1 / 512;
/** The cockpit's skeleton records the two guns stand on (player_bone.c). */
const GUN_RECORDS = [2, 4] as const;
/** The cockpit's model point the beacon lights stand on (PLAYER_PARTNER_GUN_POINT). */
const BEACON_POINT = 2;
/** The legs' model point the cockpit stands on (player.c 1621). */
const MOUNT_POINT = 0;

// --- the bone table's layout: one RGBA float texel per matrix row ------------

/** Texels per matrix: the three rows of a 3x4 affine. */
const TEXELS_PER_MATRIX = 3;
/** Legs joints, then the cockpit's, the two guns and the beacon. */
const COCKPIT_SLOTS = 7 + GUN_RECORDS.length + 1;

/** channels.json: each part's 3DHS records, raw int16 (x, y, z), channel `i` of frame `f` at `count * f + i`. */
interface Channels {
  readonly source: string;
  readonly legs: ChannelSet;
  readonly cockpit: ChannelSet;
}
interface ChannelSet {
  readonly cobj: number;
  readonly sha256: string;
  readonly count: number;
  readonly frames: number;
  readonly xyz: readonly (readonly [number, number, number])[];
}

function channelPos(set: ChannelSet, channel: number, frame: number): [number, number, number] {
  const v = set.xyz[set.count * frame + channel];
  if (!v) throw new Error(`3DHS: no channel ${channel} at frame ${frame}`);
  return [-v[0] * FIXED_POINT, v[1] * FIXED_POINT, v[2] * FIXED_POINT];
}

// --- column-major 4x4 helpers (glTF's convention) ----------------------------

type M4 = Float64Array;

function identity(): M4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply(a: M4, b: M4): M4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): M4 {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

function translation(p: ArrayLike<number>): M4 {
  const m = identity();
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  return m;
}

// --- reading a part -----------------------------------------------------------

interface Part {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  /** Per vertex: its joint (skinned parts), else 0. */
  readonly joint: Uint8Array;
  readonly count: number;
  /** Frames of the `full` clip, 0 for a static part. */
  readonly frames: number;
  /** Per frame, per joint: the joint's world matrix (no inverse bind). */
  readonly world: M4[][];
  /** Per joint: the inverse bind matrix. */
  readonly inverseBind: M4[];
  readonly image: Uint8Array | null;
}

function arrayOf(a: Accessor | null, name: string): Float32Array {
  if (!a) throw new Error(`missing ${name}`);
  const arr = a.getArray();
  if (!arr) throw new Error(`empty ${name}`);
  if (arr instanceof Float32Array) return arr;
  return Float32Array.from(arr as ArrayLike<number>);
}

async function readPart(io: NodeIO, file: string): Promise<Part> {
  const doc = await io.readBinary(new Uint8Array(readFileSync(join(X1_RAW_DIR, file))));
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length !== 1 || meshes[0].listPrimitives().length !== 1)
    throw new Error(`${file}: expected one mesh with one primitive`);
  const prim: Primitive = meshes[0].listPrimitives()[0];
  if (prim.getIndices()) throw new Error(`${file}: expected a non-indexed primitive`);
  const meshNode = root.listNodes().find((n) => n.getMesh() === meshes[0]);
  if (!meshNode) throw new Error(`${file}: no node draws the mesh`);
  const position = arrayOf(prim.getAttribute("POSITION"), `${file} POSITION`);
  const normal = arrayOf(prim.getAttribute("NORMAL"), `${file} NORMAL`);
  const uv = arrayOf(prim.getAttribute("TEXCOORD_0"), `${file} TEXCOORD_0`);
  const count = position.length / 3;
  const joint = new Uint8Array(count);
  const image = root.listTextures()[0]?.getImage() ?? null;

  const skin = meshNode.getSkin();
  if (!skin) {
    // A static part: its node must not move it, since the original places it.
    const m = meshNode.getMatrix();
    for (let i = 0; i < 16; i++) {
      if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9)
        throw new Error(`${file}: posed mesh node`);
    }
    return { position, normal, uv, joint, count, frames: 0, world: [], inverseBind: [], image };
  }

  // Rigid skin: one joint at weight 1 per vertex.
  const joints = prim.getAttribute("JOINTS_0");
  const weights = prim.getAttribute("WEIGHTS_0");
  if (!joints || !weights) throw new Error(`${file}: skinned without JOINTS_0 / WEIGHTS_0`);
  const jv: number[] = [];
  const wv: number[] = [];
  for (let v = 0; v < count; v++) {
    joints.getElement(v, jv);
    weights.getElement(v, wv);
    let best = 0;
    for (let k = 1; k < 4; k++) if (wv[k] > wv[best]) best = k;
    for (let k = 0; k < 4; k++) {
      if (k !== best && wv[k] !== 0) throw new Error(`${file}: vertex ${v} is not rigidly skinned`);
    }
    if (Math.abs(wv[best] - 1) > 1e-6) throw new Error(`${file}: vertex ${v} weight ${wv[best]}`);
    joint[v] = jv[best];
  }

  const jointNodes = skin.listJoints();
  const ibm = arrayOf(skin.getInverseBindMatrices(), `${file} inverseBindMatrices`);
  const inverseBind = jointNodes.map((_, j) =>
    Float64Array.from(ibm.subarray(j * 16, j * 16 + 16)),
  );

  const full = root.listAnimations().find((a) => a.getName() === "full");
  if (!full) throw new Error(`${file}: no "full" clip`);
  const tracks = new Map<Node, { t?: Float32Array; r?: Float32Array; s?: Float32Array }>();
  let frames = -1;
  for (const ch of full.listChannels()) {
    const node = ch.getTargetNode();
    const path = ch.getTargetPath();
    const sampler = ch.getSampler();
    if (!node || !path || !sampler) continue;
    const input = arrayOf(sampler.getInput(), `${file} clip input`);
    // The clip keys every frame, frame f at f / 15 s: an index.
    if (frames < 0) frames = input.length;
    if (input.length !== frames) throw new Error(`${file}: clip channels disagree on frames`);
    for (let f = 0; f < frames; f++) {
      if (Math.abs(input[f] - f / 15) > 1e-4)
        throw new Error(`${file}: frame ${f} keyed at ${input[f]}`);
    }
    const out = arrayOf(sampler.getOutput(), `${file} clip output`);
    const entry = tracks.get(node) ?? {};
    if (path === "translation") entry.t = out;
    else if (path === "rotation") entry.r = out;
    else if (path === "scale") entry.s = out;
    else throw new Error(`${file}: clip animates ${path}`);
    tracks.set(node, entry);
  }
  if (frames <= 0) throw new Error(`${file}: empty "full" clip`);

  const world: M4[][] = [];
  for (let f = 0; f < frames; f++) {
    const cache = new Map<Node, M4>();
    const worldOf = (node: Node): M4 => {
      const hit = cache.get(node);
      if (hit) return hit;
      const tr = tracks.get(node);
      const t = tr?.t ? tr.t.subarray(f * 3, f * 3 + 3) : node.getTranslation();
      const r = tr?.r ? tr.r.subarray(f * 4, f * 4 + 4) : node.getRotation();
      const s = tr?.s ? tr.s.subarray(f * 3, f * 3 + 3) : node.getScale();
      const local = compose(t, r, s);
      const parent = node.getParentNode();
      const m = parent ? multiply(worldOf(parent), local) : local;
      cache.set(node, m);
      return m;
    };
    world.push(jointNodes.map((n) => worldOf(n)));
  }
  return { position, normal, uv, joint, count, frames, world, inverseBind, image };
}

// --- the build ------------------------------------------------------------------

export interface X1Build {
  readonly glb: Uint8Array;
  readonly bin: Uint8Array;
  readonly ts: string;
  /** The AnmD tracks, for the sim (packages/sim/src/x1Tracks.generated.ts). */
  readonly simTs: string;
}

/** The track table's shape in tracks.json (`parts.<part>.tracks`). */
interface RawTrack {
  readonly track: number;
  readonly from: number;
  readonly to: number;
  readonly mode: number;
  readonly end: number;
  readonly link: number;
  readonly link_b: number;
  readonly link_c: number;
  readonly flags: number;
  readonly period: number;
  readonly event: { readonly frame: number; readonly code: number } | null;
}

export async function buildX1(): Promise<X1Build> {
  const io = new NodeIO();
  const [legs, cockpit, gun, beacon] = await Promise.all(PART_FILES.map((f) => readPart(io, f)));
  const channels = JSON.parse(readFileSync(join(X1_RAW_DIR, "channels.json"), "utf8")) as Channels;
  if (legs.world[0]?.length !== 8) throw new Error("the legs should have 8 joints");
  if (cockpit.world[0]?.length !== 7) throw new Error("the cockpit should have 7 joints");
  if (channels.legs.frames !== legs.frames || channels.cockpit.frames !== cockpit.frames)
    throw new Error("channels.json and the clips disagree on the frame counts");

  // The bone table: legs rows, then cockpit rows.
  const legBones = legs.world[0].length;
  const width = Math.max(legBones * TEXELS_PER_MATRIX + 1, COCKPIT_SLOTS * TEXELS_PER_MATRIX);
  const mountTexel = legBones * TEXELS_PER_MATRIX;
  const height = legs.frames + cockpit.frames;
  const data = new Float32Array(width * height * 4);
  const put = (row: number, texel: number, m: M4): void => {
    for (let r = 0; r < 3; r++) {
      const o = (row * width + texel + r) * 4;
      data[o] = m[r];
      data[o + 1] = m[4 + r];
      data[o + 2] = m[8 + r];
      data[o + 3] = m[12 + r];
    }
  };
  for (let f = 0; f < legs.frames; f++) {
    for (let j = 0; j < legBones; j++) {
      put(f, j * TEXELS_PER_MATRIX, multiply(legs.world[f][j], legs.inverseBind[j]));
    }
    const mount = channelPos(channels.legs, MOUNT_POINT, f);
    const o = (f * width + mountTexel) * 4;
    data[o] = mount[0];
    data[o + 1] = mount[1];
    data[o + 2] = mount[2];
    data[o + 3] = 1;
  }
  for (let f = 0; f < cockpit.frames; f++) {
    const row = legs.frames + f;
    const joints = cockpit.world[f].length;
    for (let j = 0; j < joints; j++) {
      put(row, j * TEXELS_PER_MATRIX, multiply(cockpit.world[f][j], cockpit.inverseBind[j]));
    }
    GUN_RECORDS.forEach((record, i) => {
      put(row, (joints + i) * TEXELS_PER_MATRIX, cockpit.world[f][record]);
    });
    const beaconSlot = joints + GUN_RECORDS.length;
    put(
      row,
      beaconSlot * TEXELS_PER_MATRIX,
      translation(channelPos(channels.cockpit, BEACON_POINT, f)),
    );
  }

  // One primitive: each vertex names its matrix slot (legs joints 0-7, cockpit
  // joints 8-14, the guns 15 and 16, the beacon 17) and whether the team's
  // texture offset applies (not on the beacon: player_partner.c 319-320).
  const cockpitSlot = legBones;
  const parts: { part: Part; slot: (v: number) => number; team: number }[] = [
    { part: legs, slot: (v) => legs.joint[v], team: 1 },
    { part: cockpit, slot: (v) => cockpitSlot + cockpit.joint[v], team: 1 },
    { part: gun, slot: () => cockpitSlot + 7, team: 1 },
    { part: gun, slot: () => cockpitSlot + 8, team: 1 },
    { part: beacon, slot: () => cockpitSlot + 9, team: 0 },
  ];
  const total = parts.reduce((n, p) => n + p.part.count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const slotAttr = new Float32Array(total);
  const teamUv = new Float32Array(total);
  let at = 0;
  for (const { part, slot, team } of parts) {
    position.set(part.position, at * 3);
    normal.set(part.normal, at * 3);
    uv.set(part.uv, at * 2);
    for (let v = 0; v < part.count; v++) {
      slotAttr[at + v] = slot(v);
      teamUv[at + v] = team;
    }
    at += part.count;
  }

  // Every part embeds the same page; the mesh carries it once.
  const image = legs.image;
  if (!image) throw new Error("x1_legs.glb has no texture page");
  for (const p of [cockpit, gun, beacon]) {
    if (!p.image || Buffer.compare(Buffer.from(p.image), Buffer.from(image)) !== 0)
      throw new Error("the parts embed different texture pages");
  }

  const doc = new Document();
  doc.getRoot().getAsset().generator = "amigo-metropolis gen:x1";
  const buffer = doc.createBuffer();
  const accessor = (
    name: string,
    type: "VEC3" | "VEC2" | "SCALAR",
    array: Float32Array<ArrayBuffer>,
  ) => doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);
  const texture = doc.createTexture("tex09").setImage(image).setMimeType("image/png");
  const material = doc
    .createMaterial("x1")
    .setBaseColorTexture(texture)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);
  material
    .getBaseColorTextureInfo()
    ?.setMagFilter(9728)
    .setMinFilter(9728)
    .setWrapS(10497)
    .setWrapT(10497);
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute("POSITION", accessor("POSITION", "VEC3", position))
    .setAttribute("NORMAL", accessor("NORMAL", "VEC3", normal))
    .setAttribute("TEXCOORD_0", accessor("TEXCOORD_0", "VEC2", uv))
    .setAttribute("_X1BONE", accessor("_X1BONE", "SCALAR", slotAttr))
    .setAttribute("_TEAMUV", accessor("_TEAMUV", "SCALAR", teamUv));
  const mesh = doc.createMesh("x1").addPrimitive(prim);
  const node = doc.createNode("x1").setMesh(mesh);
  doc.createScene("x1").addChild(node);
  const glb = await io.writeBinary(doc);

  const tracksJson = JSON.parse(readFileSync(join(X1_RAW_DIR, "tracks.json"), "utf8")) as {
    parts: Record<string, { tracks: RawTrack[] }>;
  };
  const legTracks = tracksJson.parts.legs.tracks;
  const cockpitTracks = tracksJson.parts.cockpit.tracks;
  for (const t of [...legTracks, ...cockpitTracks]) {
    // JITTER and RANDOM_LINK (block.c 300-318) draw on the game's own stream; no
    // shipped track sets them, and the sim's AnmD player (walker.ts) leaves them out.
    if ((t.flags & 0x60) !== 0) throw new Error(`track ${t.track} sets flag 0x20 / 0x40`);
  }

  const sources = [...PART_FILES, "tracks.json", "channels.json"].map((f) => {
    const sha = createHash("sha256")
      .update(readFileSync(join(X1_RAW_DIR, f)))
      .digest("hex");
    return `//   ${f} ${sha.slice(0, 16)}`;
  });
  const row = (t: RawTrack): string =>
    `  [${t.from}, ${t.to}, ${t.mode}, ${t.end}, ${t.link}, ${t.link_b}, ${t.link_c}, ${t.flags}, ${t.period}, ${t.event ? (t.event.code << 10) | t.event.frame : 0}],`;
  const ts = [
    "// Generated by `bun run gen:x1` (tools/generators/fcopX1.ts). Do not edit.",
    "//",
    "// The X1-Alpha's bone table (public/models/units/avatar-x1.anim.bin): its",
    "// layout. The AnmD tracks that pick the frames are the sim's",
    "// (packages/sim/src/x1Tracks.generated.ts). From:",
    ...sources,
    "",
    "/** Frames of the legs' timeline, and the cockpit's. */",
    `export const X1_LEGS_FRAMES = ${legs.frames};`,
    `export const X1_COCKPIT_FRAMES = ${cockpit.frames};`,
    "/** The bone table: RGBA float texels, three per 3x4 matrix (its rows). */",
    `export const X1_ANIM_WIDTH = ${width};`,
    `export const X1_ANIM_HEIGHT = ${height};`,
    "/** The first cockpit row: legs frame f is row f, cockpit frame f row X1_COCKPIT_ROW + f. */",
    `export const X1_COCKPIT_ROW = ${legs.frames};`,
    "/** The texel of a legs row that holds the cockpit's mount (3DHS channel 0). */",
    `export const X1_MOUNT_TEXEL = ${mountTexel};`,
    "/** Vertex slots below this follow the legs; from it on they ride the cockpit. */",
    `export const X1_COCKPIT_SLOT = ${cockpitSlot};`,
    "/** Matrix slots in all: legs joints, cockpit joints, two guns, the beacon. */",
    `export const X1_SLOTS = ${cockpitSlot + COCKPIT_SLOTS};`,
    "",
  ].join("\n");
  const trackSource = sources.filter((line) => line.includes("tracks.json"));
  const simTs = [
    "// Generated by `bun run gen:x1` (tools/generators/fcopX1.ts). Do not edit.",
    "//",
    "// The X1-Alpha's AnmD tracks, as the RE reads them (extracted/x1/tracks.json;",
    "// RE extracted/findings/anmd_tracks.md, src/game/actor/block.c): the legs'",
    "// and the cockpit's, which the walker's state machine and the transform's",
    "// ramp step (walker.ts, fcop-fidelity.md G11, P4). From:",
    ...trackSource,
    "",
    "/**",
    " * One AnmD track (block.c `anmd_track`): from, to, mode, end action, the three",
    " * links, flags, period (the caller's delta units a frame) and the packed event",
    " * (code << 10 | frame, 0 for none).",
    " */",
    "export type X1Track = readonly [",
    "  from: number,",
    "  to: number,",
    "  mode: number,",
    "  end: number,",
    "  link: number,",
    "  linkB: number,",
    "  linkC: number,",
    "  flags: number,",
    "  period: number,",
    "  event: number,",
    "];",
    "",
    "/** The legs' 62 tracks (Cobj 15 in Mp), by index. */",
    "export const X1_LEG_TRACKS: readonly X1Track[] = [",
    ...legTracks.map(row),
    "];",
    "",
    "/** The cockpit's tracks (Cobj 16): 0 the walker's hold, 1 the hover's, 2 the transform. */",
    "export const X1_COCKPIT_TRACKS: readonly X1Track[] = [",
    ...cockpitTracks.map(row),
    "];",
    "",
  ].join("\n");

  return {
    glb,
    bin: new Uint8Array(data.buffer),
    ts: biomeFormat(ts, X1_OUT_TS),
    simTs: biomeFormat(simTs, X1_OUT_SIM_TS),
  };
}

/** The table as the formatter writes it, so a re-run and `--check` agree with lint. */
function biomeFormat(text: string, path: string): string {
  const fmt = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${path}`], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(text),
  });
  if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
  return fmt.stdout.toString();
}

// --- the import -----------------------------------------------------------------

/** A Future Cop mission container's 0x6000-byte write block (RE tools/gfx/fcop.py). */
const BLOCK = 0x6000;

function isAlpha(b: Uint8Array, at: number): boolean {
  for (let k = 0; k < 4; k++) {
    const c = b[at + k];
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return false;
  }
  return true;
}

function tagAt(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

/** One resource's payload: its RDHS header SHOC, then its TADS fragments (fcop.py parse / extract). */
function containerResource(b: Uint8Array, type: string, id: number): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const rev = type.split("").reverse().join("");
  let pos = 0;
  let found = -1;
  let header = 0;
  let total = 0;
  while (pos < b.length) {
    const rem = BLOCK - (pos % BLOCK);
    if (rem < 8 || pos + 8 > b.length) {
      pos += rem;
      continue;
    }
    const size = view.getUint32(pos + 4, true);
    if (size < 8 || size > rem || !isAlpha(b, pos)) {
      pos += rem;
      continue;
    }
    if (found < 0) {
      if (
        tagAt(b, pos) === "COHS" &&
        tagAt(b, pos + 16) === "RDHS" &&
        tagAt(b, pos + 24) === rev &&
        view.getUint32(pos + 28, true) === id
      ) {
        found = pos;
        header = size;
        total = view.getUint32(pos + 32, true);
        pos += size;
        break;
      }
    }
    pos += size;
  }
  if (found < 0) throw new Error(`no ${type} ${id} in the container`);
  const out = new Uint8Array(total);
  let n = 0;
  pos = found + header;
  while (pos < b.length && n < total) {
    const rem = BLOCK - (pos % BLOCK);
    if (rem < 8 || pos + 8 > b.length) {
      pos += rem;
      continue;
    }
    const size = view.getUint32(pos + 4, true);
    if (size < 8 || size > rem || !isAlpha(b, pos)) {
      pos += rem;
      continue;
    }
    if (tagAt(b, pos) === "COHS") {
      const sub = tagAt(b, pos + 16);
      if (sub === "RDHS") break;
      if (sub === "TADS") {
        const frag = b.subarray(pos + 20, pos + size);
        const take = Math.min(frag.length, total - n);
        out.set(frag.subarray(0, take), n);
        n += take;
      }
    }
    pos += size;
  }
  return out;
}

/** A Cobj's 3DHS chunk (obj_mesh.walk_chunks; extract_x1.position_channels). */
function readChannels(
  blob: Uint8Array,
  frames: number,
): { count: number; xyz: [number, number, number][] } {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let pos = 0;
  while (pos + 8 <= blob.length) {
    const tag = tagAt(blob, pos).split("").reverse().join("");
    const size = view.getUint32(pos + 4, true);
    if (size < 8 || pos + size > blob.length) break;
    if (tag === "3DHS") {
      const off = pos + 8;
      const count = view.getUint32(off, true);
      const n = Math.floor((size - 8 - 4) / 8);
      if (n !== count * frames)
        throw new Error(`3DHS holds ${n} records, not ${count} x ${frames}`);
      const xyz: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const at = off + 4 + i * 8;
        xyz.push([
          view.getInt16(at, true),
          view.getInt16(at + 2, true),
          view.getInt16(at + 4, true),
        ]);
      }
      return { count, xyz };
    }
    pos += size;
  }
  throw new Error("no 3DHS chunk");
}

function importRaws(reRepo: string): void {
  const x1 = join(reRepo, "extracted", "x1");
  mkdirSync(X1_RAW_DIR, { recursive: true });
  // The RE's own assembled transform rides along for the test, not the build.
  for (const f of [...PART_FILES, "tracks.json", "x1_alpha_transform.glb"]) {
    copyFileSync(join(x1, f), join(X1_RAW_DIR, f));
  }
  const manifest = JSON.parse(readFileSync(join(x1, "manifest.json"), "utf8")) as {
    parts: {
      role: string;
      sha256: string;
      anim_frames: number;
      cobj_id_by_map: Record<string, number>;
    }[];
  };
  const container = new Uint8Array(readFileSync(join(reRepo, "fixtures", "missions", "Mp")));
  const sets: Record<string, ChannelSet> = {};
  for (const role of CHANNEL_PARTS) {
    const part = manifest.parts.find((p) => p.role === role);
    if (!part) throw new Error(`manifest: no ${role}`);
    const cobj = part.cobj_id_by_map.Mp;
    const blob = containerResource(container, "Cobj", cobj);
    const sha = createHash("sha256").update(blob).digest("hex");
    if (sha !== part.sha256) throw new Error(`Mp Cobj ${cobj} is not the manifest's ${role}`);
    const { count, xyz } = readChannels(blob, part.anim_frames);
    sets[role] = { cobj, sha256: sha, count, frames: part.anim_frames, xyz };
  }
  const channels: Channels = {
    source:
      "fixtures/missions/Mp, Cobj 15 (legs) and 16 (cockpit): the 3DHS chunk, raw int16 (x, y, z) per record; channel i of frame f is record count * f + i (RE tools/gfx/extract_x1.py position_channels)",
    legs: sets.legs,
    cockpit: sets.cockpit,
  };
  const lines = [
    "{",
    `  "source": ${JSON.stringify(channels.source)},`,
    ...CHANNEL_PARTS.map((role, i) => {
      const s = sets[role];
      const xyz = s.xyz.map((v) => `[${v.join(", ")}]`).join(", ");
      return `  "${role}": { "cobj": ${s.cobj}, "sha256": "${s.sha256}", "count": ${s.count}, "frames": ${s.frames}, "xyz": [${xyz}] }${i + 1 < CHANNEL_PARTS.length ? "," : ""}`;
    }),
    "}",
    "",
  ];
  writeFileSync(join(X1_RAW_DIR, "channels.json"), lines.join("\n"));
}

// --- main -------------------------------------------------------------------------

function same(path: string, bytes: Uint8Array | string): boolean {
  if (!existsSync(path)) return false;
  const have = readFileSync(path);
  const want = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return Buffer.compare(have, want) === 0;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  if (process.argv.includes("--import")) {
    importRaws(argOf("re-repo", process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering"));
  }
  const built = await buildX1();
  const outputs: [string, Uint8Array | string][] = [
    [X1_OUT_GLB, built.glb],
    [X1_OUT_BIN, built.bin],
    [X1_OUT_TS, built.ts],
    [X1_OUT_SIM_TS, built.simTs],
  ];
  if (check) {
    const stale = outputs.filter(([p, b]) => !same(p, b)).map(([p]) => p);
    if (stale.length > 0) {
      console.error(`gen:x1 --check: stale ${stale.join(", ")}`);
      process.exit(1);
    }
    console.log("gen:x1: the committed X1 rig matches its raws");
    return;
  }
  for (const [p, b] of outputs) writeFileSync(p, b);
  console.log(
    `gen:x1: avatar-x1.glb ${(built.glb.byteLength / 1024).toFixed(0)} KB, ` +
      `avatar-x1.anim.bin ${(built.bin.byteLength / 1024).toFixed(0)} KB, x1Rig.generated.ts, x1Tracks.generated.ts`,
  );
}

if (import.meta.main) await main();
