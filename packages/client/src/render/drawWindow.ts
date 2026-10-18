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
// 16 m. The block's per-cell visibility mask (the quadtree's 4 m leaves on
// screen) is the frustum's business here: the renderer clips what is off it,
// and the sound's claim tests the item against the frustum (`inView`).
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
