// In-match HUD, after the original's cockpit readouts
// (docs/renders/fcop-ui/hud-in-match.png): round radar top-left, per-team score
// and unit columns top-right, a health bar and the three ammo counters along
// the bottom.
//
// Raw DOM on purpose (docs/specs/ui.md §1). This is drawn while a match runs,
// so renderer rule 1 applies: nothing here allocates per frame. Every element
// is built once; refresh() compares against the last value written and touches
// the DOM only on a change, and the radar draws into a preallocated canvas with
// module-scope scratch.
//
// It reads the snapshots and nothing else (renderer rule 4). The old text HUD
// reached into sim internals as an acknowledged debug exception; that exception
// is retired here, and the text itself lives on in hudText.ts purely as the
// harness hook.

// Both imported here rather than relying on the menu bundle: a deep link like
// ?play=1 never mounts the menu, and the HUD must not depend on someone else
// having pulled in the tokens it uses. The bundler dedupes.
import "../../ui/cockpit.css";
import "./hud.css";
import {
  EVENT_STRIDE,
  type EventBuffer,
  MATCH_OUTRO_WINNER,
  MATCH_SLOT_AMMO_GUN,
  MATCH_SLOT_AMMO_HEAVY,
  MATCH_SLOT_AMMO_SPECIAL,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_LOCK,
  MATCH_SLOT_OUTPOSTS,
  MATCH_SLOT_POINTS,
  MATCH_SLOT_POWER,
  MATCH_SLOT_RESPAWN_TICKS,
  MATCH_SLOT_UNITS,
  MATCH_WINNER,
  matchSlotOffset,
  SNAPSHOT_STRIDE,
  TICK_HZ,
} from "@metropolis/sim";

import { classifyTickerEvent, TICKER_KINDS, TICKER_TEXT } from "./ticker";

const RADAR_PX = 132;
/** Blip radii, in canvas px. The avatar reads larger so it is findable. */
const BLIP_R = 2;
const BLIP_R_SELF = 3.5;

/** Ticker geometry: fixed rows, newest at the bottom. */
const TICKER_ROWS = 4;
const TICKER_ROW_MS = 5000;
/** Per-(type, team) repeat suppression: alarms fire in bursts. */
const TICKER_REPEAT_MS = 5000;

/** Pre-built banner strings (renderer rule 1: refresh() builds no strings). */
const BANNER_OVER = ["MATCH OVER — BLUE BREACHED THE GATE", "MATCH OVER — RED BREACHED THE GATE"];
const BANNER_BREACH = ["BLUE BREACHED THE GATE", "RED BREACHED THE GATE"];

export interface MatchHudOptions {
  /** Number of outpost spots on the arena; 0 hides the outpost readout. */
  outpostTotal?: number;
}

export interface MatchHud {
  /** Writes changed values only. Safe to call every frame; cheap when idle. */
  refresh(match: Float32Array, snapshot: Float32Array, count: number, arenaExtent: number): void;
  /**
   * Drains this tick's objective events (capture/claim/alarm/breach) into
   * the ticker. Call once per sim step, like the audio pump; allocation-free.
   */
  pumpEvents(events: EventBuffer, nowMs: number): void;
  /** Removes the HUD from the DOM. */
  destroy(): void;
}

/** One text node plus the value last written to it, so we can skip no-op writes. */
interface Cell {
  readonly node: HTMLElement;
  last: string;
}

function cell(parent: HTMLElement, className: string): Cell {
  const node = document.createElement("div");
  node.className = className;
  parent.appendChild(node);
  return { node, last: "\u0000" };
}

function write(c: Cell, value: string): void {
  if (c.last === value) return;
  c.last = value;
  c.node.textContent = value;
}

function div(parent: HTMLElement, className: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  parent.appendChild(node);
  return node;
}

/**
 * Builds the HUD for one player slot and returns its updater.
 * `arenaExtent` scales world coordinates onto the radar.
 */
export function createMatchHud(
  slot: number,
  opts: MatchHudOptions = {},
  parent: HTMLElement = document.body,
): MatchHud {
  const outpostTotal = opts.outpostTotal ?? 0;
  const root = div(parent, "mhud");

  // --- Radar ---------------------------------------------------------------
  const radarWrap = div(root, "mhud-radar");
  const canvas = document.createElement("canvas");
  canvas.className = "mhud-radar-canvas";
  canvas.width = RADAR_PX;
  canvas.height = RADAR_PX;
  radarWrap.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const radarLabel = cell(radarWrap, "mhud-radar-label");
  write(radarLabel, "Sky Camera");

  // --- Score column --------------------------------------------------------
  // Own team first, enemy below, matching the original's stacked readouts.
  const scores = div(root, "mhud-scores");
  const own = div(scores, "mhud-score mhud-score--own");
  const ownPoints = cell(own, "mhud-points");
  const ownUnits = cell(own, "mhud-units");
  const ownOutposts = outpostTotal > 0 ? cell(own, "mhud-units mhud-outposts") : null;
  const foe = div(scores, "mhud-score mhud-score--foe");
  const foePoints = cell(foe, "mhud-points");
  const foeUnits = cell(foe, "mhud-units");
  const foeOutposts = outpostTotal > 0 ? cell(foe, "mhud-units mhud-outposts") : null;

  // --- Objective ticker ------------------------------------------------------
  // Four fixed rows top-centre; rows expire in refresh(). Built once, text
  // rewritten in place — the pump allocates nothing.
  const tickerWrap = div(root, "mhud-ticker");
  const tickerCells: Cell[] = [];
  const tickerText: string[] = [];
  const tickerUntil: number[] = [];
  for (let i = 0; i < TICKER_ROWS; i++) {
    tickerCells.push(cell(tickerWrap, "mhud-ticker-row"));
    tickerText.push("");
    tickerUntil.push(0);
  }
  /** Next allowed show time per (kind, team). */
  const tickerNextAt = new Float64Array(TICKER_KINDS * 2);

  // --- Bottom bar ----------------------------------------------------------
  const bottom = div(root, "mhud-bottom");
  const healthWrap = div(bottom, "mhud-health");
  const healthFill = div(healthWrap, "mhud-health-fill");
  const ammo = div(bottom, "mhud-ammo");
  const ammoGun = cell(ammo, "mhud-ammo-cell mhud-ammo-cell--gun");
  const ammoHeavy = cell(ammo, "mhud-ammo-cell mhud-ammo-cell--heavy");
  const ammoSpecial = cell(ammo, "mhud-ammo-cell mhud-ammo-cell--special");
  // The lock (fcop-fidelity.md W2): the guns hit nothing else, so the HUD says
  // whether there is one.
  const lockCell = cell(bottom, "mhud-lock");
  const banner = cell(root, "mhud-banner");

  // Scratch: last written values for things that are not text cells.
  let lastHpPct = -1;
  let lastRespawn = -1;
  let lastBanner = "";
  let lastPower = -1;

  const pushTickerRow = (text: string, nowMs: number): void => {
    // Shift up, newest last — fixed-size, no allocation.
    for (let i = 0; i < TICKER_ROWS - 1; i++) {
      tickerText[i] = tickerText[i + 1];
      tickerUntil[i] = tickerUntil[i + 1];
    }
    tickerText[TICKER_ROWS - 1] = text;
    tickerUntil[TICKER_ROWS - 1] = nowMs + TICKER_ROW_MS;
  };

  return {
    refresh(match, snapshot, count, arenaExtent): void {
      const mine = matchSlotOffset(slot);
      const other = matchSlotOffset(slot === 0 ? 1 : 0);

      write(ownPoints, String(match[mine + MATCH_SLOT_POINTS] | 0));
      write(ownUnits, `${match[mine + MATCH_SLOT_UNITS] | 0} units`);
      write(foePoints, String(match[other + MATCH_SLOT_POINTS] | 0));
      write(foeUnits, `${match[other + MATCH_SLOT_UNITS] | 0} units`);
      if (ownOutposts && foeOutposts) {
        write(ownOutposts, `outposts ${match[mine + MATCH_SLOT_OUTPOSTS] | 0}/${outpostTotal}`);
        write(foeOutposts, `outposts ${match[other + MATCH_SLOT_OUTPOSTS] | 0}/${outpostTotal}`);
      }

      // Expire ticker rows. performance.now() matches the pump's clock.
      const nowMs = performance.now();
      for (let i = 0; i < TICKER_ROWS; i++) {
        write(tickerCells[i], nowMs < tickerUntil[i] ? tickerText[i] : "");
      }

      // Health: percent-quantized so a bar that moves by a fraction of a pixel
      // does not cost a style write every frame.
      const respawn = match[mine + MATCH_SLOT_RESPAWN_TICKS] | 0;
      const hpPct = respawn > 0 ? 0 : Math.round(match[mine + MATCH_SLOT_HP_FRAC] * 100);
      if (hpPct !== lastHpPct) {
        lastHpPct = hpPct;
        healthFill.style.height = `${hpPct}%`;
      }
      if (respawn !== lastRespawn) {
        lastRespawn = respawn;
        healthWrap.classList.toggle("is-down", respawn > 0);
      }

      if (respawn > 0) {
        write(ammoGun, `respawn ${Math.ceil(respawn / TICK_HZ)}s`);
        write(ammoHeavy, "");
        write(ammoSpecial, "");
        write(lockCell, "");
      } else {
        // The gun has a magazine since SIM_VERSION 41 (the Mini-Gun's 7500 on
        // NORMAL, the original's record).
        write(ammoGun, String(match[mine + MATCH_SLOT_AMMO_GUN] | 0));
        write(ammoHeavy, String(match[mine + MATCH_SLOT_AMMO_HEAVY] | 0));
        write(ammoSpecial, String(match[mine + MATCH_SLOT_AMMO_SPECIAL] | 0));
        write(lockCell, match[mine + MATCH_SLOT_LOCK] >= 0 ? "LOCK" : "");
      }
      // A powered slot fires its block B (fcop-fidelity.md P8): its count is the
      // B magazine, and the cell says so. Write-on-change.
      const power = respawn > 0 ? 0 : match[mine + MATCH_SLOT_POWER] | 0;
      if (power !== lastPower) {
        lastPower = power;
        ammoGun.node.classList.toggle("is-powered", (power & 1) !== 0);
        ammoHeavy.node.classList.toggle("is-powered", (power & 2) !== 0);
        ammoSpecial.node.classList.toggle("is-powered", (power & 4) !== 0);
      }

      const winner = match[MATCH_WINNER] | 0;
      // A breach decides the match and starts the outro (rules.md §1); the
      // banner says so for the outro's length, then that the match is over.
      const breacher = match[MATCH_OUTRO_WINNER] | 0;
      const text =
        winner >= 0
          ? BANNER_OVER[winner === 0 ? 0 : 1]
          : breacher >= 0
            ? BANNER_BREACH[breacher === 0 ? 0 : 1]
            : "";
      if (text !== lastBanner) {
        lastBanner = text;
        write(banner, text);
        banner.node.classList.toggle("is-on", text !== "");
      }

      drawRadar(ctx, snapshot, count, arenaExtent, slot);
    },
    pumpEvents(events, nowMs): void {
      for (let i = 0; i < events.count; i++) {
        const o = i * EVENT_STRIDE;
        const key = classifyTickerEvent(events.data[o], events.data[o + 2], events.data[o + 3]);
        if (key < 0) continue;
        if (nowMs < tickerNextAt[key]) continue;
        tickerNextAt[key] = nowMs + TICKER_REPEAT_MS;
        pushTickerRow(TICKER_TEXT[key >> 1][key & 1], nowMs);
      }
    },
    destroy(): void {
      root.remove();
    },
  };
}

/**
 * Top-down blips scaled to the arena. Reads the entity snapshot directly —
 * positions are per-entity, so this is exactly what writeSnapshot is for.
 * Allocation-free: no arrays, no closures, no Vector3.
 */
function drawRadar(
  ctx: CanvasRenderingContext2D | null,
  snapshot: Float32Array,
  count: number,
  arenaExtent: number,
  slot: number,
): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, RADAR_PX, RADAR_PX);
  const scale = arenaExtent > 0 ? RADAR_PX / arenaExtent : 0;
  if (scale === 0) return;

  for (let i = 0; i < count; i++) {
    const o = i * SNAPSHOT_STRIDE;
    const archetype = snapshot[o + 1];
    // Projectiles would swamp the display and tell the player nothing.
    if (archetype === 6) continue;
    const team = snapshot[o + 2];
    const x = snapshot[o + 3] * scale;
    const y = snapshot[o + 4] * scale;
    const isSelf = archetype === 0 && team === slot;
    ctx.fillStyle = isSelf
      ? "#dcf2ff"
      : team === slot
        ? "#5b8dd9"
        : team < 0
          ? "#4c6070"
          : "#d95b5b";
    ctx.beginPath();
    ctx.arc(x, y, isSelf ? BLIP_R_SELF : BLIP_R, 0, Math.PI * 2);
    ctx.fill();
  }
}
