// Sandbox entry: a fixed 30 Hz sim under a variable-rate render loop on the
// chosen arena, driving the ONE local player. Frame loop contract
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
  ARCHETYPE_RADIUS,
  AVATAR_SNAP_CLOAK,
  AVATAR_SNAP_STRIDE,
  AVATAR_SNAPSHOT_LEN,
  createSim,
  createTickInputs,
  DEFAULT_DIFFICULTIES,
  DEFAULT_LOADOUTS,
  EV_CAPTURE,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_PICKUP,
  EV_RESPAWN,
  EV_SHOT,
  EV_TRANSFORM,
  EVENT_STRIDE,
  GUN_SNAP_STRIDE,
  GUN_SNAPSHOT_LEN,
  GUNS,
  getMapById,
  HEAVIES,
  LIFT_SNAP_STRIDE,
  LOCAL_INPUT_DELAY_TICKS,
  type Loadout,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_MAX,
  MATCH_SLOT_LOCK,
  MATCH_SLOT_RESPAWN_TICKS,
  MATCH_SNAPSHOT_LEN,
  MATCH_TICK,
  MATCH_WARDEN_DIFFICULTY,
  MATCH_WINNER,
  MAX_ENTITIES,
  MAX_PLAYERS,
  type MatchConfig,
  matchSlotOffset,
  type PlayerInput,
  RESULTS_SNAPSHOT_LEN,
  SIM_VERSION,
  type SimState,
  SNAPSHOT_STRIDE,
  SPECIALS,
  sampleHeight,
  spawnUnit,
  step,
  TICK_HZ,
  type TickInputs,
  URBAN_JUNGLE_ID,
  wardenLevel,
  worldExtent,
  writeAvatarSnapshot,
  writeGunSnapshot,
  writeLiftSnapshot,
  writeMatchSnapshot,
  writeResultsSnapshot,
  writeSnapshot,
} from "@metropolis/sim";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadedBank } from "./audio/bank";
import { OriginalSounds } from "./audio/cues";
import { AudioEngine } from "./audio/engine";
import {
  FCOP_ARENA_AUDIO,
  FCOP_PLAYER_WEAPONS,
  FCOP_SAMPLE_FILES,
  FCOP_VOICE_FILES,
} from "./audio/fcopAudio.generated";
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
import { makeRaiseAt } from "./effects/chain";
import { loadControls } from "./input/controlsStore";
import { PlayerOneInput } from "./input/keyboard";
import { isTextEntryTarget } from "./input/textEntry";
import type { LocalInputSource } from "./input/types";
import {
  buildModeQuery,
  createInGameMenu,
  difficultyFromParams,
  extraFromParams,
  loadoutFromParams,
  type MenuChoice,
  type MenuHandle,
  recordSoloWin,
  runMenu,
} from "./menu";
import type { GameRules } from "./menu/dialogs/OptionsDialog";
import { createDemoSim, demoFeeder, updateFlyoverCamera, zeroPlayerInput } from "./menuWorld";
import { NetLockstep } from "./net/lockstep";
import { P2pLockstep } from "./net/p2pLockstep";
import { openP2pSession, readP2pBootstrap } from "./net/p2pSession";
import { WsTransport } from "./net/wsTransport";
import { type ArenaUnitsRenderer, createArenaUnits } from "./render/arenaUnits";
import { type AvatarRig, createAvatarRig } from "./render/avatarRig";
import {
  CAMERA_VFOV_DEG,
  ENGINE_HZ,
  gateCrowdControl,
  pressCameraKey,
  stepChaseCamera,
} from "./render/camera";
import { applyBlend, createCameraBlend } from "./render/cameraBlend";
import { applyCameraShake, resetCameraShake, shakeDamage, shakeEffect } from "./render/cameraShake";
import { makeTerrainHit, makeTerrainTrace } from "./render/cameraTrace";
import { setDecalWindow } from "./render/decals";
import {
  cellXOf,
  cellZOf,
  createDrawWindow,
  inDrawWindow,
  inView,
  placeDrawWindow,
} from "./render/drawWindow";
import { lerpGunYaws } from "./render/dreadnoughtGuns";
import { setEmitterWindow } from "./render/emitterProps";
import { createFlyState, initFlyInput, poseFlyStart, updateFlyCamera } from "./render/flyCamera";
import { createFx, createFxPoses, POSE_STRIDE } from "./render/fx";
import { bucketFor, createGreyboxMeshes } from "./render/greybox";
import { type CameraCaption, createCameraCaption } from "./render/hud/caption";
import { createMatchHud, type MatchHud } from "./render/hud/hud";
import { snapshotIndexOf } from "./render/hud/hudRules";
import { loadLifts, updateLifts } from "./render/lifts";
import {
  createMapScreen,
  mapBounds,
  mapWindow,
  panMapScreen,
  toggleMapScreen,
} from "./render/mapScreen";
import { loadMapMesh } from "./render/meshMap";
import { ATMOSPHERE_HEX } from "./render/palette";
import { loadPickups, updatePickups } from "./render/pickups";
import {
  applyChasePose,
  createPlayerViews,
  layoutViews,
  type PlayerView,
} from "./render/playerView";
import { createPost, isSoftwareRenderer, type PostPipeline } from "./render/post";
import { loadProps, updateProps } from "./render/props";
import { createResultsPage } from "./render/results/resultsPage";
import { sideName, sideOfTeam } from "./render/sides";
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
import { aimPitchModel, aimX1, aimYawModel, createX1Walk, tickX1Walk } from "./render/x1Walk";

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
const orbitMode = !netMode && params.get("cam") === "orbit";
// ?cam=fly: free-fly debug camera (render/flyCamera.ts) — noclip navigation for
// inspecting map meshes / unit+turret models. Solo-only, like orbit.
// Mutable: the menu Fly button enables it in-process without a full reload.
let flyMode = !netMode && params.get("cam") === "fly";
// ?sandbox=1: the spawn/weapon test bench (debug/sandboxPanel.ts). Works on any
// arena — it is a mode, not a map. Solo-only for the same reason the ?debug
// hooks are: it mutates sim state between ticks, which would desync the peer
// that did not click. Mutable: the menu Sandbox button enables it in-process.
let sandboxMode = !netMode && params.get("sandbox") === "1";

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
// Player texture preference: Classic (the 1998 texels, the default) or HD (the
// upscaled atlas the .glb names).
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
/**
 * The local human's difficulty, HARD / NORMAL / EASY (0 / 1 / 2): the menu's
 * plates or ?difficulty=hard|easy. Solo only — a net match plays NORMAL.
 */
let playerDifficulty: number = difficultyFromParams(params);
/**
 * The "Spielregeln" extra-weapons mask for a local match (the front end's
 * Preferences, or ?extra=<mask>). Online the host's lobby agrees it.
 */
let playerExtraWeapons: number = extraFromParams(params);
/**
 * SimOptions.extraWeapons (the extra weapons' own wave adds it to the sim):
 * spread into createSim, so it rides along by that name before and after.
 */
function ruleOptions(extraWeapons: number): { extraWeapons: number } {
  return { extraWeapons };
}
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
        difficulties: [playerDifficulty],
        ...ruleOptions(playerExtraWeapons),
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
    metropolisRig?: (slot?: number) => {
      ready: boolean;
      legsFrame: number;
      cockpitFrame: number;
      state: number;
      track: number;
      form: number;
      aimYaw: number;
      aimPitch: number;
    } | null;
    /** Live effect instances per class (render/fx.ts). */
    metropolisFx?: () => ReturnType<typeof fx.debugCounts>;
    /** The world row a round was matched to (effects/rounds.ts), 0 unknown. */
    metropolisRoundRow?: (id: number) => number;
    /**
     * Raises effect (bank, id) at (x, height, z) through the same chain the
     * cues raise through, as a death of `archetype` / `team` would: a
     * screenshot of one record without staging its event. Presentation only.
     */
    metropolisFxRaise?: (
      bank: number,
      id: number,
      x: number,
      height: number,
      z: number,
      archetype: number,
      team: number,
    ) => void;
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

  // X1 readout (render/x1Walk.ts): a screenshot shows a pose; this says which
  // walker state, leg track and frames the sim's machine is on.
  dbg.metropolisRig = (slot = 0) =>
    avatarRig === null
      ? null
      : {
          ready: avatarRig.ready,
          legsFrame: x1Walk.legsFrame[slot],
          cockpitFrame: x1Walk.cockpitFrame[slot],
          state: x1Walk.state[slot],
          track: x1Walk.legsTrack[slot],
          form: x1Walk.form[slot],
          aimYaw: x1Walk.aimYaw[slot],
          aimPitch: x1Walk.aimPitch[slot],
        };
  dbg.metropolisFx = () => fx.debugCounts();
  dbg.metropolisRoundRow = (id) => sounds.effects.rounds.row[id] ?? 0;
  const debugRaise = makeRaiseAt();
  dbg.metropolisFxRaise = (bank, id, x, height, z, archetype, team) => {
    const at = debugRaise;
    at.x = x;
    at.y = height;
    at.z = z;
    at.archetype = archetype;
    at.team = team;
    at.raiserScale = Math.round((ARCHETYPE_RADIUS[archetype] ?? 0.25) * 512) || 0x100;
    sounds.effects.raise(bank, id, at);
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
// The lifts' tops, two ticks for interpolation (writeLiftSnapshot). Sized by the
// arena's lift count when a match starts (sizeLiftSnapshots), never per frame.
let liftPrev = new Float32Array(0);
let liftCurr = new Float32Array(0);

/** (Re)sizes the lift snapshots for `lifts` lifts; false (a no-op) when they fit. */
function sizeLiftSnapshots(lifts: number): boolean {
  const len = lifts * LIFT_SNAP_STRIDE;
  if (liftCurr.length === len) return false;
  liftPrev = new Float32Array(len);
  liftCurr = new Float32Array(len);
  return true;
}

// The Dreadnought guns' yaws, two ticks for interpolation (writeGunSnapshot):
// per entity id, the hull's guns relative to it. Read for a Juggernaut only.
let gunPrev = new Float32Array(GUN_SNAPSHOT_LEN);
let gunCurr = new Float32Array(GUN_SNAPSHOT_LEN);
/** One Juggernaut's gun yaws this frame, between the two ticks (renderEntities). */
const gunYaws = new Float32Array(GUN_SNAP_STRIDE);

// The original's controls: the keyboard on its bindings (input.spec.md). The
// mouse plays no part in a match, and touch waits for the modernisation.
const keyboard = new PlayerOneInput(window);
// The stored bindings (the original's controls.txt; input/controlsStore.ts).
keyboard.setTable(loadControls()[0]);
// The Map Key opens the map screen (render/mapScreen.ts): in a solo match the
// sim pauses with it, as the original's one-viewport game does; online the
// match runs on and only this player's view is parked, its X1 reading no
// buttons, as the original's two-player game parks one view. Under the debug
// cameras (no HUD, no map screen) it pauses a solo match as before.
keyboard.onMap = () => {
  if (phase !== "match" || matchEndShown || inGameMenu.isOpen()) return;
  const view = views[0];
  if (!matchHud || !view) {
    if (!net) setMatchPaused(!matchPaused);
    return;
  }
  const pose = avatarPoses[view.slot];
  toggleMapScreen(mapScreen, pose[0], pose[1]);
  if (mapScreen.open) mapBounds(map, mapBox);
  // The original's pause silences everything (0x00434530); online the match
  // and its sound run on.
  if (!net && !matchPaused) {
    if (mapScreen.open) audio.pause();
    else audio.resume();
  }
};
// The Camera Key cycles the local view's chase camera (render/camera.ts). A
// client-local choice like the original's: the bit never reaches the sim.
keyboard.onCamera = () => {
  const view = views[0];
  if (phase === "match" && view && cameraCaption) pressCameraKey(view.cam, mapScreen.open);
};
const localInput: LocalInputSource = keyboard;
const audio = new AudioEngine();
// Browsers gate audio behind a gesture; the first pointer/key/touch unlocks it.
audio.armUnlock();
/** The original's sound calls, driven by the sim's events (audio/cues.ts). */
const sounds = new OriginalSounds(audio);
// ?debug: the sound module for the console / headless audio checks (read-only).
if (params.has("debug")) (globalThis as { metropolisAudio?: AudioEngine }).metropolisAudio = audio;
/**
 * The debug maps, which have no original of their own (test-128, layered-test),
 * play La Cantina's sounds — the Mp bank (fcop-fidelity.md A20).
 */
const FALLBACK_SOUND_ARENA = "la-cantina";
/** The local eye's 5 x 5 block of cells (render/drawWindow.ts). */
const drawWindow = createDrawWindow();
/** The prop emitters' cells, ground and whether the eye draws them (audio/cues.ts). */
let emitterCellZ = new Int16Array(0);
let emitterCellX = new Int16Array(0);
let emitterHeight = new Float32Array(0);
let emitterDrawn = new Uint8Array(0);
/** A leaf of the block's visibility quadtree is 4 m square: its half diagonal. */
const EMITTER_LEAF_RADIUS = 2.83;
const emitterViewProj = new THREE.Matrix4();

/**
 * `snd_emit_draw_block`'s test, a tick at a time: an emitter is drawn when it
 * hangs in the eye's 5 x 5 block and its leaf is on screen. Null before the
 * block is placed (the listener's range stands in).
 */
function drawnEmitters(): Uint8Array | undefined {
  const view = views[0];
  if (!view || !drawWindow.placed) return undefined;
  const cam = view.camera;
  emitterViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const m = emitterViewProj.elements;
  const data = FCOP_ARENA_AUDIO[map.id] ?? FCOP_ARENA_AUDIO[FALLBACK_SOUND_ARENA];
  const emitters = data?.emitters ?? [];
  for (let k = 0; k < emitterDrawn.length && k < emitters.length; k++) {
    const e = emitters[k];
    emitterDrawn[k] =
      inDrawWindow(drawWindow, emitterCellZ[k], emitterCellX[k]) &&
      inView(m, e.x, emitterHeight[k], e.z, EMITTER_LEAF_RADIUS)
        ? 1
        : 0;
  }
  return emitterDrawn;
}

/** The camera's right vector on the ground, for the listener's pan. */
let listenerRightX = 1;
let listenerRightZ = 0;

/** Points the engine and the cue table at the arena a match starts on. */
function beginMatchSounds(): void {
  const data = FCOP_ARENA_AUDIO[map.id] ?? FCOP_ARENA_AUDIO[FALLBACK_SOUND_ARENA];
  if (!data) return;
  // The load gates: a weapon's sounds load only when either loadout carries it.
  const codes = new Set<number>();
  for (let p = 0; p < MAX_PLAYERS; p++) {
    codes.add(GUNS[sim.loadoutGun[p]]?.code ?? -1);
    codes.add(HEAVIES[sim.loadoutHeavy[p]]?.code ?? -1);
    codes.add(SPECIALS[sim.loadoutSpecial[p]]?.code ?? -1);
  }
  audio.setArena({
    bank: loadedBank(data.bank, codes),
    sampleUrls: FCOP_SAMPLE_FILES,
    voiceUrls: FCOP_VOICE_FILES,
    musicUrl: data.music,
  });
  sounds.begin(data, FCOP_PLAYER_WEAPONS, map.lifts, map.id);
  // Where each prop emitter hangs, for `snd_emit_draw_block`'s claim.
  const n = data.emitters.length;
  emitterCellZ = Int16Array.from(data.emitters, (e) => cellZOf(e.x));
  emitterCellX = Int16Array.from(data.emitters, (e) => cellXOf(e.z));
  emitterHeight = Float32Array.from(data.emitters, (e) => sampleHeight(map, e.x, e.z));
  emitterDrawn = new Uint8Array(n);
  // The effects' trail texels are the arena's own tex10 (render/fx.ts).
  fx.begin(map.id);
  audio.startMatch();
}

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
// its ground console, then runner bursts forever (a press per runner). Used for solo
// ?opponent play AND the menu demo battle's slot 0; the (slot-aware) script
// itself lives in menuWorld.ts, shared by both.
//
// Sandbox defaults to "idle": a feeder streaming runners across the arena is
// exactly the noise you do not want while watching one unit's walk cycle. An
// explicit ?opponent= still wins, so the feeder is one URL away.
// `let`: the menu's Sandbox button switches modes in-process.
let opponentMode = warden ? "idle" : (params.get("opponent") ?? (sandboxMode ? "idle" : "feeder"));

function scriptOpponent(sim: SimState, slot: number, out: PlayerInput): void {
  if (opponentMode === "feeder") demoFeeder(sim, slot, out);
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
/** The arena's own unit models (render/arenaUnits.ts); set once the buckets exist. */
let arenaUnits: ArenaUnitsRenderer | null = null;
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
    // The greybox's water stand-in. The textured arena carries the original's
    // own water plates (Hk, Ovmp), so a plane at `waterLevel` over the whole
    // extent would only fight them.
    group.add(buildWaterPlane(m));
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
    // The materials callback arms the texture-variant switcher (the Textures
    // option, and the debug hotkeys 0/1/2). The mesh loads with the preferred
    // atlas already in place, so a Classic player never fetches the HD one.
    const loadedAs = variantOfPref(texPref);
    loadMapMesh(
      m,
      group,
      () => {
        buildGreyboxTerrain();
        buildGreyboxStructures();
      },
      (materials) => {
        texSwitcher = createVariantSwitcher(m.id, materials, loadedAs);
        // Player preference first (boot AND every map swap; it may have changed
        // while the mesh loaded); the debug hotkeys can still override it
        // temporarily afterwards.
        texSwitcher.setVariant(variantOfPref(texPref));
        refreshDebugLabel();
      },
      stale,
      loadedAs === "original",
    );
    // Original scenery actors, on the mesh path only: they are the arena's own
    // art, so they belong with the textured terrain and not on top of greybox
    // blocks (render/props.ts). No-op on a map of no mission (test-128).
    loadProps(m, group, stale);
    // The arena's own units: its mission's Cobjs and texture pages, swapped
    // into the unit buckets (render/arenaUnits.ts). Null on the first build,
    // which runs before the buckets exist; boot loads that arena below.
    arenaUnits?.load(m, stale, true);
    if (showGreyboxStructures) buildGreyboxStructures();
  } else {
    // The stand-ins keep their boxes but take the arena's sides.
    arenaUnits?.load(m, stale, false);
    buildGreyboxTerrain();
    buildGreyboxStructures();
  }
  // The pickups and the lifts wear the original's models on either path: they
  // are gameplay, not scenery (render/pickups.ts, render/lifts.ts).
  loadPickups(m, group, stale);
  loadLifts(m, group, stale);
  return group;
}
let arenaGroup = buildArenaGroup(map);
scene.add(arenaGroup);
const greybox = createGreyboxMeshes(scene);
// The original's weapon effects (render/fx.ts): the effect chain's other
// listener, beside the sounds (audio/cues.ts raises every install once for
// both). Render-only — nothing reaches the sim.
const fxPoses = createFxPoses();
/**
 * A dying archetype's model for the shatter: its greybox bucket's current mesh
 * and the texture offset its team's instances carry (render/arenaUnits.ts).
 */
const shatterModel = {
  geometry: new THREE.BufferGeometry(),
  material: null as unknown as THREE.Material,
  teamU: 0,
  teamV: 0,
};
const shatterUv = new Float32Array(2);
const fx = createFx(scene, sounds.effects, {
  poses: fxPoses,
  ground: (x, z) => sampleHeight(map, x, z),
  shatter: (archetype, team) => {
    const b = bucketFor(greybox, archetype, 0, 0);
    if (!b) return null;
    shatterModel.geometry = b.mesh.geometry;
    shatterModel.material = b.mesh.material as THREE.Material;
    const offset = units.teamUv(b, team, shatterUv);
    shatterModel.teamU = offset ? shatterUv[0] : 0;
    shatterModel.teamV = offset ? shatterUv[1] : 0;
    return shatterModel;
  },
  viewportHeight: () => renderer.domElement.height,
});
// Instantiate the composer only when bloom actually starts on — its render
// targets are the cost, and a SwiftShader run never pays it.
if (bloomOn) setBloom(true);
// Stage B unit models upgrade the greybox buckets in place as they load;
// missing assets keep their greybox mesh (render/unitMeshes.ts). The X1 and the
// projectiles at boot, the arena's own units with the arena.
if (renderMode === "mesh") loadUnitMeshes(greybox);
arenaUnits = createArenaUnits(scene, greybox);
{
  const bootEpoch = arenaEpoch;
  arenaUnits.load(map, () => arenaEpoch !== bootEpoch, renderMode === "mesh");
}
/** Non-null from here on: the frame loop's handle on the arena's units. */
const units: ArenaUnitsRenderer = arenaUnits;
// The X1s come off the greybox buckets and onto the rig once avatar-x1.glb and
// its bone table have loaded (render/avatarRig.ts): one mesh, posed by the
// original's frames, walker, transform and hover alike. Until then — and
// forever in ?render=greybox — the buckets keep drawing them.
// `?x1rig=off` keeps them there, the RE's two rest poses, for a side-by-side.
const avatarRig: AvatarRig | null =
  renderMode === "mesh" && params.get("x1rig") !== "off" ? createAvatarRig(scene) : null;
// The X1s' frames and codes per player slot (render/x1Walk.ts): the sim's
// walker machine, read once a sim tick off the avatar snapshot (animateAvatars).
const x1Walk = createX1Walk();
/** The X1's per-slot snapshot (sim avatarSnapshot.ts), refilled every tick. */
const avatarSnap = new Float32Array(AVATAR_SNAPSHOT_LEN);

let extent = worldExtent(map);
/** The chase cameras' line-of-sight test over the arena's ground and decks. */
let chaseTrace = makeTerrainTrace(map);
/** The lock beam's first terrain hit toward its target (hud_draw_lock_beam). */
let lockHit = makeTerrainHit(map);

/**
 * Online only: the server's MSG_WELCOME config is authoritative. If it names a
 * different arena than this client's URL, rebuild map, extent and the static
 * scene BEFORE the views/cameras are created — render must match the sim.
 */
function rebuildArena(mapId: string): void {
  if (mapId === map.id) return;
  map = getMapById(mapId);
  extent = worldExtent(map);
  chaseTrace = makeTerrainTrace(map);
  lockHit = makeTerrainHit(map);
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

const scratchQuat = new THREE.Quaternion();
const scratchPitch = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
/**
 * Local axis a nose pitches about. Models are baked +Z -> +X (unitMeshes.ts), so
 * after the yaw rotation a shell's nose is local +X and rolling about local +Z
 * lifts it toward +Y.
 */
const PITCH_AXIS = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;

/**
 * The occlusion trace's anchor above the avatar's feet, m: the original traces
 * from the mech's model point (+0x5c); 0.5 m is the walker's middle, which keeps
 * a trace from starting inside a slope it stands on.
 */
const CHASE_ANCHOR_LIFT = 0.5;
/** The camera caption (render/hud/caption.ts), present while a chase camera is. */
let cameraCaption: CameraCaption | undefined;

/** The Map Key's map screen (render/mapScreen.ts): client-local view state. */
const mapScreen = createMapScreen();
/** [half width m, half height m, CSS px a sample] of the map window. */
const mapWin = new Float64Array(3);
/** The world the window stays inside, [minX, maxX, minY, maxY] (mapBounds). */
const mapBox = new Float64Array(4);
/** The keyboard's word for the map screen's pan, sampled per frame. */
const panInput = createTickInputs().players[0];
/** Straight down onto the window: screen right is +x, screen down +y (three +z). */
const mapCam = new THREE.OrthographicCamera(-16, 16, 12, -12, 1, 1000);
mapCam.up.set(0, 0, -1);
mapCam.matrixAutoUpdate = true;
/** The map camera's height over the arena, m: above every deck. */
const MAP_CAM_HEIGHT = 400;
/** Scene children hidden for the top-down render (reused; no per-frame growth). */
const mapHidden: THREE.Object3D[] = [];
const MAP_CLEAR = new THREE.Color(0, 0, 0);
const savedClear = new THREE.Color();

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

// --- In-match pause (ESC) and the original's in-game menu --------------------
// Escape opens the original's in-game menu, dialog 0xa6 (menu/inGame.tsx): a
// Preact island outside the frame loop (docs/specs/ui.md §1). Solo it freezes
// the sim and silences the sound, as the original's step before its modal
// dialog does (0x00407d70); online the lockstep runs on behind it so the peer
// is not starved (fcop-fidelity.md F16).
let matchPaused = false;
/** Suppresses opening the in-game menu on the same ESC that released pointer lock. */
let suppressPauseForUnlock = false;

const inGameMenu = createInGameMenu({
  audio,
  onResume: () => {
    setMatchPaused(false);
    refreshCapture();
  },
  onAbort: () => returnToMenu(),
  // The controls screen saved; player 1's table applies at once.
  onControls: (tables) => keyboard.setTable(tables[0]),
});

/** Opens the in-game menu; solo, the match stops under it. */
function openInGameMenu(): void {
  if (inGameMenu.isOpen()) return;
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.style.cursor = "default";
  flyState.keys.clear();
  inGameMenu.open();
  if (!net) setMatchPaused(true, true);
  refreshCapture();
}

/** The bound keys are the game's only while it is live, not paused and no menu is up. */
function refreshCapture(): void {
  keyboard.capture = !matchPaused && !inGameMenu.isOpen() && isMatchLive() && !matchEndShown;
  if (keyboard.capture) document.body.style.cursor = "";
}

// --- The results page -----------------------------------------------------------
// The original's page (render/results/resultsPage.ts; fcop-fidelity.md V7),
// opened as the sim freezes on a winner — the outro was the original's
// countdown — on the figures of that moment. Its two keys are the way out: the
// Map Key plays again (the next level after a solo win against the Sky
// Captain), the Camera Key quits; online only the Camera Key.
const results = createResultsPage({
  bindings: () => keyboard.getTable(),
  onAgain: () => rematchSolo(),
  onQuit: () => returnToMenu(),
});
/** The results page's figures, read once when it opens (writeResultsSnapshot). */
const resultsSnap = new Float32Array(RESULTS_SNAPSHOT_LEN);

/** -1 until a winner is first seen; then the wall-clock ms it was seen at. */
let winSeenAtMs = -1;
let matchEndShown = false;
/** The original opens its page on the frame the countdown runs out. */
const MATCH_END_DELAY_MS = 0;

function resetMatchEnd(): void {
  winSeenAtMs = -1;
  matchEndShown = false;
  results.close();
}

function showMatchEnd(winner: number): void {
  matchEndShown = true;
  inGameMenu.close();
  setMatchPaused(false); // the page replaces the in-game menu, never stacks
  mapScreen.open = false;
  const slot = views[0]?.slot ?? 0;
  // A solo win over the Sky Captain moves the map's progress (0x00409630).
  if (warden && !net && winner === slot) recordSoloWin(map.id, wardenDifficulty);
  writeResultsSnapshot(sim, resultsSnap);
  // LEVEL is the Sky Captain's, one viewport only; the next round after a win
  // plays the level above it (results.c 0x00408121).
  const level = warden && !netMode ? matchSnap[MATCH_WARDEN_DIFFICULTY] | 0 : 0;
  if (level > 0 && winner === 0) wardenDifficulty = wardenLevel(level + 1) + 1;
  const sides: [number, number] = [sideOfTeam(map.id, 0), sideOfTeam(map.id, 1)];
  results.open({ figures: resultsSnap, winner, online: netMode, level, sides });
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.style.cursor = "default";
  keyboard.capture = false;
}

/** Seed of the running local match; each rematch derives the next from it. */
let matchSeed = seed;

/** Offline rematch: same arena, same opponent, a fresh derived seed. */
function rematchSolo(): void {
  if (netMode) return;
  resetMatchEnd();
  // Derived from the PREVIOUS match's seed, not the boot constant: seeding
  // from (bootSeed + tick) alone has a fixed point — two matches of equal
  // length would replay the same AI match move for move, forever.
  matchSeed = (matchSeed * 0x9e3779b9 + sim.tick + 1) >>> 0;
  resetForMatch(
    createSim(map, matchSeed, {
      ...(warden ? { wardenPlayer: 1, wardenDifficulty } : {}),
      loadouts: [playerLoadout],
      difficulties: [playerDifficulty],
      ...ruleOptions(playerExtraWeapons),
    }),
  );
  startMatch([{ slot: 0, input: localInput }]);
}

function isMatchLive(): boolean {
  return phase === "match" || phase === "connecting";
}

function setMatchPaused(paused: boolean, menu = false): void {
  if (paused === matchPaused) return;
  matchPaused = paused;
  // The pause (0x00434530): everything silenced, the pause's sound. The
  // in-game menu (0x00407d70) silences without one. Online the match runs on
  // behind the dialog, and so does its sound.
  if (!net && phase === "match") {
    if (paused && menu) audio.suspend();
    else if (paused) audio.pause();
    else if (!mapScreen.open) audio.resume(); // the map screen keeps its pause
  }
  if (paused) {
    if (document.pointerLockElement) document.exitPointerLock();
    flyState.keys.clear();
  }
  refreshCapture();
}

/**
 * Tear down a live match (or connecting lobby) and remount the title menu over
 * a fresh demo backdrop. Works for solo, online, fly and sandbox.
 */
function returnToMenu(): void {
  inGameMenu.close();
  setMatchPaused(false);
  mapScreen.open = false;
  audio.stopMatch();
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
  cameraCaption?.destroy();
  cameraCaption = undefined;
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
  flyMode = false;
  sandboxMode = false;
  warden = false;
  wardenDifficulty = 0;
  // Menu backdrop uses the AI feeder so the live arena stays lively.
  opponentMode = "feeder";
  timeScale = 1;
  debugPaused = false;
  setFlyCrosshairVisible(false);
  keyboard.capture = false;
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

  if (!document.querySelector(".menu-root")) menuHandle = runMenu(menuOptions());
  refreshDebugLabel();
}

document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement) {
    // Canvas recaptured — hide the system cursor again.
    if (isMatchLive() && !matchPaused && !inGameMenu.isOpen()) document.body.style.cursor = "";
    return;
  }
  if (!isMatchLive() || matchPaused || inGameMenu.isOpen()) return;
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
  // The results page answers only its two keys (render/results/resultsPage.ts).
  if (matchEndShown) return;
  // The in-game menu's procedure ignores IDCANCEL: Escape opens it, and only
  // Resume Game closes it.
  openInGameMenu();
});

// --- Debug tooling: texture-variant switcher + fly-cam label -------------------
// Armed by buildArenaGroup's onMaterials callback (mesh render path only).
// Hotkeys 0/1/2 swap the map's atlas texture between the shipped default and
// the original/esrgan variants (render/texVariants.ts, 404-tolerant).
let texSwitcher: VariantSwitcher | null = null;
const flyState = createFlyState();

// Small fixed DOM label (overlay idiom: only write on change). Shows the fly
// controls and the active texture variant while debugging.
// Top centre, which the original's HUD leaves empty: the HUD is the game, this
// is scaffolding, so the scaffolding is what moves.
const debugLabelEl = document.createElement("div");
debugLabelEl.style.cssText =
  "position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:30;padding:4px 8px;" +
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
    parts.push(`${texSwitcher.status()}  [0]=hd [1]=original [2]=esrgan`);
  }
  if (flyMode) {
    parts.push("fly: WASD+QE move, Shift fast, click=mouse-look");
    parts.push("pin: P = capture + problem note (Shift+P pauses sim)");
  }
  if (sandboxMode) parts.push("sandbox: F2 = spawn + weapon panel");
  if (phase === "match" || phase === "connecting") {
    parts.push(flyMode ? "ESC: release mouse · game menu" : "ESC: game menu");
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
            legsFrame: avatarRig.legsAt(0),
            cockpitFrame: avatarRig.cockpitAt(0),
            state: x1Walk.state[views[0]?.slot ?? 0],
            track: x1Walk.legsTrack[views[0]?.slot ?? 0],
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
  if (e.code === "Digit0") texSwitcher.setVariant("hd");
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

// Per-player avatar render state, filled by renderEntities for the chase
// cameras: [threeX, threeZ, height, found(0/1), hover(0/1), yaw], all
// interpolated; yaw is the hull heading (sim radians).
const avatarPoses: Float32Array[] = [];
for (let p = 0; p < MAX_PLAYERS; p++) avatarPoses.push(new Float32Array(6));

function wrapAngleDelta(d: number): number {
  return ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

// Set once the match starts (after the lobby, if any).
let views: PlayerView[] = [];
let matchHud: MatchHud | undefined;
const viewBySlot: (PlayerView | undefined)[] = new Array(MAX_PLAYERS).fill(undefined);
let orbitControls: OrbitControls | undefined;

function runTick(): void {
  // Sample every slot into the delayed frame: local humans from their device,
  // the Warden slot left alone (the sim ignores it), everything else scripted.
  const futureTick = sim.tick + LOCAL_INPUT_DELAY_TICKS;
  const queued = inputQueue[futureTick % QUEUE_SIZE];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const view = viewBySlot[p];
    if (view) {
      view.input.sample(queued.players[p]);
      // A parked view's X1 reads no buttons (player.c:1420, player_fire.c:864).
      if (mapScreen.open && view === views[0]) queued.players[p].buttons = 0;
    } else if (p !== sim.wardenPlayer) scriptOpponent(sim, p, queued.players[p]);
  }

  step(sim, inputQueue[sim.tick % QUEUE_SIZE]);
  // Sandbox cheat toggles (infinite ammo / invulnerable), applied AFTER the tick
  // so the tick itself never sees them — same host-side contract as
  // metropolisSpawn. Null unless ?sandbox=1, so a normal match pays nothing.
  sandboxPanel?.afterTick();
  animateAvatars(sim);
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
    case EV_PICKUP: {
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

/** Audio + VFX share the event buffer; VFX resolves positions here. */
function pumpCosmetics(events: typeof sim.events): void {
  buildAudioIndex();
  pumpShake(events);
  pumpSounds(events);
  fx.pump(events, resolveEventPosition);
}

/**
 * The camera shake's damage half (render/cameraShake.ts): a new avatar is a
 * `player_reset`, and every hit on a view's X1 is `player_take_amount`'s share
 * against the X1's health, halved by Precinct Assault's team-game word.
 */
function pumpShake(events: typeof sim.events): void {
  const d = events.data;
  for (let v = 0; v < views.length; v++) {
    const view = views[v];
    const o = matchSlotOffset(view.slot);
    const avatar = matchSnap[o + MATCH_SLOT_AVATAR_ID] | 0;
    if (avatar !== view.shake.avatar) resetCameraShake(view.shake, avatar);
    if (avatar < 0) continue;
    const maxHp = matchSnap[o + MATCH_SLOT_HP_MAX];
    for (let i = 0; i < events.count; i++) {
      const e = i * EVENT_STRIDE;
      if (d[e] !== EV_HIT || d[e + 1] !== avatar) continue;
      shakeDamage(view.shake, d[e + 3], maxHp, PA_TEAM_GAME);
    }
  }
}

/**
 * Mission-state word 23, which every Precinct Assault mission sets: it halves
 * the damage share (`player_take_amount`) and keeps damage off the other slot.
 */
const PA_TEAM_GAME = true;
/** Scratch for the shake's X1 position (an effect install within 0x20000 of it). */
const shakePose = new Float32Array(3);
/**
 * The camera shake's effect half (`cact_effect_install` 0x0042d248): an install
 * whose record carries +0x32 bit 4 or 13 shakes team slot 0's X1 and, in the
 * two-viewport network game, slot 1's — so every local view here.
 */
sounds.effects.addListener({
  install(_bank, _id, rec, at) {
    if (!rec) return;
    for (let v = 0; v < views.length; v++) {
      const view = views[v];
      const avatar = view.shake.avatar;
      if (avatar < 0 || !entityPose(avatar, shakePose)) continue;
      shakeEffect(
        view.shake,
        rec.flags,
        at.x - shakePose[0],
        at.y - shakePose[1],
        at.z - shakePose[2],
      );
    }
  },
});

/** Scratch for the listener's position (the local mech, `snd_set_listener`). */
const listenerPose = new Float32Array(3);

/**
 * One tick of the original's sound calls. The listener is the local mech
 * (retail hands `snd_set_listener` the actor's position) facing the camera's
 * way; while the mech is down it stays where it last stood.
 */
function pumpSounds(events: typeof sim.events): void {
  const localSlot = views[0]?.slot ?? 0;
  const avatar = matchSnap[matchSlotOffset(localSlot) + MATCH_SLOT_AVATAR_ID];
  if (entityPose(avatar, listenerPose)) {
    audio.setListener(listenerPose[0], listenerPose[2], listenerRightX, listenerRightZ);
  }
  const level = matchSnap[MATCH_WARDEN_DIFFICULTY] - 1;
  sounds.tick(events, {
    snapshot: snapCurr,
    count: countCurr,
    stride: SNAPSHOT_STRIDE,
    match: matchSnap,
    localSlot,
    captainSlot: sim.wardenPlayer,
    captainLevel: level > 0 ? level : 0,
    lifts: liftCurr,
    walker: x1Walk,
    ground: groundUnder,
    emitterDrawn: drawnEmitters(),
  });
}

/** The ground under (x, z) on the arena in play (an effect with no height of its own). */
function groundUnder(x: number, z: number): number {
  return sampleHeight(map, x, z);
}

/**
 * One sim tick of the X1s' animation (render/x1Walk.ts): the avatar snapshot,
 * the sim machine's frames, form and codes off it, then the cockpit's aim. Runs
 * after every sim step and before the sounds, which play the legs' codes the
 * same tick (audio/cues.ts).
 */
function animateAvatars(stepped: SimState): void {
  writeAvatarSnapshot(stepped, avatarSnap);
  tickX1Walk(x1Walk, avatarSnap);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const avatar = matchSnap[matchSlotOffset(p) + MATCH_SLOT_AVATAR_ID] | 0;
    const lock = matchSnap[matchSlotOffset(p) + MATCH_SLOT_LOCK] | 0;
    const a = avatar >= 0 ? snapshotIndexOf(snapCurr, countCurr, avatar) : -1;
    const t = lock >= 0 && a >= 0 ? snapshotIndexOf(snapCurr, countCurr, lock) : -1;
    if (a < 0 || t < 0) {
      aimX1(x1Walk, p, false, 0, 0, 0, 0);
      continue;
    }
    const ao = a * SNAPSHOT_STRIDE;
    const to = t * SNAPSHOT_STRIDE;
    // From the cockpit's mount to the target's middle (the lock beam's end).
    const mount = avatarRig ? avatarRig.mountHeight(x1Walk.legsFrame[p]) : 0;
    aimX1(
      x1Walk,
      p,
      true,
      snapCurr[to + 3] - snapCurr[ao + 3],
      snapCurr[to + 4] - snapCurr[ao + 4],
      snapCurr[to + 5] + LOCK_TO_LIFT - (snapCurr[ao + 5] + mount),
      snapCurr[ao + 6],
    );
  }
}

function rotateSnapshot(): void {
  const swap = snapPrev;
  snapPrev = snapCurr;
  snapCurr = swap;
  countPrev = countCurr;
  countCurr = writeSnapshot(sim, snapCurr);
  // The tick's launches meet the rounds they spawned (effects/rounds.ts).
  sounds.effects.rounds.bind(snapCurr, countCurr, SNAPSHOT_STRIDE);
  // Per-match scalars for the graphical HUD. Written into a preallocated buffer
  // right beside the entity snapshot so the HUD reads only the snapshot
  // interface (renderer rule 4), never sim internals.
  writeMatchSnapshot(sim, matchSnap);
  // The demo battles and the menu's arena previews swap the arena without a
  // match start, so the lift snapshots size themselves here (a no-op when they
  // fit; it allocates only when the arena's lift count changes).
  const fresh = sizeLiftSnapshots(map.lifts.length);
  const liftSwap = liftPrev;
  liftPrev = liftCurr;
  liftCurr = liftSwap;
  writeLiftSnapshot(sim, liftCurr);
  if (fresh) liftPrev.set(liftCurr);
  const gunSwap = gunPrev;
  gunPrev = gunCurr;
  gunCurr = gunSwap;
  writeGunSnapshot(sim, gunCurr);
}

function renderEntities(alpha: number, simDtSec: number): void {
  // Once per frame, ahead of the sweep that samples it. This is the one place
  // the entity pass runs, however many views the frame ends up drawing. On the
  // SIM's clock, not the frame's — see advanceSimClock.
  updatePickups(matchSnap, alpha);
  updateLifts(liftPrev, liftCurr, alpha);
  for (let i = 0; i < greybox.all.length; i++) {
    greybox.all[i].count = 0;
  }
  // The Sky Captain's model is its level's (match config, via the snapshot).
  units.setCaptainLevel(wardenLevel(matchSnap[MATCH_WARDEN_DIFFICULTY]));
  units.begin(simDtSec);
  if (avatarRig) avatarRig.begin();
  // Readiness cannot change mid-frame, so resolve it once instead of per entity.
  const readyRig = avatarRig?.ready ? avatarRig : null;
  // The cloak's v offset: the frame clock (300 Hz units) >> 2 & 0x3f
  // (RE player_partner.c 289-293), on the sim's clock as the original's is.
  const cloakV = (Math.floor((matchSnap[MATCH_TICK] + alpha) * (ENGINE_HZ / TICK_HZ)) >> 2) & 0x3f;
  for (let p = 0; p < MAX_PLAYERS; p++) avatarPoses[p][3] = 0;
  fxPoses.live.fill(0);
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

    // Every X1 — walking, transforming or hovering — goes to the rig, posed by
    // its slot's frames (render/avatarRig.ts, render/x1Walk.ts). Before the
    // rig's asset lands, and in ?render=greybox, the buckets draw it by form.
    const rig = archetype === ARCHETYPE.AVATAR ? readyRig : null;
    // A world round wears its row's model: which launch it came from is the
    // effect chain's round tracker's (effects/rounds.ts).
    const row = archetype === ARCHETYPE.PROJECTILE ? sounds.effects.rounds.row[id] : 0;
    const greyboxBucket = rig ? undefined : bucketFor(greybox, archetype, animState, aux, row);

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
    // Where it is drawn, for the effects that ride it (render/fx.ts).
    if (id >= 0 && id < MAX_ENTITIES) {
      const f = id * POSE_STRIDE;
      fxPoses.table[f] = x;
      fxPoses.table[f + 1] = height;
      fxPoses.table[f + 2] = y;
      fxPoses.table[f + 3] = yaw;
      fxPoses.live[id] = 1;
    }
    // A bolt row's round is its Cobj's line facers (rows 1, 3 and 6), drawn by
    // the effects between the two ticks' positions' heading, not as a mesh.
    if (archetype === ARCHETYPE.PROJECTILE && row > 0) {
      let pitch = 0;
      if (hasPrev) {
        const dh = snapCurr[o + 5] - snapPrev[po + 5];
        const dx = snapCurr[o + 3] - snapPrev[po + 3];
        const dy = snapCurr[o + 4] - snapPrev[po + 4];
        const run = Math.sqrt(dx * dx + dy * dy);
        if (dh !== 0 || run !== 0) pitch = Math.atan2(dh, run);
      }
      if (fx.bolt(row, x, height, y, yaw, pitch)) continue;
    }
    if (!rig && !greyboxBucket) continue;
    // A turret is found by where it stands (render/arenaUnits.ts spotKey): the
    // snapshot's own position, not an interpolation of it.
    const spotX = snapCurr[o + 3];
    const spotY = snapCurr[o + 4];
    const bucket = greyboxBucket && units.route(greyboxBucket, archetype, aux, spotX, spotY);

    // Player avatars (archetype AVATAR, team === player slot) feed that
    // player's chase camera and HUD.
    const team = snapCurr[o + 2];
    if (archetype === ARCHETYPE.AVATAR && team >= 0 && team < MAX_PLAYERS) {
      const pose = avatarPoses[team];
      pose[0] = x; // three x
      pose[1] = y; // three z (sim y)
      pose[2] = height; // three y
      pose[3] = 1; // found
      pose[4] = (animState & ANIM_HOVER) !== 0 ? 1 : 0; // the chase camera's sink
      pose[5] = yaw; // the hull's heading, which the chase camera follows
    }

    if (rig) {
      // The slot's frames once the snapshot has carried this X1, else the
      // reset's pose by form (a spawn this frame). A false return is the rig
      // out of capacity, which has already said so.
      const slot = team >= 0 && team < MAX_PLAYERS ? team : -1;
      const known = slot >= 0 && x1Walk.owner[slot] === id;
      const hovering = (animState & ANIM_HOVER) !== 0;
      const cloaked = slot >= 0 && avatarSnap[slot * AVATAR_SNAP_STRIDE + AVATAR_SNAP_CLOAK] > 0;
      rig.place(
        x,
        height,
        y,
        yaw,
        team,
        known ? x1Walk.legsFrame[slot] : hovering ? 359 : 0,
        known ? x1Walk.cockpitFrame[slot] : hovering ? 29 : 0,
        known ? aimYawModel(x1Walk.aimYaw[slot]) : 0,
        known ? aimPitchModel(x1Walk.aimPitch[slot]) : 0,
        cloaked ? cloakV : -1,
      );
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
      scratchQuat.setFromAxisAngle(UP, -yaw);
      // A shell points where it is going, in the vertical too. The snapshot
      // carries no vertical velocity, but the two ticks being interpolated
      // between do: rise over run across that step IS the flight angle. Costs
      // nothing while projectiles fly flat (the delta is zero, atan2 gives
      // zero) and turns the mortar's arc into a shell that noses over at the
      // top of it. No allocation — both quaternions are module scratch.
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
      // A Dreadnought's guns turn on their mounts, between the two ticks on the
      // shortest arc like the hull's own yaw (render/dreadnoughtGuns.ts).
      if (archetype === ARCHETYPE.JUGGERNAUT) {
        const gunsPrev = hasPrev && snapPrev[po + 1] === archetype;
        lerpGunYaws(gunPrev, gunCurr, id, alpha, gunsPrev, gunYaws);
      }
      // Matrix, parts (a turret's base and a Dreadnought's guns) and team
      // colour (render/arenaUnits.ts).
      units.place(
        bucket,
        slot,
        id,
        archetype,
        team,
        spotX,
        spotY,
        scratchPos,
        scratchQuat,
        scratchScale,
        gunYaws,
      );
    }
  }
  for (let i = 0; i < greybox.all.length; i++) {
    const b = greybox.all[i];
    b.mesh.count = b.count;
    b.mesh.instanceMatrix.needsUpdate = true;
  }
  units.end();
  // The scenery by its outpost's claim: the console until then, the terminals
  // after, the flags in the claimer's half of the page; the cloth's frame on
  // the sim's clock (render/props.ts).
  updateProps(units.outpostSides, matchSnap, simDtSec);
  if (avatarRig) avatarRig.end();
}

/**
 * `world_view_focus` for the local view: the block about the ground focus of
 * its camera over its X1's height; the Props and DCSQuads follow it.
 */
function placeViewWindow(view: PlayerView): void {
  view.camera.updateMatrixWorld();
  const height = avatarPoses[view.slot][2];
  if (placeDrawWindow(drawWindow, view.camera.matrixWorld.elements, height)) {
    setEmitterWindow(drawWindow);
    setDecalWindow(drawWindow);
  }
}

/**
 * The original's chase camera for one view (camera.spec, render/camera.ts): the
 * interpolated avatar is its subject, the frame's real time its clock in the
 * engine's 300 Hz ticks. Client-local render state — reads only the
 * interpolated avatar pose, never the sim. Frozen while the match is paused.
 */
function updateChaseCamera(view: PlayerView, dtSec: number): void {
  const pose = avatarPoses[view.slot];
  if (pose[3] === 0) return; // avatar not present this frame
  const subject = view.subject;
  subject.x = pose[0];
  subject.y = pose[1];
  subject.height = pose[2];
  subject.facing = pose[5];
  subject.hover = pose[4] !== 0;
  // No Precinct Assault arena has a volume trigger (camera.json pa_volume_triggers).
  gateCrowdControl(view.cam, false);
  const ticks = matchPaused ? 0 : dtSec * ENGINE_HZ;
  stepChaseCamera(view.cam, subject, ticks, chaseTrace, CHASE_ANCHOR_LIFT, view.pose);
  // The shake moves the eye only after the trace and the occlusion machine,
  // as the camera tick's last arm does (view_place.c 0x00445d10).
  applyCameraShake(view.shake, ticks, view.pose);
  applyChasePose(view.camera, view.pose);
  // The menu blend animates the fov; the chase owns it again afterwards.
  if (view.camera.fov !== CAMERA_VFOV_DEG) {
    view.camera.fov = CAMERA_VFOV_DEG;
    view.camera.updateProjectionMatrix();
  }
}

/**
 * The map screen's frame: the pan from the keyboard's word, then the terrain
 * window drawn from straight above (the arena alone: units, effects and the sky
 * are left out, as the original's `draw_pause_map_cell` draws only terrain).
 */
function renderMapScreen(dtSec: number): void {
  const view = views[0];
  if (!view) return;
  mapWindow(innerWidth, innerHeight, mapWin);
  const pose = avatarPoses[view.slot];
  keyboard.sample(panInput);
  const ticks = Math.min(dtSec * ENGINE_HZ, 60);
  panMapScreen(mapScreen, panInput.buttons, ticks, pose[0], pose[1], mapBox, mapWin[0], mapWin[1]);
  mapCam.left = -mapWin[0];
  mapCam.right = mapWin[0];
  mapCam.top = mapWin[1];
  mapCam.bottom = -mapWin[1];
  mapCam.updateProjectionMatrix();
  mapCam.position.set(mapScreen.cx, MAP_CAM_HEIGHT, mapScreen.cy);
  mapCam.lookAt(mapScreen.cx, 0, mapScreen.cy);
  mapCam.updateMatrixWorld();
  mapHidden.length = 0;
  const children = scene.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c === arenaGroup || (c as THREE.Light).isLight || !c.visible) continue;
    c.visible = false;
    mapHidden.push(c);
  }
  const fog = scene.fog;
  const background = scene.background;
  scene.fog = null;
  scene.background = null;
  renderer.getClearColor(savedClear);
  const clearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(MAP_CLEAR, 1);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.setScissor(0, 0, innerWidth, innerHeight);
  renderer.render(scene, mapCam);
  renderer.setClearColor(savedClear, clearAlpha);
  scene.fog = fog;
  scene.background = background;
  for (let i = 0; i < mapHidden.length; i++) mapHidden[i].visible = true;
}

/** The lock's two ends above the entities' feet, m: the X1's gun, the target's middle. */
const LOCK_FROM_LIFT = 0.6;
const LOCK_TO_LIFT = 0.5;

/**
 * The graphical HUD for the local view: the snapshots, the 300 Hz frame clock
 * (sim tick x 10, interpolated) and the X1's interpolated pose for the radar;
 * then the lock beam and reticle onto the posed camera.
 */
function refreshMatchHud(view: PlayerView, alpha: number): void {
  const hud = matchHud;
  if (!hud) return;
  const pose = avatarPoses[view.slot];
  // The frame clock runs on through the map screen's pause (its rings pulse).
  const clock = mapScreen.open
    ? Math.floor(performance.now() * (ENGINE_HZ / 1000))
    : Math.floor((matchSnap[MATCH_TICK] + alpha) * (ENGINE_HZ / TICK_HZ));
  const ov = hud.radar.overview;
  ov.open = mapScreen.open;
  ov.cx = mapScreen.cx;
  ov.cy = mapScreen.cy;
  ov.halfX = mapWin[0];
  ov.halfY = mapWin[1];
  hud.refresh(matchSnap, snapCurr, countCurr, clock, pose[0], pose[1], pose[5]);
  hud.map.draw(
    mapScreen.open,
    matchSnap,
    snapCurr,
    countCurr,
    clock,
    mapScreen.cx,
    mapScreen.cy,
    mapWin[2],
    view.slot,
  );
  if (mapScreen.open) {
    hud.drawLock(view.camera, false, 0, 0, 0, 0, 0, 0, 1);
    return;
  }
  const mine = matchSlotOffset(view.slot);
  const lock = matchSnap[mine + MATCH_SLOT_LOCK] | 0;
  const down = (matchSnap[mine + MATCH_SLOT_RESPAWN_TICKS] | 0) > 0;
  const c = lock >= 0 && !down && pose[3] !== 0 ? snapshotIndexOf(snapCurr, countCurr, lock) : -1;
  if (c < 0) {
    hud.drawLock(view.camera, false, 0, 0, 0, 0, 0, 0, 1);
    return;
  }
  const o = c * SNAPSHOT_STRIDE;
  let tx = snapCurr[o + 3];
  let ty = snapCurr[o + 5];
  let tz = snapCurr[o + 4];
  const p = snapshotIndexOf(snapPrev, countPrev, lock);
  if (p >= 0) {
    const po = p * SNAPSHOT_STRIDE;
    tx = snapPrev[po + 3] + (tx - snapPrev[po + 3]) * alpha;
    ty = snapPrev[po + 5] + (ty - snapPrev[po + 5]) * alpha;
    tz = snapPrev[po + 4] + (tz - snapPrev[po + 4]) * alpha;
  }
  ty += LOCK_TO_LIFT;
  const fx = pose[0];
  const fy = pose[2] + LOCK_FROM_LIFT;
  const fz = pose[1];
  const hit = lockHit(fx, fy, fz, tx, ty, tz);
  hud.drawLock(view.camera, true, fx, fy, fz, tx, ty, tz, hit);
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
      ? `\nMATCH OVER — ${sideName(sideOfTeam(map.id, sim.winner))} BREACHED THE GATE`
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
  let ownOutposts = 0;
  for (let k = 0; k < sim.outpostOwner.length; k++) {
    if (sim.outpostOwner[k] === slot) ownOutposts += 1;
  }
  if (ownOutposts > 0) progress += `  outposts ${ownOutposts}`;
  // The original's side colour of the team (render/sides.ts).
  const tag = sideName(sideOfTeam(map.id, slot));
  return (
    `P${slot + 1} ${tag}  ${status}  points ${sim.points[slot]}  units ${unitCounts[0]}v${unitCounts[1]}${progress}\n` +
    `tick ${sim.tick}  fps ${fps}  entities ${countCurr}  sfx ${audio.lastPlayed || "-"}  map ${map.id}` +
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
 * transformation, whose 1.37 s has to line up tick for tick with the sim's
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
  // A pad's Map Key, polled per frame so it can also resume a paused match.
  keyboard.pollPad();
  // The original's front end has no world behind it: while the menu (or a
  // connecting lobby's status card) is up, nothing is stepped or drawn.
  if (phase !== "match" && views.length === 0) {
    last = now;
    accumulator = 0;
    if (net) refreshOverlay();
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setScissor(0, 0, innerWidth, innerHeight);
    renderer.clear();
    requestAnimationFrame(frame);
    return;
  }
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
      if (mapScreen.open) break; // the Map Key's pause, one viewport
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

  const dtSec = dtMs / 1000;
  const alpha = accumulator / TICK_MS;
  const simDtSec = advanceSimClock(alpha);
  renderEntities(alpha, simDtSec);
  if (views.length === 0) {
    // A match with no views yet (the menu and the connecting card return
    // above): the flyover.
    updateFlyoverCamera(flyCam, now / 1000, extent);
    if (phase === "match") fx.update(dtSec, flyCam, simDtSec);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setScissor(0, 0, innerWidth, innerHeight);
    renderScene(flyCam);
  } else if (mapScreen.open && matchHud) {
    // The map screen in place of the view (view 0 only: one local player).
    renderMapScreen(dtSec);
  } else {
    for (let v = 0; v < views.length; v++) {
      const view = views[v];
      if (flyMode && v === 0) {
        // Free-fly debug camera owns view 0's posing (render/flyCamera.ts) —
        // rig and blend are skipped, exactly like orbit below. Skip while the
        // pin modal is open so WASD does not drift under the dialog.
        if (!pinModal.isOpen()) updateFlyCamera(flyState, view.camera, dtSec);
      } else if (orbitControls && v === 0) {
        orbitControls.update();
      } else {
        updateChaseCamera(view, dtSec);
        if (blend.active) applyBlend(blend, view.camera, dtSec);
        if (v === 0 && cameraCaption) cameraCaption.update(view.cam.name, view.cam.caption > 0);
      }
      // Billboards face the local view's camera (view 0); update once after
      // that camera is posed, before any scissored draw.
      if (v === 0 && phase === "match") fx.update(dtSec, view.camera, simDtSec);
      // The Props and DCSQuads in the eye's 5 x 5 block of cells only.
      if (v === 0 && phase === "match") placeViewWindow(view);
      const vp = view.viewport;
      const yBottom = innerHeight - (vp.top + vp.height); // three uses lower-left origin
      renderer.setViewport(vp.left, yBottom, vp.width, vp.height);
      renderer.setScissor(vp.left, yBottom, vp.width, vp.height);
      renderScene(view.camera);
      // The listener's facing is the local view's camera: its first basis
      // column (the right vector) on the ground plane. Raw matrix element
      // reads, so no allocation in the frame loop.
      if (v === 0) {
        const e = view.camera.matrixWorld.elements;
        listenerRightX = e[0];
        listenerRightZ = e[2];
      }
    }
  }

  // The original's HUD, every frame: each of its canvases redraws only when a
  // value it shows changed (render/hud/hud.ts), the radar and the lock follow
  // the interpolated poses.
  if (matchHud && views.length > 0) refreshMatchHud(views[0], alpha);
  if (matchHud && now - matchHudLastUpdate > 100) {
    matchHudLastUpdate = now;
    // Match end on a 10 Hz cadence: once the sim freezes on a winner the
    // results page opens, as the original's does when its countdown runs out
    // (render/results/resultsPage.ts). Debug camera modes skip it —
    // they exist to look at the world (matchHud is undefined there anyway,
    // which is why this lives inside the guard).
    const endWinner = matchSnap[MATCH_WINNER] | 0;
    if (endWinner < 0) {
      winSeenAtMs = -1; // no winner (or a fresh sim): the clock re-arms
    } else if (winSeenAtMs < 0) {
      winSeenAtMs = now;
    }
    if (winSeenAtMs >= 0 && !matchEndShown && now - winSeenAtMs >= MATCH_END_DELAY_MS) {
      showMatchEnd(endWinner);
    }
  }

  results.frame(now);

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
  // A new match's X1s start from their reset, whatever ids they reuse.
  x1Walk.owner.fill(-1);
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
  sizeLiftSnapshots(map.lifts.length);
  writeLiftSnapshot(sim, liftCurr);
  liftPrev.set(liftCurr);
  writeGunSnapshot(sim, gunCurr);
  if (params.has("debug")) (globalThis as { metropolisSim?: SimState }).metropolisSim = sim;
}

function startMatch(localPlayers: readonly { slot: number; input: LocalInputSource }[]): void {
  phase = "match";
  setMatchPaused(false);
  mapScreen.open = false;
  beginMatchSounds();
  views = createPlayerViews(localPlayers, map.spawns);
  keyboard.capture = true;
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
      : createMatchHud(views[0]?.slot ?? 0, { mapId: map.id, online: netMode });
  matchHud?.layout(innerWidth, innerHeight);
  layoutViews(views, "v", innerWidth, innerHeight, textHudInset());
  // The camera caption rides with the chase camera: not under fly or orbit.
  cameraCaption?.destroy();
  cameraCaption = flyMode || orbitMode ? undefined : createCameraCaption();
  cameraCaption?.layout(innerWidth, innerHeight);

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
      view.input.sample(localInput);
      if (mapScreen.open) localInput.buttons = 0; // the parked view (see runTick)
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
    // The online lobby offers no difficulty pick yet: both players NORMAL.
    difficulties: DEFAULT_DIFFICULTIES,
    loadouts: DEFAULT_LOADOUTS,
    extraWeapons: 0,
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
  let welcomedSlot = -1;

  net = new NetLockstep(new WsTransport(relayUrl(code)), {
    sampleInput: makeNetSampler(),
    onStep: (_tick, stepped) => {
      animateAvatars(stepped);
      pumpCosmetics(stepped.events);
      rotateSnapshot();
    },
    onWelcome: (slotIdx) => {
      welcomedSlot = slotIdx;
    },
    onStart: (started, startedConfig) => {
      netStatus = null;
      refreshOverlay();
      enterNetMatch(startedConfig.mapId, started, welcomedSlot);
    },
    onPeer: (_slot, present) => {
      // Protocol 4: a full room is a lobby; the host seals the setup.
      if (present && welcomedSlot === 0 && net && !net.isStarted) {
        (net as NetLockstep).begin(config);
      }
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
            animateAvatars(stepped);
            pumpCosmetics(stepped.events);
            rotateSnapshot();
          },
          onLinked: () => {
            // Protocol 4: the host seals the setup once linked.
            if (session.slot === 0) p2pNet.begin(session.config);
          },
          onStart: (started, startedConfig) => {
            netStatus = null;
            refreshOverlay();
            enterNetMatch(startedConfig.mapId, started, session.slot);
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
      p2pNet.start();
    })
    .catch((err: unknown) => {
      netStatus = `Lobby ${code}: ${err instanceof Error ? err.message : "connection failed"}`;
      refreshOverlay();
    });
}

/**
 * The agreed config's START: fade the (demo) world into the match sim the
 * lockstep just built, on the host's arena.
 */
function enterNetMatch(mapId: string, matchSim: SimState, slot: number): void {
  if (views.length === 0) {
    fadeCover(() => {
      rebuildArena(mapId);
      resetForMatch(matchSim);
      startMatch([{ slot, input: localInput }]);
    });
  } else {
    rebuildArena(mapId);
    resetForMatch(matchSim);
  }
}

let menuHandle: MenuHandle | undefined;

/** The front end's hooks into the client (menu/index.ts). */
function menuOptions(): Parameters<typeof runMenu>[0] {
  return {
    audio,
    onChoice: handleMenuChoice,
    // START: the arena loads under the loading screen.
    onSelect: previewArena,
    // PREFERENCES' HD textures option applies at once to a loaded arena;
    // persisting is the dialog's job.
    onTexPref: (pref) => {
      texPref = pref;
      texSwitcher?.setVariant(variantOfPref(pref));
      refreshDebugLabel();
    },
    // The controls screen saves the bindings; they apply at once.
    onControls: (table) => keyboard.setTable(table),
  };
}

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
function handleMenuChoice(
  choice: MenuChoice,
  mapId: string,
  loadout: Loadout,
  difficulty: number,
  rules: GameRules,
): void {
  playerLoadout = loadout;
  playerDifficulty = difficulty;
  playerExtraWeapons = rules.extraWeapons;
  const query = buildModeQuery(choice, mapId, loadout, difficulty, rules.extraWeapons);
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
          difficulties: [playerDifficulty],
          ...ruleOptions(playerExtraWeapons),
        }),
      );
      startMatch([{ slot: 0, input: localInput }]);
      break;
    }
    case "fly": {
      // Localhost debug: sandbox sim (base + capturable turrets on the map) +
      // free-fly cam. The arena's unit models (turrets included) already load
      // with the arena when renderMode is mesh (render/arenaUnits.ts).
      flyMode = true;
      warden = false;
      wardenDifficulty = 0;
      resetForMatch(
        createSim(map, seed, {
          loadouts: [playerLoadout],
          difficulties: [playerDifficulty],
          ...ruleOptions(playerExtraWeapons),
        }),
      );
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
      resetForMatch(
        createSim(map, seed, {
          loadouts: [playerLoadout],
          difficulties: [playerDifficulty],
          ...ruleOptions(playerExtraWeapons),
        }),
      );
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
  // Bare URL: the original's front end; a choice starts its mode in-process.
  document.body.style.cursor = "default";
  menuHandle = runMenu(menuOptions());
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
  cameraCaption?.layout(innerWidth, innerHeight);
  matchHud?.layout(innerWidth, innerHeight);
});

// The single persistent frame loop — every phase renders through it.
last = performance.now();
requestAnimationFrame(frame);
