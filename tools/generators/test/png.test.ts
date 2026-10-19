// gen:units keeps a committed atlas's PNG bytes where a rebuild decodes to the
// same pixels (genUnitModels.ts keepCommittedImages): the deflate stream is the
// encoder's, and identical pixels encode to other bytes under another zlib or
// level. samePixels is the judge, so it must see through the encoding and
// nothing else.

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, samePixels } from "../png";

/** The same image as encodePng writes it, but deflated at another level. */
function reencode(png: Uint8Array, level: number): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idatLen = view.getUint32(33);
  const image = decodePng(png);
  const raw = new Uint8Array(image.height * (image.width * 4 + 1));
  for (let y = 0; y < image.height; y++) {
    raw.set(
      image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      y * (image.width * 4 + 1) + 1,
    );
  }
  const idat = new Uint8Array(deflateSync(raw, { level }));
  const head = png.subarray(0, 33);
  const tail = png.subarray(33 + 12 + idatLen);
  const chunk = new Uint8Array(12 + idat.length);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, idat.length);
  chunk.set([73, 68, 65, 84], 4);
  chunk.set(idat, 8);
  // The decoder reads no CRC, so a zero one does not matter here.
  const out = new Uint8Array(head.length + chunk.length + tail.length);
  out.set(head, 0);
  out.set(chunk, head.length);
  out.set(tail, head.length + chunk.length);
  return out;
}

function image(seed: number) {
  const width = 37;
  const height = 19;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + seed * 7 + ((i >> 5) & 3)) & 0xff;
  return { width, height, pixels };
}

describe("samePixels", () => {
  test("sees through the deflate stream", () => {
    const a = encodePng(image(1));
    const b = reencode(a, 1);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(samePixels(a, b)).toBe(true);
  });

  test("tells one texel apart", () => {
    const img = image(1);
    const other = { ...img, pixels: img.pixels.slice() };
    other.pixels[100] ^= 1;
    expect(samePixels(encodePng(img), encodePng(other))).toBe(false);
  });

  test("tells the size apart", () => {
    const img = image(2);
    const wide = { width: img.height, height: img.width, pixels: img.pixels };
    expect(samePixels(encodePng(img), encodePng(wide))).toBe(false);
  });
});
