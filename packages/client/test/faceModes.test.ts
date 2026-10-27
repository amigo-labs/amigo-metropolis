// The original's face draw modes on every model the client draws
// (render/fcopModel.ts; RE docs/formats/objects.md "Face draw modes"): what
// each mode's materials blend, test and write, read off the materials the
// loaders build — for a synthetic model of all three, and for every committed
// glb's groups as its materials name them.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  addTint,
  type FaceGroup,
  type FcopModel,
  faceMaterials,
  facePassOf,
  materialList,
} from "../src/render/fcopModel";
import { patchTeamUv } from "../src/render/teamUv";

const MODELS = join(import.meta.dir, "..", "public", "models");

/** A model of `groups`, two triangles each, on one map. */
function model(groups: Omit<FaceGroup, "start" | "count" | "map">[]): FcopModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(groups.length * 12), 3),
  );
  geometry.setIndex(Array.from({ length: groups.length * 6 }, (_, i) => i % 4));
  const map = new THREE.Texture();
  return {
    geometry,
    map,
    groups: groups.map((g, i) => ({ ...g, map, start: i * 6, count: 6 })),
    extras: undefined,
  };
}

/** A fragment shader with the chunks the patches replace. */
function patched(material: THREE.Material): string {
  const shader = {
    vertexShader: "#include <common>\n#include <uv_vertex>",
    fragmentShader:
      "#include <map_fragment>\n#include <alphatest_fragment>\n#include <fog_fragment>",
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader.fragmentShader;
}

describe("a face's draw mode is its material's", () => {
  const m = model([
    { mode: "opaque", tint: null },
    { mode: "half", tint: null },
    { mode: "add", tint: [0x80, 0x59, 0xff] },
  ]);
  const list = materialList(faceMaterials(m));
  const geometry = m.geometry as THREE.BufferGeometry;

  test("one material per pass, the half group drawn twice over its own triangles", () => {
    expect(list.map(facePassOf)).toEqual(["opaque", "half-solid", "half-blend", "add"]);
    expect(geometry.groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([
      [0, 6, 0],
      [6, 6, 1],
      [6, 6, 2],
      [12, 6, 3],
    ]);
  });

  test("opaque: the key cut at 0.25, bit-15 texels solid, no blending", () => {
    const opaque = list[0];
    expect(opaque.alphaTest).toBe(0.25);
    expect(opaque.transparent).toBe(false);
    expect(opaque.blending).toBe(THREE.NormalBlending);
    expect(opaque.depthWrite).toBe(true);
  });

  test("half: alpha 255 solid with the opaque faces, alpha 128 blended 50/50 behind no depth", () => {
    const [, solid, blend] = list;
    // 128 / 255 is under 0.75: only the 255 texels pass the solid pass.
    expect(solid.alphaTest).toBe(0.75);
    expect(solid.transparent).toBe(false);
    expect(solid.depthWrite).toBe(true);
    // The blended pass: SRC_ALPHA / ONE_MINUS_SRC_ALPHA on the 0.5 texels only.
    expect(blend.transparent).toBe(true);
    expect(blend.blending).toBe(THREE.NormalBlending);
    expect(blend.premultipliedAlpha).toBe(false);
    expect(blend.alphaTest).toBe(0.25);
    expect(blend.depthWrite).toBe(false);
    expect(blend.depthTest).toBe(true);
    expect(patched(blend)).toContain("if ( diffuseColor.a > 0.75 ) discard;");
  });

  test("add: ONE / ONE, never three's AdditiveBlending, the tint doubled, no depth write", () => {
    const add = list[3] as THREE.MeshBasicMaterial;
    expect(add.blending).toBe(THREE.CustomBlending);
    expect(add.blending).not.toBe(THREE.AdditiveBlending);
    expect(add.blendSrc).toBe(THREE.OneFactor);
    expect(add.blendDst).toBe(THREE.OneFactor);
    expect(add.blendEquation).toBe(THREE.AddEquation);
    expect(add.depthWrite).toBe(false);
    expect(add.transparent).toBe(true);
    expect(add.toneMapped).toBe(false);
    // The texture's alpha is ignored: nothing is tested or discarded on it.
    expect(add.alphaTest).toBe(0);
    // tint x 2 / 255, 0x80 unity, unclamped.
    expect(add.color.r).toBeCloseTo(1.0039, 3);
    expect(add.color.g).toBeCloseTo((0x59 * 2) / 255, 6);
    expect(add.color.b).toBeCloseTo(2, 6);
    const fragment = patched(add);
    expect(fragment).toContain("sRGBTransferOETF( fcopTexel ).rgb * fcopTint");
    expect(fragment).toContain("vec3 fcopTint = diffuse;");
    expect(fragment).toContain("diffuseColor.a = 1.0;");
    expect(fragment).toContain("gl_FragColor.rgb *= 1.0 - fcopFog;");
  });

  test("a model of opaque faces alone keeps one material and no groups", () => {
    const one = model([{ mode: "opaque", tint: null }]);
    const material = faceMaterials(one);
    expect(Array.isArray(material)).toBe(false);
    expect(one.geometry?.groups.length).toBe(0);
  });

  test("the team offset chains onto a mode's patch", () => {
    const m2 = model([{ mode: "add", tint: [0x80, 0x80, 0x80] }]);
    const material = materialList(faceMaterials(m2, { patch: patchTeamUv }))[0];
    expect(material.customProgramCacheKey()).toBe("fcopAdd+teamUv");
    const shader = {
      vertexShader: "#include <common>\n#include <uv_vertex>",
      fragmentShader: "#include <map_fragment>\n#include <fog_fragment>",
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("vMapUv += instanceTeamUv * teamUvMask;");
    expect(shader.fragmentShader).toContain("fcopTexel");
  });

  test("the tint is the THRASH walk's doubling", () => {
    const c = addTint([0x80, 0x00, 0xff], new THREE.Color());
    expect([c.r, c.g, c.b]).toEqual([256 / 255, 0, 510 / 255]);
  });
});

/** Every committed FCOP glb: gen:units' outputs and the RE's pickup and lift packs. */
function glbs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...glbs(path));
    else if (name.endsWith(".glb")) out.push(path);
  }
  return out;
}

interface GltfJson {
  materials?: { extras?: { fcop?: { mode?: string; tint?: number[] } } }[];
  meshes?: { primitives: { material?: number }[] }[];
}

function json(path: string): GltfJson {
  const b = readFileSync(path);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8")) as GltfJson;
}

describe("every committed model's add faces blend ONE / ONE", () => {
  const files = ["units", "props", "fx", "pa-props"].flatMap((d) => glbs(join(MODELS, d)));

  test("the models are there, and some add", () => {
    expect(files.length).toBeGreaterThan(200);
    const adding = files.filter((f) =>
      (json(f).materials ?? []).some((m) => m.extras?.fcop?.mode === "add"),
    );
    expect(adding.length).toBeGreaterThan(20);
  });

  test("each group's materials are its mode's, and no add face is AdditiveBlending", () => {
    for (const file of files) {
      const gltf = json(file);
      const groups = (gltf.meshes ?? []).flatMap((mesh) =>
        mesh.primitives.map((p) => {
          const fcop = gltf.materials?.[p.material ?? -1]?.extras?.fcop ?? {};
          const mode = fcop.mode === "add" || fcop.mode === "half" ? fcop.mode : "opaque";
          return { mode, tint: mode === "add" ? (fcop.tint ?? null) : null } as const;
        }),
      );
      if (groups.length === 0) continue;
      const materials = materialList(faceMaterials(model(groups)));
      for (const material of materials) {
        const pass = facePassOf(material);
        const want = { file, pass, additive: false, oneOne: pass === "add" };
        expect({
          file,
          pass,
          additive: material.blending === THREE.AdditiveBlending,
          oneOne:
            material.blending === THREE.CustomBlending &&
            material.blendSrc === THREE.OneFactor &&
            material.blendDst === THREE.OneFactor,
        }).toEqual(want);
      }
      expect(materials.filter((m) => facePassOf(m) === "add").length).toBe(
        groups.filter((g) => g.mode === "add").length,
      );
    }
  });
});
