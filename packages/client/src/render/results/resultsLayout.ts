// The results page's layout maths, pure and DOM-free (fcop-fidelity.md V7):
// what the original's page draws where on its 640 x 480 screen, in the order
// and colours it draws it (RE mission/results.c 0x004080a0 and its column
// formatter 0x004084b0), as text runs for the HUD's font (render/hud/
// bitmapText.ts: cfnt_text_width and cfnt_text_draw at Resolution 4). This file
// allocates only when a page opens.

import { STAT_FIRST_TIME_KEY, STAT_KEYS } from "@metropolis/sim";
import { textWidth } from "../hud/bitmapText";
import { SIDE_BLUE } from "../sides";
import {
  FOOTER_COLOUR,
  FOOTER_SPAN,
  FOOTER_X,
  FOOTER_Y,
  HEAD_COLOUR,
  HEAD_LEFT_X,
  HEAD_RIGHT_X,
  HEAD_SPAN,
  HEAD_Y,
  LEVEL_SPAN,
  LEVEL_X,
  LEVEL_Y,
  RESULTS_COLUMNS,
  RESULTS_RECTS,
  RESULTS_TEXTS,
  TEXT_AGAIN,
  TEXT_LOSER,
  TEXT_NEXT,
  TEXT_QUIT,
  TEXT_WINNER,
} from "./fcopResults.generated";

/** A byte in [0x0a, 0x20) switches the colour to byte - 10 (cfnt_text_draw). */
const COLOUR_CODE_FIRST = 0x0a;
const COLOUR_CODE_END = 0x20;
/** The run colour of the level line, whose colour blinks (the page fills it in). */
export const COLOUR_BLINK = -1;

/** C's signed division: truncates toward zero. */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** `cfnt_text_width` at 640 x 480: the printable bytes' advances, colour codes skipped. */
export function pageTextWidth(text: string): number {
  return textWidth(text);
}

/** A column line's left edge in 320 units: centred on `x`, `x - width / 4` (0x004085b6). */
export function lineX(x: number, text: string): number {
  return x - idiv(pageTextWidth(text), 4);
}

/** A head's, the level's or the footer's left edge: `(span - width) / 4 + x`. */
export function spanX(span: number, x: number, text: string): number {
  return idiv(span - pageTextWidth(text), 4) + x;
}

/** printf's `%02ld`: at least two characters, zero-padded, the sign counted. */
function pad2(n: number): string {
  const s = `${n}`;
  return s.length >= 2 ? s : `0${s}`;
}

/**
 * A figure as the page prints it (0x0040852e): `%ld` below key 0xf; from it on
 * a time on the 300 Hz frame clock as `%02ld:%02ld` of (v + 150) / 300 seconds
 * split by sixty, every divide signed and truncating (0x00408536..0x00408578).
 */
export function formatFigure(key: number, value: number): string {
  const v = value | 0;
  if (key < STAT_FIRST_TIME_KEY) return `${v}`;
  const seconds = idiv((v + 150) | 0, 300);
  return `${pad2(idiv(seconds, 60))}:${pad2(seconds % 60)}`;
}

/** "LEVEL %02d" of the level just played. */
export function levelText(level: number): string {
  return `LEVEL ${pad2(level | 0)}`;
}

/** The two heads: WINNER over the side that won, LOSER over the other (0x004081d1). */
export function headTexts(winner: number): readonly [string, string] {
  const lost = winner !== 0; // `lost` is slot 0's
  return [
    RESULTS_TEXTS[lost ? TEXT_LOSER : TEXT_WINNER],
    RESULTS_TEXTS[lost ? TEXT_WINNER : TEXT_LOSER],
  ];
}

/**
 * The footer (0x00408398): quit only in a network session; the next level with
 * one viewport after slot 0 won; play again otherwise.
 */
export function footerText(online: boolean, solo: boolean, winner: number): string {
  if (online) return RESULTS_TEXTS[TEXT_QUIT];
  if (solo && winner === 0) return RESULTS_TEXTS[TEXT_NEXT];
  return RESULTS_TEXTS[TEXT_AGAIN];
}

/** What the page shows, read once when it opens. */
export interface ResultsInput {
  /** writeResultsSnapshot's figures: STAT_KEYS per slot, slot 0 first. */
  readonly figures: Float32Array;
  /** The winning team (slot). */
  readonly winner: number;
  /** An online match: only the Camera Key, which quits. */
  readonly online: boolean;
  /** The Sky Captain's level just played (1..10), 0 for none: one viewport. */
  readonly level: number;
  /** The original side each slot holds on this arena (render/sides.ts sideOfTeam). */
  readonly sides: readonly [number, number];
}

/** A rect to fill: x, y, w, h in 640 units and its RGB, at half alpha (dim 1). */
export interface PageRect {
  readonly rect: readonly number[];
  readonly rgb: readonly number[];
}

/** One run of text: its pen at (x, y) in 640 units and its colour (COLOUR_BLINK: the level's). */
export interface TextRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly colour: number;
}

/** The page: its rects and its text runs, in the original's draw order. */
export interface PageLayout {
  readonly rects: readonly PageRect[];
  readonly runs: readonly TextRun[];
}

/**
 * Appends `text` at (x, y) in 320 units as runs: the pen starts at (2x, 2y) and
 * a colour-code byte switches the colour for the rest of the string, drawing
 * nothing — so a run ends at every code and the next starts where it ended.
 */
export function layoutText(
  text: string,
  x: number,
  y: number,
  colour: number,
  out: TextRun[],
): void {
  let pen = x * 2;
  let c = colour;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    const isCode = code >= COLOUR_CODE_FIRST && code < COLOUR_CODE_END;
    if (i < text.length && !isCode) continue;
    if (i > start) {
      const run = text.slice(start, i);
      out.push({ text: run, x: pen, y: y * 2, colour: c });
      pen += pageTextWidth(run);
    }
    if (isCode) c = code - 10;
    start = i + 1;
  }
}

/**
 * The page for `input`: the page rect, each head in its slot's side colour (the
 * original's slot 0 is always side 1, red; Metropolis' slot 0 is side 2 on La
 * Cantina, V6), the footer bar; then the heads, the level, the eleven columns
 * and the footer.
 */
export function layoutPage(input: ResultsInput): PageLayout {
  const [page, red, blue, bar] = RESULTS_RECTS;
  const headRgb = (side: number) => (side === SIDE_BLUE ? blue.rgb : red.rgb);
  const rects: PageRect[] = [
    { rect: page.rect, rgb: page.rgb },
    { rect: red.rect, rgb: headRgb(input.sides[0]) },
    { rect: blue.rect, rgb: headRgb(input.sides[1]) },
    { rect: bar.rect, rgb: bar.rgb },
  ];
  const runs: TextRun[] = [];
  const [left, right] = headTexts(input.winner);
  layoutText(left, spanX(HEAD_SPAN, HEAD_LEFT_X, left), HEAD_Y, HEAD_COLOUR, runs);
  layoutText(right, spanX(HEAD_SPAN, HEAD_RIGHT_X, right), HEAD_Y, HEAD_COLOUR, runs);
  if (input.level > 0) {
    const level = levelText(input.level);
    layoutText(level, spanX(LEVEL_SPAN, LEVEL_X, level), LEVEL_Y, COLOUR_BLINK, runs);
  }
  for (const col of RESULTS_COLUMNS) {
    for (const line of col.lines) {
      let text: string;
      if (line.key !== undefined) {
        const base = (col.side === 1 ? 1 : 0) * STAT_KEYS;
        text = formatFigure(line.key, input.figures[base + line.key]);
      } else {
        text = RESULTS_TEXTS[line.text ?? 0];
      }
      layoutText(text, lineX(col.x, text), line.y, col.colour, runs);
    }
  }
  const footer = footerText(input.online, input.level > 0, input.winner);
  layoutText(footer, spanX(FOOTER_SPAN, FOOTER_X, footer), FOOTER_Y, FOOTER_COLOUR, runs);
  return { rects, runs };
}
