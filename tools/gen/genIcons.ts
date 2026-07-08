// Generates packages/client/public/icons/*.png — the PWA app icons + favicon.
//
// Authoring-time only, like genSinTable/genDistrict01: the emitted PNGs are the
// committed, self-authored (CC0, see CREDITS.md) artifacts. The mark is an
// original geometric "breach" — a cyan chevron piercing a broken amber gate bar
// on a dark field — so it carries no third-party or trademarked design.
//
// Dependency-free: pixels are rasterized by hand with anti-aliased SDFs and
// encoded to PNG via the shared node:zlib encoder in ./png.ts.
//
// Usage: bun tools/gen/genIcons.ts

import { encodePng } from "./png";

type RGB = [number, number, number];
type ColorFn = (x: number, y: number) => RGB;

// --- Rasterizer --------------------------------------------------------------

function makeImage(size: number): Uint8ClampedArray {
  return new Uint8ClampedArray(size * size * 4);
}

/** Straight-alpha "over" composite of one pixel. */
function blend(img: Uint8ClampedArray, w: number, x: number, y: number, c: RGB, a: number): void {
  if (a <= 0) return;
  const i = (y * w + x) * 4;
  const da = img[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  img[i] = (c[0] * a + img[i] * da * (1 - a)) / outA;
  img[i + 1] = (c[1] * a + img[i + 1] * da * (1 - a)) / outA;
  img[i + 2] = (c[2] * a + img[i + 2] * da * (1 - a)) / outA;
  img[i + 3] = outA * 255;
}

/** Paints a shape defined by a signed-distance function (px; <0 inside). */
function paint(
  img: Uint8ClampedArray,
  size: number,
  color: RGB | ColorFn,
  alpha: number,
  sdf: (x: number, y: number) => number,
): void {
  const fn: ColorFn = typeof color === "function" ? color : () => color;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      const cov = Math.max(0, Math.min(1, 0.5 - d)); // 1px anti-aliased edge
      if (cov > 0) blend(img, size, x, y, fn(x, y), cov * alpha);
    }
  }
}

function sdRoundRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number,
): number {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
}

function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// --- The mark ----------------------------------------------------------------

const FIELD_TOP: RGB = [19, 26, 42];
const FIELD_BOT: RGB = [8, 11, 20];
const CYAN: RGB = [126, 242, 255];
const AMBER: RGB = [251, 191, 36];

function drawIcon(size: number, rounded: boolean): Uint8ClampedArray {
  const img = makeImage(size);
  const S = size;
  const u = (n: number): number => n * S; // normalized → pixels

  // Field: rounded dark plate with a subtle top-to-bottom gradient.
  const radius = rounded ? u(0.22) : 0;
  const gradient: ColorFn = (_x, y) => {
    const t = y / S;
    return [
      lerp(FIELD_TOP[0], FIELD_BOT[0], t),
      lerp(FIELD_TOP[1], FIELD_BOT[1], t),
      lerp(FIELD_TOP[2], FIELD_BOT[2], t),
    ];
  };
  paint(img, S, gradient, 1, (x, y) => sdRoundRect(x, y, S / 2, S / 2, S / 2, S / 2, radius));

  // Broken gate bar (amber): two vertical segments with a breach gap at center.
  const gateX = u(0.66);
  const gateHalf = u(0.045);
  paint(img, S, AMBER, 1, (x, y) =>
    sdRoundRect(x, y, gateX, u(0.29), gateHalf, u(0.11), gateHalf * 0.6),
  );
  paint(img, S, AMBER, 1, (x, y) =>
    sdRoundRect(x, y, gateX, u(0.71), gateHalf, u(0.11), gateHalf * 0.6),
  );

  // Chevron (cyan): a bold ">" whose tip drives into the breach gap.
  const th = u(0.075); // half thickness
  const chevron = (x: number, y: number): number =>
    Math.min(
      sdSegment(x, y, u(0.3), u(0.26), u(0.58), u(0.5)),
      sdSegment(x, y, u(0.58), u(0.5), u(0.3), u(0.74)),
    ) - th;
  paint(img, S, CYAN, 1, chevron);

  return img;
}

// --- Emit --------------------------------------------------------------------

const OUT = new URL("../../packages/client/public/icons/", import.meta.url);
// Maskable icons keep their content in the safe zone, so the rounded plate can
// fill the frame; the small favicon skips rounding for crisper pixels.
const targets: { name: string; size: number; rounded: boolean }[] = [
  { name: "icon-512.png", size: 512, rounded: true },
  { name: "icon-192.png", size: 192, rounded: true },
  { name: "icon-180.png", size: 180, rounded: true },
  { name: "icon-32.png", size: 32, rounded: false },
];

for (const { name, size, rounded } of targets) {
  const png = encodePng(size, size, drawIcon(size, rounded));
  await Bun.write(new URL(name, OUT), png);
  console.log(`wrote icons/${name} (${size}×${size}, ${png.length} bytes)`);
}
