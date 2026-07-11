// Sandbox entry: a fixed 30 Hz sim under a variable-rate render loop on the
// district-01 arena, driving the ONE local player. Frame loop contract
// (CLAUDE.md renderer rules): ZERO allocations — all scratch objects live at
// module scope, snapshots rotate between two preallocated buffers, and entity
// rendering reads sim state ONLY via writeSnapshot(). (The 1 Hz debug HUD reads
// sim fields directly — it is host-side debug UI, not part of the renderer.)
//
// Modes (architecture.md §4 "inputs differ, sim doesn't"):
//   solo               ?warden=<1-10> | ?opponent=feeder|idle   (1 view)
//   online 1v1         ?online=<CODE> (+ ?relay=<wsBase>)        (1 view, lockstep)
//   online 1v1 (P2P)   ?p2p=<CODE>                               (1 view, lockstep)
// URL params: ?map=test-128 ?cam=orbit ?seed=123
//
// Online is the same sim driven by network-confirmed inputs instead of a local
// delay queue (§5): both peers derive the seed from the room code, then step
// only ticks the relay has confirmed for BOTH players. All the netcode lives in
// net/lockstep.ts (proven by packages/client/test/netLockstep.test.ts); this
// file just samples the local device, renders, and shows connection state.

import {
  ANIM_HOVER,
  ARCHETYPE,
  CAPTURE_TICKS,
  CONSOLE_HOLD_TICKS,
  createSim,
  createTickInputs,
  DISTRICT_01_ID,
  getMapById,
  LOCAL_INPUT_DELAY_TICKS,
  MAX_ENTITIES,
  MAX_PLAYERS,
  type MatchConfig,
  type PlayerInput,
  SIM_VERSION,
  type SimState,
  SNAPSHOT_STRIDE,
  step,
  TICK_HZ,
  type TickInputs,
  worldExtent,
  writeSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AudioEngine } from "./audio/engine";
import { aimAssist, parseAimAssistMode } from "./input/aimAssist";
import { PlayerOneInput } from "./input/keyboard";
import type { LocalInputSource } from "./input/types";
import { buildModeQuery, type MenuChoice, type MenuHandle, runMenu } from "./menu";
import { createDemoSim, demoFeeder, updateFlyoverCamera, zeroPlayerInput } from "./menuWorld";
import { NetLockstep } from "./net/lockstep";
import { P2pLockstep } from "./net/p2pLockstep";
import { openP2pSession, readP2pBootstrap } from "./net/p2pSession";
import { WsTransport } from "./net/wsTransport";
import { DEFAULT_RIG_CONFIG, deriveCameraPose, updateCamera } from "./render/camera";
import { applyBlend, beginBlend, createCameraBlend } from "./render/cameraBlend";
import { bucketFor, createGreyboxMeshes, tintFor, tintKey } from "./render/greybox";
import { createPlayerViews, layoutViews, type PlayerView } from "./render/playerView";
import { buildBaseStructures } from "./render/structures";
import { buildTerrainMesh, buildWaterPlane } from "./render/terrain";

// --- Mode + simulation setup -------------------------------------------------

const params = new URLSearchParams(location.search);
const map = getMapById(params.get("map") ?? DISTRICT_01_ID);
// ?online=<CODE> is 1v1 lockstep; it owns both slots, so the Warden stays off.
const onlineCode = normalizeCode(params.get("online"));
// ?p2p=<CODE> is 1v1 lockstep too, but lobby-brokered and peer-to-peer over
// WebRTC (hosting.spec.md) — the relay never sees the match traffic.
const p2pCode = normalizeCode(params.get("p2p"));
const online = onlineCode !== null;
const p2p = !online && p2pCode !== null;
const netMode = online || p2p;
const orbitMode = !netMode && params.get("cam") === "orbit";
// Aim assist is a LOCAL setting (input.spec §8): ?aim=off|assist|lock.
aimAssist.mode = parseAimAssistMode(params.get("aim"));

// Offline match seed. Net matches ignore it — the room/lobby code seeds them
// (connectOnline / connectP2pMode derive the same seed on both peers, so no
// seed negotiation is needed and the relay stays a dumb input relay, §5).
const seed = Number(params.get("seed") ?? "0xc0ffee") >>> 0;

// ?warden=<1-10> puts the Phase 4 AI on player 2's slot (rules.md §7). It is a
// solo feature — a net match owns both slots, so the AI stays off.
// Mutable (`let`) because a menu choice now re-targets them in-process.
let wardenDifficulty = netMode ? 0 : Math.trunc(Number(params.get("warden") ?? "0"));
let warden = wardenDifficulty >= 1;

// A bare URL shows the title/menu (Phase 7). Any explicit mode — a network
// match, an AI/scripted opponent, ?play=1 from the menu, or ?debug for the
// harness — boots straight into the match and skips the menu, so every deep
// link and test entry point behaves exactly as before.
const explicitMode =
  netMode || warden || params.has("opponent") || params.has("play") || params.has("debug");
// Offline match modes build the sim now; a net mode defers — to the server's
// authoritative config (arrives in MSG_WELCOME) or the lobby-brokered P2P
// session — so both peers build a byte-identical sim. The menu instead shows
// a local throwaway demo battle (Warden vs feeder) under the flyover camera —
// the real match sim replaces it via resetForMatch() when play starts.
let sim: SimState = netMode
  ? (undefined as unknown as SimState)
  : explicitMode
    ? createSim(map, seed, warden ? { wardenPlayer: 1, wardenDifficulty } : undefined)
    : createDemoSim(map);

// ?debug exposes the live sim for the console / e2e harness (host-side only,
// like the debug HUD — nothing in the sim or renderer reads it back).
if (params.has("debug") && !netMode) {
  (globalThis as { metropolisSim?: SimState }).metropolisSim = sim;
}

// --- Online helpers (no-ops unless ?online) ----------------------------------

/** 5 alphanumeric chars, upper-cased; anything else → not an online session. */
function normalizeCode(raw: string | null): string | null {
  if (!raw) return null;
  const code = raw.toUpperCase();
  return /^[A-Z0-9]{5}$/.test(code) ? code : null;
}

/** Deterministic seed from the room code (FNV-1a) — identical on both peers. */
function seedFromCode(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** Relay WebSocket URL: ?relay=<wsBase> overrides the same-origin default. */
function relayUrl(code: string): string {
  return `${wsBase()}/room/${code}`;
}

/** Lobby DO WebSocket URL (P2P handshake), same override rules as the relay. */
function lobbyUrl(code: string): string {
  return `${wsBase()}/lobby/${code}`;
}

function wsBase(): string {
  const base = params.get("relay");
  if (base) return base.replace(/\/+$/, "");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

const NET_ERROR_TEXT: Record<number, string> = {
  1: "version mismatch — update the game",
  2: "room is full",
  3: "cannot reconnect to that slot",
  4: "protocol error",
};

let net: NetLockstep | P2pLockstep | undefined;
/** Sticky connection status shown over the scene; null once playing normally. */
let netStatus: string | null = null;

// Local-input delay queue (architecture.md §4): even offline, the local
// player's input is delayed LOCAL_INPUT_DELAY_TICKS so online (3 ticks) feels
// identical — same parity in every mode.
const QUEUE_SIZE = LOCAL_INPUT_DELAY_TICKS + 1;
const inputQueue: TickInputs[] = [];
for (let i = 0; i < QUEUE_SIZE; i++) inputQueue.push(createTickInputs());

let snapPrev = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
let snapCurr = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
let countPrev = 0;
let countCurr = 0;

const keyboard = new PlayerOneInput(window);
const audio = new AudioEngine();
// Browsers gate audio behind a gesture; the first pointer/key/touch unlocks it.
audio.armUnlock();

// Service worker for offline solo play (production builds only — the dev server
// runs HMR and its own module graph). Best-effort: a failure just means no
// offline cache, never a broken load.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// Scripted opponent (?opponent=feeder|idle, Phase 3 DoD): a slot that is
// neither a local human nor the Warden runs the feeder build order — walk to
// its ground console, then hold-to-buy runner bursts forever. Used for solo
// ?opponent play AND the menu demo battle's slot 0; the (slot-aware) script
// itself lives in menuWorld.ts, shared by both.
const opponentMode = warden ? "idle" : (params.get("opponent") ?? "feeder");

function scriptOpponent(slot: number, tick: number, out: PlayerInput): void {
  if (opponentMode === "feeder") demoFeeder(slot, tick, out);
  else zeroPlayerInput(out);
}

// --- Scene setup --------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setScissorTest(true); // each player view renders scissored to its rect
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
buildBaseStructures(scene, map);
const greybox = createGreyboxMeshes(scene);

const extent = worldExtent(map);

// --- App phase ----------------------------------------------------------------
// One persistent rAF loop drives every phase; the phase only decides which
// camera renders (flyover vs per-view rigs) and whether match-only side
// effects (SFX, HUD) run. The sim underneath is the demo battle until
// resetForMatch() swaps the real match in.
type Phase = "menu" | "connecting" | "match";
let phase: Phase = netMode ? "connecting" : explicitMode ? "match" : "menu";

// Flyover camera for the menu/lobby/connecting backdrop world.
const flyCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
// Menu→match camera blend (solo starts): flyover pose eases into the chase rig.
const blend = createCameraBlend();

// --- Frame-loop scratch (never allocate inside frame/runTick) ----------------

const TICK_MS = 1000 / TICK_HZ;
const MAX_STEPS_PER_FRAME = 5;

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const camTarget = new THREE.Vector3();
const rigFocus = { x: 0, y: 0, z: 0 };
const rigVel = { x: 0, y: 0, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

// Mouse-wheel zoom for the pointer view: accumulated between frames, drained
// into that view's rig input once per frame (kept out of the sim entirely).
let wheelAccum = 0;
addEventListener(
  "wheel",
  (e) => {
    wheelAccum += e.deltaY;
  },
  { passive: true },
);

const reticle = document.getElementById("reticle") as HTMLDivElement;
addEventListener("mousemove", (e) => {
  reticle.style.transform = `translate(${e.clientX - 10}px, ${e.clientY - 10}px)`;
});
const unitCounts = new Int32Array(2);

// Full-screen status overlay for online mode (connecting / waiting / desync).
// Reuses the lobby card look; only touched when the text actually changes.
const overlayEl = document.createElement("div");
overlayEl.id = "lobby";
overlayEl.style.display = "none";
const overlayCard = document.createElement("div");
overlayCard.className = "lobby-card";
overlayEl.appendChild(overlayCard);
document.body.appendChild(overlayEl);
let overlayText: string | null = null;

function setOverlay(text: string | null): void {
  if (text === overlayText) return;
  overlayText = text;
  if (text === null) {
    overlayEl.style.display = "none";
  } else {
    overlayCard.textContent = text;
    overlayEl.style.display = "flex";
  }
}

/** Picks the status to show: sticky netStatus wins, else the live stall state. */
function refreshOverlay(): void {
  let text = netStatus;
  if (!text && net && net.isStarted && !net.isEnded && net.isWaiting) {
    text = "Waiting for opponent…";
  }
  setOverlay(text);
}

/** Triggers a browser download of a dumped replay (desync forensics, §6). */
function downloadReplay(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Interpolated pose of each player's avatar (sim x,y,height,yaw in 0..3; slot
// 4 = found), keyed by player slot. Filled by renderEntities for chase cams+HUD.
// Per-player avatar render state, filled by renderEntities for the chase rigs:
// [threeX, threeZ, height, found(0/1), pursuit(0/1), velX, velZ]. velX/velZ are
// world u/s in render space, from the raw per-tick snapshot delta.
const avatarPoses: Float32Array[] = [];
for (let p = 0; p < MAX_PLAYERS; p++) avatarPoses.push(new Float32Array(7));

function wrapAngleDelta(d: number): number {
  return ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

// Enemy positions (packed x,y in sim coords) for "assist" aim magnetism, filled
// per view from live sim state. Reused scratch — the input source copies it.
const enemyScratch = new Float32Array(MAX_ENTITIES * 2);
function fillEnemies(slot: number): number {
  const ent = sim.ent;
  let n = 0;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    const team = ent.team[id];
    if (team < 0 || team === slot) continue; // neutral or own team
    const a = ent.archetype[id];
    // Combat entities only: avatars, spawned units, the Warden.
    if (
      a !== ARCHETYPE.AVATAR &&
      !(a >= ARCHETYPE.RUNNER && a <= ARCHETYPE.FORTRESS) &&
      a !== ARCHETYPE.WARDEN
    ) {
      continue;
    }
    enemyScratch[n * 2] = ent.posX[id];
    enemyScratch[n * 2 + 1] = ent.posY[id];
    n++;
  }
  return n;
}

// Set once the match starts (after the lobby, if any).
let views: PlayerView[] = [];
const viewBySlot: (PlayerView | undefined)[] = new Array(MAX_PLAYERS).fill(undefined);
let orbitControls: OrbitControls | undefined;

function runTick(): void {
  // Refresh pointer aim for each local view (uses last frame's chase camera).
  for (let v = 0; v < views.length; v++) {
    const view = views[v];
    const a = sim.avatarId[view.slot];
    if (a >= 0) {
      const ec = aimAssist.mode === "assist" ? fillEnemies(view.slot) : 0;
      view.input.updateAim(
        view.camera,
        sim.ent.posX[a],
        sim.ent.posY[a],
        sim.ent.height[a],
        view.viewport,
        enemyScratch,
        ec,
      );
    }
  }
  // Sample every slot into the delayed frame: local humans from their device,
  // the Warden slot left alone (the sim ignores it), everything else scripted.
  const futureTick = sim.tick + LOCAL_INPUT_DELAY_TICKS;
  const queued = inputQueue[futureTick % QUEUE_SIZE];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const view = viewBySlot[p];
    if (view) view.input.sample(queued.players[p]);
    else if (p !== sim.wardenPlayer) scriptOpponent(p, futureTick, queued.players[p]);
  }

  step(sim, inputQueue[sim.tick % QUEUE_SIZE]);
  // The demo battle stays sonically calm — music only, no SFX.
  if (phase === "match") {
    audio.pump(sim.events); // events are per-tick transients: drain immediately
  }
  rotateSnapshot();
}

/** Rotates the double-buffered snapshots and writes the current sim state. */
function rotateSnapshot(): void {
  const swap = snapPrev;
  snapPrev = snapCurr;
  snapCurr = swap;
  countPrev = countCurr;
  countCurr = writeSnapshot(sim, snapCurr);
}

function renderEntities(alpha: number): void {
  for (let i = 0; i < greybox.all.length; i++) {
    greybox.all[i].count = 0;
  }
  for (let p = 0; p < MAX_PLAYERS; p++) avatarPoses[p][3] = 0;
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

    // Player avatars (archetype AVATAR, team === player slot) feed that
    // player's chase camera and HUD.
    const team = snapCurr[o + 2];
    if (archetype === ARCHETYPE.AVATAR && team >= 0 && team < MAX_PLAYERS) {
      const pose = avatarPoses[team];
      pose[0] = x; // three x
      pose[1] = y; // three z (sim y)
      pose[2] = height; // three y
      pose[3] = 1; // found
      pose[4] = (animState & ANIM_HOVER) !== 0 ? 1 : 0; // pursuit/hover framing
      // Look-ahead velocity: raw per-tick delta → world u/s, in render space.
      if (hasPrev) {
        pose[5] = (snapCurr[o + 3] - snapPrev[po + 3]) * TICK_HZ;
        pose[6] = (snapCurr[o + 4] - snapPrev[po + 4]) * TICK_HZ;
      } else {
        pose[5] = 0;
        pose[6] = 0;
      }
    }

    // sim (x, y, height, yaw) → three (x, height, z, rotationY = -yaw)
    scratchPos.set(x, height, y);
    scratchQuat.setFromAxisAngle(UP, -yaw);
    scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
    bucket.mesh.setMatrixAt(slot, scratchMatrix);

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

/**
 * Orbit-follow rig (camera.spec): world-fixed yaw, a stepless pitch+zoom `t`
 * continuum, look-ahead and a walker/pursuit resting-point bias. Client-local
 * render state — reads only the interpolated avatar pose, never the sim. Per
 * view; framerate-stable in real `dt` seconds.
 */
function updateRigCamera(view: PlayerView, dtSec: number): void {
  const pose = avatarPoses[view.slot];
  if (pose[3] === 0) return; // avatar not present this frame
  rigFocus.x = pose[0];
  rigFocus.y = pose[2]; // three y (height) — the rig adds focusHeight
  rigFocus.z = pose[1];
  rigVel.x = pose[5];
  rigVel.y = 0;
  rigVel.z = pose[6];
  const pursuit = pose[4] !== 0;
  updateCamera(view.cam, view.camInput, rigFocus, rigVel, pursuit, DEFAULT_RIG_CONFIG, dtSec);
  const fov = deriveCameraPose(view.cam, DEFAULT_RIG_CONFIG, view.camera.position, camTarget);
  if (view.camera.fov !== fov) {
    view.camera.fov = fov;
    view.camera.updateProjectionMatrix();
  }
  view.camera.lookAt(camTarget);
}

// --- HUD (1 Hz, host-side debug UI; reads sim directly) ----------------------

let hudFrames = 0;
let hudLastUpdate = 0;

function refreshHud(fps: number): void {
  unitCounts[0] = 0;
  unitCounts[1] = 0;
  for (let c = 0; c < countCurr; c++) {
    const o = c * SNAPSHOT_STRIDE;
    const archetype = snapCurr[o + 1];
    const team = snapCurr[o + 2];
    if (archetype >= 1 && archetype <= 4 && (team === 0 || team === 1)) unitCounts[team] += 1;
  }
  const banner =
    sim.winner >= 0 ? `\nMATCH OVER — ${sim.winner === 0 ? "BLUE" : "RED"} BREACHED THE GATE` : "";
  for (let v = 0; v < views.length; v++) {
    views[v].hud.textContent = hudText(views[v], fps, banner);
  }
}

function hudText(view: PlayerView, fps: number, banner: string): string {
  const slot = view.slot;
  const a = sim.avatarId[slot];
  const status =
    a >= 0
      ? `hp ${Math.ceil(sim.ent.hp[a])}  heavy ${sim.ent.ammoA[a]}  special ${sim.ent.ammoB[a]}  ` +
        `${(sim.ent.animState[a] & ANIM_HOVER) !== 0 ? "HOVER" : "WALKER"}`
      : `respawn in ${Math.ceil(sim.respawnTimer[slot] / TICK_HZ)}s`;
  let progress = "";
  if (sim.buyTarget[slot] >= 0)
    progress += `  buying ${sim.buyProgress[slot]}/${CONSOLE_HOLD_TICKS}`;
  for (let k = 0; k < sim.captureTeam.length; k++) {
    if (sim.captureTeam[k] === slot) {
      progress += `  capturing ${Math.round((sim.captureProgress[k] / CAPTURE_TICKS) * 100)}%`;
    }
  }
  let ownOutposts = 0;
  for (let k = 0; k < sim.outpostOwner.length; k++) {
    if (sim.outpostOwner[k] === slot) ownOutposts += 1;
  }
  if (ownOutposts > 0) progress += `  outposts ${ownOutposts}`;
  const tag = slot === 0 ? "BLUE" : "RED";
  return (
    `P${slot + 1} ${tag}  ${status}  points ${sim.points[slot]}  units ${unitCounts[0]}v${unitCounts[1]}${progress}\n` +
    `tick ${sim.tick}  fps ${fps}  entities ${countCurr}  sfx ${audio.lastCue || "-"}  map ${map.id}` +
    `${warden ? `  warden d${sim.wardenDifficulty}` : ""}\n${view.input.hint}${banner}`
  );
}

// --- Frame loop --------------------------------------------------------------

let last = performance.now();
let accumulator = 0;

function frame(now: number): void {
  const dtMs = Math.min(now - last, 250);
  accumulator += dtMs; // cap catch-up after tab switch
  last = now;
  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
    // Online matches step only confirmed ticks (net.tryStep); a stall (peer
    // input not yet in) breaks out and the overlay explains the pause.
    // Everything else — offline matches AND the menu/lobby/connecting demo
    // battle — steps locally every tick. All paced at 30 Hz by the accumulator.
    if (phase === "match" && net) {
      if (!net.tryStep()) break;
    } else if (sim) {
      runTick();
    } else {
      break; // online deep link: no sim at all until MSG_WELCOME
    }
    accumulator -= TICK_MS;
    steps++;
  }
  if (accumulator >= TICK_MS) accumulator = TICK_MS; // shed backlog, stay stable
  if (net) refreshOverlay();

  // The demo battle is throwaway ambience — when a gate falls, roll a fresh
  // one (rare, seconds-apart event; the allocation is outside the hot path).
  if (phase !== "match" && sim && sim.winner >= 0) {
    sim = createDemoSim(map);
    countPrev = 0;
    countCurr = writeSnapshot(sim, snapCurr);
  }

  renderEntities(accumulator / TICK_MS);
  const dtSec = dtMs / 1000;
  if (views.length === 0) {
    // No views yet: menu / lobby / waiting-for-opponent — flyover over the demo.
    updateFlyoverCamera(flyCam, now / 1000, extent);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setScissor(0, 0, innerWidth, innerHeight);
    renderer.render(scene, flyCam);
  } else {
    // Drain accumulated wheel into the pointer view's rig (scroll up → zoom in
    // → toward ACTION). Only the pointer view takes zoom.
    for (let v = 0; v < views.length; v++) {
      const view = views[v];
      view.camInput.zoomDelta = v === 0 ? wheelAccum * 0.0005 : 0;
      if (orbitControls && v === 0) {
        orbitControls.update();
      } else {
        updateRigCamera(view, dtSec);
        if (blend.active) applyBlend(blend, view.camera, dtSec);
      }
      const vp = view.viewport;
      const yBottom = innerHeight - (vp.top + vp.height); // three uses lower-left origin
      renderer.setViewport(vp.left, yBottom, vp.width, vp.height);
      renderer.setScissor(vp.left, yBottom, vp.width, vp.height);
      renderer.render(scene, view.camera);
    }
  }
  wheelAccum = 0; // consumed for this frame

  hudFrames++;
  if (now - hudLastUpdate > 1000) {
    refreshHud(hudFrames);
    hudFrames = 0;
    hudLastUpdate = now;
  }
  requestAnimationFrame(frame);
}

// --- Boot: (optional menu/lobby →) build views → run --------------------------

/**
 * Swaps the module sim for the real match sim and clears every piece of state
 * the demo battle may have dirtied: queued (delayed) inputs, the snapshot
 * double-buffer, and accumulated wheel zoom. Called by every in-process start;
 * deep links never need it (their sim was built fresh at boot).
 */
function resetForMatch(newSim: SimState): void {
  sim = newSim;
  for (let i = 0; i < inputQueue.length; i++) {
    for (let p = 0; p < MAX_PLAYERS; p++) zeroPlayerInput(inputQueue[i].players[p]);
  }
  countPrev = 0;
  countCurr = writeSnapshot(sim, snapCurr);
  wheelAccum = 0;
  if (params.has("debug")) (globalThis as { metropolisSim?: SimState }).metropolisSim = sim;
}

function startMatch(localPlayers: readonly { slot: number; input: LocalInputSource }[]): void {
  phase = "match";
  views = createPlayerViews(localPlayers, map.spawns, extent);
  viewBySlot.fill(undefined);
  for (let v = 0; v < views.length; v++) viewBySlot[views[v].slot] = views[v];
  layoutViews(views, "v", innerWidth, innerHeight);

  if (orbitMode && views.length === 1) {
    orbitControls = new OrbitControls(views[0].camera, renderer.domElement);
    orbitControls.target.set(extent / 2, 0, extent / 2);
    orbitControls.enableDamping = true;
    orbitControls.update();
  }
  // The mouse reticle only makes sense for a single full-window pointer player.
  reticle.style.display = views.length === 1 ? "block" : "none";
  document.body.style.cursor = ""; // back to the stylesheet crosshair
}

// Short full-screen fade that covers hard view switches (flyover → net-match
// view) where a camera blend would look broken. DOM-side, not part
// of the frame loop, so the transition handling may allocate freely.
const fadeEl = document.createElement("div");
fadeEl.id = "fade-cover";
document.body.appendChild(fadeEl);

function fadeCover(action: () => void): void {
  fadeEl.classList.add("is-on");
  setTimeout(() => {
    action();
    fadeEl.classList.remove("is-on");
  }, 320); // slightly past the 0.3 s CSS transition so the cover is fully opaque
}

/** Local-device sampler shared by both net modes (relay and P2P). */
function makeNetSampler(): () => PlayerInput {
  // One reusable input object; the lockstep serializes it immediately on send.
  const localInput = createTickInputs().players[0];
  return () => {
    const view = views[0];
    if (view) {
      const a = sim.avatarId[view.slot];
      if (a >= 0) {
        const ec = aimAssist.mode === "assist" ? fillEnemies(view.slot) : 0;
        view.input.updateAim(
          view.camera,
          sim.ent.posX[a],
          sim.ent.posY[a],
          sim.ent.height[a],
          view.viewport,
          enemyScratch,
          ec,
        );
      }
      view.input.sample(localInput);
    }
    return localInput;
  };
}

/** Net-match parameters: both peers derive the seed from the shared code. */
function netConfig(matchSeed: number): MatchConfig {
  return {
    simVersion: SIM_VERSION,
    seed: matchSeed,
    mapId: map.id,
    wardenPlayer: -1,
    wardenDifficulty: 0,
  };
}

/**
 * Online 1v1: connect to the relay, then let the netcode drive. The local
 * device samples for whichever slot the server assigns; the sim it builds from
 * the authoritative MSG_WELCOME config replaces the (deferred) module sim, and
 * the frame loop steps it through net.tryStep(). Everything else — render,
 * chase cam, HUD — is unchanged from solo, since only the input source differs.
 */
function connectOnline(code: string): void {
  const config = netConfig(seedFromCode(code));

  net = new NetLockstep(new WsTransport(relayUrl(code)), {
    sampleInput: makeNetSampler(),
    onStep: (_tick, stepped) => {
      audio.pump(stepped.events); // per-tick transients, drained immediately
      rotateSnapshot();
    },
    onWelcome: (slotIdx, welcomed) => {
      if (views.length === 0) {
        fadeCover(() => {
          resetForMatch(welcomed);
          startMatch([{ slot: slotIdx, input: keyboard }]);
        });
      } else {
        resetForMatch(welcomed);
      }
    },
    onStart: () => {
      netStatus = null;
      refreshOverlay();
    },
    onPeer: (_slot, present) => {
      netStatus = present ? null : "Opponent disconnected — waiting to reconnect…";
      refreshOverlay();
    },
    onDesync: (tick, replay) => {
      netStatus = `Desync detected at tick ${tick} — match ended. Replay downloaded.`;
      refreshOverlay();
      downloadReplay(replay, `desync-${code}-t${tick}.mrep`);
    },
    onError: (errCode) => {
      netStatus = `Cannot join room ${code}: ${NET_ERROR_TEXT[errCode] ?? "unknown error"}`;
      refreshOverlay();
    },
    onClose: () => {
      // A desync already sets its own final status; don't overwrite it.
      if (net?.isEnded === "desync") return;
      netStatus = `Connection lost — reload to rejoin room ${code}.`;
      refreshOverlay();
    },
  });

  netStatus = `Room ${code} — waiting for opponent…`;
  setOverlay(netStatus);
  net.start(config);
}

/**
 * P2P 1v1 (hosting.spec.md §5): open/join the lobby by code, run WebRTC
 * signaling through it, then hand the open channel pair to P2pLockstep. The
 * role and lobby options ride sessionStorage from the menu; a bare pasted
 * ?p2p link joins passwordless. Unlike the relay mode there is no WELCOME —
 * the sim exists as soon as the session resolves.
 */
function connectP2pMode(code: string): void {
  const boot = readP2pBootstrap(code);
  netStatus = `Lobby ${code} — connecting…`;
  setOverlay(netStatus);
  openP2pSession({
    url: lobbyUrl(code),
    role: boot.role,
    config: netConfig(seedFromCode(code)),
    hostSetup:
      boot.role === "host"
        ? {
            name: boot.name || `Lobby ${code}`,
            visibility: boot.visibility ?? "private",
            passwordHash: boot.passwordHash,
          }
        : undefined,
    joinPasswordHash: boot.role === "join" ? boot.passwordHash : undefined,
    onStatus: (text) => {
      netStatus = text;
      refreshOverlay();
    },
  })
    .then((session) => {
      const p2pNet = new P2pLockstep(
        session.slot,
        session.config,
        session.channels.control,
        session.channels.inputs,
        {
          sampleInput: makeNetSampler(),
          onStep: (_tick, stepped) => {
            audio.pump(stepped.events);
            rotateSnapshot();
          },
          onStart: () => {
            netStatus = null;
            refreshOverlay();
          },
          onDesync: (tick, replay) => {
            netStatus = `Desync detected at tick ${tick} — match ended. Replay downloaded.`;
            refreshOverlay();
            downloadReplay(replay, `desync-${code}-t${tick}.mrep`);
          },
          onError: (errCode) => {
            netStatus = `Lobby ${code}: ${NET_ERROR_TEXT[errCode] ?? "unknown error"}`;
            refreshOverlay();
          },
          onClose: () => {
            if (net?.isEnded === "desync") return;
            netStatus = `Connection to opponent lost — match over. Return to the menu to rematch.`;
            refreshOverlay();
          },
        },
      );
      net = p2pNet;
      // Same swap the relay path does on WELCOME: fade the (demo) world into
      // the real match sim the lockstep just built.
      if (views.length === 0) {
        fadeCover(() => {
          resetForMatch(p2pNet.simState);
          startMatch([{ slot: session.slot, input: keyboard }]);
        });
      } else {
        resetForMatch(p2pNet.simState);
      }
    })
    .catch((err: unknown) => {
      netStatus = `Lobby ${code}: ${err instanceof Error ? err.message : "connection failed"}`;
      refreshOverlay();
    });
}

let menuHandle: MenuHandle | undefined;

/**
 * In-process mode start for menu choices — the live demo world morphs into the
 * match instead of reloading the page. The URL is pushState()d to the matching
 * deep link (carrying a ?relay override), so it stays shareable and a refresh
 * re-enters through the deep-link path exactly as before.
 */
function handleMenuChoice(choice: MenuChoice): void {
  const query = buildModeQuery(choice);
  const relay = params.get("relay");
  history.pushState(null, "", relay ? `${query}&relay=${encodeURIComponent(relay)}` : query);
  menuHandle?.dismiss();
  switch (choice.mode) {
    case "solo":
    case "warden": {
      warden = choice.mode === "warden";
      wardenDifficulty = choice.mode === "warden" ? choice.difficulty : 0;
      resetForMatch(
        createSim(map, seed, warden ? { wardenPlayer: 1, wardenDifficulty } : undefined),
      );
      // The flagship transition: one continuous shot from flyover to chase rig.
      if (!orbitMode) beginBlend(blend, flyCam, 1.2);
      startMatch([{ slot: 0, input: keyboard }]);
      break;
    }
    case "online":
      phase = "connecting"; // demo battle keeps running under the net overlay
      connectOnline(choice.code);
      break;
    case "p2p":
      phase = "connecting"; // ditto — the P2P lobby handshake runs on top
      connectP2pMode(choice.code);
      break;
  }
}

if (online) {
  connectOnline(onlineCode as string);
} else if (p2p) {
  connectP2pMode(p2pCode as string);
} else if (explicitMode) {
  startMatch([{ slot: 0, input: keyboard }]);
} else {
  // Bare URL: title screen over the live demo world; a choice starts its mode
  // in-process. The reticle/crosshair only makes sense in a live match.
  reticle.style.display = "none";
  document.body.style.cursor = "default";
  menuHandle = runMenu({ audio, onChoice: handleMenuChoice });
  // The install prompt usually fires after the menu mounts; reveal it then.
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    const evt = e as Event & { prompt(): Promise<void> };
    menuHandle?.offerInstall(() => void evt.prompt());
  });
}

// Menu choices pushState() their deep link; back/forward would silently desync
// URL ↔ app state, so just re-boot through the (deep-link) param path.
addEventListener("popstate", () => location.reload());

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  flyCam.aspect = innerWidth / innerHeight;
  flyCam.updateProjectionMatrix();
  if (views.length > 0) layoutViews(views, "v", innerWidth, innerHeight);
});

// The single persistent frame loop — every phase renders through it.
last = performance.now();
requestAnimationFrame(frame);
