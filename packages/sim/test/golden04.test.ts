// Golden #4 (Phase 4 DoD): a full Warden-vs-scripted-input match. Beyond the
// hash-sequence check in golden.test.ts, assert what the AI match actually
// plays out. If a balance retune or AI change shifts the match off these beats,
// this fails and the golden needs regenerating WITH new pins (and justification
// in the commit message — CLAUDE.md hard rule 6).
//
// Since SIM_VERSION 46 the Warden is the original's Sky Captain at level 7
// (difficulty 8; fcop-fidelity.md U3), and since SIM_VERSION 52 district-01 runs
// on the original's rules too (turrets, units, speeds, targeting; owner's call).
// It now BREACHES district-01, and the reason is measured:
// - the captain's mode machine promotes it to DEFEND whenever its own team
//   turrets within 256 m of home, each counted twice (the turret and its base
//   part, fcop-re/outposts.md Q2), come to fewer than ten: fewer than 5 turrets.
//   district-01's ring is 4, so 8: it defends all match, flying at the player,
//   and buys no tank (that needs roam/attack, or level 9);
// - its only tanks are its free opening order (level 7: here 5 Runners and 5
//   jets, unpaid). Until SIM_VERSION 52 they halted at the first thing in reach
//   on the polyline lanes and died to the 28 m instant-hit ring; now they are
//   the original's 150-HP tanks at 1.98 m/s that never stop to fight, against a
//   ring of four 12 m weapon-3 turrets, and one reaches base West's gate at tick
//   2824 (94 s);
// - it downs the patrolling player once, kills one of its ring turrets and
//   captures a pad, and is never shot down (was: six falls to the 28 m ring).
// On the imported arenas its 6- or 8-turret ring counts 12 or 16 and it roams,
// buying tanks and Juggernauts (paAttribution.test.ts).

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
  it("the Sky Captain defends, and its opening order breaches district-01", () => {
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

    // It captures the one pad it flies over chasing the player.
    expect(wardenCaptures).toBe(1);
    // Its opening order is its whole field: five Runners (and five jets), none
    // bought — its defend mode buys no tank below level 9.
    expect(wardenRunners).toBe(5);
    expect(wardenJuggernauts).toBe(0);
    // It downs the patrol once and is never shot down.
    expect(wardenDeaths).toBe(0);
    expect(avatarDeaths).toBe(1);
    // The down pays it 10 and costs player 0 10 (R4); a ring turret and a capture
    // pay it 1 each.
    expect(sim.points[1]).toBe(12);
    expect(sim.points[0]).toBe(0);
    // An opening-order Runner breaches base West's gate (SIM_VERSION 52: was no
    // breach), and the match ends one outro later.
    expect(breaches).toBe(1);
    expect(breachTick).toBe(2824);
    expect(breachTeam).toBe(1);
    expect(sim.winner).toBe(1);
  });
});
