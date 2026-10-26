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
// Only actors in the registry get a blip (hud_radar_draw_contacts walks it):
// the live list filtered by octagonal distance from the viewpoints — team slot
// 0's X1 alone in one viewport (`cact_registry_build` 0x0043b520), the nearer
// of both X1s in the two-viewport network game (`cact_registry_build_mp`
// 0x0043b7a0) — at the widest of 0x38000, 0x34000 .. 0x24000 world units that
// holds at most 0xfe actors (the team game's limit), in the live list's order:
// creation order, oldest first, as `cact_link` (0x0043ad70) appends every new
// actor at the tail (`radarRegistry`, `LiveOrder`). The actors Metropolis has
// no entity for count against the limit where they stand: each X1's partner
// (type 0x12, `player_partner_create`, made right after it), each turret's base
// part (`part_b`, made in the turret's construct, so before it; no PA turret is
// type 0x21 with a gun part too) and each Dreadnought's four gun mounts
// (0x00425fa0, made in its construct). An actor with flag 8 is kept at any
// distance and still counts (0x0043b61b): every unit, turret and round, a
// Dreadnought's mounts, and the type-11 records whose flags carry it -- never
// an X1, its partner, a turret's base part or a pickup (RE M3-OP). The live
// list starts with the load's `Cact` actors in the container's file order --
// the X1s (with their partners) before every placed type-11 record -- and the
// registry is the frame start's: built from the snapshot the tick began from,
// so an actor made during the tick shows a tick later (mission_update
// 0x00407360). An outpost's console entity is no actor of the original's (its
// type-11 record is) and no candidate.
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
  MATCH_PICKUPS,
  MATCH_SLOT_AVATAR_ID,
  MAX_ENTITIES,
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
import { VIEW_TERRAIN } from "../viewTerrain.generated";
import { hudPage11 } from "./hudArt";
import { type HudCanvas, hudCanvas } from "./hudLayout";
import { snapshotIndexOf } from "./hudRules";

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
  /**
   * Draws the radar for this frame (the local X1's interpolated pose, sim
   * frame). `prev` is the snapshot the last tick began from: the registry is
   * the frame start's (cact_registry_build), the blips the frame's.
   */
  refresh(
    match: Float32Array,
    snapshot: Float32Array,
    count: number,
    prev: Float32Array,
    prevCount: number,
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
 * up after 0x24000 with what that pass held. Writes 1 into `member` for every
 * candidate the registry keeps and answers how many. A candidate with `keep`
 * set carries flag 8 (`test al, 8` at 0x0043b61b, ahead of the distance
 * compare): it is kept at any distance, and still counts toward the limit.
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
  keep: Uint8Array,
): number {
  let radius = REGISTRY_BAND_START;
  for (;;) {
    let count = 0;
    let overflowed = false;
    member.fill(0, 0, n);
    for (let k = 0; k < n; k++) {
      const x = xs[k];
      if (Number.isNaN(x)) continue;
      if (keep[k] !== 0) {
        if (count >= limit) {
          overflowed = true;
          break;
        }
        member[k] = 1;
        count++;
        continue;
      }
      let d = Number.POSITIVE_INFINITY;
      for (let v = 0; v < nv; v++) {
        // position[2] is the map's x, position[0] its y.
        const e = registryDistance((ys[k] - vy[v]) * WU, (x - vx[v]) * WU);
        if (e < d) d = e;
      }
      if (d >= radius) continue;
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
 * The client's copy of the live list's order: `cact_link` (0x0043ad70) appends
 * every new actor at the tail, so the list runs in creation order, oldest first
 * (RE game/actor/factory.c; mission_frame.c's "newest actor first" is the
 * other way round). The snapshot carries no birth, so an entity is born on the
 * first refresh that shows it (an id that was missing from the last refresh,
 * or now another archetype, is a new actor); the ones born together are in id
 * order. Render-only, and nothing allocates after construction.
 */
export class LiveOrder {
  private readonly born = new Uint32Array(MAX_ENTITIES);
  private readonly seen = new Uint32Array(MAX_ENTITIES);
  private readonly kind = new Int16Array(MAX_ENTITIES).fill(-1);
  /** Snapshot indices in creation order, the first `update` answers of them. */
  readonly order = new Int32Array(MAX_ENTITIES);
  private refreshes = 1;
  private births = 0;

  /** Orders `count` snapshot entities by creation into `order`; answers `count`. */
  update(snapshot: Float32Array, count: number): number {
    const prev = this.refreshes++;
    let m = 0;
    for (let i = 0; i < count; i++) {
      const o = i * SNAPSHOT_STRIDE;
      const id = snapshot[o] | 0;
      if (id < 0 || id >= MAX_ENTITIES) continue;
      const kind = snapshot[o + 1];
      if (this.seen[id] !== prev || this.kind[id] !== kind) this.born[id] = ++this.births;
      this.seen[id] = this.refreshes;
      this.kind[id] = kind;
      // Insertion by birth: the snapshot is in id order, so only a reused id moves.
      const b = this.born[id];
      let j = m - 1;
      while (j >= 0 && this.born[snapshot[this.order[j] * SNAPSHOT_STRIDE] | 0] > b) {
        this.order[j + 1] = this.order[j];
        j--;
      }
      this.order[j + 1] = i;
      m++;
    }
    return m;
  }
}

/**
 * Flag 8 by archetype (RE M3-OP): every tank, jet, Flying Fortress, turret,
 * Dreadnought and Sky Captain record of the six arenas carries it, and every
 * round has it from its spawner; an X1-Alpha's record does not (nor its
 * partner, which copies the X1's flags). A console entity is no candidate.
 */
const KEPT_ARCHETYPES: readonly boolean[] = (() => {
  const kept: boolean[] = [];
  for (const a of [
    ARCHETYPE.RUNNER,
    ARCHETYPE.GUARDIAN,
    ARCHETYPE.JUGGERNAUT,
    ARCHETYPE.FORTRESS,
    ARCHETYPE.TURRET,
    ARCHETYPE.PROJECTILE,
    ARCHETYPE.WARDEN,
  ]) {
    kept[a] = true;
  }
  return kept;
})();

/**
 * The placed records ("Cact 147", "Csac 43") in the order their actors join
 * the live list, as indices into `records`: every `Cact` in `cactLoad`'s order
 * (the container's file order, the load's), then every `Csac` by id.
 */
export function placedLoadOrder(records: readonly string[], cactLoad: readonly number[]): number[] {
  return records
    .map((record, k) => {
      const id = Number(record.split(" ")[1]) || 0;
      const csac = record.startsWith("Csac");
      const at = csac ? -1 : cactLoad.indexOf(id);
      return { k, id, csac, at: at >= 0 ? at : cactLoad.length + id };
    })
    .sort((a, b) => Number(a.csac) - Number(b.csac) || (a.csac ? a.id - b.id : a.at - b.at))
    .map((e) => e.k);
}

/** Which entities an entityCandidates pass writes. */
export const CANDIDATES_ALL = 0;
/** The X1-Alphas only: their records load before every placed type-11 record. */
export const CANDIDATES_AVATARS = 1;
/** Every entity but the X1-Alphas. */
export const CANDIDATES_OTHERS = 2;

/**
 * Writes the entities, in `order` (LiveOrder), into the registry's candidates
 * from `n` on, each with the actors that stand with it and have no entity: a
 * turret's base part before it, a Dreadnought's four mounts before it, an X1's
 * partner after it. `entityAt[i]` takes snapshot entity i's own candidate, and
 * `keep` each candidate's flag 8: the entity's by its archetype, the mounts'
 * their Dreadnought's (0x00425fdd keeps it), the base part's clear (the part's
 * construct masks it off, 0x0041cfdd) and the partner's the X1's. Answers the
 * next free candidate.
 *
 * `which` picks the X1s, the others or all (CANDIDATES_*). With `prev` (the
 * snapshot the tick began from) each candidate stands where its entity stood
 * then, and an entity that was not there yet (or was another actor under the
 * id) stands nowhere (NaN): `cact_registry_build` runs at the frame's start,
 * before any actor moves or is made (mission_update 0x00407360, step 2).
 */
export function entityCandidates(
  snapshot: Float32Array,
  order: Int32Array,
  m: number,
  xs: Float64Array,
  ys: Float64Array,
  keep: Uint8Array,
  n: number,
  entityAt: Int32Array,
  which = CANDIDATES_ALL,
  prev: Float32Array | null = null,
  prevCount = 0,
): number {
  for (let q = 0; q < m; q++) {
    const i = order[q];
    const o = i * SNAPSHOT_STRIDE;
    const archetype = snapshot[o + 1];
    const avatar = archetype === ARCHETYPE.AVATAR;
    if (which === CANDIDATES_AVATARS ? !avatar : which === CANDIDATES_OTHERS && avatar) continue;
    // An outpost's console entity is Metropolis' own: the original's actor is
    // its type-11 record (Mp Cact 147 and kin, flags 0x208c0, no flag 8), a
    // placed candidate of its own. No second candidate for it.
    if (archetype === ARCHETYPE.CONSOLE) {
      entityAt[i] = -1;
      continue;
    }
    let x = snapshot[o + 3];
    let y = snapshot[o + 4];
    if (prev !== null) {
      const p = snapshotIndexOf(prev, prevCount, snapshot[o]);
      if (p >= 0 && prev[p * SNAPSHOT_STRIDE + 1] === archetype) {
        x = prev[p * SNAPSHOT_STRIDE + 3];
        y = prev[p * SNAPSHOT_STRIDE + 4];
      } else {
        x = Number.NaN;
      }
    }
    const kept = KEPT_ARCHETYPES[archetype] === true ? 1 : 0;
    const before =
      archetype === ARCHETYPE.TURRET ? 1 : archetype === ARCHETYPE.JUGGERNAUT ? MOUNTS : 0;
    const beforeKept = archetype === ARCHETYPE.JUGGERNAUT ? kept : 0;
    for (let k = 0; k < before; k++) {
      xs[n] = x;
      ys[n] = y;
      keep[n] = beforeKept;
      n++;
    }
    entityAt[i] = n;
    xs[n] = x;
    ys[n] = y;
    keep[n] = kept;
    n++;
    if (archetype === ARCHETYPE.AVATAR) {
      xs[n] = x;
      ys[n] = y;
      keep[n] = 0;
      n++;
    }
  }
  return n;
}

/** A Dreadnought's gun mounts, each an actor of its own (RE mount.c 0x00425fa0). */
const MOUNTS = 4;
/** Candidates an entity can bring at most: itself and its four mounts. */
const MAX_CANDIDATES_PER_ENTITY = 1 + MOUNTS;

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
      return side ? UNIT_MARKERS.avatar[i] : 0;
    case ARCHETYPE.WARDEN:
      // The Sky Captain's record byte (radar_markers.json): side 2's X1 marker,
      // 0x32, whatever side it flies for -- in the original it is always side
      // 2, and every Metropolis match seats it there too (wardenPlayer 1).
      return UNIT_MARKERS.captain;
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

  // The registry's candidates, in live-list order, oldest first. The load
  // makes the `Cact` actors in the container's file order (res_dispatch_chunks
  // 0x004063c0, cact_load 0x0043af20; gen:viewterrain `cactLoad`): the X1s
  // (records 12 and 16, with their partners) before every placed type-11
  // record on all six arenas, then those records. A `Csac` only registers a
  // spawner (csac_load 0x0044eff0), so its type-11 records, the pickups and
  // every other entity come after; among those Metropolis keeps the Csac
  // records by id, then the pickups, then the entities in the order they
  // were made (LiveOrder) -- when each spawner first fires is the scripts'.
  const placements = SCENERY_PLACEMENTS[mapId]?.placements ?? [];
  const pickups = map?.pickups ?? [];
  const nPickups = pickups.length < 24 ? pickups.length : 24;
  const placedOrder = placedLoadOrder(
    placements.map((p) => p.record),
    VIEW_TERRAIN[mapId]?.cactLoad ?? [],
  );
  const recordIndex = (record: string): number => placements.findIndex((p) => p.record === record);
  const staticPlaced = Int32Array.from(arena.staticMarkers, (m) => recordIndex(m.record));
  const claimPlaced = Int32Array.from(arena.claimMarkers, (m) => recordIndex(m.record));
  const maxCandidates = MAX_ENTITIES * MAX_CANDIDATES_PER_ENTITY + nPickups + placements.length;
  const live = new LiveOrder();
  const entityAt = new Int32Array(MAX_ENTITIES);
  const candX = new Float64Array(maxCandidates);
  const candY = new Float64Array(maxCandidates);
  const member = new Uint8Array(maxCandidates);
  /** Flag 8 per candidate: kept at any distance (radarRegistry). */
  const candKeep = new Uint8Array(maxCandidates);
  const placedKeep = Uint8Array.from(placements, (p) => (p.keep === true ? 1 : 0));
  /** Where each placement and pickup sits among this frame's candidates. */
  const placedAt = new Int32Array(placements.length);
  const pickupAt = new Int32Array(nPickups);
  const viewX = new Float64Array(2);
  const viewY = new Float64Array(2);
  const overview: RadarOverview = { open: false, cx: 0, cy: 0, halfX: 16, halfY: 12 };

  return {
    overview,
    refresh(match, snapshot, count, prev, prevCount, clock, selfX, selfY, facing, _down) {
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

      // --- the outposts' owners: their consoles' teams.
      outpostSidesOf(snapshot, count, spots, mapId, spotSide);

      // --- the registry: every live actor, oldest first, by distance, as the
      // frame began. The X1s and their partners first.
      const m = live.update(snapshot, count);
      let n = entityCandidates(
        snapshot,
        live.order,
        m,
        candX,
        candY,
        candKeep,
        0,
        entityAt,
        CANDIDATES_AVATARS,
        prev,
        prevCount,
      );
      for (let q = 0; q < placedOrder.length; q++) {
        const k = placedOrder[q];
        const p = placements[k];
        placedAt[k] = n;
        const claimed = p.outpost >= 0 && (spotSide[p.outpost] ?? 0) !== 0;
        candX[n] = standsAt(p.show, claimed) ? p.x : Number.NaN;
        candY[n] = p.y;
        candKeep[n] = placedKeep[k];
        n++;
      }
      const up = match[MATCH_PICKUPS] | 0;
      for (let k = 0; k < nPickups; k++) {
        pickupAt[k] = n;
        const standing = (up & (1 << k)) !== 0;
        candX[n] = standing ? pickups[k].x : Number.NaN;
        candY[n] = pickups[k].y;
        candKeep[n] = 0; // a pickup's record has no flag 8
        n++;
      }
      n = entityCandidates(
        snapshot,
        live.order,
        m,
        candX,
        candY,
        candKeep,
        n,
        entityAt,
        CANDIDATES_OTHERS,
        prev,
        prevCount,
      );
      // The view's X1 where it stood as the frame began (the drawn pose until
      // it has a previous tick).
      const selfAvatar = match[matchSlotOffset(slot) + MATCH_SLOT_AVATAR_ID] | 0;
      const ps = selfAvatar >= 0 ? snapshotIndexOf(prev, prevCount, selfAvatar) : -1;
      viewX[0] = ps >= 0 ? prev[ps * SNAPSHOT_STRIDE + 3] : selfX;
      viewY[0] = ps >= 0 ? prev[ps * SNAPSHOT_STRIDE + 4] : selfY;
      let nv = 1;
      if (online) {
        // The two-viewport registry: the nearer of both team slots' X1s.
        const otherAvatar = match[matchSlotOffset(slot === 0 ? 1 : 0) + MATCH_SLOT_AVATAR_ID] | 0;
        const c = otherAvatar >= 0 ? snapshotIndexOf(prev, prevCount, otherAvatar) : -1;
        if (c >= 0) {
          viewX[1] = prev[c * SNAPSHOT_STRIDE + 3];
          viewY[1] = prev[c * SNAPSHOT_STRIDE + 4];
          nv = 2;
        }
      }
      radarRegistry(candX, candY, n, viewX, viewY, nv, REGISTRY_LIMIT_TEAM_GAME, member, candKeep);

      // --- the entities in the registry.
      for (let i = 0; i < count; i++) {
        const o = i * SNAPSHOT_STRIDE;
        const archetype = snapshot[o + 1];
        if (archetype === ARCHETYPE.CONSOLE) continue; // the console's marker is placed
        if (member[entityAt[i]] === 0) continue;
        const team = snapshot[o + 2];
        blipAt(
          markerOf(archetype, sideOfTeam(mapId, team), snapshot[o + 9]),
          snapshot[o + 3],
          snapshot[o + 4],
        );
      }

      // --- the outposts' consoles, until the claim kills them.
      for (let k = 0; k < arena.staticMarkers.length; k++) {
        const pk = staticPlaced[k];
        if (pk < 0 || member[placedAt[pk]] === 0) continue;
        const m = arena.staticMarkers[k];
        blipAt(m.marker, m.x, m.y);
      }

      // --- an outpost's claim posts carry its claimer's marker.
      for (let k = 0; k < arena.claimMarkers.length; k++) {
        const j = claimSpot[k];
        if (j < 0) continue;
        const side = spotSide[j];
        if (side !== SIDE_RED && side !== SIDE_BLUE) continue;
        const pk = claimPlaced[k];
        if (pk >= 0 && member[placedAt[pk]] === 0) continue;
        const m = arena.claimMarkers[k];
        blipAt(m.markers[side - 1], m.x, m.y);
      }

      // --- the standing pickups carry the item marker.
      for (let k = 0; k < nPickups; k++) {
        if (member[pickupAt[k]] === 0) continue;
        blipAt(UNIT_MARKERS.pickup, pickups[k].x, pickups[k].y);
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
