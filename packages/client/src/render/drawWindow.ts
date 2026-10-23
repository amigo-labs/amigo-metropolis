// The 5 x 5 block of cells the original draws its Props and DCSQuads in
// (fcop-fidelity.md G13): `world_view_focus` (RE game/frame/draw.c 0x00452880)
// meets the camera's axis with the plane at min(player height, 0), takes the
// 16 m cell of that ground focus (`>> 17` of the world unit) and backs off two
// cells; `snd_emit_draw_block` (snd/emitter.c 0x0042fe20) and `pyro_draw_block`
// (world/pyro_chain.c 0x00437310) then walk the five rows and five columns from
// there and draw only what is hung in those cells. Beyond it they are not drawn,
// and a Prop's sound is not claimed (audio/cues.ts).
//
// Cells are the original's: its world origin is the Metropolis map frame's
// (16, 0) m (the generators' LOGIC_OFFSET_X / _Z), a cell 0x20000 world units,
// 16 m.
//
// Within the block a Prop is drawn, and claims its sound, only where its
// footprint meets a leaf on screen: `world_build_tile_block` (draw.c 0x00452a20)
// walks each cell's quadtree (`draw_node_visible` 0x00452de0, `draw_quad_visible`
// 0x00453070) — the cell's sphere, its four 8 m children's, their sixteen 4 m
// leaves', each a (radius, height) pair of its Ctil section — and packs the
// leaves on screen into a 4 x 4 raster (0x00452cb3..0x00452d7e: leaf (x, z) at
// bit 0x8000 >> (4 x + z)), which `snd_emit_draw_block` ands with the Prop's
// `world_cell_quad_mask` (`leafMask`, `emitterDrawn`). A sphere is tested
// against the view frustum (`inView`), not `draw_point_visible`'s fixed-point
// cone. The DCSQuads keep the renderer's frustum clipping.
//
// Pure arithmetic over a camera's world matrix; nothing allocates per frame.

/** A cell's side, metres (0x20000 world units). */
export const DRAW_CELL_M = 16;
/** The block's side in cells (DRAW_TILE_BLOCK_SIDE). */
export const DRAW_BLOCK_CELLS = 5;
/** The original's world origin in the Metropolis map frame, metres. */
export const WORLD_ORIGIN_X = 16;
export const WORLD_ORIGIN_Y = 0;

/** The block's first cell on each axis: z (the map's x) and x (the map's y). */
export interface DrawWindow {
  cellZ: number;
  cellX: number;
  /** False until a camera has placed it: then everything is drawn. */
  placed: boolean;
}

export function createDrawWindow(): DrawWindow {
  return { cellZ: 0, cellX: 0, placed: false };
}

/** The cell (along the map's x) of a map-frame x, metres. */
export function cellZOf(x: number): number {
  return Math.floor((x - WORLD_ORIGIN_X) / DRAW_CELL_M);
}
/** The cell (along the map's y) of a map-frame y, metres. */
export function cellXOf(y: number): number {
  return Math.floor((y - WORLD_ORIGIN_Y) / DRAW_CELL_M);
}

/**
 * `world_view_focus`: the block for a camera whose world matrix is `e` (three's
 * column-major elements; it looks along -column 2), over a player at `height`
 * m. A camera axis within 1/32768 of level leaves the block where it was
 * (retail divides by zero there). Answers whether the block moved.
 */
export function placeDrawWindow(win: DrawWindow, e: ArrayLike<number>, height: number): boolean {
  const px = e[12];
  const py = e[13];
  const pz = e[14];
  const fx = -e[8];
  const fy = -e[9];
  const fz = -e[10];
  if (Math.abs(fy) < 1 / 32768) return false;
  const plane = height < 0 ? height : 0;
  const r = (py - plane) / fy;
  // three's x is the map's x, its z the map's y.
  const z = cellZOf(px - fx * r) - 2;
  const x = cellXOf(pz - fz * r) - 2;
  if (win.placed && z === win.cellZ && x === win.cellX) return false;
  win.cellZ = z;
  win.cellX = x;
  win.placed = true;
  return true;
}

/** Whether the item hung in cell (z, x) is in the block (everything is, unplaced). */
export function inDrawWindow(win: DrawWindow, z: number, x: number): boolean {
  if (!win.placed) return true;
  return (
    z >= win.cellZ &&
    z < win.cellZ + DRAW_BLOCK_CELLS &&
    x >= win.cellX &&
    x < win.cellX + DRAW_BLOCK_CELLS
  );
}

/** A quadtree halfword, radius or height, is 16 world units (draw.c 0x00453070). */
const LEAF_UNIT_M = 16 / 8192;
/** The quadtree's steps: the cell's children 8 m, their leaves 4 m. */
const CHILD_M = 8;
const LEAF_M = 4;

/** One cell's visibility quadtree (gen:scenery `leafTrees`). */
export interface LeafTree {
  /** The cell: `z >> 17` (along the map's x) and `x >> 17` (along its y). */
  readonly cz: number;
  readonly cx: number;
  /**
   * (radius, height) halfwords: the cell's, its children 1..4's (`pair` n - 1:
   * child (x, z) halves at 2 x + z), then each child's four leaves' (pair 2 x + z).
   */
  readonly spheres: readonly number[];
}

/** Whether one quadtree sphere, centred (x, z) m into its cell, touches the view. */
function sphereInView(
  m: ArrayLike<number>,
  spheres: readonly number[],
  at: number,
  cz: number,
  cx: number,
  x: number,
  z: number,
): boolean {
  const r = spheres[at] * LEAF_UNIT_M;
  // `(h >> 4)` lifts by a sixteenth, then times 256 (draw.c 0x00452e5b).
  const h = ((spheres[at + 1] >> 4) * 256) / 8192;
  // The game's x is the map's y, its z the map's x less the origin's 16.
  return inView(
    m,
    WORLD_ORIGIN_X + cz * DRAW_CELL_M + z,
    h,
    WORLD_ORIGIN_Y + cx * DRAW_CELL_M + x,
    r,
  );
}

/**
 * The cell's leaves on screen (`world_build_tile_block`'s record word): leaf
 * (x, z) — 4 m quarters, x along the map's y, z along its x — at bit
 * 0x8000 >> (4 x + z) when the cell's sphere, its child's and its own all touch
 * the view of the camera whose projection-times-inverse-world is `m`.
 */
export function leafMask(m: ArrayLike<number>, tree: LeafTree): number {
  const s = tree.spheres;
  if (!sphereInView(m, s, 0, tree.cz, tree.cx, CHILD_M, CHILD_M)) return 0;
  let mask = 0;
  for (let child = 0; child < 4; child++) {
    const hx = child >> 1;
    const hz = child & 1;
    const cxm = hx * CHILD_M + LEAF_M;
    const czm = hz * CHILD_M + LEAF_M;
    if (!sphereInView(m, s, 2 + child * 2, tree.cz, tree.cx, cxm, czm)) continue;
    for (let leaf = 0; leaf < 4; leaf++) {
      const qx = hx * 2 + (leaf >> 1);
      const qz = hz * 2 + (leaf & 1);
      const at = 10 + child * 8 + leaf * 2;
      if (sphereInView(m, s, at, tree.cz, tree.cx, qx * LEAF_M + 2, qz * LEAF_M + 2)) {
        mask |= 0x8000 >> (4 * qx + qz);
      }
    }
  }
  return mask;
}

/** This frame's leaf masks, one per quadtree of the arena (0 outside the block). */
export interface LeafView {
  readonly masks: Uint16Array;
  /** False until a camera has set it: the block alone decides until then. */
  set: boolean;
}

export function createLeafView(trees: number): LeafView {
  return { masks: new Uint16Array(trees), set: false };
}

/** The masks of the quadtrees in the block, for the camera `m`. */
export function updateLeafView(
  view: LeafView,
  trees: readonly LeafTree[],
  win: DrawWindow,
  m: ArrayLike<number>,
): void {
  for (let t = 0; t < trees.length && t < view.masks.length; t++) {
    const tree = trees[t];
    view.masks[t] = inDrawWindow(win, tree.cz, tree.cx) ? leafMask(m, tree) : 0;
  }
  view.set = true;
}

/**
 * `snd_emit_draw_block`'s test for a Prop hung in cell (cz, cx) with quadtree
 * `leaf` (-1: a cell with no section, which retail skips) and footprint `quad`:
 * in the block, and its footprint meets a leaf on screen.
 */
export function emitterDrawn(
  win: DrawWindow,
  view: LeafView,
  cz: number,
  cx: number,
  leaf: number,
  quad: number,
): boolean {
  if (!win.placed) return true;
  if (!inDrawWindow(win, cz, cx)) return false;
  if (!view.set) return true;
  return leaf >= 0 && (view.masks[leaf] & quad) !== 0;
}

/**
 * Whether the sphere (x, y, z) three's frame, radius `r` m, touches the view of
 * a camera whose projection-times-inverse-world matrix is `m` (column-major):
 * the six clip planes, unnormalised, scaled by each plane's normal length.
 */
export function inView(m: ArrayLike<number>, x: number, y: number, z: number, r: number): boolean {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  // Plane k: w + s * c_k >= -r * |n|; |n| from the rows.
  for (let row = 0; row < 3; row++) {
    const c = row === 0 ? cx : row === 1 ? cy : cz;
    for (let sign = -1; sign <= 1; sign += 2) {
      const nx = m[3] + sign * m[row];
      const ny = m[7] + sign * m[row + 4];
      const nz = m[11] + sign * m[row + 8];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (cw + sign * c < -r * len) return false;
    }
  }
  return true;
}
