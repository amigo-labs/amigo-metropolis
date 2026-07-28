// Offline orthographic PNG previews of the two turret GLBs (no browser).
// Draws raw hull (green) vs gun (magenta) separately, and the merged ship
// output, so we can see that base+gun both survive gen:units.
//
//   bun run tools/determinism/src/turretPreviewPng.ts

import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(ROOT, "docs", "verification", "stage7-units");

interface MeshPart {
  name: string;
  positions: Float32Array; // xyz xyz …
}

function parseGlbMeshes(path: string): MeshPart[] {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8").replace(/\0+$/, ""));
  let off = 20 + jsonLen;
  while (off % 4) off++;
  const binLen = buf.readUInt32LE(off);
  const bin = buf.subarray(off + 8, off + 8 + binLen);

  const parts: MeshPart[] = [];
  for (let mi = 0; mi < (json.meshes ?? []).length; mi++) {
    const m = json.meshes[mi];
    const node = (json.nodes ?? []).find((n: { mesh?: number }) => n.mesh === mi);
    for (const p of m.primitives) {
      const acc = json.accessors[p.attributes.POSITION];
      const bv = json.bufferViews[acc.bufferView];
      const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = bv.byteStride ?? 12;
      const positions = new Float32Array(acc.count * 3);
      for (let i = 0; i < acc.count; i++) {
        const o = start + i * stride;
        positions[i * 3] = bin.readFloatLE(o);
        positions[i * 3 + 1] = bin.readFloatLE(o + 4);
        positions[i * 3 + 2] = bin.readFloatLE(o + 8);
      }
      parts.push({ name: node?.name ?? m.name ?? `mesh${mi}`, positions });
    }
  }
  return parts;
}

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  // CRC over type+data
  const crcData = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function writePng(path: string, w: number, h: number, rgba: Uint8Array): void {
  const row = w * 4 + 1;
  const raw = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0; // filter none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * row + 1);
  }
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  writeFileSync(path, out);
}

function paint(
  path: string,
  parts: { positions: Float32Array; r: number; g: number; b: number }[],
  label: string,
): void {
  const W = 640;
  const H = 480;
  const rgba = new Uint8Array(W * H * 4);
  // dark bg
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = 18;
    rgba[i * 4 + 1] = 20;
    rgba[i * 4 + 2] = 28;
    rgba[i * 4 + 3] = 255;
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) {
      minX = Math.min(minX, p.positions[i]);
      minY = Math.min(minY, p.positions[i + 1]);
      minZ = Math.min(minZ, p.positions[i + 2]);
      maxX = Math.max(maxX, p.positions[i]);
      maxY = Math.max(maxY, p.positions[i + 1]);
      maxZ = Math.max(maxZ, p.positions[i + 2]);
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.01);
  const scale = (Math.min(W, H) * 0.72) / span;

  // 3/4 view: X right, Y up, Z toward camera-ish (simple isometric-ish)
  const project = (x: number, y: number, z: number) => {
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    // yaw ~35°, pitch ~25°
    const cosA = 0.82,
      sinA = 0.57;
    const cosB = 0.9,
      sinB = 0.44;
    const x1 = dx * cosA - dz * sinA;
    const z1 = dx * sinA + dz * cosA;
    const y1 = dy * cosB - z1 * sinB;
    const px = W / 2 + x1 * scale;
    const py = H / 2 - y1 * scale + H * 0.05;
    return [px, py] as const;
  };

  const put = (px: number, py: number, r: number, g: number, b: number) => {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    // additive-ish brighten
    rgba[i] = Math.min(255, (rgba[i] + r) >> 1);
    rgba[i + 1] = Math.min(255, (rgba[i + 1] + g) >> 1);
    rgba[i + 2] = Math.min(255, (rgba[i + 2] + b) >> 1);
    rgba[i + 3] = 255;
    // fat point
    for (const [ox, oy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]) {
      const xx = x + ox;
      const yy = y + oy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = (yy * W + xx) * 4;
      rgba[j] = Math.min(255, (rgba[j] + r) >> 1);
      rgba[j + 1] = Math.min(255, (rgba[j + 1] + g) >> 1);
      rgba[j + 2] = Math.min(255, (rgba[j + 2] + b) >> 1);
      rgba[j + 3] = 255;
    }
  };

  // ground cross at y=0
  for (let t = -1; t <= 1; t += 0.02) {
    const [px, py] = project(cx + t * span * 0.6, 0, cz);
    put(px, py, 60, 60, 80);
    const [px2, py2] = project(cx, 0, cz + t * span * 0.6);
    put(px2, py2, 60, 60, 80);
  }

  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) {
      const [px, py] = project(p.positions[i], p.positions[i + 1], p.positions[i + 2]);
      put(px, py, p.r, p.g, p.b);
    }
  }

  // size bar in corner
  const sizeLabel = `${label}  size ${span.toFixed(2)}m  h=${(maxY - minY).toFixed(2)}  xz=${Math.max(maxX - minX, maxZ - minZ).toFixed(2)}`;
  // crude 5x7 bitmap text is overkill; write sidecar text instead
  writePng(path, W, H, rgba);
  writeFileSync(path.replace(/\.png$/, ".txt"), sizeLabel + "\n");
  console.log("wrote", path, sizeLabel);
}

mkdirSync(OUT, { recursive: true });

for (const key of ["turret-standard", "turret-defense"] as const) {
  const rawPath = join(ROOT, "tools/generators/units/raw/custom", `${key}.glb`);
  const outPath = join(ROOT, "packages/client/public/models/units", `${key}.glb`);
  const raw = parseGlbMeshes(rawPath);
  const out = parseGlbMeshes(outPath);

  // Color hull green, gun magenta if we can tell them apart by name.
  const colored = raw.map((p) => {
    const isGun = /gun/i.test(p.name);
    return {
      positions: p.positions,
      r: isGun ? 240 : 40,
      g: isGun ? 40 : 220,
      b: isGun ? 200 : 80,
    };
  });
  paint(join(OUT, `${key}-raw-parts.png`), colored, `${key} RAW hull=green gun=magenta`);

  paint(
    join(OUT, `${key}-shipped.png`),
    out.map((p) => ({ positions: p.positions, r: 200, g: 200, b: 220 })),
    `${key} SHIPPED (merged)`,
  );

  // verts
  const rawV = raw.reduce((s, p) => s + p.positions.length / 3, 0);
  const outV = out.reduce((s, p) => s + p.positions.length / 3, 0);
  console.log(key, "raw parts", raw.map((p) => `${p.name}:${p.positions.length / 3}`).join(", "), "→ out verts", outV, "raw total", rawV);
}
