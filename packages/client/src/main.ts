// Sandbox entry: a fixed 30 Hz sim under a variable-rate render loop on the
// district-01 arena, now driving one-to-two LOCAL players. Frame loop contract
// (CLAUDE.md renderer rules): ZERO allocations — all scratch objects live at
// module scope, snapshots rotate between two preallocated buffers, and entity
// rendering reads sim state ONLY via writeSnapshot(). (The 1 Hz debug HUD reads
// sim fields directly — it is host-side debug UI, not part of the renderer.)
//
// Modes (architecture.md §4 "inputs differ, sim doesn't"):
//   solo               ?warden=<1-10> | ?opponent=feeder|idle   (1 view)
//   couch splitscreen  ?splitscreen | ?players=2                 (2 views)
//   online 1v1         ?online=<CODE> (+ ?relay=<wsBase>)        (1 view, lockstep)
// URL params: ?map=test-128 ?cam=orbit ?seed=123 ?split=v|h ?rumble=0
//
// Online is the same sim driven by network-confirmed inputs instead of a local
// delay queue (§5): both peers derive the seed from the room code, then step
// only ticks the relay has confirmed for BOTH players. All the netcode lives in
// net/lockstep.ts (proven by packages/client/test/netLockstep.test.ts); this
// file just samples the local device, renders, and shows connection state.

import {
  ANIM_HOVER,
  ARCHETYPE,
  BUTTON_INTERACT,
  CAPTURE_TICKS,
  CONSOLE_HOLD_TICKS,
  createSim,
  createTickInputs,
  DISTRICT_01_ID,
  EV_DEATH,
  EV_HIT,
  EVENT_STRIDE,
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
import { PlayerOneInput } from "./input/keyboard";
import type { LocalInputSource } from "./input/types";
import { runLobby } from "./lobby";
import { NetLockstep } from "./net/lockstep";
import { WsTransport } from "./net/wsTransport";
import { bucketFor, createGreyboxMeshes, tintFor, tintKey } from "./render/greybox";
import {
  createPlayerViews,
  layoutViews,
  type PlayerView,
  type SplitOrientation,
} from "./render/playerView";
import { buildBaseStructures } from "./render/structures";
import { buildTerrainMesh, buildWaterPlane } from "./render/terrain";

// --- Mode + simulation setup -------------------------------------------------

const params = new URLSearchParams(location.search);
const map = getMapById(params.get("map") ?? DISTRICT_01_ID);
// ?online=<CODE> is 1v1 lockstep; it owns both slots, so warden/splitscreen off.
const onlineCode = normalizeCode(params.get("online"));
const online = onlineCode !== null;
const splitscreen = !online && (params.has("splitscreen") || params.get("players") === "2");
const splitOrientation: SplitOrientation = params.get("split") === "h" ? "h" : "v";
const rumbleEnabled = params.get("rumble") !== "0";
const orbitMode = !online && params.get("cam") === "orbit";

// The room code seeds an online match: both peers derive the same seed from it,
// so no seed negotiation is needed and the relay stays a dumb input relay (§5).
const seed = online
  ? seedFromCode(onlineCode as string)
  : Number(params.get("seed") ?? "0xc0ffee") >>> 0;

// ?warden=<1-10> puts the Phase 4 AI on player 2's slot (rules.md §7). It is a
// solo feature — splitscreen fills both slots with humans, so the AI stays off.
const wardenDifficulty =
  splitscreen || online ? 0 : Math.trunc(Number(params.get("warden") ?? "0"));
const warden = wardenDifficulty >= 1;
// Offline builds the sim now; online defers to the server's authoritative
// config (arrives in MSG_WELCOME) so both peers build a byte-identical sim.
let sim: SimState = online
  ? (undefined as unknown as SimState)
  : createSim(map, seed, warden ? { wardenPlayer: 1, wardenDifficulty } : undefined);

// ?debug exposes the live sim for the console / e2e harness (host-side only,
// like the debug HUD — nothing in the sim or renderer reads it back).
if (params.has("debug") && !online) {
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
  const base = params.get("relay");
  if (base) return `${base.replace(/\/+$/, "")}/room/${code}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/room/${code}`;
}

const NET_ERROR_TEXT: Record<number, string> = {
  1: "version mismatch — update the game",
  2: "room is full",
  3: "cannot reconnect to that slot",
  4: "protocol error",
};

let net: NetLockstep | undefined;
/** Sticky connection status shown over the scene; null once playing normally. */
let netStatus: string | null = null;

// Local-input delay queue (architecture.md §4): even offline, every local
// player's input is delayed LOCAL_INPUT_DELAY_TICKS so online (3 ticks) feels
// identical. In splitscreen BOTH humans route through it — same parity.
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

// Scripted opponent (?opponent=feeder|idle, Phase 3 DoD): player 2 runs a
// fixed build order — walk to its ground console, then hold-to-buy runner
// bursts forever. Only used for a slot that is neither a local human nor the
// Warden (i.e. solo ?opponent play).
const opponentMode = warden ? "idle" : (params.get("opponent") ?? "feeder");

function scriptOpponent(tick: number, out: PlayerInput): void {
  out.moveX = 0;
  out.moveY = 0;
  out.aimX = 0;
  out.aimY = 0;
  out.buttons = 0;
  if (opponentMode !== "feeder") return;
  if (tick < 76) {
    out.moveX = 40; // spawn → own ground console (matches map authoring)
    out.moveY = 120;
    return;
  }
  if (tick % 900 < 300) out.buttons = BUTTON_INTERACT; // 10 s burst, 20 s pause
}

// --- Scene setup --------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setScissorTest(true); // splitscreen renders one scissored view per player
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

// --- Frame-loop scratch (never allocate inside frame/runTick) ----------------

const TICK_MS = 1000 / TICK_HZ;
const MAX_STEPS_PER_FRAME = 5;

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const camTarget = new THREE.Vector3();
const camEye = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

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
const avatarPoses: Float32Array[] = [];
for (let p = 0; p < MAX_PLAYERS; p++) avatarPoses.push(new Float32Array(5));
// Avatar id per player captured BEFORE each step, so we can attribute this
// tick's hit/death events (which clear avatarId) back to a player for rumble.
const prevAvatarId = new Int32Array(MAX_PLAYERS);

function wrapAngleDelta(d: number): number {
  return ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
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
      view.input.updateAim(
        view.camera,
        sim.ent.posX[a],
        sim.ent.posY[a],
        sim.ent.height[a],
        view.viewport,
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
    else if (p !== sim.wardenPlayer) scriptOpponent(futureTick, queued.players[p]);
  }

  for (let p = 0; p < MAX_PLAYERS; p++) prevAvatarId[p] = sim.avatarId[p];
  step(sim, inputQueue[sim.tick % QUEUE_SIZE]);
  audio.pump(sim.events); // events are per-tick transients: drain immediately
  if (rumbleEnabled) pumpRumble();
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

/** Turns this tick's hit/death events on a local avatar into a haptic pulse. */
function pumpRumble(): void {
  const ev = sim.events;
  for (let i = 0; i < ev.count; i++) {
    const o = i * EVENT_STRIDE;
    const type = ev.data[o];
    if (type !== EV_HIT && type !== EV_DEATH) continue;
    const target = ev.data[o + 1];
    for (let v = 0; v < views.length; v++) {
      const view = views[v];
      if (prevAvatarId[view.slot] !== target) continue;
      if (type === EV_DEATH) view.input.rumble(1, 300);
      else view.input.rumble(Math.min(ev.data[o + 3] / 60, 1) * 0.4 + 0.1, 120);
    }
  }
}

function renderEntities(alpha: number): void {
  for (let i = 0; i < greybox.all.length; i++) {
    greybox.all[i].count = 0;
  }
  for (let p = 0; p < MAX_PLAYERS; p++) avatarPoses[p][4] = 0;
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
      pose[0] = x;
      pose[1] = y;
      pose[2] = height;
      pose[3] = yaw;
      pose[4] = 1;
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

/** Chase cam: behind the avatar's facing, smoothed exponentially. Per view. */
function updateChaseCamera(view: PlayerView, dtMs: number): void {
  const pose = avatarPoses[view.slot];
  if (pose[4] === 0) return;
  const yaw = pose[3];
  const fx = Math.cos(yaw);
  const fy = Math.sin(yaw);
  camEye.set(pose[0] - fx * 13, pose[2] + 8.5, pose[1] - fy * 13);
  const k = 1 - Math.exp(-dtMs / 180);
  view.camera.position.lerp(camEye, k);
  camTarget.set(pose[0] + fx * 4, pose[2] + 2, pose[1] + fy * 4);
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
    // Online steps only confirmed ticks (net.tryStep); a stall (peer input not
    // yet in) breaks out and the overlay explains the pause. Offline steps
    // locally every tick. Both stay paced at 30 Hz by the accumulator.
    if (net) {
      if (!net.tryStep()) break;
    } else {
      runTick();
    }
    accumulator -= TICK_MS;
    steps++;
  }
  if (accumulator >= TICK_MS) accumulator = TICK_MS; // shed backlog, stay stable
  if (net) refreshOverlay();

  renderEntities(accumulator / TICK_MS);
  for (let v = 0; v < views.length; v++) {
    const view = views[v];
    if (orbitControls && v === 0) orbitControls.update();
    else updateChaseCamera(view, dtMs);
    const vp = view.viewport;
    const yBottom = innerHeight - (vp.top + vp.height); // three uses lower-left origin
    renderer.setViewport(vp.left, yBottom, vp.width, vp.height);
    renderer.setScissor(vp.left, yBottom, vp.width, vp.height);
    renderer.render(scene, view.camera);
  }

  hudFrames++;
  if (now - hudLastUpdate > 1000) {
    refreshHud(hudFrames);
    hudFrames = 0;
    hudLastUpdate = now;
  }
  requestAnimationFrame(frame);
}

// --- Boot: (optional lobby →) build views → run ------------------------------

function startMatch(localPlayers: readonly { slot: number; input: LocalInputSource }[]): void {
  views = createPlayerViews(localPlayers, map.spawns);
  for (let v = 0; v < views.length; v++) viewBySlot[views[v].slot] = views[v];
  layoutViews(views, splitOrientation, innerWidth, innerHeight);

  if (orbitMode && views.length === 1) {
    orbitControls = new OrbitControls(views[0].camera, renderer.domElement);
    orbitControls.target.set(extent / 2, 0, extent / 2);
    orbitControls.enableDamping = true;
    orbitControls.update();
  }
  // The mouse reticle only makes sense for a single full-window pointer player.
  reticle.style.display = views.length === 1 ? "block" : "none";

  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    layoutViews(views, splitOrientation, innerWidth, innerHeight);
  });

  last = performance.now();
  requestAnimationFrame(frame);
}

/**
 * Online 1v1: connect to the relay, then let the netcode drive. The local
 * device samples for whichever slot the server assigns; the sim it builds from
 * the authoritative MSG_WELCOME config replaces the (deferred) module sim, and
 * the frame loop steps it through net.tryStep(). Everything else — render,
 * chase cam, HUD — is unchanged from solo, since only the input source differs.
 */
function connectOnline(code: string): void {
  const config: MatchConfig = {
    simVersion: SIM_VERSION,
    seed,
    mapId: map.id,
    wardenPlayer: -1,
    wardenDifficulty: 0,
  };
  // One reusable input object; NetLockstep serializes it immediately on send.
  const localInput = createTickInputs().players[0];

  net = new NetLockstep(new WsTransport(relayUrl(code)), {
    sampleInput: () => {
      const view = views[0];
      if (view) {
        const a = sim.avatarId[view.slot];
        if (a >= 0) {
          view.input.updateAim(
            view.camera,
            sim.ent.posX[a],
            sim.ent.posY[a],
            sim.ent.height[a],
            view.viewport,
          );
        }
        view.input.sample(localInput);
      }
      return localInput;
    },
    onStep: (_tick, stepped) => {
      audio.pump(stepped.events); // per-tick transients, drained immediately
      rotateSnapshot();
    },
    onWelcome: (slotIdx, welcomed) => {
      sim = welcomed;
      if (params.has("debug")) (globalThis as { metropolisSim?: SimState }).metropolisSim = sim;
      if (views.length === 0) startMatch([{ slot: slotIdx, input: keyboard }]);
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

if (online) {
  connectOnline(onlineCode as string);
} else if (splitscreen) {
  // Render a static overview as the lobby backdrop, then assign devices.
  const overview = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
  overview.position.set(extent / 2, extent * 0.9, extent * 1.4);
  overview.lookAt(extent / 2, 0, extent / 2);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.setScissor(0, 0, innerWidth, innerHeight);
  renderer.render(scene, overview);
  runLobby({ needed: MAX_PLAYERS, keyboard }).then(startMatch);
} else {
  startMatch([{ slot: 0, input: keyboard }]);
}
