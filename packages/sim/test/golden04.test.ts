// Golden #4 (Phase 4 DoD): a full Warden-vs-scripted-input match. Beyond the
// hash-sequence check in golden.test.ts, assert what the AI match actually
// plays out. If a balance retune or AI change shifts the match off these beats,
// this fails and the golden needs regenerating WITH new pins (and justification
// in the commit message — CLAUDE.md hard rule 6).
//
// Until SIM_VERSION 32 the difficulty-8 Warden captured the map, saved for a
// Juggernaut on a 20-point start plus a trickle plus 3 a pad, and breached at
// tick 7660. Under the original's economy (v33, fcop-fidelity.md R2-R7) it no
// longer does: it takes all six pads (+6) and downs the patrolling player twice
// (+20), but each of its own nine falls costs it 10, so the Juggernaut save it
// holds every other purchase for never completes and it fields nothing. That is
// a defect of this invented AI under the original's rules, pinned here as
// measured rather than hidden; the Sky Captain port (fidelity ledger U3) replaces
// it, and its spending is the original's, not a saving rule.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_BREACH, EV_CAPTURE, EV_DEATH, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

describe("golden-04-warden beats", () => {
  it("the Warden captures and trades kills, but its falls starve its save", () => {
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

    // Map control: every pad on district-01.
    expect(wardenCaptures).toBe(6);
    // Both sides trade kills: the scripted patrol hurts the Warden enough to
    // exercise its retreat/respawn paths, and dies to it in return.
    expect(wardenDeaths).toBe(9);
    expect(avatarDeaths).toBe(2);
    // Each Warden fall costs it 10 and pays player 0 10 (R4), so the
    // difficulty-8 Juggernaut save never reaches 50 and nothing is bought.
    expect(wardenRunners).toBe(0);
    expect(wardenJuggernauts).toBe(0);
    expect(sim.points[1]).toBe(0);
    expect(sim.points[0]).toBe(80);
    // No breach: the match is still running when the recording ends.
    expect(breaches).toBe(0);
    expect(breachTick).toBe(-1);
    expect(breachTeam).toBe(-1);
    expect(sim.winner).toBe(-1);
  });
});
