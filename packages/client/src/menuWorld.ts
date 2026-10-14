// The living title-screen world (menu backdrop): a throwaway local sim where
// the Warden defends one base against the scripted feeder on the other, under
// a slow camera flyover. Purely client-side ambience — this sim is never
// networked, so a random seed is fine here (the DETERMINISM rules bind sim
// code, not who seeds a local instance). CLIENT code: Math.sin/cos/random ok.

import {
  BUTTON_INTERACT,
  createSim,
  type MapData,
  type PlayerInput,
  type SimState,
} from "@metropolis/sim";
import type * as THREE from "three";

/**
 * Fresh demo battle: Warden on slot 1 vs the feeder script on slot 0. A mid
 * difficulty pushes back visibly without instantly steamrolling the feeder.
 */
export function createDemoSim(map: MapData): SimState {
  const seed = (Math.random() * 0x100000000) >>> 0;
  return createSim(map, seed, { wardenPlayer: 1, wardenDifficulty: 5 });
}

export function zeroPlayerInput(out: PlayerInput): void {
  out.moveX = 0;
  out.moveY = 0;
  out.aimX = 0;
  out.aimY = 0;
  out.buttons = 0;
}

// Spawn → own ground console, per slot (authored for bases mirrored about x):
// slot 1 walks (+4,+12), slot 0 the exact mirror.
const FEEDER_MOVE_X = [-40, 40];
const FEEDER_MOVE_Y = [-120, 120];

/**
 * The Phase 3 scripted feeder, generalized to either slot: walk to the ground
 * console, then runner bursts forever (10 s burst, 20 s pause). A purchase is one
 * press of the action key (rules.md §3, the original's), so a burst presses it
 * every 0.5 s — one tick down, then released — the rate the old 0.5 s hold
 * bought at. The walk is byte-identical to the historic ?opponent=feeder.
 */
export function demoFeeder(slot: number, tick: number, out: PlayerInput): void {
  zeroPlayerInput(out);
  if (tick < 76) {
    out.moveX = FEEDER_MOVE_X[slot];
    out.moveY = FEEDER_MOVE_Y[slot];
    return;
  }
  if (tick % 900 < 300 && tick % 15 === 0) out.buttons = BUTTON_INTERACT;
}

/**
 * Slow orbit around the arena center with a gentle height bob, framing the
 * whole map. Zero allocations — writes the camera in place every frame.
 */
export function updateFlyoverCamera(
  cam: THREE.PerspectiveCamera,
  timeSec: number,
  extent: number,
): void {
  const cx = extent / 2;
  const cz = extent / 2;
  const yaw = timeSec * 0.03;
  // Close, steep vantage: framing only the central ~half of the arena keeps
  // terrain filling the frame at every extent, so the map edge / void horizon
  // never shows. Paired with flyCam's narrow FOV (main.ts). Multipliers are
  // extent-relative, so one set works for all arenas (extents 240–304 m).
  const radius = extent * 0.2;
  const height = extent * 0.44 + Math.sin(timeSec * 0.11) * extent * 0.015;
  cam.position.set(cx + Math.cos(yaw) * radius, height, cz + Math.sin(yaw) * radius);
  cam.lookAt(cx, 0, cz);
}
