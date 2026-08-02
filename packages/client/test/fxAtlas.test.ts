// The committed Cpyr atlas is a build artifact of tools/generators/fx/keyAtlas.ts.
// This asserts the artifact is in the state fx.ts assumes, because the failure
// mode is silent: a wrong colour is not an error, and additive blending turns
// every leftover background pixel into light.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATLAS_KEY, keyOutBackground } from "../../../tools/generators/fx/keyAtlas";
import { decodePng } from "../../../tools/generators/png";

const ATLAS = join(import.meta.dir, "..", "public", "fx", "particles.png");

describe("Cpyr particle atlas", () => {
  test("carries no opaque background pixels", () => {
    // extract_media.py renders palette index 0 as opaque #D5AC00 instead of
    // transparent. It filled the corner of every sprite rect and the whole
    // unused bottom half — 95,279 of 131,072 pixels — and fx.ts draws these on
    // additive quads, so each muzzle flash and explosion added a dark-yellow
    // square the size of its quad. Run `bun run gen:fxkey` if this fails.
    const image = decodePng(new Uint8Array(readFileSync(ATLAS)));
    let opaqueKey = 0;
    for (let i = 0; i < image.pixels.length; i += 4) {
      if (image.pixels[i + 3] === 0) continue;
      if (
        image.pixels[i] === ATLAS_KEY.r &&
        image.pixels[i + 1] === ATLAS_KEY.g &&
        image.pixels[i + 2] === ATLAS_KEY.b
      ) {
        opaqueKey++;
      }
    }
    expect(opaqueKey).toBe(0);
  });

  test("still has paint left — keying did not eat the sprites", () => {
    // The guard on the other side: an over-eager key (a tolerance, say) would
    // also pass the test above by erasing the puffs.
    const image = decodePng(new Uint8Array(readFileSync(ATLAS)));
    let opaque = 0;
    for (let i = 3; i < image.pixels.length; i += 4) if (image.pixels[i] !== 0) opaque++;
    expect(opaque).toBeGreaterThan(9000);
  });

  test("keying is idempotent", () => {
    const image = decodePng(new Uint8Array(readFileSync(ATLAS)));
    const pixels = new Uint8Array(image.pixels);
    expect(keyOutBackground(pixels)).toBe(0);
  });
});
