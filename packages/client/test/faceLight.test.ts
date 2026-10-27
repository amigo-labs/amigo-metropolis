// The original's face lighting on every model the client draws
// (render/fcopModel.ts; RE docs/formats/objects.md "Face lighting",
// fcop-fidelity.md G13): the one light, the shade, the colour each material
// makes of it, the materials a lit model gets, and the committed glbs carrying
// what the shade needs.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  FCOP_LIGHT,
  type FcopModel,
  faceMaterials,
  facePassOf,
  fcopLightFactor,
  fcopShadeByte,
  LIGHT_ATTRIBUTE,
  materialList,
} from "../src/render/fcopModel";

const MODELS = join(import.meta.dir, "..", "public", "models");

describe("the light", () => {
  test("is RE 0x0048b7a8's three 16.16 words, game (x, y, z) as three's (z, y, x)", () => {
    expect(FCOP_LIGHT.map((c) => c * 0x10000)).toEqual([0x37dd, 0xdf75, 0x6fba]);
    expect(Math.hypot(...FCOP_LIGHT)).toBeCloseTo(1, 5);
  });

  test("shines from above", () => {
    expect(FCOP_LIGHT[1]).toBeGreaterThan(0.87);
  });
});

describe("the shade (0x00427fb0, 0x00428000)", () => {
  test("turned away is the ambient 0x20, whatever the byte", () => {
    expect(fcopShadeByte(0x80, -1)).toBe(0x20);
    expect(fcopShadeByte(0xff, -4096)).toBe(0x20);
  });

  test("edge-on is 0x20, full light 0x20 + byte, capped at 0xff", () => {
    expect(fcopShadeByte(0x80, 0)).toBe(0x20);
    expect(fcopShadeByte(0x80, 4096)).toBe(0xa0);
    expect(fcopShadeByte(0x59, 2048)).toBe(0x20 + 44);
    expect(fcopShadeByte(0xff, 4096)).toBe(0xff);
  });
});

describe("a material's colour on the screen (0x00428c70, THRASH colour_of)", () => {
  const out: [number, number, number] = [0, 0, 0];

  test("0: the grey byte through the palette row, 0x80 unity", () => {
    expect(fcopLightFactor([0, 0x80, 0x80, 0x80], -4096, out)).toEqual([1, 1, 1]);
    // 0x40: row 16, grey 0x80 with its top bits 0b100 below.
    expect(fcopLightFactor([0, 0x40, 0, 0], 4096, out)[0]).toBe(0x84 / 0xff);
  });

  test("2: the grey shaded at the face's normal, then the palette row", () => {
    expect(fcopLightFactor([2, 0x80, 0x80, 0x80], 4096, out)).toEqual([1, 1, 1]);
    // Turned away: 0x20, row 8, grey 0x40 with its top bits 0b010 below.
    expect(fcopLightFactor([2, 0x80, 0x80, 0x80], -1, out)[0]).toBe(0x42 / 0xff);
  });

  test("4: the grey shaded per corner, doubled", () => {
    expect(fcopLightFactor([4, 0x80, 0, 0], 0, out)).toEqual([
      0x40 / 0xff,
      0x40 / 0xff,
      0x40 / 0xff,
    ]);
    expect(fcopLightFactor([4, 0x73, 0, 0], 4096, out)[0]).toBe(1);
  });

  test("3 and 5: a lit colour keeps r and g and loses its blue", () => {
    expect(fcopLightFactor([5, 127, 127, 127], 0, out)).toEqual([0x40 / 0xff, 0x40 / 0xff, 0]);
    expect(fcopLightFactor([3, 64, 64, 76], 4096, out)).toEqual([0xc0 / 0xff, 0xc0 / 0xff, 0]);
  });

  test("1: the colour unshaded, doubled, its blue kept", () => {
    expect(fcopLightFactor([1, 0x40, 0x80, 0x20], 4096, out)).toEqual([
      0x80 / 0xff,
      1,
      0x40 / 0xff,
    ]);
  });
});

/** A model of one opaque and one half group with the light attribute. */
function litModel(): FcopModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(24), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(24), 3));
  geometry.setAttribute(LIGHT_ATTRIBUTE, new THREE.BufferAttribute(new Uint8Array(32), 4));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 2]);
  const map = new THREE.Texture();
  return {
    geometry,
    map,
    groups: [
      { mode: "opaque", tint: null, map, start: 0, count: 6 },
      { mode: "half", tint: null, map, start: 6, count: 6 },
      { mode: "add", tint: [0x80, 0x80, 0x80], map, start: 12, count: 3 },
    ],
    extras: undefined,
  };
}

/** The shaders after a material's patches, from three's own chunk names. */
function patched(material: THREE.Material): { vertex: string; fragment: string } {
  const shader = {
    vertexShader:
      "#include <common>\nvoid main() {\n#include <uv_vertex>\n#include <begin_vertex>\n}",
    fragmentShader:
      "void main() {\n#include <map_fragment>\n#include <alphatest_fragment>\n#include <fog_fragment>\n}",
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader };
}

describe("a model that carries _FCOP_LIGHT", () => {
  const model = litModel();
  const list = materialList(faceMaterials(model));

  test("draws its opaque and half faces unlit by three, shaded by the original", () => {
    expect(list.map(facePassOf)).toEqual(["opaque", "half-solid", "half-blend", "add"]);
    for (const m of list.slice(0, 3)) {
      expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect((m as THREE.MeshBasicMaterial).vertexColors).toBe(false);
      expect(m.customProgramCacheKey()).toContain("fcopLight");
      expect(m.toneMapped).toBe(true);
      const { vertex, fragment } = patched(m);
      expect(vertex).toContain(`attribute vec4 ${LIGHT_ATTRIBUTE};`);
      expect(vertex).toContain("mat3( instanceMatrix ) * fcopNormal");
      expect(vertex).toContain("getMorph( gl_VertexID, i, 1 )");
      expect(vertex).toContain("#include <begin_vertex>");
      expect(fragment).toContain("sRGBTransferOETF( fcopTexel ).rgb * vFcopShade");
    }
    expect(patched(list[2]).fragment).toContain("if ( diffuseColor.a > 0.75 ) discard;");
  });

  test("the add faces are light, not lit", () => {
    expect(list[3].customProgramCacheKey()).not.toContain("fcopLight");
  });

  test("the weapons' unlit loader keeps them out of the tone mapping", () => {
    const unlit = materialList(faceMaterials(litModel(), { unlit: true }));
    expect(unlit[0].toneMapped).toBe(false);
    expect(unlit[0].customProgramCacheKey()).toContain("fcopLight");
  });

  test("without the attribute a loader's own lighting stays", () => {
    const plain = litModel();
    plain.geometry?.deleteAttribute(LIGHT_ATTRIBUTE);
    expect(materialList(faceMaterials(plain))[0]).toBeInstanceOf(THREE.MeshStandardMaterial);
  });
});

function glbs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...glbs(path));
    else if (name.endsWith(".glb")) out.push(path);
  }
  return out;
}

interface Gltf {
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      targets?: Record<string, number>[];
    }[];
  }[];
  accessors: { componentType: number; type: string; normalized?: boolean }[];
}

function gltfOf(path: string): Gltf {
  const data = readFileSync(path);
  const length = data.readUInt32LE(12);
  return JSON.parse(data.subarray(20, 20 + length).toString("utf8")) as Gltf;
}

describe("every FCOP model the client draws carries the light's inputs", () => {
  const files = ["units", "props", "fx", "pa-props"]
    .flatMap((d) => glbs(join(MODELS, d)))
    // The greybox fallbacks keep their raws from before the modes; the X1
    // itself (avatar-x1, gen:x1) carries the light since RE M3-OZ.
    .filter((f) => !/avatar-(walker|hover)/.test(f));

  test("the models are there", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  test("every face primitive has _FCOP_LIGHT as four unsigned bytes", () => {
    for (const file of files) {
      const gltf = gltfOf(file);
      for (const mesh of gltf.meshes ?? []) {
        for (const prim of mesh.primitives) {
          const index = prim.attributes._FCOP_LIGHT;
          expect({ file, index: index !== undefined }).toEqual({ file, index: true });
          const accessor = gltf.accessors[index];
          expect([accessor.componentType, accessor.type, accessor.normalized ?? false]).toEqual([
            5121,
            "VEC4",
            false,
          ]);
        }
      }
    }
  });

  test("a kept morph turns its normals with its frames", () => {
    let morphs = 0;
    for (const file of files) {
      for (const mesh of gltfOf(file).meshes ?? []) {
        for (const prim of mesh.primitives) {
          for (const target of prim.targets ?? []) {
            morphs++;
            expect({ file, keys: Object.keys(target).sort() }).toEqual({
              file,
              keys: ["NORMAL", "POSITION"],
            });
          }
        }
      }
    }
    expect(morphs).toBeGreaterThan(0);
  });
});
