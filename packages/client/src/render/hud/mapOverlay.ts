// The map screen's marks over the top-down terrain window (RE hud.json
// pause_map; src/game/frame/pause_map.c 139-337): an arrow per marked actor in
// its marker's colour — tip at the middle of its box's +z face in half the
// colour, base at the -z corners in the full colour, the player's box tripled
// and labelled "P" (font 3, colour 8 in Precinct Assault's team game) — and a
// ring per objective contact with bit 1, its radius the frame clock's low byte
// (growing and snapping back every 256 ticks), the contact's colour at the
// centre fading to a black rim.
//
// The placed actors Metropolis has no entity for get theirs too, on box 0 of
// their model's current frame (`cobj_bbox_frame_box`: 3DBB entry f for frame f,
// gen:presentation `boxes`) turned by their record's yaw: the outposts' consoles
// until the claim, the claim posts in the claimer's marker after it (their cloth
// steps its frames on the sim's clock as the scenery draws it, `clothFrame`), the
// standing pickups turning at their spin. The type-96 Props are no actors and
// get none.
//
// The "P" is the original's: at four times the arrow's centroid (labelPen; RE
// M3-PA read the two coordinate spaces), so mostly off the view. The entities' boxes are their footprint radii (balance.ts
// ARCHETYPE_RADIUS): Metropolis carries no unit bounding tables.
//
// Raw DOM: one full-view canvas, redrawn per frame while the screen is open (the
// rings pulse on the clock), without allocating — colours and ring sprites are
// built once.

import {
  ARCHETYPE,
  ARCHETYPE_RADIUS,
  getMapById,
  MATCH_PICKUPS,
  MATCH_TICK,
  type MapData,
  SNAPSHOT_STRIDE,
} from "@metropolis/sim";
import { SCENERY_PLACEMENTS } from "../arenaScenery.generated";
import { ARENA_PRESENTATION, RADAR_PALETTE, UNIT_MARKERS } from "../fcopPresentation.generated";
import { SIDE_BLUE, SIDE_RED, sideOfTeam } from "../sides";
import { drawChar, hudFont } from "./bitmapText";
import { markerOf, outpostSidesOf, standsAt } from "./radar";

/** The player's arrow: reach and box tripled (PAUSE_MAP_PLAYER_SCALE). */
const PLAYER_SCALE = 3;
/** The "P" label's offset, 640 x 480 px: PAUSE_MAP_LABEL_OFFSET 4 in 320 x 240. */
const LABEL_OFFSET_PX = 8;
/** The "P" label's colour in a team game (PAUSE_MAP_LABEL_TEAM_COLOUR). */
const LABEL_COLOUR = 8;
/** Ring sprites are drawn at this radius and scaled. */
const RING_PX = 64;
/** A record angle's turn, 4096ths, to radians. */
const UNIT_RAD = (Math.PI * 2) / 4096;
/** Engine ticks a sim tick: the pickups' spin clock (render/pickups.ts). */
const ENGINE_TICKS_PER_SIM_TICK = 10;

/** A model's arrow boxes, one per frame or one for all (gen:presentation `boxes`). */
type Boxes = readonly (readonly [number, number, number, number])[];

/**
 * The box of frame `frame` (`cobj_bbox_frame_box`): entry f is frame f's, and a
 * model whose frames share one box carries one.
 */
export function boxFrame(boxes: Boxes, frame: number): readonly [number, number, number, number] {
  return boxes[frame < boxes.length ? frame : boxes.length - 1];
}

/**
 * The frame a looping morph shows `engine` engine ticks into the match: track 0
 * from frame 0, a frame per `period` ticks (render/props.ts propMorphFrame, the
 * claim posts' cloth). Frozen while the sim is paused, as the scenery is.
 */
export function clothFrame(frames: number, period: number, engine: number): number {
  return Math.floor(engine / period) % frames;
}

/**
 * An arrow's three corners (pause_map_draw_actor 0x004516e0): the box (cx, cz,
 * lx, lz) in the model's frame, placed at (px, py) window px turned by `yaw`
 * (the model's +z along (cos, sin) in the map frame, its +x along (-sin, cos)),
 * `pps` px a metre. The tip is the middle of the box's +z face, the base its
 * -z corners. Writes [tipX, tipY, rightX, rightY, leftX, leftY] into `out`.
 */
export function arrowCorners(
  px: number,
  py: number,
  yaw: number,
  cx: number,
  cz: number,
  lx: number,
  lz: number,
  pps: number,
  out: Float64Array,
): void {
  const c = Math.cos(yaw) * pps;
  const s = Math.sin(yaw) * pps;
  out[0] = px - s * cx + c * (cz + lz);
  out[1] = py + c * cx + s * (cz + lz);
  out[2] = px - s * (cx + lx) + c * (cz - lz);
  out[3] = py + c * (cx + lx) + s * (cz - lz);
  out[4] = px - s * (cx - lx) + c * (cz - lz);
  out[5] = py + c * (cx - lx) + s * (cz - lz);
}
const corners = new Float64Array(6);

/**
 * The "P" label's pen for the player's arrow centroid (gx, gy), view px from
 * the window's top-left, `s` view px per 640 x 480 px (pause_map_draw_actor
 * 0x00451995..0x00451a0a). The original passes `cfnt_text_draw` the three
 * vertices' sum over six less four: half the centroid, in its 320 x 240 space,
 * which it doubles into 640 x 480 pixels (0x00435fde; the glyph record, op
 * 0x8e, is not scaled again). The arrow's own vertices are quarter pixels of
 * 640 x 480 (`PAUSE_MAP_SCALE` 80 a sample; the walker scales a vertex record
 * by the mode over four, fcop/draw_submit_soft.h). So the label stands at four
 * times the arrow's centroid, less 8 px: on screen only while the arrow is in
 * the window's top-left sixteenth. Writes [x, y] into `out`.
 */
export function labelPen(gx: number, gy: number, s: number, out: Float64Array): void {
  out[0] = 4 * gx - LABEL_OFFSET_PX * s;
  out[1] = 4 * gy - LABEL_OFFSET_PX * s;
}
const pen = new Float64Array(2);

/** One arrow: the tip in half the colour, the base corners in the full one. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  yaw: number,
  cx: number,
  cz: number,
  lx: number,
  lz: number,
  pps: number,
  colour: number,
): void {
  arrowCorners(px, py, yaw, cx, cz, lx, lz, pps, corners);
  const tipX = corners[0];
  const tipY = corners[1];
  const rx = corners[2];
  const ry = corners[3];
  const lxp = corners[4];
  const lyp = corners[5];
  ctx.fillStyle = FULL[colour];
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(rx, ry);
  ctx.lineTo(lxp, lyp);
  ctx.closePath();
  ctx.fill();
  // The tip's half colour, fading to the full at the base: the front half.
  ctx.fillStyle = HALF[colour];
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo((tipX + rx) / 2, (tipY + ry) / 2);
  ctx.lineTo((tipX + lxp) / 2, (tipY + lyp) / 2);
  ctx.closePath();
  ctx.fill();
}

const FULL: readonly string[] = RADAR_PALETTE.map((c) =>
  c ? `rgb(${c[0]},${c[1]},${c[2]})` : "rgba(0,0,0,0)",
);
/** The tip's half colour: `(colour >> 1) & mask`, each channel halved. */
const HALF: readonly string[] = RADAR_PALETTE.map((c) =>
  c ? `rgb(${c[0] >> 1},${c[1] >> 1},${c[2] >> 1})` : "rgba(0,0,0,0)",
);

export interface MapOverlay {
  /**
   * Draws the marks for the window centred on (cx, cy) metres at `pps` CSS px a
   * sample, or clears them when `open` is false.
   */
  draw(
    open: boolean,
    match: Float32Array,
    snapshot: Float32Array,
    count: number,
    clock: number,
    cx: number,
    cy: number,
    pps: number,
    selfSlot: number,
  ): void;
  layout(vw: number, vh: number): void;
  destroy(): void;
}

export function createMapOverlay(mapId: string, parent: HTMLElement = document.body): MapOverlay {
  const el = document.createElement("canvas");
  el.className = "mhud-map";
  parent.appendChild(el);
  const ctx = el.getContext("2d") as CanvasRenderingContext2D;
  const font = hudFont();
  const presentation = ARENA_PRESENTATION[mapId];
  const contacts = presentation?.contacts ?? [];
  let map: MapData | null = null;
  try {
    map = getMapById(mapId);
  } catch {
    map = null;
  }
  const spots = map?.outpostSpots ?? [];
  const spotSide = new Int32Array(spots.length);
  const pickups = map?.pickups ?? [];
  const nPickups = pickups.length < 24 ? pickups.length : 24;
  const placements = SCENERY_PLACEMENTS[mapId]?.placements ?? [];
  const morphs = SCENERY_PLACEMENTS[mapId]?.morphs ?? {};
  const boxes = presentation?.boxes ?? {};
  /**
   * The placed actors with a marker: their scenery placement, their marker (or
   * the claim's pair), and their model's box.
   */
  interface Placed {
    readonly x: number;
    readonly y: number;
    readonly yaw: number;
    readonly show: (typeof placements)[number]["show"];
    readonly outpost: number;
    /** Marker while standing, 0 for a claim post (its claimer's, below). */
    readonly marker: number;
    readonly claim: readonly [number, number] | null;
    readonly boxes: Boxes;
    /** Its model's morph (frames, period), or one frame when it stands still. */
    readonly frames: number;
    readonly period: number;
  }
  const placed: Placed[] = [];
  const addPlaced = (record: string, marker: number, claim: readonly [number, number] | null) => {
    const p = placements.find((q) => q.record === record);
    const b = p ? boxes[p.cobj] : undefined;
    if (!p || !b || b.length === 0) return;
    const morph = morphs[p.cobj];
    placed.push({
      x: p.x,
      y: p.y,
      yaw: p.yaw * UNIT_RAD,
      show: p.show,
      outpost: p.outpost,
      marker,
      claim,
      boxes: b,
      frames: morph?.frames ?? 1,
      period: morph?.period ?? 1,
    });
  };
  for (const m of presentation?.staticMarkers ?? []) addPlaced(m.record, m.marker, null);
  for (const m of presentation?.claimMarkers ?? []) addPlaced(m.record, 0, m.markers);
  // A pickup steps no frames: frame 0's box.
  const pickupBox = pickups.map((k) => {
    const b = boxes[k.model];
    return b && b.length > 0 ? boxFrame(b, 0) : null;
  });
  const rings: (HTMLCanvasElement | null)[] = new Array(RADAR_PALETTE.length).fill(null);
  let vw = 1;
  let vh = 1;
  let drawn = false;

  /** The ring sprite of a palette colour: the colour at the centre, black at the rim. */
  const ringOf = (colour: number): HTMLCanvasElement | null => {
    const have = rings[colour];
    if (have) return have;
    const rgb = RADAR_PALETTE[colour];
    if (!rgb) return null;
    const c = document.createElement("canvas");
    c.width = RING_PX * 2;
    c.height = RING_PX * 2;
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(RING_PX, RING_PX, 0, RING_PX, RING_PX, RING_PX);
    grad.addColorStop(0, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
    grad.addColorStop(1, "rgb(0,0,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(RING_PX, RING_PX, RING_PX, 0, Math.PI * 2);
    g.fill();
    rings[colour] = c;
    return c;
  };
  // Built now: the frame loop must not build them.
  for (let k = 0; k < contacts.length; k++) ringOf(contacts[k].colour);

  return {
    draw(open, match, snapshot, count, clock, cx, cy, pps, selfSlot) {
      if (drawn) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, el.width, el.height);
        drawn = false;
      }
      if (!open) return;
      drawn = true;
      const x0 = cx - vw / pps / 2;
      const y0 = cy - vh / pps / 2;
      const s = pps / 20; // the HUD's scale: 20 px a sample at 640 x 480

      // --- the contact rings: 2 x (clock & 0xff) raw units, a quarter px each.
      const r = ((clock & 0xff) / 2) * s;
      if (r > 0) {
        ctx.globalAlpha = 0.5;
        for (let k = 0; k < contacts.length; k++) {
          const c = contacts[k];
          if ((c.shown & 2) === 0) continue;
          const sprite = rings[c.colour];
          if (!sprite) continue;
          const px = (c.x - x0) * pps;
          const py = (c.y - y0) * pps;
          ctx.drawImage(sprite, px - r, py - r, 2 * r, 2 * r);
        }
        ctx.globalAlpha = 1;
      }

      // --- the placed actors' arrows: the outposts' consoles and claim posts.
      const engine = match[MATCH_TICK] * ENGINE_TICKS_PER_SIM_TICK;
      outpostSidesOf(snapshot, count, spots, mapId, spotSide);
      for (let k = 0; k < placed.length; k++) {
        const p = placed[k];
        const side = p.outpost >= 0 ? (spotSide[p.outpost] ?? 0) : 0;
        if (!standsAt(p.show, side !== 0)) continue;
        let marker = p.marker;
        if (p.claim) marker = side === SIDE_RED || side === SIDE_BLUE ? p.claim[side - 1] : 0;
        if (marker === 0) continue;
        const b = boxFrame(p.boxes, clothFrame(p.frames, p.period, engine));
        const reach = (Math.abs(b[0]) + b[2] + Math.abs(b[1]) + b[3]) * pps;
        const px = (p.x - x0) * pps;
        const py = (p.y - y0) * pps;
        if (px < -reach || py < -reach || px > vw + reach || py > vh + reach) continue;
        drawArrow(ctx, px, py, p.yaw, b[0], b[1], b[2], b[3], pps, marker & 0x1f);
      }
      // --- the standing pickups, turned by their spin on the sim's clock.
      const up = match[MATCH_PICKUPS] | 0;
      for (let k = 0; k < nPickups; k++) {
        const b = pickupBox[k];
        if (!b || (up & (1 << k)) === 0) continue;
        const q = pickups[k];
        const reach = (Math.abs(b[0]) + b[2] + Math.abs(b[1]) + b[3]) * pps;
        const px = (q.x - x0) * pps;
        const py = (q.y - y0) * pps;
        if (px < -reach || py < -reach || px > vw + reach || py > vh + reach) continue;
        const yaw = ((((engine * q.spin) % 4096) + 4096) % 4096) * UNIT_RAD;
        drawArrow(ctx, px, py, yaw, b[0], b[1], b[2], b[3], pps, UNIT_MARKERS.pickup & 0x1f);
      }

      // --- the entities' arrows, in id order.
      for (let i = 0; i < count; i++) {
        const o = i * SNAPSHOT_STRIDE;
        const archetype = snapshot[o + 1];
        const team = snapshot[o + 2];
        const marker = markerOf(archetype, sideOfTeam(mapId, team), snapshot[o + 9]);
        if (marker === 0) continue;
        const colour = marker & 0x1f;
        const self = archetype === ARCHETYPE.AVATAR && team === selfSlot;
        const reach = (ARCHETYPE_RADIUS[archetype] ?? 0.5) * (self ? PLAYER_SCALE : 1);
        const px = (snapshot[o + 3] - x0) * pps;
        const py = (snapshot[o + 4] - y0) * pps;
        const rr = reach * pps;
        if (px < -rr || py < -rr || px > vw + rr || py > vh + rr) continue;
        const yaw = snapshot[o + 6];
        const fx = Math.cos(yaw) * rr;
        const fy = Math.sin(yaw) * rr;
        const tipX = px + fx;
        const tipY = py + fy;
        const lx = px - fx - fy; // base corners: -z face, both sides
        const ly = py - fy + fx;
        const rx = px - fx + fy;
        const ry = py - fy - fx;
        ctx.fillStyle = FULL[colour];
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(rx, ry);
        ctx.lineTo(lx, ly);
        ctx.closePath();
        ctx.fill();
        // The tip's half colour, fading to the full at the base: the front half.
        ctx.fillStyle = HALF[colour];
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo((tipX + rx) / 2, (tipY + ry) / 2);
        ctx.lineTo((tipX + lx) / 2, (tipY + ly) / 2);
        ctx.closePath();
        ctx.fill();
        if (self) {
          // "P", its pen at four times the arrow's centroid less 8 px
          // (labelPen), font 3 at the HUD's scale; off the view it is clipped.
          labelPen((tipX + lx + rx) / 3, (tipY + ly + ry) / 3, s, pen);
          ctx.setTransform(s, 0, 0, s, pen[0], pen[1]);
          ctx.imageSmoothingEnabled = false;
          drawChar(ctx, font, 80, 0, 0, LABEL_COLOUR);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
      }
    },
    layout(w, h) {
      vw = Math.max(1, w);
      vh = Math.max(1, h);
      el.width = Math.round(vw);
      el.height = Math.round(vh);
      el.style.width = `${vw}px`;
      el.style.height = `${vh}px`;
      drawn = false;
    },
    destroy() {
      el.remove();
    },
  };
}
