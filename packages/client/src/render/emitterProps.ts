// The type-96 Props (fcop-fidelity.md G13): the scenery the original builds not
// as actors but as permanent sound emitters around a model (RE snd/emitter.c:
// `cact_load_type96` 0x0042fc80 -> `snd_emit_build` 0x0042f6c0), drawn by
// `snd_emit_draw_block` (0x0042fe20) every frame they are in view. Each arena's
// own Cobjs (public/models/props/<mapId>/, the type-11 scenery's folder), stood
// where render/arenaScenery.generated.ts `props` says, which gen:scenery reads
// out of the mission's records:
//
// - the orientation is `math_matrix_from_angles(yaw, pitch, roll)` = Mz Mx My
//   (row-vector, fcop/matrix.h), its rows scaled by the record's three bytes /
//   64 — the model's own axes scaled before it is turned. A negative angle was a
//   random one, drawn by gen:scenery from `game_rand` (a stand-in seed);
// - a Prop with a spin turns every frame instead: `clock * spin` (12-bit), or
//   with a swing a triangle wave of that amplitude about `park`, as `My` alone
//   — the build flattened the orientation's y row and column for it and the
//   frame writes the four words of a yaw, so a spinning Prop is unscaled;
// - a Prop with a rate steps its model's frames, looping or there and back,
//   one per `period` engine ticks (1/300 s) on the clock from the arena's load
//   — through the mesh's morph texture, a row per instance, as the flags'
//   cloth is (render/props.ts).
//
// The model turns as every record angle does (render/recordYaw.ts): the game's
// frame through the actors frame's swap of x and z, the RE's glb the Cobj with
// its x negated; the two mirrors cancel. One InstancedMesh per model, an
// instance per record; the per-frame work writes only the spinning instances'
// matrices and the frames that changed, and allocates nothing.
//
// Not modelled: the sound a Prop plays where it stands (`sound`, the table-A
// script `snd_emit_voice_follow` queues; the audio's); the draw only within the
// viewer's 5x5 block of cells (Metropolis draws the arena whole); the facers
// (stars, billboards) facing the camera — they draw as the RE exports them.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ArenaScenery, SceneryProp } from "./arenaScenery.generated";
import { disposeSubtree } from "./meshMap";
import { mergePropAsset } from "./propAsset";
import { RECORD_TURN, recordTurn } from "./recordYaw";

const loader = new GLTFLoader();
const UP = new THREE.Vector3(0, 1, 0);
const SCALE_ONE = 64;

/** The RE's single-angle matrices, rows: My, Mx, Mz (fcop/matrix.h). */
function my(a: number): number[][] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, 0, -s],
    [0, 1, 0],
    [s, 0, c],
  ];
}
function mx(b: number): number[][] {
  const c = Math.cos(b);
  const s = Math.sin(b);
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c],
  ];
}
function mz(g: number): number[][] {
  const c = Math.cos(g);
  const s = Math.sin(g);
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
}
function mul(a: number[][], b: number[][]): number[][] {
  return [0, 1, 2].map((r) =>
    [0, 1, 2].map((c) => a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c]),
  );
}

/** 4096ths of a turn to radians. */
function rad(raw: number): number {
  return (raw * 2 * Math.PI) / RECORD_TURN;
}

/**
 * `math_matrix_from_angles(yaw, pitch, roll)` with its rows scaled: the
 * orientation `snd_emit_build` leaves, row r the image of the model's axis r
 * in the game's frame.
 */
export function emitterOrientation(p: SceneryProp): number[][] {
  const m = mul(mul(mz(rad(p.roll)), mx(rad(p.pitch))), my(rad(p.yaw)));
  return m.map((row, r) => row.map((e) => (e * p.scale[r]) / SCALE_ONE));
}

/**
 * The instance matrix of a Prop that does not spin: the glb's axis k (the
 * Cobj's, x negated) goes through the orientation's row k into the game's
 * frame, and the game's (x, y, z) is three's (z, y, x).
 */
export function emitterMatrix(p: SceneryProp, out: THREE.Matrix4): THREE.Matrix4 {
  const m = emitterOrientation(p);
  // Column k of the three-space matrix: S(sign_k * row k).
  const col = [0, 1, 2].map((k) => {
    const sign = k === 0 ? -1 : 1;
    return [sign * m[k][2], sign * m[k][1], sign * m[k][0]];
  });
  return out.set(
    col[0][0],
    col[1][0],
    col[2][0],
    p.x,
    col[0][1],
    col[1][1],
    col[2][1],
    p.h,
    col[0][2],
    col[1][2],
    col[2][2],
    p.y,
    0,
    0,
    0,
    1,
  );
}

/**
 * The yaw a spinning Prop stands at `now` engine ticks from the arena's load
 * (`snd_emit_draw_block`'s turn, snd/emitter.c 0x0042ff25..0x0042ffa8): the
 * spin's angle, or with a swing the triangle wave about `park` it drives.
 * 12-bit, as the matrix takes it.
 */
export function emitterYaw(spin: number, swing: number, park: number, now: number): number {
  let angle: number;
  if (spin > 0) {
    angle = (now * spin) % 0x1000;
  } else {
    // `0xfff - ((-(clock * spin)) & 0xfff)` on the clock's low twelve bits:
    // one unit short of the mirror, as retail spells it.
    angle = 0xfff - ((((now & 0xfff) * -spin) >>> 0) & 0xfff);
  }
  if (swing !== 0) {
    const phase = Math.trunc((angle * swing * 2) / 4096);
    const half = swing >> 1;
    let s: number;
    if (phase > swing) {
      const past = phase - swing;
      s = past <= half ? past : swing - past;
    } else {
      s = phase <= half ? phase : swing - phase;
      s = -s;
    }
    angle = park + s * 2;
  }
  return angle & 0xfff;
}

/**
 * The frame a Prop's model shows at `now` engine ticks (`emit_step_frame`'s
 * two clock arms): looping, or there and back over its frames.
 */
export function emitterFrame(p: SceneryProp, frames: number, now: number): number {
  if (p.anim === "none" || p.period <= 0 || frames <= 1) return 0;
  if (p.anim === "loop") return Math.floor((now % (frames * p.period)) / p.period);
  const i = Math.floor((now % ((frames - 1) * p.period * 2)) / p.period);
  return i < frames ? i : 2 * frames - i - 2;
}

interface EmitterMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly props: readonly SceneryProp[];
  readonly frames: number;
  /** The instances that turn every frame. */
  readonly spinning: Int16Array;
  /** The morph texture and the frame each instance shows (-1 unwritten). */
  readonly morph: {
    readonly texture: THREE.DataTexture;
    readonly len: number;
    readonly shown: Int16Array;
  } | null;
}

let meshes: EmitterMesh[] = [];
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const UNIT = new THREE.Vector3(1, 1, 1);

/** The arena's Prop models, an InstancedMesh each as its .glb arrives. */
export function loadEmitters(
  scenery: ArenaScenery,
  group: THREE.Object3D,
  url: (cobj: number) => string,
  cancelled?: () => boolean,
): void {
  meshes = [];
  const byModel = new Map<number, SceneryProp[]>();
  for (const p of scenery.props) {
    if (!scenery.propModels[p.cobj]?.drawn) continue;
    const list = byModel.get(p.cobj);
    if (list) list.push(p);
    else byModel.set(p.cobj, [p]);
  }
  for (const [cobj, props] of byModel) {
    const at = url(cobj);
    loader.loadAsync(at).then(
      (gltf) => {
        if (cancelled?.()) {
          disposeSubtree(gltf.scene);
          return;
        }
        const asset = mergePropAsset(gltf, at, "props");
        if (!asset) return;
        const material = new THREE.MeshStandardMaterial({
          flatShading: true,
          vertexColors: asset.geometry.hasAttribute("color"),
          map: asset.atlas,
        });
        const mesh = new THREE.InstancedMesh(asset.geometry, material, props.length);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        const spinning: number[] = [];
        props.forEach((p, i) => {
          if (p.spin !== 0) spinning.push(i);
          mesh.setMatrixAt(i, emitterMatrix(p, scratchMatrix));
        });
        mesh.instanceMatrix.needsUpdate = true;
        const frames = scenery.propModels[cobj]?.frames ?? 1;
        const targets = asset.geometry.morphAttributes.position?.length ?? 0;
        let morph: EmitterMesh["morph"] = null;
        if (props.some((p) => p.anim !== "none")) {
          if (targets === frames - 1) {
            const len = targets + 1;
            const texture = new THREE.DataTexture(
              new Float32Array(len * props.length),
              len,
              props.length,
              THREE.RedFormat,
              THREE.FloatType,
            );
            texture.needsUpdate = true;
            mesh.morphTexture = texture;
            morph = { texture, len, shown: new Int16Array(props.length).fill(-1) };
          } else {
            console.warn(`[props] ${at}: ${targets} morph targets for ${frames} frames`);
          }
        }
        group.add(mesh);
        meshes.push({ mesh, props, frames, spinning: Int16Array.from(spinning), morph });
        // A model that arrives late stands at the clock it arrives on.
        updateEmitters(lastNow);
      },
      () => {
        console.warn(`[props] no prop asset at ${at}, skipping`);
      },
    );
  }
}

let lastNow = 0;

/** Per frame: `now` engine ticks since the arena's load. Turns and steps. */
export function updateEmitters(now: number): void {
  lastNow = now;
  for (let m = 0; m < meshes.length; m++) {
    const em = meshes[m];
    const spinning = em.spinning;
    for (let k = 0; k < spinning.length; k++) {
      const i = spinning[k];
      const p = em.props[i];
      scratchPosition.set(p.x, p.h, p.y);
      scratchQuat.setFromAxisAngle(UP, recordTurn(emitterYaw(p.spin, p.swing, p.park, now)));
      em.mesh.setMatrixAt(i, scratchMatrix.compose(scratchPosition, scratchQuat, UNIT));
    }
    if (spinning.length > 0) em.mesh.instanceMatrix.needsUpdate = true;
    const morph = em.morph;
    if (morph) {
      const a = morph.texture.image.data as Float32Array;
      let dirty = false;
      for (let i = 0; i < em.props.length; i++) {
        const frame = emitterFrame(em.props[i], em.frames, now);
        if (morph.shown[i] === frame) continue;
        morph.shown[i] = frame;
        // Frame k + 1 is target k at weight 1 (gen:units); the base counts in full.
        const row = i * morph.len;
        a[row] = 1;
        for (let k = 1; k < morph.len; k++) a[row + k] = k === frame ? 1 : 0;
        dirty = true;
      }
      if (dirty) morph.texture.needsUpdate = true;
    }
  }
}
