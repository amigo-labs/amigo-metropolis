// The damaged arms' flag (render/damaged.ts; fcop-fidelity.md G13): an EV_HIT
// with positive damage marks its target for the frames after its step and is
// gone at the next step, as the registry pass clears CACT_FLAG_DAMAGED at the
// top of the next frame (0x0043b520); the per-instance attribute is written on
// a change only.

import { describe, expect, test } from "bun:test";
import { createEventBuffer, EV_DEATH, EV_HIT, pushEvent } from "@metropolis/sim";
import * as THREE from "three";
import { clearHits, createHitAttribute, isHit, noteHits, writeHit } from "../src/render/damaged";
import { HIT_ATTRIBUTE } from "../src/render/fcopModel";

describe("the hit marks", () => {
  test("a step's positive hits mark their targets until the next step", () => {
    clearHits();
    const step = createEventBuffer();
    pushEvent(step, EV_HIT, 7, 0, 25);
    pushEvent(step, EV_HIT, 9, 1, 0);
    pushEvent(step, EV_DEATH, 11, 0, 3);
    noteHits(step);
    expect([isHit(7), isHit(9), isHit(11)]).toEqual([true, false, false]);
    const next = createEventBuffer();
    pushEvent(next, EV_HIT, 9, 1, 4);
    noteHits(next);
    expect([isHit(7), isHit(9)]).toEqual([false, true]);
    noteHits(createEventBuffer());
    expect(isHit(9)).toBe(false);
    expect(isHit(-1)).toBe(false);
  });

  test("an instance's flag is written on a change only", () => {
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 2);
    const attr = createHitAttribute(2);
    mesh.geometry.setAttribute(HIT_ATTRIBUTE, attr);
    const v0 = attr.version;
    writeHit(mesh, 1, true);
    expect(Array.from(attr.array)).toEqual([0, 1]);
    expect(attr.version).toBe(v0 + 1);
    writeHit(mesh, 1, true);
    expect(attr.version).toBe(v0 + 1);
    // A stand-in without the attribute is left alone.
    writeHit(new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 1), 0, true);
  });
});
