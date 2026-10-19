// The original's HUD font: font 3, the one `cfnt_font_for_resolution` picks at
// 640 x 480 (RE hud.json font; extracted/fonts/font3.png + .json), drawn in the
// text colours of `session.c` (hud.json text_colours: a 16-step ramp per colour
// whose top entry is the colour; the glyphs are one-bit, so a glyph pixel is
// that entry). A text call's pen is in 320 x 240 space, doubled at 640 x 480,
// each glyph placed at its own offset from the pen.
//
// One tinted copy of the atlas per colour, built once on first use (boot-time
// work, not frame work). Drawing a number goes digit by digit from the integer,
// so a HUD refresh never builds a string (CLAUDE.md renderer rule 1).

import { FONT3_GLYPHS, TEXT_COLOURS } from "../fcopPresentation.generated";

const FONT_URL = "/hud/font3.png";

/** The atlas and its tinted copies. */
export interface BitmapFont {
  ready: boolean;
  readonly image: HTMLImageElement;
  readonly tinted: (HTMLCanvasElement | null)[];
}

let shared: BitmapFont | null = null;

/** The HUD font, loaded once per page. */
export function hudFont(): BitmapFont {
  if (shared) return shared;
  const image = new Image();
  const font: BitmapFont = {
    ready: false,
    image,
    tinted: new Array<HTMLCanvasElement | null>(TEXT_COLOURS.length).fill(null),
  };
  image.onload = () => {
    font.ready = true;
  };
  image.src = FONT_URL;
  shared = font;
  return font;
}

function tintedAtlas(font: BitmapFont, colour: number): HTMLCanvasElement | null {
  const have = font.tinted[colour];
  if (have) return have;
  if (!font.ready) return null;
  const rgb = TEXT_COLOURS[colour] ?? TEXT_COLOURS[8];
  const c = document.createElement("canvas");
  c.width = font.image.naturalWidth;
  c.height = font.image.naturalHeight;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(font.image, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.fillRect(0, 0, c.width, c.height);
  font.tinted[colour] = c;
  return c;
}

/** The glyph record for a char code, or null. */
function glyph(code: number): readonly number[] | null {
  return code >= 32 && code < 128 ? (FONT3_GLYPHS[code - 32] ?? null) : null;
}

/** The pen advance of `text`, px at 640 x 480. */
export function textWidth(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += glyph(text.charCodeAt(i))?.[4] ?? 0;
  return w;
}

/** Draws one glyph at the pen; returns the advance (0 when the font is not in). */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  atlas: HTMLCanvasElement | null,
  code: number,
  x: number,
  y: number,
): number {
  const g = glyph(code);
  if (!g) return 0;
  if (atlas && g[2] > 1)
    ctx.drawImage(atlas, g[0], g[1], g[2], g[3], x + g[5], y + g[6], g[2], g[3]);
  return g[4];
}

/** Draws `text` with its pen at (x, y) in 640 units; returns the pen's end. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  font: BitmapFont,
  text: string,
  x: number,
  y: number,
  colour: number,
): number {
  const atlas = tintedAtlas(font, colour);
  let pen = x;
  for (let i = 0; i < text.length; i++) pen += drawGlyph(ctx, atlas, text.charCodeAt(i), pen, y);
  return pen;
}

/**
 * Draws a non-negative integer zero-padded to `digits` (the original's "%0Nld";
 * 0 = no padding, "%ld"); returns the pen's end. No string is built.
 */
export function drawNumber(
  ctx: CanvasRenderingContext2D,
  font: BitmapFont,
  value: number,
  digits: number,
  x: number,
  y: number,
  colour: number,
): number {
  const atlas = tintedAtlas(font, colour);
  let v = value < 0 ? 0 : Math.floor(value);
  let n = 1;
  for (let t = v; t >= 10; t = Math.floor(t / 10)) n++;
  if (n < digits) n = digits;
  let div = 1;
  for (let i = 1; i < n; i++) div *= 10;
  let pen = x;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(v / div) % 10;
    pen += drawGlyph(ctx, atlas, 48 + d, pen, y);
    v -= Math.floor(v / div) * div;
    div /= 10;
  }
  return pen;
}

/** The advance of a number drawn by drawNumber. */
export function numberWidth(value: number, digits: number): number {
  let n = 1;
  for (let t = value < 0 ? 0 : Math.floor(value); t >= 10; t = Math.floor(t / 10)) n++;
  if (n < digits) n = digits;
  return n * (glyph(48)?.[4] ?? 0);
}

/** Draws a single character (the counts' "/", the "L" of L%02d). */
export function drawChar(
  ctx: CanvasRenderingContext2D,
  font: BitmapFont,
  code: number,
  x: number,
  y: number,
  colour: number,
): number {
  return x + drawGlyph(ctx, tintedAtlas(font, colour), code, x, y);
}
