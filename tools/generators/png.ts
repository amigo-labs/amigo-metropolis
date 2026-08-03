// Minimal PNG codec shared by the asset generators.
//
// Lifted out of genUnitModels.ts when the FX atlas tooling needed the same two
// functions. Authoring-time only — nothing here ships to the client, so plain
// Math and node:zlib are fine.
//
// Scope is exactly what the generators feed it: 8-bit non-interlaced PNGs in,
// 8-bit RGBA out. Anything else throws rather than guessing.

import { deflateSync, inflateSync } from "node:zlib";

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, sRGB-encoded like the source file. */
  readonly pixels: Uint8Array;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(
      bytes[off + 4],
      bytes[off + 5],
      bytes[off + 6],
      bytes[off + 7],
    );
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      bitDepth = bytes[off + 16];
      colorType = bytes[off + 17];
      interlace = bytes[off + 20];
    } else if (type === "PLTE") {
      palette = bytes.subarray(off + 8, off + 8 + len);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(off + 8, off + 8 + len));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, interlace ${interlace})`);
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let w = 0;
  for (const chunk of idat) {
    compressed.set(chunk, w);
    w += chunk.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  const scanlines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x];
      const a = x >= channels ? scanlines[dst + x - channels] : 0;
      const b = y > 0 ? scanlines[dst + x - stride] : 0;
      const c = x >= channels && y > 0 ? scanlines[dst + x - channels - stride] : 0;
      let value: number;
      if (filter === 0) value = cur;
      else if (filter === 1) value = cur + a;
      else if (filter === 2) value = cur + b;
      else if (filter === 3) value = cur + Math.floor((a + b) / 2);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      scanlines[dst + x] = value & 0xff;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (colorType === 3) {
      if (!palette) throw new Error("indexed PNG without PLTE");
      const p = scanlines[s] * 3;
      pixels.set([palette[p], palette[p + 1], palette[p + 2], 255], i * 4);
    } else if (colorType === 2 || colorType === 6) {
      pixels.set(
        [
          scanlines[s],
          scanlines[s + 1],
          scanlines[s + 2],
          colorType === 6 ? scanlines[s + 3] : 255,
        ],
        i * 4,
      );
    } else {
      const g = scanlines[s];
      pixels.set([g, g, g, colorType === 4 ? scanlines[s + 1] : 255], i * 4);
    }
  }
  return { width, height, pixels };
}

/** Minimal PNG encode (8-bit RGBA, filter 0) for the packed unit atlases. */
export function encodePng(image: DecodedImage): Uint8Array {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const { width, height, pixels } = image;
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
