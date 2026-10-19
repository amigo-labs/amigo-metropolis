// The original's face draw modes on a loaded model (RE docs/formats/objects.md
// "Face draw modes"; fcop-fidelity.md G13). Every FCOP glb this client draws —
// gen:units' units, scenery, Props and weapons, and the RE's pickup and lift
// packs — keys its faces by the mode `cact_model_shade_face` (0x00428c70)
// gives them, one glTF primitive (and material, `extras.fcop`) per key:
//
// - `opaque`: alpha cut at 0.25, so the key texel (word 0, alpha 0) is a hole
//   and a bit-15 texel (alpha 128) is as solid as any other — Glide's constant
//   alpha 0xff (arm 0x00439e8f) and `grChromakeyValue(0)` (0x0043a58b).
// - `half`: op bit 3. Glide sets the constant alpha 0x80 and alpha = texture
//   alpha x 0x80 + 0x80 (0x00439a43..0x00439a53, arm 0x00439e97) under
//   SRC_ALPHA / ONE_MINUS_SRC_ALPHA (arm 0x00439edb); the ARGB1555 upload
//   clears the alpha bit exactly on bit-15 texels (0x00415700). So those
//   texels average with the frame buffer and the rest are opaque. Drawn in two
//   passes over the same triangles: the opaque texels (alpha 255) with the
//   opaque faces, writing depth; the bit-15 texels (alpha 128) blended 50/50 in
//   the transparent pass, testing depth but not writing it, so a half texel
//   never hides what is drawn behind it after it, and the solid parts of the
//   same face sort as solid parts do. The key is cut in both.
// - `add`: material 6, `grAlphaBlendFunction(ONE, ONE, ONE, ZERO)` (arm
//   0x00439ee5): dst + texel x tint x 2 / 255, the texture's alpha ignored.
//   Not three's AdditiveBlending, which is SRC_ALPHA / ONE and would halve the
//   90 % of these texels that carry bit 15: CustomBlending ONE / ONE, the
//   destination's alpha kept. The product is taken in the original's own
//   (display) values — the texel's sRGB bytes times the doubled tint, as the
//   hardware did — and handed on as linear light (render/fx/common.ts
//   FX_OUTPUT does the same for the effects). Unlit and not tone-mapped: it
//   is light. No depth write, and fog fades it to nothing rather than to the
//   fog's colour, which an additive face would otherwise add.
//
// The lighting materials 0..5 are not exported (the RE draws the texture
// unlit), so opaque and half faces keep the material each loader gave them
// before: lit for units and scenery, unlit for the weapons.
//
// Init-time only: nothing here runs in the frame loop.

import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type FaceMode = "opaque" | "half" | "add";

/** One draw mode's faces: an index range of the merged geometry. */
export interface FaceGroup {
  readonly mode: FaceMode;
  /** An `add` face's raw 3DTL bytes, 0x80 unity; null otherwise. */
  readonly tint: readonly number[] | null;
  /** The page or atlas its faces sample (gen:units: one atlas for all). */
  readonly map: THREE.Texture | null;
  readonly start: number;
  readonly count: number;
}

/** A loaded model: its faces merged in model space, a group per draw mode. */
export interface FcopModel {
  /** Null for a model of facers only (render/facers.ts draws those). */
  readonly geometry: THREE.BufferGeometry | null;
  readonly groups: readonly FaceGroup[];
  /** The texture its faces and facers sample: the first group's, or the glb's first. */
  readonly map: THREE.Texture | null;
  /** The root node's extras: the facers' records (render/facers.ts parseFacers). */
  readonly extras: unknown;
}

interface FcopExtras {
  mode?: string;
  tint?: number[];
}

function modeOf(material: THREE.Material): { mode: FaceMode; tint: readonly number[] | null } {
  const fcop = (material.userData as { fcop?: FcopExtras }).fcop ?? {};
  if (fcop.mode === "add") return { mode: "add", tint: fcop.tint ?? [0x80, 0x80, 0x80] };
  if (fcop.mode === "half") return { mode: "half", tint: null };
  return { mode: "opaque", tint: null };
}

/**
 * Merges every mesh of `gltf` (its node transforms baked) into one geometry
 * with a group per primitive, in the file's order — gen:units writes opaque,
 * half, then add by tint — and disposes the loader's materials (their maps
 * survive). A model with no faces (facers only) still brings the glb's
 * texture 0, the atlas its facers sample.
 */
export async function mergeFcopModel(gltf: GLTF): Promise<FcopModel> {
  const extras = (gltf.parser.json as { nodes?: { extras?: unknown }[] }).nodes?.[0]?.extras;
  gltf.scene.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  const keys: { mode: FaceMode; tint: readonly number[] | null; map: THREE.Texture | null }[] = [];
  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (list.length !== 1) throw new Error("a glTF primitive with several materials");
    const material = list[0];
    const geometry = mesh.geometry.clone();
    // gen:units writes the one node with the identity matrix, which is what
    // keeps a morph's deltas (applyMatrix4 leaves them alone) right.
    geometry.applyMatrix4(mesh.matrixWorld);
    geometries.push(geometry);
    const std = material as THREE.MeshStandardMaterial;
    keys.push({ ...modeOf(material), map: std.map ?? null });
    material.dispose(); // material only — the kept map texture survives
  });
  if (geometries.length === 0) {
    // No material names the atlas, so the glb lists it as an image alone.
    const parser = gltf.parser as unknown as {
      json: { images?: unknown[] };
      textureLoader: THREE.Loader;
      loadImageSource(index: number, loader: THREE.Loader): Promise<THREE.Texture>;
    };
    const map =
      (parser.json.images?.length ?? 0) > 0
        ? await parser.loadImageSource(0, parser.textureLoader)
        : null;
    // As GLTFLoader sets a texture's: glTF's (u, v) are not flipped. Left raw
    // (no colour space): render/facers.ts reads its bytes as they are.
    if (map) {
      map.flipY = false;
      map.needsUpdate = true;
    }
    return { geometry: null, groups: [], map, extras };
  }
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, true);
  if (!merged) throw new Error("unmergeable model");
  const count = (g: THREE.BufferGeometry) =>
    g.index ? g.index.count : (g.getAttribute("position")?.count ?? 0);
  let start = 0;
  const groups = keys.map((k, i) => {
    const n = count(geometries[i]);
    const group: FaceGroup = { ...k, start, count: n };
    start += n;
    return group;
  });
  return { geometry: merged, groups, map: keys[0].map, extras };
}

/** How a loader draws the faces it does not blend: lit, or unlit (the weapons). */
export interface FaceMaterialOptions {
  readonly unlit?: boolean;
  /** Applied to every material made (the team offset: render/teamUv.ts). */
  readonly patch?: (material: THREE.Material) => void;
}

/** A material's draw-mode pass, for the tests and the patches below. */
export type FacePass = "opaque" | "half-solid" | "half-blend" | "add";

/** The pass a material made by `faceMaterials` draws. */
export function facePassOf(material: THREE.Material): FacePass | null {
  return (material.userData as { facePass?: FacePass }).facePass ?? null;
}

/**
 * The materials of `model`'s groups, and the geometry's groups rewritten to
 * them: one material a group, two for a half group (its solid and its blended
 * texels, the same triangles twice). A model of one opaque group keeps a single
 * material and no groups, as every model had before the modes.
 */
export function faceMaterials(
  model: FcopModel,
  options: FaceMaterialOptions = {},
): THREE.Material | THREE.Material[] {
  const geometry = model.geometry;
  if (!geometry) throw new Error("a model of facers only has no faces to draw");
  const vertexColors = geometry.hasAttribute("color");
  const materials: THREE.Material[] = [];
  const add = (material: THREE.Material, pass: FacePass): number => {
    material.userData.facePass = pass;
    options.patch?.(material);
    materials.push(material);
    return materials.length - 1;
  };
  geometry.clearGroups();
  for (const g of model.groups) {
    if (g.mode === "opaque") {
      const m = solidMaterial(g.map, vertexColors, options.unlit === true);
      m.alphaTest = 0.25;
      geometry.addGroup(g.start, g.count, add(m, "opaque"));
    } else if (g.mode === "half") {
      const solid = solidMaterial(g.map, vertexColors, options.unlit === true);
      // Alpha 255 only: the key (0) and the bit-15 texels (128) are the other pass's.
      solid.alphaTest = 0.75;
      geometry.addGroup(g.start, g.count, add(solid, "half-solid"));
      const blend = solidMaterial(g.map, vertexColors, options.unlit === true);
      blend.alphaTest = 0.25;
      blend.transparent = true;
      blend.blending = THREE.NormalBlending;
      blend.depthWrite = false;
      halfBlendPatch(blend);
      geometry.addGroup(g.start, g.count, add(blend, "half-blend"));
    } else {
      geometry.addGroup(g.start, g.count, add(addMaterial(g.map, g.tint), "add"));
    }
  }
  if (materials.length === 1 && model.groups.length === 1) {
    geometry.clearGroups();
    return materials[0];
  }
  return materials;
}

function solidMaterial(
  map: THREE.Texture | null,
  vertexColors: boolean,
  unlit: boolean,
): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial {
  return unlit
    ? new THREE.MeshBasicMaterial({ map, vertexColors, toneMapped: false })
    : new THREE.MeshStandardMaterial({ map, vertexColors, flatShading: true });
}

/**
 * Chains a shader patch onto whatever patch `material` already has (the
 * team offset, the X1's pose), and keys the program by both.
 */
export function chainPatch(
  material: THREE.Material,
  key: string,
  patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void,
): void {
  const before = material.onBeforeCompile;
  const keys = [...((material.userData.patchKeys as string[] | undefined) ?? []), key];
  material.userData.patchKeys = keys;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    patch(shader);
  };
  const programKey = keys.join("+");
  material.customProgramCacheKey = () => programKey;
}

/** The bit-15 pass of a half face: the solid texels are the other pass's. */
function halfBlendPatch(material: THREE.Material): void {
  chainPatch(material, "fcopHalf", (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <alphatest_fragment>",
      "#include <alphatest_fragment>\n\tif ( diffuseColor.a > 0.75 ) discard;",
    );
  });
}

/**
 * The doubled tint of an `add` face, 0x80 unity, unclamped: what the THRASH
 * walk draws (`rgb_doubled` 0x00456a49; a byte above 0x80 overflows into a
 * second pass of the clamped excess, 0x00456c9c, which sums to the same).
 */
export function addTint(tint: readonly number[], out: THREE.Color): THREE.Color {
  return out.setRGB((tint[0] * 2) / 255, (tint[1] * 2) / 255, (tint[2] * 2) / 255);
}

function addMaterial(map: THREE.Texture | null, tint: readonly number[] | null): THREE.Material {
  const material = new THREE.MeshBasicMaterial({
    map,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
  });
  // Raw multipliers, set without colour management: the patch below takes the
  // product in display values.
  addTint(tint ?? [0x80, 0x80, 0x80], material.color);
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  chainPatch(material, "fcopAdd", (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
	vec4 fcopTexel = texture2D( map, vMapUv );
	diffuseColor.rgb = sRGBTransferEOTF( vec4( sRGBTransferOETF( fcopTexel ).rgb * diffuse, 1.0 ) ).rgb;
#else
	diffuseColor.rgb = sRGBTransferEOTF( vec4( diffuse, 1.0 ) ).rgb;
#endif
	diffuseColor.a = 1.0;`,
      )
      .replace(
        "#include <fog_fragment>",
        `#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fcopFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fcopFog = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb *= 1.0 - fcopFog;
#endif`,
      );
  });
  return material;
}

/** Every material of a mesh's `material`, single or an array. */
export function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

/** The map a mesh's faces sample: its first material's. */
export function materialMap(material: THREE.Material | THREE.Material[]): THREE.Texture | null {
  return (materialList(material)[0] as THREE.MeshBasicMaterial | undefined)?.map ?? null;
}
