// The models' camera-facing facers (render/facers.ts; RE docs/formats/objects.md
// "Facers", `cobj_prim_emit` 0x00428690, `draw_disc_fan` 0x004271c0): the
// geometry each arm builds against the camera, what the glb's records parse
// into, the batches' blends, and the committed facer-only Props.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  billboardCorners,
  drawFacers,
  FACER_LINE,
  FACER_NEAR,
  FACER_STAR,
  facerMaterial,
  facerSourceCount,
  initFacers,
  lineCorners,
  onSortPlane,
  parseFacers,
  rampByte,
  rampColour,
  registerFacers,
  sortFarToNear,
  starWedges,
  viewDepth,
} from "../src/render/facers";
import { FxView } from "../src/render/fx/common";
import { createGreyboxMeshes } from "../src/render/greybox";

const PROPS = join(import.meta.dir, "..", "public", "models", "props");

/** A camera at `pos` looking at `at`, and its view. */
function viewOf(pos: THREE.Vector3, at: THREE.Vector3): { camera: THREE.Camera; view: FxView } {
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
  camera.position.copy(pos);
  camera.lookAt(at);
  camera.updateMatrixWorld(true);
  const view = new FxView();
  view.set(camera, 480);
  return { camera, view };
}

const corner = (out: Float32Array, k: number) =>
  new THREE.Vector3(out[k * 3], out[k * 3 + 1], out[k * 3 + 2]);

/** A corner on the screen: normalized device coordinates. */
function ndc(camera: THREE.Camera, p: THREE.Vector3): THREE.Vector3 {
  return p.clone().project(camera);
}

describe("a billboard faces the camera", () => {
  const { camera, view } = viewOf(new THREE.Vector3(3, 4, 9), new THREE.Vector3(0.5, 1, -1));
  const out = new Float32Array(12);
  billboardCorners(view, 0.5, 1, -1, 0.2, 0.2, out);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  test("its corners lie in the view plane through its point, a square of the half-size", () => {
    const c = new THREE.Vector3(0.5, 1, -1);
    for (let k = 0; k < 4; k++) {
      const d = corner(out, k).sub(c);
      // In the plane facing the camera: no component along the view axis.
      expect(Math.abs(d.dot(dir))).toBeLessThan(1e-6);
      // Each corner is half-size off along the right and the up.
      expect(Math.abs(Math.abs(d.dot(view.right)) - 0.2)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(d.dot(view.up)) - 0.2)).toBeLessThan(1e-6);
    }
    expect(viewDepth(view, out[0], out[1], out[2])).toBeCloseTo(viewDepth(view, 0.5, 1, -1), 6);
  });

  test("corners 0..3 are top-left, top-right, bottom-right, bottom-left on the screen", () => {
    const s = [0, 1, 2, 3].map((k) => ndc(camera, corner(out, k)));
    expect(s[0].x).toBeLessThan(s[1].x);
    expect(s[0].y).toBeGreaterThan(s[3].y);
    expect(s[2].x).toBeGreaterThan(s[3].x);
    expect(s[1].y).toBeGreaterThan(s[2].y);
    // An axis-aligned square on the screen.
    expect(s[0].y).toBeCloseTo(s[1].y, 6);
    expect(s[0].x).toBeCloseTo(s[3].x, 6);
  });
});

describe("a line is a ribbon locked to its segment, turned to the camera", () => {
  const { camera, view } = viewOf(new THREE.Vector3(6, 3, 5), new THREE.Vector3(0, 1, 0));
  const from = new THREE.Vector3(0, 0, 0);
  const to = new THREE.Vector3(0.2, 2, -0.4);
  const out = new Float32Array(12);
  lineCorners(view, from.x, from.y, from.z, to.x, to.y, to.z, 0.13, 0.05, out);

  test("each end's corners sit its own half-width off it, either side, in the view plane", () => {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const off0 = corner(out, 0).sub(from);
    const off1 = corner(out, 1).sub(from);
    const off3 = corner(out, 3).sub(to);
    const off2 = corner(out, 2).sub(to);
    expect(off0.length()).toBeCloseTo(0.13, 6);
    expect(off3.length()).toBeCloseTo(0.05, 6);
    expect(off0.clone().add(off1).length()).toBeLessThan(1e-6);
    expect(off3.clone().add(off2).length()).toBeLessThan(1e-6);
    expect(Math.abs(off0.dot(dir))).toBeLessThan(1e-6);
    expect(Math.abs(off3.dot(dir))).toBeLessThan(1e-6);
  });

  test("the offset is square to the segment on the screen, corner 0 counter-clockwise of it", () => {
    const a = ndc(camera, from);
    const b = ndc(camera, to);
    const c0 = ndc(camera, corner(out, 0));
    const seg = new THREE.Vector2(b.x - a.x, b.y - a.y);
    const off = new THREE.Vector2(c0.x - a.x, c0.y - a.y);
    // NDC x and y scale differently (aspect 4 / 3): compare in pixels.
    seg.x *= 4 / 3;
    off.x *= 4 / 3;
    expect(Math.abs(seg.clone().normalize().dot(off.clone().normalize()))).toBeLessThan(1e-4);
    // Turned 90 degrees counter-clockwise, screen y up: cross(seg, off) > 0.
    expect(seg.x * off.y - seg.y * off.x).toBeGreaterThan(0);
  });

  test("a segment seen end-on takes the camera's right", () => {
    const e = viewOf(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 0, 0));
    lineCorners(e.view, 0, 2, 0, 0, 1, 0, 0.1, 0.1, out);
    const off = corner(out, 0).sub(new THREE.Vector3(0, 2, 0));
    expect(Math.abs(off.dot(e.view.up))).toBeCloseTo(0.1, 6);
  });
});

describe("a star's wedges follow its size on the 480-line screen", () => {
  const { view } = viewOf(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, 0));
  test("rounded down to fours, at least 4, at most the cap", () => {
    const at = (px: number) => (px * 10) / view.focal480;
    expect(starWedges(view, at(2), 10, 12)).toBe(4);
    expect(starWedges(view, at(9.9), 10, 12)).toBe(8);
    expect(starWedges(view, at(40), 10, 12)).toBe(12);
    expect(starWedges(view, at(40), 10, 4)).toBe(4);
  });
});

describe("the records parse as the glb writes them", () => {
  const extras = {
    fcop: {
      frames: 2,
      facers: [
        {
          kind: "line",
          mode: "add",
          from: [
            [1, 2, 3],
            [1, 3, 3],
          ],
          to: [
            [1, 0, 3],
            [1, 0, 3],
          ],
          half: [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
          rgb: [0x80, 0x40, 0xff],
          uv: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          texture: 0,
        },
        {
          kind: "star",
          mode: "add",
          at: [[0, 1, 0]],
          radius: [1.2],
          centre_rgb: [128, 106, 56],
          rim_rgb: [0, 0, 0],
          wedge_cap: 8,
          texture: null,
        },
      ],
    },
  };
  const set = parseFacers(extras, true);
  test("frames, ends turned onto the buckets' +x, lengths kept", () => {
    expect(set?.frames).toBe(2);
    const line = set?.facers[0];
    expect(line?.kind).toBe(FACER_LINE);
    // (x, y, z) -> (z, y, -x): the bake every unit and weapon bucket gives its geometry.
    expect(Array.from(line?.a ?? [])).toEqual([3, 2, -1, 3, 3, -1]);
    expect(Array.from(line?.h ?? []).map((v) => Math.round(v * 10) / 10)).toEqual([
      0.1, 0.2, 0.3, 0.4,
    ]);
  });
  test("an add facer's colour is its bytes doubled, a star's centre and rim too", () => {
    const line = set?.facers[0];
    expect(Array.from(line?.colour ?? []).map((v) => Math.round(v * 255))).toEqual([256, 128, 510]);
    const star = set?.facers[1];
    expect(star?.kind).toBe(FACER_STAR);
    expect(star?.uv).toBeNull();
    // Frame 1 of a one-frame list is its frame 0.
    expect(Array.from(star?.h ?? [])).toEqual([
      1.2000000476837158, 1.2000000476837158, 1.2000000476837158, 1.2000000476837158,
    ]);
    expect(Array.from(star?.colour ?? []).map((v) => Math.round(v * 255))).toEqual([256, 212, 112]);
  });
});

describe("the batches blend as the faces do", () => {
  test("add and the stars ONE / ONE, never AdditiveBlending; half 50/50 without depth writes", () => {
    for (const pass of [0, 3]) {
      const m = facerMaterial(pass, new THREE.Texture());
      expect(m.blending).toBe(THREE.CustomBlending);
      expect(m.blending).not.toBe(THREE.AdditiveBlending);
      expect([m.blendSrc, m.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
      expect(m.depthWrite).toBe(false);
    }
    const half = facerMaterial(1, new THREE.Texture());
    expect(half.blending).toBe(THREE.NormalBlending);
    expect(half.depthWrite).toBe(false);
    expect(half.fragmentShader).toContain("if (t.a < 0.25) discard;");
    const opaque = facerMaterial(2, new THREE.Texture());
    expect(opaque.transparent).toBe(false);
    expect(opaque.depthWrite).toBe(true);
  });
});

describe("the batches are rebuilt from the instances every frame", () => {
  const scene = new THREE.Scene();
  initFacers(scene);
  const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 3);
  scene.add(mesh);
  const set = parseFacers({
    fcop: {
      frames: 1,
      facers: [
        {
          kind: "billboard",
          mode: "add",
          at: [[0, 1, 0]],
          half: [0.25],
          rgb: [128, 128, 128],
          uv: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          texture: 0,
        },
      ],
    },
  });
  registerFacers(mesh, set, new THREE.Texture());
  const m = new THREE.Matrix4();
  mesh.setMatrixAt(0, m.makeTranslation(0, 0, 0));
  mesh.setMatrixAt(1, m.makeScale(0, 0, 0)); // hidden
  mesh.setMatrixAt(2, m.makeTranslation(0, 0, -20));
  const batch = () =>
    scene.children.find(
      (c) => c !== mesh && (c as THREE.Mesh).geometry instanceof THREE.BufferGeometry,
    ) as THREE.Mesh;

  test("one quad per shown instance in front of the near plane", () => {
    const { camera } = viewOf(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 1, 0));
    drawFacers(camera, 480);
    expect(batch().geometry.drawRange.count).toBe(2 * 6);
    // The camera within 0x405 / 512 m of instance 0 drops its facer.
    const near = viewOf(new THREE.Vector3(0, 1, FACER_NEAR * 0.9), new THREE.Vector3(0, 1, -1));
    drawFacers(near.camera, 480);
    expect(batch().geometry.drawRange.count).toBe(6);
  });

  test("a mesh taken out of the scene takes its facers with it", () => {
    const before = facerSourceCount();
    scene.remove(mesh);
    const { camera } = viewOf(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 1, 0));
    drawFacers(camera, 480);
    expect(facerSourceCount()).toBe(before - 1);
  });
});

/** The root extras of a committed glb. */
function rootExtras(path: string): unknown {
  const b = readFileSync(path);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8")) as {
    nodes: { extras?: unknown; mesh?: number }[];
    meshes?: unknown[];
  };
  expect(json.meshes ?? []).toEqual([]);
  return json.nodes[0].extras;
}

describe("the Props of facers only are their facers", () => {
  test("Slim 63 / Joke 62: an add billboard glow over a half line pole", () => {
    for (const file of ["proving-ground/prop-063.glb", "bug-hunt/prop-062.glb"]) {
      const set = parseFacers(rootExtras(join(PROPS, file)));
      expect(set?.facers.map((f) => `${f.kind}:${f.mode}`)).toEqual(["0:add", "2:half"]);
      expect(set?.facers[0].a[1]).toBeCloseTo(0.828, 3);
      expect(set?.facers[0].h[0]).toBeCloseTo(0.193, 3);
    }
  });
  test("Slim 83 / Joke 82: one add line over ten frames", () => {
    for (const file of ["proving-ground/prop-083.glb", "bug-hunt/prop-082.glb"]) {
      const set = parseFacers(rootExtras(join(PROPS, file)));
      expect(set?.frames).toBe(10);
      expect(set?.facers.length).toBe(1);
      expect(set?.facers[0].kind).toBe(FACER_LINE);
      expect(set?.facers[0].mode).toBe("add");
    }
  });
  test("Hk 65: a star, centre (128, 106, 56) to a black rim, cap 8", () => {
    const set = parseFacers(rootExtras(join(PROPS, "hollywood-keys/prop-065.glb")));
    const star = set?.facers[0];
    expect(star?.kind).toBe(FACER_STAR);
    expect(star?.wedgeCap).toBe(8);
    expect(star?.h[0]).toBeCloseTo(1.199, 3);
    expect(Array.from(star?.rim ?? [])).toEqual([0, 0, 0]);
  });
});

describe("the Fusion Torpedo's and the Plasma Flare's round is Cobj 46's star, 47 from block B", () => {
  test("fx/star-46.glb is one star, (128, 17, 12) doubled to a black rim", () => {
    const set = parseFacers(
      rootExtras(join(import.meta.dir, "..", "public", "models", "fx", "star-46.glb")),
      true,
    );
    expect(set?.facers.length).toBe(1);
    const star = set?.facers[0];
    expect(star?.kind).toBe(FACER_STAR);
    expect(star?.h[0]).toBeCloseTo(0.0742, 4);
    expect(Array.from(star?.colour ?? []).map((v) => Math.round(v * 255))).toEqual([256, 34, 24]);
    expect(Array.from(star?.rim ?? [])).toEqual([0, 0, 0]);
  });

  test("fx/star-47.glb, block B's, is the same star in blue: (31, 59, 128) doubled", () => {
    const set = parseFacers(
      rootExtras(join(import.meta.dir, "..", "public", "models", "fx", "star-47.glb")),
      true,
    );
    expect(set?.facers.length).toBe(1);
    const star = set?.facers[0];
    expect(star?.kind).toBe(FACER_STAR);
    expect(star?.h[0]).toBeCloseTo(0.0742, 4);
    expect(Array.from(star?.colour ?? []).map((v) => Math.round(v * 255))).toEqual([62, 118, 256]);
    expect(Array.from(star?.rim ?? [])).toEqual([0, 0, 0]);
  });

  test("its greybox stand-in adds nothing: no AdditiveBlending anywhere", () => {
    const grey = createGreyboxMeshes(new THREE.Scene());
    for (const b of grey.all) {
      const list = Array.isArray(b.mesh.material) ? b.mesh.material : [b.mesh.material];
      for (const m of list) expect(m.blending).not.toBe(THREE.AdditiveBlending);
    }
  });
});

describe("the facers sort as the original's display list does (draw_list_submit 0x0040ca10)", () => {
  test("a corner slid onto the sort plane stays where the screen shows it", () => {
    const { camera, view } = viewOf(new THREE.Vector3(4, 3, 6), new THREE.Vector3(0, 1, 0));
    const out = new Float32Array(12);
    lineCorners(view, 0, 0, 0, 0.5, 2, -3, 0.2, 0.1, out);
    const before = [0, 1, 2, 3].map((k) => ndc(camera, corner(out, k)));
    onSortPlane(view, 7, out);
    for (let k = 0; k < 4; k++) {
      const after = ndc(camera, corner(out, k));
      expect(after.x).toBeCloseTo(before[k].x, 6);
      expect(after.y).toBeCloseTo(before[k].y, 6);
      expect(viewDepth(view, out[k * 3], out[k * 3 + 1], out[k * 3 + 2])).toBeCloseTo(7, 5);
    }
  });

  test("far to near, the references along", () => {
    const keys = Float32Array.from([3, 9, 1, 9.5, 0]);
    const refs = Int32Array.from([0, 1, 2, 3, 4]);
    sortFarToNear(keys, refs, 4);
    expect(Array.from(keys)).toEqual([9.5, 9, 3, 1, 0]);
    expect(Array.from(refs)).toEqual([3, 1, 0, 2, 4]);
  });

  test("a half line lies flat at its ends' mean, and its batch is drawn far to near", () => {
    const scene = new THREE.Scene();
    initFacers(scene);
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 2);
    scene.add(mesh);
    const set = parseFacers({
      fcop: {
        frames: 1,
        facers: [
          {
            kind: "line",
            mode: "half",
            from: [[0, 0, 0]],
            to: [[0, 2, -4]],
            half: [[0.1, 0.1]],
            uv: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            texture: 0,
          },
        ],
      },
    });
    registerFacers(mesh, set, new THREE.Texture());
    const m = new THREE.Matrix4();
    mesh.setMatrixAt(0, m.makeTranslation(0, 0, 0));
    mesh.setMatrixAt(1, m.makeTranslation(1, 0, -12));
    const { camera, view } = viewOf(new THREE.Vector3(0, 1, 8), new THREE.Vector3(0, 1, 0));
    drawFacers(camera, 480);
    const batch = scene.children.find((c) => c !== mesh) as THREE.Mesh;
    expect(batch.geometry.drawRange.count).toBe(2 * 6);
    const pos = batch.geometry.getAttribute("position").array as Float32Array;
    const depth = (v: number) => viewDepth(view, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    // The far instance first: its ends at 20 and 24 m, its key 22 m.
    const key = (z: number) => (viewDepth(view, 0, 0, z) + viewDepth(view, 0, 2, z - 4)) / 2;
    for (let v = 0; v < 4; v++) expect(depth(v)).toBeCloseTo(key(-12), 4);
    for (let v = 4; v < 8; v++) expect(depth(v)).toBeCloseTo(key(0), 4);
    scene.remove(mesh);
    drawFacers(camera, 480);
  });
});

describe("a star's 3DAL colour ramp runs on the clock (cobj_tick_color_anims 0x0041a1a0)", () => {
  test("a triangle wave of clock * speed, 4096 units a period, retail's rounding", () => {
    // The mine's: grey (128, 128, 128) to magenta (255, 0, 255) at speed 16.
    const to = [255, 0, 255];
    const at = (clock: number) => [0, 1, 2].map((c) => rampByte(128, to[c], 16, clock));
    expect(at(0)).toEqual([128, 128, 128]);
    // Phase 1024: up by (to - from + 1) * 1024 >> 11; down biased by 0x7ff first.
    expect(at(64)).toEqual([192, 65, 192]);
    // Phase 2048 folds to 2047, the top of the wave.
    expect(at(128)).toEqual([255, 2, 255]);
    // And back down: phase 3072 folds to 1023.
    expect(at(192)).toEqual([191, 65, 191]);
    // 4096 / 16 clock units a period.
    expect(at(256)).toEqual(at(0));
    expect(at(256 * 1000 + 64)).toEqual(at(64));
  });

  test("the record's ramp writes the star's centre, doubled, every frame", () => {
    const set = parseFacers({
      fcop: {
        frames: 1,
        facers: [
          {
            kind: "star",
            mode: "add",
            at: [[0, 0.1, 0]],
            radius: [0.1],
            centre_rgb: [128, 128, 128],
            rim_rgb: [32, 32, 32],
            wedge_cap: 8,
            texture: null,
            colour_anim: { speed: 16, from: [128, 128, 128], to: [255, 0, 255] },
          },
        ],
      },
    });
    const star = set?.facers[0];
    if (!star) throw new Error("no star");
    expect(Array.from(star.ramp ?? [])).toEqual([16, 128, 128, 128, 255, 0, 255]);
    rampColour(star, 128);
    expect(Array.from(star.colour).map((v) => Math.round(v * 255))).toEqual([510, 4, 510]);
    // The rim does not ramp.
    expect(Array.from(star.rim).map((v) => Math.round(v * 255))).toEqual([64, 64, 64]);

    // drawFacers runs it at the clock it is handed.
    const scene = new THREE.Scene();
    initFacers(scene);
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 1);
    scene.add(mesh);
    registerFacers(mesh, set, null);
    const { camera } = viewOf(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 0, 0));
    drawFacers(camera, 480, 0);
    expect(Array.from(star.colour).map((v) => Math.round(v * 255))).toEqual([256, 256, 256]);
    drawFacers(camera, 480, 64);
    expect(Array.from(star.colour).map((v) => Math.round(v * 255))).toEqual([384, 130, 384]);
    scene.remove(mesh);
    drawFacers(camera, 480, 0);
  });

  test("the committed mine carries Mp 50's ramp on its star (prim 4)", () => {
    const b = readFileSync(join(import.meta.dir, "..", "public", "models", "fx", "mine.glb"));
    const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8")) as {
      nodes: { extras?: unknown }[];
    };
    const set = parseFacers(json.nodes[0].extras, true);
    const star = set?.facers.find((f) => f.kind === FACER_STAR);
    expect(Array.from(star?.ramp ?? [])).toEqual([16, 128, 128, 128, 255, 0, 255]);
  });
});
