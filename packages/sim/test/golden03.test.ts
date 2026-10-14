// Golden #3 (match): beyond the hash-sequence check in golden.test.ts, assert
// the two-player match on la-cantina plays out. Both players walk to their own
// ground consoles and buy five tanks, one per press; then they meet in the
// middle and fight with every weapon, each walking back out after its respawns.
// The tanks drive the original's roads into each other and the rings, the downs
// are paid at the respawn (fcop-fidelity.md R4), and player 1's tanks breach
// base 0 on the pinned tick: the original's gate-box win, its outro, and the
// freeze after it.
// Since district-01 left the game (wave 2, 2026-10-14) this replaces the
// district-01 mini-match. The script steers by the live state at recording time.
// If a rule change shifts the match off these beats, this fails and the script
// needs adjusting WITH the regenerated golden (and a new pin).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_BREACH, EV_DEATH, EV_PURCHASE, EV_RESPAWN, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

// Pinned after recording; regenerate together with the golden.
// 3349 -> 1438 at SIM_VERSION 55: captures measured by the original's
// octagonal estimate change which plate guns the tanks take on the way.
const BREACH_TICK_PIN = 1438;

describe("golden-03-match beats", () => {
  it("purchases on both sides, fights, downs paid at the respawn, breach on the pinned tick", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-03-match.mrep"))),
    );
    expect(replay.mapId).toBe("la-cantina");
    const sim = createSim(getMapById(replay.mapId), replay.seed);
    const inputs = createTickInputs();

    const purchases = [0, 0];
    const respawns = [0, 0];
    let avatarDeaths = 0;
    let runnerDeaths = 0;
    let breaches = 0;
    let breachTick = -1;
    let breachTeam = -1;

    for (let t = 0; t < replay.tickCount; t++) {
      readFrame(replay, t, inputs);
      step(sim, inputs);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = sim.events.data[o];
        if (type === EV_PURCHASE) {
          purchases[sim.events.data[o + 2]] += 1;
          expect(sim.events.data[o + 3]).toBe(ARCHETYPE.RUNNER);
        } else if (type === EV_RESPAWN) {
          const p = sim.events.data[o + 2];
          if (p >= 0) respawns[p] += 1;
        } else if (type === EV_DEATH) {
          const archetype = sim.events.data[o + 3];
          if (archetype === ARCHETYPE.AVATAR) avatarDeaths += 1;
          if (archetype === ARCHETYPE.RUNNER) runnerDeaths += 1;
        } else if (type === EV_BREACH) {
          breaches += 1;
          breachTick = t;
          breachTeam = sim.events.data[o + 2];
        }
      }
    }

    expect(purchases).toEqual([5, 5]);
    // Both go down, and come back every time.
    expect(avatarDeaths).toBeGreaterThanOrEqual(2);
    expect(respawns[0]).toBeGreaterThanOrEqual(1);
    expect(respawns[1]).toBeGreaterThanOrEqual(1);
    expect(runnerDeaths).toBeGreaterThanOrEqual(3);
    // Exactly one breach, by player 1's tanks, on the known tick; the match
    // freezes after the outro.
    expect(breaches).toBe(1);
    expect(breachTeam).toBe(1);
    expect(breachTick).toBe(BREACH_TICK_PIN);
    expect(sim.winner).toBe(1);
  });
});
