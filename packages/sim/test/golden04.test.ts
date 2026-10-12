// Golden #4 (Phase 4 DoD): a full Warden-vs-scripted-input match. Beyond the
// hash-sequence check in golden.test.ts, assert what the AI match actually
// plays out. If a balance retune or AI change shifts the match off these beats,
// this fails and the golden needs regenerating WITH new pins (and justification
// in the commit message — CLAUDE.md hard rule 6).
//
// Since SIM_VERSION 46 the Warden is the original's Sky Captain at level 7
// (difficulty 8; fcop-fidelity.md U3). It does not breach district-01, and the
// reason is measured, not hidden:
// - the captain's mode machine promotes it to DEFEND whenever it owns fewer than
//   ten turrets within 256 m of home (8 base turrets + 2 per owned outpost in
//   the original; district-01's ring is 4 and Metropolis' outposts carry none).
//   In defend mode it flies at the player and buys only jets, a Fortress past 65
//   points, and — at level 9 only — a base tank against a threat at home; it
//   claims outposts and buys tanks or a Dreadnought only in its other two modes.
//   So it spends this match in defend mode (all but the 6 ticks after a respawn);
// - its only tanks are its free opening order (level 7: 2-5 tanks and the rest
//   of ten jets, unpaid). On district-01 (Metropolis' polyline lanes) a Runner
//   halts at the first thing in reach and dies there: all five do;
// - chasing the patrolling player into district-01's ring (Metropolis' 28 m
//   instant-hit turrets) it falls six times, each costing it 10.
// On the imported arenas the same opening order breaches an idle player in
// 41-132 s on 19 of 20 seeds (paAttribution.test.ts): their Runners are the
// original's route followers and do not stop to fight.

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
  it("the Sky Captain defends, trades kills, and its opening order dies on the lanes", () => {
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

    // It captures the two pads it flies over chasing the player.
    expect(wardenCaptures).toBe(2);
    // Its opening order is its whole field: five Runners (and five jets), none
    // bought — its defend mode buys no tank below level 9.
    expect(wardenRunners).toBe(5);
    expect(wardenJuggernauts).toBe(0);
    // Both sides trade kills: it falls six times to the patrol and the ring, and
    // downs the patrol once.
    expect(wardenDeaths).toBe(6);
    expect(avatarDeaths).toBe(1);
    // Each fall costs it 10 and pays player 0 10 (R4): it ends on nothing.
    expect(sim.points[1]).toBe(0);
    expect(sim.points[0]).toBe(65);
    // No breach: the match is still running when the recording ends.
    expect(breaches).toBe(0);
    expect(breachTick).toBe(-1);
    expect(breachTeam).toBe(-1);
    expect(sim.winner).toBe(-1);
  });
});
