// Verification-pin capture orchestration — the one path both the human hotkey
// (P in fly mode) and the agent hook (metropolisPin) go through.
//
// Why it is shared: a reshoot is only worth anything if the follow-up pin is
// field-for-field comparable with the original. Two capture paths would drift
// apart on the first change to either.
//
// Impure by design (renderer, canvas, console, DOM); the arithmetic lives in
// pinCapture.ts, which stays DOM-free and unit-tested. Debug-only — nothing
// here runs in the frame loop, so it may allocate, and nothing in the sim or
// renderer reads it back.

import type { MapData, SimState } from "@metropolis/sim";
import { hash } from "@metropolis/sim";
import type * as THREE from "three";
import { OrthographicCamera } from "three";
import type { FlyState } from "../render/flyCamera";
import {
  type BuildPinInput,
  buildPin,
  buildPinPrompt,
  type ConsoleRing,
  createConsoleRing,
  findEntities,
  findNearby,
  pinIdFromCreatedAt,
  rayHitHeightfield,
} from "./pinCapture";
import { captureCanvasPng, DEFAULT_PIN_SERVER, exportPin } from "./pinExport";
import type { PinConsoleEntry, PinShot, VerificationPin } from "./pinTypes";

/** Half-extent (world units) the top-down shot covers vertically around the hit. */
const TOP_HALF_EXTENT = 64;
/** Height above the hit for the top-down camera; ortho, so only clipping cares. */
const TOP_HEIGHT = 400;

/** Reused across captures — posed, then updateMatrixWorld'd, per shot. */
const topCam = new OrthographicCamera(-1, 1, 1, -1, 0.1, TOP_HEIGHT * 4);

// vite `define`; undefined when a client module is imported straight into bun.
const COMMIT: string | null =
  typeof __COMMIT__ === "string" && __COMMIT__.length > 0 ? __COMMIT__ : null;

/**
 * Shared console tail. A module singleton on purpose: the arena mesh loads (and
 * warns "[meshMap] no mesh asset") during boot, well before the pin session is
 * built, so capture has to be armable earlier than the session exists.
 */
export const pinConsoleRing: ConsoleRing = createConsoleRing();

export interface PinViewport {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PinSessionDeps {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  /** View 0's camera + viewport, or null before the views exist. */
  readonly getView0: () => { camera: THREE.PerspectiveCamera; viewport: PinViewport } | null;
  readonly getMap: () => MapData;
  readonly getSim: () => SimState | null;
  /** Current snapshot buffer + entity count (architecture.md §3). */
  readonly getSnapshot: () => { snap: Float32Array; count: number };
  readonly flyState: FlyState;
  readonly renderMode: string;
  readonly seed: number;
  readonly getTexVariant: () => string | null;
  readonly greyboxStructures: boolean;
  readonly setPaused: (paused: boolean) => void;
  readonly getPaused: () => boolean;
  /** Defaults to the module singleton armed at boot; injectable for tests. */
  readonly consoleRing?: ConsoleRing;
  /**
   * Where to POST the pin. Defaults to the standard `bun run pin:serve` port;
   * `?pinServer=<url>` overrides it so pin:drive can point its own headless
   * client at the receiver it runs itself — a headless browser has nowhere to
   * put the download fallback.
   */
  readonly pinServerUrl?: string;
}

export interface PinShotBlob {
  readonly meta: PinShot;
  readonly blob: Blob;
}

/** Everything a pin needs except the notes — captured before the modal opens. */
export interface PinFrame {
  readonly shots: readonly PinShotBlob[];
  readonly partial: Omit<BuildPinInput, "notes">;
}

export interface PinSession {
  readonly consoleRing: ConsoleRing;
  /** Freeze, render, and grab both shots plus the structured context. */
  readonly captureFrame: () => Promise<PinFrame>;
  /** Attach notes, write it out, and return the saved pin. */
  readonly savePin: (
    frame: PinFrame,
    notes: string,
    opts?: { parentId?: string | null; origin?: "hotkey" | "agent" },
  ) => Promise<{ pin: VerificationPin; id: string; message: string }>;
}

/**
 * Mirrors console output into a bounded ring so a pin can carry it. A texture
 * that silently fell back to greybox says so here and nowhere else — no
 * screenshot shows it.
 *
 * Installed in solo only, which is exactly where pins are reachable (fly mode
 * is off in a net match), so a real match never has its console wrapped. The
 * originals are always called through, so devtools behaves as before.
 */
export function installConsoleCapture(ring: ConsoleRing, getTick: () => number | null): () => void {
  const levels: readonly PinConsoleEntry["level"][] = ["log", "info", "warn", "error", "debug"];
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const level of levels) {
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      try {
        ring.push(level, args.map(formatArg).join(" "), getTick());
      } catch {
        // Never let capture break the app's own logging.
      }
      original(...args);
    };
  }
  const onError = (e: ErrorEvent) => {
    ring.push("error", `uncaught: ${e.message} @ ${e.filename}:${e.lineno}`, getTick());
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    ring.push("error", `unhandled rejection: ${String(e.reason)}`, getTick());
  };
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
  return () => {
    for (const level of levels) {
      const original = originals.get(level);
      if (original) console[level] = original as typeof console.log;
    }
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
  };
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** WebGL vendor/renderer string, for "works here, broken there" reports. */
function gpuInfo(renderer: THREE.WebGLRenderer): string | null {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return null;
    const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string;
    const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
    return `${vendor} / ${name}`.trim();
  } catch {
    return null;
  }
}

export function createPinSession(deps: PinSessionDeps): PinSession {
  const consoleRing = deps.consoleRing ?? pinConsoleRing;

  const renderToViewport = (camera: THREE.Camera, vp: PinViewport): void => {
    // three uses a lower-left origin; same conversion as the frame loop.
    const yBottom = innerHeight - (vp.top + vp.height);
    deps.renderer.setViewport(vp.left, yBottom, vp.width, vp.height);
    deps.renderer.setScissor(vp.left, yBottom, vp.width, vp.height);
    deps.renderer.render(deps.scene, camera);
  };

  const flyLookDirection = (): { x: number; y: number; z: number } => {
    // Same basis as updateFlyCamera (view-forward including pitch).
    const cosPitch = Math.cos(deps.flyState.pitch);
    return {
      x: -Math.sin(deps.flyState.yaw) * cosPitch,
      y: Math.sin(deps.flyState.pitch),
      z: -Math.cos(deps.flyState.yaw) * cosPitch,
    };
  };

  const captureFrame = async (): Promise<PinFrame> => {
    const view = deps.getView0();
    if (!view) throw new Error("no view to capture (views not built yet)");
    const map = deps.getMap();
    const cam = view.camera;
    const vp = view.viewport;

    // --- Shot 1: the fly view, exactly what the user is looking at ---
    renderToViewport(cam, vp);
    const viewBlob = await captureCanvasPng(deps.renderer.domElement);

    const dir = flyLookDirection();
    const hit = rayHitHeightfield(
      map,
      cam.position.x,
      cam.position.y,
      cam.position.z,
      dir.x,
      dir.y,
      dir.z,
    );

    // --- Shot 2: orthographic top-down over the hit ---
    // The reason this exists: a mesh/logic-centre offset is not readable from a
    // perspective view. Top-down against the map JSON is what decides it.
    // up = -Z so world +Z runs *down* the image, matching the 0-based grid rows
    // in the sim map JSON and the fcop-viz top renders.
    const aspect = vp.height > 0 ? vp.width / vp.height : 1;
    const halfX = TOP_HALF_EXTENT * aspect;
    topCam.left = -halfX;
    topCam.right = halfX;
    topCam.top = TOP_HALF_EXTENT;
    topCam.bottom = -TOP_HALF_EXTENT;
    topCam.position.set(hit.x, hit.y + TOP_HEIGHT, hit.z);
    topCam.up.set(0, 0, -1);
    topCam.lookAt(hit.x, hit.y, hit.z);
    topCam.updateProjectionMatrix();
    topCam.updateMatrixWorld();
    renderToViewport(topCam, vp);
    const topBlob = await captureCanvasPng(deps.renderer.domElement);

    // Restore the fly view so the frozen frame on screen is the pinned one.
    renderToViewport(cam, vp);

    const camera = {
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
      yaw: deps.flyState.yaw,
      pitch: deps.flyState.pitch,
    };
    const shots: PinShotBlob[] = [
      {
        blob: viewBlob,
        meta: {
          file: "view.png",
          kind: "fly",
          projection: "perspective",
          width: vp.width,
          height: vp.height,
          camera,
          fov: cam.fov,
          world: null,
        },
      },
      {
        blob: topBlob,
        meta: {
          file: "top.png",
          kind: "top",
          projection: "orthographic",
          width: vp.width,
          height: vp.height,
          camera: { x: hit.x, y: hit.y + TOP_HEIGHT, z: hit.z, yaw: 0, pitch: -Math.PI / 2 },
          fov: null,
          world: [hit.x - halfX, hit.z - TOP_HALF_EXTENT, hit.x + halfX, hit.z + TOP_HALF_EXTENT],
        },
      },
    ];

    const sim = deps.getSim();
    const { snap, count } = deps.getSnapshot();
    return {
      shots,
      partial: {
        mapId: map.id,
        url: location.href,
        render: deps.renderMode,
        seed: Number.isFinite(deps.seed) ? deps.seed : null,
        tick: sim ? sim.tick : null,
        camera,
        hit,
        nearby: findNearby(map, hit.x, hit.z),
        entities: findEntities(snap, count, hit.x, hit.z),
        shots: shots.map((s) => s.meta),
        console: consoleRing.entries(),
        simHash: sim ? hash(sim) : null,
        client: {
          viewport: [vp.width, vp.height],
          dpr: devicePixelRatio,
          gpu: gpuInfo(deps.renderer),
          texVariant: deps.getTexVariant(),
          greyboxStructures: deps.greyboxStructures,
          commit: COMMIT,
        },
      },
    };
  };

  const savePin: PinSession["savePin"] = async (frame, notes, opts) => {
    const pin = buildPin({
      ...frame.partial,
      notes,
      parentId: opts?.parentId ?? null,
      origin: opts?.origin ?? "hotkey",
    });
    const id = pinIdFromCreatedAt(pin.createdAt);
    const result = await exportPin(
      pin,
      frame.shots,
      buildPinPrompt(pin),
      id,
      deps.pinServerUrl ?? DEFAULT_PIN_SERVER,
    );
    return { pin, id: result.id ?? id, message: result.message };
  };

  return { consoleRing, captureFrame, savePin };
}
