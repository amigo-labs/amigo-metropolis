// Heightfield render mesh, built once at startup from the SAME MapData the
// sim samples (single source of truth, architecture.md §2). Init-time
// allocation is fine; nothing here runs in the frame loop.

import type { MapData } from "@metropolis/sim";
import * as THREE from "three";

const LOW_COLOR = new THREE.Color(0x1e3a46);
const HIGH_COLOR = new THREE.Color(0xc9b98f);

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
      c.copy(LOW_COLOR).lerp(HIGH_COLOR, (h - minH) * invRange);
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
