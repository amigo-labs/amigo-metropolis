// Node harness for x1Alloc.test.ts (bundled by the test, run under
// `node --expose-gc`): the X1's per-tick and per-frame paths -- tickX1Walk and
// aimX1 once a tick, the rig's placeX1 once a frame -- run through a scripted
// match (stand, walk, run, turn, the three jumps and their landings, the
// transform both ways, the hover, the cloak) and report how much the JS heap
// grew while they did. V8's heapUsed counts a young-generation allocation the
// moment it is made, so with the semi-space large enough that no scavenge runs,
// any `new`, literal or closure on these paths shows up.

import {
  ANIM_AIRBORNE,
  ANIM_HOVER,
  ANIM_MOVING,
  AVATAR_SNAP_ANIM,
  AVATAR_SNAP_BUTTONS,
  AVATAR_SNAP_ID,
  AVATAR_SNAP_LOCK,
  AVATAR_SNAP_STRIDE,
  AVATAR_SNAP_VX,
  AVATAR_SNAP_VZ,
  AVATAR_SNAPSHOT_LEN,
  BTN_ACTION,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_TURN_LEFT,
  TRANSFORM_LOCK_TICKS,
  WALKER_HIGH_LIFT,
  WALKER_HOP_LIFT,
} from "@metropolis/sim";
import * as THREE from "three";
import { buildX1Rig, placeX1 } from "../src/render/avatarRig";
import { patchTeamUv, prepareTeamUvMask } from "../src/render/teamUv";
import { X1_ANIM_HEIGHT, X1_ANIM_WIDTH } from "../src/render/x1Rig.generated";
import { aimX1, createX1Walk, tickX1Walk } from "../src/render/x1Walk";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");

// --- the script: one avatar snapshot per tick, built up front ------------------
const script: number[][] = [];
function hold(ticks: number, buttons: number, vx: number, vz: number, anim: number, lock = 0) {
  for (let t = 0; t < ticks; t++) script.push([buttons, vx, vz, anim, lock]);
}
hold(20, 0, 0, 0, 0);
hold(60, BTN_ACTION | BTN_FORWARD, 1.95, 0, ANIM_MOVING);
hold(60, BTN_FORWARD, 4.69, 0, ANIM_MOVING);
hold(20, BTN_TURN_LEFT, 0, 0, 0);
hold(30, BTN_ACTION | BTN_JUMP, 0, 0, 0);
hold(1, 0, 0, WALKER_HIGH_LIFT - 0.87, ANIM_AIRBORNE);
hold(18, 0, 0, -6, ANIM_AIRBORNE);
hold(20, 0, 0, 0, 0);
hold(1, 0, 0, WALKER_HOP_LIFT - 0.87, ANIM_AIRBORNE);
hold(12, 0, 0, -11, ANIM_AIRBORNE);
hold(30, 0, 0, 0, 0);
for (let lock = TRANSFORM_LOCK_TICKS; lock >= 1; lock--) hold(1, 0, 0, 0, ANIM_HOVER, lock);
hold(30, BTN_FORWARD, 9, 0, ANIM_HOVER | ANIM_MOVING);
for (let lock = TRANSFORM_LOCK_TICKS; lock >= 1; lock--) hold(1, 0, 0, 0, 0, lock);
hold(300, 0, 0, 0, 0); // long enough for the idle fidget
const frames = new Float32Array(script.length * AVATAR_SNAPSHOT_LEN);
script.forEach((row, t) => {
  const o = t * AVATAR_SNAPSHOT_LEN;
  frames[o + AVATAR_SNAP_ID] = 3;
  frames[o + AVATAR_SNAP_BUTTONS] = row[0];
  frames[o + AVATAR_SNAP_VX] = row[1];
  frames[o + AVATAR_SNAP_VZ] = row[2];
  frames[o + AVATAR_SNAP_ANIM] = row[3];
  frames[o + AVATAR_SNAP_LOCK] = row[4];
  frames[o + AVATAR_SNAP_STRIDE + AVATAR_SNAP_ID] = -1;
});

// --- the rig, on a stand-in geometry (place's cost is the same) -----------------
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
geometry.setAttribute("_x1bone", new THREE.BufferAttribute(new Float32Array([0, 9, 17]), 1));
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
  const o = (t % script.length) * AVATAR_SNAPSHOT_LEN;
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
  const short = script.length * 4;
  const long = script.length * 16;
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
