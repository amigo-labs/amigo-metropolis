// Steps, not walls: opens the wall bits that stand for a kerb, or for nothing
// (fcop-fidelity.md P15). Authoring-time only, part of stage 2 (enrichArena.ts).
//
// THE PROBLEM
// The RE extractor (tools/gfx/til_mesh.py) turns EVERY near-vertical polygon of
// the original's terrain into a wall on the edges of the tile it lies in,
// whatever its height. The original's mech does not collide with polygons: its
// walker asks for the ground from 0.4 m above its feet and steps onto a rise of
// up to about 0.46 m in one step (RE camera-and-movement.md "Step-up"); the
// hover climbs more. So a 0.2 m step between two floors — a kerb, a stair, the
// rim of a ramp — is something the original walks over and Metropolis' lattice
// walls off. On Slim and Joke that sealed the spawn's lift landing from the
// ramp that leads down to the base: the mech rode the lift up and stood on a
// deck it could not leave.
//
// THE RULE
// A wall bit on a lattice (the ground's or a deck's) stands only where the
// original's mesh has a face along it: it is opened when the original's own
// floors on its two sides, read off the committed terrain .glb (the original's
// mesh, as til_mesh.py wrote it), are at most KERB_STEP apart and no polygon
// along the edge stands more than KERB_CLEARANCE above the higher of the two.
// That takes two kinds of bit:
// - a kerb: a face no taller than a step between two floors;
// - a spill: the extractor marks a face on BOTH edges of the tile it lies in,
//   so the edge a tile away from the face carries a wall with nothing on it.
// Each side takes the floor nearest the surface the lattice describes there
// (or the floor a walker from the other side meets), so a deck's kerb is
// measured on the deck and not on the road beneath it. A fence or a building
// face along the edge, and a step taller than KERB_STEP, stay walls.
//
// It is deterministic and a function of committed inputs (the .glb, the map's
// heights and decks, the wall snapshot), like the rest of stage 2.

import { readFileSync } from "node:fs";
import {
  KERB_CLEARANCE,
  KERB_STEP,
  type MapData,
  sampleHeight,
  sampleLayerHeight,
} from "@metropolis/sim";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface GltfJson {
  meshes?: { primitives: { attributes: { POSITION?: number }; indices?: number }[] }[];
  accessors?: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews?: { byteOffset?: number; byteStride?: number }[];
}

/**
 * The triangles of a terrain .glb in the sim's frame: 9 numbers each, three
 * (x, height, y) corners, with `x = glb.x + dx`, `y = glb.z + dz` (MAP_ALIGN).
 */
export function readGlbTriangles(path: string, dx: number, dz: number): Float64Array {
  const file = readFileSync(path);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error(`${path}: not a .glb`);
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  for (let at = 12; at + 8 <= view.getUint32(8, true); ) {
    const length = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const body = file.subarray(at + 8, at + 8 + length);
    if (kind === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (kind === CHUNK_BIN) bin = body;
    at += 8 + length;
  }
  if (!json || !bin) throw new Error(`${path}: missing JSON or BIN chunk`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const accessors = json.accessors ?? [];
  const views = json.bufferViews ?? [];
  const read = (index: number, comps: number): number[] => {
    const a = accessors[index];
    const bv = views[a.bufferView];
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const size =
      a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1;
    const stride = bv.byteStride ?? size * comps;
    const out: number[] = [];
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * size;
        if (a.componentType === 5126) out.push(dv.getFloat32(o, true));
        else if (a.componentType === 5125) out.push(dv.getUint32(o, true));
        else if (a.componentType === 5123) out.push(dv.getUint16(o, true));
        else out.push(dv.getUint8(o));
      }
    }
    return out;
  };
  const tris: number[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (prim.attributes.POSITION === undefined) continue;
      const pos = read(prim.attributes.POSITION, 3);
      const idx =
        prim.indices !== undefined ? read(prim.indices, 1) : [...Array(pos.length / 3).keys()];
      for (let t = 0; t + 2 < idx.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const v = idx[t + k] * 3;
          tris.push(pos[v] + dx, pos[v + 1], pos[v + 2] + dz);
        }
      }
    }
  }
  return Float64Array.from(tris);
}

/** A lattice as editable rows: v[row][line], h[line][col] (MapJson layout). */
export interface Lattice {
  v: string[][];
  h: string[][];
}

/**
 * The original's terrain mesh indexed by cell: its floors (near-horizontal
 * triangles) and its faces (the rest), each listed in every cell its box
 * touches, one cell of margin.
 */
export class TerrainMesh {
  private readonly floors = new Map<number, number[]>();
  private readonly faces = new Map<number, number[]>();

  constructor(
    private readonly tris: Float64Array,
    private readonly size: number,
  ) {
    const n = tris.length / 9;
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const ux = tris[o + 3] - tris[o];
      const uy = tris[o + 4] - tris[o + 1];
      const uz = tris[o + 5] - tris[o + 2];
      const vx = tris[o + 6] - tris[o];
      const vy = tris[o + 7] - tris[o + 1];
      const vz = tris[o + 8] - tris[o + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len === 0) continue;
      const xs = [tris[o], tris[o + 3], tris[o + 6]];
      const ys = [tris[o + 2], tris[o + 5], tris[o + 8]];
      const target = Math.abs(ny) / len >= 0.5 ? this.floors : this.faces;
      for (let i = Math.floor(Math.min(...xs)) - 1; i <= Math.floor(Math.max(...xs)) + 1; i++) {
        for (let j = Math.floor(Math.min(...ys)) - 1; j <= Math.floor(Math.max(...ys)) + 1; j++) {
          if (i < 0 || j < 0 || i >= size || j >= size) continue;
          const k = j * size + i;
          const list = target.get(k);
          if (list) list.push(t);
          else target.set(k, [t]);
        }
      }
    }
  }

  /** The original's floor heights at (x, y). */
  floorsAt(x: number, y: number): number[] {
    const tris = this.tris;
    const out: number[] = [];
    for (const t of this.floors.get(Math.floor(y) * this.size + Math.floor(x)) ?? []) {
      const o = t * 9;
      const [ax, ah, ay, bx, bh, by, cx, ch, cy] = tris.subarray(o, o + 9);
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push(l1 * ah + l2 * bh + l3 * ch);
    }
    return out;
  }

  /** The original's floor at (x, y) nearest `ref`, undefined where it has none. */
  floorNear(x: number, y: number, ref: number): number | undefined {
    let best: number | undefined;
    for (const h of this.floorsAt(x, y)) {
      if (best === undefined || Math.abs(h - ref) < Math.abs(best - ref)) best = h;
    }
    return best;
  }

  /**
   * Does a face within half a tile of the segment (x0..x1, y0..y1) stand above
   * `limit`? Half a tile: the extractor puts a face on both edges of its tile,
   * so a face anywhere in either tile beside an edge may be that edge's.
   */
  tall(x0: number, x1: number, y0: number, y1: number, limit: number): boolean {
    const tris = this.tris;
    const m = 0.5;
    for (let i = Math.floor(x0) - 1; i <= Math.floor(x1) + 1; i++) {
      for (let j = Math.floor(y0) - 1; j <= Math.floor(y1) + 1; j++) {
        if (i < 0 || j < 0 || i >= this.size || j >= this.size) continue;
        for (const t of this.faces.get(j * this.size + i) ?? []) {
          const o = t * 9;
          const fx0 = Math.min(tris[o], tris[o + 3], tris[o + 6]);
          const fx1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
          const fy0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]);
          const fy1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
          if (fx1 < x0 - m || fx0 > x1 + m || fy1 < y0 - m || fy0 > y1 + m) continue;
          if (Math.max(tris[o + 1], tris[o + 4], tris[o + 7]) > limit) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Opens every kerb bit (see the header) in `lattices` (index 0 the ground's,
 * L deck L's) in place, and returns how many it opened.
 */
export function openKerbs(map: MapData, mesh: TerrainMesh, lattices: Lattice[]): number {
  const size = map.size;
  const floorsAt = (x: number, y: number): number[] => mesh.floorsAt(x, y);
  const tall = (x0: number, x1: number, y0: number, y1: number, limit: number): boolean =>
    mesh.tall(x0, x1, y0, y1, limit);
  /** The surface lattice `layer` describes at (x, y), undefined off its deck. */
  const surface = (layer: number, x: number, y: number): number | undefined => {
    if (layer === 0) return sampleHeight(map, x, y);
    if (map.layerMask[layer - 1][Math.floor(y) * size + Math.floor(x)] === 0) return undefined;
    return sampleLayerHeight(map, layer - 1, x, y);
  };
  const nearest = (hs: number[], ref: number): number | undefined => {
    let best: number | undefined;
    for (const h of hs)
      if (best === undefined || Math.abs(h - ref) < Math.abs(best - ref)) best = h;
    return best;
  };
  /** One pairing of floors across the edge: a step a walker takes either way? */
  const step = (ha: number | undefined, hb: number | undefined, seg: number[]): boolean => {
    if (ha === undefined || hb === undefined) return false;
    const rise = Math.abs(ha - hb);
    if (rise > KERB_STEP) return false;
    return !tall(seg[0], seg[1], seg[2], seg[3], Math.max(ha, hb) + KERB_CLEARANCE);
  };
  const isKerb = (
    layer: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    seg: number[],
  ): boolean => {
    const ra = surface(layer, ax, ay);
    const rb = surface(layer, bx, by);
    const fa = floorsAt(ax, ay);
    const fb = floorsAt(bx, by);
    // The floor the lattice describes on each side, and the floor across the
    // edge that a walker on it meets — a ramp that runs up onto a deck is a
    // kerb on the ground's lattice too, though the ground beneath that deck lies
    // far below the ramp.
    if (ra !== undefined) {
      const ha = nearest(fa, ra);
      if (ha !== undefined && step(ha, nearest(fb, rb ?? ha), seg)) return true;
      if (ha !== undefined && rb !== undefined && step(ha, nearest(fb, ha), seg)) return true;
    }
    if (rb !== undefined) {
      const hb = nearest(fb, rb);
      if (hb !== undefined && step(nearest(fa, ra ?? hb), hb, seg)) return true;
      if (hb !== undefined && ra !== undefined && step(nearest(fa, hb), hb, seg)) return true;
    }
    return false;
  };

  let opened = 0;
  // Each side is read a quarter metre off the edge: on the floor that meets it,
  // not across the next cell.
  const q = 0.25;
  for (let layer = 0; layer < lattices.length; layer++) {
    const { v, h } = lattices[layer];
    for (let row = 0; row < size; row++) {
      for (let line = 1; line < size; line++) {
        if (v[row][line] !== "1") continue;
        if (isKerb(layer, line - q, row + 0.5, line + q, row + 0.5, [line, line, row, row + 1])) {
          v[row][line] = "0";
          opened++;
        }
      }
    }
    for (let line = 1; line < size; line++) {
      for (let col = 0; col < size; col++) {
        if (h[line][col] !== "1") continue;
        if (isKerb(layer, col + 0.5, line - q, col + 0.5, line + q, [col, col + 1, line, line])) {
          h[line][col] = "0";
          opened++;
        }
      }
    }
  }
  return opened;
}
