// The kiosks and terminals face the zones they sell at (fcop-fidelity.md G12).
//
// The scenery's yaw (render/recordYaw.ts) is a reading of the RE's code; this
// holds it to the arenas' own data, which the code does not see: every base's
// buy box (bases[].groundConsole / airConsole, the shop triggers' centres) and
// every outpost's claim pad (outposts[].tankPad / jetPad) stands a few
// decimetres from a kiosk or terminal, and the player buys there with the
// model's screen in front of them. The screen is the model's slanted face on
// its +z (area-weighted normal (0, 0.61, 0.80) on every one), so the turn must
// carry +z onto the zone. The other convention the client once used for record
// angles (three's turn a, the turret bases') carries none of them there.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { SCENERY_PLACEMENTS } from "../../../packages/client/src/render/arenaScenery.generated";
import { recordYaw } from "../../../packages/client/src/render/recordYaw";
import { getMapById } from "../../../packages/sim/src/index";

const PROPS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "client",
  "public",
  "models",
  "props",
);
const io = new NodeIO();
/** The cloth flag: no screen, and not what a zone is sold at. */
const FLAG = 28;
/** Nearer than this, the zone is under the kiosk and says nothing about its turn. */
const DECIDES = 0.2;
const TOLERANCE_DEG = 15;
/**
 * Four base kiosks whose shop trigger stands off to one side of the screen's
 * middle (lateral 0.06-0.17 m on a 0.6 m screen, 0.22-0.31 m out): in front of
 * the screen, and further off its axis than 15 degrees. The original's data.
 */
const OFF_AXIS: Record<string, number> = {
  "urban-jungle base 0 air": 17.3,
  "urban-jungle base 1 ground": -42.6,
  "hollywood-keys base 0 air": -16.3,
  "venice-beach base 1 air": -23.1,
};

/** The area-weighted normal of a model's slanted faces (0.3 < n.y < 0.95): its screen. */
async function screenNormal(path: string): Promise<[number, number, number]> {
  const doc = await io.read(path);
  const n = [0, 0, 0];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute("POSITION")?.getArray();
      if (!p) continue;
      const idx = prim.getIndices()?.getArray();
      const count = idx ? idx.length : p.length / 3;
      for (let t = 0; t < count; t += 3) {
        const [a, b, c] = idx ? [idx[t], idx[t + 1], idx[t + 2]] : [t, t + 1, t + 2];
        const u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]);
        const v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
        const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(f[0], f[1], f[2]);
        if (len === 0 || f[1] / len < 0.3 || f[1] / len > 0.95) continue;
        for (let k = 0; k < 3; k++) n[k] += f[k] / 2;
      }
    }
  }
  const len = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / len, n[1] / len, n[2] / len];
}

interface Zone {
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

function zonesOf(mapId: string): Zone[] {
  const map = getMapById(mapId);
  const out: Zone[] = [];
  map.bases.forEach((b, k) => {
    out.push({ name: `${mapId} base ${k} ground`, x: b.groundConsole.x, y: b.groundConsole.y });
    out.push({ name: `${mapId} base ${k} air`, x: b.airConsole.x, y: b.airConsole.y });
  });
  map.outposts.forEach((o, k) => {
    out.push({ name: `${mapId} outpost ${k} tank`, x: o.tankPad.x, y: o.tankPad.y });
    out.push({ name: `${mapId} outpost ${k} jet`, x: o.jetPad.x, y: o.jetPad.y });
  });
  return out;
}

/** The zone in the frame of the kiosk nearest it: distance, and its bearing off +z. */
function facing(mapId: string, z: Zone, heading: (raw: number) => number) {
  let best = SCENERY_PLACEMENTS[mapId].placements[0];
  let d = Number.POSITIVE_INFINITY;
  for (const p of SCENERY_PLACEMENTS[mapId].placements) {
    const e = Math.hypot(p.x - z.x, p.y - z.y);
    if (p.cobj !== FLAG && e < d) {
      d = e;
      best = p;
    }
  }
  const a = heading(best.yaw);
  const dx = z.x - best.x;
  const dy = z.y - best.y;
  const forward = dx * Math.cos(a) + dy * Math.sin(a);
  const lateral = dy * Math.cos(a) - dx * Math.sin(a);
  const off = (Math.atan2(lateral, forward) * 180) / Math.PI;
  return { kiosk: best, d, forward, lateral, off };
}

describe("the kiosks and terminals face their zones", () => {
  const arenas = Object.keys(SCENERY_PLACEMENTS);

  test("every one that stands by a zone has its screen on its +z", async () => {
    const seen = new Set<string>();
    for (const mapId of arenas) {
      for (const z of zonesOf(mapId)) {
        const { kiosk } = facing(mapId, z, recordYaw);
        const file = join(PROPS, mapId, `prop-${String(kiosk.cobj).padStart(3, "0")}.glb`);
        if (seen.has(file)) continue;
        seen.add(file);
        const [x, y, zz] = await screenNormal(file);
        expect({ file, x: Math.abs(x) < 0.05, y: y > 0.5, z: zz > 0.75 }).toEqual({
          file,
          x: true,
          y: true,
          z: true,
        });
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  test("its screen faces the zone within 15 degrees, by the record's yaw", () => {
    let decided = 0;
    for (const mapId of arenas) {
      for (const z of zonesOf(mapId)) {
        const f = facing(mapId, z, recordYaw);
        if (f.d <= DECIDES) continue;
        decided++;
        // In front of the screen, inside its width, wherever the zone decides.
        expect({
          zone: z.name,
          front: f.forward > 0.18,
          inside: Math.abs(f.lateral) < 0.2,
        }).toEqual({ zone: z.name, front: true, inside: true });
        const known = OFF_AXIS[z.name];
        if (known !== undefined) expect(f.off).toBeCloseTo(known, 1);
        else
          expect({ zone: z.name, within: Math.abs(f.off) <= TOLERANCE_DEG }).toEqual({
            zone: z.name,
            within: true,
          });
      }
    }
    // La Cantina's 12, Urban Jungle's 11, and the few elsewhere.
    expect(decided).toBe(34);
  });

  test("three's turn a would face none of them", () => {
    // The turret bases' old convention: three turns by a, so +z heads the sim's
    // (sin a, cos a), the yaw pi/2 - a.
    for (const mapId of arenas) {
      for (const z of zonesOf(mapId)) {
        const f = facing(mapId, z, (raw) => Math.PI / 2 - recordYaw(raw));
        if (f.d <= DECIDES || recordYaw(f.kiosk.yaw) % Math.PI === Math.PI / 4) continue;
        expect({ zone: z.name, within: Math.abs(f.off) <= TOLERANCE_DEG }).toEqual({
          zone: z.name,
          within: false,
        });
      }
    }
  });
});
