// The Map Key's map screen (RE hud.json pause_map; src/game/frame/draw.c
// 1566-1650, pause_map.c, mission_frame.c 1661-1691): the view's pause byte
// flipped, the saved camera set to the X1's position, the terrain drawn from
// straight above in a 32 x 24-sample window about it (20 px a sample at
// 640 x 480), panned by the movement bits and re-centred by Action, kept inside
// the world.
//
// The state and its rules; main.ts renders the top-down window and
// render/hud/mapOverlay.ts the arrows, rings and the radar's 54-cell overview.
// Client-local: while the view is paused the original reads its X1's button
// word as 0 (player.c:1420, player_fire.c:864), and Metropolis sends 0.

import {
  BTN_ACTION,
  BTN_BACK,
  BTN_FORWARD,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  type MapData,
  worldExtent,
} from "@metropolis/sim";
import { HUD } from "./fcopPresentation.generated";

/** World units to a metre (a terrain sample). */
const WU = 8192;
/** The window at 640 x 480: 32 samples across, 24 down. */
export const MAP_SAMPLES_X = HUD.pauseMap.samples[0];
export const MAP_SAMPLES_Y = HUD.pauseMap.samples[1];
/** A held pan's rate saturates at 0x200 (draw.c:1590). */
const RATE_MAX = HUD.pauseMap.panRateMax;

export interface MapScreen {
  open: boolean;
  /** The saved camera, the window's centre, map frame metres. */
  cx: number;
  cy: number;
  /** Pan rates (the original's +0x316 / +0x314), -0x200 .. 0x200. */
  rateX: number;
  rateY: number;
}

export function createMapScreen(): MapScreen {
  return { open: false, cx: 0, cy: 0, rateX: 0, rateY: 0 };
}

/** The Map Key: rates zeroed, the centre on the X1, the pause flipped. */
export function toggleMapScreen(m: MapScreen, x: number, y: number): void {
  m.rateX = 0;
  m.rateY = 0;
  m.cx = x;
  m.cy = y;
  m.open = !m.open;
}

/**
 * One held axis (draw.c:1577-1650): from 0 — a reversal snapping to 0 first —
 * by a unit a tick, saturating at +-0x200; released, 0 at once.
 */
function axisRate(rate: number, plus: boolean, minus: boolean, ticks: number): number {
  if (plus === minus) return 0;
  if (plus) return Math.min(RATE_MAX, (rate < 0 ? 0 : rate) + ticks);
  return Math.max(-RATE_MAX, (rate > 0 ? 0 : rate) - ticks);
}

/**
 * Pans the open map by the button word for `ticks` ticks: Turn Right / Left
 * scroll toward +x / -x (screen right / left), Move Backward / Forward toward
 * +y / -y (screen down / up), at `(dt x rate) << 2` world units a frame (up to
 * 2048 a tick, 75 m/s); Action re-centres on the X1. The window, `halfX` x
 * `halfY` metres about its centre, then stays inside the world `bounds`
 * [minX, maxX, minY, maxY] (world_clamp_map_centre).
 */
export function panMapScreen(
  m: MapScreen,
  buttons: number,
  ticks: number,
  selfX: number,
  selfY: number,
  bounds: ArrayLike<number>,
  halfX: number,
  halfY: number,
): void {
  if (!m.open) return;
  if ((buttons & BTN_ACTION) !== 0) {
    m.cx = selfX;
    m.cy = selfY;
  }
  m.rateX = axisRate(
    m.rateX,
    (buttons & BTN_TURN_RIGHT) !== 0,
    (buttons & BTN_TURN_LEFT) !== 0,
    ticks,
  );
  m.rateY = axisRate(m.rateY, (buttons & BTN_BACK) !== 0, (buttons & BTN_FORWARD) !== 0, ticks);
  m.cx += (ticks * m.rateX * 4) / WU;
  m.cy += (ticks * m.rateY * 4) / WU;
  m.cx = clampAxis(m.cx, halfX, bounds[0], bounds[1]);
  m.cy = clampAxis(m.cy, halfY, bounds[2], bounds[3]);
}

function clampAxis(c: number, half: number, lo: number, hi: number): number {
  if (2 * half >= hi - lo) return (lo + hi) / 2;
  return c < lo + half ? lo + half : c > hi - half ? hi - half : c;
}

/**
 * The world the window stays inside. The original clamps to its terrain grid
 * less a margin (grid.c world_clamp_map_centre); Metropolis' maps pad that grid
 * unevenly (CLAUDE.md, FCOP maps rule 3), so the bound is the arena's content —
 * spawns, bases, turret and outpost spots, pickups, lanes — and half a window's
 * width beyond it. Writes [minX, maxX, minY, maxY]. Not in the frame loop.
 */
export function mapBounds(map: MapData, out: Float64Array): void {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const p of map.spawns) add(p.x, p.y);
  for (const b of map.bases) {
    add(b.gate.x, b.gate.y);
    add(b.core.x, b.core.y);
  }
  for (const p of map.turretSpots) add(p.x, p.y);
  for (const p of map.outpostSpots) add(p.x, p.y);
  for (const p of map.pickups) add(p.x, p.y);
  for (const lane of map.lanes) for (const p of lane) add(p.x, p.y);
  const extent = worldExtent(map);
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = extent;
    maxY = extent;
  }
  const pad = MAP_SAMPLES_X / 2;
  out[0] = Math.max(0, minX - pad);
  out[1] = Math.min(extent, maxX + pad);
  out[2] = Math.max(0, minY - pad);
  out[3] = Math.min(extent, maxY + pad);
}

/**
 * The window's half extents in metres for a `vw` x `vh` view: 24 samples tall
 * as the original's (at 20 px a sample at 640 x 480); a wider view shows more
 * samples across, a narrower one fewer, at the same scale.
 */
export function mapWindow(vw: number, vh: number, out: Float64Array): void {
  const s = Math.min(vw / 640, vh / 480);
  const pxPerSample = HUD.pauseMap.pxPerSample * s;
  out[0] = vw / pxPerSample / 2;
  out[1] = vh / pxPerSample / 2;
  out[2] = pxPerSample;
}

/** world_to_map_cell: the whole world onto 0..53 per axis (the 54-cell overview). */
export function mapCell(v: number, extent: number): number {
  const c = Math.floor((v / extent) * 54);
  return c < 0 ? 0 : c > 53 ? 53 : c;
}
