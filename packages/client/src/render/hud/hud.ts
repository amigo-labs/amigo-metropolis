// The in-match HUD on the original's layout (RE hud.json; src/game/frame/draw.c
// 1340-1542, hud_weapons.c): the armour gauge with its colour ramp and blink,
// the FUTURE COP badge, the three weapon icons with their magazine counts, the
// score plate ("%03ld", flashing while an outpost is affordable), the tanks/jets
// counts ("%02ld/%02ld"), the opponent's row and gauge, the Sky Captain's level
// ("L%02d"), the lock beam and reticle. The radar is render/hud/radar.ts; the
// camera caption render/hud/caption.ts.
//
// Laid out in the original's 640 x 480 space and placed by hudLayout.ts (4:3
// box, left/right halves anchored to the edges). Drawn with the original's
// atlas page 11 and font 3 into a few canvases, each redrawn only when one of the
// values it shows changes (blinks change on the 300 Hz frame clock's bits 6 and
// 7, so at most every 64 ticks). Raw DOM, no allocation per frame: every colour
// string is built once below, numbers are drawn digit by digit (docs/specs/ui.md
// §1, CLAUDE.md renderer rule 1).
//
// It reads the snapshots and nothing else (renderer rule 4).

import "./hud.css";
import {
  MATCH_SLOT_AMMO_GUN,
  MATCH_SLOT_AMMO_HEAVY,
  MATCH_SLOT_AMMO_SPECIAL,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_INVULN,
  MATCH_SLOT_ISSUED_GUN,
  MATCH_SLOT_ISSUED_HEAVY,
  MATCH_SLOT_ISSUED_SPECIAL,
  MATCH_SLOT_OUTPOSTS,
  MATCH_SLOT_POINTS,
  MATCH_SLOT_POWER,
  MATCH_SLOT_RESPAWN_TICKS,
  MATCH_WARDEN_DIFFICULTY,
  matchSlotOffset,
} from "@metropolis/sim";
import type * as THREE from "three";
import { ARENA_PRESENTATION, HUD } from "../fcopPresentation.generated";
import { sideOfTeam, sideTextColour } from "../sides";
import { type BitmapFont, drawChar, drawNumber, hudFont } from "./bitmapText";
import { type HudImage, hudPage11, hudReticles } from "./hudArt";
import { type HudCanvas, hudCanvas, hudScale } from "./hudLayout";
import {
  countTanksJets,
  GAUGE_PX,
  gaugeDimmed,
  gaugeInvulnerable,
  gaugeRgb,
  gaugeValue,
  iconLit,
  scoreColour,
  upperCount,
  upperCountColour,
} from "./hudRules";
import { createMapOverlay, type MapOverlay } from "./mapOverlay";
import { createRadar, type Radar } from "./radar";

export interface MatchHudOptions {
  /** The arena: its sides, its reticle, its radar markers. */
  readonly mapId: string;
  /**
   * Whether the opponent is a second player over the network (the original's
   * two-player game): then the other player's gauge stands where the Sky
   * Captain's would, and no level caption is drawn.
   */
  readonly online: boolean;
}

export interface MatchHud {
  /**
   * Draws what changed. `clock` is the 300 Hz frame clock (sim tick x 10); the
   * radar takes the local X1-Alpha's interpolated pose (sim frame, radians).
   */
  refresh(
    match: Float32Array,
    snapshot: Float32Array,
    count: number,
    clock: number,
    selfX: number,
    selfY: number,
    facing: number,
  ): void;
  /**
   * The lock beam and reticle (hud_draw_lock_beam): from the X1's model point to
   * the first terrain hit toward the target (`hit` in 0..1 of the segment), the
   * reticle on the target. Three frame, metres. `active` false clears it.
   */
  drawLock(
    camera: THREE.PerspectiveCamera,
    active: boolean,
    fx: number,
    fy: number,
    fz: number,
    tx: number,
    ty: number,
    tz: number,
    hit: number,
  ): void;
  /** The radar; the map screen writes its overview state (radar.ts). */
  readonly radar: Radar;
  /** The map screen's arrows and rings over the top-down window (mapOverlay.ts). */
  readonly map: MapOverlay;
  /** Re-places every element for a viewport (CSS px). */
  layout(vw: number, vh: number): void;
  destroy(): void;
}

const css = (rgb: readonly number[], a = 1): string =>
  a === 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

// --- colour strings, built once ----------------------------------------------

/** "dim 1" draws a flat rect at half alpha (op 0x3d). */
const BACKING = css(HUD.gauge.backingRgb, 0.5);
const TICKS = css(HUD.gauge.tickRgb);
const PLATE = css(HUD.score.plateRgb, 0.5);
const UNLIT = "rgba(0,0,0,0.247)"; // the icons' unlit tint 192/255
const BEAM = css(HUD.beamRgb, 0.5);

/**
 * The gauge's fill, a column of 1-px strips per gauge value and blink state: a
 * quarter of each channel at the outer edges, the full colour at the seam in the
 * middle (two Gouraud quads, 8 px each).
 */
const STRIPS = 16;
/** One colour's strips, plain then dimmed, appended to `out`. */
function pushStrips(rgb: readonly number[], out: string[]): void {
  for (let dim = 0; dim < 2; dim++) {
    for (let k = 0; k < STRIPS; k++) {
      const half = k < STRIPS / 2 ? k : STRIPS - 1 - k; // 0 at the edge, 7 at the seam
      const shade = (0.25 + (0.75 * (half + 0.5)) / (STRIPS / 2)) * (dim ? 0.5 : 1);
      out.push(
        css([Math.round(rgb[0] * shade), Math.round(rgb[1] * shade), Math.round(rgb[2] * shade)]),
      );
    }
  }
}
const GAUGE_STYLES: string[] = [];
{
  const rgb = [0, 0, 0];
  for (let v = 0; v <= GAUGE_PX; v++) {
    gaugeRgb(v / GAUGE_PX, rgb);
    pushStrips(rgb, GAUGE_STYLES);
  }
}
/** The invulnerable arm's flat blue (0, 0x40, 0x7f) doubled, for every value. */
const INVULNERABLE_STYLES: string[] = [];
pushStrips(HUD.gauge.invulnerableRgb, INVULNERABLE_STYLES);

type Rect = readonly [number, number, number, number];
interface Gauge {
  readonly backing: Rect;
  readonly ticks: readonly Rect[];
}

/**
 * One gauge (draw.c:803-866): backing, fill from the bottom, ticks. `blue` is
 * the invulnerable arm's flat colour in place of the ramp.
 */
function drawGauge(
  ctx: CanvasRenderingContext2D,
  g: Gauge,
  frac: number,
  dim: boolean,
  blue = false,
): void {
  const b = g.backing;
  const x = b[0];
  const y = b[1];
  const h = b[3];
  ctx.fillStyle = BACKING;
  ctx.fillRect(x, y, b[2], h);
  const v = gaugeValue(frac);
  if (v > 0) {
    const styles = blue ? INVULNERABLE_STYLES : GAUGE_STYLES;
    const base = ((blue ? 0 : v * 2) + (dim ? 1 : 0)) * STRIPS;
    for (let k = 0; k < STRIPS; k++) {
      ctx.fillStyle = styles[base + k];
      ctx.fillRect(x + k, y + h - v, 1, v);
    }
  }
  ctx.fillStyle = TICKS;
  for (let i = 0; i < g.ticks.length; i++) {
    const t = g.ticks[i];
    ctx.fillRect(t[0], t[1], t[2], t[3]);
  }
}

/** An icon from page 11, unlit (grey) unless `lit`. */
function drawIcon(
  ctx: CanvasRenderingContext2D,
  page: HudImage,
  icon: Rect,
  box: Rect,
  lit: boolean,
): void {
  if (!page.ready) return;
  ctx.drawImage(page.image, icon[0], icon[1], icon[2], icon[3], box[0], box[1], box[2], box[3]);
  if (lit) return;
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = UNLIT;
  ctx.fillRect(box[0], box[1], box[2], box[3]);
  ctx.globalCompositeOperation = "source-over";
}

/** A score: the four-digit plate and pen from 1000 up (hud.json score). */
function drawScore(
  ctx: CanvasRenderingContext2D,
  font: BitmapFont,
  score: number,
  dy: number,
  colour: number,
): void {
  const wide = score >= 1000;
  const plate = wide ? HUD.score.plate4 : HUD.score.plate;
  const pen = wide ? HUD.score.text4 : HUD.score.text;
  ctx.fillStyle = PLATE;
  ctx.fillRect(plate[0], plate[1] + dy, plate[2], plate[3]);
  drawNumber(ctx, font, score, 3, pen[0], pen[1] + dy, colour);
}

/** "%02ld/%02ld" on its plate. */
function drawCounts(
  ctx: CanvasRenderingContext2D,
  font: BitmapFont,
  plate: Rect,
  pen: readonly [number, number],
  tanks: number,
  jets: number,
  colour: number,
): void {
  ctx.fillStyle = PLATE;
  ctx.fillRect(plate[0], plate[1], plate[2], plate[3]);
  let x = drawNumber(ctx, font, tanks, 2, pen[0], pen[1], colour);
  x = drawChar(ctx, font, 47, x, pen[1], colour);
  drawNumber(ctx, font, jets, 2, x, pen[1], colour);
}

/** The magazine each slot fires from: block B while powered, else block A. */
const AMMO_FIELDS = [MATCH_SLOT_AMMO_GUN, MATCH_SLOT_AMMO_HEAVY, MATCH_SLOT_AMMO_SPECIAL];
/** The issued magazine, block A, whether or not the slot is powered. */
const ISSUED_FIELDS = [MATCH_SLOT_ISSUED_GUN, MATCH_SLOT_ISSUED_HEAVY, MATCH_SLOT_ISSUED_SPECIAL];

/** Builds the HUD for one player slot. */
export function createMatchHud(
  slot: number,
  opts: MatchHudOptions,
  parent: HTMLElement = document.body,
): MatchHud {
  const root = document.createElement("div");
  root.className = "mhud";
  parent.appendChild(root);
  // First, so the HUD draws over the map screen's marks, as the original's does.
  const map = createMapOverlay(opts.mapId, root);
  const font = hudFont();
  const page = hudPage11();
  const reticles = hudReticles();
  const other = slot === 0 ? 1 : 0;
  const ownColour = sideTextColour(sideOfTeam(opts.mapId, slot));
  const otherColour = sideTextColour(sideOfTeam(opts.mapId, other));
  const reticleCol = ARENA_PRESENTATION[opts.mapId]?.reticle ?? 0;

  // Bottom-left: gauge, badge, weapons. Bottom-right: opponent gauge, badge,
  // level. Top-right: the score and counts rows. (640 units.)
  const left = hudCanvas(root, 0, 336, 304, 144);
  const right = hudCanvas(root, 560, 336, 80, 144);
  const top = hudCanvas(root, 552, 0, 88, 100);
  const canvases: HudCanvas[] = [left, right, top];
  const radar = createRadar(root, opts.mapId, slot);

  // The lock: a full-viewport overlay, cleared and drawn per frame while a lock
  // stands (the target moves every frame), in CSS px.
  const lockEl = document.createElement("canvas");
  lockEl.className = "mhud-lock";
  root.appendChild(lockEl);
  const lockCtx = lockEl.getContext("2d") as CanvasRenderingContext2D;
  let lockDrawn = false;
  let viewW = 1;
  let viewH = 1;

  // Last-drawn keys per canvas; NaN forces the first draw.
  const leftKey = new Float64Array(16).fill(Number.NaN);
  const rightKey = new Float64Array(6).fill(Number.NaN);
  const topKey = new Float64Array(8).fill(Number.NaN);
  const counts = new Int32Array(2);

  const changed = (key: Float64Array, i: number, v: number, dirty: boolean): boolean => {
    if (key[i] === v && !dirty) return false;
    key[i] = v;
    return true;
  };

  return {
    radar,
    map,
    refresh(match, snapshot, count, clock, selfX, selfY, facing) {
      const mine = matchSlotOffset(slot);
      const theirs = matchSlotOffset(other);
      const ready = (font.ready ? 1 : 0) + (page.ready ? 2 : 0);
      const respawn = match[mine + MATCH_SLOT_RESPAWN_TICKS] | 0;
      const down = respawn > 0;
      const hp = down ? 0 : match[mine + MATCH_SLOT_HP_FRAC];
      const power = match[mine + MATCH_SLOT_POWER] | 0;

      // --- bottom left -----------------------------------------------------
      {
        const dirty = left.dirty;
        let d = changed(leftKey, 0, ready, dirty);
        d = changed(leftKey, 1, gaugeValue(hp), d) || d;
        d = changed(leftKey, 2, gaugeDimmed(hp, clock) ? 1 : 0, d) || d;
        d = changed(leftKey, 3, upperCountColour(clock), d) || d;
        const blue = !down && gaugeInvulnerable(match[mine + MATCH_SLOT_INVULN], clock);
        d = changed(leftKey, 13, blue ? 1 : 0, d) || d;
        for (let w = 0; w < 3; w++) {
          const powered = (power & (1 << w)) !== 0;
          // Lower: the issued magazine, block A; upper: block B while it holds
          // rounds (hud.json weapons.lower_count / upper_count).
          d = changed(leftKey, 4 + w * 3, match[mine + ISSUED_FIELDS[w]] | 0, d) || d;
          d =
            changed(leftKey, 5 + w * 3, upperCount(powered, match[mine + AMMO_FIELDS[w]] | 0), d) ||
            d;
          d = changed(leftKey, 6 + w * 3, iconLit(powered, clock) ? 1 : 0, d) || d;
        }
        if (d) {
          left.dirty = false;
          const ctx = left.ctx;
          left.begin();
          if (leftKey[13] === 1) {
            drawGauge(ctx, HUD.gauge.invulnerable, hp, leftKey[2] === 1, true);
          } else {
            drawGauge(ctx, HUD.gauge.own, hp, leftKey[2] === 1);
          }
          drawIcon(ctx, page, HUD.badge.icon, HUD.badge.own, false);
          for (let w = 0; w < 3; w++) {
            const s = HUD.weapons[w];
            drawIcon(ctx, page, s.icon, s.box, leftKey[6 + w * 3] === 1);
            drawNumber(
              ctx,
              font,
              leftKey[4 + w * 3],
              0,
              s.lower[0],
              s.lower[1],
              HUD.lowerCountColour,
            );
            const b = leftKey[5 + w * 3];
            if (b > 0) drawNumber(ctx, font, b, 0, s.upper[0], s.upper[1], leftKey[3]);
          }
        }
      }

      // --- bottom right ----------------------------------------------------
      {
        const level = opts.online ? 0 : match[MATCH_WARDEN_DIFFICULTY] | 0;
        const theirDown = (match[theirs + MATCH_SLOT_RESPAWN_TICKS] | 0) > 0;
        const theirHp = theirDown ? 0 : match[theirs + MATCH_SLOT_HP_FRAC];
        const dirty = right.dirty;
        let d = changed(rightKey, 0, ready, dirty);
        d = changed(rightKey, 1, gaugeValue(theirHp), d) || d;
        d = changed(rightKey, 2, gaugeDimmed(theirHp, clock) ? 1 : 0, d) || d;
        d = changed(rightKey, 3, level, d) || d;
        if (d) {
          right.dirty = false;
          const ctx = right.ctx;
          right.begin();
          // Not drawn while its X1 (or the Sky Captain) is down: hp <= 0.
          if (theirHp > 0) drawGauge(ctx, HUD.gauge.opponent, theirHp, rightKey[2] === 1);
          drawIcon(ctx, page, HUD.badge.icon, HUD.badge.opponent, false);
          if (level > 0) {
            const pen = HUD.level.text;
            const x = drawChar(ctx, font, 76, pen[0], pen[1], HUD.level.colour);
            drawNumber(ctx, font, level, 2, x, pen[1], HUD.level.colour);
          }
        }
      }

      // --- top right -------------------------------------------------------
      {
        const ownScore = match[mine + MATCH_SLOT_POINTS] | 0;
        const theirScore = match[theirs + MATCH_SLOT_POINTS] | 0;
        const claimed =
          (match[mine + MATCH_SLOT_OUTPOSTS] | 0) + (match[theirs + MATCH_SLOT_OUTPOSTS] | 0);
        const dirty = top.dirty;
        let d = changed(topKey, 0, ready, dirty);
        d = changed(topKey, 1, ownScore, d) || d;
        d = changed(topKey, 2, scoreColour(ownScore, ownColour, claimed, clock), d) || d;
        countTanksJets(snapshot, count, slot, counts);
        d = changed(topKey, 3, counts[0], d) || d;
        d = changed(topKey, 4, counts[1], d) || d;
        d = changed(topKey, 5, theirScore, d) || d;
        countTanksJets(snapshot, count, other, counts);
        d = changed(topKey, 6, counts[0], d) || d;
        d = changed(topKey, 7, counts[1], d) || d;
        if (d) {
          top.dirty = false;
          const ctx = top.ctx;
          top.begin();
          drawScore(ctx, font, ownScore, 0, topKey[2]);
          drawCounts(ctx, font, HUD.counts.plate, HUD.counts.text, topKey[3], topKey[4], ownColour);
          // The opponent's row, one viewport always (draw.c:1460): its score is
          // in its own colour and never flashes.
          const dy = HUD.opponent.scorePlate[1] - HUD.score.plate[1];
          drawScore(ctx, font, theirScore, dy, otherColour);
          drawCounts(
            ctx,
            font,
            HUD.opponent.countsPlate,
            HUD.opponent.countsText,
            topKey[6],
            topKey[7],
            otherColour,
          );
        }
      }

      radar.refresh(match, snapshot, count, clock, selfX, selfY, facing, down);
    },

    drawLock(camera, active, fx, fy, fz, tx, ty, tz, hit) {
      if (lockDrawn) {
        lockCtx.setTransform(1, 0, 0, 1, 0, 0);
        lockCtx.clearRect(0, 0, lockEl.width, lockEl.height);
        lockDrawn = false;
      }
      if (!active) return;
      // The target's point projected; behind the camera nothing is drawn.
      if (!project(camera, tx, ty, tz, viewW, viewH, scratchPx)) return;
      const cx = scratchPx[0];
      const cy = scratchPx[1];
      const s = hudScale(viewW, viewH);
      // The beam: from the mech to the first terrain hit, half alpha.
      const hx = fx + (tx - fx) * hit;
      const hy = fy + (ty - fy) * hit;
      const hz = fz + (tz - fz) * hit;
      if (project(camera, fx, fy, fz, viewW, viewH, scratchPx)) {
        const ax = scratchPx[0];
        const ay = scratchPx[1];
        if (project(camera, hx, hy, hz, viewW, viewH, scratchPx)) {
          lockCtx.strokeStyle = BEAM;
          lockCtx.lineWidth = Math.max(1, s);
          lockCtx.beginPath();
          lockCtx.moveTo(ax, ay);
          lockCtx.lineTo(scratchPx[0], scratchPx[1]);
          lockCtx.stroke();
        }
      }
      // The reticle: 16 x 16 texels drawn 32 x 32 (640 units), half alpha.
      if (reticles.ready) {
        const size = HUD.reticle.size * s;
        const t = HUD.reticle.texels;
        lockCtx.imageSmoothingEnabled = false;
        lockCtx.globalAlpha = 0.5;
        lockCtx.drawImage(
          reticles.image,
          reticleCol * t,
          0,
          t,
          t,
          cx - size / 2,
          cy - size / 2,
          size,
          size,
        );
        lockCtx.globalAlpha = 1;
      }
      lockDrawn = true;
    },

    layout(vw, vh) {
      viewW = vw;
      viewH = vh;
      for (let i = 0; i < canvases.length; i++) canvases[i].place(vw, vh);
      radar.layout(vw, vh);
      map.layout(vw, vh);
      lockEl.width = Math.max(1, Math.round(vw));
      lockEl.height = Math.max(1, Math.round(vh));
      lockEl.style.width = `${vw}px`;
      lockEl.style.height = `${vh}px`;
      lockDrawn = false;
    },

    destroy() {
      root.remove();
    },
  };
}

// Projection scratch (renderer rule 1).
const scratchPx = new Float64Array(2);
const ndc = { x: 0, y: 0, z: 0 };

/** World point -> CSS px of a `vw` x `vh` view; false behind the camera. */
function project(
  camera: THREE.PerspectiveCamera,
  x: number,
  y: number,
  z: number,
  vw: number,
  vh: number,
  out: Float64Array,
): boolean {
  // view = inverse(world) * p, then the projection; by hand to stay allocation-free.
  const m = camera.matrixWorldInverse.elements;
  const vx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const vy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const vz = m[2] * x + m[6] * y + m[10] * z + m[14];
  if (vz > -camera.near) return false;
  const p = camera.projectionMatrix.elements;
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
  ndc.x = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / cw;
  ndc.y = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / cw;
  out[0] = ((ndc.x + 1) / 2) * vw;
  out[1] = ((1 - ndc.y) / 2) * vh;
  return true;
}
