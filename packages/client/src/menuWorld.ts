// The living title-screen world (menu backdrop): a throwaway local sim where
// the Warden defends one base against the scripted feeder on the other, under
// a slow camera flyover. Purely client-side ambience — this sim is never
// networked, so a random seed is fine here (the DETERMINISM rules bind sim
// code, not who seeds a local instance). CLIENT code: Math.sin/cos/random ok.

import {
  BTN_ACTION,
  BTN_FORWARD,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
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
  out.buttons = 0;
}

/** The feeder stops this close to its console (m): inside its trigger box. */
const FEEDER_NEAR = 0.5;
/** Off its heading by more than this (sin, about 4°), the feeder turns. */
const FEEDER_TURN = 0.07;
/** Within this of its heading (cos 22.5°), it walks as it turns. */
const FEEDER_DRIVE = 0.9238795325112867;

/**
 * The Phase 3 scripted feeder, for either slot: walk to the own ground console
 * on the original's buttons — turn toward it, forward once facing it — then
 * runner bursts forever (10 s burst, 20 s pause). A purchase is one press of the
 * Action Key (rules.md §3, the original's), so a burst presses it every 0.5 s —
 * one tick down, then released. Steers by the live sim; client-side only.
 */
export function demoFeeder(sim: Readonly<SimState>, slot: number, out: PlayerInput): void {
  zeroPlayerInput(out);
  const a = sim.avatarId[slot];
  if (a < 0) return;
  const c = sim.map.bases[slot].groundConsole;
  const dx = c.x - sim.ent.posX[a];
  const dy = c.y - sim.ent.posY[a];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > FEEDER_NEAR) {
    const hx = sim.ent.aimX[a];
    const hy = sim.ent.aimY[a];
    const across = (hx * dy - hy * dx) / d;
    const along = (hx * dx + hy * dy) / d;
    if (along < 0 || Math.abs(across) > FEEDER_TURN) {
      out.buttons |= across >= 0 ? BTN_TURN_RIGHT : BTN_TURN_LEFT;
    }
    if (along > FEEDER_DRIVE) out.buttons |= BTN_FORWARD;
    return;
  }
  if (sim.tick % 900 < 300 && sim.tick % 15 === 0) out.buttons = BTN_ACTION;
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
