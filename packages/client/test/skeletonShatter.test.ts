// Type 90's flag 0x10, the skeleton shatter (render/fx/skeletonShatter.ts)
// against the RE's `shatter.c` (0x00429a40, 0x00429f40, 0x0042a030) and the
// draw 0x00429510, on la-cantina's (Mp's) 1:8 -- the wrecked X1's cockpit.

import { describe, expect, test } from "bun:test";
import { ARCHETYPE } from "@metropolis/sim";
import * as THREE from "three";
import { EffectChain, fxArenaFor, makeRaiseAt } from "../src/effects/chain";
import { createFx } from "../src/render/fx";
import {
  type ShatterSkeleton,
  skeletonFloor,
  skeletonGravity,
  skeletonSpin,
} from "../src/render/fx/skeletonShatter";

describe("the builder's numbers", () => {
  test("both spins are one pair draw >> 4, its low byte signed (0x00429cf8)", () => {
    expect(skeletonSpin(0)).toBe(0);
    expect(skeletonSpin(44 * 16 + 15)).toBe(44);
    // 1:8's pair is [0, 8000): past 127 >> 4 the byte wraps negative.
    expect(skeletonSpin(200 * 16)).toBe(-56);
    expect(skeletonSpin(7999)).toBe(499 - 512);
  });

  test("the gravity is the roll's scale >> 4: trunc(fall_scale * raw / -100)", () => {
    expect(skeletonGravity(100, 0)).toBe(-0x500);
    expect(skeletonGravity(100, 31)).toBe(-0x5f8);
    expect(skeletonGravity(0, 9)).toBe(0);
  });

  test("the floor is the ground less the height, world units >> 3", () => {
    // 2 m above the ground: -16384 world units, -2048 -- four metres of
    // model units below the bone's place.
    expect(skeletonFloor(0, 2)).toBe(-2048);
    expect(skeletonFloor(5, 5)).toBe(0);
  });
});

/**
 * A three-bone skeleton at slots 8..10: bone 0 has two whole triangles, bones
 * 1 and 2 one each, and one triangle straddles bones 0 and 1. Each bone's
 * matrix is the identity at its own place.
 */
function skeleton(out: ShatterSkeleton): void {
  const tris: [number, number, number][] = [
    [8, 8, 8],
    [8, 8, 8],
    [9, 9, 9],
    [10, 10, 10],
    [8, 9, 8],
  ];
  const pos: number[] = [];
  const slot: number[] = [];
  for (const t of tris) {
    pos.push(1, 0, 0, 0, 0.5, 0, 0, 0, 1);
    slot.push(...t);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("x1Bone", new THREE.BufferAttribute(new Float32Array(slot), 1));
  out.geometry = g;
  out.slotAttr = "x1Bone";
  out.first = 8;
  out.bones = 3;
  const places = [
    [0, 1, 0],
    [0.5, 1, 0],
    [0, 1, 0.5],
  ];
  out.matrices.fill(0);
  for (let b = 0; b < 3; b++) {
    const o = b * 12;
    out.matrices[o] = 1;
    out.matrices[o + 5] = 1;
    out.matrices[o + 10] = 1;
    out.matrices[o + 3] = places[b][0];
    out.matrices[o + 7] = places[b][1];
    out.matrices[o + 11] = places[b][2];
  }
  out.x = 10;
  out.y = 3;
  out.z = 20;
}

function rig(withSkeleton = true) {
  const scene = new THREE.Scene();
  const chain = new EffectChain();
  chain.begin(fxArenaFor("Mp"));
  let ground = 3;
  const faces = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  const fx = createFx(scene, chain, {
    ground: () => ground,
    shatter: () => ({ geometry: faces, material, teamU: 0, teamV: 0 }),
    shatterSkeleton: (at, out) => {
      if (!withSkeleton || at.archetype !== ARCHETYPE.AVATAR) return false;
      skeleton(out);
      out.material = material;
      return true;
    },
  });
  fx.begin("la-cantina");
  const at = makeRaiseAt();
  at.archetype = ARCHETYPE.AVATAR;
  at.team = 0;
  at.y = 3;
  at.modelY = 3;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const frames = (n: number) => {
    for (let k = 0; k < n; k++) fx.update(1 / 30, camera, 1 / 30);
  };
  /** The visible skeleton mesh's positions. */
  const drawn = () => {
    for (const child of scene.children) {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.visible && mesh.material === material) {
        const g = mesh.geometry;
        if (g.getAttribute("teamUvMask") && g.drawRange.count > 0 && g !== faces) {
          return g.getAttribute("position").array as Float32Array;
        }
      }
    }
    return null;
  };
  return {
    fx,
    chain,
    at,
    frames,
    drawn,
    setGround: (g: number) => {
      ground = g;
    },
  };
}

describe("1:8 on the wrecked X1", () => {
  test("its bones fly as pieces, and a face across two bones is never drawn", () => {
    const r = rig();
    r.chain.raise(1, 8, r.at);
    expect(r.fx.debugCounts().bones).toBe(4);
    expect(r.fx.debugCounts().shatter).toBe(0);
    // Bone 0's first corner (1, 0, 0) at its place (0, 1, 0): the model's x is
    // the glb's mirrored, the model's (x, z) three's (z, x), from the origin.
    const p = r.drawn();
    expect(p).not.toBeNull();
    expect(p?.[0]).toBeCloseTo(10, 5);
    expect(p?.[1]).toBeCloseTo(4, 5);
    expect(p?.[2]).toBeCloseTo(19, 5);
  });

  test("without a skeleton the faces fly instead (0x004385f7)", () => {
    const r = rig(false);
    r.chain.raise(1, 8, r.at);
    expect(r.fx.debugCounts().bones).toBe(0);
    expect(r.fx.debugCounts().shatter).toBeGreaterThan(0);
  });

  test("the first piece down is all that is left drawn, the second leaves none, the last kills it", () => {
    const r = rig();
    r.chain.raise(1, 8, r.at);
    // The ground at the model's height: the floor is 0, and every piece is
    // rolled upward, so each comes down through its start.
    const seen: number[] = [];
    for (let k = 0; k < 600 && r.fx.debugCounts().bones > 0; k++) {
      r.frames(1);
      const n = r.fx.debugCounts().bones;
      if (seen[seen.length - 1] !== n) seen.push(n);
    }
    // 4 drawn, then only the first-landed bone's (2 or 1), then none.
    expect(seen[0]).toBe(4);
    expect(seen[seen.length - 1]).toBe(0);
    for (const n of seen.slice(1, -1)) expect(n === 1 || n === 2).toBe(true);
    // Drawing nothing, it lives until its last piece is down.
    r.frames(600);
    expect(r.drawn()).toBeNull();
  });

  test("a piece falls twice the model's height above the ground before it is caught", () => {
    const r = rig();
    // 2 m of ground below: the floor -2048 model units, 4 m down.
    r.setGround(1);
    r.chain.raise(1, 8, r.at);
    let lowest = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 900 && r.fx.debugCounts().bones === 4; k++) {
      r.frames(1);
      const p = r.drawn();
      if (p && r.fx.debugCounts().bones === 4) {
        for (let v = 0; v < 12; v++) lowest = Math.min(lowest, p[v * 3 + 1]);
      }
    }
    // Every corner starts at 3.5 m or more; the first piece is caught only
    // once it is 4 m below its start, below the ground (1 m).
    expect(lowest).toBeLessThan(1);
    expect(r.fx.debugCounts().bones).toBeLessThan(4);
  });
});
