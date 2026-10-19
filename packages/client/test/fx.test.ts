// render/fx.ts: the original's effect records drawn from the effect chain,
// against la-cantina's (Mp's) own records. The chain is the one the sound cues
// raise through; here it is driven directly, the way cues.ts drives it.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEventBuffer,
  EV_SHOT,
  pushEvent,
  reachToShotPayload,
  SHOT_SLOT_GUN,
  SHOT_SLOT_HITSCAN,
  weaponShotPayload,
} from "@metropolis/sim";
import * as THREE from "three";
import { EffectChain, fxArenaFor, makeRaiseAt, ROUND_TOKEN } from "../src/effects/chain";
import { FX_EXE, FX_RECORDS } from "../src/effects/fcopEffects.generated";
import { IMPACT_SCALE, SHELL_SPHERE } from "../src/effects/records";
import { createFx, createFxPoses, type FxPoseResolver, POSE_STRIDE } from "../src/render/fx";
import { domeRingColour } from "../src/render/fx/shells";
import { TEAM_UV_ATTR } from "../src/render/teamUv";

function rig() {
  const scene = new THREE.Scene();
  const chain = new EffectChain();
  chain.begin(fxArenaFor("Mp"));
  const poses = createFxPoses();
  const fx = createFx(scene, chain, { poses });
  fx.begin("la-cantina");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const at = makeRaiseAt();
  at.y = 0.6;
  /** One sim tick: the chain's timers, then three frames of 1/90 s. */
  const tick = () => {
    chain.tick();
    for (let k = 0; k < 3; k++) fx.update(1 / 90, camera, 1 / 90);
  };
  return { scene, chain, fx, poses, camera, at, tick };
}

/** Resolver that puts every event at the origin facing +X. */
const atOrigin: FxPoseResolver = (_type, _a, _b, _c, out) => {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  return true;
};

describe("each record draws as its class", () => {
  test("a turret round's impact: flash 43 (89) and sparks 44 (94, 20 nodes)", () => {
    const { chain, fx, at, tick } = rig();
    at.scale = 0;
    chain.raise(0, 43, at);
    expect(fx.debugCounts().flashes).toBe(1);
    expect(fx.debugCounts().nodes).toBe(20);
    tick();
    expect(fx.debugCounts().flashes).toBe(1);
  });

  test("a flash lives its lifetime: 43's 90 ticks are nine sim ticks", () => {
    const { chain, fx, at, tick } = rig();
    chain.raise(0, 43, at);
    for (let t = 0; t < 8; t++) tick();
    expect(fx.debugCounts().flashes).toBe(1);
    tick();
    tick();
    expect(fx.debugCounts().flashes).toBe(0);
  });

  test("the turret's launch: ring 220 (92) and its trail 221 (87)", () => {
    const { chain, fx, at } = rig();
    chain.raise(0, 220, at);
    const c = fx.debugCounts();
    expect(c.shells).toBe(1);
    expect(c.trails).toBe(1);
  });

  test("the Mini Gun's muzzle (93) and its impact sparks (94)", () => {
    const { chain, fx, at } = rig();
    chain.raise(1, 20, at);
    expect(fx.debugCounts().particles).toBe(1);
    at.scale = IMPACT_SCALE;
    chain.raise(1, 21, at);
    expect(fx.debugCounts().nodes).toBe(3);
  });

  test("the transform's effect 4: a ten-strand link (88) and its flash 5 (89)", () => {
    const { chain, fx, at } = rig();
    chain.raise(1, 4, at);
    expect(fx.debugCounts().links).toBe(1);
    expect(fx.debugCounts().flashes).toBe(1);
  });

  test("a turret's death chain installs its ring and flash, and its trail 29 ticks on", () => {
    const { chain, fx, at, tick } = rig();
    chain.raise(0, 107, at); // shatter 107 -> ring 106 -> flash 108
    expect(fx.debugCounts().shells).toBe(1);
    expect(fx.debugCounts().flashes).toBe(1);
    // With no model to break (no source in a test), the shatter draws nothing.
    expect(fx.debugCounts().shatter).toBe(0);
    tick();
    tick();
    tick(); // 108's delay publishes trail 102
    expect(fx.debugCounts().trails).toBeGreaterThanOrEqual(1);
  });
});

describe("the shatter", () => {
  test("a dying model's faces fly with its own texels, its side's offset and all", () => {
    const scene = new THREE.Scene();
    const chain = new EffectChain();
    chain.begin(fxArenaFor("Mp"));
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    let asked = -2;
    const fx = createFx(scene, chain, {
      shatter: (_archetype, team) => {
        asked = team;
        return { geometry, material, teamU: 0.5, teamV: 0.25 };
      },
    });
    fx.begin("la-cantina");
    const at = makeRaiseAt();
    at.archetype = 5;
    at.team = 1;
    chain.raise(0, 107, at); // the turret's shatter, 50 of the box's 12 triangles: 12
    expect(asked).toBe(1);
    expect(fx.debugCounts().shatter).toBe(12);
    let offsets: ArrayLike<number> | null = null;
    scene.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      const a = g?.getAttribute(TEAM_UV_ATTR);
      if (a && (o as THREE.Mesh).material === material) offsets = a.array;
    });
    expect(offsets).not.toBeNull();
    const uv = offsets as unknown as Float32Array;
    expect(uv[0]).toBe(0.5);
    expect(uv[1]).toBe(0.25);
  });
});

describe("the dome", () => {
  test("a type-92 sphere is a dome: the export's dome on every sphere record, none on a ring", () => {
    let domes = 0;
    for (const rec of FX_RECORDS) {
      if (rec.type !== 92) continue;
      if ((rec.shellFlags & SHELL_SPHERE) === 0) {
        expect(rec.dome).toBeNull();
        continue;
      }
      domes++;
      const dome = rec.dome as NonNullable<typeof rec.dome>;
      // 0x100 the flattened meridian, 0x80 open from 45 degrees, 0x104 oriented.
      expect(dome.profile).toBe((rec.shellFlags & 0x100) !== 0 ? 1 : 0);
      expect(dome.fromTheta).toBe((rec.shellFlags & 0x80) !== 0 ? 0x200 : 0);
      expect(dome.oriented).toBe((rec.flags & 0x104) !== 0 ? 1 : 0);
    }
    expect(domes).toBeGreaterThan(0);
  });

  test("the meridians are the image's: the pole at 0x1000, the rim at r 0x1000, the flat top", () => {
    const { unit, radial } = FX_EXE.spherePatch;
    expect(unit[0]).toEqual([4096, 0]);
    expect(unit[4]).toEqual([0, 4096]);
    expect(radial[0]).toEqual([2048, 0]);
    expect(radial[4]).toEqual([0, 4096]);
  });

  test("the colour steps ring by ring in 12.4, as derived.sphere.band_colours has it", () => {
    // Conft 1:106: near (0, 0, 127) to far (96, 96, 0) over four rings.
    expect([0, 1, 2, 3, 4].map((k) => domeRingColour(0, 96, k, 0))).toEqual([0, 24, 48, 72, 96]);
    expect([0, 1, 2, 3, 4].map((k) => domeRingColour(127, 0, k, 0))).toEqual([127, 95, 63, 31, 0]);
    // Conft 1:143, open at the top: near (0, 0, 0) to far (127, 96, 0) over two.
    expect([2, 3, 4].map((k) => domeRingColour(0, 127, k, 2))).toEqual([0, 63, 127]);
    expect([2, 3, 4].map((k) => domeRingColour(0, 96, k, 2))).toEqual([0, 48, 96]);
  });
});

describe("the executable's own drawings", () => {
  test("the Mini Gun's ribbon while it fires; the Laser's tracer; the Sky Captain's", () => {
    const { fx, tick } = rig();
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_GUN, weaponShotPayload(0, 10)); // Mini-Gun
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_GUN, weaponShotPayload(1, 10)); // Gatling Laser
    pushEvent(events, EV_SHOT, 2, SHOT_SLOT_HITSCAN, reachToShotPayload(12));
    fx.pump(events, atOrigin);
    const c = fx.debugCounts();
    expect(c.ribbons).toBe(1);
    expect(c.tracers).toBe(2);
    // The ribbon holds for the tick after the shot, then goes.
    tick();
    tick();
    expect(fx.debugCounts().ribbons).toBe(0);
  });

  test("a tracer dies when its head reaches the end", () => {
    const { fx, tick } = rig();
    const events = createEventBuffer();
    // The world hitscan slides at 0x30000 world units a second: 24 m/s.
    pushEvent(events, EV_SHOT, 2, SHOT_SLOT_HITSCAN, reachToShotPayload(4.8));
    fx.pump(events, atOrigin);
    for (let t = 0; t < 5; t++) tick();
    expect(fx.debugCounts().tracers).toBe(1);
    for (let t = 0; t < 2; t++) tick();
    expect(fx.debugCounts().tracers).toBe(0);
  });
});

describe("the bolts", () => {
  test("a bolt row's round is drawn as its facers for the frame; a model row is not", () => {
    const { fx, camera } = rig();
    expect(fx.bolt(3, 0, 0.6, 0, 0, 0)).toBe(true);
    expect(fx.bolt(1, 2, 0.6, 0, Math.PI / 2, 0.1)).toBe(true);
    expect(fx.bolt(4, 0, 0.6, 0, 0, 0)).toBe(false);
    expect(fx.bolt(0, 0, 0.6, 0, 0, 0)).toBe(false);
    fx.update(1 / 60, camera, 1 / 60);
    expect(fx.debugCounts().bolts).toBe(2);
    // Queued per frame: the next frame draws only what the entity pass hands it.
    fx.update(1 / 60, camera, 1 / 60);
    expect(fx.debugCounts().bolts).toBe(0);
  });
});

describe("riding a round", () => {
  test("the launch's trail follows its round, and stops when the round is gone", () => {
    const { chain, fx, poses, at, tick } = rig();
    at.attach = ROUND_TOKEN;
    chain.raise(0, 220, at); // 220 ring -> 221 trail, riding the token
    chain.rebind(ROUND_TOKEN, 40);
    // The round flies along +x at 0.25 m a tick.
    for (let t = 0; t < 6; t++) {
      poses.live.fill(0);
      poses.live[40] = 1;
      poses.table[40 * POSE_STRIDE] = t * 0.25;
      poses.table[40 * POSE_STRIDE + 1] = 0.6;
      tick();
    }
    expect(fx.debugCounts().trails).toBe(1);
    // Gone: the trail stops emitting and retires once its nodes fade (102 ticks).
    poses.live.fill(0);
    for (let t = 0; t < 14; t++) tick();
    expect(fx.debugCounts().trails).toBe(0);
  });
});

describe("pools", () => {
  test("a full pool drops the install, it does not grow", () => {
    const { chain, fx, at } = rig();
    for (let k = 0; k < 400; k++) chain.raise(1, 20, at);
    expect(fx.debugCounts().particles).toBe(350);
    for (let k = 0; k < 100; k++) chain.raise(0, 43, at);
    expect(fx.debugCounts().nodes).toBe(700);
  });

  test("reset drops every live effect", () => {
    const { chain, fx, at } = rig();
    chain.raise(0, 107, at);
    chain.raise(0, 220, at);
    chain.raise(1, 4, at);
    fx.reset();
    const c = fx.debugCounts();
    expect(c.flashes + c.shells + c.particles + c.nodes + c.trails + c.links).toBe(0);
  });

  test("the GPU buffers are the same arrays frame after frame (fixed pools)", () => {
    const { scene, chain, fx, camera, at } = rig();
    const arrays = () => {
      const out: ArrayLike<number>[] = [];
      scene.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!g) return;
        for (const name of Object.keys(g.attributes)) out.push(g.attributes[name].array);
        if (g.index) out.push(g.index.array);
        const inst = o as THREE.InstancedMesh;
        if (inst.isInstancedMesh) out.push(inst.instanceMatrix.array);
      });
      return out;
    };
    const before = arrays();
    chain.raise(0, 107, at);
    chain.raise(0, 220, at);
    chain.raise(1, 4, at);
    chain.raise(1, 40, at);
    for (let k = 0; k < 120; k++) fx.update(1 / 60, camera, 1 / 60);
    const after = arrays();
    expect(after.length).toBe(before.length);
    for (let k = 0; k < before.length; k++) expect(after[k]).toBe(before[k]);
  });

  test("the per-frame paths create no objects, arrays or closures", () => {
    // A structural guard (CLAUDE.md renderer rule 1): the bodies of every
    // update, draw, tick, put and strip function in the effect drawers.
    const dir = join(import.meta.dir, "..", "src", "render", "fx");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), join(dir, "..", "fx.ts")];
    const header =
      /^\s*(?:private |export )?(?:function )?(update|draw\w*|tick\w*|put|flush|followAnchor|sides|plainStrip|texturedStrip|cornerQuad|bolt|ramp|drawNode|pump)\(/;
    let bodies = 0;
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!header.test(lines[i])) continue;
        let depth = 0;
        let started = false;
        const body: string[] = [];
        for (let j = i; j < lines.length; j++) {
          const line = lines[j].replace(/\/\/.*$/, "");
          for (const ch of line) {
            if (ch === "{") {
              depth++;
              started = true;
            } else if (ch === "}") depth--;
          }
          if (j > i) body.push(line);
          if (started && depth === 0) break;
        }
        bodies++;
        const text = body.join("\n");
        for (const bad of [
          /\bnew\s+[A-Z]/,
          /=\s*\[/,
          /\.(map|filter|forEach|slice|concat)\(/,
          /=>/,
          /for \(const \w+ of/,
        ]) {
          expect(bad.test(text), `${file}:${i + 1} ${lines[i].trim()} matches ${bad}`).toBe(false);
        }
      }
    }
    expect(bodies).toBeGreaterThan(20);
  });
});
