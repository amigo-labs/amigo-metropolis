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
  getMapById,
  LOCAL_INPUT_DELAY_TICKS,
  MAX_ENTITIES,
  MAX_PLAYERS,
  type MatchConfig,
  type PlayerInput,
  SIM_VERSION,
  type SimState,
  SNAPSHOT_STRIDE,
  spawnUnit,
  step,
  TICK_HZ,
  type TickInputs,
  URBAN_JUNGLE_ID,
  worldExtent,
  writeSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AudioEngine } from "./audio/engine";
import { aimAssist, parseAimAssistMode } from "./input/aimAssist";
import { PlayerOneInput } from "./input/keyboard";
import { TouchInput, wantsTouch } from "./input/touch";
import { TOUCH_BUTTONS } from "./input/touchMapping";
import type { LocalInputSource } from "./input/types";
import { buildModeQuery, type MenuChoice, type MenuHandle, runMenu } from "./menu";
import { createDemoSim, demoFeeder, updateFlyoverCamera, zeroPlayerInput } from "./menuWorld";
import { NetLockstep } from "./net/lockstep";
import { P2pLockstep } from "./net/p2pLockstep";
import { openP2pSession, readP2pBootstrap } from "./net/p2pSession";
import { WsTransport } from "./net/wsTransport";
import { DEFAULT_RIG_CONFIG, deriveCameraPose, updateCamera } from "./render/camera";
import { applyBlend, beginBlend, createCameraBlend } from "./render/cameraBlend";
import { createFlyState, initFlyInput, poseFlyStart, updateFlyCamera } from "./render/flyCamera";
import { bucketFor, createGreyboxMeshes, tintFor, tintKey } from "./render/greybox";
import { loadMapMesh } from "./render/meshMap";
import { ATMOSPHERE_HEX } from "./render/palette";
import { createPlayerViews, layoutViews, type PlayerView } from "./render/playerView";
import { buildBaseStructures, buildSpawnMarkers } from "./render/structures";
import {
  buildDeckMeshes,
  buildTerrainMesh,
  buildWallMesh,
  buildWaterPlane,
} from "./render/terrain";
import {
  createVariantSwitcher,
  loadTexPref,
  parseTexPref,
  type TexPref,
  type VariantSwitcher,
  variantOfPref,
} from "./render/texVariants";
import { loadUnitMeshes } from "./render/unitMeshes";
import { createTouchControls } from "./touchControls";

// --- Mode + simulation setup -------------------------------------------------

const params = new URLSearchParams(location.search);
// `let`: online the server's MSG_WELCOME config is authoritative — a joiner
// whose URL names a different arena rebuilds map + scene (see rebuildArena).
let map = getMapById(params.get("map") ?? URBAN_JUNGLE_ID);
// ?online=<CODE> is 1v1 lockstep; it owns both slots, so the Warden stays off.
const onlineCode = normalizeCode(params.get("online"));
// ?p2p=<CODE> is 1v1 lockstep too, but lobby-brokered and peer-to-peer over
// WebRTC (hosting.spec.md) — the relay never sees the match traffic.
const p2pCode = normalizeCode(params.get("p2p"));
const online = onlineCode !== null;
const p2p = !online && p2pCode !== null;
const netMode = online || p2p;
// Touch controls (?touch=1/0 override, else coarse-pointer auto-detect): the
// local player drives via on-screen sticks instead of keyboard/mouse. Touch
// suppresses the orbit debug cam — OrbitControls would fight the sticks for
// the same canvas pointers.
const touchMode = wantsTouch(params);
const orbitMode = !netMode && !touchMode && params.get("cam") === "orbit";
// ?cam=fly: free-fly debug camera (render/flyCamera.ts) — noclip navigation for
// inspecting map meshes / texture variants. Solo-only, like orbit.
const flyMode = !netMode && params.get("cam") === "fly";
// Aim assist is a LOCAL setting (input.spec §8): ?aim=off|assist|lock.
aimAssist.mode = parseAimAssistMode(params.get("aim"));

// Mesh rendering (textured Stage 4 maps + Stage B unit models) is the default
// look since the Phase 7 model pass; ?render=greybox keeps the full Stage A
// debug view (assets.md §1 — greybox stays in the repo forever). Every asset
// falls back to greybox per map/archetype when missing, so mesh is safe as
// the default.
const renderMode: "mesh" | "greybox" = params.get("render") === "greybox" ? "greybox" : "mesh";
// Player texture preference (HD = shipped atlas, Original = 1998 texels).
// ?tex=hd|original is a session override and is NOT persisted back (like ?aim=);
// the menu's Graphics drawer writes the stored preference. Mutable: the menu
// updates it live via onTexPref. Applied whenever a map mesh loads (see
// buildArenaGroup's onMaterials) — a no-op on the greybox path.
let texPref: TexPref = parseTexPref(params.get("tex")) ?? loadTexPref();

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
// Harness freeze flag (metropolisPause): stops the local tick loop only —
// rendering continues, so a posed scene holds still for screenshots.
let debugPaused = false;
if (params.has("debug") && !netMode) {
  const dbg = globalThis as {
    metropolisSim?: SimState;
    metropolisSetCamera?: (
      px: number,
      py: number,
      pz: number,
      tx: number,
      ty: number,
      tz: number,
    ) => boolean;
    metropolisSpawn?: (archetype: number, team: number, x: number, y: number) => number;
    metropolisPause?: (paused: boolean) => void;
    metropolisSnap?: () => void;
  };
  dbg.metropolisSim = sim;
  // Debug-only spawner + freeze + snapshot for the verify:units screenshot
  // harness (tools/determinism/src/unitShots.ts): line up one unit per archetype,  // freeze the local tick loop, pose entities directly, then re-snapshot so
  // the posed scene renders without the sim re-aiming anything. Solo/debug
  // only — never reachable in a net match, sim untouched otherwise.
  dbg.metropolisSpawn = (archetype, team, x, y) => spawnUnit(sim, archetype, team, x, y);
  dbg.metropolisPause = (paused) => {
    debugPaused = paused;
  };
  // Twice: both interpolation buffers get the posed state, so the render is
  // still at any alpha.
  dbg.metropolisSnap = () => {
    rotateSnapshot();
    rotateSnapshot();
  };
  // Host-side debug hook (like metropolisSim above): lets an e2e/screenshot
  // harness place the single arena-view camera at a fixed pose looking at a
  // target. Render-only — nothing in the sim or renderer reads it back, so no
  // determinism impact. Needs ?cam=orbit: the frame loop's OrbitControls.update
  // keeps a manually set pose (no input deltas), whereas the chase rig would
  // overwrite the camera every frame. Returns false until the view exists.
  dbg.metropolisSetCamera = (px, py, pz, tx, ty, tz) => {
    const view = views[0];
    if (!view) return false;
    view.camera.position.set(px, py, pz);
    if (orbitControls) {
      orbitControls.target.set(tx, ty, tz);
      orbitControls.update();
    } else {
      view.camera.lookAt(tx, ty, tz);
      view.camera.updateMatrixWorld();
    }
    return true;
  };
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
// In touch mode the local player's device is the on-screen overlay instead;
// the keyboard source stays constructed (harmless) so an attached keyboard on
// a touch device still gets its window-level contextmenu/blur handling.
const touchControls = touchMode ? createTouchControls(TOUCH_BUTTONS) : null;
const localInput: LocalInputSource = touchControls ? new TouchInput(touchControls) : keyboard;
if (touchMode) document.body.classList.add("touch");
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

// Dusk sky gradient (Blade-Runner-ish): deep indigo zenith, a narrow warm amber
// smog band at the horizon, cool haze/nadir below. Built once as an
// equirectangular canvas texture so it tracks camera orientation with a true
// world horizon, costs no geometry, and is never touched by fog.
function makeSkyTexture(): THREE.Texture {
  const css = (h: number) => `#${h.toString(16).padStart(6, "0")}`;
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for sky gradient");
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height); // top = zenith
  grad.addColorStop(0.0, css(ATMOSPHERE_HEX.skyZenith));
  grad.addColorStop(0.44, css(ATMOSPHERE_HEX.skyZenith)); // hold indigo up high
  grad.addColorStop(0.5, css(ATMOSPHERE_HEX.skyHorizon)); // thin amber smog band
  grad.addColorStop(0.56, css(ATMOSPHERE_HEX.skyHaze));
  grad.addColorStop(1.0, css(ATMOSPHERE_HEX.skyNadir));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const scene = new THREE.Scene();
scene.background = makeSkyTexture();
// Distance fog fades the far ground into the dusk haze before the arena edge /
// void can be framed (at the ACTION pitch the camera sees ~170u past its focus).
// near/far are the primary playtest knobs: keep gameplay crisp, hide the edge.
scene.fog = new THREE.Fog(ATMOSPHERE_HEX.fog, 55, 190);
// High-key, near-neutral lighting: the map textures keep their own colors, the
// mood lives in the sky + fog. Warm key + subtle cool fill = a gentle teal/amber
// split without a surface color cast.
scene.add(new THREE.AmbientLight(ATMOSPHERE_HEX.lightAmbient, 0.9));
const keyLight = new THREE.DirectionalLight(ATMOSPHERE_HEX.lightKey, 2.2);
keyLight.position.set(120, 180, 60);
keyLight.matrixAutoUpdate = false;
keyLight.updateMatrix();
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(ATMOSPHERE_HEX.lightFill, 0.7);
fillLight.position.set(-110, 90, -80);
fillLight.matrixAutoUpdate = false;
fillLight.updateMatrix();
scene.add(fillLight);
// All static arena visuals live in one group so an online joiner can swap the
// arena wholesale when the authoritative config names a different map.
function buildArenaGroup(m: typeof map): THREE.Group {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false; // identity transform, per renderer rules
  const buildGreyboxTerrain = () => {
    group.add(buildTerrainMesh(m));
    const walls = buildWallMesh(m); // null on wall-free maps
    if (walls) group.add(walls);
    for (const deck of buildDeckMeshes(m)) group.add(deck); // upper decks on layered maps
  };
  if (renderMode === "mesh") {
    // Async: textured terrain mesh (incl. decks) added when loaded; maps
    // without a local asset fall back to greybox terrain instead of nothing.
    // The materials callback arms the debug texture-variant switcher (0/1/2/3).
    loadMapMesh(m, group, buildGreyboxTerrain, (materials) => {
      texSwitcher = createVariantSwitcher(m.id, materials);
      // Player preference first (boot AND every map swap); the debug hotkeys
      // 0-3 can still override it temporarily afterwards.
      texSwitcher.setVariant(variantOfPref(texPref));
      refreshDebugLabel();
    });
  } else {
    buildGreyboxTerrain();
  }
  group.add(buildWaterPlane(m));
  buildBaseStructures(group, m);
  buildSpawnMarkers(group, m);
  return group;
}
let arenaGroup = buildArenaGroup(map);
scene.add(arenaGroup);
const greybox = createGreyboxMeshes(scene);
// Stage B unit models upgrade the greybox buckets in place as they load;
// missing assets keep their greybox mesh (render/unitMeshes.ts).
if (renderMode === "mesh") loadUnitMeshes(greybox);

let extent = worldExtent(map);

/**
 * Online only: the server's MSG_WELCOME config is authoritative. If it names a
 * different arena than this client's URL, rebuild map, extent and the static
 * scene BEFORE the views/cameras are created — render must match the sim.
 */
function rebuildArena(mapId: string): void {
  if (mapId === map.id) return;
  map = getMapById(mapId);
  extent = worldExtent(map);
  // Debug variant textures are per-map: free them before the arena they
  // belong to goes away (the switcher is re-armed by buildArenaGroup's
  // onMaterials callback once the new mesh loads).
  texSwitcher?.dispose();
  texSwitcher = null;
  refreshDebugLabel(); // hide the variant line immediately, not at the 1 Hz tick
  scene.remove(arenaGroup);
  arenaGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map?.dispose(); // free loaded textures on map swap (mesh render path)
      mat.dispose();
    }
  });
  arenaGroup = buildArenaGroup(map);
  scene.add(arenaGroup);
}

// --- App phase ----------------------------------------------------------------
// One persistent rAF loop drives every phase; the phase only decides which
// camera renders (flyover vs per-view rigs) and whether match-only side
// effects (SFX, HUD) run. The sim underneath is the demo battle until
// resetForMatch() swaps the real match in.
type Phase = "menu" | "connecting" | "match";
let phase: Phase = netMode ? "connecting" : explicitMode ? "match" : "menu";

// Flyover camera for the menu/lobby/connecting backdrop world. A tighter FOV
// than the in-match rigs keeps the arena filling the frame (no void horizon).
const flyCam = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.1, 2000);
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

// --- Debug tooling: texture-variant switcher + fly-cam label -------------------
// Armed by buildArenaGroup's onMaterials callback (mesh render path only).
// Hotkeys 0/1/2 swap the map's atlas texture between the shipped default and
// the original/esrgan variants (render/texVariants.ts, 404-tolerant).
let texSwitcher: VariantSwitcher | null = null;
const flyState = createFlyState();

// Small fixed DOM label (overlay idiom: only write on change). Shows the fly
// controls and the active texture variant while debugging.
const debugLabelEl = document.createElement("div");
debugLabelEl.style.cssText =
  "position:fixed;left:8px;bottom:8px;z-index:30;padding:4px 8px;" +
  "font:12px/1.4 monospace;color:#cfd8e3;background:rgba(10,14,20,.7);" +
  "border-radius:4px;pointer-events:none;display:none;white-space:pre";
document.body.appendChild(debugLabelEl);
let debugLabelText: string | null = null;

function refreshDebugLabel(): void {
  // No early return when nothing is active: after rebuildArena drops the
  // switcher the label must hide (empty text) instead of staying stale.
  const parts: string[] = [];
  if (texSwitcher) parts.push(`${texSwitcher.status()}  [0]=default [1]=original [2]=esrgan`);
  if (flyMode) parts.push("fly: WASD+QE move, Shift fast, click=mouse-look (ESC releases)");
  const text = parts.join("\n");
  if (text === debugLabelText) return;
  debugLabelText = text;
  debugLabelEl.textContent = text;
  debugLabelEl.style.display = text ? "block" : "none";
}

// Variant hotkeys: plain digits are unused by gameplay (movement/fire live on
// WASD/JKL, see input/keyboard.ts BUTTON_KEYS) — safe for debug bindings.
addEventListener("keydown", (e) => {
  if (!texSwitcher) return;
  if (e.code === "Digit0") texSwitcher.setVariant("default");
  else if (e.code === "Digit1") texSwitcher.setVariant("original");
  else if (e.code === "Digit2") texSwitcher.setVariant("esrgan");
  else return;
  refreshDebugLabel();
});

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
      if (debugPaused) break; // ?debug harness freeze (metropolisPause)
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
      if (flyMode && v === 0) {
        // Free-fly debug camera owns view 0's posing (render/flyCamera.ts) —
        // rig and blend are skipped, exactly like orbit below.
        updateFlyCamera(flyState, view.camera, dtSec);
      } else if (orbitControls && v === 0) {
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
    // Debug label piggybacks on the 1 Hz cadence so async texture-load status
    // ("loading..." -> "esrgan"/"missing") surfaces without a keypress.
    refreshDebugLabel();
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
  if (flyMode && views.length === 1) {
    initFlyInput(flyState, renderer.domElement);
    poseFlyStart(flyState, views[0].camera, extent);
    refreshDebugLabel();
  }
  // The mouse reticle only makes sense for a single full-window pointer player
  // — and not at all under touch, where the aim stick owns facing.
  reticle.style.display = views.length === 1 && !touchMode ? "block" : "none";
  document.body.style.cursor = ""; // back to the stylesheet crosshair (touch: none)
  touchControls?.show();
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
    onWelcome: (slotIdx, welcomed, welcomedConfig) => {
      if (views.length === 0) {
        fadeCover(() => {
          rebuildArena(welcomedConfig.mapId); // host map wins; joiner ?map is moot
          resetForMatch(welcomed);
          startMatch([{ slot: slotIdx, input: localInput }]);
        });
      } else {
        rebuildArena(welcomedConfig.mapId);
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
      // the real match sim the lockstep just built — on the host's arena.
      if (views.length === 0) {
        fadeCover(() => {
          rebuildArena(session.config.mapId);
          resetForMatch(p2pNet.simState);
          startMatch([{ slot: session.slot, input: localInput }]);
        });
      } else {
        rebuildArena(session.config.mapId);
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
 * Menu arena preview: swap the live backdrop world to the picked arena so the
 * picker doubles as a full-3D preview. Menu-only — once a match or connection
 * starts, the arena is pinned by handleMenuChoice/the net handshake. Reuses
 * rebuildArena (updates map + extent + scene) then reseats the throwaway demo
 * battle on the new arena, exactly like the frame loop's demo-gate reset.
 */
function previewArena(mapId: string): void {
  if (phase !== "menu" || mapId === map.id) return;
  rebuildArena(mapId);
  sim = createDemoSim(map);
  countPrev = 0;
  countCurr = writeSnapshot(sim, snapCurr);
}

/**
 * In-process mode start for menu choices — the live demo world morphs into the
 * match instead of reloading the page. The URL is pushState()d to the matching
 * deep link (carrying a ?relay override), so it stays shareable and a refresh
 * re-enters through the deep-link path exactly as before.
 */
function handleMenuChoice(choice: MenuChoice, mapId: string): void {
  const query = buildModeQuery(choice, mapId);
  const relay = params.get("relay");
  history.pushState(null, "", relay ? `${query}&relay=${encodeURIComponent(relay)}` : query);
  menuHandle?.dismiss();
  // The picked arena becomes the live scene (no-op when unchanged). For net
  // modes this also feeds netConfig's mapId — the host's pick is authoritative.
  rebuildArena(mapId);
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
      startMatch([{ slot: 0, input: localInput }]);
      break;
    }
    case "online":
      phase = "connecting"; // demo battle keeps running under the net overlay,
      resetForMatch(createDemoSim(map)); // re-seated on the picked arena
      connectOnline(choice.code);
      break;
    case "p2p":
      phase = "connecting"; // ditto — the P2P lobby handshake runs on top
      resetForMatch(createDemoSim(map));
      connectP2pMode(choice.code);
      break;
  }
}

if (online) {
  connectOnline(onlineCode as string);
} else if (p2p) {
  connectP2pMode(p2pCode as string);
} else if (explicitMode) {
  startMatch([{ slot: 0, input: localInput }]);
} else {
  // Bare URL: title screen over the live demo world; a choice starts its mode
  // in-process. The reticle/crosshair only makes sense in a live match.
  reticle.style.display = "none";
  document.body.style.cursor = "default";
  menuHandle = runMenu({
    audio,
    onChoice: handleMenuChoice,
    onSelect: previewArena,
    // Graphics drawer: apply a texture-preference change immediately to the
    // (possibly already loaded) backdrop arena; persisting is menu.ts's job.
    onTexPref: (pref) => {
      texPref = pref;
      texSwitcher?.setVariant(variantOfPref(pref));
      refreshDebugLabel();
    },
  });
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
