// The type-97 DCSQuads (fcop-fidelity.md G13): decal quads the original keeps
// as pyro blocks that never expire (RE world/pyro_chain.c: `cact_load_type97`
// 0x004372d0 -> `pyro_spawn` 0x00437050 -> `pyro_place` 0x00436e20; drawn by
// world/pyro_draw.c 0x004373e0). On Slim, Joke and Hk every one is a soft
// cloud of the mission's own Cdcs rect, 2.8-6 m across, 1-2.5 m over the
// highest surface, added onto the frame in a dim grey: a haze. Where
// render/arenaScenery.generated.ts `quads` says, which gen:scenery reads out of
// the mission's records; the crops are the RE's (public/models/decals/<mapId>/,
// copied unchanged).
//
// - The corners are (-+halfX, 0, -+halfZ) in the quad's own frame, through
//   `math_matrix_from_angles(yaw, pitch, roll)` and the actors frame's swap
//   into three; the rect's (u, v) sits on corner (-x, +z), u running along +x
//   and v along -z, over w - 1 and h - 1 texels (the drawer's u + w - 1).
// - The driver's blend byte 2 (flag 0x10) is the additive pair; the colour is
//   vertex 0's r, g, b doubled (colour mode 0x30), modulating the texels. Blend
//   1 is the default pair, drawn opaque (a textured record's alpha is 0xff).
// - Without flag 0x01 the drawer culls a quad whose screen corners turn the
//   other way: one side only, the side its corners face up from.
//
// One InstancedMesh per decal image, an instance per quad, every matrix written
// at load: nothing moves, and the frame loop never touches them.
//
// - The drawer's depth (fcop-fidelity.md G13): the original sorts its display
//   list, far keys first, with no depth buffer (render/facers.ts has the
//   reading), and a quad's key is the mean of its centre's and its first three
//   corners' view depths less 0x100 -- the fourth corner's is never read
//   (`pyro_draw.c` 0x0043783d..0x00437864, PYRO_DRAW_DEPTH_BIAS; the corners
//   in `pyro_place`'s order (-x, +z) (+x, +z) (+x, -z) (-x, -z), 0x00436f91).
//   So the quad is drawn whole over what sorts farther -- the plates it hangs
//   over, whose keys are their own unbiased means -- and under what sorts
//   nearer. The vertex shader stands each corner where it projects and tests
//   it at that key (DECAL_KEY_PATCH): one depth for the whole quad, as the
//   sort has it, where a polygon offset stood in until then.
//
// Drawn only within the viewer's 5x5 block of cells (setDecalWindow).

import type { MapData } from "@metropolis/sim";
import * as THREE from "three";
import type { ArenaScenery, SceneryDecal, SceneryQuad } from "./arenaScenery.generated";
import { cellXOf, cellZOf, type DrawWindow, inDrawWindow } from "./drawWindow";
import { RECORD_TURN } from "./recordYaw";

/** The arena's quads as drawn: per mesh each instance's cell, drawn state and matrix. */
interface QuadMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly cellZ: Int16Array;
  readonly cellX: Int16Array;
  readonly shown: Uint8Array;
  readonly rest: Float32Array;
}
let quadMeshes: QuadMesh[] = [];
let lastWindow: DrawWindow | null = null;

/**
 * The viewer's block moved (render/drawWindow.ts): a DCSQuad is drawn only in
 * it (`pyro_draw_block` 0x00437310), elsewhere at a zero matrix. Writes only
 * what changed.
 */
export function setDecalWindow(win: DrawWindow): void {
  lastWindow = win;
  for (let m = 0; m < quadMeshes.length; m++) {
    const qm = quadMeshes[m];
    const a = qm.mesh.instanceMatrix.array as Float32Array;
    let dirty = false;
    for (let i = 0; i < qm.shown.length; i++) {
      const want = inDrawWindow(win, qm.cellZ[i], qm.cellX[i]) ? 1 : 0;
      if (want === qm.shown[i]) continue;
      qm.shown[i] = want;
      dirty = true;
      if (want === 0) a.fill(0, i * 16, i * 16 + 16);
      else a.set(qm.rest.subarray(i * 16, i * 16 + 16), i * 16);
    }
    if (dirty) qm.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** The arena's decal image for a Cdcs rect id. */
export function decalUrl(mapId: string, decal: SceneryDecal): string {
  return `/models/decals/${mapId}/${decal.file}`;
}

/** PYRO_DRAW_DEPTH_BIAS, 0x100 in the 512-a-metre view: half a metre. */
export const DECAL_DEPTH_BIAS = 0x100 / 512;

/**
 * The quad's sort key as its depth: the mean view depth of its centre and
 * corners (-x, +z), (+x, +z), (+x, -z) -- three's (1, 0, -1), (1, 0, 1),
 * (-1, 0, 1) in the unit quad (quadGeometry) -- less the bias, written into
 * every vertex's clip z so it projects where it did and tests at the key.
 */
export const DECAL_KEY_PATCH = `#include <project_vertex>
{
	mat4 dcsView = modelViewMatrix;
#ifdef USE_INSTANCING
	dcsView = modelViewMatrix * instanceMatrix;
#endif
	float dcsKey = -( ( dcsView * vec4( 0.0, 0.0, 0.0, 1.0 ) ).z
		+ ( dcsView * vec4( 1.0, 0.0, -1.0, 1.0 ) ).z
		+ ( dcsView * vec4( 1.0, 0.0, 1.0, 1.0 ) ).z
		+ ( dcsView * vec4( -1.0, 0.0, 1.0, 1.0 ) ).z ) / 4.0 - ${DECAL_DEPTH_BIAS.toFixed(6)};
	vec4 dcsClip = projectionMatrix * vec4( 0.0, 0.0, -dcsKey, 1.0 );
	gl_Position.z = dcsClip.z / dcsClip.w * gl_Position.w;
}`;

function rad(raw: number): number {
  return (raw * 2 * Math.PI) / RECORD_TURN;
}

/**
 * The quad's turn in three: `math_matrix_from_angles(yaw, pitch, roll)` = Mz Mx
 * My (row-vector) seen through the swap of x and z on both sides, S M^T S, a
 * rotation. Column-major 3x3 as a Matrix4's upper left.
 */
export function quadRotation(q: SceneryQuad, out: THREE.Matrix4): THREE.Matrix4 {
  const [a, b, g] = [rad(q.yaw), rad(q.pitch), rad(q.roll)];
  const y = [
    [Math.cos(a), 0, -Math.sin(a)],
    [0, 1, 0],
    [Math.sin(a), 0, Math.cos(a)],
  ];
  const x = [
    [1, 0, 0],
    [0, Math.cos(b), Math.sin(b)],
    [0, -Math.sin(b), Math.cos(b)],
  ];
  const z = [
    [Math.cos(g), Math.sin(g), 0],
    [-Math.sin(g), Math.cos(g), 0],
    [0, 0, 1],
  ];
  const mul = (p: number[][], r: number[][]) =>
    [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => p[i][0] * r[0][j] + p[i][1] * r[1][j] + p[i][2] * r[2][j]),
    );
  const m = mul(mul(z, x), y);
  // three = S M^T S t: element (i, j) of S M^T S is M[2-j][2-i] (S reverses).
  const e = (i: number, j: number) => m[2 - j][2 - i];
  return out.set(
    e(0, 0),
    e(0, 1),
    e(0, 2),
    0,
    e(1, 0),
    e(1, 1),
    e(1, 2),
    0,
    e(2, 0),
    e(2, 1),
    e(2, 2),
    0,
    0,
    0,
    0,
    1,
  );
}

/** The quad's instance matrix: centre, turn, and its half extents (three's x is its z). */
export function quadMatrix(q: SceneryQuad, out: THREE.Matrix4): THREE.Matrix4 {
  quadRotation(q, out);
  out.multiply(new THREE.Matrix4().makeScale(q.halfZ, 1, q.halfX));
  out.setPosition(q.x, q.h, q.y);
  return out;
}

/**
 * The unit quad of a decal, in three's frame of the quad: the game's local
 * (x, z) is three's (z, x). Its corners carry the rect's texels, wound to face
 * +y (up).
 */
export function quadGeometry(decal: SceneryDecal): THREE.BufferGeometry {
  // Corners A (-x, +z), B (+x, +z), C (+x, -z), D (-x, -z) of the quad's own
  // frame, at three's (z, 0, x).
  const pos = new Float32Array([1, 0, -1, 1, 0, 1, -1, 0, 1, -1, 0, -1]);
  const u1 = (decal.w - 1) / decal.w;
  const v1 = 1 / decal.h;
  // Texture rows run down from the image's top (flipY): v = 1 is the rect's v.
  const uv = new Float32Array([0, 1, u1, 1, u1, v1, 0, v1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
  );
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

const textureLoader = new THREE.TextureLoader();

/** The arena's DCSQuads, an InstancedMesh per decal image as it arrives. */
export function loadDecals(
  map: MapData,
  scenery: ArenaScenery,
  group: THREE.Object3D,
  cancelled?: () => boolean,
): void {
  quadMeshes = [];
  const byDecal = new Map<string, SceneryQuad[]>();
  for (const q of scenery.quads) {
    // One mesh per image and blend: the blend is the material's.
    const key = `${q.decal}/${q.blend}/${q.twoSided}`;
    const list = byDecal.get(key);
    if (list) list.push(q);
    else byDecal.set(key, [q]);
  }
  for (const quads of byDecal.values()) {
    const first = quads[0];
    const decal = scenery.decals[first.decal];
    if (!decal) continue;
    const url = decalUrl(map.id, decal);
    textureLoader.loadAsync(url).then(
      (texture) => {
        if (cancelled?.()) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        const additive = first.blend === 2;
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: additive,
          depthWrite: !additive,
          blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
          side: first.twoSided ? THREE.DoubleSide : THREE.FrontSide,
          toneMapped: false,
        });
        // The drawer's sort key as the quad's one depth (DECAL_KEY_PATCH).
        material.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader.replace(
            "#include <project_vertex>",
            DECAL_KEY_PATCH,
          );
        };
        material.customProgramCacheKey = () => "dcsKey";
        const mesh = new THREE.InstancedMesh(quadGeometry(decal), material, quads.length);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        const m = new THREE.Matrix4();
        const c = new THREE.Color();
        quads.forEach((q, i) => {
          mesh.setMatrixAt(i, quadMatrix(q, m));
          mesh.setColorAt(
            i,
            c.setRGB(q.tint[0] / 255, q.tint[1] / 255, q.tint[2] / 255, THREE.SRGBColorSpace),
          );
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        group.add(mesh);
        // A quad hangs in the cell of its centre (`pyro_place`).
        quadMeshes.push({
          mesh,
          cellZ: Int16Array.from(quads, (q) => cellZOf(q.x)),
          cellX: Int16Array.from(quads, (q) => cellXOf(q.y)),
          shown: new Uint8Array(quads.length).fill(1),
          rest: Float32Array.from(mesh.instanceMatrix.array),
        });
        if (lastWindow) setDecalWindow(lastWindow);
      },
      () => {
        console.warn(`[decals] no decal image at ${url}, skipping`);
      },
    );
  }
}
