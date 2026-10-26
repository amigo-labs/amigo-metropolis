// The X1-Alpha's rig (`bun run gen:x1`, tools/generators/fcopX1.ts): the
// committed mesh and bone table must be what the committed raws build, and
// posed at the original's two spawn poses -- walker legs 0 / cockpit 0, hover
// legs 359 / cockpit 29 (FC:MIT X1Alpha.cpp, RE manifest `poses`) -- they must
// be the RE's own assembled walker and hover, vertex for vertex, face draw
// mode by mode and layer by layer. That second check is what says the
// assembly is the original's: the cockpit on the legs' 3DHS point 0 of the
// frame, the guns on the cockpit's records 2 and 4, the beacon on its point 2;
// and the RE's walker and hover keep only the faces the partner's layer masks
// let through in that form (RE x1-alpha.md "Draw modes and layers"), which
// must be the faces the rig's masks show.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Node, NodeIO } from "@gltf-transform/core";
import { poseX1Vertex } from "../../../packages/client/src/render/x1Pose";
import {
  X1_ANIM_HEIGHT,
  X1_ANIM_WIDTH,
  X1_ATTACHED_LAYER_MASK,
  X1_COCKPIT_FRAMES,
  X1_COCKPIT_LAYER_MASKS,
  X1_COCKPIT_SLOT,
  X1_GUN_SLOT,
  X1_LEGS_FRAMES,
  X1_LEGS_LAYER_MASKS,
  X1_SLOTS,
} from "../../../packages/client/src/render/x1Rig.generated";
import {
  X1_FORM_HOVER,
  X1_FORM_RAMP,
  X1_FORM_WALKER,
} from "../../../packages/client/src/render/x1Walk";
import { X1_LEG_TRACKS } from "../../../packages/sim/src/x1Tracks.generated";
import { buildX1, X1_OUT_BIN, X1_OUT_GLB, X1_OUT_SIM_TS, X1_OUT_TS, X1_RAW_DIR } from "../fcopX1";

const io = new NodeIO();

/** The output's primitives' modes, in order. */
const RIG_MODES = ["opaque", "half"];

const rig = await (async () => {
  const doc = await io.read(X1_OUT_GLB);
  const prims = doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives());
  const attr = (name: string) => {
    const out: number[] = [];
    for (const p of prims) {
      const a = p.getAttribute(name);
      if (!a) throw new Error(`avatar-x1.glb has no ${name}`);
      out.push(...(a.getArray() as Float32Array));
    }
    return Float32Array.from(out);
  };
  const mode: string[] = [];
  for (const p of prims) {
    const m =
      (p.getMaterial()?.getExtras() as { fcop?: { mode?: string } } | undefined)?.fcop?.mode ?? "";
    for (let i = 0; i < (p.getAttribute("POSITION")?.getCount() ?? 0); i++) mode.push(m);
  }
  const bin = readFileSync(X1_OUT_BIN);
  return {
    prims: prims.map(
      (p) => (p.getMaterial()?.getExtras() as { fcop?: { mode?: string } } | undefined)?.fcop,
    ),
    position: attr("POSITION"),
    slot: attr("_X1BONE"),
    face: attr("_X1FACE"),
    team: attr("_TEAMUV"),
    layer: attr("_X1LAYER"),
    uv: attr("TEXCOORD_0"),
    mode,
    table: new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)),
  };
})();

/** The RE assembly's mesh node a rig slot's vertex belongs to. */
function partOf(slot: number): string {
  if (slot < X1_COCKPIT_SLOT) return "legs_mesh";
  if (slot < X1_GUN_SLOT) return "cockpit_mesh";
  if (slot === X1_GUN_SLOT) return "weapon_0_mesh";
  if (slot === X1_GUN_SLOT + 1) return "weapon_1_mesh";
  return "beacon_lights_mesh";
}

/** The layer mask a part is drawn with in a draw form. */
function maskOf(part: string, form: number): number {
  if (part === "legs_mesh") return X1_LEGS_LAYER_MASKS[form];
  if (part === "cockpit_mesh") return X1_COCKPIT_LAYER_MASKS[form];
  return X1_ATTACHED_LAYER_MASK;
}

/** `part/mode/layer`: how the RE's assembly and the rig are both cut up here. */
const keyOf = (part: string, mode: string, layer: number) => `${part}/${mode}/${layer}`;

/**
 * The RE's assembly, skinned with its own node pose, by part and by each
 * primitive's draw mode and layer: the static walker and hover, or sample
 * `sample` of the transform glb's `transform_to_hover` clip.
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
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const fcop = (
        prim.getMaterial()?.getExtras() as { fcop?: { mode?: string; layer?: number } } | undefined
      )?.fcop;
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
      const key = keyOf(node.getName(), fcop?.mode ?? "", fcop?.layer ?? 0);
      if (out.has(key)) throw new Error(`${path}: two primitives ${key}`);
      out.set(key, res);
    }
  }
  return out;
}

/**
 * The rig posed at (legs, cockpit) against the RE's assembly in `form`: every
 * part, mode and layer the RE keeps vertex for vertex, and none it drops --
 * which must be exactly the faces the rig's masks hide in that form.
 */
async function expectPose(
  path: string,
  legsFrame: number,
  cockpitFrame: number,
  form: number,
  sample = -1,
): Promise<void> {
  const ref = await assembled(path, sample);
  const posed = new Float32Array(3);
  const mine = new Map<string, number[]>();
  for (let at = 0; at < rig.slot.length; at++) {
    const part = partOf(rig.slot[at]);
    const key = keyOf(part, rig.mode[at], rig.layer[at]);
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
    const list = mine.get(key) ?? [];
    list.push(posed[0], posed[1], posed[2]);
    mine.set(key, list);
  }
  const shown = [...mine.keys()]
    .filter((key) => {
      const [part, , layer] = key.split("/");
      return ((maskOf(part, form) >> Number(layer)) & 1) === 1;
    })
    .sort();
  expect([...ref.keys()].sort()).toEqual(shown);
  for (const key of shown) {
    const want = ref.get(key) as Float32Array;
    const got = mine.get(key) as number[];
    expect(`${key} ${got.length}`).toBe(`${key} ${want.length}`);
    let worst = 0;
    for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
    expect(`${key} ${worst < 1e-5}`).toBe(`${key} true`);
  }
}

describe("the X1's rig", () => {
  test("is what the committed raws build", async () => {
    const built = await buildX1();
    expect(Buffer.compare(Buffer.from(built.glb), readFileSync(X1_OUT_GLB))).toBe(0);
    expect(Buffer.compare(Buffer.from(built.bin), readFileSync(X1_OUT_BIN))).toBe(0);
    expect(built.ts).toBe(readFileSync(X1_OUT_TS, "utf8"));
    expect(built.simTs).toBe(readFileSync(X1_OUT_SIM_TS, "utf8"));
  });

  test("is a primitive per draw mode over a table of both timelines", () => {
    expect(rig.prims).toEqual(RIG_MODES.map((mode) => ({ mode })));
    expect(X1_LEGS_FRAMES).toBe(371);
    expect(X1_COCKPIT_FRAMES).toBe(30);
    expect(rig.table.length).toBe(X1_ANIM_WIDTH * X1_ANIM_HEIGHT * 4);
    expect(X1_ANIM_HEIGHT).toBe(X1_LEGS_FRAMES + X1_COCKPIT_FRAMES);
    for (const s of rig.slot) expect(s >= 0 && s < X1_SLOTS && Number.isInteger(s)).toBe(true);
    for (const l of rig.layer) expect(l === 0 || l === 1).toBe(true);
  });

  test("keeps the team's offset off the beacon lights only", () => {
    // The beacon is 78 vertices (13 quads), slot 17.
    let beacon = 0;
    for (let i = 0; i < rig.slot.length; i++) {
      expect(rig.team[i]).toBe(rig.slot[i] === X1_SLOTS - 1 ? 0 : 1);
      beacon += +(rig.slot[i] === X1_SLOTS - 1);
    }
    expect(beacon).toBe(78);
  });

  test("stands as the RE's assembled walker at legs 0 / cockpit 0", async () => {
    await expectPose(join(X1_RAW_DIR, "x1_alpha.glb"), 0, 0, X1_FORM_WALKER);
  });

  test("folds into the RE's assembled hover at legs 359 / cockpit 29", async () => {
    await expectPose(join(X1_RAW_DIR, "x1_alpha_hover.glb"), 359, 29, X1_FORM_HOVER);
  });

  test("passes through the RE's assembled transform: legs 330 + i with cockpit i", async () => {
    // The RE's transform glb keys both tracks on one 30-sample timeline, the
    // cockpit's frame equal to the legs' offset from 330 -- as the mode-3 ramp
    // has them, both `from + (to - from) * progress >> 16` over 29 frames. It
    // keeps every face, as the ramp's masks show every one.
    const file = join(X1_RAW_DIR, "x1_alpha_transform.glb");
    for (const i of [0, 7, 14, 21, 29]) await expectPose(file, 330 + i, i, X1_FORM_RAMP, i);
  });

  test("names every triangle's face: a quad's two halves one after the other", () => {
    // faces.json's 3DQL per part (legs, cockpit, the gun twice, the beacon):
    // each face once, in one mode's primitive, two triangles for a quad (arm 4)
    // and one for a triangle (arms 1-3), its id the part's place x 1024 + index.
    const raw = JSON.parse(readFileSync(join(X1_RAW_DIR, "faces.json"), "utf8")) as {
      parts: Record<string, { prims: number[][] }>;
    };
    const order = ["legs", "cockpit", "weapon", "weapon", "beacon_lights"];
    const want = new Map<number, number>();
    order.forEach((role, i) => {
      raw.parts[role].prims.forEach(([arm], k) => {
        if (arm === 4) want.set(i * 1024 + k, 2);
        else if (arm >= 1 && arm <= 3) want.set(i * 1024 + k, 1);
      });
    });
    const got = new Map<number, number>();
    const tris = rig.face.length / 3;
    let last = -1;
    for (let t = 0; t < tris; t++) {
      const f = rig.face[t * 3];
      expect(rig.face[t * 3 + 1]).toBe(f);
      expect(rig.face[t * 3 + 2]).toBe(f);
      // A face's triangles are consecutive: an id seen before is the last one.
      if (got.has(f)) expect(f).toBe(last);
      got.set(f, (got.get(f) ?? 0) + 1);
      last = f;
    }
    expect([...got.entries()].sort((a, b) => a[0] - b[0])).toEqual(
      [...want.entries()].sort((a, b) => a[0] - b[0]),
    );
    // The cockpit, the shatter's model: 43 quads and 40 triangles, 126 triangles.
    const cockpit = [...got.entries()].filter(([f]) => f >= 1024 && f < 2048);
    expect(cockpit.filter(([, n]) => n === 2).length).toBe(43);
    expect(cockpit.filter(([, n]) => n === 1).length).toBe(40);
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
