// Render top-down la-cantina overlays (lanes / spawns / turrets) into
// docs/renders/la-cantina-overlay/. Run: bun tools/generators/renderLaCantinaOverlay.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { getMapById } from "../../packages/sim/src/map";

const OUT_DIR = join(import.meta.dir, "../../docs/renders/la-cantina-overlay");
const map = getMapById("la-cantina");
const size = map.size;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function writePNG(path: string, w: number, h: number, rgba: Buffer): void {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 6 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

let minH = Infinity;
let maxH = -Infinity;
for (const h of map.heights) {
  if (h < minH) minH = h;
  if (h > maxH) maxH = h;
}
const inv = maxH > minH ? 1 / (maxH - minH) : 0;

function draw(
  scale: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  outPath: string,
  northUp: boolean,
): void {
  const cw = x1 - x0;
  const ch = y1 - y0;
  const w = cw * scale;
  const h = ch * scale;
  const rgba = Buffer.alloc(w * h * 4);

  for (let py = 0; py < h; py++) {
    const j = northUp
      ? Math.min(size - 1, y1 - 1 - Math.floor(py / scale))
      : Math.min(size - 1, y0 + Math.floor(py / scale));
    for (let px = 0; px < w; px++) {
      const i = Math.min(size - 1, x0 + Math.floor(px / scale));
      const o = (py * w + px) * 4;
      if (map.waterMask[j * size + i] === 1) {
        rgba[o] = 26;
        rgba[o + 1] = 74;
        rgba[o + 2] = 85;
        rgba[o + 3] = 255;
      } else {
        const t = (map.heights[j * size + i] - minH) * inv;
        rgba[o] = Math.round(90 + t * 100);
        rgba[o + 1] = Math.round(85 + t * 90);
        rgba[o + 2] = Math.round(70 + t * 50);
        rgba[o + 3] = 255;
      }
    }
  }

  const toScr = (x: number, y: number): [number, number] => {
    const sx = (x - x0) * scale;
    const sy = northUp ? (y1 - y) * scale : (y - y0) * scale;
    return [sx, sy];
  };

  const disc = (x: number, y: number, rad: number, r: number, g: number, b: number) => {
    const [cx, cy] = toScr(x, y);
    const R = Math.ceil(rad * scale);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
  };
  const ring = (x: number, y: number, rad: number, r: number, g: number, b: number) => {
    const [cx, cy] = toScr(x, y);
    const R = Math.ceil(rad * scale);
    const Ri = Math.max(0, R - Math.max(2, Math.round(scale * 0.35)));
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R || d2 < Ri * Ri) continue;
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
  };
  const line = (
    x0s: number,
    y0s: number,
    x1s: number,
    y1s: number,
    r: number,
    g: number,
    b: number,
    thick = 2,
  ) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1s - x0s, y1s - y0s) * scale * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0s + (x1s - x0s) * t;
      const y = y0s + (y1s - y0s) * t;
      const [cx, cy] = toScr(x, y);
      for (let dy = -thick; dy <= thick; dy++) {
        for (let dx = -thick; dx <= thick; dx++) {
          const px = Math.round(cx + dx);
          const py = Math.round(cy + dy);
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const o = (py * w + px) * 4;
          rgba[o] = r;
          rgba[o + 1] = g;
          rgba[o + 2] = b;
          rgba[o + 3] = 255;
        }
      }
    }
  };

  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      if (map.wallsV[j * size + i]) line(i, j, i, j + 1, 50, 50, 50, 0);
      if (map.wallsH[j * size + i]) line(i, j, i + 1, j, 50, 50, 50, 0);
    }
  }

  const laneCols: [number, number, number][] = [
    [66, 165, 245],
    [239, 83, 80],
  ];
  map.lanes.forEach((lane, li) => {
    const [r, g, b] = laneCols[li % 2];
    const thick = Math.max(2, Math.round(scale * 0.35));
    for (let k = 0; k < lane.length - 1; k++) {
      line(lane[k].x, lane[k].y, lane[k + 1].x, lane[k + 1].y, r, g, b, thick);
    }
    for (const p of lane) disc(p.x, p.y, 0.4, r, g, b);
  });

  map.bases.forEach((base, team) => {
    const col: [number, number, number] = team === 0 ? [33, 150, 243] : [244, 67, 54];
    disc(base.core.x, base.core.y, 2.0, ...col);
    ring(base.core.x, base.core.y, 2.8, ...col);
    for (const t of base.turrets) {
      disc(t.x, t.y, 1.25, 255, 152, 0);
      ring(t.x, t.y, 1.6, 255, 255, 255);
    }
  });

  for (const t of map.turretSpots) {
    disc(t.x, t.y, 1.35, 236, 236, 236);
    disc(t.x, t.y, 0.65, 120, 120, 120);
  }
  for (const t of map.dummySpots) {
    ring(t.x, t.y, 1.35, 126, 87, 194);
    disc(t.x, t.y, 0.7, 126, 87, 194);
  }
  for (const o of map.outpostSpots) {
    disc(o.x, o.y, 1.5, 255, 235, 59);
    ring(o.x, o.y, 1.9, 0, 0, 0);
  }
  for (const s of map.spawns) {
    disc(s.x, s.y, 2.2, 0, 230, 118);
    ring(s.x, s.y, 2.7, 255, 255, 255);
    line(s.x, s.y, s.x + Math.cos(s.yaw) * 3.5, s.y + Math.sin(s.yaw) * 3.5, 0, 230, 118, 2);
  }

  line(96.5, y0, 96.5, y1, 0, 200, 255, 0);

  writePNG(outPath, w, h, rgba);
  console.log("wrote", outPath, `${w}x${h}`);
}

mkdirSync(OUT_DIR, { recursive: true });
// Frame on FCOP logic centre (same as la-cantina-top.png / prep_viz bbox centre).
// Equal half-extents so the compound is centered — NOT the padded 241 grid.
const LOGIC_CX = 96.16;
const LOGIC_CY = 112.03;
const HALF_W = 38; // covers dual-ring + bases
const HALF_H = 52;
const fx0 = Math.floor(LOGIC_CX - HALF_W);
const fx1 = Math.ceil(LOGIC_CX + HALF_W);
const fy0 = Math.floor(LOGIC_CY - HALF_H);
const fy1 = Math.ceil(LOGIC_CY + HALF_H);

draw(4, fx0, fy0, fx1, fy1, join(OUT_DIR, "top-full.png"), false);
draw(4, fx0, fy0, fx1, fy1, join(OUT_DIR, "top-full-north-up.png"), true);
draw(6, fx0, fy0, fx1, fy1, join(OUT_DIR, "top-zoom.png"), false);
draw(6, fx0, fy0, fx1, fy1, join(OUT_DIR, "top-zoom-north-up.png"), true);

// SVG zoom with labels — same logic-centred frame as the PNGs
const x0 = fx0;
const x1 = fx1;
const y0 = fy0;
const y1 = fy1;
const cw = x1 - x0;
const ch = y1 - y0;
const lines: string[] = [];
lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
lines.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${cw * 5}" height="${(ch + 20) * 5}" viewBox="${x0} ${y0} ${cw} ${ch + 20}">`,
);
lines.push(`<rect x="${x0}" y="${y0}" width="${cw}" height="${ch + 20}" fill="#0a0a0c"/>`);
for (let j = y0; j < y1; j++) {
  for (let i = x0; i < x1; i++) {
    const t = (map.heights[j * size + i] - minH) * inv;
    const r = Math.round(90 + t * 100);
    const g = Math.round(85 + t * 90);
    const b = Math.round(70 + t * 50);
    const fill = map.waterMask[j * size + i] === 1 ? "#1a4a55" : `rgb(${r},${g},${b})`;
    lines.push(`<rect x="${i}" y="${j}" width="1" height="1" fill="${fill}"/>`);
  }
}
const laneColors = ["#42a5f5", "#ef5350"];
map.lanes.forEach((lane, li) => {
  const pts = lane.map((p) => `${p.x},${p.y}`).join(" ");
  lines.push(
    `<polyline points="${pts}" fill="none" stroke="${laneColors[li]}" stroke-width="1.6" stroke-opacity="0.35"/>`,
  );
  lines.push(
    `<polyline points="${pts}" fill="none" stroke="${laneColors[li]}" stroke-width="0.7" stroke-linecap="round"/>`,
  );
});
map.bases.forEach((b, team) => {
  const col = team === 0 ? "#2196f3" : "#f44336";
  lines.push(
    `<circle cx="${b.core.x}" cy="${b.core.y}" r="2.2" fill="${col}" fill-opacity="0.4" stroke="${col}" stroke-width="0.35"/>`,
  );
  for (const t of b.turrets) {
    lines.push(
      `<rect x="${t.x - 1}" y="${t.y - 1}" width="2" height="2" fill="#ff9800" stroke="#fff" stroke-width="0.2" transform="rotate(45 ${t.x} ${t.y})"/>`,
    );
  }
});
map.turretSpots.forEach((t, i) => {
  lines.push(
    `<circle cx="${t.x}" cy="${t.y}" r="1.35" fill="#eee" stroke="#333" stroke-width="0.25"/>`,
  );
  lines.push(
    `<text x="${t.x}" y="${t.y + 0.5}" text-anchor="middle" font-size="1.4" fill="#333" font-family="monospace" font-weight="700">C${i}</text>`,
  );
});
map.dummySpots.forEach((t) => {
  lines.push(
    `<circle cx="${t.x}" cy="${t.y}" r="1.15" fill="#7e57c2" stroke="#fff" stroke-width="0.2"/>`,
  );
});
map.outpostSpots.forEach((o, i) => {
  lines.push(
    `<rect x="${o.x - 1.2}" y="${o.y - 1.2}" width="2.4" height="2.4" fill="#ffeb3b" stroke="#000" stroke-width="0.2"/>`,
  );
  lines.push(
    `<text x="${o.x}" y="${o.y + 0.55}" text-anchor="middle" font-size="1.3" fill="#000" font-family="monospace" font-weight="700">O${i}</text>`,
  );
});
map.spawns.forEach((s, i) => {
  lines.push(
    `<circle cx="${s.x}" cy="${s.y}" r="2.1" fill="#00e676" stroke="#fff" stroke-width="0.35"/>`,
  );
  lines.push(
    `<line x1="${s.x}" y1="${s.y}" x2="${s.x + Math.cos(s.yaw) * 3}" y2="${s.y + Math.sin(s.yaw) * 3}" stroke="#00e676" stroke-width="0.55"/>`,
  );
  lines.push(
    `<text x="${s.x}" y="${s.y + 0.7}" text-anchor="middle" font-size="1.6" fill="#000" font-family="monospace" font-weight="700">S${i}</text>`,
  );
});
lines.push(
  `<line x1="96.5" y1="${y0}" x2="96.5" y2="${y1}" stroke="#00e5ff" stroke-width="0.25" stroke-dasharray="1.5 1.5"/>`,
);
lines.push(`<rect x="${x0}" y="${y1}" width="${cw}" height="20" fill="#12141a"/>`);
lines.push(
  `<text x="${x0 + 2}" y="${y1 + 5}" font-family="monospace" font-size="2.6" fill="#fff" font-weight="700">la-cantina · FCOP Cnet dual-ring · cyan = x=96.5</text>`,
);
lines.push(
  `<text x="${x0 + 2}" y="${y1 + 10}" font-family="monospace" font-size="2.2" fill="#90caf9">blue=lane0 west · red=lane1 east · orange=defense · white=capturable · purple=dummy · yellow=outpost · green=spawn</text>`,
);
lines.push(
  `<text x="${x0 + 2}" y="${y1 + 15}" font-family="monospace" font-size="2.1" fill="#888">SVG: sim +Y down · use *-north-up.png for north-up</text>`,
);
lines.push(`</svg>`);
writeFileSync(join(OUT_DIR, "top-zoom-interior.svg"), lines.join("\n"));

const md: string[] = [];
md.push("# la-cantina overlays (current sim map)");
md.push("");
md.push("Source: `packages/sim/maps/la-cantina.json` — FCOP Cnet dual-ring lanes.");
md.push("");
md.push("## Images");
md.push("| File | Description |");
md.push("|------|-------------|");
md.push("| **`top-zoom-north-up.png`** | Recommended — interior, north up |");
md.push("| `top-full-north-up.png` | Full map, north up |");
md.push("| `top-zoom.png` | Interior, sim Y down |");
md.push("| `top-full.png` | Full map, sim Y down |");
md.push("| `top-zoom-interior.svg` | Vector zoom + labels |");
md.push("");
md.push("## Legend");
md.push("- **Blue** — lane 0 west ring (mean X ≈ 89)");
md.push("- **Red** — lane 1 east ring (mean X ≈ 104)");
md.push("- **Cyan dashed** — centerline x = 96.5");
md.push("- **Green** — spawns");
md.push("- **Orange** — defense (base ring)");
md.push("- **White** — capturable");
md.push("- **Purple** — dummy");
md.push("- **Yellow** — outpost console");
md.push("");
md.push("## Spawns");
for (const [i, s] of map.spawns.entries()) {
  md.push(`- S${i}: (${s.x}, ${s.y})`);
}
md.push("");
md.push("## Lanes");
map.lanes.forEach((lane, i) => {
  const mx = lane.reduce((s, p) => s + p.x, 0) / lane.length;
  md.push(`### Lane ${i} (n=${lane.length}, meanX=${mx.toFixed(1)})`);
  md.push(lane.map((p) => `(${p.x},${p.y})`).join(" → "));
});
md.push("");
md.push("## Defense");
map.bases.forEach((b, t) => {
  md.push(`### Team ${t}`);
  for (const p of b.turrets) md.push(`- (${p.x}, ${p.y})`);
});
md.push("");
md.push("## Capturable / dummy / outpost");
md.push(`capturable: ${map.turretSpots.map((p) => `(${p.x},${p.y})`).join(" ")}`);
md.push(`dummy: ${map.dummySpots.map((p) => `(${p.x},${p.y})`).join(" ")}`);
md.push(`outpost: ${map.outpostSpots.map((p) => `(${p.x},${p.y})`).join(" ")}`);
writeFileSync(join(OUT_DIR, "README.md"), `${md.join("\n")}\n`);
console.log("wrote README + SVG");
