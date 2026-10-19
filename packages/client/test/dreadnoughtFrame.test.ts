// The Dreadnought's gun mounts (sim map.ts MapGunMount) are hull-frame glb
// points, placed by the sim at hull + z * forward + x * (sin yaw, -cos yaw). That
// is where the client draws the same glb point: unitMeshes.ts turns a unit's
// geometry a quarter turn about +Y, main.ts sets the instance at (x, height, y)
// turned by -yaw about +Y. A gun drawn at its mount by that transform stands
// where the sim fires it from.

import { describe, expect, test } from "bun:test";
import { DREADNOUGHT_MOUNTS } from "@metropolis/sim";
import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);

describe("the Dreadnought's mount frame", () => {
  test("is the frame the client draws the hull's glb in", () => {
    for (const yaw of [0, 0.9, -2.1, 3.0]) {
      for (const m of DREADNOUGHT_MOUNTS) {
        const v = new THREE.Vector3(m.x, m.y, m.z)
          .applyAxisAngle(UP, Math.PI / 2)
          .applyAxisAngle(UP, -yaw);
        expect(v.x).toBeCloseTo(m.z * Math.cos(yaw) + m.x * Math.sin(yaw), 6);
        expect(v.z).toBeCloseTo(m.z * Math.sin(yaw) - m.x * Math.cos(yaw), 6);
        expect(v.y).toBeCloseTo(m.y, 6);
      }
    }
  });
});
