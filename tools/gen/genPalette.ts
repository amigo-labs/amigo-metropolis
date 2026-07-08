// Generates assets/palette/metropolis.pal + metropolis.png — the committed,
// self-authored (CC0, see CREDITS.md) reference artifacts for the shared game
// palette (assets.md §3).
//
// Like the other generators, this runs at AUTHORING time only. The single
// source of truth is packages/client/src/render/palette.ts; this tool just
// serializes those entries into a standard palette file (JASC-PAL, importable
// by Aseprite / GIMP / Paint Shop Pro) and a swatch sheet for eyeballing.
//
// Usage: bun tools/gen/genPalette.ts

import { PALETTE } from "../../packages/client/src/render/palette";
import { encodePng } from "./png";

function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

// --- .pal (JASC-PAL) ---------------------------------------------------------

const palLines = ["JASC-PAL", "0100", String(PALETTE.length)];
for (const { hex } of PALETTE) {
  const [r, g, b] = rgb(hex);
  palLines.push(`${r} ${g} ${b}`);
}
const palText = `${palLines.join("\n")}\n`;

// --- reference swatch sheet (PNG) --------------------------------------------

const COLS = 8;
const ROWS = Math.ceil(PALETTE.length / COLS);
const CELL = 64; // one grid cell per color
const GUT = 4; // mid-grey frame so both black and white swatches read
const W = COLS * CELL;
const H = ROWS * CELL;

const img = new Uint8Array(W * H * 4);
for (let p = 0; p < W * H; p++) {
  img[p * 4] = 127;
  img[p * 4 + 1] = 127;
  img[p * 4 + 2] = 127;
  img[p * 4 + 3] = 255;
}

function fillRect(x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      img[i] = r;
      img[i + 1] = g;
      img[i + 2] = b;
      img[i + 3] = 255;
    }
  }
}

for (let i = 0; i < PALETTE.length; i++) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const [r, g, b] = rgb(PALETTE[i].hex);
  fillRect(col * CELL + GUT, row * CELL + GUT, CELL - 2 * GUT, CELL - 2 * GUT, r, g, b);
}

// --- emit --------------------------------------------------------------------

const OUT = new URL("../../assets/palette/", import.meta.url);
await Bun.write(new URL("metropolis.pal", OUT), palText);
const png = encodePng(W, H, img);
await Bun.write(new URL("metropolis.png", OUT), png);
console.log(`wrote assets/palette/metropolis.pal (${PALETTE.length} colors)`);
console.log(`wrote assets/palette/metropolis.png (${W}×${H}, ${png.length} bytes)`);
