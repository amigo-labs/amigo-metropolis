// The original's results page (fcop-fidelity.md V7; RE mission/results.c
// 0x004080a0): four half-alpha rects and the page's text in the HUD's font
// (render/hud/bitmapText.ts), drawn once on a 640 x 480 canvas when it opens —
// the figures are those of the first pass, as the original's are — and scaled
// to the viewport as the HUD's 4:3 box, at an integer multiple of the
// original's pixels (render/hud/hudLayout.ts). Raw DOM, frame-loop world:
// `frame()` allocates nothing and redraws only when the level line's blink
// flips.
//
// The way out is the original's two keys, read through the player's bindings:
// the Map Key plays again (the next level after a solo win) and wins over a
// Camera Key in the same frame; the Camera Key quits. Online only the Camera
// Key counts. No mouse, no Escape: the original's page answers neither.

import { type Binding, codesOfKey, DEVICE_JOYSTICK, DEVICE_KEYBOARD } from "../../input/bindings";
import { firstPad, joyControlDown } from "../../input/gamepad";
import { drawText, hudFont } from "../hud/bitmapText";
import { HUD_H, HUD_W, hudScale, pixelMultiple } from "../hud/hudLayout";
import { LEVEL_BLINK_BIT, LEVEL_COLOUR_OFF, LEVEL_COLOUR_ON } from "./fcopResults.generated";
import { COLOUR_BLINK, layoutPage, type PageLayout, type ResultsInput } from "./resultsLayout";
import "./results.css";

/** The binding slots of the two keys (bindings.ts SLOT_NAMES). */
const SLOT_MAP = 8;
const SLOT_CAMERA = 9;
/** The original's frame clock: 300 units a second (the blink reads its bit 5). */
const FRAME_CLOCK_PER_MS = 0.3;

export interface ResultsPageOptions {
  /** Player 1's bindings, read when the page opens. */
  readonly bindings: () => readonly Binding[];
  /** The Map Key: another round (the next level after a solo win). */
  readonly onAgain: () => void;
  /** The Camera Key: back to the menu. */
  readonly onQuit: () => void;
}

export interface ResultsPage {
  readonly isOpen: () => boolean;
  /** Opens the page on the figures of this moment. */
  open(input: ResultsInput): void;
  close(): void;
  /** Once a frame: the level's blink, the pad's keys, and the way out. */
  frame(nowMs: number): void;
}

export function createResultsPage(opts: ResultsPageOptions): ResultsPage {
  const root = document.createElement("div");
  root.id = "results-page";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Results");
  const canvas = document.createElement("canvas");
  root.appendChild(canvas);
  document.body.appendChild(root);
  const ctx = canvas.getContext("2d");
  const font = hudFont();

  let open = false;
  let page: PageLayout = { rects: [], runs: [] };
  /** The rects' fill styles, made at open: a redraw allocates nothing. */
  let rectStyles: string[] = [];
  let online = false;
  let hasLevel = false;
  let blink = -1;
  /** The font was still loading at the last draw. */
  let fontPending = false;
  let table: readonly Binding[] = [];
  let mapLatched = false;
  let cameraLatched = false;
  let padMapWas = false;
  let padCameraWas = false;

  function draw(): void {
    if (!ctx) return;
    const k = canvas.width / HUD_W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, HUD_W, HUD_H);
    // Every rect at dim 1: half alpha over the world behind.
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < page.rects.length; i++) {
      const r = page.rects[i].rect;
      ctx.fillStyle = rectStyles[i];
      ctx.fillRect(r[0], r[1], r[2], r[3]);
    }
    ctx.globalAlpha = 1;
    const levelColour = blink === 1 ? LEVEL_COLOUR_ON : LEVEL_COLOUR_OFF;
    for (let i = 0; i < page.runs.length; i++) {
      const run = page.runs[i];
      const colour = run.colour === COLOUR_BLINK ? levelColour : run.colour;
      drawText(ctx, font, run.text, run.x, run.y, colour);
    }
    fontPending = !font.ready;
  }

  function isKey(slot: number, code: string): boolean {
    const b = table[slot];
    return b !== undefined && b.device === DEVICE_KEYBOARD && codesOfKey(b.code).includes(code);
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    const map = isKey(SLOT_MAP, e.code);
    const camera = isKey(SLOT_CAMERA, e.code);
    // Escape is no key of the page's; the bound two belong to it.
    if (map || camera || e.code === "Escape") e.preventDefault();
    if (e.repeat) return;
    if (map) mapLatched = true;
    if (camera) cameraLatched = true;
  }
  window.addEventListener("keydown", onKey, true);

  function padDown(slot: number): boolean {
    const b = table[slot];
    if (b === undefined || b.device !== DEVICE_JOYSTICK) return false;
    const pad = firstPad();
    return pad !== null && joyControlDown(pad, b.code);
  }

  return {
    isOpen: () => open,
    open(input: ResultsInput): void {
      page = layoutPage(input);
      rectStyles = page.rects.map((r) => `rgb(${r.rgb[0]}, ${r.rgb[1]}, ${r.rgb[2]})`);
      online = input.online;
      hasLevel = input.level > 0;
      table = opts.bindings();
      mapLatched = false;
      cameraLatched = false;
      // A key already held when the page opens is not a press of it.
      padMapWas = padDown(SLOT_MAP);
      padCameraWas = padDown(SLOT_CAMERA);
      // The HUD's box: the 4:3 fit, its pixels a whole multiple of the original's.
      const s = hudScale(window.innerWidth, window.innerHeight);
      const k = pixelMultiple(s);
      canvas.width = HUD_W * k;
      canvas.height = HUD_H * k;
      canvas.style.width = `${HUD_W * s}px`;
      canvas.style.height = `${HUD_H * s}px`;
      blink = -1;
      open = true;
      root.classList.add("is-open");
      draw();
    },
    close(): void {
      if (!open) return;
      open = false;
      page = { rects: [], runs: [] };
      root.classList.remove("is-open");
    },
    frame(nowMs: number): void {
      if (!open) return;
      const bit = hasLevel ? (Math.floor(nowMs * FRAME_CLOCK_PER_MS) >> LEVEL_BLINK_BIT) & 1 : 0;
      if (bit !== blink || (fontPending && font.ready)) {
        blink = bit;
        draw();
      }
      const padMap = padDown(SLOT_MAP);
      const padCamera = padDown(SLOT_CAMERA);
      if (padMap && !padMapWas) mapLatched = true;
      if (padCamera && !padCameraWas) cameraLatched = true;
      padMapWas = padMap;
      padCameraWas = padCamera;
      // 0x004083fb..0x0040848e: online only the Camera Key; else the Map Key
      // first, then the Camera Key.
      const again = !online && mapLatched;
      const quit = cameraLatched;
      mapLatched = false;
      cameraLatched = false;
      if (again) opts.onAgain();
      else if (quit) opts.onQuit();
    },
  };
}
