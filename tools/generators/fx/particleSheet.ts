// Contact sheet for the original's Cpyr particle atlas.
//
//   bun run gen:fxsheet
//
// WHY THIS EXISTS
// The effect records name their particle by id (type 93's +0x34; a trail node
// spawns id 10), so no role is picked here any more. The sheet stays as the
// picture of what each id is: the atlas is the RE's page 0, every sprite drawn
// through its own A1R5G5B5 palette (bun run gen:fx), and an earlier copy decoded
// every sprite through palette 0 — which is how a cyan ring came to be taken for
// a red muzzle flash.
//
// It writes docs/renders/fx/particles-contact.png: every id at 2x on a
// checkerboard, so alpha-0 texels read as a pattern rather than as black, and
// prints per-id size, opaque coverage and dominant colours.
//
// Authoring-time only.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DecodedImage, decodePng, encodePng } from "../png";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ATLAS = join(ROOT, "packages", "client", "public", "fx", "particles.png");
const META = join(ROOT, "packages", "client", "public", "fx", "particles.json");
const OUT = join(ROOT, "docs", "renders", "fx", "particles-contact.png");

const SCALE = 2;
const PAD = 8;
const CHECKER = 8;

interface Rect {
  atlas_x: number;
  atlas_y: number;
  w: number;
  h: number;
}
/** The RE's particles.json (extracted/particles/), copied unchanged by gen:fx. */
interface Meta {
  particles: { id: number; sprites: Rect[] }[];
}

function checkerAt(x: number, y: number): number {
  return (Math.floor(x / CHECKER) + Math.floor(y / CHECKER)) % 2 === 0 ? 0x30 : 0x50;
}

function main(): void {
  const atlas = decodePng(new Uint8Array(readFileSync(ATLAS)));
  const meta = JSON.parse(readFileSync(META, "utf8")) as Meta;

  const cells = meta.particles.flatMap((p) =>
    p.sprites.map((r, frame) => ({ id: p.id, frame, r })),
  );
  const cellW = Math.max(...cells.map((c) => c.r.w)) * SCALE + PAD * 2;
  const cellH = Math.max(...cells.map((c) => c.r.h)) * SCALE + PAD * 2;
  const cols = Math.min(4, cells.length);
  const rows = Math.ceil(cells.length / cols);
  const width = cols * cellW;
  const height = rows * cellH;
  const pixels = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const v = checkerAt(x, y);
      pixels[o] = v;
      pixels[o + 1] = v;
      pixels[o + 2] = v;
      pixels[o + 3] = 255;
    }
  }

  console.log(`Cpyr atlas ${atlas.width}x${atlas.height}, ${cells.length} sprite(s)\n`);
  cells.forEach((cell, i) => {
    const cx = (i % cols) * cellW + PAD;
    const cy = Math.floor(i / cols) * cellH + PAD;
    let clear = 0;
    let solid = 0;
    const colours = new Map<string, number>();
    for (let y = 0; y < cell.r.h; y++) {
      for (let x = 0; x < cell.r.w; x++) {
        const s = ((cell.r.atlas_y + y) * atlas.width + (cell.r.atlas_x + x)) * 4;
        const [r, g, b, a] = [
          atlas.pixels[s],
          atlas.pixels[s + 1],
          atlas.pixels[s + 2],
          atlas.pixels[s + 3],
        ];
        if (a === 0) clear++;
        else {
          solid++;
          const k = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
          colours.set(k, (colours.get(k) ?? 0) + 1);
        }
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            const dx = cx + x * SCALE + sx;
            const dy = cy + y * SCALE + sy;
            const d = (dy * width + dx) * 4;
            if (a === 0) continue; // let the checkerboard show through
            pixels[d] = r;
            pixels[d + 1] = g;
            pixels[d + 2] = b;
            pixels[d + 3] = 255;
          }
        }
      }
    }
    const total = cell.r.w * cell.r.h;
    const top = [...colours.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, n]) => `${c} ${Math.round((n / total) * 100)}%`)
      .join("  ");
    console.log(
      `  id ${String(cell.id).padStart(2)} frame ${cell.frame}  ${cell.r.w}x${cell.r.h}` +
        `  clear ${Math.round((clear / total) * 100)}%` +
        `  paint ${Math.round((solid / total) * 100)}%   ${top}`,
    );
  });

  const image: DecodedImage = { width, height, pixels };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, encodePng(image));
  console.log(`\nwrote ${OUT} (${width}x${height})`);
}

main();
