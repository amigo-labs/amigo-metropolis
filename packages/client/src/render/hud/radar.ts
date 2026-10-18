// The running radar (RE hud.json radar; src/game/frame/hud_radar.c): GlblData
// page 11's disc, 112 x 112 at (4, 4) at 640 x 480, appended twice at half
// alpha; then the rim (hud_radar_draw_bearings): a white compass tick at
// -0x800 - facing between radii 48 and 60, and an arrow per objective contact
// with bit 0, blinking on clock bits 7-8; then a blip per actor that carries a
// marker byte (hud_radar_place_contact): heading-up, 1.5/4096 px a world unit
// (3 px a metre), inside +-0x25555 on both axes and the octagonal distance;
// sprite 6 x 6 (kind 0), triangle (1) or diamond (2+), coloured from the
// 32-entry palette, blinking from index 23 on clock bit 7.
//
// Markers come from radar_markers.json by unit kind and the team's original
// side (render/sides.ts); the placed actors Metropolis has no entity for — the
// outposts' green diamonds, Hk's / Joke's / Slim's marked props — and the
// outposts' claim posts are drawn from the imported per-arena lists. Pickups
// carry the item marker while standing (MATCH_PICKUPS).
//
// Raw DOM: one canvas in the 640 space, redrawn every frame (the heading turns
// every frame) without allocating: colours are strings built once.

import {
  ARCHETYPE,
  getMapById,
  MATCH_PICKUPS,
  type MapData,
  SNAPSHOT_STRIDE,
  TURRET_CAPTURABLE,
} from "@metropolis/sim";
import {
  ARENA_PRESENTATION,
  type ArenaPresentation,
  HUD,
  RADAR_PALETTE,
  UNIT_MARKERS,
} from "../fcopPresentation.generated";
import { SIDE_BLUE, SIDE_RED, sideOfTeam } from "../sides";
import { hudPage11 } from "./hudArt";
import { type HudCanvas, hudCanvas } from "./hudLayout";

export interface Radar {
  /** Draws the radar for this frame (the local X1's interpolated pose, sim frame). */
  refresh(
    match: Float32Array,
    snapshot: Float32Array,
    count: number,
    clock: number,
    selfX: number,
    selfY: number,
    facing: number,
    down: boolean,
  ): void;
  /** Re-places the radar for a viewport (CSS px). */
  layout(vw: number, vh: number): void;
}

/** World units to a metre (a terrain sample). */
const WU = 8192;
/** The radar's canvas covers the disc and the rim (radius 60 about (60, 60)). */
const AREA = 120;
/** Palette index from which a blip blinks (0x17). */
const BLINK_INDEX = 0x17;
/** The rim arrows blink on 0x180, the blips on 0x80 (hud_radar.c). */
const ARROW_BLINK = 0x180;
const BLIP_BLINK = 0x80;
/** A contact within 8192 wu (1 m) has no bearing (hud_radar_bearing). */
const NO_BEARING_WU = 8192;
const TURN = 4096;
const UNIT_RAD = (Math.PI * 2) / TURN;

const PALETTE_CSS: readonly string[] = RADAR_PALETTE.map((c) =>
  c ? `rgb(${c[0]},${c[1]},${c[2]})` : "rgba(0,0,0,0)",
);
const TICK_CSS = `rgb(${HUD.radar.tickRgb[0]},${HUD.radar.tickRgb[1]},${HUD.radar.tickRgb[2]})`;

/**
 * hud_radar_place_contact's range test (0x0044a950): each axis within the range,
 * then the two-branch octagonal distance within it too. World units.
 */
export function radarInRange(dx: number, dz: number, range = HUD.radar.rangeWu): boolean {
  let lo = Math.abs(Math.trunc(dx));
  let hi = Math.abs(Math.trunc(dz));
  if (lo > range || hi > range) return false;
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  if (lo > hi >> 1) {
    const diag = (hi + 32 * lo + 74 * (hi + lo)) >> 7;
    lo = hi - lo;
    hi = diag;
  }
  return hi + (lo >> 2) - (lo >> 6) <= range;
}

/**
 * Heading-up placement: a point `dx`, `dy` metres from the X1 (sim frame) and
 * the X1's facing (rad) -> [across, down] px at 640 x 480 from the centre.
 * Straight ahead is up, the facing's right is right (hud_radar.c:792-795).
 */
export function radarPlace(dx: number, dy: number, facing: number, out: Float64Array): void {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  const scale = HUD.radar.pxPerWu * WU; // 1.5 / 4096 px a world unit
  out[0] = Math.trunc((-dx * s + dy * c) * scale);
  out[1] = Math.trunc(-(dx * c + dy * s) * scale);
}

/** The marker an entity carries, or 0 (radar_markers.json by kind and side). */
export function markerOf(archetype: number, side: number, aux: number): number {
  const i = side === SIDE_BLUE ? 1 : 0;
  switch (archetype) {
    case ARCHETYPE.AVATAR:
    case ARCHETYPE.WARDEN: // the Sky Captain carries the X1's marker of its side (0x32)
      return side ? UNIT_MARKERS.avatar[i] : 0;
    case ARCHETYPE.RUNNER:
      return side ? UNIT_MARKERS.tank[i] : 0;
    case ARCHETYPE.GUARDIAN:
      return side ? UNIT_MARKERS.jet[i] : 0;
    case ARCHETYPE.FORTRESS:
      return side ? UNIT_MARKERS.fortress[i] : 0;
    case ARCHETYPE.JUGGERNAUT:
      return side ? UNIT_MARKERS.dreadnought[i] : 0;
    case ARCHETYPE.TURRET:
      if (!side) return UNIT_MARKERS.neutralTurret;
      return aux === TURRET_CAPTURABLE ? UNIT_MARKERS.capturedTurret[i] : UNIT_MARKERS.turret[i];
    default:
      // Projectiles, consoles (the outposts' markers are placed actors of their
      // own, below): no marker.
      return 0;
  }
}

/** Draws one blip, `marker`'s shape and colour, at (across, down) from the centre. */
function drawBlip(ctx: CanvasRenderingContext2D, marker: number, a: number, d: number): void {
  const index = marker & 0x1f;
  const kind = marker >> 5;
  const cx = HUD.radar.centre[0];
  const cy = HUD.radar.centre[1];
  ctx.fillStyle = PALETTE_CSS[index];
  if (kind === 0) {
    // The arena's 3 x 3 texel drawn 6 x 6; the palette colour saturates it.
    ctx.fillRect(cx - 3 + a, cy - 2 + d, 6, 6);
    return;
  }
  ctx.beginPath();
  if (kind === 1) {
    ctx.moveTo(cx + a, cy - 4 + d);
    ctx.lineTo(cx + 8 + a, cy + 4 + d);
    ctx.lineTo(cx - 8 + a, cy + 4 + d);
  } else {
    ctx.moveTo(cx + a, cy - 6 + d);
    ctx.lineTo(cx + 6 + a, cy + d);
    ctx.lineTo(cx + a, cy + 6 + d);
    ctx.lineTo(cx - 6 + a, cy + d);
  }
  ctx.closePath();
  ctx.fill();
}

/** A radial line on the rim at `angle` (4096 a turn, screen y down). */
function drawTick(ctx: CanvasRenderingContext2D, angle: number): void {
  const r = angle * UNIT_RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const cx = HUD.radar.centre[0];
  const cy = HUD.radar.centre[1];
  ctx.beginPath();
  ctx.moveTo(cx + HUD.radar.tickInner * c, cy + HUD.radar.tickInner * s);
  ctx.lineTo(cx + HUD.radar.tickOuter * c, cy + HUD.radar.tickOuter * s);
  ctx.stroke();
}

/** An arrowhead on the rim at `angle` (hud_radar_arrow: the table x 2 px). */
function drawArrow(ctx: CanvasRenderingContext2D, angle: number, colour: number): void {
  const r = angle * UNIT_RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const cx = HUD.radar.centre[0];
  const cy = HUD.radar.centre[1];
  const pts = HUD.radar.arrow;
  ctx.fillStyle = PALETTE_CSS[colour];
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const rr = pts[i][0] * 2;
    const tt = pts[i][1] * 2;
    const x = cx + c * rr - s * tt;
    const y = cy + s * rr + c * tt;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** The disc, twice at half alpha: 0.75 of the texture over what is behind it. */
export function drawDisc(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  ready: boolean,
): void {
  if (!ready) return;
  const d = HUD.radar.disc;
  const b = HUD.radar.box;
  ctx.globalAlpha = 0.5;
  ctx.drawImage(image, d[0], d[1], d[2], d[3], b[0], b[1], b[2], b[3]);
  ctx.drawImage(image, d[0], d[1], d[2], d[3], b[0], b[1], b[2], b[3]);
  ctx.globalAlpha = 1;
}

/** The frame being drawn: module scratch, so the blip walk builds no closure. */
const frame = {
  ctx: null as CanvasRenderingContext2D | null,
  selfX: 0,
  selfY: 0,
  facing: 0,
  blink: false,
};
const place = new Float64Array(2);

/** One blip at map (x, y), if it carries a marker, is lit and is in range. */
function blipAt(marker: number, x: number, y: number): void {
  const ctx = frame.ctx;
  if (marker === 0 || !ctx) return;
  if ((marker & 0x1f) >= BLINK_INDEX && !frame.blink) return;
  const dx = x - frame.selfX;
  const dy = y - frame.selfY;
  // position[2] is the map's x, position[0] its y.
  if (!radarInRange(dy * WU, dx * WU)) return;
  radarPlace(dx, dy, frame.facing, place);
  drawBlip(ctx, marker, place[0], place[1]);
}

const EMPTY_ARENA: ArenaPresentation = {
  mission: "",
  team0Side: 1,
  reticle: 0,
  contacts: [],
  staticMarkers: [],
  claimMarkers: [],
};

export function createRadar(parent: HTMLElement, mapId: string, _slot: number): Radar {
  const page = hudPage11();
  const canvas: HudCanvas = hudCanvas(parent, 0, 0, AREA, AREA);
  const arena = ARENA_PRESENTATION[mapId] ?? EMPTY_ARENA;
  let map: MapData | null = null;
  try {
    map = getMapById(mapId);
  } catch {
    map = null;
  }
  // Each claim post's outpost: the nearest outpost spot (static).
  const spots = map?.outpostSpots ?? [];
  const claimSpot = new Int32Array(arena.claimMarkers.length).fill(-1);
  for (let k = 0; k < arena.claimMarkers.length; k++) {
    let best = 12 * 12; // a post stands within a few metres of its console
    for (let j = 0; j < spots.length; j++) {
      const dx = spots[j].x - arena.claimMarkers[k].x;
      const dy = spots[j].y - arena.claimMarkers[k].y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        claimSpot[k] = j;
      }
    }
  }
  /** The side owning each outpost spot this frame (its console's team). */
  const spotSide = new Int32Array(spots.length);

  return {
    refresh(match, snapshot, count, clock, selfX, selfY, facing, _down) {
      const ctx = canvas.ctx;
      canvas.dirty = false;
      canvas.begin();
      drawDisc(ctx, page.image, page.ready);
      const facingU = facing / UNIT_RAD;

      // --- the rim: the compass tick, the objective arrows.
      ctx.strokeStyle = TICK_CSS;
      ctx.lineWidth = 1;
      drawTick(ctx, -0x800 - facingU);
      if ((clock & ARROW_BLINK) !== 0) {
        for (let k = 0; k < arena.contacts.length; k++) {
          const c = arena.contacts[k];
          if ((c.shown & 1) === 0) continue;
          const dx = c.x - selfX;
          const dy = c.y - selfY;
          if (Math.abs(dx) * WU < NO_BEARING_WU && Math.abs(dy) * WU < NO_BEARING_WU) continue;
          const bearing = Math.atan2(dy, dx) / UNIT_RAD - facingU - 0x400;
          drawArrow(ctx, bearing, c.colour);
        }
      }

      frame.ctx = ctx;
      frame.selfX = selfX;
      frame.selfY = selfY;
      frame.facing = facing;
      frame.blink = (clock & BLIP_BLINK) !== 0;

      // --- the placed actors Metropolis has no entity for.
      for (let k = 0; k < arena.staticMarkers.length; k++) {
        const m = arena.staticMarkers[k];
        blipAt(m.marker, m.x, m.y);
      }

      // --- the entities (dense id order, the registry's order).
      spotSide.fill(0);
      for (let i = 0; i < count; i++) {
        const o = i * SNAPSHOT_STRIDE;
        const archetype = snapshot[o + 1];
        const team = snapshot[o + 2];
        const x = snapshot[o + 3];
        const y = snapshot[o + 4];
        if (archetype === ARCHETYPE.CONSOLE) {
          if (team === 0 || team === 1) {
            for (let j = 0; j < spots.length; j++) {
              const ddx = spots[j].x - x;
              const ddy = spots[j].y - y;
              if (ddx * ddx + ddy * ddy < 1) spotSide[j] = sideOfTeam(mapId, team);
            }
          }
          continue;
        }
        blipAt(markerOf(archetype, sideOfTeam(mapId, team), snapshot[o + 9]), x, y);
      }

      // --- an outpost's claim posts carry its claimer's marker.
      for (let k = 0; k < arena.claimMarkers.length; k++) {
        const j = claimSpot[k];
        if (j < 0) continue;
        const side = spotSide[j];
        if (side !== SIDE_RED && side !== SIDE_BLUE) continue;
        const m = arena.claimMarkers[k];
        blipAt(m.markers[side - 1], m.x, m.y);
      }

      // --- the standing pickups carry the item marker.
      if (map) {
        const up = match[MATCH_PICKUPS] | 0;
        const n = map.pickups.length < 24 ? map.pickups.length : 24;
        for (let k = 0; k < n; k++) {
          if ((up & (1 << k)) === 0) continue;
          blipAt(UNIT_MARKERS.pickup, map.pickups[k].x, map.pickups[k].y);
        }
      }

      // --- the contacts whose bit 2 asks for a blip (none on the PA arenas).
      for (let k = 0; k < arena.contacts.length; k++) {
        const c = arena.contacts[k];
        if ((c.shown & 4) !== 0) blipAt(c.colour, c.x, c.y);
      }
    },
    layout(vw, vh) {
      canvas.place(vw, vh);
    },
  };
}
