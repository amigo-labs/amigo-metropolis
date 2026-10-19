// Team colour the way the original does it (fcop-fidelity.md G4): not a tint.
// Every unit page holds the art twice, one half per side, and each actor
// carries a texture offset onto its own half. Record payload +30/+31 become
// instance +0x92/+0x93 (RE `base.c` 197-198); the draw sets
// `draw_set_uv_offset(+0x92, +0x93)` around the model (`base.c` 336-349) and
// the face readers add `u | v << 8` to every corner's packed texel coordinate
// (RE `fcop/draw_uv.h`). No unit's offset carries u into v or wraps v (RE
// pa_models.json `per_model.*.carry_u` / `wrap_v`), so in glTF texcoords it is
// a plain (+du / 256, +dv / 256) on the page — and, on gen:units' atlas of
// side-by-side 256-texel pages, (+du / atlasWidth, +dv / atlasHeight).
//
// Here that is one per-instance vec2 (`instanceTeamUv`, atlas units) added to
// the map UV in the vertex shader, times a per-vertex 0/1 mask (`teamUvMask`)
// for the X1, whose beacon lights keep their texels (RE `player_partner.c`
// 285-320). Everything else takes the offset on every face. Written per slot
// only when the slot's side changes; nothing here allocates per frame.

import * as THREE from "three";
import { chainPatch } from "./fcopModel";

/** Per-instance offset in atlas UV units. */
export const TEAM_UV_ATTR = "instanceTeamUv";
/** Per-vertex 0/1: which faces take the offset. gen:units writes `_TEAMUV`. */
export const TEAM_UV_MASK = "teamUvMask";
/** The name GLTFLoader gives a custom `_TEAMUV` attribute (lowercased). */
const GLTF_MASK = "_teamuv";

const VERTEX_DECL = `#include <common>
attribute vec2 ${TEAM_UV_ATTR};
attribute float ${TEAM_UV_MASK};`;
const VERTEX_UV = `#include <uv_vertex>
#ifdef USE_MAP
	vMapUv += ${TEAM_UV_ATTR} * ${TEAM_UV_MASK};
#endif`;

/**
 * Adds the per-instance offset to a unit material's map lookup, after any
 * patch the material already has (a draw mode's, render/fcopModel.ts).
 */
export function patchTeamUv(material: THREE.Material): void {
  chainPatch(material, "teamUv", (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", VERTEX_DECL)
      .replace("#include <uv_vertex>", VERTEX_UV);
  });
}

/**
 * Gives a loaded unit geometry its mask: the generator's `_TEAMUV` where the
 * model has one (the X1), else every vertex. Load-time only.
 */
export function prepareTeamUvMask(geometry: THREE.BufferGeometry): void {
  const authored = geometry.getAttribute(GLTF_MASK);
  if (authored) {
    geometry.setAttribute(TEAM_UV_MASK, authored);
    geometry.deleteAttribute(GLTF_MASK);
    return;
  }
  const count = geometry.getAttribute("position")?.count ?? 0;
  geometry.setAttribute(
    TEAM_UV_MASK,
    new THREE.BufferAttribute(new Float32Array(count).fill(1), 1),
  );
}

/** One per InstancedMesh: the slot's offset, zero until written. */
export function createTeamUvAttribute(capacity: number): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  attr.setUsage(THREE.DynamicDrawUsage);
  return attr;
}

/**
 * The offset in atlas units for one texel offset on `map`'s pages. The atlas
 * is 256-texel pages side by side, so a texel is 1 / width across and
 * 1 / height down whichever page the face samples.
 */
export function atlasOffset(
  map: THREE.Texture | null,
  du: number,
  dv: number,
  out: Float32Array,
  at: number,
): void {
  const image = map?.image as { width?: number; height?: number } | undefined;
  const w = image?.width ?? 256;
  const h = image?.height ?? 256;
  out[at] = du / w;
  out[at + 1] = dv / h;
}

/** Writes slot's offset into the mesh's per-instance attribute. */
export function writeTeamUv(mesh: THREE.InstancedMesh, slot: number, du: number, dv: number): void {
  const attr = mesh.geometry.getAttribute(TEAM_UV_ATTR) as
    | THREE.InstancedBufferAttribute
    | undefined;
  if (!attr) return;
  const a = attr.array as Float32Array;
  a[slot * 2] = du;
  a[slot * 2 + 1] = dv;
  attr.needsUpdate = true;
}
