import { describe, expect, test } from "bun:test";
import { NodeIO } from "@gltf-transform/core";
import { ANIM_AIRBORNE, ANIM_HOVER, ANIM_MOVING } from "@metropolis/sim";
import {
  advanceGait,
  createGait,
  LEG_SPLIT_FRACTION,
  type PositionReader,
  SWING_RADIANS,
  splitWalkerParts,
  strideForLeg,
} from "../src/render/avatarRig";

// The split is read out of the shipped asset at load time, so the asset is part
// of the contract: these numbers are the regression net. If `bun run gen:units`
// ever emits a walker that no longer falls apart along the original's part
// seams, this fails here rather than shipping a mech that slides on stiff legs.
const WALKER_GLB = new URL("../public/models/units/avatar-walker.glb", import.meta.url).pathname;

/** Tight XYZ, the way gltf-transform stores it. */
function packedReader(xyz: Float32Array): PositionReader {
  return {
    count: xyz.length / 3,
    getX: (i) => xyz[i * 3],
    getY: (i) => xyz[i * 3 + 1],
    getZ: (i) => xyz[i * 3 + 2],
  };
}

/**
 * Positions strided through a buffer that also holds normals and UVs — what
 * GLTFLoader actually produces for these assets.
 *
 * Present because the first implementation read the attribute's backing array
 * directly, which silently walked normals and UVs as coordinates: 1675 components
 * and a 199-vertex "leg" at runtime, while the packed-array test read 9 and 648
 * and passed. Both shapes are checked now so a reader that only handles one
 * cannot pass again.
 */
function interleavedReader(xyz: Float32Array): PositionReader {
  const stride = 8; // x y z | nx ny nz | u v
  const buffer = new Float32Array((xyz.length / 3) * stride);
  for (let i = 0; i < xyz.length / 3; i++) {
    buffer[i * stride] = xyz[i * 3];
    buffer[i * stride + 1] = xyz[i * 3 + 1];
    buffer[i * stride + 2] = xyz[i * 3 + 2];
    // Filler that would look like plausible geometry to a flat-array reader.
    buffer[i * stride + 3] = 0.577;
    buffer[i * stride + 4] = -0.577;
    buffer[i * stride + 5] = 0.577;
    buffer[i * stride + 6] = 0.25;
    buffer[i * stride + 7] = 0.75;
  }
  return {
    count: xyz.length / 3,
    getX: (i) => buffer[i * stride],
    getY: (i) => buffer[i * stride + 1],
    getZ: (i) => buffer[i * stride + 2],
  };
}

const walker = await (async () => {
  const doc = await new NodeIO().read(WALKER_GLB);
  const meshes = doc.getRoot().listMeshes();
  const prims = meshes.flatMap((m) => m.listPrimitives());
  expect(meshes.length).toBe(1); // the pipeline's promise: one node, one mesh…
  expect(prims.length).toBe(1); // …one primitive
  const position = prims[0].getAttribute("POSITION");
  const index = prims[0].getIndices();
  if (!position || !index) throw new Error("avatar-walker.glb has no indexed positions");
  const xyz = position.getArray() as Float32Array;
  return {
    xyz,
    position: packedReader(xyz),
    index: index.getArray() as Uint16Array | Uint32Array,
  };
})();

describe("walker part split", () => {
  const split = splitWalkerParts(walker.position, walker.index);

  test("an interleaved attribute splits identically to a packed one", () => {
    const other = splitWalkerParts(interleavedReader(walker.xyz), walker.index);
    expect(other.componentCount).toBe(split.componentCount);
    expect(other.legVertexCount).toBe(split.legVertexCount);
    expect(Array.from(other.legL)).toEqual(Array.from(split.legL));
    expect(Array.from(other.legR)).toEqual(Array.from(split.legR));
    expect(Array.from(other.body)).toEqual(Array.from(split.body));
  });

  test("the asset still falls apart into the original's nine parts", () => {
    // legs, cockpit, two guns, two symmetric pairs, beacon, one more pair.
    expect(split.componentCount).toBe(9);
    // 648 is exactly the vertex count of the raw legs mesh in
    // tools/generators/units/raw/fcop/x1-alpha-walker.glb — that equality is
    // what says the largest island really is the legs and nothing else.
    expect(split.legVertexCount).toBe(648);
  });

  test("the legs island splits symmetrically into two legs plus a hip", () => {
    // 94 / 94 triangles: a mech with one leg heavier than the other would be a
    // sign the threshold landed inside geometry instead of in the gap.
    expect(split.legL.length / 3).toBe(94);
    expect(split.legR.length / 3).toBe(94);
    // 488 triangles total, 188 of them leg → 300 body (28 hip + 272 above).
    expect(split.body.length / 3).toBe(300);
  });

  test("every triangle lands in exactly one part", () => {
    const total = walker.index.length;
    expect(split.legL.length + split.legR.length + split.body.length).toBe(total);
    // No triangle in two parts: each part's triangles, keyed by their start
    // offset in the source index buffer, must form disjoint sets. Rebuilt by
    // scanning rather than trusted, so a duplicated triangle cannot hide behind
    // the length check above.
    const seen = new Set<string>();
    for (const part of [split.legL, split.legR, split.body]) {
      for (let t = 0; t < part.length; t += 3) {
        const key = `${part[t]},${part[t + 1]},${part[t + 2]}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(total / 3);
  });

  test("the two legs mirror each other to within a centimetre", () => {
    // Left triangles all sit clear of the centre line on the +x side, right ones
    // on the -x side, and the two x-extents mirror. This is the check that would
    // catch a threshold that quietly swallowed one leg into the hip.
    //
    // The bound is rebuilt from the legs' own extent rather than compared
    // against a metre constant, because the threshold is a fraction of the
    // island's half-width (avatarRig.LEG_SPLIT_FRACTION) — the asset is authored
    // at the original's scale and this test must not re-import an assumption
    // about what that scale is.
    //
    // NOT exact: the pipeline's simplify pass breaks the original's symmetry.
    // Measured on the shipped walker it is 2.6 mm, against a 0.80 m footprint.
    // 4 mm is the honest tolerance and still an order of magnitude tighter than
    // any plausible mis-split.
    const extent = (part: Uint32Array) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t < part.length; t += 3) {
        const cx =
          (walker.xyz[part[t] * 3] + walker.xyz[part[t + 1] * 3] + walker.xyz[part[t + 2] * 3]) / 3;
        lo = Math.min(lo, cx);
        hi = Math.max(hi, cx);
      }
      return [lo, hi];
    };
    const [lLo, lHi] = extent(split.legL);
    const [rLo, rHi] = extent(split.legR);
    // Lower bound on the real threshold: triangle centres never reach as far out
    // as the vertices the source measures the half-width from.
    const minSplitX = Math.max(lHi, -rLo) * LEG_SPLIT_FRACTION;
    expect(lLo).toBeGreaterThan(minSplitX);
    expect(rHi).toBeLessThan(-minSplitX);
    // Absolute tolerance, not toBeCloseTo's decimal digits, which quantize in
    // powers of ten and cannot express "4 mm".
    expect(Math.abs(lLo - -rHi)).toBeLessThan(0.004);
    expect(Math.abs(lHi - -rLo)).toBeLessThan(0.004);
  });
});

describe("stride derivation", () => {
  test("a full stride keeps the mid-stance foot planted", () => {
    // The one number the gait is calibrated on: at mid-stance the foot must move
    // backwards relative to the hull at exactly the hull's speed. Sampled
    // numerically here rather than restating strideForLeg's algebra, so an
    // algebra slip in the source cannot pass by matching itself.
    const legLength = 0.653; // the shipped walker's hip height above the sole
    const stride = strideForLeg(legLength);
    const footZ = (phase: number) => legLength * Math.sin(SWING_RADIANS * Math.sin(phase));
    const dPhase = 1e-6;
    const footSpeed = (footZ(dPhase) - footZ(-dPhase)) / (2 * dPhase);
    const hullSpeed = stride / (Math.PI * 2);
    expect(footSpeed).toBeCloseTo(hullSpeed, 6);
  });
});

describe("gait", () => {
  const out = new Float32Array(2);
  // 4.4 world units per cycle ≈ the shipped walker; the exact value is the
  // asset's business (createAvatarRig measures it), so the gait tests pick a
  // round one and check behaviour relative to it.
  const STRIDE = 4.4;
  const gaitOf = () => createGait(1, STRIDE);

  test("the phase advances with distance travelled, not with the clock", () => {
    const gait = gaitOf();
    // Same elapsed time, twice the distance → twice the phase. A clock-driven
    // cycle would give the same phase both times, and the feet would slide.
    advanceGait(gait, 0, 7, 0, 0, ANIM_MOVING, 1 / 60, out);
    advanceGait(gait, 0, 7, 1, 0, ANIM_MOVING, 1 / 60, out);
    const slow = gait.phase[0];
    const fast = (() => {
      const g = gaitOf();
      advanceGait(g, 0, 7, 0, 0, ANIM_MOVING, 1 / 60, out);
      advanceGait(g, 0, 7, 2, 0, ANIM_MOVING, 1 / 60, out);
      return g.phase[0];
    })();
    expect(slow).toBeCloseTo((1 / STRIDE) * Math.PI * 2, 6);
    expect(fast).toBeCloseTo(slow * 2, 6);
  });

  test("a full stride is exactly one cycle", () => {
    const gait = gaitOf();
    advanceGait(gait, 0, 7, 0, 0, ANIM_MOVING, 1 / 60, out);
    // Walk one stride in small steps; the phase must come back to ~0.
    for (let i = 1; i <= 100; i++) {
      advanceGait(gait, 0, 7, (STRIDE * i) / 100, 0, ANIM_MOVING, 1 / 60, out);
    }
    expect(gait.phase[0]).toBeCloseTo(0, 5);
  });

  test("the legs swing in antiphase and stay inside the amplitude", () => {
    const gait = gaitOf();
    advanceGait(gait, 0, 7, 0, 0, ANIM_MOVING, 1, out); // dt 1 s: blend saturates
    let peak = 0;
    for (let i = 1; i <= 200; i++) {
      advanceGait(gait, 0, 7, i * 0.1, 0, ANIM_MOVING, 1 / 60, out);
      expect(out[1]).toBeCloseTo(-out[0], 10);
      peak = Math.max(peak, Math.abs(out[0]));
    }
    expect(peak).toBeGreaterThan(SWING_RADIANS * 0.9);
    expect(peak).toBeLessThanOrEqual(SWING_RADIANS + 1e-9);
  });

  test("standing still holds the phase and settles the legs to neutral", () => {
    const gait = gaitOf();
    advanceGait(gait, 0, 7, 0, 0, ANIM_MOVING, 1, out);
    // Stop mid-swing, so a frozen amplitude would leave a leg sticking out.
    advanceGait(gait, 0, 7, STRIDE / 4, 0, ANIM_MOVING, 1 / 60, out);
    const held = gait.phase[0];
    expect(Math.abs(out[0])).toBeGreaterThan(0.1);
    for (let i = 0; i < 120; i++) {
      advanceGait(gait, 0, 7, STRIDE / 4, 0, 0, 1 / 60, out);
    }
    expect(gait.phase[0]).toBe(held); // no drift while standing
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(0, 12);
  });

  test("airborne freezes a tucked pose without losing the stride", () => {
    const gait = gaitOf();
    advanceGait(gait, 0, 7, 0, 0, ANIM_MOVING, 1, out);
    advanceGait(gait, 0, 7, 1, 0, ANIM_MOVING, 1 / 60, out);
    const held = gait.phase[0];
    // Both legs together, not antiphase — that is what reads as a jump.
    advanceGait(gait, 0, 7, 3, 0, ANIM_MOVING | ANIM_AIRBORNE, 1 / 60, out);
    expect(out[0]).toBe(out[1]);
    expect(out[0]).toBeGreaterThan(0);
    expect(gait.phase[0]).toBe(held);
    // Landing resumes from where the stride left off rather than snapping.
    advanceGait(gait, 0, 7, 3, 0, ANIM_MOVING, 1 / 60, out);
    expect(gait.phase[0]).toBe(held);
  });

  test("a new occupant of a slot starts from neutral, not the last one's stride", () => {
    const gait = gaitOf();
    advanceGait(gait, 0, 7, 0, 0, ANIM_MOVING, 1, out);
    advanceGait(gait, 0, 7, STRIDE / 4, 0, ANIM_MOVING, 1 / 60, out);
    expect(gait.phase[0]).toBeGreaterThan(0);
    // Respawn / different avatar: same slot, different entity id, far away.
    advanceGait(gait, 0, 9, 900, 900, ANIM_MOVING, 1 / 60, out);
    expect(gait.phase[0]).toBe(0);
    // …and crucially no phase jump from the 1200-unit teleport.
    expect(out[0]).toBeCloseTo(0, 12);
  });

  test("hover state is not the rig's business", () => {
    // The rig is only ever handed walking avatars (main.ts routes hovering ones
    // to the avatarHover bucket), so ANIM_HOVER must not change the cycle.
    const walk = gaitOf();
    const hover = gaitOf();
    for (let i = 0; i <= 30; i++) {
      advanceGait(walk, 0, 7, i * 0.2, 0, ANIM_MOVING, 1 / 60, out);
      advanceGait(hover, 0, 7, i * 0.2, 0, ANIM_MOVING | ANIM_HOVER, 1 / 60, out);
    }
    expect(hover.phase[0]).toBe(walk.phase[0]);
    expect(hover.blend[0]).toBe(walk.blend[0]);
  });
});
