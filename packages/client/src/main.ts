// Phase 1 sandbox: fixed 30 Hz sim under a variable-rate render loop on the
// district-01 arena. Frame loop contract (CLAUDE.md renderer rules): ZERO
// allocations — all scratch objects live at module scope, snapshots rotate
// between two preallocated buffers, and entity rendering reads sim state ONLY
// via writeSnapshot(). (The 1 Hz debug HUD reads sim fields directly — it is
// host-side debug UI, not part of the renderer.)
//
// URL params: ?map=test-128 ?cam=orbit ?seed=123

import {
  ANIM_HOVER,
  createSim,
  createTickInputs,
  DISTRICT_01_ID,
  getMapById,
  LOCAL_INPUT_DELAY_TICKS,
  MAX_ENTITIES,
  SNAPSHOT_STRIDE,
  step,
  TICK_HZ,
  type TickInputs,
  worldExtent,
  writeSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PlayerOneInput } from "./input/keyboard";
import { bucketFor, createGreyboxMeshes, tintFor, tintKey } from "./render/greybox";
import { buildTerrainMesh, buildWaterPlane } from "./render/terrain";

// --- Simulation setup --------------------------------------------------------

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? "0xc0ffee") >>> 0;
const map = getMapById(params.get("map") ?? DISTRICT_01_ID);
const sim = createSim(map, seed);

const QUEUE_SIZE = LOCAL_INPUT_DELAY_TICKS + 1;
const inputQueue: TickInputs[] = [];
for (let i = 0; i < QUEUE_SIZE; i++) inputQueue.push(createTickInputs());

let snapPrev = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
let snapCurr = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
let countPrev = 0;
let countCurr = 0;

const input = new PlayerOneInput(window);

function runTick(): void {
  const a = sim.avatarId[0];
  if (a >= 0) {
    input.updateAim(camera, sim.ent.posX[a], sim.ent.posY[a], sim.ent.height[a]);
  }
  input.sample(inputQueue[(sim.tick + LOCAL_INPUT_DELAY_TICKS) % QUEUE_SIZE].players[0]);
  step(sim, inputQueue[sim.tick % QUEUE_SIZE]);
  const swap = snapPrev;
  snapPrev = snapCurr;
  snapCurr = swap;
  countPrev = countCurr;
  countCurr = writeSnapshot(sim, snapCurr);
}

// --- Scene setup --------------------------------------------------------------

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
scene.add(buildWaterPlane(map));
const greybox = createGreyboxMeshes(scene);

const extent = worldExtent(map);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(map.spawns[0].x - 14, 12, map.spawns[0].y);

const orbitMode = params.get("cam") === "orbit";
let controls: OrbitControls | undefined;
if (orbitMode) {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(extent / 2, 0, extent / 2);
  controls.enableDamping = true;
  controls.update();
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Frame loop ----------------------------------------------------------------

const TICK_MS = 1000 / TICK_HZ;
const MAX_STEPS_PER_FRAME = 5;

// Module-scope scratch: never allocate inside frame().
const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const camTarget = new THREE.Vector3();
const camEye = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

const hud = document.getElementById("hud") as HTMLDivElement;
const reticle = document.getElementById("reticle") as HTMLDivElement;
addEventListener("mousemove", (e) => {
  reticle.style.transform = `translate(${e.clientX - 10}px, ${e.clientY - 10}px)`;
});
let hudFrames = 0;
let hudLastUpdate = 0;

function wrapAngleDelta(d: number): number {
  return ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

// Interpolated pose of player 0's avatar, updated by renderEntities for the
// chase camera and HUD (sim x,y,height,yaw in slots 0..3; slot 4 = found).
const avatarPose = new Float32Array(5);

function renderEntities(alpha: number): void {
  for (let i = 0; i < greybox.all.length; i++) {
    greybox.all[i].count = 0;
  }
  avatarPose[4] = 0;
  let p = 0;
  for (let c = 0; c < countCurr; c++) {
    const o = c * SNAPSHOT_STRIDE;
    const id = snapCurr[o];
    // Both snapshots are in dense id order — two-pointer match, no lookups.
    while (p < countPrev && snapPrev[p * SNAPSHOT_STRIDE] < id) p++;
    const po = p * SNAPSHOT_STRIDE;
    const hasPrev = p < countPrev && snapPrev[po] === id;

    const archetype = snapCurr[o + 1];
    const animState = snapCurr[o + 7];
    const bucket = bucketFor(greybox, archetype, animState);
    if (!bucket) continue;
    const slot = bucket.count;
    if (slot >= bucket.tintCache.length) continue;
    bucket.count = slot + 1;

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

    if (archetype === 0 && snapCurr[o + 2] === 0) {
      avatarPose[0] = x;
      avatarPose[1] = y;
      avatarPose[2] = height;
      avatarPose[3] = yaw;
      avatarPose[4] = 1;
    }

    // sim (x, y, height, yaw) → three (x, height, z, rotationY = -yaw)
    scratchPos.set(x, height, y);
    scratchQuat.setFromAxisAngle(UP, -yaw);
    scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
    bucket.mesh.setMatrixAt(slot, scratchMatrix);

    const team = snapCurr[o + 2];
    const aux = snapCurr[o + 9];
    const key = tintKey(archetype, team, aux);
    if (bucket.tintCache[slot] !== key) {
      bucket.tintCache[slot] = key;
      bucket.mesh.setColorAt(slot, tintFor(archetype, team, aux));
      if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
    }
  }
  for (let i = 0; i < greybox.all.length; i++) {
    const b = greybox.all[i];
    b.mesh.count = b.count;
    b.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Chase cam: behind the avatar's facing, smoothed exponentially. */
function updateChaseCamera(dtMs: number): void {
  if (avatarPose[4] === 0) return;
  const yaw = avatarPose[3];
  const fx = Math.cos(yaw);
  const fy = Math.sin(yaw);
  camEye.set(avatarPose[0] - fx * 13, avatarPose[2] + 8.5, avatarPose[1] - fy * 13);
  const k = 1 - Math.exp(-dtMs / 180);
  camera.position.lerp(camEye, k);
  camTarget.set(avatarPose[0] + fx * 4, avatarPose[2] + 2, avatarPose[1] + fy * 4);
  camera.lookAt(camTarget);
}

let last = performance.now();
let accumulator = 0;

function frame(now: number): void {
  const dtMs = Math.min(now - last, 250);
  accumulator += dtMs; // cap catch-up after tab switch
  last = now;
  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
    runTick();
    accumulator -= TICK_MS;
    steps++;
  }
  if (accumulator >= TICK_MS) accumulator = TICK_MS; // shed backlog, stay stable

  renderEntities(accumulator / TICK_MS);
  if (controls) controls.update();
  else updateChaseCamera(dtMs);
  renderer.render(scene, camera);

  hudFrames++;
  if (now - hudLastUpdate > 1000) {
    // Debug HUD (1 Hz): reads sim directly — host-side UI, not the renderer.
    const a = sim.avatarId[0];
    const status =
      a >= 0
        ? `hp ${Math.ceil(sim.ent.hp[a])}  heavy ${sim.ent.ammoA[a]}  special ${sim.ent.ammoB[a]}  ` +
          `${(sim.ent.animState[a] & ANIM_HOVER) !== 0 ? "HOVER" : "WALKER"}`
        : `respawn in ${Math.ceil(sim.respawnTimer[0] / TICK_HZ)}s`;
    hud.textContent =
      `${status}  points ${sim.points[0]}\n` +
      `tick ${sim.tick}  fps ${hudFrames}  entities ${countCurr}  map ${map.id}\n` +
      "WASD drive · mouse aim · LMB/RMB/MMB fire · Q transform · Space jump";
    hudFrames = 0;
    hudLastUpdate = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
