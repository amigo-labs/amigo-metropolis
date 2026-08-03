// Keys the leftover background colour out of the Cpyr particle atlas.
//
//   bun run gen:fxkey            # rewrite packages/client/public/fx/particles.png
//   bun run gen:fxkey --check    # report only, non-zero if work is pending
//
// THE BUG THIS FIXES
// extract_media.py renders the atlas through PYPL palette 0 and writes RGBA,
// but palette index 0 — the background — comes out OPAQUE #D5AC00 instead of
// transparent. It fills the corners of every sprite rect and the whole unused
// bottom half of the sheet: 95,279 of 105,576 opaque pixels in the committed
// file.
//
// render/fx.ts draws these sprites on additive-blended quads (makeAdditiveMaterial),
// and additive blending has no notion of "background" — every one of those gold
// pixels ADDS. So each muzzle flash and each explosion laid a dark-yellow square
// over the scene, sized to the whole quad rather than to the puff. Nothing in the
// pipeline complained, because a wrong colour is not an error.
//
// The dither of alpha-0 pixels INSIDE each puff is left alone: that is the
// original's own stipple transparency and reads correctly under additive.
//
// Idempotent — running it on an already-keyed atlas changes nothing.
//
// Authoring-time only.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "../png";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ATLAS = join(ROOT, "packages", "client", "public", "fx", "particles.png");

/**
 * Palette-0 index 0 as extract_media.py renders it.
 *
 * Exact match only, no tolerance: the sprites' own paint is dithered and a
 * fuzzy match would eat the darker tan pixels (#e6b48b and friends) along with
 * the background.
 */
export const ATLAS_KEY = { r: 0xd5, g: 0xac, b: 0x00 } as const;

/** Zeroes alpha on every exact key-colour pixel. Returns how many it hit. */
export function keyOutBackground(pixels: Uint8Array): number {
  let hit = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    if (pixels[i] !== ATLAS_KEY.r || pixels[i + 1] !== ATLAS_KEY.g || pixels[i + 2] !== ATLAS_KEY.b)
      continue;
    pixels[i + 3] = 0;
    hit++;
  }
  return hit;
}

function main(): void {
  const check = process.argv.includes("--check");
  const image = decodePng(new Uint8Array(readFileSync(ATLAS)));
  const pixels = new Uint8Array(image.pixels);
  const total = image.width * image.height;
  const hit = keyOutBackground(pixels);

  if (hit === 0) {
    console.log(`particles.png: already keyed (${total} px, no #D5AC00 left opaque)`);
    return;
  }
  console.log(
    `particles.png: ${hit} opaque #D5AC00 pixel(s) of ${total} ` +
      `(${((hit / total) * 100).toFixed(1)}%) would become transparent`,
  );
  if (check) {
    console.log("--check: nothing written");
    process.exit(1);
  }
  writeFileSync(ATLAS, encodePng({ width: image.width, height: image.height, pixels }));
  console.log(`wrote ${ATLAS}`);
}

if (import.meta.main) main();
