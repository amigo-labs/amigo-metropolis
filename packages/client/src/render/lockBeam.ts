// The lock beam (RE src/game/frame/draw.c `hud_draw_lock_beam`, 0x00435330):
// a line from the X1's partner model point 0 to the first terrain hit toward
// the locked target, drawn in the scene rather than over it.
//
// The original appends it to the display list like any primitive: op 0x3a (a
// line, op bit 3) with `flag_06` 2 and a sort key of the nearer end's camera
// depth, clamped up to 0x400 (2 m) -- `min(z0, z1)` then `max(.., 0x400)` at
// 0x004354cc..0x00435507, after `draw_clip_line` has moved both ends in front
// of the camera. The list is depth-sorted, far first (draw_list_submit.h), so
// whatever lies nearer than the beam's key is drawn over it and whatever lies
// farther under it. Op bit 3 with flag 2 is the walker's saturating add of the
// colour (fcop/draw_line.h: 0x00410bec, 0x00410bfc), the record's (0x20, 0, 0)
// -- (64, 0, 0) of 255 (RE hud.json `lock.beam.colour`). One pixel wide at
// 640 x 480.
//
// Here: one quad, expanded to the line's width in screen space in the vertex
// shader and drawn at the key's depth for its whole length, depth-tested, not
// written, added. Metropolis draws with a depth buffer, so "nearer than the
// key" is a per-pixel test instead of a per-primitive sort; among the other
// blended primitives three sorts it by the key's point, as the original's
// list does. The ends are clipped to the near plane on the CPU, as
// `draw_clip_line` clips them.
//
// Renderer rules: built once, `matrixAutoUpdate = false`; `set` writes uniforms
// and the sort point and allocates nothing.

import * as THREE from "three";
import { FX_OUTPUT } from "./fx/common";

/** `HUD_LOCK_BEAM_MIN_DEPTH` 0x400 camera units of 16 wu (`>> 4`, 0x004353de): 2 m. */
export const LOCK_BEAM_MIN_DEPTH_M = (0x400 * 16) / 8192;
/** The record's colour (0x20, 0, 0) as the hardware took it, 0..255 (hud.json). */
const BEAM_RGB = [64, 0, 0] as const;
/** The beam's width at 640 x 480, px. */
const BEAM_PX = 1;

const VERTEX = /* glsl */ `
attribute vec2 corner;
uniform vec3 uA;
uniform vec3 uB;
uniform float uKey;
uniform vec2 uViewport;
uniform float uWidth;
void main() {
  vec4 ca = projectionMatrix * vec4(uA, 1.0);
  vec4 cb = projectionMatrix * vec4(uB, 1.0);
  vec2 na = ca.xy / ca.w;
  vec2 nb = cb.xy / cb.w;
  vec2 d = (nb - na) * uViewport;
  float len = length(d);
  vec2 n = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0, 1.0);
  vec2 p = mix(na, nb, corner.x) + n * corner.y * uWidth / uViewport;
  vec4 ck = projectionMatrix * vec4(0.0, 0.0, -uKey, 1.0);
  gl_Position = vec4(p, ck.z / ck.w, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
void main() {
  gl_FragColor = vec4(uColour, 1.0);
  ${FX_OUTPUT}
}`;

export interface LockBeam {
  readonly mesh: THREE.Mesh;
  /**
   * Places the beam for `camera` (posed, its matrices current) from (ax, ah, ay)
   * to (bx, bh, by), three frame (x, height, sim y) metres, `scale` view px per
   * 640 x 480 px. `active` false hides it.
   */
  set(
    camera: THREE.PerspectiveCamera,
    active: boolean,
    ax: number,
    ah: number,
    ay: number,
    bx: number,
    bh: number,
    by: number,
    viewW: number,
    viewH: number,
    scale: number,
  ): void;
}

const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchKey = new THREE.Vector3();

export function createLockBeam(scene: THREE.Scene): LockBeam {
  const geometry = new THREE.BufferGeometry();
  // Three needs a position attribute; the shader places every corner itself.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute(
    "corner",
    new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2),
  );
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  const uniforms = {
    uA: { value: new THREE.Vector3() },
    uB: { value: new THREE.Vector3() },
    uKey: { value: LOCK_BEAM_MIN_DEPTH_M },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: 1 },
    uColour: {
      value: new THREE.Vector3(BEAM_RGB[0] / 255, BEAM_RGB[1] / 255, BEAM_RGB[2] / 255),
    },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.blending = THREE.AdditiveBlending;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  // Drawn among the effects (render/fx/common.ts prepareMesh), sorted by its key.
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene.add(mesh);

  return {
    mesh,
    set(camera, active, ax, ah, ay, bx, bh, by, viewW, viewH, scale) {
      if (!active) {
        mesh.visible = false;
        return;
      }
      // Camera space: three looks down -z, so depth is -z.
      const inv = camera.matrixWorldInverse;
      scratchA.set(ax, ah, ay).applyMatrix4(inv);
      scratchB.set(bx, bh, by).applyMatrix4(inv);
      // draw_clip_line: both ends in front of the near plane, or nothing.
      const near = -camera.near;
      const aIn = scratchA.z < near;
      const bIn = scratchB.z < near;
      if (!aIn && !bIn) {
        mesh.visible = false;
        return;
      }
      if (!aIn || !bIn) {
        const t = (near - scratchA.z) / (scratchB.z - scratchA.z);
        const cx = scratchA.x + (scratchB.x - scratchA.x) * t;
        const cy = scratchA.y + (scratchB.y - scratchA.y) * t;
        if (aIn) scratchB.set(cx, cy, near);
        else scratchA.set(cx, cy, near);
      }
      const key = Math.max(Math.min(-scratchA.z, -scratchB.z), LOCK_BEAM_MIN_DEPTH_M);
      uniforms.uA.value.copy(scratchA);
      uniforms.uB.value.copy(scratchB);
      uniforms.uKey.value = key;
      uniforms.uViewport.value.set(viewW, viewH);
      uniforms.uWidth.value = Math.max(1, BEAM_PX * scale);
      // The transparent sort's point: the key on the camera's axis, in the world.
      scratchKey.set(0, 0, -key).applyMatrix4(camera.matrixWorld);
      const e = mesh.matrix.elements;
      e[12] = scratchKey.x;
      e[13] = scratchKey.y;
      e[14] = scratchKey.z;
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
    },
  };
}
