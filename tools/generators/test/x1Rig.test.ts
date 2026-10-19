// The X1-Alpha's rig (`bun run gen:x1`, tools/generators/fcopX1.ts): the
// committed mesh and bone table must be what the committed raws build, and
// posed at the original's two spawn poses -- walker legs 0 / cockpit 0, hover
// legs 359 / cockpit 29 (FC:MIT X1Alpha.cpp, RE manifest `poses`) -- they must
// be the RE's own assembled walker and hover, vertex for vertex. That second
// check is what says the assembly is the original's: the cockpit on the legs'
// 3DHS point 0 of the frame, the guns on the cockpit's records 2 and 4, the
// beacon on its point 2.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Node, NodeIO } from "@gltf-transform/core";
import { poseX1Vertex } from "../../../packages/client/src/render/x1Pose";
import {
  X1_ANIM_HEIGHT,
  X1_ANIM_WIDTH,
  X1_COCKPIT_FRAMES,
  X1_LEGS_FRAMES,
  X1_SLOTS,
} from "../../../packages/client/src/render/x1Rig.generated";
import { X1_LEG_TRACKS } from "../../../packages/sim/src/x1Tracks.generated";
import { buildX1, X1_OUT_BIN, X1_OUT_GLB, X1_OUT_SIM_TS, X1_OUT_TS, X1_RAW_DIR } from "../fcopX1";

const io = new NodeIO();
const RAW_FCOP = join(import.meta.dir, "..", "units", "raw", "fcop");

const rig = await (async () => {
  const doc = await io.read(X1_OUT_GLB);
  const prims = doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives());
  const p = prims[0];
  const attr = (name: string) => {
    const a = p.getAttribute(name);
    if (!a) throw new Error(`avatar-x1.glb has no ${name}`);
    return a.getArray() as Float32Array;
  };
  const bin = readFileSync(X1_OUT_BIN);
  return {
    prims: prims.length,
    position: attr("POSITION"),
    slot: attr("_X1BONE"),
    team: attr("_TEAMUV"),
    uv: attr("TEXCOORD_0"),
    table: new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)),
  };
})();

/**
 * The RE's assembly, skinned with its own node pose, part by part: the static
 * walker and hover, or sample `sample` of the transform glb's
 * `transform_to_hover` clip.
 */
async function assembled(path: string, sample = -1): Promise<Map<string, Float32Array>> {
  const doc = await io.read(path);
  const out = new Map<string, Float32Array>();
  const keyed = new Map<Node, { t?: ArrayLike<number>; r?: ArrayLike<number> }>();
  if (sample >= 0) {
    const clip = doc
      .getRoot()
      .listAnimations()
      .find((a) => a.getName() === "transform_to_hover");
    for (const ch of clip?.listChannels() ?? []) {
      const node = ch.getTargetNode();
      const out = ch.getSampler()?.getOutput()?.getArray();
      if (!node || !out) continue;
      const e = keyed.get(node) ?? {};
      if (ch.getTargetPath() === "translation") e.t = out.slice(sample * 3, sample * 3 + 3);
      if (ch.getTargetPath() === "rotation") e.r = out.slice(sample * 4, sample * 4 + 4);
      keyed.set(node, e);
    }
  }
  const localOf = (n: Node): ArrayLike<number> => {
    const k = keyed.get(n);
    if (!k) return n.getMatrix();
    const [x, y, z, w] = (k.r ?? n.getRotation()) as number[];
    const t = (k.t ?? n.getTranslation()) as number[];
    const s = n.getScale();
    return [
      (1 - 2 * (y * y + z * z)) * s[0],
      2 * (x * y + z * w) * s[0],
      2 * (x * z - y * w) * s[0],
      0,
      2 * (x * y - z * w) * s[1],
      (1 - 2 * (x * x + z * z)) * s[1],
      2 * (y * z + x * w) * s[1],
      0,
      2 * (x * z + y * w) * s[2],
      2 * (y * z - x * w) * s[2],
      (1 - 2 * (x * x + y * y)) * s[2],
      0,
      t[0],
      t[1],
      t[2],
      1,
    ];
  };
  const worldOf = (n: Node): Float64Array => {
    const m = localOf(n);
    const parent = n.getParentNode();
    if (!parent) return Float64Array.from(m);
    const p = worldOf(parent);
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) {
        let s = 0;
        for (let j = 0; j < 4; j++) s += p[j * 4 + k] * m[c * 4 + j];
        r[c * 4 + k] = s;
      }
    return r;
  };
  const apply = (
    m: ArrayLike<number>,
    x: number,
    y: number,
    z: number,
    o: Float32Array,
    at: number,
  ) => {
    o[at] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[at + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[at + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  };
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    const n = pos.getCount();
    const res = new Float32Array(n * 3);
    const v: number[] = [];
    const skin = node.getSkin();
    if (skin) {
      const joints = skin.listJoints();
      const ibm = skin.getInverseBindMatrices()?.getArray() as Float32Array;
      const skinMats = joints.map((j, k) => {
        const w = worldOf(j);
        const b = ibm.subarray(k * 16, k * 16 + 16);
        const r = new Float64Array(16);
        for (let c = 0; c < 4; c++)
          for (let row = 0; row < 4; row++) {
            let s = 0;
            for (let q = 0; q < 4; q++) s += w[q * 4 + row] * b[c * 4 + q];
            r[c * 4 + row] = s;
          }
        return r;
      });
      const jo = prim.getAttribute("JOINTS_0");
      const wo = prim.getAttribute("WEIGHTS_0");
      const jv: number[] = [];
      const wv: number[] = [];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        jo?.getElement(i, jv);
        wo?.getElement(i, wv);
        let best = 0;
        for (let k = 1; k < 4; k++) if (wv[k] > wv[best]) best = k;
        apply(skinMats[jv[best]], v[0], v[1], v[2], res, i * 3);
      }
    } else {
      const w = worldOf(node);
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        apply(w, v[0], v[1], v[2], res, i * 3);
      }
    }
    out.set(node.getName(), res);
  }
  return out;
}

const PART_ORDER = [
  "legs_mesh",
  "cockpit_mesh",
  "weapon_0_mesh",
  "weapon_1_mesh",
  "beacon_lights_mesh",
];

async function expectPose(
  path: string,
  legsFrame: number,
  cockpitFrame: number,
  sample = -1,
): Promise<void> {
  const ref = await assembled(path, sample);
  const posed = new Float32Array(3);
  let at = 0;
  for (const name of PART_ORDER) {
    const want = ref.get(name);
    if (!want) throw new Error(`${path}: no ${name}`);
    let worst = 0;
    for (let i = 0; i < want.length / 3; i++, at++) {
      poseX1Vertex(
        rig.table,
        rig.slot[at],
        legsFrame,
        cockpitFrame,
        0,
        0,
        rig.position[at * 3],
        rig.position[at * 3 + 1],
        rig.position[at * 3 + 2],
        posed,
        0,
      );
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(posed[k] - want[i * 3 + k]));
    }
    expect(`${name} ${worst < 1e-5}`).toBe(`${name} true`);
  }
  expect(at).toBe(rig.position.length / 3);
}

describe("the X1's rig", () => {
  test("is what the committed raws build", async () => {
    const built = await buildX1();
    expect(Buffer.compare(Buffer.from(built.glb), readFileSync(X1_OUT_GLB))).toBe(0);
    expect(Buffer.compare(Buffer.from(built.bin), readFileSync(X1_OUT_BIN))).toBe(0);
    expect(built.ts).toBe(readFileSync(X1_OUT_TS, "utf8"));
    expect(built.simTs).toBe(readFileSync(X1_OUT_SIM_TS, "utf8"));
  });

  test("is one primitive over a table of both timelines", () => {
    expect(rig.prims).toBe(1);
    expect(X1_LEGS_FRAMES).toBe(371);
    expect(X1_COCKPIT_FRAMES).toBe(30);
    expect(rig.table.length).toBe(X1_ANIM_WIDTH * X1_ANIM_HEIGHT * 4);
    expect(X1_ANIM_HEIGHT).toBe(X1_LEGS_FRAMES + X1_COCKPIT_FRAMES);
    for (const s of rig.slot) expect(s >= 0 && s < X1_SLOTS && Number.isInteger(s)).toBe(true);
  });

  test("keeps the team's offset off the beacon lights only", () => {
    // The beacon is the last 78 vertices (13 quads), slot 17.
    for (let i = 0; i < rig.slot.length; i++) {
      expect(rig.team[i]).toBe(rig.slot[i] === X1_SLOTS - 1 ? 0 : 1);
    }
  });

  test("stands as the RE's assembled walker at legs 0 / cockpit 0", async () => {
    await expectPose(join(RAW_FCOP, "x1-alpha-walker.glb"), 0, 0);
  });

  test("folds into the RE's assembled hover at legs 359 / cockpit 29", async () => {
    await expectPose(join(RAW_FCOP, "x1-alpha-hover.glb"), 359, 29);
  });

  test("passes through the RE's assembled transform: legs 330 + i with cockpit i", async () => {
    // The RE's transform glb keys both tracks on one 30-sample timeline, the
    // cockpit's frame equal to the legs' offset from 330 -- as the mode-3 ramp
    // has them, both `from + (to - from) * progress >> 16` over 29 frames.
    const file = join(X1_RAW_DIR, "x1_alpha_transform.glb");
    for (const i of [0, 7, 14, 21, 29]) await expectPose(file, 330 + i, i, i);
  });

  test("hands the sim the legs' 62 AnmD tracks, the transform's at 0x0c", () => {
    expect(X1_LEG_TRACKS.length).toBe(62);
    // Track 0x0c: frames 330 -> 359, mode 3 (frame = from + (to - from) * progress >> 16).
    expect(X1_LEG_TRACKS[0x0c].slice(0, 3)).toEqual([330, 359, 3]);
    // Track 0x0d: the hover's hold at 359.
    expect(X1_LEG_TRACKS[0x0d].slice(0, 3)).toEqual([359, 359, 0]);
    const raw = JSON.parse(readFileSync(join(X1_RAW_DIR, "tracks.json"), "utf8")) as {
      parts: { legs: { tracks: { period: number; flags: number; link: number }[] } };
    };
    raw.parts.legs.tracks.forEach((t, i) => {
      expect(X1_LEG_TRACKS[i][8]).toBe(t.period);
      expect(X1_LEG_TRACKS[i][7]).toBe(t.flags);
      expect(X1_LEG_TRACKS[i][4]).toBe(t.link);
    });
  });
});
