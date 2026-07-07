// Phase 0 sandbox: fixed 30 Hz sim under a variable-rate render loop.
// Frame loop contract (CLAUDE.md renderer rules): ZERO allocations — all
// scratch objects live at module scope, snapshots rotate between two
// preallocated buffers, and the renderer reads sim state ONLY via
// writeSnapshot().

import {
  createSim,
  createTestMap,
  createTickInputs,
  LOCAL_INPUT_DELAY_TICKS,
  MAX_ENTITIES,
  SNAPSHOT_STRIDE,
  step,
  TICK_HZ,
  type TickInputs,
  writeSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { KeyboardInput } from "./input/keyboard";
import { createGreyboxMeshes, NEUTRAL_COLOR, TEAM_COLORS } from "./render/greybox";
import { buildTerrainMesh } from "./render/terrain";

// --- Simulation setup -------------------------------------------------------

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? "0xc0ffee") >>> 0;
const map = createTestMap();
const sim = createSim(map, seed);

// Local input delay queue: input sampled at tick T is applied at
// T + LOCAL_INPUT_DELAY_TICKS, matching online feel (architecture.md §4).
const QUEUE_SIZE = LOCAL_INPUT_DELAY_TICKS + 1;
const inputQueue: TickInputs[] = [];
for (let i = 0; i < QUEUE_SIZE; i++) inputQueue.push(createTickInputs());

// Rotating snapshot buffers: renderer interpolates prev → curr by alpha.
let snapPrev = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
let snapCurr = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
let countPrev = 0;
let countCurr = 0;

const keyboard = new KeyboardInput(window);

function runTick(): void {
  keyboard.sample(inputQueue[(sim.tick + LOCAL_INPUT_DELAY_TICKS) % QUEUE_SIZE].players[0]);
  step(sim, inputQueue[sim.tick % QUEUE_SIZE]);
  const swap = snapPrev;
  snapPrev = snapCurr;
  snapCurr = swap;
  countPrev = countCurr;
  countCurr = writeSnapshot(sim, snapCurr);
}

// --- Scene setup -------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
sun.position.set(120, 180, 60);
sun.matrixAutoUpdate = false;
sun.updateMatrix();
scene.add(sun);
scene.add(buildTerrainMesh(map));
const greybox = createGreyboxMeshes(scene);

const extent = (map.size - 1) * map.cellSize;
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(extent / 2, 70, extent / 2 - 70);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(extent / 2, 0, extent / 2);
controls.enableDamping = true;
controls.update();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Frame loop --------------------------------------------------------------

const TICK_MS = 1000 / TICK_HZ;
const MAX_STEPS_PER_FRAME = 5;

// Module-scope scratch: never allocate inside frame().
const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const archetypeCounts = new Int32Array(8);

const hud = document.getElementById("hud") as HTMLDivElement;
let hudFrames = 0;
let hudLastUpdate = 0;

function wrapAngleDelta(d: number): number {
  return ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

function renderEntities(alpha: number): void {
  archetypeCounts.fill(0);
  let p = 0;
  for (let c = 0; c < countCurr; c++) {
    const o = c * SNAPSHOT_STRIDE;
    const id = snapCurr[o];
    // Both snapshots are in dense id order — two-pointer match, no lookups.
    while (p < countPrev && snapPrev[p * SNAPSHOT_STRIDE] < id) p++;
    const po = p * SNAPSHOT_STRIDE;
    const hasPrev = p < countPrev && snapPrev[po] === id;

    const archetype = snapCurr[o + 1];
    const mesh = greybox.byArchetype[archetype];
    if (!mesh) continue;
    const slot = archetypeCounts[archetype];
    if (slot >= (greybox.teamCache[archetype]?.length ?? 0)) continue;
    archetypeCounts[archetype] = slot + 1;

    let x = snapCurr[o + 3];
    let y = snapCurr[o + 4];
    let height = snapCurr[o + 5];
    let yaw = snapCurr[o + 6];
    if (hasPrev) {
      x = snapPrev[po + 3] + (x - snapPrev[po + 3]) * alpha;
      y = snapPrev[po + 4] + (y - snapPrev[po + 4]) * alpha;
      height = snapPrev[po + 5] + (height - snapPrev[po + 5]) * alpha;
      yaw = snapPrev[po + 6] + wrapAngleDelta(yaw - snapPrev[po + 6]) * alpha;
    }

    // sim (x, y, height, yaw) → three (x, height, z, rotationY = -yaw)
    scratchPos.set(x, height, y);
    scratchQuat.setFromAxisAngle(UP, -yaw);
    scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
    mesh.setMatrixAt(slot, scratchMatrix);

    const team = snapCurr[o + 2];
    const cache = greybox.teamCache[archetype];
    if (cache[slot] !== team) {
      cache[slot] = team;
      mesh.setColorAt(slot, team >= 0 ? TEAM_COLORS[team] : NEUTRAL_COLOR);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
  for (let a = 0; a < greybox.byArchetype.length; a++) {
    const mesh = greybox.byArchetype[a];
    if (!mesh) continue;
    mesh.count = archetypeCounts[a];
    mesh.instanceMatrix.needsUpdate = true;
  }
}

let last = performance.now();
let accumulator = 0;

function frame(now: number): void {
  accumulator += Math.min(now - last, 250); // cap catch-up after tab switch
  last = now;
  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
    runTick();
    accumulator -= TICK_MS;
    steps++;
  }
  if (accumulator >= TICK_MS) accumulator = TICK_MS; // shed backlog, stay stable

  renderEntities(accumulator / TICK_MS);
  controls.update();
  renderer.render(scene, camera);

  hudFrames++;
  if (now - hudLastUpdate > 1000) {
    hud.textContent =
      `tick ${sim.tick}  fps ${hudFrames}  entities ${countCurr}\n` +
      `WASD/arrows drive · mouse orbits · seed ${seed}`;
    hudFrames = 0;
    hudLastUpdate = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
