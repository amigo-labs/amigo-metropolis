// The Map Key's map screen (RE hud.json pause_map; src/game/frame/draw.c
// 1566-1650, pause_map.c, mission_frame.c 1661-1691): the view's pause byte
// flipped, the saved camera set to the X1's position, the terrain drawn from
// straight above in a 32 x 24-sample window about it (20 px a sample at
// 640 x 480), panned by the movement bits and re-centred by Action, its centre
// kept inside the original's terrain grid less its margin, so the window
// overhangs the grid by at most 2 m.
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
import { VIEW_TERRAIN } from "./viewTerrain.generated";

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
 * `halfY` metres about its centre, then overhangs the world `bounds`
 * [minX, maxX, minY, maxY] by at most 2 m (world_clamp_map_centre).
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

/** `WORLD_MAP_WINDOW_OVERHANG` 0x4000: how far the window may overhang the world, m. */
export const MAP_OVERHANG_M = 0x4000 / WU;

/**
 * `world_clamp_map_centre` (0x00452710) on one axis: the centre kept `half`
 * less the overhang inside [lo, hi]. The low bound is tested first and the
 * high one only when the low passed, so where the margin exceeds half the
 * world the centre ends on the low bound or, above the high one, on it.
 */
function clampAxis(c: number, half: number, lo: number, hi: number): number {
  const margin = half - MAP_OVERHANG_M;
  if (c < lo + margin) return lo + margin;
  if (c > hi - margin) return hi - margin;
  return c;
}

/**
 * The world the window stays inside: the original's terrain grid less its
 * margin (`cptc_load` 0x00451510's bounds; gen:viewterrain `world`, in the
 * sim's frame). A map the original has no grid for (the test maps) keeps the
 * whole of its own. Writes [minX, maxX, minY, maxY]. Not in the frame loop.
 */
export function mapBounds(map: MapData, out: Float64Array): void {
  const world = VIEW_TERRAIN[map.id]?.world;
  if (world) {
    out[0] = world[0];
    out[1] = world[1];
    out[2] = world[2];
    out[3] = world[3];
    return;
  }
  const extent = worldExtent(map);
  out[0] = 0;
  out[1] = extent;
  out[2] = 0;
  out[3] = extent;
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
