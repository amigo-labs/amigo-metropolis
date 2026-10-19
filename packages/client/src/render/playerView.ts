// Per-player view (PLAN Phase 5): one chase camera + one HUD anchor + one
// screen rectangle per local player. Solo play uses a single full-window view;
// splitscreen lays two of them side by side (or stacked) and the frame loop
// renders the shared scene once per view via setViewport/setScissor.
//
// The scene, meshes and snapshot are global and camera-independent — a view is
// purely "where do I look from and where does my HUD sit", so nothing here
// touches sim state.

import * as THREE from "three";
import type { LocalInputSource, Viewport } from "../input/types";
import {
  CAMERA_VFOV_DEG,
  type ChaseCamera,
  type ChasePose,
  type ChaseSubject,
  createChaseCamera,
  createChasePose,
  stepChaseCamera,
} from "./camera";
import { type CameraShake, createCameraShake } from "./cameraShake";

export type SplitOrientation = "v" | "h";

export interface PlayerView {
  /** Player slot this view follows (its avatar is team === slot). */
  readonly slot: number;
  readonly input: LocalInputSource;
  readonly camera: THREE.PerspectiveCamera;
  readonly hud: HTMLDivElement;
  /** Screen rectangle in CSS px, top-left origin (recomputed on resize). */
  readonly viewport: Viewport;
  /** The original's chase camera (camera.spec) — client-local, mutated per frame. */
  readonly cam: ChaseCamera;
  /** The chase camera's subject, refilled per frame from the interpolated avatar. */
  readonly subject: ChaseSubject;
  /** The chase camera's last placement. */
  readonly pose: ChasePose;
  /** The damage meter that shakes the camera (render/cameraShake.ts). */
  readonly shake: CameraShake;
}

/**
 * Builds a view per local player, appending each HUD element to the document.
 * Each chase camera is seated behind its avatar at the spawn record's facing,
 * and follows the hull from there (camera.spec §3).
 */
export function createPlayerViews(
  players: readonly { slot: number; input: LocalInputSource }[],
  spawns: readonly { x: number; y: number; yaw: number; hover?: boolean }[],
): PlayerView[] {
  const views: PlayerView[] = [];
  for (const p of players) {
    const spawn = spawns[p.slot] ?? spawns[0];
    const camera = new THREE.PerspectiveCamera(CAMERA_VFOV_DEG, 1, 0.1, 2000);
    const hud = document.createElement("div");
    hud.className = "hud";
    document.body.appendChild(hud);
    const cam = createChaseCamera();
    const subject: ChaseSubject = {
      x: spawn.x,
      y: spawn.y,
      height: 0,
      facing: spawn.yaw,
      hover: spawn.hover === true,
    };
    const pose = createChasePose();
    // Seat the camera so the first frame has a sensible basis before the frame
    // loop's first update. Allocation is fine here — once per match start.
    stepChaseCamera(cam, subject, 0, null, 0, pose);
    applyChasePose(camera, pose);
    views.push({
      slot: p.slot,
      input: p.input,
      camera,
      hud,
      viewport: { left: 0, top: 0, width: 1, height: 1 },
      cam,
      subject,
      pose,
      shake: createCameraShake(0x5eed + p.slot),
    });
  }
  return views;
}

/**
 * Writes a chase pose onto a three camera: the eye, and a look along the view
 * axis — (cos p cos yaw, -sin p, cos p sin yaw) in three's frame. Allocation-free.
 */
export function applyChasePose(camera: THREE.PerspectiveCamera, pose: ChasePose): void {
  const cp = Math.cos(pose.pitch);
  camera.position.set(pose.eyeX, pose.eyeY, pose.eyeZ);
  camera.lookAt(
    pose.eyeX + cp * Math.cos(pose.yaw),
    pose.eyeY - Math.sin(pose.pitch),
    pose.eyeZ + cp * Math.sin(pose.yaw),
  );
  camera.updateMatrixWorld();
}

/**
 * Recomputes each view's viewport, camera aspect and HUD anchor for the current
 * window size. One view → full window; two → an even split. HUD sits in the
 * top-left of its own viewport.
 *
 * `hudInset` shifts the text HUD in from that corner. It exists because the
 * graphical HUD's radar occupies the same corner, and under ?debug both are on
 * screen: the text is scaffolding, so the text is what moves. Set in px; the
 * default keeps the original 8px anchor for every other mode.
 */
export function layoutViews(
  views: readonly PlayerView[],
  orientation: SplitOrientation,
  width: number,
  height: number,
  hudInset = 8,
): void {
  for (let i = 0; i < views.length; i++) {
    const vp = views[i].viewport;
    if (views.length === 1) {
      vp.left = 0;
      vp.top = 0;
      vp.width = width;
      vp.height = height;
    } else if (orientation === "v") {
      // Side by side: P1 left, P2 gets the remainder so the halves exactly
      // cover an odd width (no 1px seam).
      const half = Math.floor(width / 2);
      vp.left = i === 0 ? 0 : half;
      vp.top = 0;
      vp.width = i === 0 ? half : width - half;
      vp.height = height;
    } else {
      // Stacked: P1 top, P2 gets the remainder (exact cover on odd heights).
      const half = Math.floor(height / 2);
      vp.left = 0;
      vp.top = i === 0 ? 0 : half;
      vp.width = width;
      vp.height = i === 0 ? half : height - half;
    }
    const cam = views[i].camera;
    // Guard a degenerate (zero-height) viewport so aspect never goes NaN/Inf.
    cam.aspect = vp.width / Math.max(vp.height, 1);
    cam.updateProjectionMatrix();
    const hud = views[i].hud.style;
    hud.left = `${vp.left + hudInset}px`;
    hud.top = `${vp.top + 8}px`;
  }
}
