// Top-down arena minimap for the menu picker — a lightweight 2D preview drawn
// straight from MapData (heightfield + water mask + base cores). This is
// CLIENT-only 2D canvas work: Math.* and free-form drawing are fine here (no
// sim state, no determinism coupling, never runs inside the render frame loop).
// It mirrors buildTerrainMesh's palette so a thumbnail reads like a zoomed-out
// version of the live 3D backdrop.

import type { MapData } from "@metropolis/sim";
import { TEAM_RAMPS, TERRAIN_HEX } from "./palette";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function rgb(hex: number): Rgb {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/**
 * Draws a top-down minimap of `map` into `canvas` at its current pixel size
 * (set canvas.width/height before calling). Height shades tan low→high to match
 * the 3D terrain palette, water cells read teal, and each team's base core is
 * marked with a team-colored dot so the two sides read at a glance.
 */
export function drawArenaThumbnail(canvas: HTMLCanvasElement, map: MapData): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  if (W === 0 || H === 0) return;

  const low = rgb(TERRAIN_HEX.low);
  const high = rgb(TERRAIN_HEX.high);
  const water = rgb(TERRAIN_HEX.water);

  // Height range for normalization — same idea as buildTerrainMesh.
  let minH = Infinity;
  let maxH = -Infinity;
  for (let k = 0; k < map.heights.length; k++) {
    const h = map.heights[k];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const invRange = maxH > minH ? 1 / (maxH - minH) : 0;

  const s = map.size;
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let py = 0; py < H; py++) {
    // Nearest grid cell for this pixel: sim x → canvas x, sim y → canvas y.
    const j = Math.min(s - 1, Math.floor((py / H) * s));
    for (let px = 0; px < W; px++) {
      const i = Math.min(s - 1, Math.floor((px / W) * s));
      const k = j * s + i;
      const c = map.waterMask[k] === 1 ? water : mix(low, high, (map.heights[k] - minH) * invRange);
      const o = (py * W + px) * 4;
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Base cores: a filled team-colored dot with a light ring. World (x, y) maps
  // to canvas (px, py) through the playable extent.
  const extent = (s - 1) * map.cellSize;
  const r = Math.max(3, Math.round(Math.min(W, H) * 0.05));
  for (let team = 0; team < map.bases.length; team++) {
    const core = map.bases[team].core;
    const px = (core.x / extent) * W;
    const py = (core.y / extent) * H;
    const ramp = TEAM_RAMPS[team] ?? TEAM_RAMPS[0];
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = hexCss(ramp.base);
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.35);
    ctx.strokeStyle = hexCss(ramp.light);
    ctx.stroke();
  }
}
