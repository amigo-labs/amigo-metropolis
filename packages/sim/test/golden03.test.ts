// Golden #3 (match): beyond the hash-sequence check in golden.test.ts, assert
// the two-player match on la-cantina plays out. Both players walk to their own
// ground consoles and buy five tanks, one per press; then they meet in the
// middle and fight with every weapon, each walking back out after its respawns.
// The tanks drive the original's roads into each other and the rings, and the
// downs are paid at the respawn (fcop-fidelity.md R4). Whether a tank slips
// through a ring is the roads' coin flips: pinned below as recorded (the gate-box
// win, its outro and the freeze are golden07.test's to prove).
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
// 1438 -> none at SIM_VERSION 60: the heavy-zone poll's draw at createSim moves
// the PRNG stream, and no tank's route gets through (2 of seeds c0ffee/1-7
// breach, both by player 0's tanks).
// none -> 2498 at SIM_VERSION 69: both players drive on the original's
// buttons, turning toward each route cell before they walk it, and fire Special
// from its latch's held state, so the fight in the middle plays out
// differently; one of player 0's tanks gets through player 1's ring at 83 s.
// 2498 -> none at SIM_VERSION 78: every hit radius is the original's (the mech
// 0.553 m walking, was 0.4; the tank 0.943, was 0.76), so the fight's and the
// rings' rounds find more: the mechs go down 11 times in the 200 s (were 5), both
// rings lose a turret, and all ten tanks die short of the gates (the nearest 19 m
// off; player 0's breaching tank was killed at 25.6 m).
const BREACH_TICK_PIN = -1;
const BREACH_TEAM_PIN = 0;

describe("golden-03-match beats", () => {
  it("purchases on both sides, fights, downs paid at the respawn, the breach as pinned", () => {
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
    // The breach as recorded: none since SIM_VERSION 78 (player 0's tank at 83 s
    // from 69).
    expect(breaches).toBe(BREACH_TICK_PIN < 0 ? 0 : 1);
    expect(breachTick).toBe(BREACH_TICK_PIN);
    expect(breachTeam).toBe(BREACH_TICK_PIN < 0 ? -1 : BREACH_TEAM_PIN);
    expect(sim.winner).toBe(BREACH_TICK_PIN < 0 ? -1 : BREACH_TEAM_PIN);
  });
});
