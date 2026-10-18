// The map screen's marks over the top-down terrain window (RE hud.json
// pause_map; src/game/frame/pause_map.c 139-337): an arrow per marked actor in
// its marker's colour — tip at the middle of its box's +z face in half the
// colour, base at the -z corners in the full colour, the player's box tripled
// and labelled "P" (font 3, colour 8 in Precinct Assault's team game) — and a
// ring per objective contact with bit 1, its radius the frame clock's low byte
// (growing and snapping back every 256 ticks), the contact's colour at the
// centre fading to a black rim.
//
// The original places the "P" at half the arrow's centroid in raw units, four
// times its screen position (RE open item); Metropolis puts it on its arrow, as
// the RE suggests. The boxes are the units' footprint radii (balance.ts
// ARCHETYPE_RADIUS): Metropolis carries no model bounding tables.
//
// Raw DOM: one full-view canvas, redrawn per frame while the screen is open (the
// rings pulse on the clock), without allocating — colours and ring sprites are
// built once.

import { ARCHETYPE, ARCHETYPE_RADIUS, SNAPSHOT_STRIDE } from "@metropolis/sim";
import { ARENA_PRESENTATION, RADAR_PALETTE } from "../fcopPresentation.generated";
import { sideOfTeam } from "../sides";
import { drawChar, hudFont } from "./bitmapText";
import { markerOf } from "./radar";

/** The player's arrow: reach and box tripled (PAUSE_MAP_PLAYER_SCALE). */
const PLAYER_SCALE = 3;
/** The "P" label's colour in a team game (PAUSE_MAP_LABEL_TEAM_COLOUR). */
const LABEL_COLOUR = 8;
/** Ring sprites are drawn at this radius and scaled. */
const RING_PX = 64;

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
  const contacts = ARENA_PRESENTATION[mapId]?.contacts ?? [];
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
    draw(open, snapshot, count, clock, cx, cy, pps, selfSlot) {
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

      // --- the arrows, in id order.
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
          // "P" on the arrow's centroid, font 3 at the HUD's scale.
          const gx = (tipX + lx + rx) / 3;
          const gy = (tipY + ly + ry) / 3;
          ctx.setTransform(s, 0, 0, s, gx, gy);
          ctx.imageSmoothingEnabled = false;
          drawChar(ctx, font, 80, -5, -10, LABEL_COLOUR);
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
