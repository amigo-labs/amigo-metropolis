// The DCSQuads' drawer depth (render/decals.ts; fcop-fidelity.md G13): the
// key is the mean view depth of the quad's centre and its first three corners
// in `pyro_place`'s order, less PYRO_DRAW_DEPTH_BIAS (RE pyro_draw.c
// 0x0043783d..0x00437864), and the vertex shader writes it as the quad's depth.

import { describe, expect, test } from "bun:test";
import { DECAL_DEPTH_BIAS, DECAL_KEY_PATCH, quadGeometry } from "../src/render/decals";

describe("a DCSQuad's depth", () => {
  test("is its sort key: 0x100 under the mean, half a metre in the 512-a-metre view", () => {
    expect(DECAL_DEPTH_BIAS).toBe(0.5);
    expect(DECAL_KEY_PATCH).toContain("/ 4.0 - 0.500000");
    expect(DECAL_KEY_PATCH).toContain("gl_Position.z = dcsClip.z / dcsClip.w * gl_Position.w;");
  });

  test("averages the corners the drawer reads: (-x, +z), (+x, +z), (+x, -z), never the fourth", () => {
    const g = quadGeometry({ file: "x.png", w: 8, h: 8 } as never);
    const pos = g.getAttribute("position");
    // Corners A, B, C of the unit quad, three's (z, 0, x) of the game's frame.
    const named = [0, 1, 2].map((k) => `vec4( ${pos.getX(k)}.0, 0.0, ${pos.getZ(k)}.0, 1.0 )`);
    for (const v of named) expect(DECAL_KEY_PATCH).toContain(v);
    const fourth = `vec4( ${pos.getX(3)}.0, 0.0, ${pos.getZ(3)}.0, 1.0 )`;
    expect(DECAL_KEY_PATCH).not.toContain(fourth);
  });
});
