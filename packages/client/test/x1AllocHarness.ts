// Node harness for x1Alloc.test.ts (bundled by the test, run under
// `node --expose-gc`): the X1's per-tick and per-frame paths -- tickX1Walk and
// aimX1 once a tick, the rig's placeX1 once a frame -- run through a recorded
// match (stand, walk, run, turn, the crouch, the three jumps and their
// landings, the transform both ways, the hover, the idle fidget) and report
// how much the JS heap grew while they did. V8's heapUsed counts a
// young-generation allocation the moment it is made, so with the semi-space
// large enough that no scavenge runs, any `new`, literal or closure on these
// paths shows up.

import {
  AVATAR_SNAPSHOT_LEN,
  BTN_ACTION,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_TURN_LEFT,
  createSim,
  createTickInputs,
  getMapById,
  step,
  TRANSFORM_CHORD,
  TRANSFORM_LOCK_TICKS,
  writeAvatarSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { buildX1Rig, placeX1 } from "../src/render/avatarRig";
import { patchTeamUv, prepareTeamUvMask } from "../src/render/teamUv";
import { X1_ANIM_HEIGHT, X1_ANIM_WIDTH } from "../src/render/x1Rig.generated";
import { aimX1, createX1Walk, tickX1Walk, x1DrawForm } from "../src/render/x1Walk";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");

// --- the script: the sim's avatar snapshot per tick, recorded up front ----------
const plan: [number, number][] = [
  [20, 0],
  [60, BTN_ACTION | BTN_FORWARD],
  [60, BTN_FORWARD],
  [1, BTN_FORWARD | BTN_JUMP],
  [40, BTN_FORWARD],
  [20, BTN_TURN_LEFT],
  [30, BTN_ACTION | BTN_JUMP],
  [60, BTN_JUMP],
  [30, 0],
  [1, TRANSFORM_CHORD],
  [TRANSFORM_LOCK_TICKS + 30, BTN_FORWARD],
  [1, TRANSFORM_CHORD],
  [TRANSFORM_LOCK_TICKS + 300, 0], // long enough for the idle fidget
];
let ticks = 0;
for (const [n] of plan) ticks += n;
const frames = new Float32Array(ticks * AVATAR_SNAPSHOT_LEN);
{
  const sim = createSim(getMapById("urban-jungle"), 1);
  const inputs = createTickInputs();
  let t = 0;
  for (const [n, buttons] of plan) {
    for (let k = 0; k < n; k++) {
      inputs.players[0].buttons = buttons;
      step(sim, inputs);
      writeAvatarSnapshot(sim, frames.subarray(t * AVATAR_SNAPSHOT_LEN));
      t++;
    }
  }
}
const scriptLength = ticks;

// --- the rig, on a stand-in geometry (place's cost is the same) -----------------
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
geometry.setAttribute("_x1bone", new THREE.BufferAttribute(new Float32Array([0, 9, 17]), 1));
geometry.setAttribute("_x1layer", new THREE.BufferAttribute(new Float32Array([0, 1, 0]), 1));
geometry.setAttribute("_teamuv", new THREE.BufferAttribute(new Float32Array([1, 1, 0]), 1));
prepareTeamUvMask(geometry);
const material = new THREE.MeshStandardMaterial({ flatShading: true });
material.map = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
patchTeamUv(material);
const core = buildX1Rig(
  new THREE.Scene(),
  geometry,
  material,
  new Float32Array(X1_ANIM_WIDTH * X1_ANIM_HEIGHT * 4),
);

const walk = createX1Walk();
const snap = new Float32Array(AVATAR_SNAPSHOT_LEN);

function tick(t: number): void {
  const o = (t % scriptLength) * AVATAR_SNAPSHOT_LEN;
  for (let k = 0; k < AVATAR_SNAPSHOT_LEN; k++) snap[k] = frames[o + k];
  tickX1Walk(walk, snap);
  aimX1(walk, 0, (t & 64) !== 0, 3, 1, 0.5, 0.2);
}

function frame(t: number): void {
  for (let s = 0; s < 2; s++) {
    placeX1(
      core,
      s,
      t * 0.01,
      0,
      s,
      t * 0.001,
      1 + s,
      walk.legsFrame[0],
      walk.cockpitFrame[0],
      walk.aimYaw[0] * 0.001,
      walk.aimPitch[0] * 0.001,
      (t & 128) !== 0 ? (t >> 2) & 63 : -1,
      x1DrawForm(walk, 0),
    );
  }
}

let sink: unknown = null;

function run(from: number, n: number, leak: boolean): void {
  for (let t = from; t < from + n; t++) {
    tick(t);
    frame(t);
    frame(t);
    if (leak) sink = [t];
  }
}

function measure(n: number, leak: boolean): number {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  run(0, n, leak);
  return process.memoryUsage().heapUsed - before;
}

// Warm up until the JIT has optimised the paths (an interpreted caller boxes
// every double it passes), then measure, and measure a loop that allocates one
// small array a tick to show the measure sees one.
for (let i = 0; i < 400; i++) {
  run(i * 32, 32, false);
  run(i * 32, 32, true);
}
// Per tick, from the slope between a short and a long run (the least of three
// each): heapUsed moves in allocation-buffer steps, which a slope cancels.
function perTick(leak: boolean): number {
  const short = scriptLength * 4;
  const long = scriptLength * 16;
  let a = Number.POSITIVE_INFINITY;
  let b = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    a = Math.min(a, measure(short, leak));
    b = Math.min(b, measure(long, leak));
  }
  return (b - a) / (long - short);
}
const clean = perTick(false);
const leaky = perTick(true);
if (sink === 1) console.log(sink);
console.log(JSON.stringify({ clean, leaky }));
