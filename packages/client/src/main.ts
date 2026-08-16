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
  ANIM_TRANSFORMING,
  ARCHETYPE,
  CAPTURE_TICKS,
  CONSOLE_HOLD_TICKS,
  createSim,
  createTickInputs,
  EV_CAPTURE,
  EV_CORE_HIT,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_PICKUP,
  EV_RESPAWN,
  EV_SHOT,
  EV_TRANSFORM,
  EVENT_STRIDE,
  getMapById,
  LOCAL_INPUT_DELAY_TICKS,
  type Loadout,
  MATCH_SLOT_CORE_FRAC,
  MATCH_SLOT_POINTS,
  MATCH_SNAPSHOT_LEN,
  MATCH_TICK,
  MATCH_WINNER,
  MAX_ENTITIES,
  MAX_PLAYERS,
  type MatchConfig,
  matchSlotOffset,
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
  writeMatchSnapshot,
  writeSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AudioEngine } from "./audio/engine";
import { findEntities } from "./debug/pinCapture";
import { createPinModal, showPinToast } from "./debug/pinModal";
import {
  createPinSession,
  installConsoleCapture,
  type PinFrame,
  pinConsoleRing,
} from "./debug/pinSession";
import type { PinEntity } from "./debug/pinTypes";
import { createSandboxPanel, type SandboxPanel } from "./debug/sandboxPanel";
import { aimAssist, parseAimAssistMode } from "./input/aimAssist";
import { PlayerOneInput } from "./input/keyboard";
import { createMouseLook, type MouseLook } from "./input/mouseLook";
import { isTextEntryTarget } from "./input/textEntry";
import { TouchInput, wantsTouch } from "./input/touch";
import { TOUCH_BUTTONS } from "./input/touchMapping";
import type { LocalInputSource } from "./input/types";
import {
  buildModeQuery,
  loadoutFromParams,
  type MenuChoice,
  type MenuHandle,
  runMenu,
} from "./menu";
import { createDemoSim, demoFeeder, updateFlyoverCamera, zeroPlayerInput } from "./menuWorld";
import { NetLockstep } from "./net/lockstep";
import { P2pLockstep } from "./net/p2pLockstep";
import { openP2pSession, readP2pBootstrap } from "./net/p2pSession";
import { WsTransport } from "./net/wsTransport";
import { type AvatarRig, createAvatarRig } from "./render/avatarRig";
import { DEFAULT_RIG_CONFIG, deriveCameraPose, updateCamera } from "./render/camera";
import { applyBlend, beginBlend, createCameraBlend } from "./render/cameraBlend";
import { createFlyState, initFlyInput, poseFlyStart, updateFlyCamera } from "./render/flyCamera";
import { createFx } from "./render/fx";
import { bucketFor, createGreyboxMeshes, tintFor } from "./render/greybox";
import { createMatchHud, type MatchHud } from "./render/hud/hud";
import { matchClock, matchEndText } from "./render/matchEnd";
import { loadMapMesh } from "./render/meshMap";
import {
  createAvatarMorph,
  MORPH_DRAW_HOVER,
  MORPH_FOLD,
  MORPH_OUT_LEN,
  MORPH_SCALE_XZ,
  MORPH_SCALE_Y,
  MORPH_SPIN,
} from "./render/morph";
import { ATMOSPHERE_HEX } from "./render/palette";
import { createPlayerViews, layoutViews, type PlayerView } from "./render/playerView";
import { createPost, isSoftwareRenderer, type PostPipeline } from "./render/post";
import { loadProps } from "./render/props";
import { buildBaseStructures, buildSpawnMarkers } from "./render/structures";
import {
  buildDeckMeshes,
  buildTerrainMesh,
  buildWallMesh,
  buildWaterPlane,
} from "./render/terrain";
import {
  createVariantSwitcher,
  loadBloomPref,
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
// inspecting map meshes / unit+turret models. Solo-only, like orbit.
// Mutable: the menu Fly button enables it in-process without a full reload.
let flyMode = !netMode && params.get("cam") === "fly";
// ?sandbox=1: the spawn/weapon test bench (debug/sandboxPanel.ts). Works on any
// arena — it is a mode, not a map. Solo-only for the same reason the ?debug
// hooks are: it mutates sim state between ticks, which would desync the peer
// that did not click. Mutable: the menu Sandbox button enables it in-process.
let sandboxMode = !netMode && params.get("sandbox") === "1";
// Aim assist is a LOCAL setting (input.spec §8): ?aim=off|assist|lock.
aimAssist.mode = parseAimAssistMode(params.get("aim"));

// Mesh rendering (textured Stage 4 maps + Stage B unit models) is the default
// look since the Phase 7 model pass; ?render=greybox keeps the full Stage A
// debug view (assets.md §1 — greybox stays in the repo forever). Every asset
// falls back to greybox per map/archetype when missing, so mesh is safe as
// the default.
const renderMode: "mesh" | "greybox" = params.get("render") === "greybox" ? "greybox" : "mesh";
// ?structures=greybox draws the greybox gate/core/console/pad blocks on TOP of a
// textured arena. Off by default because the original art already contains those
// structures; on, it is the only way to see where the gate and pad VOLUMES
// actually are, which matters when checking an imported layout.
const showGreyboxStructures = params.get("structures") === "greybox";
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
  netMode ||
  warden ||
  sandboxMode ||
  params.has("opponent") ||
  params.has("play") ||
  params.has("debug");
/** Loadout for the local human (menu pick or ?gun=&heavy=&special= deep link). */
let playerLoadout: Loadout = loadoutFromParams(params);
// Offline match modes build the sim now; a net mode defers — to the server's
// authoritative config (arrives in MSG_WELCOME) or the lobby-brokered P2P
// session — so both peers build a byte-identical sim. The menu instead shows
// a local throwaway demo battle (Warden vs feeder) under the flyover camera —
// the real match sim replaces it via resetForMatch() when play starts.
let sim: SimState = netMode
  ? (undefined as unknown as SimState)
  : explicitMode
    ? createSim(map, seed, {
        ...(warden ? { wardenPlayer: 1, wardenDifficulty } : {}),
        loadouts: [playerLoadout],
      })
    : createDemoSim(map);

// Arm the pin console tail before any asset loads. A texture that silently fell
// back to greybox says so on the console and nowhere else — no screenshot shows
// it — so a pin has to be able to carry those lines. Solo only, which is
// exactly where pins are reachable (fly mode is off in a net match), so a real
// match never has its console wrapped.
if (!netMode) {
  installConsoleCapture(pinConsoleRing, () => (sim ? sim.tick : null));
}

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
    metropolisFly?: (x: number, y: number, z: number, yaw: number, pitch: number) => boolean;
    metropolisStep?: (ticks: number) => number;
    metropolisState?: (cx: number, cz: number, radius?: number) => PinEntity[];
    metropolisHud?: () => string[];
    metropolisPin?: (opts?: {
      notes?: string;
      parentId?: string | null;
    }) => Promise<{ id: string; message: string }>;
    metropolisRig?: () => {
      ready: boolean;
      legL: number;
      legR: number;
      stride: number;
      components: number;
      legVertices: number;
    } | null;
    metropolisMorph?: (id: number) => {
      morphing: boolean;
      scaleXZ: number;
      scaleY: number;
      spin: number;
      fold: number;
      drawingHover: boolean;
      arcs: number;
      emitters: number;
    };
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

  // --- Agent-driven verification (tools/determinism/src/pinDrive.ts) ----------
  // Same contract as every hook above: host-side, ?debug-only, solo-only, and
  // nothing in the sim or renderer reads any of it back. Together these let an
  // agent do unattended what a human does with the fly cam and P — so a
  // proposed fix gets re-shot at the original camera pose instead of the human
  // having to fly back and pin again.

  // Fly-cam pose by yaw/pitch. Distinct from metropolisSetCamera above: that
  // one wants ?cam=orbit and a look-at target, whereas a pin records yaw/pitch
  // and the fly rig would overwrite a look-at on the next frame anyway.
  dbg.metropolisFly = (x, y, z, yaw, pitch) => {
    const view = views[0];
    if (!view || !flyMode) return false;
    view.camera.position.set(x, y, z);
    flyState.yaw = yaw;
    flyState.pitch = pitch;
    // dt = 0: apply yaw/pitch to the camera basis without integrating movement,
    // so the pose is exactly what a human at these angles would see.
    updateFlyCamera(flyState, view.camera, 0);
    return true;
  };

  // Deterministic fast-forward. Calls the SAME runTick as the frame loop, so a
  // stepped sim is indistinguishable from a played one at equal input — no
  // second tick path to drift. Pair it with metropolisPause(true), or the frame
  // loop races these ticks.
  dbg.metropolisStep = (ticks) => {
    const n = Math.max(0, Math.trunc(ticks));
    for (let i = 0; i < n && sim && sim.winner < 0; i++) runTick();
    return sim ? sim.tick : -1;
  };

  // Snapshot dump around a point, decoded exactly like a pin's `entities`.
  dbg.metropolisState = (cx, cz, radius) => {
    const all = findEntities(snapCurr, countCurr, cx, cz);
    return radius === undefined ? all : all.filter((e) => e.dist <= radius);
  };

  dbg.metropolisHud = () => views.map((v) => v.hud.textContent ?? "");

  // The agent's equivalent of pressing P.
  dbg.metropolisPin = (opts) => capturePinNow(opts?.notes ?? "", opts?.parentId ?? null);

  // Walk-rig readout. A screenshot shows legs; only this shows them SWINGING,
  // so the harness checks the angles rather than the pixels.
  dbg.metropolisRig = () =>
    avatarRig === null
      ? null
      : {
          ready: avatarRig.ready,
          legL: avatarRig.angleAt(0, 0),
          legR: avatarRig.angleAt(0, 1),
          stride: avatarRig.stride,
          components: avatarRig.split?.componentCount ?? 0,
          legVertices: avatarRig.split?.legVertexCount ?? 0,
        };

  // Transformation readout, same reasoning as the rig hook above: a single
  // screenshot of a morph always looks plausible, so the harness reads the
  // curve it is being posed by rather than trusting the picture. Sampled off a
  // scratch buffer of its own — the frame loop's is mid-sweep whenever this is
  // called from a pin.
  const morphProbe = new Float32Array(MORPH_OUT_LEN);
  dbg.metropolisMorph = (id) => {
    const counts = fx.debugCounts();
    const morphing = avatarMorph.sample(id, morphProbe);
    return {
      morphing,
      scaleXZ: morphing ? morphProbe[MORPH_SCALE_XZ] : 1,
      scaleY: morphing ? morphProbe[MORPH_SCALE_Y] : 1,
      spin: morphing ? morphProbe[MORPH_SPIN] : 0,
      fold: morphing ? morphProbe[MORPH_FOLD] : 0,
      drawingHover: morphing && morphProbe[MORPH_DRAW_HOVER] === 1,
      arcs: counts.arcs,
      emitters: counts.arcEmitters,
    };
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
// Match scalars (points, ammo, respawn, unit counts). Preallocated like the
// entity snapshots — rotateSnapshot() refills it every tick, never reallocates.
const matchSnap = new Float32Array(MATCH_SNAPSHOT_LEN);
// A zero-filled buffer would read as "team 0 already won" (MATCH_WINNER is
// index 1, and 0 is a valid team) until the first rotateSnapshot writes it —
// the match-end detection must never see that boot frame.
matchSnap[MATCH_WINNER] = -1;

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
//
// Sandbox defaults to "idle": a feeder streaming runners across the arena is
// exactly the noise you do not want while watching one unit's walk cycle. An
// explicit ?opponent= still wins, so the feeder is one URL away.
// `let`: the menu's Sandbox button switches modes in-process.
let opponentMode = warden ? "idle" : (params.get("opponent") ?? (sandboxMode ? "idle" : "feeder"));

function scriptOpponent(slot: number, tick: number, out: PlayerInput): void {
  if (opponentMode === "feeder") demoFeeder(slot, tick, out);
  else zeroPlayerInput(out);
}

// --- Scene setup --------------------------------------------------------------

// preserveDrawingBuffer: fly-mode verification pins read the canvas after a
// forced re-render; without this some GPUs return a blank frame on toBlob.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setScissorTest(true); // each player view renders scissored to its rect
// Filmic tone mapping is the base look (the dusk palette is built for it, and
// the additive FX opt out via toneMapped:false, which is also what makes the
// bloom threshold selective). ?tone=off keeps the raw output for debugging.
// Software rasterizers (SwiftShader — the e2e/verification environment) skip
// it like they skip bloom: the look is not for them, the extra shader cost
// shifts the harnesses' wall-clock input timing against the sim, and the
// committed verification screenshots stay comparable. ?tone=on forces it.
const toneParam = params.get("tone");
if (toneParam === "on" || (toneParam !== "off" && !isSoftwareRenderer(renderer))) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Slightly over unity: ACES sinks midtones, and the arenas' rooftop texels
  // are dark to begin with. Eyeballed against SwiftShader shots at 1.0-1.3.
  renderer.toneMappingExposure = 1.2;
}
document.body.appendChild(renderer.domElement);

// Threshold bloom behind a graphics preference (render/post.ts). ?bloom=0|1
// decides the BOOT state, overriding both the stored preference and the
// software-rasterizer default (SwiftShader — the e2e and verification
// environment — defaults off, both for speed and to keep the committed
// verification screenshots comparable). It is deliberately not a lock: the
// Graphics drawer still applies live, because a player explicitly flipping
// the toggle outranks whatever the URL bootstrapped.
const bloomParam = params.get("bloom");
let bloomOn =
  bloomParam === "1"
    ? true
    : bloomParam === "0"
      ? false
      : loadBloomPref() && !isSoftwareRenderer(renderer);
let post: PostPipeline | null = null;
function setBloom(enabled: boolean): void {
  bloomOn = enabled;
  if (enabled && post === null) {
    post = createPost(renderer, scene);
    post.setSize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2));
  } else if (!enabled && post !== null) {
    // Free the composer's screen-sized render targets: a player who tried
    // bloom and turned it off should not keep paying its GPU memory.
    post.dispose();
    post = null;
  }
}

/**
 * The one place a camera reaches the canvas: through the composer when bloom
 * is on (single full-window view only — the multi-view scissor path predates
 * the composer and post-v1 2v2 will need its own pass layout), else direct.
 */
function renderScene(camera: THREE.Camera): void {
  if (bloomOn && post !== null && views.length <= 1) post.render(camera);
  else renderer.render(scene, camera);
}

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
// `?fog=off` disables it for whole-arena verification shots: an overview pose
// sits far beyond the far plane, so the haze that reads as atmosphere in play
// erases the very geometry those shots exist to prove (terrain↔collision
// alignment). Debug-only, alongside ?render= and ?tex=.
if (params.get("fog") !== "off") {
  scene.fog = new THREE.Fog(ATMOSPHERE_HEX.fog, 55, 190);
}
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
//
// The epoch guards the async loaders inside: rapid preview swaps in the menu
// can otherwise resolve a slow .glb load into a group that rebuildArena has
// already removed and disposed — the stale load must throw its parse away
// (and must not re-arm texSwitcher for the wrong map).
let arenaEpoch = 0;
function buildArenaGroup(m: typeof map): THREE.Group {
  const epoch = ++arenaEpoch;
  const stale = () => epoch !== arenaEpoch;
  const group = new THREE.Group();
  group.matrixAutoUpdate = false; // identity transform, per renderer rules
  const buildGreyboxTerrain = () => {
    group.add(buildTerrainMesh(m));
    const walls = buildWallMesh(m); // null on wall-free maps
    if (walls) group.add(walls);
    for (const deck of buildDeckMeshes(m)) group.add(deck); // upper decks on layered maps
  };
  // Greybox structure blocks stand in for base geometry the textured arena
  // already has baked in. Drawing both puts blue boxes on top of the original
  // base building, so in mesh mode they are only added on the fallback path —
  // where there is no art to cover them — unless ?structures=greybox asks for
  // them, which is the only way to see the gate/pad VOLUMES while tuning.
  const buildGreyboxStructures = () => {
    buildBaseStructures(group, m);
    buildSpawnMarkers(group, m);
  };
  if (renderMode === "mesh") {
    // Async: textured terrain mesh (incl. decks) added when loaded; maps
    // without a local asset fall back to greybox terrain instead of nothing.
    // The materials callback arms the debug texture-variant switcher (0/1/2/3).
    loadMapMesh(
      m,
      group,
      () => {
        buildGreyboxTerrain();
        buildGreyboxStructures();
      },
      (materials) => {
        texSwitcher = createVariantSwitcher(m.id, materials);
        // Player preference first (boot AND every map swap); the debug hotkeys
        // 0-3 can still override it temporarily afterwards.
        texSwitcher.setVariant(variantOfPref(texPref));
        refreshDebugLabel();
      },
      stale,
    );
    // Original scenery actors, on the mesh path only: they are the arena's own
    // art, so they belong with the textured terrain and not on top of greybox
    // blocks (render/props.ts). No-op on arenas that carry no `props`.
    loadProps(m, group, stale);
    if (showGreyboxStructures) buildGreyboxStructures();
  } else {
    buildGreyboxTerrain();
    buildGreyboxStructures();
  }
  group.add(buildWaterPlane(m));
  return group;
}
let arenaGroup = buildArenaGroup(map);
scene.add(arenaGroup);
const greybox = createGreyboxMeshes(scene);
// Client-only shot VFX (tracers, muzzle flashes, explosions) — same event
// buffer as audio, independent of sim hash.
const fx = createFx(scene);
// Instantiate the composer only when bloom actually starts on — its render
// targets are the cost, and a SwiftShader run never pays it.
if (bloomOn) setBloom(true);
// Stage B unit models upgrade the greybox buckets in place as they load;
// missing assets keep their greybox mesh (render/unitMeshes.ts).
if (renderMode === "mesh") loadUnitMeshes(greybox);
// Walking avatars come off the greybox bucket and onto the three-part rig once
// avatar-walker.glb has loaded and split (render/avatarRig.ts). Until then — and
// forever in ?render=greybox — the bucket keeps drawing them.
const avatarRig: AvatarRig | null = renderMode === "mesh" ? createAvatarRig(scene) : null;
// Walker <-> hover transformation (render/morph.ts). Client-local clock started
// by EV_TRANSFORM; drives which of the two forms is on screen and how squashed.
const avatarMorph = createAvatarMorph();
/** Preallocated sample buffer — one avatar is posed at a time in the sweep. */
const morphScratch = new Float32Array(MORPH_OUT_LEN);

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
// Sandbox slow-motion: the accumulator drains this much slower, so the sim runs
// fewer ticks per real second. The tick itself is untouched (it knows only its
// counter), so slow motion cannot change what the sim computes — only when.
let timeScale = 1;

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPitch = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const camTarget = new THREE.Vector3();
const rigFocus = { x: 0, y: 0, z: 0 };
const rigVel = { x: 0, y: 0, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);
/**
 * Local axis a nose pitches about. Models are baked +Z -> +X (unitMeshes.ts), so
 * after the yaw rotation a shell's nose is local +X and rolling about local +Z
 * lifts it toward +Y.
 */
const PITCH_AXIS = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;

// The chase rig has no zoom to give the wheel (camera.spec §3), and under
// pointer lock there is no cursor for the reticle to follow — it sits in the
// middle of the view, where the gun points, and CSS keeps it there.
const reticle = document.getElementById("reticle") as HTMLDivElement;
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

// --- In-match pause (ESC) + quit to title menu --------------------------------
// Solo / fly / sandbox / online all need a way to release the pointer and leave.
// Browser ESC already exits pointer lock; a second ESC (or ESC while unlocked)
// opens this overlay. Offline freezes ticks; online keeps lockstep running so
// the peer is not starved, and Leave disconnects cleanly.
let matchPaused = false;
/** Suppresses opening the pause card on the same ESC that released pointer lock. */
let suppressPauseForUnlock = false;

const pauseEl = document.createElement("div");
pauseEl.id = "pause-menu";
pauseEl.setAttribute("role", "dialog");
pauseEl.setAttribute("aria-modal", "true");
pauseEl.setAttribute("aria-label", "Paused");
const pauseCard = document.createElement("div");
pauseCard.className = "pause-card";
const pauseTitle = document.createElement("h1");
pauseTitle.textContent = "Paused";
const pauseHint = document.createElement("p");
pauseHint.textContent = "ESC resumes · click canvas to recapture the mouse";
const pauseActions = document.createElement("div");
pauseActions.className = "pause-actions";
const pauseResumeBtn = document.createElement("button");
pauseResumeBtn.type = "button";
pauseResumeBtn.className = "pause-btn pause-btn--primary";
pauseResumeBtn.textContent = "Resume";
const pauseQuitBtn = document.createElement("button");
pauseQuitBtn.type = "button";
pauseQuitBtn.className = "pause-btn";
pauseQuitBtn.textContent = "Quit to menu";
pauseActions.append(pauseResumeBtn, pauseQuitBtn);
pauseCard.append(pauseTitle, pauseHint, pauseActions);
pauseEl.appendChild(pauseCard);
document.body.appendChild(pauseEl);

// --- Match-end screen ----------------------------------------------------------
// Shown a beat after the sim freezes on a winner (the banner and death FX get
// their moment first). Raw DOM like the pause card; Rematch is offline-only —
// online peers each return to the menu, there is no rematch handshake.
const endEl = document.createElement("div");
endEl.id = "match-end";
endEl.setAttribute("role", "dialog");
endEl.setAttribute("aria-modal", "true");
endEl.setAttribute("aria-label", "Match over");
const endCard = document.createElement("div");
endCard.className = "pause-card";
const endTitle = document.createElement("h1");
const endSubtitle = document.createElement("p");
const endStats = document.createElement("div");
endStats.className = "end-stats";
const endStatTime = document.createElement("div");
const endStatPoints = document.createElement("div");
const endStatKills = document.createElement("div");
endStats.append(endStatTime, endStatPoints, endStatKills);
const endActions = document.createElement("div");
endActions.className = "pause-actions";
const endRematchBtn = document.createElement("button");
endRematchBtn.type = "button";
endRematchBtn.className = "pause-btn pause-btn--primary";
endRematchBtn.textContent = "Rematch";
const endMenuBtn = document.createElement("button");
endMenuBtn.type = "button";
endMenuBtn.className = "pause-btn";
endMenuBtn.textContent = "Return to menu";
endActions.append(endRematchBtn, endMenuBtn);
endCard.append(endTitle, endSubtitle, endStats, endActions);
endEl.appendChild(endCard);
document.body.appendChild(endEl);

/** -1 until a winner is first seen; then the wall-clock ms it was seen at. */
let winSeenAtMs = -1;
let matchEndShown = false;
/** EV_DEATH events credited to the local slot this match (pumpCosmetics). */
let localKills = 0;
/** Delay between the sim freezing and the card appearing. */
const MATCH_END_DELAY_MS = 2500;

function resetMatchEnd(): void {
  winSeenAtMs = -1;
  localKills = 0;
  matchEndShown = false;
  endEl.classList.remove("is-open");
}

function showMatchEnd(winner: number): void {
  matchEndShown = true;
  setMatchPaused(false); // the end card replaces the pause card, never stacks
  const slot = views[0]?.slot ?? 0;
  // Read the win condition off the snapshot, not sim internals (renderer
  // rule 4): the core fraction is -1 exactly on gate (§1) arenas.
  const hasCore = matchSnap[matchSlotOffset(slot) + MATCH_SLOT_CORE_FRAC] >= 0;
  const text = matchEndText(winner, slot, hasCore);
  endTitle.textContent = text.title;
  endCard.classList.toggle("is-victory", winner === slot);
  endSubtitle.textContent = text.subtitle;
  const mine = matchSlotOffset(slot);
  const other = matchSlotOffset(slot === 0 ? 1 : 0);
  endStatTime.textContent = `Time ${matchClock(matchSnap[MATCH_TICK] | 0, TICK_HZ)}`;
  endStatPoints.textContent = `Points ${matchSnap[mine + MATCH_SLOT_POINTS] | 0} — ${
    matchSnap[other + MATCH_SLOT_POINTS] | 0
  }`;
  endStatKills.textContent = `Kills ${localKills}`;
  endRematchBtn.style.display = netMode ? "none" : "";
  endEl.classList.add("is-open");
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.style.cursor = "default";
  reticle.style.display = "none";
  touchControls?.hide();
  (netMode ? endMenuBtn : endRematchBtn).focus();
}

/** Seed of the running local match; each rematch derives the next from it. */
let matchSeed = seed;

/** Offline rematch: same arena, same opponent, a fresh derived seed. */
function rematchSolo(): void {
  resetMatchEnd();
  // Derived from the PREVIOUS match's seed, not the boot constant: seeding
  // from (bootSeed + tick) alone has a fixed point — two matches of equal
  // length would replay the same AI match move for move, forever.
  matchSeed = (matchSeed * 0x9e3779b9 + sim.tick + 1) >>> 0;
  resetForMatch(
    createSim(map, matchSeed, {
      ...(warden ? { wardenPlayer: 1, wardenDifficulty } : {}),
      loadouts: [playerLoadout],
    }),
  );
  startMatch([{ slot: 0, input: localInput }]);
}

endRematchBtn.addEventListener("click", () => rematchSolo());
endMenuBtn.addEventListener("click", () => returnToMenu());

function isMatchLive(): boolean {
  return phase === "match" || phase === "connecting";
}

function setMatchPaused(paused: boolean): void {
  if (paused === matchPaused) return;
  matchPaused = paused;
  pauseEl.classList.toggle("is-open", paused);
  if (paused) {
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.style.cursor = "default";
    flyState.keys.clear();
    pauseResumeBtn.focus();
  } else if (isMatchLive()) {
    // Hidden cursor again; click re-engages pointer lock (mouseLook / fly).
    document.body.style.cursor = "";
  }
}

/**
 * Tear down a live match (or connecting lobby) and remount the title menu over
 * a fresh demo backdrop. Works for solo, online, fly and sandbox.
 */
function returnToMenu(): void {
  setMatchPaused(false);
  if (document.pointerLockElement) document.exitPointerLock();

  // Drop the net session first so no further tryStep runs against a dying sim.
  if (net) {
    net.close();
    net = undefined;
  }
  netStatus = null;
  setOverlay(null);

  matchHud?.destroy();
  matchHud = undefined;
  document.body.classList.remove("hud-text-hidden");

  // fx.update only runs while a match is on — anything still in flight would
  // freeze over the menu backdrop for good if it were not dropped here.
  fx.reset();
  resetMatchEnd();

  sandboxPanel?.dispose();
  sandboxPanel = null;

  for (const v of views) v.hud.remove();
  views = [];
  viewBySlot.fill(undefined);

  if (orbitControls) {
    orbitControls.dispose();
    orbitControls = undefined;
  }
  mouseLook.dispose();
  mouseLook = createMouseLook(renderer.domElement);

  flyMode = false;
  sandboxMode = false;
  warden = false;
  wardenDifficulty = 0;
  // Menu backdrop uses the AI feeder so the live arena stays lively.
  opponentMode = "feeder";
  timeScale = 1;
  debugPaused = false;
  setFlyCrosshairVisible(false);
  reticle.style.display = "none";
  touchControls?.hide();
  document.body.style.cursor = "default";

  phase = "menu";
  // Keep the arena the player was on as the menu backdrop.
  rebuildArena(map.id);
  sim = createDemoSim(map);
  countPrev = 0;
  countCurr = writeSnapshot(sim, snapCurr);
  if (params.has("debug")) (globalThis as { metropolisSim?: SimState }).metropolisSim = sim;

  // Drop mode query so refresh lands on the title screen, not back into the match.
  history.pushState(null, "", location.pathname + location.hash);

  if (!document.querySelector(".menu-root")) {
    menuHandle = runMenu({
      audio,
      onChoice: handleMenuChoice,
      onSelect: previewArena,
      initialLoadout: playerLoadout,
      onTexPref: (pref) => {
        texPref = pref;
        texSwitcher?.setVariant(variantOfPref(pref));
        refreshDebugLabel();
      },
      onBloomPref: setBloom,
    });
  }
  refreshDebugLabel();
}

pauseResumeBtn.addEventListener("click", () => setMatchPaused(false));
pauseQuitBtn.addEventListener("click", () => returnToMenu());

document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement) {
    // Canvas recaptured — hide the system cursor again.
    if (isMatchLive() && !matchPaused) document.body.style.cursor = "";
    return;
  }
  if (!isMatchLive() || matchPaused) return;
  // Browser ESC (and our own exitPointerLock) both land here. Mark the unlock
  // so the same keypress does not immediately open the pause card.
  suppressPauseForUnlock = true;
  document.body.style.cursor = "default";
  setTimeout(() => {
    suppressPauseForUnlock = false;
  }, 120);
});

addEventListener("keydown", (e) => {
  if (e.code !== "Escape" || e.repeat) return;
  if (isTextEntryTarget(e.target)) return;
  if (pinModal.isOpen() || pinBusy) return;
  if (!isMatchLive()) return;

  // Always drop pointer lock first — "give up cursor focus".
  if (document.pointerLockElement) {
    e.preventDefault();
    document.exitPointerLock();
    return;
  }
  if (suppressPauseForUnlock) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  // The end card owns ESC once it is up: the match is over, so "pause" has
  // nothing left to pause — ESC means leave.
  if (matchEndShown) {
    returnToMenu();
    return;
  }
  setMatchPaused(!matchPaused);
});

// --- Debug tooling: texture-variant switcher + fly-cam label -------------------
// Armed by buildArenaGroup's onMaterials callback (mesh render path only).
// Hotkeys 0/1/2 swap the map's atlas texture between the shipped default and
// the original/esrgan variants (render/texVariants.ts, 404-tolerant).
let texSwitcher: VariantSwitcher | null = null;
const flyState = createFlyState();

// Yaw-only mouse steering (input.spec §4.1). Pointer-locks on click; fly mode
// installs its own listeners on the same canvas and keeps free pitch, which is
// why this is a separate object rather than a mode of flyCamera.
let mouseLook: MouseLook = createMouseLook(renderer.domElement);

// Small fixed DOM label (overlay idiom: only write on change). Shows the fly
// controls and the active texture variant while debugging.
// Sits above the HUD's ammo row rather than on it: the ammo numbers are the
// game, this is scaffolding, so the scaffolding is what moves.
const debugLabelEl = document.createElement("div");
debugLabelEl.style.cssText =
  "position:fixed;left:8px;bottom:56px;z-index:30;padding:4px 8px;" +
  "font:12px/1.4 monospace;color:#cfd8e3;background:rgba(10,14,20,.7);" +
  "border-radius:4px;pointer-events:none;display:none;white-space:pre";
document.body.appendChild(debugLabelEl);
let debugLabelText: string | null = null;

function refreshDebugLabel(): void {
  // No early return when nothing is active: after rebuildArena drops the
  // switcher the label must hide (empty text) instead of staying stale.
  const parts: string[] = [];
  // Title-menu backdrop also arms the switcher (Graphics drawer live preview),
  // but the hotkey legend sits over the console footer — hide it until a match.
  if (texSwitcher && phase !== "menu") {
    parts.push(`${texSwitcher.status()}  [0]=default [1]=original [2]=esrgan`);
  }
  if (flyMode) {
    parts.push("fly: WASD+QE move, Shift fast, click=mouse-look");
    parts.push("pin: P = capture + problem note (Shift+P pauses sim)");
  }
  if (sandboxMode) parts.push("sandbox: F2 = spawn + weapon panel");
  if (phase === "match" || phase === "connecting") {
    parts.push("ESC: release mouse · pause · quit to menu");
  }
  const text = parts.join("\n");
  if (text === debugLabelText) return;
  debugLabelText = text;
  debugLabelEl.textContent = text;
  debugLabelEl.style.display = text ? "block" : "none";
}

// --- Verification pin (fly mode): center-ray capture + problem modal ----------
const pinModal = createPinModal();
const flyCrosshair = document.createElement("div");
flyCrosshair.style.cssText =
  "position:fixed;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;" +
  "z-index:25;pointer-events:none;display:none;" +
  "border:1px solid rgba(220,235,255,.85);border-radius:50%;" +
  "box-shadow:0 0 0 1px rgba(0,0,0,.35)";
// Inner cross ticks via two thin bars.
const chH = document.createElement("div");
chH.style.cssText =
  "position:absolute;left:3px;right:3px;top:50%;height:1px;margin-top:-0.5px;background:rgba(220,235,255,.9)";
const chV = document.createElement("div");
chV.style.cssText =
  "position:absolute;top:3px;bottom:3px;left:50%;width:1px;margin-left:-0.5px;background:rgba(220,235,255,.9)";
flyCrosshair.append(chH, chV);
document.body.appendChild(flyCrosshair);

function setFlyCrosshairVisible(on: boolean): void {
  flyCrosshair.style.display = on ? "block" : "none";
}

let pinBusy = false;

// The single capture path: the P hotkey below and metropolisPin (the agent hook)
// both go through this, so a reshoot is field-for-field comparable with the pin
// that prompted it.
const pinSession = createPinSession({
  renderer,
  scene,
  getView0: () => views[0] ?? null,
  getMap: () => map,
  getSim: () => sim ?? null,
  getSnapshot: () => ({ snap: snapCurr, count: countCurr }),
  flyState,
  renderMode,
  seed,
  getTexVariant: () => texSwitcher?.status() ?? null,
  greyboxStructures: showGreyboxStructures,
  // pin:drive runs its own receiver and names it here; a human's browser uses
  // the default port and falls back to downloads when nothing is listening.
  ...(params.get("pinServer") ? { pinServerUrl: params.get("pinServer") as string } : {}),
  setPaused: (p) => {
    debugPaused = p;
  },
  getPaused: () => debugPaused,
});

/**
 * Freezes the sim and neutralises fly input so the pinned frame stays valid,
 * and returns the restore. Only a *saved* pin may leave the sim paused
 * (Shift+P); cancelling and failing both put the pre-pin state back.
 */
function freezeForPin(pauseAfter: boolean): (saved: boolean) => void {
  const wasPaused = debugPaused;
  debugPaused = true;
  if (document.pointerLockElement) document.exitPointerLock();
  flyState.keys.clear();
  flyState.lookX = 0;
  flyState.lookY = 0;
  return (saved: boolean): void => {
    debugPaused = saved && pauseAfter ? true : wasPaused;
    pinBusy = false;
  };
}

/** Hotkey path: capture first, then ask what the problem is. */
async function beginVerificationPin(pauseSim: boolean): Promise<void> {
  if (!flyMode || pinBusy || pinModal.isOpen() || views.length === 0) return;
  pinBusy = true;
  const finish = freezeForPin(pauseSim);
  let frame: PinFrame;
  try {
    frame = await pinSession.captureFrame();
  } catch (e) {
    finish(false);
    showPinToast(`Pin failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  pinModal.open({
    onCancel: () => finish(false),
    onSubmit: (notes) => {
      void (async () => {
        let saved = false;
        try {
          const result = await pinSession.savePin(frame, notes, { origin: "hotkey" });
          showPinToast(result.message);
          saved = true;
        } catch (e) {
          showPinToast(`Pin failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          finish(saved);
        }
      })();
    },
  });
}

/**
 * Agent path (metropolisPin): the notes are known up front, so this is one
 * straight line — no modal, same capture, same payload, same on-disk format.
 * That sameness is the whole point: it makes a reshoot comparable to the pin
 * that prompted it.
 */
async function capturePinNow(
  notes: string,
  parentId: string | null,
): Promise<{ id: string; message: string }> {
  if (pinBusy) throw new Error("a pin capture is already in progress");
  if (views.length === 0) throw new Error("no view to capture (views not built yet)");
  pinBusy = true;
  // Stay paused afterwards: an agent that just captured usually wants to look
  // at the same frame again (reshoot, second angle).
  const finish = freezeForPin(true);
  try {
    const frame = await pinSession.captureFrame();
    const result = await pinSession.savePin(frame, notes, { origin: "agent", parentId });
    finish(true);
    return { id: result.id, message: result.message };
  } catch (e) {
    finish(false);
    throw e;
  }
}

// --- Sandbox test bench (?sandbox=1) -----------------------------------------
// Built on first use rather than at boot: the deps close over `sim`, `views` and
// `avatarRig`, which are seated by startMatch. Same host-side contract as the
// ?debug hooks above — solo only, and nothing in the sim or renderer reads it
// back. `debugPaused` and metropolisStep are SHARED with the harness freeze on
// purpose, so the panel's Pause and metropolisPause can never disagree.
let sandboxPanel: SandboxPanel | null = null;

function ensureSandboxPanel(): void {
  if (sandboxPanel || netMode) return;
  sandboxPanel = createSandboxPanel({
    getSim: () => sim ?? null,
    getMap: () => map,
    getCamera: () => views[0]?.camera ?? null,
    getPlayer: () => views[0]?.slot ?? 0,
    setPaused: (p) => {
      debugPaused = p;
    },
    getPaused: () => debugPaused,
    step: (ticks) => {
      for (let i = 0; i < ticks && sim && sim.winner < 0; i++) runTick();
    },
    resnap: () => {
      // Twice, like metropolisSnap: both interpolation buffers get the new
      // state, so a paused scene renders the spawn at any alpha.
      rotateSnapshot();
      rotateSnapshot();
    },
    setTimeScale: (s) => {
      timeScale = s;
    },
    getTimeScale: () => timeScale,
    rigInfo: () =>
      avatarRig === null || !avatarRig.ready
        ? null
        : {
            legL: avatarRig.angleAt(0, 0),
            legR: avatarRig.angleAt(0, 1),
            stride: avatarRig.stride,
          },
  });
}

addEventListener("keydown", (e) => {
  if (!flyMode || pinModal.isOpen() || pinBusy) return;
  if (e.code !== "KeyP" || e.repeat) return;
  // Ignore when typing in unrelated UI (menu drawers, etc.).
  if (isTextEntryTarget(e.target)) return;
  e.preventDefault();
  void beginVerificationPin(e.shiftKey);
});

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
let matchHud: MatchHud | undefined;
const viewBySlot: (PlayerView | undefined)[] = new Array(MAX_PLAYERS).fill(undefined);
let orbitControls: OrbitControls | undefined;

function runTick(): void {
  // Drain this tick's mouse travel into the heading before anything reads it,
  // so aim and the camera agree within the tick.
  mouseLook.update();
  // Refresh aim for each local view (uses last frame's chase camera basis).
  for (let v = 0; v < views.length; v++) {
    const view = views[v];
    const a = sim.avatarId[view.slot];
    if (a >= 0) {
      const ec = aimAssist.mode === "assist" ? fillEnemies(view.slot) : 0;
      view.input.updateAim(
        view.camera,
        sim.ent.posX[a],
        sim.ent.posY[a],
        mouseLook.yaw,
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
  // Sandbox cheat toggles (infinite ammo / invulnerable), applied AFTER the tick
  // so the tick itself never sees them — same host-side contract as
  // metropolisSpawn. Null unless ?sandbox=1, so a normal match pays nothing.
  sandboxPanel?.afterTick();
  // The demo battle stays calm — music only, no SFX/VFX.
  if (phase === "match") pumpCosmetics(sim.events);
  rotateSnapshot();
}

/** Rotates the double-buffered snapshots and writes the current sim state. */

// --- Positional audio + shot VFX ---------------------------------------------
// Events carry no coordinates for their own sake — only the ones that already
// quantize a position do (EV_EXPLOSION and the Precinct Assault events pack
// x*16/y*16), capture/claim carry a spot index, and the rest name an entity. So
// resolution happens here, the one place that holds both the map and a snapshot.
//
// The snapshot in hand when cosmetics pump runs is up to one tick old (pump
// drains before rotateSnapshot). That is deliberate: 33 ms of staleness is
// inaudible/invisible, and it avoids reordering the tick loop on the two online
// paths, where a mistake would silently drop cues on one path only.
/** id -> snapshot slot, rebuilt per pump. -1 = not in this snapshot. */
const audioIndex = new Int32Array(MAX_ENTITIES).fill(-1);

function buildAudioIndex(): void {
  audioIndex.fill(-1);
  for (let c = 0; c < countCurr; c++) {
    const id = snapCurr[c * SNAPSHOT_STRIDE];
    if (id >= 0 && id < MAX_ENTITIES) audioIndex[id] = c;
  }
}

/**
 * Entity world pose from the current snapshot: `[x, height, z]` always, and
 * `out[3] = yaw` when the buffer is long enough (FX tracers need facing).
 */
function entityPose(id: number, out: Float32Array): boolean {
  if (id < 0 || id >= MAX_ENTITIES) return false;
  const slot = audioIndex[id];
  if (slot < 0) return false;
  const o = slot * SNAPSHOT_STRIDE;
  out[0] = snapCurr[o + 3];
  out[1] = snapCurr[o + 5];
  out[2] = snapCurr[o + 4];
  if (out.length > 3) out[3] = snapCurr[o + 6];
  // Slot 4, for callers that ask for it: the shooter's archetype. render/fx.ts
  // needs it to pick the bolt — the original gives turrets the twin bolt and
  // ground units the single one (docs/specs/fcop-fx.md §4). Guarded by length
  // like the yaw above, so the audio resolver's shorter buffer is untouched.
  if (out.length > 4) out[4] = snapCurr[o + 1];
  return true;
}

/**
 * Module-scope, passed by reference to every pump call site: a fresh closure per
 * tick would allocate in the frame loop (CLAUDE.md renderer rule 1).
 */
function resolveEventPosition(
  type: number,
  a: number,
  b: number,
  c: number,
  out: Float32Array,
): boolean {
  switch (type) {
    // Already quantized to x*16 / y*16 by the sim.
    case EV_EXPLOSION:
    case EV_PICKUP:
    case EV_CORE_HIT: {
      out[0] = a / 16;
      out[2] = b / 16;
      out[1] = 1.5;
      if (out.length > 3) out[3] = 0;
      return true;
    }
    // Spot index into the map's own lists — always resolvable, no lookup risk.
    case EV_CAPTURE: {
      const spot = map.turretSpots[c];
      if (!spot) return false;
      out[0] = spot.x;
      out[2] = spot.y;
      out[1] = 1.5;
      if (out.length > 3) out[3] = 0;
      return true;
    }
    case EV_SHOT:
    case EV_HIT:
    case EV_DEATH:
    case EV_RESPAWN:
    case EV_TRANSFORM:
      return entityPose(a, out);
    default:
      return false;
  }
}

/** Audio + VFX share the event buffer and the same position resolver. */
function pumpCosmetics(events: typeof sim.events): void {
  buildAudioIndex();
  audio.pump(events, resolveEventPosition);
  fx.pump(events, resolveEventPosition);
  startMorphs(events);
  matchHud?.pumpEvents(events, performance.now());
  // Kills credited to the local player, for the match-end stats row.
  // EV_DEATH.b is the killer's player slot (-1 for unowned deaths).
  const localSlot = views[0]?.slot ?? 0;
  for (let i = 0; i < events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (events.data[o] === EV_DEATH && events.data[o + 2] === localSlot) localKills += 1;
  }
}

/**
 * Starts a mesh morph for every avatar that just changed form.
 *
 * Separate from fx.pump because the two want different things out of the same
 * event: the arcs need a world position and nothing else, while the morph needs
 * the entity id and the form being entered, and would have to resolve a pose it
 * never uses to get them through the fx resolver.
 */
function startMorphs(events: typeof sim.events): void {
  const data = events.data;
  for (let i = 0; i < events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (data[o] !== EV_TRANSFORM) continue;
    avatarMorph.start(data[o + 1], data[o + 2] === 1);
  }
}

function rotateSnapshot(): void {
  const swap = snapPrev;
  snapPrev = snapCurr;
  snapCurr = swap;
  countPrev = countCurr;
  countCurr = writeSnapshot(sim, snapCurr);
  // Per-match scalars for the graphical HUD. Written into a preallocated buffer
  // right beside the entity snapshot so the HUD reads only the snapshot
  // interface (renderer rule 4), never sim internals.
  writeMatchSnapshot(sim, matchSnap);
}

function renderEntities(alpha: number, dtSec: number, simDtSec: number): void {
  // Once per frame, ahead of the sweep that samples it. This is the one place
  // the entity pass runs, however many views the frame ends up drawing. On the
  // SIM's clock, not the frame's — see advanceSimClock.
  avatarMorph.advance(simDtSec);
  for (let i = 0; i < greybox.all.length; i++) {
    greybox.all[i].count = 0;
  }
  if (avatarRig) avatarRig.begin();
  // Readiness cannot change mid-frame, so resolve it once instead of per entity.
  const readyRig = avatarRig?.ready ? avatarRig : null;
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
    const aux = snapCurr[o + 9];

    // Mid-transformation the form on screen is NOT the one in ANIM_HOVER: the
    // sim flips the mode byte on the first tick of the lock, so the snapshot
    // already reads as the destination while the mech is still collapsing out of
    // the form it is leaving. render/morph.ts owns that half-and-half decision.
    let morph: Float32Array | null = null;
    if (archetype === ARCHETYPE.AVATAR) {
      if ((animState & ANIM_TRANSFORMING) === 0) {
        // The lock ended (or was cut short by a death or a rollback) before the
        // client's own clock ran out. The sim is the authority on that.
        avatarMorph.release(id);
      } else if (avatarMorph.sample(id, morphScratch)) {
        morph = morphScratch;
      }
    }
    const drawHover = morph ? morph[MORPH_DRAW_HOVER] === 1 : (animState & ANIM_HOVER) !== 0;

    // Walking avatars go to the three-part walk rig instead of a single bucket
    // instance (render/avatarRig.ts). Hovering ones, and every avatar before the
    // rig's asset lands, keep their bucket.
    const rig = archetype === ARCHETYPE.AVATAR && !drawHover ? readyRig : null;
    // The bucket picks walker vs hover off ANIM_HOVER too, and it is what draws
    // the avatar whenever the rig is unavailable (?render=greybox, or the asset
    // still loading). Hand it the form actually being drawn, or the fallback
    // would swap meshes half a morph before the rig path does.
    const bucketAnim = drawHover ? animState | ANIM_HOVER : animState & ~ANIM_HOVER;
    const bucket = rig ? undefined : bucketFor(greybox, archetype, bucketAnim, aux);
    if (!rig && !bucket) continue;

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

    if (rig) {
      // The rig poses all three of its parts and keeps its own gait state; a
      // false return means it is out of capacity and has already said so.
      rig.place(id, x, height, y, yaw, animState, team, dtSec, morph);
    } else if (bucket) {
      const slot = bucket.count;
      if (slot >= bucket.tintCache.length) {
        // A dropped instance is an entity that shoots at you and is not drawn.
        // Shout once per bucket rather than per frame: verify:arenas fails the run
        // on any console error, so this cannot ship unnoticed again.
        if (!bucket.overflowed) {
          bucket.overflowed = true;
          console.error(
            `[render] instance bucket full at ${bucket.tintCache.length} — entities are not being drawn; raise the capacity in render/greybox.ts`,
          );
        }
        continue;
      }
      bucket.count = slot + 1;

      // sim (x, y, height, yaw) → three (x, height, z, rotationY = -yaw)
      scratchPos.set(x, height, y);
      scratchQuat.setFromAxisAngle(UP, -yaw - (morph ? morph[MORPH_SPIN] : 0));
      if (morph) {
        scratchScale.set(morph[MORPH_SCALE_XZ], morph[MORPH_SCALE_Y], morph[MORPH_SCALE_XZ]);
      } else {
        // Shared module scratch: a morphing avatar earlier in the sweep left its
        // squash in here, and every later instance would inherit it.
        scratchScale.set(1, 1, 1);
      }
      // A shell points where it is going, in the vertical too. The snapshot
      // carries no vertical velocity, but the two ticks being interpolated
      // between do: rise over run across that step IS the flight angle. Costs
      // nothing while projectiles fly flat (the delta is zero, atan2 gives
      // zero) and turns the mortar's arc into a shell that noses over at the
      // top of it. No allocation — both quaternions are module scratch. Never
      // collides with the morph above: a projectile is not an avatar.
      if (archetype === ARCHETYPE.PROJECTILE && hasPrev) {
        const dh = snapCurr[o + 5] - snapPrev[po + 5];
        const dx = snapCurr[o + 3] - snapPrev[po + 3];
        const dy = snapCurr[o + 4] - snapPrev[po + 4];
        const run = Math.sqrt(dx * dx + dy * dy);
        if (dh !== 0 || run !== 0) {
          scratchPitch.setFromAxisAngle(PITCH_AXIS, Math.atan2(dh, run));
          scratchQuat.multiply(scratchPitch);
        }
      }
      scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
      bucket.mesh.setMatrixAt(slot, scratchMatrix);

      if (bucket.tintCache[slot] !== team) {
        bucket.tintCache[slot] = team;
        bucket.mesh.setColorAt(slot, tintFor(team));
        if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
      }
    }
  }
  for (let i = 0; i < greybox.all.length; i++) {
    const b = greybox.all[i];
    b.mesh.count = b.count;
    b.mesh.instanceMatrix.needsUpdate = true;
  }
  if (avatarRig) avatarRig.end();
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
let matchHudLastUpdate = 0;

/**
 * Left inset for the text HUD. Under ?debug both HUDs are on screen and the
 * graphical one's radar owns the top-left corner, so the text clears it —
 * scaffolding moves, the game does not. 160 = radar (132) + its margin.
 */
function textHudInset(): number {
  return matchHud && params.has("debug") ? 160 : 8;
}

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
    sim.winner >= 0
      ? `\nMATCH OVER — ${sim.winner === 0 ? "BLUE" : "RED"} ${
          sim.coreHp.length > 0 ? "RAZED THE BASE" : "BREACHED THE GATE"
        }`
      : "";
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

/**
 * Sim time (in fractional ticks) the previous frame interpolated to, or -1
 * before the first frame and after a discontinuity.
 */
let lastSimTime = -1;

/**
 * How far the SIM moved since the last frame, in seconds — the clock anything
 * timed against a sim window has to use.
 *
 * `dtMs` is capped at 250 ms so a backgrounded tab cannot spiral the
 * accumulator, which means one long frame can hand a wall-clock effect a third
 * of a second in a single go. Harmless for a 0.09 s tracer; ruinous for the
 * transformation, whose 0.8 s has to line up tick for tick with the sim's
 * transform lock or the mech finishes changing shape and then stands frozen.
 *
 * Zero while the sim is paused or has not started, so the pin harness can
 * freeze a transformation mid-swing and photograph it.
 */
function advanceSimClock(alpha: number): number {
  if (!sim) {
    lastSimTime = -1;
    return 0;
  }
  const simTime = sim.tick + alpha;
  // First frame, a new match (tick back to 0) or a rollback: no delta to report,
  // just re-anchor. A negative one would run every live morph backwards.
  if (lastSimTime < 0 || simTime < lastSimTime) {
    lastSimTime = simTime;
    return 0;
  }
  const delta = simTime - lastSimTime;
  lastSimTime = simTime;
  return delta / TICK_HZ;
}

function frame(now: number): void {
  const dtMs = Math.min(now - last, 250);
  // timeScale is 1 everywhere except sandbox slow motion; net matches never see
  // it (the panel is solo-only), so lockstep pacing is unchanged.
  accumulator += dtMs * timeScale; // cap catch-up after tab switch
  last = now;
  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
    // Online matches step only confirmed ticks (net.tryStep); a stall (peer
    // input not yet in) breaks out and the overlay explains the pause.
    // Everything else — offline matches AND the menu/lobby/connecting demo
    // battle — steps locally every tick. All paced at 30 Hz by the accumulator.
    if (phase === "match" && net) {
      // Online keeps stepping while the pause card is up so the peer is not
      // starved; Quit to menu is what leaves the room.
      if (!net.tryStep()) break;
    } else if (sim) {
      if (debugPaused) break; // ?debug harness freeze (metropolisPause)
      if (matchPaused) break; // ESC pause freezes offline / fly / sandbox
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

  // dtSec before renderEntities: the walk rig fades its swing in and out in real
  // seconds (the stride itself is distance-driven — render/avatarRig.ts).
  const dtSec = dtMs / 1000;
  const alpha = accumulator / TICK_MS;
  const simDtSec = advanceSimClock(alpha);
  renderEntities(alpha, dtSec, simDtSec);
  if (views.length === 0) {
    // No views yet: menu / lobby / waiting-for-opponent — flyover over the demo.
    updateFlyoverCamera(flyCam, now / 1000, extent);
    if (phase === "match") fx.update(dtSec, flyCam, simDtSec);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setScissor(0, 0, innerWidth, innerHeight);
    renderScene(flyCam);
  } else {
    // Drain accumulated wheel into the pointer view's rig (scroll up → zoom in
    // → toward ACTION). Only the pointer view takes zoom.
    for (let v = 0; v < views.length; v++) {
      const view = views[v];
      // Chase rig: the mouse heading drives the camera as well as the avatar,
      // and there is nothing left for the wheel to change (camera.spec §3).
      view.camInput.yawAbsolute = mouseLook.yaw;
      view.camInput.zoomDelta = 0;
      if (flyMode && v === 0) {
        // Free-fly debug camera owns view 0's posing (render/flyCamera.ts) —
        // rig and blend are skipped, exactly like orbit below. Skip while the
        // pin modal is open so WASD does not drift under the dialog.
        if (!pinModal.isOpen()) updateFlyCamera(flyState, view.camera, dtSec);
      } else if (orbitControls && v === 0) {
        orbitControls.update();
      } else {
        updateRigCamera(view, dtSec);
        if (blend.active) applyBlend(blend, view.camera, dtSec);
      }
      // Billboards face the local view's camera (view 0); update once after
      // that camera is posed, before any scissored draw.
      if (v === 0 && phase === "match") fx.update(dtSec, view.camera, simDtSec);
      const vp = view.viewport;
      const yBottom = innerHeight - (vp.top + vp.height); // three uses lower-left origin
      renderer.setViewport(vp.left, yBottom, vp.width, vp.height);
      renderer.setScissor(vp.left, yBottom, vp.width, vp.height);
      renderScene(view.camera);
      // Audio listener follows the local view's camera: translation plus the
      // first basis column (its right vector) is all a stereo pan needs. Raw
      // matrix element reads, so no allocation in the frame loop.
      if (v === 0) {
        const e = view.camera.matrixWorld.elements;
        audio.setListener(e[12], e[13], e[14], e[0], e[1], e[2]);
      }
    }
  }

  // Graphical HUD at 10 Hz. It writes only on change and allocates nothing, but
  // the radar still clears and redraws a canvas, so it gets its own cadence
  // rather than riding the frame. 100 ms is under the health bar's 0.18 s
  // transition, so damage still reads as a smooth drain.
  if (matchHud && now - matchHudLastUpdate > 100) {
    matchHudLastUpdate = now;
    matchHud.refresh(matchSnap, snapCurr, countCurr, extent);
    // Match end rides the same cadence: once the sim freezes on a winner, give
    // the banner and the death FX a beat, then put up the end card. Debug
    // camera modes skip it — they exist to look at the world (matchHud is
    // undefined there anyway, which is why this lives inside the guard).
    const endWinner = matchSnap[MATCH_WINNER] | 0;
    if (endWinner < 0) {
      winSeenAtMs = -1; // no winner (or a fresh sim): the clock re-arms
    } else if (winSeenAtMs < 0) {
      winSeenAtMs = now;
    }
    if (winSeenAtMs >= 0 && !matchEndShown && now - winSeenAtMs > MATCH_END_DELAY_MS) {
      showMatchEnd(endWinner);
    }
  }

  hudFrames++;
  if (now - hudLastUpdate > 1000) {
    refreshHud(hudFrames);
    // Debug label piggybacks on the 1 Hz cadence so async texture-load status
    // ("loading..." -> "esrgan"/"missing") surfaces without a keypress.
    refreshDebugLabel();
    // Same cadence for the sandbox readout — it is DOM, not frame-loop work,
    // and it writes only when its text actually moved.
    sandboxPanel?.refresh();
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
  // A rematch must not inherit the previous match's in-flight effects.
  fx.reset();
  resetMatchEnd();
  for (let i = 0; i < inputQueue.length; i++) {
    for (let p = 0; p < MAX_PLAYERS; p++) zeroPlayerInput(inputQueue[i].players[p]);
  }
  countPrev = 0;
  countCurr = writeSnapshot(sim, snapCurr);
  // Refresh the match scalars immediately: the 10 Hz consumer (HUD + match-end
  // detection) must never read the previous sim's winner against the new one.
  writeMatchSnapshot(sim, matchSnap);
  if (params.has("debug")) (globalThis as { metropolisSim?: SimState }).metropolisSim = sim;
}

function startMatch(localPlayers: readonly { slot: number; input: LocalInputSource }[]): void {
  phase = "match";
  setMatchPaused(false);
  views = createPlayerViews(localPlayers, map.spawns, extent);
  // Start facing the way the rig starts: spawn -> arena centre. Otherwise the
  // first tick snaps the avatar to yaw 0 before the player has touched anything.
  mouseLook.dispose();
  mouseLook = createMouseLook(renderer.domElement, { initialYaw: views[0]?.cam.yaw ?? 0 });
  viewBySlot.fill(undefined);
  for (let v = 0; v < views.length; v++) viewBySlot[views[v].slot] = views[v];

  // Graphical HUD for the local player. Skipped in the debug camera modes: they
  // exist to look at the world, and a score readout over a free-fly shot is
  // just in the way. The text HUD stays in all modes for the harnesses.
  //
  // Before layoutViews, not after: the text HUD's inset depends on whether this
  // one exists.
  matchHud?.destroy();
  matchHud =
    flyMode || orbitMode
      ? undefined
      : createMatchHud(views[0]?.slot ?? 0, {
          hasCore: map.bases.some((b) => b.coreHp > 0),
          outpostTotal: map.outpostSpots.length,
        });
  layoutViews(views, "v", innerWidth, innerHeight, textHudInset());

  // The text HUD keeps being written in every mode — globalThis.metropolisHud()
  // is what the e2e and verification-pin harnesses assert against, so its
  // content is a contract (docs/specs/ui.md §2). Once the graphical HUD is up it
  // is just noise on screen, so hide it unless ?debug. textContent is unaffected
  // by the class, so the harnesses read exactly what they always did.
  document.body.classList.toggle("hud-text-hidden", matchHud !== undefined && !params.has("debug"));

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
  if (sandboxMode) ensureSandboxPanel();
  setFlyCrosshairVisible(flyMode && views.length === 1);
  // The mouse reticle only makes sense for a single full-window pointer player
  // — and not at all under touch or fly (fly uses a fixed center crosshair).
  reticle.style.display = views.length === 1 && !touchMode && !flyMode ? "block" : "none";
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
          mouseLook.yaw,
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
      pumpCosmetics(stepped.events);
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
            pumpCosmetics(stepped.events);
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
function handleMenuChoice(choice: MenuChoice, mapId: string, loadout: Loadout): void {
  playerLoadout = loadout;
  const query = buildModeQuery(choice, mapId, loadout);
  const relay = params.get("relay");
  history.pushState(null, "", relay ? `${query}&relay=${encodeURIComponent(relay)}` : query);
  menuHandle?.dismiss();
  // The picked arena becomes the live scene (no-op when unchanged). For net
  // modes this also feeds netConfig's mapId — the host's pick is authoritative.
  rebuildArena(mapId);
  switch (choice.mode) {
    case "solo":
    case "warden": {
      flyMode = false;
      warden = choice.mode === "warden";
      wardenDifficulty = choice.mode === "warden" ? choice.difficulty : 0;
      resetForMatch(
        createSim(map, seed, {
          ...(warden ? { wardenPlayer: 1, wardenDifficulty } : {}),
          loadouts: [playerLoadout],
        }),
      );
      // The flagship transition: one continuous shot from flyover to chase rig.
      if (!orbitMode) beginBlend(blend, flyCam, 1.2);
      startMatch([{ slot: 0, input: localInput }]);
      break;
    }
    case "fly": {
      // Localhost debug: sandbox sim (base + capturable turrets on the map) +
      // free-fly cam. Unit GLBs (incl. turret-standard / turret-defense) already
      // load via loadUnitMeshes when renderMode is mesh (the default).
      flyMode = true;
      warden = false;
      wardenDifficulty = 0;
      resetForMatch(createSim(map, seed, { loadouts: [playerLoadout] }));
      // No flyover→chase blend — fly cam owns posing from the first frame.
      startMatch([{ slot: 0, input: localInput }]);
      break;
    }
    case "sandbox": {
      // The test bench (debug/sandboxPanel.ts): fly cam so you can get an angle
      // on what you spawned, and the idle opponent so nothing walks through the
      // shot. startMatch builds the panel.
      flyMode = true;
      sandboxMode = true;
      opponentMode = "idle";
      warden = false;
      wardenDifficulty = 0;
      resetForMatch(createSim(map, seed, { loadouts: [playerLoadout] }));
      startMatch([{ slot: 0, input: localInput }]);
      break;
    }
    case "online":
      flyMode = false;
      phase = "connecting"; // demo battle keeps running under the net overlay,
      resetForMatch(createDemoSim(map)); // re-seated on the picked arena
      connectOnline(choice.code);
      break;
    case "p2p":
      flyMode = false;
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
    initialLoadout: playerLoadout,
    // Graphics drawer: apply a texture-preference change immediately to the
    // (possibly already loaded) backdrop arena; persisting is menu.ts's job.
    onTexPref: (pref) => {
      texPref = pref;
      texSwitcher?.setVariant(variantOfPref(pref));
      refreshDebugLabel();
    },
    // Bloom applies live to the backdrop; persistence is the drawer's job.
    onBloomPref: setBloom,
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
  post?.setSize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2));
  flyCam.aspect = innerWidth / innerHeight;
  flyCam.updateProjectionMatrix();
  if (views.length > 0) layoutViews(views, "v", innerWidth, innerHeight, textHudInset());
});

// The single persistent frame loop — every phase renders through it.
last = performance.now();
requestAnimationFrame(frame);
