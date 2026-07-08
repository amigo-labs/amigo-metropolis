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

export type SplitOrientation = "v" | "h";

export interface PlayerView {
  /** Player slot this view follows (its avatar is team === slot). */
  readonly slot: number;
  readonly input: LocalInputSource;
  readonly camera: THREE.PerspectiveCamera;
  readonly hud: HTMLDivElement;
  /** Screen rectangle in CSS px, top-left origin (recomputed on resize). */
  readonly viewport: Viewport;
}

/** Builds a view per local player, appending each HUD element to the document. */
export function createPlayerViews(
  players: readonly { slot: number; input: LocalInputSource }[],
  spawns: readonly { x: number; y: number }[],
): PlayerView[] {
  const views: PlayerView[] = [];
  for (const p of players) {
    const spawn = spawns[p.slot] ?? spawns[0];
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    camera.position.set(spawn.x - 14, 12, spawn.y);
    const hud = document.createElement("div");
    hud.className = "hud";
    document.body.appendChild(hud);
    views.push({
      slot: p.slot,
      input: p.input,
      camera,
      hud,
      viewport: { left: 0, top: 0, width: 1, height: 1 },
    });
  }
  return views;
}

/**
 * Recomputes each view's viewport, camera aspect and HUD anchor for the current
 * window size. One view → full window; two → an even split. HUD sits in the
 * top-left of its own viewport.
 */
export function layoutViews(
  views: readonly PlayerView[],
  orientation: SplitOrientation,
  width: number,
  height: number,
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
    hud.left = `${vp.left + 8}px`;
    hud.top = `${vp.top + 8}px`;
  }
}
