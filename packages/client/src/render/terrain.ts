// Heightfield render mesh, built once at startup from the SAME MapData the
// sim samples (single source of truth, architecture.md §2). Init-time
// allocation is fine; nothing here runs in the frame loop.

import { type MapData, worldExtent } from "@metropolis/sim";
import * as THREE from "three";
import { TERRAIN_HEX } from "./palette";

// Terrain colors come from the shared game palette (assets.md §3).
const LOW_COLOR = new THREE.Color(TERRAIN_HEX.low);
const HIGH_COLOR = new THREE.Color(TERRAIN_HEX.high);
const RIVERBED_COLOR = new THREE.Color(TERRAIN_HEX.riverbed);
// Tier-1 wall slabs: a darkened terrain tone so they read as solid blockers.
const WALL_COLOR = new THREE.Color(TERRAIN_HEX.high).multiplyScalar(0.55);
/** Greybox wall slab height above the local terrain (meters). */
const WALL_RENDER_HEIGHT = 2.5;

/** Translucent plane at the water surface so the river reads as water. */
export function buildWaterPlane(map: MapData): THREE.Mesh {
  const extent = worldExtent(map);
  const geometry = new THREE.PlaneGeometry(extent, extent);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(extent / 2, map.waterLevel, extent / 2);
  const material = new THREE.MeshStandardMaterial({
    color: TERRAIN_HEX.water,
    transparent: true,
    opacity: 0.55,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/**
 * Tier-1 wall render: one vertical quad per edge-blocker segment, built from
 * the SAME wallsV/wallsH arrays the collision reads — render and physics can
 * never drift apart. Returns null for wall-free maps (district-01, test-128).
 */
export function buildWallMesh(map: MapData): THREE.Mesh | null {
  if (map.wallsV.length === 0 && map.wallsH.length === 0) return null;
  const s = map.size;
  const cell = map.cellSize;
  let count = 0;
  for (let k = 0; k < map.wallsV.length; k++) if (map.wallsV[k] === 1) count++;
  for (let k = 0; k < map.wallsH.length; k++) if (map.wallsH[k] === 1) count++;
  if (count === 0) return null;

  const positions = new Float32Array(count * 4 * 3);
  const indices = new Uint32Array(count * 6);
  let v = 0; // vertex cursor
  let n = 0; // index cursor
  const hAt = (i: number, j: number): number => map.heights[j * s + i];

  // Emits one vertical quad from (x0,z0) to (x1,z1); the slab bottom sinks
  // slightly below the lower end so terrain steps never open a gap.
  const quad = (x0: number, z0: number, x1: number, z1: number, hA: number, hB: number): void => {
    const bottom = Math.min(hA, hB) - 0.25;
    const top = Math.max(hA, hB) + WALL_RENDER_HEIGHT;
    const base = v / 3;
    positions[v++] = x0;
    positions[v++] = bottom;
    positions[v++] = z0;
    positions[v++] = x1;
    positions[v++] = bottom;
    positions[v++] = z1;
    positions[v++] = x0;
    positions[v++] = top;
    positions[v++] = z0;
    positions[v++] = x1;
    positions[v++] = top;
    positions[v++] = z1;
    indices[n++] = base;
    indices[n++] = base + 1;
    indices[n++] = base + 2;
    indices[n++] = base + 1;
    indices[n++] = base + 3;
    indices[n++] = base + 2;
  };

  for (let j = 0; j < s - 1; j++) {
    for (let i = 0; i < s; i++) {
      if (map.wallsV[j * s + i] === 1) {
        // Vertical segment on line x = i, spanning cell row j (sim y → three z).
        quad(i * cell, j * cell, i * cell, (j + 1) * cell, hAt(i, j), hAt(i, j + 1));
      }
    }
  }
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s - 1; i++) {
      if (map.wallsH[j * s + i] === 1) {
        // Horizontal segment on line y = j, spanning cell column i.
        quad(i * cell, j * cell, (i + 1) * cell, j * cell, hAt(i, j), hAt(i + 1, j));
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: WALL_COLOR,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

export function buildTerrainMesh(map: MapData): THREE.Mesh {
  const s = map.size;
  const positions = new Float32Array(s * s * 3);
  const colors = new Float32Array(s * s * 3);

  let minH = Infinity;
  let maxH = -Infinity;
  for (let k = 0; k < map.heights.length; k++) {
    const h = map.heights[k];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const invRange = maxH > minH ? 1 / (maxH - minH) : 0;

  const c = new THREE.Color();
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const k = j * s + i;
      const h = map.heights[k];
      positions[k * 3] = i * map.cellSize; // sim x → three x
      positions[k * 3 + 1] = h; //             sim height → three y
      positions[k * 3 + 2] = j * map.cellSize; // sim y → three z
      if (map.waterMask[k] === 1) {
        c.copy(RIVERBED_COLOR);
      } else {
        c.copy(LOW_COLOR).lerp(HIGH_COLOR, (h - minH) * invRange);
      }
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;
    }
  }

  const quads = (s - 1) * (s - 1);
  const indices = new Uint32Array(quads * 6);
  let n = 0;
  for (let j = 0; j < s - 1; j++) {
    for (let i = 0; i < s - 1; i++) {
      const a = j * s + i;
      const b = a + 1;
      const d = a + s;
      const e = d + 1;
      // Diagonal split must match the sim's bilinear patch closely enough for
      // greybox; exact triangle choice is render-only and hash-irrelevant.
      indices[n++] = a;
      indices[n++] = d;
      indices[n++] = b;
      indices[n++] = b;
      indices[n++] = d;
      indices[n++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
