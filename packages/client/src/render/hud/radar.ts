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
// Only actors in the registry get a blip, drawn in registry order
// (`hud_radar_draw_contacts` 0x0043bfb0 walks it): the live list (liveList.ts:
// creation order, oldest first, with the actors Metropolis has no entity for)
// filtered by octagonal distance from the viewpoints — team slot 0's X1 alone in
// one viewport (`cact_registry_build` 0x0043b520), the nearer of both X1s in the
// two-viewport network game (`cact_registry_build_mp` 0x0043b7a0) — at the
// widest of 0x38000, 0x34000 .. 0x24000 world units that holds at most 0xfe
// actors (the team game's limit); a flag-8 actor is never culled
// (`radarRegistry`).
//
// Markers come from radar_markers.json by unit kind and the team's original
// side (render/sides.ts); the placed actors Metropolis has no entity for — the
// outposts' green diamonds (their consoles, until the claim kills them) and
// their claim posts — are drawn from the imported per-arena lists. Pickups
// carry the item marker while standing (MATCH_PICKUPS). The type-96 Props are
// no actors (RE game/actor/load.c:68) and carry none.
//
// Raw DOM: one canvas in the 640 space, redrawn every frame (the heading turns
// every frame) without allocating: colours are strings built once.

import {
  ARCHETYPE,
  getMapById,
  MATCH_SLOT_AVATAR_ID,
  type MapData,
  matchSlotOffset,
  SNAPSHOT_STRIDE,
  TURRET_CAPTURABLE,
  worldExtent,
} from "@metropolis/sim";
import { SCENERY_PLACEMENTS, type SceneryShow } from "../arenaScenery.generated";
import {
  ARENA_PRESENTATION,
  type ArenaPresentation,
  HUD,
  RADAR_PALETTE,
  UNIT_MARKERS,
} from "../fcopPresentation.generated";
import { mapCell } from "../mapScreen";
import { SIDE_BLUE, SIDE_RED, sideOfTeam } from "../sides";
import { hudPage11 } from "./hudArt";
import { type HudCanvas, hudCanvas } from "./hudLayout";
import { snapshotIndexOf } from "./hudRules";
import { createLiveList, LIVE_ENTITY, LIVE_PICKUP, LIVE_PLACED, NO_SPAWNED } from "./liveList";

/**
 * The map screen's state as the radar needs it: while open the 54-cell overview
 * takes the disc's place (hud_draw_radar, the view paused), with the terrain
 * window's extent marked on it. Map frame metres.
 */
export interface RadarOverview {
  open: boolean;
  cx: number;
  cy: number;
  halfX: number;
  halfY: number;
}

export interface Radar {
  /** Written by the map screen; read by refresh(). */
  readonly overview: RadarOverview;
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
const half = (rgb: readonly number[]): string => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`;
/** The overview's frame and fill (op 0x3d, half alpha); its window frame, dim. */
const OVERVIEW_BORDER = half(HUD.pauseMap.borderRgb);
const OVERVIEW_FILL = half(HUD.pauseMap.fillRgb);
const OVERVIEW_WINDOW = half(HUD.pauseMap.windowRgb);
/** The team slots' and the Sky Captain's blips: 0x7fff, white. */
const OVERVIEW_WHITE = "rgb(248,248,248)";
const TICK_CSS = `rgb(${HUD.radar.tickRgb[0]},${HUD.radar.tickRgb[1]},${HUD.radar.tickRgb[2]})`;

/** The registry's widening search (mission_frame.c MISSION_BAND_*), world units. */
export const REGISTRY_BAND_START = 0x38000;
export const REGISTRY_BAND_STEP = 0x4000;
export const REGISTRY_BAND_MIN = 0x20000;
/** The registry's limit while mission-state word 23 is 1, every PA match (0xfe). */
export const REGISTRY_LIMIT_TEAM_GAME = 0xfe;

/** The registry's distance, `|dx| + |dz| - min / 2` (mission_octagonal), world units. */
export function registryDistance(dx: number, dz: number): number {
  const a = Math.abs(Math.trunc(dx));
  const b = Math.abs(Math.trunc(dz));
  return a + b - ((a < b ? a : b) >> 1);
}

/**
 * `cact_registry_build`'s cull over `n` candidates in live-list order (map frame
 * metres `xs`, `ys`; NaN for one that is not alive): each is measured against
 * the nearest of `nv` viewpoints; the walk starts at 0x38000 and, whenever more
 * than `limit` are inside, is thrown away and run again 0x4000 tighter, giving
 * up after 0x24000 with what that pass held. A candidate with `noCull` set (the
 * flag-8 actors) is inside at every radius. Writes 1 into `member` for every
 * candidate the registry keeps and answers how many.
 */
export function radarRegistry(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  vx: Float64Array,
  vy: Float64Array,
  nv: number,
  limit: number,
  member: Uint8Array,
  noCull: Uint8Array | null = null,
): number {
  let radius = REGISTRY_BAND_START;
  for (;;) {
    let count = 0;
    let overflowed = false;
    member.fill(0, 0, n);
    for (let k = 0; k < n; k++) {
      const x = xs[k];
      if (Number.isNaN(x)) continue;
      if (noCull === null || noCull[k] === 0) {
        let d = Number.POSITIVE_INFINITY;
        for (let v = 0; v < nv; v++) {
          // position[2] is the map's x, position[0] its y.
          const e = registryDistance((ys[k] - vy[v]) * WU, (x - vx[v]) * WU);
          if (e < d) d = e;
        }
        if (d >= radius) continue;
      }
      if (count >= limit) {
        overflowed = true;
        break;
      }
      member[k] = 1;
      count++;
    }
    if (!overflowed) return count;
    radius -= REGISTRY_BAND_STEP;
    if (radius <= REGISTRY_BAND_MIN) return count;
  }
}

/**
 * The side (0 nobody's, SIDE_RED, SIDE_BLUE) holding each of `spots` (the map's
 * outpost spots): its console's team in the snapshot, set at the claim.
 */
export function outpostSidesOf(
  snapshot: Float32Array,
  count: number,
  spots: readonly { readonly x: number; readonly y: number }[],
  mapId: string,
  out: Int32Array,
): void {
  out.fill(0);
  for (let i = 0; i < count; i++) {
    const o = i * SNAPSHOT_STRIDE;
    if (snapshot[o + 1] !== ARCHETYPE.CONSOLE) continue;
    const team = snapshot[o + 2];
    if (team !== 0 && team !== 1) continue;
    for (let j = 0; j < spots.length; j++) {
      const dx = spots[j].x - snapshot[o + 3];
      const dy = spots[j].y - snapshot[o + 4];
      if (dx * dx + dy * dy < 1) out[j] = sideOfTeam(mapId, team);
    }
  }
}

/** Whether a placement with `show` stands while its outpost is claimed (or not). */
export function standsAt(show: SceneryShow, claimed: boolean): boolean {
  return show === "always" || (show === "claimed") === claimed;
}

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
  boxes: {},
  loadActors: [],
  spawned: NO_SPAWNED,
};

/**
 * The radar of player `slot`. `online` is the two-viewport network game, whose
 * registry measures from both X1s.
 */
export function createRadar(
  parent: HTMLElement,
  mapId: string,
  slot: number,
  online = false,
): Radar {
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
  const extent = map ? worldExtent(map) : 1;

  // The registry's candidates, in live-list order (liveList.ts), and what each
  // placement shows: a console's marker until the claim, a claim post's
  // claimer's after it.
  const placements = SCENERY_PLACEMENTS[mapId]?.placements ?? [];
  const pickups = map?.pickups ?? [];
  const live = createLiveList(mapId, arena, placements, pickups);
  const stands = new Uint8Array(placements.length);
  const placedMarker = new Int32Array(placements.length);
  const placedClaim = new Int32Array(placements.length).fill(-1);
  for (const m of arena.staticMarkers) {
    const j = placements.findIndex((p) => p.record === m.record);
    if (j >= 0) placedMarker[j] = m.marker;
  }
  arena.claimMarkers.forEach((m, k) => {
    const j = placements.findIndex((p) => p.record === m.record);
    if (j >= 0) placedClaim[j] = k;
  });
  const member = new Uint8Array(live.out.x.length);
  const viewX = new Float64Array(2);
  const viewY = new Float64Array(2);
  const overview: RadarOverview = { open: false, cx: 0, cy: 0, halfX: 16, halfY: 12 };

  return {
    overview,
    refresh(match, snapshot, count, clock, selfX, selfY, facing, _down) {
      const ctx = canvas.ctx;
      canvas.dirty = false;
      canvas.begin();
      if (overview.open) {
        drawOverview(ctx, snapshot, count, arena, extent, overview, mapId);
        return;
      }
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

      // --- the outposts' owners: their consoles' teams; what stands by them.
      outpostSidesOf(snapshot, count, spots, mapId, spotSide);
      for (let j = 0; j < placements.length; j++) {
        const p = placements[j];
        const claimed = p.outpost >= 0 && (spotSide[p.outpost] ?? 0) !== 0;
        stands[j] = standsAt(p.show, claimed) ? 1 : 0;
      }

      // --- the registry: the live list, culled by distance.
      live.build(match, snapshot, count, stands);
      const c = live.out;
      viewX[0] = selfX;
      viewY[0] = selfY;
      let nv = 1;
      if (online) {
        // The two-viewport registry: the nearer of both team slots' X1s.
        const otherAvatar = match[matchSlotOffset(slot === 0 ? 1 : 0) + MATCH_SLOT_AVATAR_ID] | 0;
        const i = otherAvatar >= 0 ? snapshotIndexOf(snapshot, count, otherAvatar) : -1;
        if (i >= 0) {
          viewX[1] = snapshot[i * SNAPSHOT_STRIDE + 3];
          viewY[1] = snapshot[i * SNAPSHOT_STRIDE + 4];
          nv = 2;
        }
      }
      radarRegistry(c.x, c.y, c.n, viewX, viewY, nv, REGISTRY_LIMIT_TEAM_GAME, member, c.noCull);

      // --- a blip per member, in registry order.
      for (let k = 0; k < c.n; k++) {
        if (member[k] === 0) continue;
        const ref = c.ref[k];
        switch (c.kind[k]) {
          case LIVE_ENTITY: {
            const o = ref * SNAPSHOT_STRIDE;
            const archetype = snapshot[o + 1];
            if (archetype === ARCHETYPE.CONSOLE) break; // the console's marker is placed
            blipAt(
              markerOf(archetype, sideOfTeam(mapId, snapshot[o + 2]), snapshot[o + 9]),
              snapshot[o + 3],
              snapshot[o + 4],
            );
            break;
          }
          case LIVE_PICKUP:
            blipAt(UNIT_MARKERS.pickup, pickups[ref].x, pickups[ref].y);
            break;
          case LIVE_PLACED: {
            const q = placedClaim[ref];
            if (q < 0) {
              blipAt(placedMarker[ref], placements[ref].x, placements[ref].y);
              break;
            }
            // An outpost's claim posts carry its claimer's marker.
            const j = claimSpot[q];
            const side = j >= 0 ? spotSide[j] : 0;
            if (side !== SIDE_RED && side !== SIDE_BLUE) break;
            const m = arena.claimMarkers[q];
            blipAt(m.markers[side - 1], m.x, m.y);
            break;
          }
          default:
            break;
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

/** A 4 x 4 overview blip at a world point (2 x cell + 6, 640 units). */
function overviewBlip(ctx: CanvasRenderingContext2D, x: number, y: number, extent: number): void {
  ctx.fillRect(2 * mapCell(x, extent) + 6, 2 * mapCell(y, extent) + 6, 4, 4);
}

/**
 * The paused radar (hud_radar.c:268-378): the frame and fill, the terrain
 * window's extent, then white blips for the team slots and the Sky Captain,
 * the contacts with bit 1 and the Dreadnoughts (marker kind 0x40) in their
 * palette colours.
 */
function drawOverview(
  ctx: CanvasRenderingContext2D,
  snapshot: Float32Array,
  count: number,
  arena: ArenaPresentation,
  extent: number,
  ov: RadarOverview,
  mapId: string,
): void {
  const frame = HUD.pauseMap.frame;
  for (let i = 0; i < frame.length; i++) {
    ctx.fillStyle = i === frame.length - 1 ? OVERVIEW_FILL : OVERVIEW_BORDER;
    ctx.fillRect(frame[i][0], frame[i][1], frame[i][2], frame[i][3]);
  }
  const c0 = mapCell(ov.cx - ov.halfX, extent);
  const c1 = Math.min(0x35, mapCell(ov.cx + ov.halfX, extent));
  const r0 = mapCell(ov.cy - ov.halfY, extent);
  const r1 = Math.min(0x35, mapCell(ov.cy + ov.halfY, extent));
  ctx.fillStyle = OVERVIEW_WINDOW;
  ctx.fillRect(2 * c0 + 6, 2 * r0 + 6, 2 * (c1 - c0) + 4, 2 * (r1 - r0) + 4);
  for (let i = 0; i < count; i++) {
    const o = i * SNAPSHOT_STRIDE;
    const a = snapshot[o + 1];
    if (a === ARCHETYPE.AVATAR || a === ARCHETYPE.WARDEN) {
      ctx.fillStyle = OVERVIEW_WHITE;
      overviewBlip(ctx, snapshot[o + 3], snapshot[o + 4], extent);
    } else if (a === ARCHETYPE.JUGGERNAUT) {
      const side = sideOfTeam(mapId, snapshot[o + 2]);
      ctx.fillStyle = PALETTE_CSS[markerOf(a, side, 0) & 0x1f];
      overviewBlip(ctx, snapshot[o + 3], snapshot[o + 4], extent);
    }
  }
  for (let k = 0; k < arena.contacts.length; k++) {
    const c = arena.contacts[k];
    if ((c.shown & 2) === 0) continue;
    ctx.fillStyle = PALETTE_CSS[c.colour];
    overviewBlip(ctx, c.x, c.y, extent);
  }
}
