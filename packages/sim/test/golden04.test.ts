// Golden #4 (Phase 4 DoD): a full Warden-vs-scripted-input match. Beyond the
// hash-sequence check in golden.test.ts, assert the AI match actually plays
// out — the difficulty-8 Warden captures the map, builds waves and the
// Juggernaut, trades kills with the patrol-and-shoot player 0, and breaches
// on the KNOWN tick. If a balance retune or AI change shifts the match off
// these beats, this fails and the golden needs regenerating WITH a new pin
// (and justification in the commit message — CLAUDE.md hard rule 6).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_BREACH, EV_CAPTURE, EV_DEATH, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

// Pinned after recording; regenerate together with the golden.
const BREACH_TICK_PIN = 7660;

describe("golden-04-warden beats", () => {
  it("the Warden captures, builds and breaches on the pinned tick", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-04-warden.mrep"))),
    );
    expect(replay.mapId).toBe("district-01");
    expect(replay.wardenPlayer).toBe(1);
    expect(replay.wardenDifficulty).toBe(8);
    const sim = createSim(getMapById(replay.mapId), replay.seed, {
      wardenPlayer: replay.wardenPlayer,
      wardenDifficulty: replay.wardenDifficulty,
    });
    const inputs = createTickInputs();

    let wardenRunners = 0;
    let wardenJuggernauts = 0;
    let wardenCaptures = 0;
    let avatarDeaths = 0;
    let wardenDeaths = 0;
    let breaches = 0;
    let breachTick = -1;
    let breachTeam = -1;

    for (let t = 0; t < replay.tickCount; t++) {
      readFrame(replay, t, inputs);
      step(sim, inputs);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = sim.events.data[o];
        if (type === EV_PURCHASE && sim.events.data[o + 2] === 1) {
          if (sim.events.data[o + 3] === ARCHETYPE.RUNNER) wardenRunners += 1;
          if (sim.events.data[o + 3] === ARCHETYPE.JUGGERNAUT) wardenJuggernauts += 1;
        } else if (type === EV_CAPTURE && sim.events.data[o + 2] === 1) {
          wardenCaptures += 1;
        } else if (type === EV_DEATH) {
          if (sim.events.data[o + 3] === ARCHETYPE.AVATAR) avatarDeaths += 1;
          if (sim.events.data[o + 3] === ARCHETYPE.WARDEN) wardenDeaths += 1;
        } else if (type === EV_BREACH) {
          breaches += 1;
          breachTick = t;
          breachTeam = sim.events.data[o + 2];
        }
      }
    }

    // The Warden plays the whole game: map control, waves, the 50-point
    // Juggernaut save (difficulty 8 aggression), and it wins.
    expect(wardenCaptures).toBeGreaterThanOrEqual(4);
    expect(wardenRunners).toBeGreaterThanOrEqual(4);
    expect(wardenJuggernauts).toBeGreaterThanOrEqual(1);
    // Both sides trade kills: the scripted patrol hurts the Warden enough to
    // exercise its retreat/respawn paths, and dies to it in return.
    expect(wardenDeaths).toBeGreaterThanOrEqual(1);
    expect(avatarDeaths).toBeGreaterThanOrEqual(1);
    // Exactly one breach, by the Warden's team, on the known tick.
    expect(breaches).toBe(1);
    expect(breachTeam).toBe(1);
    expect(breachTick).toBe(BREACH_TICK_PIN);
    expect(sim.winner).toBe(1);
    // The replay ran well past the breach: the frozen tail is in the golden.
    expect(replay.tickCount).toBeGreaterThan(BREACH_TICK_PIN + 300);
  });
});
