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
// Only the Props hung in the viewer's 5 x 5 block of cells are drawn
// (`setEmitterWindow`, render/drawWindow.ts): the others stand at a zero
// matrix until the block reaches them. A Prop hangs in the cell of its box's
// placed centre (`snd_emit_build` 0x0042f942..0x0042fa88), not its origin:
// Hk's lamps (61 / 62) reach 4 m out from their poles (`emitterCentre`).
// The sound a Prop plays is the audio's (audio/cues.ts).
//
// The camera-facing facers (stars, billboards, lines) of a model draw from its
// records on the instance's matrix and frame (render/facers.ts), a model of
// facers only included.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ArenaScenery, SceneryProp } from "./arenaScenery.generated";
import { cellXOf, cellZOf, type DrawWindow, inDrawWindow } from "./drawWindow";
import { parseFacers, registerFacers } from "./facers";
import { faceMaterials, mergeFcopModel } from "./fcopModel";
import { disposeSubtree } from "./meshMap";
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
 * Where `snd_emit_build` hangs Prop `p` (0x0042f942..0x0042fa88): its model's
 * box centre (`centre`, the glb's frame) through the orientation the build
 * left — for a spinning Prop the y row and column flattened first
 * (0x0042f92b..0x0042f93b) — plus the origin. Into `out`: the sim frame's x, y.
 */
export function emitterCentre(
  p: SceneryProp,
  centre: readonly [number, number, number],
  out: Float32Array,
): Float32Array {
  const m = emitterOrientation(p);
  if (p.spin !== 0) {
    m[1] = [0, 1, 0];
    m[0][1] = 0;
    m[2][1] = 0;
  }
  // The Cobj's x is the glb's negated; the game's (x, z) is the sim's (y, x).
  const cx = -centre[0];
  const cy = centre[1];
  const cz = centre[2];
  out[0] = p.x + cx * m[0][2] + cy * m[1][2] + cz * m[2][2];
  out[1] = p.y + cx * m[0][0] + cy * m[1][0] + cz * m[2][0];
  return out;
}

/**
 * Where the Prop that stands at sim (x, y) and plays `sound` hangs (its box's
 * placed centre), into `out`; (x, y) itself when `scenery` has no such Prop.
 * For the audio's emitter table, which lists the Props that sound by origin.
 */
export function emitterHungAt(
  scenery: ArenaScenery | null,
  x: number,
  y: number,
  sound: number,
  out: Float32Array,
): Float32Array {
  out[0] = x;
  out[1] = y;
  for (const p of scenery?.props ?? []) {
    if (p.sound !== sound || Math.abs(p.x - x) > 0.01 || Math.abs(p.y - y) > 0.01) continue;
    const c = scenery?.propModels[p.cobj]?.centre;
    if (c) emitterCentre(p, c, out);
    break;
  }
  return out;
}

/** The cell a Prop hangs in, by its box's placed centre: [cellZ, cellX]. */
export function emitterCell(scenery: ArenaScenery, p: SceneryProp): [number, number] {
  const c = scenery.propModels[p.cobj]?.centre;
  if (!c) return [cellZOf(p.x), cellXOf(p.y)];
  const at = emitterCentre(p, c, new Float32Array(2));
  return [cellZOf(at[0]), cellXOf(at[1])];
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
  /** Each instance's cell (render/drawWindow.ts), whether it is drawn, its standing matrix. */
  readonly cellZ: Int16Array;
  readonly cellX: Int16Array;
  readonly shown: Uint8Array;
  readonly rest: Float32Array;
  /** Some record steps the model's frames. */
  readonly animated: boolean;
  /** The frame each instance shows (-1 unwritten): its morph's and its facers'. */
  readonly frame: Int16Array;
  /** The morph texture, a row per instance. */
  readonly morph: {
    readonly texture: THREE.DataTexture;
    readonly len: number;
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
      async (gltf) => {
        if (cancelled?.()) {
          disposeSubtree(gltf.scene);
          return;
        }
        const model = await mergeFcopModel(gltf);
        const facers = parseFacers(model.extras);
        if (!model.geometry && !facers) {
          console.warn(`[props] nothing to draw in ${at}, skipping`);
          return;
        }
        // A material per draw mode (render/fcopModel.ts). A model of facers
        // only (Hk 65, Slim 63 / 83, Joke 62 / 82) has no faces: its mesh
        // draws nothing and holds the instances' matrices its facers ride.
        const geometry = model.geometry ?? new THREE.BufferGeometry();
        const mesh = new THREE.InstancedMesh(
          geometry,
          model.geometry ? faceMaterials(model) : new THREE.MeshBasicMaterial(),
          props.length,
        );
        if (!model.geometry) mesh.visible = false;
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
        const targets = geometry.morphAttributes.position?.length ?? 0;
        let morph: EmitterMesh["morph"] = null;
        const animated = props.some((p) => p.anim !== "none");
        if (animated && model.geometry) {
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
            morph = { texture, len };
          } else {
            console.warn(`[props] ${at}: ${targets} morph targets for ${frames} frames`);
          }
        }
        group.add(mesh);
        const frame = new Int16Array(props.length).fill(-1);
        // The facers ride each instance's matrix on its frame (render/facers.ts).
        registerFacers(mesh, facers, model.map, { frames: frame });
        meshes.push({
          mesh,
          props,
          frames,
          spinning: Int16Array.from(spinning),
          cellZ: Int16Array.from(props, (p) => emitterCell(scenery, p)[0]),
          cellX: Int16Array.from(props, (p) => emitterCell(scenery, p)[1]),
          shown: new Uint8Array(props.length).fill(1),
          rest: Float32Array.from(mesh.instanceMatrix.array),
          animated,
          frame,
          morph,
        });
        // A model that arrives late stands at the clock it arrives on, in the
        // block the viewer has.
        updateEmitters(lastNow);
        if (lastWindow) setEmitterWindow(lastWindow);
      },
      () => {
        console.warn(`[props] no prop asset at ${at}, skipping`);
      },
    );
  }
}

let lastNow = 0;
let lastWindow: DrawWindow | null = null;

/** The spinning instance `i` of `em` at `now`, into its matrix. */
function spinAt(em: EmitterMesh, i: number, now: number): void {
  const p = em.props[i];
  scratchPosition.set(p.x, p.h, p.y);
  scratchQuat.setFromAxisAngle(UP, recordTurn(emitterYaw(p.spin, p.swing, p.park, now)));
  em.mesh.setMatrixAt(i, scratchMatrix.compose(scratchPosition, scratchQuat, UNIT));
}

/**
 * The viewer's block moved (render/drawWindow.ts): every Prop outside it stands
 * at a zero matrix, every one inside at its own. Writes only what changed.
 */
export function setEmitterWindow(win: DrawWindow): void {
  lastWindow = win;
  for (let m = 0; m < meshes.length; m++) {
    const em = meshes[m];
    const a = em.mesh.instanceMatrix.array as Float32Array;
    let dirty = false;
    for (let i = 0; i < em.props.length; i++) {
      const want = inDrawWindow(win, em.cellZ[i], em.cellX[i]) ? 1 : 0;
      if (want === em.shown[i]) continue;
      em.shown[i] = want;
      dirty = true;
      if (want === 0) a.fill(0, i * 16, i * 16 + 16);
      else if (em.props[i].spin !== 0) spinAt(em, i, lastNow);
      else a.set(em.rest.subarray(i * 16, i * 16 + 16), i * 16);
    }
    if (dirty) em.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Per frame: `now` engine ticks since the arena's load. Turns and steps. */
export function updateEmitters(now: number): void {
  lastNow = now;
  for (let m = 0; m < meshes.length; m++) {
    const em = meshes[m];
    const spinning = em.spinning;
    for (let k = 0; k < spinning.length; k++) {
      const i = spinning[k];
      if (em.shown[i] !== 0) spinAt(em, i, now);
    }
    if (spinning.length > 0) em.mesh.instanceMatrix.needsUpdate = true;
    if (!em.animated) continue;
    const morph = em.morph;
    const a = morph ? (morph.texture.image.data as Float32Array) : null;
    let dirty = false;
    for (let i = 0; i < em.props.length; i++) {
      const frame = emitterFrame(em.props[i], em.frames, now);
      if (em.frame[i] === frame) continue;
      em.frame[i] = frame;
      if (!morph || !a) continue;
      // Frame k + 1 is target k at weight 1 (gen:units); the base counts in full.
      const row = i * morph.len;
      a[row] = 1;
      for (let k = 1; k < morph.len; k++) a[row + k] = k === frame ? 1 : 0;
      dirty = true;
    }
    if (morph && dirty) morph.texture.needsUpdate = true;
  }
}
