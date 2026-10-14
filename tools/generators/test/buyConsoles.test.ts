// Each arena's two base shops stand where the original's sell what they sell:
// the ground console (tanks) on the trigger whose script queues a tank, the air
// console (jets) on the one whose script requests a jet, with that trigger's
// box — read from the rules artifact (tools/generators/fcop/<mission>-rules.json,
// RE tools/logic/pa_rules_data.py `buy_triggers[].sells`).
//
// Two readings before it were each backwards somewhere: the wider footprint
// (la-cantina, bug-hunt, hollywood-keys, venice-beach) and a kiosk Cobj id read
// as if every mission numbered its Cobjs alike (urban-jungle, proving-ground,
// whose 40 is Mp's 39, the jet kiosk). Getting it backwards is invisible in a
// screenshot of the map data; you only notice when the wrong unit rolls out.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMapById } from "@metropolis/sim";
import { LOGIC_OFFSET_X, LOGIC_OFFSET_Z } from "../enrichArena";
import { FCOP_ARENAS, rulesFile } from "../fcopArenas";
import { triggerHalfExtent } from "../fcopLogic";
import type { FcopRules } from "../fcopRules";

const FCOP = join(import.meta.dir, "..", "fcop");
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

describe("base buy consoles follow the original's shop triggers", () => {
  for (const arena of FCOP_ARENAS) {
    test(`${arena.mapId} (${arena.mission}): tanks at the ground console, jets at the air console`, () => {
      const rules = JSON.parse(readFileSync(join(FCOP, rulesFile(arena)), "utf8")) as FcopRules;
      const map = getMapById(arena.mapId);
      expect(rules.buyTriggers).toHaveLength(4);
      // Each slot sells one tank and one jet, at one base.
      for (const slot of [0, 1]) {
        const kinds = rules.buyTriggers.filter((b) => b.slot === slot).map((b) => b.kind);
        expect(kinds.sort()).toEqual(["jet", "tank"]);
      }
      const teamOfSlot = new Map<number, number>();
      for (const shop of rules.buyTriggers) {
        const x = round4(shop.x + LOGIC_OFFSET_X);
        const y = round4(shop.z + LOGIC_OFFSET_Z);
        const box = {
          halfW: round4(triggerHalfExtent(shop.widthRaw)),
          halfL: round4(triggerHalfExtent(shop.lengthRaw)),
        };
        const team = map.bases.findIndex((b) => {
          const p = shop.kind === "tank" ? b.groundConsole : b.airConsole;
          return p.x === x && p.y === y;
        });
        expect(team, `${shop.kind} shop ${shop.id} at (${x}, ${y})`).toBeGreaterThanOrEqual(0);
        const base = map.bases[team];
        expect(shop.kind === "tank" ? base.groundBuy : base.airBuy).toEqual(box);
        // The other console of that base is not this trigger.
        const other = shop.kind === "tank" ? base.airConsole : base.groundConsole;
        expect(other.x === x && other.y === y).toBe(false);
        const seen = teamOfSlot.get(shop.slot);
        if (seen === undefined) teamOfSlot.set(shop.slot, team);
        else expect(team).toBe(seen);
      }
      expect(new Set(teamOfSlot.values()).size).toBe(2);
    });
  }
});
