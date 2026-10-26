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
// These are the Glide and software readings, which agree; the D3D driver
// does not (RE M3-OO): its pages are ARGB4444 with alpha 8/15 on bit 15 under
// a standing SRC_ALPHA / INV_SRC_ALPHA, so it blends bit-15 texels at 53 % on
// opaque faces too, and Glide keys a PX16 word of exactly 0x8000. Kept: half
// on half faces, solid on opaque ones, 0x8000 a drawn black (G13). Its adds
// are (ONE, ONE) as here, with the tint doubled as here.
//
// The lighting (RE docs/formats/objects.md "Face lighting", fcop-fidelity.md
// G13). The same op0 bits are the face's lighting material, which
// `cact_model_shade_face` (0x00428c70) turns into the vertex colour: 0 a grey
// (3DTL byte 1), 1 a colour (bytes 1..3), 2 / 3 those shaded at the face's
// first normal, 4 / 5 at each corner's own. The shade (0x00427fb0, 0x00428000)
// is the normal against ONE light, fixed in the world for every mission (RE
// 0x0048b7a8): 0x20 when turned away, else 0x20 + cos x byte, capped at 0xff;
// a lit colour loses its blue (0x00428000 answers byte 3 zero). On the screen
// 0x80 is unity and the colour multiplies the texel (THRASH `colour_of`
// 0x004568b2: grey and r, g, b doubled and clamped; a grey on a textured face
// through the palette row, `(grey >> 2) << 3`). Every RE glb carries the
// inputs per corner: `_FCOP_LIGHT` (material, bytes 1..3) and the NORMAL the
// corner is lit against. So an opaque or half face of a model that has them
// draws unlit by three's lights (MeshBasicMaterial) with the original's shade:
// `fcopLightPatch` computes it per vertex — interpolated over a smooth face,
// constant over a flat one — and takes the product in display values, as the
// `add` faces do. The normal goes through the instance's 3x3 unnormalised,
// as the engine's transpose does (a Prop's scaled rows scale its shade), and
// a morph's frame through its own normals. A model without the attribute
// keeps the loader's lighting: lit, or unlit for the weapons.
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

/** The geometry attribute GLTFLoader makes of the RE glbs' `_FCOP_LIGHT`. */
export const LIGHT_ATTRIBUTE = "_fcop_light";

/**
 * The original's one light, the three 16.16 words at RE 0x0048b7a8 (0x6fba,
 * 0xdf75, 0x37dd), which are the game's (x, y, z): `draw_light_prepare`
 * (0x00426eb0) puts them through the camera and the model draw back through
 * the placement's transpose (0x00458770), so the light is fixed in the world.
 * Three's axes are the game's (z, y, x) (render/recordYaw.ts: sim x = game z,
 * sim y = game x, three (x, h, y)), so this is (0x37dd, 0xdf75, 0x6fba) /
 * 0x10000: from above, the +x and +z side.
 */
export const FCOP_LIGHT: readonly [number, number, number] = [
  0x37dd / 0x10000,
  0xdf75 / 0x10000,
  0x6fba / 0x10000,
];

/**
 * One byte through `cact_model_shade_grey` / `_rgb` (0x00427fb0, 0x00428000):
 * `cos` is the dot in 4.12 (`dot >> 16`, floored); turned away is 0x20, else
 * `(cos * byte >> 12) + 0x20`, capped at 0xff.
 */
export function fcopShadeByte(byte: number, cos: number): number {
  if (cos < 0) return 0x20;
  return Math.min(Math.floor((cos * byte) / 4096) + 0x20, 0xff);
}

/**
 * The display factor, 0..1 per channel, a corner's texel is multiplied by:
 * its `_FCOP_LIGHT` (material, bytes 1..3) and its cosine in 4.12 through
 * `cact_model_shade_face`'s undamaged table (0x0042900c), then THRASH's
 * `colour_of`: the grey materials 0 and 2 (colour mode 0x20, every shipped one
 * textured) through the palette row `(grey >> 2) << 3`, capped, its low bits
 * from its top three (0x004568ec..0x00456936); 4 doubled (0x00456a17); the
 * colours doubled per channel (0x00456a49), a lit one's blue zero. The mirror
 * of `fcopLightPatch`'s GLSL, for the tests.
 */
export function fcopLightFactor(
  light: readonly number[],
  cos: number,
  out: [number, number, number],
): [number, number, number] {
  const [material, b1, b2, b3] = light;
  const doubled = (c: number) => Math.min(2 * c, 0xff) / 0xff;
  if (material === 0 || material === 2) {
    const grey = material === 2 ? fcopShadeByte(b1, cos) : b1;
    let level = Math.min((grey >> 2) << 3, 0xff);
    level |= (level >> 5) & 7;
    out[0] = out[1] = out[2] = level / 0xff;
  } else if (material === 4) {
    out[0] = out[1] = out[2] = doubled(fcopShadeByte(b1, cos));
  } else if (material === 3 || material === 5) {
    out[0] = doubled(fcopShadeByte(b1, cos));
    out[1] = doubled(fcopShadeByte(b2, cos));
    out[2] = 0;
  } else if (material === 1 || material === 6) {
    out[0] = doubled(b1);
    out[1] = doubled(b2);
    out[2] = doubled(b3);
  } else {
    // Material 7 has no arm (`ja` at 0x00428e32); none is shipped.
    out[0] = out[1] = out[2] = 1;
  }
  return out;
}

const LIGHT_VERTEX_DECL = `attribute vec4 ${LIGHT_ATTRIBUTE};
varying vec3 vFcopShade;
const vec3 FCOP_LIGHT = vec3( ${FCOP_LIGHT.map((c) => c.toFixed(10)).join(", ")} );
float fcopShadeByte( float c, float cosine ) {
	return cosine < 0.0 ? 32.0 : min( floor( cosine * c / 4096.0 ) + 32.0, 255.0 );
}
float fcopDoubled( float c ) {
	return min( 2.0 * c, 255.0 ) / 255.0;
}
void main() {`;

const LIGHT_VERTEX = `vec3 fcopNormal = vec3( normal );
#if defined( USE_MORPHNORMALS ) && defined( USE_MORPHTARGETS )
	fcopNormal *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) fcopNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
	}
#endif
#ifdef USE_INSTANCING
	fcopNormal = mat3( instanceMatrix ) * fcopNormal;
#endif
	fcopNormal = mat3( modelMatrix ) * fcopNormal;
	float fcopCos = floor( dot( fcopNormal, FCOP_LIGHT ) * 4096.0 );
	float fcopMaterial = ${LIGHT_ATTRIBUTE}.x;
	vec3 fcopBytes = ${LIGHT_ATTRIBUTE}.yzw;
	if ( fcopMaterial < 0.5 || ( fcopMaterial > 1.5 && fcopMaterial < 2.5 ) ) {
		float grey = fcopMaterial > 1.5 ? fcopShadeByte( fcopBytes.x, fcopCos ) : fcopBytes.x;
		float level = min( floor( grey / 4.0 ) * 8.0, 255.0 );
		level += level < 255.0 ? mod( floor( level / 32.0 ), 8.0 ) : 0.0;
		vFcopShade = vec3( level / 255.0 );
	} else if ( fcopMaterial > 3.5 && fcopMaterial < 4.5 ) {
		vFcopShade = vec3( fcopDoubled( fcopShadeByte( fcopBytes.x, fcopCos ) ) );
	} else if ( ( fcopMaterial > 2.5 && fcopMaterial < 3.5 ) || ( fcopMaterial > 4.5 && fcopMaterial < 5.5 ) ) {
		vFcopShade = vec3( fcopDoubled( fcopShadeByte( fcopBytes.x, fcopCos ) ), fcopDoubled( fcopShadeByte( fcopBytes.y, fcopCos ) ), 0.0 );
	} else if ( fcopMaterial < 6.5 ) {
		vFcopShade = vec3( fcopDoubled( fcopBytes.x ), fcopDoubled( fcopBytes.y ), fcopDoubled( fcopBytes.z ) );
	} else {
		vFcopShade = vec3( 1.0 );
	}
#include <begin_vertex>`;

const LIGHT_FRAGMENT_DECL = `varying vec3 vFcopShade;
void main() {`;

/** The texel times the shade, in display values, handed on as linear light. */
const LIGHT_MAP = `#ifdef USE_MAP
	vec4 fcopTexel = texture2D( map, vMapUv );
	diffuseColor *= vec4( sRGBTransferEOTF( vec4( sRGBTransferOETF( fcopTexel ).rgb * vFcopShade, 1.0 ) ).rgb, fcopTexel.a );
#else
	diffuseColor.rgb *= sRGBTransferEOTF( vec4( vFcopShade, 1.0 ) ).rgb;
#endif`;

/**
 * The original's lighting on an opaque or half face material (see the head of
 * this file): the shade per vertex out of `_fcop_light`, the normal and the
 * fixed light, multiplied into the texel in display values.
 */
export function fcopLightPatch(material: THREE.Material): void {
  chainPatch(material, "fcopLight", (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", LIGHT_VERTEX_DECL)
      .replace("#include <begin_vertex>", LIGHT_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", LIGHT_FRAGMENT_DECL)
      .replace("#include <map_fragment>", LIGHT_MAP);
  });
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
  // The original's lighting where the glb carries its inputs; its COLOR_0 is
  // then only gen:units' white fill or the RE's stand-in grey of an untextured
  // face, whose colour the light attribute holds.
  const lit = geometry.hasAttribute(LIGHT_ATTRIBUTE);
  const vertexColors = !lit && geometry.hasAttribute("color");
  const solid = (map: THREE.Texture | null): THREE.Material => {
    if (!lit) return solidMaterial(map, vertexColors, options.unlit === true);
    const m = new THREE.MeshBasicMaterial({ map, toneMapped: options.unlit !== true });
    fcopLightPatch(m);
    return m;
  };
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
      const m = solid(g.map);
      m.alphaTest = 0.25;
      geometry.addGroup(g.start, g.count, add(m, "opaque"));
    } else if (g.mode === "half") {
      const solidTexels = solid(g.map);
      // Alpha 255 only: the key (0) and the bit-15 texels (128) are the other pass's.
      solidTexels.alphaTest = 0.75;
      geometry.addGroup(g.start, g.count, add(solidTexels, "half-solid"));
      const blend = solid(g.map);
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
