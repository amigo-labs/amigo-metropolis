// The type-90 shatter (render/fx/shatter.ts) against the RE's settled rules
// (tables.json type_rules.90; effect_type90.c, effect_type90_tick.c, the roll
// 0x00437b20), on la-cantina's (Mp's) own records.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { killPush } from "../src/audio/cues";
import { EffectChain, fxArenaFor, makeRaiseAt } from "../src/effects/chain";
import { createFx, createFxPoses } from "../src/render/fx";
import { POSE_STRIDE } from "../src/render/fx/common";
import {
  FACE_REF_BASE,
  shatterFaceCount,
  shatterFall,
  shatterMagnitude,
} from "../src/render/fx/shatter";

describe("the roll", () => {
  test("the fall is ((rand & 0x1f) * 8 + 0x500) * scale / -100 << 4 world units a second squared", () => {
    // derived.fall_wu_s2 of every scale-100 record: [-24448, -20480].
    expect(shatterFall(100, 0)).toBe(-20480);
    expect(shatterFall(100, 31)).toBe(-24448);
    expect(shatterFall(0, 17)).toBe(0); // 0:57 and 0:107 fly straight
    expect(shatterFall(88, 0)).toBe(Math.trunc((88 * 0x500) / -100) * 16);
  });

  test("the magnitude lies in [hi, 2 hi - lo), hi when hi <= lo", () => {
    expect(shatterMagnitude(120, 1228, 0)).toBe(1228);
    expect(shatterMagnitude(120, 1228, 0.999999)).toBe(2335);
    expect(shatterMagnitude(818, 818, 0.5)).toBe(818);
    expect(shatterMagnitude(900, 818, 0.5)).toBe(818);
  });

  test("the face count: 0 every primitive, outside 0..50 fifty, cut to the pool's 200", () => {
    expect(shatterFaceCount(0, 120, 200)).toBe(120);
    expect(shatterFaceCount(-1, 120, 200)).toBe(50);
    expect(shatterFaceCount(77, 120, 200)).toBe(50);
    expect(shatterFaceCount(30, 120, 200)).toBe(30);
    expect(shatterFaceCount(30, 12, 200)).toBe(12);
    expect(shatterFaceCount(30, 120, 7)).toBe(7);
  });
});

function rig(geometry: THREE.BufferGeometry) {
  const scene = new THREE.Scene();
  const chain = new EffectChain();
  chain.begin(fxArenaFor("Mp"));
  const poses = createFxPoses();
  let ground = -100;
  const fx = createFx(scene, chain, {
    poses,
    ground: () => ground,
    shatter: () => ({ geometry, material: new THREE.MeshBasicMaterial(), teamU: 0, teamV: 0 }),
  });
  fx.begin("la-cantina");
  const at = makeRaiseAt();
  at.archetype = 5;
  at.team = 0;
  at.y = 1;
  at.modelY = 0;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  /** Installs per "bank:id", as the chain hands them to its listeners. */
  const installs = new Map<string, number>();
  chain.addListener({
    install(bank, id) {
      const k = `${bank}:${id}`;
      installs.set(k, (installs.get(k) ?? 0) + 1);
    },
  });
  const frames = (n: number) => {
    for (let k = 0; k < n; k++) fx.update(1 / 30, camera, 1 / 30);
  };
  return {
    fx,
    poses,
    at,
    installs: (k: string) => installs.get(k) ?? 0,
    chain,
    frames,
    setGround: (g: number) => {
      ground = g;
    },
  };
}

describe("faces", () => {
  test("Mp 0:159: 20 faces from the pool, six carry 172 riding them, about half reap 4", () => {
    const r = rig(new THREE.SphereGeometry(1, 16, 8));
    r.chain.raise(0, 159, r.at);
    expect(r.fx.debugCounts().shatter).toBe(20);
    // The reference effect (172, a type-93 particle) on the first six faces.
    expect(r.fx.debugCounts().particles).toBe(6);
    let refs = 0;
    for (let k = 0; k < 64; k++) refs += r.poses.live[FACE_REF_BASE + k];
    expect(refs).toBe(6);
    // Lift the ground over everything: one face in eight asks it each frame, so
    // every face is given back within eight frames, not all in the first.
    r.setGround(1000);
    r.frames(1);
    expect(r.fx.debugCounts().shatter).toBeGreaterThan(12);
    r.frames(7);
    expect(r.fx.debugCounts().shatter).toBe(0);
    // 0x00438010: the pool's count after each release, 19 .. 0; bits 2 or 3 raise.
    expect(r.installs("0:4")).toBe(10);
    for (let k = 0; k < 64; k++) expect(r.poses.live[FACE_REF_BASE + k]).toBe(0);
  });

  test("a lifetime counts down: 0:10's 375 ticks + (rand & 0xff), then the faces are gone", () => {
    const r = rig(new THREE.SphereGeometry(1, 16, 8));
    r.chain.raise(0, 10, r.at); // count 30
    expect(r.fx.debugCounts().shatter).toBe(30);
    r.frames(Math.floor((375 * 30) / 300) - 1); // under 375 ticks: all fly
    expect(r.fx.debugCounts().shatter).toBe(30);
    r.frames(Math.ceil(((375 + 256) * 30) / 300) + 1);
    expect(r.fx.debugCounts().shatter).toBe(0);
  });
});

describe("the killer's push (0x00437aa0, RE M3-OP)", () => {
  test("((heading >> 4) * (i16)(damage << 3)) >> 8, the scale a halfword", () => {
    expect(killPush(1, 25)).toBe(3200); // 4096 * 200 / 256
    expect(killPush(-1, 25)).toBe(-3200);
    expect(killPush(0, 25)).toBe(0);
    // 0x1000 << 3 is 0x8000, negative as a halfword: backwards; 0x2000 nothing.
    expect(killPush(1, 0x1000)).toBeLessThan(0);
    expect(killPush(1, 0x2000)).toBe(0);
  });

  test("a face's roll takes the push, so the faces fly the killer's way", () => {
    const meanX = (push: number) => {
      const r = rig(new THREE.SphereGeometry(1, 16, 8));
      r.at.pushX = push;
      r.chain.raise(0, 159, r.at); // the first six faces publish their place
      r.frames(10);
      let sum = 0;
      for (let k = 0; k < 6; k++) sum += r.poses.table[(FACE_REF_BASE + k) * POSE_STRIDE];
      return sum / 6;
    };
    // 3200 x16 wu/s is 6.25 m/s: a third of a second moves them about 2 m.
    expect(meanX(3200) - meanX(0)).toBeGreaterThan(1);
  });
});

describe("whole objects", () => {
  test("Mp 0:186 flies the model whole, outside the pool, and reaps 187 where it was raised", () => {
    const r = rig(new THREE.BoxGeometry(1, 1, 1));
    r.chain.raise(0, 186, r.at);
    expect(r.fx.debugCounts().shatter).toBe(12);
    // The drift lifts it off the ground; it falls back by its fall.
    r.setGround(0);
    r.frames(1);
    expect(r.fx.debugCounts().shatter).toBe(12);
    r.frames(120);
    expect(r.fx.debugCounts().shatter).toBe(0);
    // One reap (187, a shell) for the whole object.
    expect(r.installs("0:187")).toBe(1);
  });
});
