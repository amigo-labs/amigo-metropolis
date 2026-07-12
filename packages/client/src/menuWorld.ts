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

// Spawn → own ground console, per slot (matches district-01 authoring, which
// mirrors the bases about x): slot 1 walks (+4,+12), slot 0 the exact mirror.
const FEEDER_MOVE_X = [-40, 40];
const FEEDER_MOVE_Y = [-120, 120];

/**
 * The Phase 3 scripted feeder, generalized to either slot: walk to the ground
 * console, then hold-to-buy runner bursts forever (10 s burst, 20 s pause).
 * Slot 1 is byte-identical to the historic ?opponent=feeder behavior.
 */
export function demoFeeder(slot: number, tick: number, out: PlayerInput): void {
  zeroPlayerInput(out);
  if (tick < 76) {
    out.moveX = FEEDER_MOVE_X[slot];
    out.moveY = FEEDER_MOVE_Y[slot];
    return;
  }
  if (tick % 900 < 300) out.buttons = BUTTON_INTERACT;
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
  // Steep-ish vantage so the arena fills the frame instead of the void horizon.
  const radius = extent * 0.55;
  const height = extent * 0.52 + Math.sin(timeSec * 0.11) * extent * 0.04;
  cam.position.set(cx + Math.cos(yaw) * radius, height, cz + Math.sin(yaw) * radius);
  cam.lookAt(cx, 0, cz);
}
