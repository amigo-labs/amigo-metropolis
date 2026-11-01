// The original's terrain trace: does a straight line from A to B reach B, and
// if not, what stopped it and where (fcop-fidelity.md T1).
//
// Transcribed statement by statement from the decompiled executable
// (amigo-labs/fcop-reverse-engineering `src/game/world/trace.c`,
// `src/include/fcop/trace.h`):
//
//   terrainTraceSegment  retail 0x00454790 (its loop tail at 0x00455283): a
//       fixed-point DDA over the 1 m terrain samples, at 32x the world scale,
//       handing each clipped piece to the cell test;
//   terrainTraceCell     retail 0x00455480: one piece against every plate over
//       one sample cell -- the floor plates (types 0x00..0x46) as planes, the
//       wall plates (0x47..0x6e) as vertical quads.
//
// Every line the original tests against the arena goes through these two: the
// hitscan guns, every round's step, the shooters' clear line, the target
// searches, the sustained weapons' sweeps, the walker's head, the camera.
//
// Coordinates are the ORIGINAL's, in world units (8192 a metre): {x, y, z} with
// y up, x along the grid's rows (the sim's y) and z along its width (the sim's
// x). traceLine below converts from the sim's metres. The plates are the map's
// `trace` (gen:trace, tools/generators/fcopTrace.ts), the container's own bytes.
//
// DETERMINISM. Integer arithmetic only, as retail's: every value an int32, `| 0`
// after a sum that can leave 32 bits, `Math.imul` for a product, `>>>` where
// retail is unsigned. `mulShr16` (bits 16..47 of a signed 64-bit product) is
// assembled from 16-bit halves; the two unsigned divides are a double quotient
// floored, exact for operands below 2^32. No transcendental Math.* is used.
//
// Retail's four quirks are kept, as trace.c keeps them: the displaced shape-1
// floor plane, the wall pick's running best distance read before it is written
// (carried between calls in `TraceScratch.pickBest`, which the sim keeps in its
// state), the `y_at_b` seed from `hit_floors`, and the zero-length first piece on
// a cell boundary travelling down.
//
// Zero allocations: the scratch is module-level.

import type { MapTrace } from "./map";
import { TERRAIN_TYPE_CORNERS, TERRAIN_TYPE_FLAGS } from "./traceTables.generated";

/** trace.h TRACE_KIND_*: which line of the cell a wall stands on, or a floor. */
export const TRACE_KIND_WALL_X = 1;
export const TRACE_KIND_WALL_Z = 2;
export const TRACE_KIND_WALL_ANTIDIAG = 3;
export const TRACE_KIND_WALL_DIAG = 4;
export const TRACE_KIND_FLOOR = 5;
/** The result's low three bits: the kind of plate that stopped the line. */
export const TRACE_KIND_MASK = 7;
/** view_trace's see-through bit: bit 7 of the action type, bit 15 of the result. */
export const TRACE_PASSTHROUGH = 0x8000;

/**
 * What one caller carries between traces: the wall pick's running best distance
 * (trace.c `g_pick_best`, retail's [esp+0x40] of 0x00455480, which a call reads
 * before writing when every candidate is a kind-1/2 wall), and how many wall
 * candidates the last cell test collected.
 */
export interface TraceScratch {
  pickBest: number;
  candidates: number;
}

/** A fresh scratch, as retail's static starts. */
export function newTraceScratch(): TraceScratch {
  return { pickBest: 0, candidates: 0 };
}

const TERRAIN_SAMPLE_SHIFT = 13;
const TERRAIN_CELL_SHIFT = 17;
const TERRAIN_TYPE_COUNT = 0x70;
const TERRAIN_TYPE_MAX = 0x46;
const TERRAIN_CELL_INDEX_OFFSET = 0x3cc;
const TERRAIN_PLATE_OFFSET = 0x5d0;
const TRACE_ACTION_TYPE_OFFSET = 0x370;
const TRACE_FIXED_SHIFT = 5;
const TRACE_CELL_STEP = 1 << (TERRAIN_SAMPLE_SHIFT + TRACE_FIXED_SHIFT); // 0x40000
const TRACE_GRID_STEP = 1 << (TERRAIN_CELL_SHIFT + TRACE_FIXED_SHIFT); // 0x400000
const TRACE_NO_CROSSING = 0x40000000;
/** trace.h TRACE_MAX_CANDIDATES. */
const MAX_CANDIDATES = 16;

// --- the cell test's scratch ------------------------------------------------

const cellA = new Int32Array(3);
const cellB = new Int32Array(3);
const crossing = new Int32Array(3);
const candPt = new Int32Array(MAX_CANDIDATES * 3);
const candTop = new Int32Array(MAX_CANDIDATES);
const candWord = new Uint32Array(MAX_CANDIDATES);
const candKind = new Int32Array(MAX_CANDIDATES);
const plane = new Int32Array(5); // cx, cz, w, d, href
const pieceStart = new Int32Array(3);
const pieceEnd = new Int32Array(3);

/** A signed byte of the section. */
function i8(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 24) >> 24;
}

function u32At(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * `cptc_cell_raw` (grid.c) then `ctil_section_of` (tile.c): the byte offset in
 * `trace.bytes` of the section over grid cell (x, z), or -1 when the id has no
 * section. Off the grid the raw word is 0, so section 0 answers there, as in
 * retail.
 */
function sectionAt(trace: MapTrace, gx: number, gz: number): number {
  let id = 0;
  if (gx >= 0 && gz >= 0 && gx < trace.height && gz < trace.width) {
    id = trace.cells[gx * trace.width + gz];
  }
  return id < trace.sectAt.length ? trace.sectAt[id] : -1;
}

/**
 * trace_floor_plane: the plane constants and reference corner by shape (the
 * jump table at 0x00455c94). Shape 1 is retail's displaced plane.
 */
function floorPlane(shape: number, h0: number, h1: number, h2: number): void {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  let href = h0;
  switch (shape) {
    case 0:
      a = 0x20;
      break;
    case 1:
      b = -0x20;
      c = 0x20;
      d = 0x20;
      href = h1;
      break;
    case 2:
      a = 0x20;
      c = 0x20;
      break;
    case 3:
    case 4:
      a = 0x20;
      b = 0x20;
      break;
    default:
      break;
  }
  plane[0] = b * (h1 - h0) - a * (h2 - h0); // cx
  plane[1] = c * (h2 - h0) - (h1 - h0) * 0x20; // cz
  plane[2] = a * 0x20 - b * c; // w
  plane[3] = d;
  plane[4] = href;
}

/** trace_floor_eval: the plane's value at p ({z, x, y}), in wrapping 32-bit arithmetic. */
function floorEval(p: Int32Array): number {
  const cx = plane[0];
  const cz = plane[1];
  const w = plane[2];
  const d = plane[3];
  const href = plane[4];
  let v = Math.imul((p[2] - Math.imul(href, 256)) | 0, w);
  v = (v + Math.imul((p[0] - d) | 0, cz)) | 0;
  v = (v + Math.imul(p[1], cx)) | 0;
  return v;
}

/**
 * Retail 0x00455480 (`terrain_trace_cell`). `from` and `to` are {z, x, y} in
 * world units and lie in or next to the sample cell under their midpoint.
 * `outHit` receives the hit point as {x, y, z}. Returns 0 when nothing over the
 * cell stops the piece, else (action type << 8) | kind.
 */
export function terrainTraceCell(
  trace: MapTrace,
  from: Int32Array,
  to: Int32Array,
  outHit: Int32Array | null,
  hitFloors: number,
  st: TraceScratch,
): number {
  let midZ = (from[0] + to[0]) | 0;
  midZ = (midZ - (midZ >> 31)) | 0;
  midZ >>= 1;
  let midX = (from[1] + to[1]) | 0;
  midX = (midX - (midX >> 31)) | 0;
  midX >>= 1;

  st.candidates = 0;

  const sect = sectionAt(trace, midX >> TERRAIN_CELL_SHIFT, midZ >> TERRAIN_CELL_SHIFT);
  if (sect < 0) return 0;
  const bytes = trace.bytes;

  const sampleX = midX >> TERRAIN_SAMPLE_SHIFT;
  const sampleZ = midZ >> TERRAIN_SAMPLE_SHIFT;
  const u = sampleX & 0xf;
  const v = sampleZ & 0xf;
  const cell = u * 16 + v;
  const corner = sect + (cell + 4 + u) * 3;
  const xbase = sampleX << TERRAIN_SAMPLE_SHIFT;
  const zbase = sampleZ << TERRAIN_SAMPLE_SHIFT;

  const index =
    bytes[sect + TERRAIN_CELL_INDEX_OFFSET + cell * 2] |
    (bytes[sect + TERRAIN_CELL_INDEX_OFFSET + cell * 2 + 1] << 8);
  let plate = sect + TERRAIN_PLATE_OFFSET + (index >> 4);
  let remaining = index & 0xf;

  const a = cellA;
  const b = cellB;
  a[0] = (from[0] - zbase) | 0;
  a[1] = (from[1] - xbase) | 0;
  a[2] = from[2];
  b[0] = (to[0] - zbase) | 0;
  b[1] = (to[1] - xbase) | 0;
  b[2] = to[2];
  crossing[0] = 0;
  crossing[1] = 0;
  crossing[2] = 0;

  let best = -1;

  while (remaining > 0) {
    const word = u32At(bytes, plate);
    plate += 4;
    const type = (word >>> 15) & 0x7f;
    if (type >= TERRAIN_TYPE_COUNT) {
      // Bounded, not reproduced: no shipped plate is above 0x6e (trace.c).
      remaining--;
      continue;
    }

    if (type <= TERRAIN_TYPE_MAX) {
      // ---- a floor plate ----
      if (hitFloors === 0) {
        remaining--;
        continue;
      }
      const h0 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4]);
      const h1 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4 + 1]);
      const h2 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4 + 2]);
      let cornerHi = h0;
      let cornerLo = h0;
      if (h1 > h0) cornerHi = h1;
      else if (h1 < h0) cornerLo = h1;
      if (h2 > cornerHi) cornerHi = h2;
      else if (h2 < cornerLo) cornerLo = h2;

      // The endpoint with the larger y is the one a hit reports.
      let upper = to;
      let yHi = to[2] >> 8;
      let yLo = from[2] >> 8;
      if (yHi < yLo) {
        upper = from;
        const swap = yHi;
        yHi = yLo;
        yLo = swap;
      }
      if (yLo > cornerHi || yHi < cornerLo) {
        remaining--;
        continue;
      }

      floorPlane(TERRAIN_TYPE_FLAGS[type] >> 3, h0, h1, h2);
      const fa = floorEval(a);
      const fb = floorEval(b);
      // Opposite signs, or equal values (retail's `xor; jle`).
      if ((fa ^ fb) <= 0) {
        if (outHit !== null) {
          outHit[0] = upper[1];
          outHit[1] = upper[2];
          outHit[2] = upper[0];
        }
        return (
          (bytes[sect + TRACE_ACTION_TYPE_OFFSET + ((word >>> 13) & 3)] << 8) | TRACE_KIND_FLOOR
        );
      }
      remaining--;
      continue;
    }

    // ---- a wall plate ----
    const flags = TERRAIN_TYPE_FLAGS[type];
    const kind = flags & 7;
    const shape = flags >> 3;

    // Does the piece cross the line the wall stands on (0x00455ca8)?
    let consider = true;
    switch (kind) {
      case TRACE_KIND_WALL_X:
        if (a[1] > 0 && b[1] > 0) consider = false;
        break;
      case TRACE_KIND_WALL_Z:
        if (a[0] > 0 && b[0] > 0) consider = false;
        break;
      case TRACE_KIND_WALL_ANTIDIAG: {
        const sideB = (b[0] + b[1] - 0x2000) | 0;
        const sideA = (a[0] + a[1] - 0x2000) | 0;
        st.pickBest = sideB; // retail's [esp+0x40]
        if (sideB !== 0 && (sideA ^ sideB) >= 0) consider = false;
        break;
      }
      case TRACE_KIND_WALL_DIAG: {
        const sideB = (b[0] - b[1]) | 0;
        const sideA = (a[0] - a[1]) | 0;
        st.pickBest = sideB;
        if (sideB !== 0 && (sideA ^ sideB) >= 0) consider = false;
        break;
      }
      default:
        break;
    }
    if (!consider) {
      remaining--;
      continue;
    }

    // The vertical quad's two edges by the shape (0x00455cb8).
    const c0 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4]);
    const c1 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4 + 1]);
    const c2 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4 + 2]);
    const c3 = i8(bytes, corner + TERRAIN_TYPE_CORNERS[type * 4 + 3]);
    let topAt0 = c1;
    let topAt1 = c2;
    let botAt1 = c3;
    let pick: Int32Array = a;
    let t = 0;

    switch (kind) {
      case TRACE_KIND_WALL_X:
        if (shape === 0xc) {
          botAt1 = c2;
          topAt1 = c1;
          topAt0 = c0;
        } else if (shape === 0xb) {
          botAt1 = c2;
        }
        pick = a[1] !== 0 ? b : a;
        t = pick[0];
        break;
      case TRACE_KIND_WALL_Z:
        if (shape === 0xa) {
          botAt1 = c2;
          topAt1 = c1;
          topAt0 = c0;
        } else if (shape === 9) {
          botAt1 = c2;
        }
        pick = a[0] !== 0 ? b : a;
        t = pick[1];
        break;
      case TRACE_KIND_WALL_ANTIDIAG:
        if (shape === 6) {
          botAt1 = c2;
          topAt1 = c1;
          topAt0 = c0;
        } else if (shape === 5) {
          botAt1 = c1;
          topAt1 = c1;
          topAt0 = c2;
        }
        if (a[0] === b[0]) {
          pick = a;
          t = a[0];
        } else {
          const dz = (b[0] - a[0]) | 0;
          const dx = (b[1] - a[1]) | 0;
          const den = (dx + dz) | 0;
          if (den === 0) return 0;
          const num = (Math.imul((0x2000 - a[1]) | 0, dz) + Math.imul(dx, a[0])) | 0;
          const zi = (num / den) | 0;
          crossing[0] = zi;
          crossing[1] = (0x2000 - zi) | 0;
          crossing[2] = ((Math.imul((zi - a[0]) | 0, (b[2] - a[2]) | 0) / dz) | 0) + a[2];
          pick = crossing;
          t = zi;
        }
        break;
      case TRACE_KIND_WALL_DIAG:
        if (shape === 8) {
          botAt1 = c2;
          topAt1 = c1;
          topAt0 = c0;
        } else if (shape === 7) {
          botAt1 = c2;
        }
        if (a[0] === b[0]) {
          pick = a;
          t = a[0];
        } else {
          const dz = (b[0] - a[0]) | 0;
          const dx = (b[1] - a[1]) | 0;
          const den = (dx - dz) | 0;
          if (den === 0) return 0;
          const num = (Math.imul(dx, a[0]) - Math.imul(dz, a[1])) | 0;
          const xi = (num / den) | 0;
          crossing[0] = xi;
          crossing[1] = xi;
          crossing[2] = ((Math.imul((xi - a[0]) | 0, (b[2] - a[2]) | 0) / dz) | 0) + a[2];
          pick = crossing;
          t = xi;
        }
        break;
      default:
        break;
    }

    // t runs 0..0x2000 across the cell, the corner bytes scaled by 256: `sar 5`.
    let top = ((Math.imul(topAt1 - topAt0, t) >> 5) + topAt0 * 256) | 0;
    let bot = ((Math.imul(botAt1 - c0, t) >> 5) + c0 * 256) | 0;
    if (bot > top) {
      const swap = bot;
      bot = top;
      top = swap;
    }
    if (pick[2] >= top || pick[2] <= bot) {
      remaining--;
      continue;
    }

    best++;
    if (best < MAX_CANDIDATES) {
      candPt[best * 3] = pick[0];
      candPt[best * 3 + 1] = pick[1];
      candPt[best * 3 + 2] = pick[2];
      candWord[best] = word;
      candKind[best] = kind;
      candTop[best] = top;
    }
    remaining--;
  }

  if (best < 0) return 0;
  st.candidates = best + 1;

  // More than one wall: the nearest to where the piece entered the cell, by an
  // octagonal distance, against the carried running best.
  if (best > 0) {
    for (let i = best; i >= 0; i--) {
      let dz = (candPt[i * 3] - a[0]) | 0;
      if (dz < 0) dz = -dz;
      let dx = (candPt[i * 3 + 1] - a[1]) | 0;
      if (dx < 0) dx = -dx;
      let hi = dz;
      let lo = dx;
      if (dx > dz) {
        hi = dx;
        lo = dz;
      }
      let base = hi;
      let term = lo;
      if (lo > hi >> 1) {
        base = (Math.imul(hi, 0x4b) + Math.imul(lo, 0x6a)) >> 7;
        term = (hi - lo) | 0;
      }
      const dist = (base + (term >> 2) - (term >> 6)) | 0;
      if (dist < st.pickBest) {
        st.pickBest = dist;
        best = i;
      }
    }
  }

  if (outHit !== null) {
    outHit[0] = (candPt[best * 3 + 1] + xbase) | 0;
    outHit[1] = candPt[best * 3 + 2];
    outHit[2] = (candPt[best * 3] + zbase) | 0;
  }
  return (
    (bytes[sect + TRACE_ACTION_TYPE_OFFSET + ((candWord[best] >>> 13) & 3)] << 8) | candKind[best]
  );
}

// --- the walk, 0x00454790 ---------------------------------------------------

/**
 * Bits 16..47 of the signed 64-bit product x * y, as an int32 (retail's
 * `imul; shr eax,16; shl edx,16; or`). Exact: assembled from 16-bit halves.
 */
function mulShr16(x: number, y: number): number {
  const xh = x >> 16;
  const xl = x & 0xffff;
  const yh = y >> 16;
  const yl = y & 0xffff;
  const low = Math.floor((xl * yl) / 65536);
  const mid = xh * yl + xl * yh;
  return (Math.imul(Math.imul(xh, yh), 65536) + mid + low) | 0;
}

/** `0x80000000u / (u32)q` for 0 < q < 2^32, as an int32. */
function recipOf(q: number): number {
  return Math.floor(2147483648 / (q >>> 0)) | 0;
}

/** recip6: retail's two arms, `sar 6` for a positive denominator, `sar 5; neg; sar 1` else. */
function recip6(den: number): number {
  const q = (den & ~0x1f) > 0 ? den >> 6 : -(den >> 5) >> 1;
  return recipOf(q);
}

/** Step along one axis per unit of the major axis, 1/2^21 units; den > 0. */
function traceStep(num: number, den: number): number {
  if (den <= 0x7f) return num << 10;
  const r = mulShr16(recip6(den), num > 0 ? num : -num | 0);
  return num > 0 ? r : -r | 0;
}

/** The same divide with the minor axis' (negative) delta as denominator. */
function traceStepDown(num: number, den: number): number {
  if (-den <= 0x7f) return -(num << 10) | 0;
  const r = mulShr16(recip6(den), num > 0 ? num : -num | 0);
  return num > 0 === (den & ~0x1f) > 0 ? -r | 0 : r;
}

/**
 * The fraction of the segment consumed at the one boundary the minor axis
 * crosses, 1/2^16 units (`sar 1`). A |den| below 2 would divide by zero in
 * retail; it cannot arise from a segment that crosses a boundary at the 32x
 * scale by more than a unit, and answers 0 here.
 */
function traceFraction(num: number, den: number): number {
  const q = den > 0 ? den >> 1 : -den >> 1;
  if (q === 0) return 0;
  const recip = recipOf(q);
  if (num > 0) {
    const r = mulShr16(recip, num);
    return den > 0 ? r : -r | 0;
  }
  const r = mulShr16(recip, -num | 0);
  return den > 0 ? -r | 0 : r;
}

function abs32(v: number): number {
  const s = v >> 31;
  return ((v + s) | 0) ^ s;
}

/**
 * Retail 0x00454790 (`terrain_trace_segment`). `from` and `to` are {x, y, z} in
 * world units. `outHit` receives the hit point as {x, y, z}; it is not written
 * when the line is clear. Returns 0 when the segment reaches `to` (or either end
 * lies outside the grid less one cell, as retail answers), else
 * (action type << 8) | kind of the first plate it meets.
 */
export function terrainTraceSegment(
  trace: MapTrace,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  outHit: Int32Array | null,
  hitFloors: number,
  st: TraceScratch,
): number {
  const fromX = from[0] << TRACE_FIXED_SHIFT;
  const fromY = from[1] << TRACE_FIXED_SHIFT;
  const fromZ = from[2] << TRACE_FIXED_SHIFT;
  const toX = to[0] << TRACE_FIXED_SHIFT;
  const toY = to[1] << TRACE_FIXED_SHIFT;
  const toZ = to[2] << TRACE_FIXED_SHIFT;

  // Both ends a whole grid cell in from the far edge; z against the width.
  let limit = ((trace.width << (TERRAIN_CELL_SHIFT + TRACE_FIXED_SHIFT)) - TRACE_GRID_STEP) | 0;
  if (fromZ < 0 || fromZ >= limit || toZ < 0 || toZ >= limit) return 0;
  limit = ((trace.height << (TERRAIN_CELL_SHIFT + TRACE_FIXED_SHIFT)) - TRACE_GRID_STEP) | 0;
  if (fromX < 0 || fromX >= limit || toX < 0 || toX >= limit) return 0;

  const dy = (toY - fromY) | 0;
  // Axis A starts as z and B as x; A becomes the major axis, increasing.
  let a0 = fromZ;
  let a1 = toZ;
  let da = (toZ - fromZ) | 0;
  let b0 = fromX;
  let b1 = toX;
  let db = (toX - fromX) | 0;
  let orient = 0;
  if (abs32(da) < abs32(db)) {
    let swap = a0;
    a0 = b0;
    b0 = swap;
    swap = a1;
    a1 = b1;
    b1 = swap;
    swap = da;
    da = db;
    db = swap;
    orient = 1;
  }
  if (da < 0) {
    a0 = -a0 | 0;
    a1 = -a1 | 0;
    da = -da | 0;
    b0 = -b0 | 0;
    b1 = -b1 | 0;
    db = -db | 0;
    orient |= 2;
  }

  let nextA = TRACE_NO_CROSSING;
  let bAtA = 0;
  let yAtA = 0;
  let stepB = 0;
  let stepYA = 0;
  let atB = TRACE_NO_CROSSING;
  let nextB = 0;
  let yAtB = 0;
  let stepA = 0;
  let stepYB = 0;
  let bStep = 0;

  const sampleShift = TERRAIN_SAMPLE_SHIFT + TRACE_FIXED_SHIFT;
  if (a1 >> sampleShift !== a0 >> sampleShift) {
    nextA = ((a0 & ~(TRACE_CELL_STEP - 1)) + TRACE_CELL_STEP) | 0;
    const span = (nextA - a0) | 0;
    stepB = traceStep(db, da);
    bAtA = ((mulShr16(stepB, span) >> TRACE_FIXED_SHIFT) + b0) | 0;
    stepYA = traceStep(dy, da);
    yAtA = ((mulShr16(stepYA, span) >> TRACE_FIXED_SHIFT) + fromY) | 0;
  }

  const crossings = (b1 >> sampleShift) - (b0 >> sampleShift);
  if (crossings > 0) {
    nextB = ((b0 & ~(TRACE_CELL_STEP - 1)) + TRACE_CELL_STEP) | 0;
    bStep = TRACE_CELL_STEP;
    if (crossings > 1) {
      const span = (nextB - b0) | 0;
      stepA = traceStep(da, db);
      atB = ((mulShr16(stepA, span) >> TRACE_FIXED_SHIFT) + a0) | 0;
      stepYB = traceStep(dy, db);
      yAtB = ((mulShr16(stepYB, span) >> TRACE_FIXED_SHIFT) + fromY) | 0;
    } else {
      stepA = TRACE_NO_CROSSING;
      const fraction = traceFraction((nextB - b0) | 0, db);
      atB = (mulShr16(fraction, da) + a0) | 0;
      yAtB = (mulShr16(fraction, dy) + fromY) | 0;
      stepYB = dy;
    }
  } else if (crossings < 0) {
    nextB = b0 & ~(TRACE_CELL_STEP - 1);
    bStep = -TRACE_CELL_STEP;
    if (crossings < -1) {
      stepA = traceStepDown(da, db);
      const span = (nextB - b0) | 0;
      atB = (a0 - (mulShr16(stepA, span) >> TRACE_FIXED_SHIFT)) | 0;
      stepYB = traceStepDown(dy, db);
      yAtB = (fromY - (mulShr16(stepYB, span) >> TRACE_FIXED_SHIFT)) | 0;
    } else {
      stepA = TRACE_NO_CROSSING;
      const fraction = traceFraction((nextB - b0) | 0, db);
      atB = (mulShr16(fraction, da) + a0) | 0;
      yAtB = (mulShr16(fraction, dy) + fromY) | 0;
      stepYB = dy;
    }
  } else {
    // Retail seeds y_at_b from `hit_floors` here; inert behind the sentinel.
    atB = TRACE_NO_CROSSING;
    yAtB = hitFloors;
  }

  let curA = (a0 + 0x10) >> TRACE_FIXED_SHIFT;
  let curB = (b0 + 0x10) >> TRACE_FIXED_SHIFT;
  const curY = (fromY + 0x10) >> TRACE_FIXED_SHIFT;
  if ((orient & 2) !== 0) {
    curA = -curA | 0;
    curB = -curB | 0;
  }
  if ((orient & 1) !== 0) {
    const swap = curA;
    curA = curB;
    curB = swap;
  }
  stepB >>= 3;
  stepA >>= 3;
  stepYA >>= 3;
  stepYB >>= 3;

  let yAtAR = (yAtA + 0x10) | 0;
  let yAtBR = (yAtB + 0x10) | 0;
  let nextAR = (nextA + 0x10) | 0;
  let atBR = (atB + 0x10) | 0;
  let bAtAR = (bAtA + 0x10) | 0;
  let nextBR = (nextB + 0x10) | 0;

  const start = pieceStart;
  const end = pieceEnd;
  start[0] = curA;
  start[1] = curB;
  start[2] = curY;

  for (;;) {
    if (nextA >= a1 && atB >= a1) {
      // Nothing left to cross: the last piece runs to the true end.
      let endA = (a1 + 0x10) >> TRACE_FIXED_SHIFT;
      let endB = (b1 + 0x10) >> TRACE_FIXED_SHIFT;
      const endY = (toY + 0x10) >> TRACE_FIXED_SHIFT;
      if ((orient & 2) !== 0) {
        endA = -endA | 0;
        endB = -endB | 0;
      }
      if ((orient & 1) !== 0) {
        end[0] = endB;
        end[1] = endA;
      } else {
        end[0] = endA;
        end[1] = endB;
      }
      end[2] = endY;
      return terrainTraceCell(trace, start, end, outHit, hitFloors, st);
    }

    let pieceA: number;
    let pieceB: number;
    let pieceY: number;
    if (nextA > atB) {
      // Across a boundary on the minor axis.
      pieceY = yAtBR >> TRACE_FIXED_SHIFT;
      pieceA = atBR >> TRACE_FIXED_SHIFT;
      pieceB = nextBR >> TRACE_FIXED_SHIFT;
      nextBR = (nextBR + bStep) | 0;
      atB = (atB + stepA) | 0;
      atBR = (atBR + stepA) | 0;
      yAtBR = (yAtBR + stepYB) | 0;
    } else {
      // Across a boundary on the major axis.
      pieceY = yAtAR >> TRACE_FIXED_SHIFT;
      pieceA = nextAR >> TRACE_FIXED_SHIFT;
      pieceB = bAtAR >> TRACE_FIXED_SHIFT;
      nextA = (nextA + TRACE_CELL_STEP) | 0;
      nextAR = (nextAR + TRACE_CELL_STEP) | 0;
      bAtAR = (bAtAR + stepB) | 0;
      yAtAR = (yAtAR + stepYA) | 0;
    }
    if ((orient & 2) !== 0) {
      pieceA = -pieceA | 0;
      pieceB = -pieceB | 0;
    }
    if ((orient & 1) !== 0) {
      end[0] = pieceB;
      end[1] = pieceA;
    } else {
      end[0] = pieceA;
      end[1] = pieceB;
    }
    end[2] = pieceY;

    const hit = terrainTraceCell(trace, start, end, outHit, hitFloors, st);
    if (hit !== 0) return hit;
    start[0] = end[0];
    start[1] = end[1];
    start[2] = end[2];
  }
}
