// Every feature stands where the original stands it (issue #33, PLAN.md Phase 13).
//
// No actor's Y is stored: each construct asks `terrain_height_at` with a selector
// byte from its own record, and `cnet_load` does the same for a node
// (fcopLogic.ts HEIGHT_SELECTOR). gen:palogic runs that query over the shipped
// plates (fcopTerrain.ts) and carries the answer per record as `groundY`; stage 2
// puts each feature on the sim surface carrying that height. This test holds the
// committed maps to it on all six arenas: every feature that has a record (or
// a node, or an aircraft record over whose surface it is placed) at its
// position stands on a surface within SURFACE_MATCH of the original's height
// there; one with none must stand on the ground.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMapById, type MapData, resolveHeight } from "@metropolis/sim";
import { LOGIC_OFFSET_X, LOGIC_OFFSET_Z } from "../enrichArena";
import { FCOP_ARENAS, logicFile } from "../fcopArenas";

/** enrichArena.ts SURFACE_MATCH: the plate query against stage 1's decks. */
const SURFACE_MATCH = 0.6;

interface Rec {
  x: number;
  z: number;
  groundY: number | null;
}

interface Logic {
  spawns: Rec[];
  turrets: Rec[];
  neutrals: Rec[];
  pickups: Rec[];
  triggers: Rec[];
  markers: { type14: Rec[] };
  aircraft: Rec[];
  nets: { nodes: Rec[] }[];
}

function recordsAt(logic: Logic): Map<string, Rec[]> {
  const all = [
    ...logic.spawns,
    ...logic.turrets,
    ...logic.neutrals,
    ...logic.pickups,
    ...logic.triggers,
    ...logic.markers.type14,
    ...logic.aircraft,
    ...logic.nets.flatMap((n) => n.nodes),
  ];
  const out = new Map<string, Rec[]>();
  for (const r of all) {
    const k = key(r.x + LOGIC_OFFSET_X, r.z + LOGIC_OFFSET_Z);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

const key = (x: number, y: number): string => `${x.toFixed(2)}|${y.toFixed(2)}`;

interface Feature {
  what: string;
  x: number;
  y: number;
  layer: number;
}

function features(map: MapData): Feature[] {
  const out: Feature[] = [];
  const add = (what: string, p: { x: number; y: number; layer: number }): void => {
    out.push({ what, x: p.x, y: p.y, layer: p.layer });
  };
  for (const [k, s] of map.spawns.entries()) add(`spawn ${k}`, s);
  for (const [t, b] of map.bases.entries()) {
    add(`base ${t} gate`, b.gate);
    add(`base ${t} core`, b.core);
    add(`base ${t} ground console`, b.groundConsole);
    add(`base ${t} air console`, b.airConsole);
    for (const [k, q] of b.turrets.entries()) add(`base ${t} ring turret ${k}`, q);
    add(`base ${t} tank spawn`, b.tankSpawn);
    add(`base ${t} jet spawn`, b.jetSpawn);
    add(`base ${t} fortress spawn`, b.fortressSpawn);
    if (b.heavyZones) {
      add(`base ${t} juggernaut zone`, b.heavyZones.juggernaut);
      add(`base ${t} fortress zone`, b.heavyZones.fortress);
    }
  }
  for (const [k, p] of map.turretSpots.entries()) add(`capture pad ${k}`, p);
  for (const [k, p] of map.outpostSpots.entries()) add(`outpost ${k}`, p);
  for (const [k, o] of map.outposts.entries()) {
    add(`outpost ${k} tank pad`, o.tankPad);
    add(`outpost ${k} jet pad`, o.jetPad);
    for (const [t, q] of o.tankSpawn.entries()) add(`outpost ${k} team ${t} tank spawn`, q);
    for (const [t, q] of o.jetSpawn.entries()) add(`outpost ${k} team ${t} jet spawn`, q);
  }
  for (const [j, pl] of map.outpostPlates.entries()) {
    for (const [t, q] of pl.turrets.entries()) add(`outpost ${pl.outpost} plate ${j} team ${t}`, q);
  }
  for (const [k, p] of map.pickups.entries()) add(`pickup ${k}`, p);
  for (const [k, n] of (map.laneGraph?.nodes ?? []).entries()) add(`lane node ${k}`, n);
  return out;
}

describe("every feature stands on the original's surface", () => {
  for (const arena of FCOP_ARENAS) {
    it(arena.mapId, () => {
      const map = getMapById(arena.mapId);
      const logic = JSON.parse(
        readFileSync(join(import.meta.dir, "..", "fcop", logicFile(arena)), "utf8"),
      ) as Logic;
      const at = recordsAt(logic);
      const bad: string[] = [];
      let matched = 0;
      for (const f of features(map)) {
        const recs = at.get(key(f.x, f.y));
        const h = resolveHeight(map, f.x, f.y, f.layer);
        if (!recs) {
          // No record here: it can only stand on the ground.
          if (f.layer !== 0) bad.push(`${f.what}: no record, yet surface ${f.layer}`);
          continue;
        }
        matched++;
        if (!recs.some((r) => r.groundY !== null && Math.abs(r.groundY - h) <= SURFACE_MATCH)) {
          bad.push(
            `${f.what} (${f.x}, ${f.y}) surface ${f.layer} at ${h.toFixed(3)} m, ` +
              `the original ${recs.map((r) => r.groundY).join("/")} m`,
          );
        }
      }
      expect(bad).toEqual([]);
      expect(matched).toBeGreaterThan(100);
    });
  }
});
