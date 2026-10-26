// Golden #4: a full Sky-Captain match against a scripted player. Beyond the
// hash-sequence check in golden.test.ts, assert what the AI match plays out.
// If a rule or AI change shifts the match off these beats, this fails and the
// golden needs regenerating WITH new pins (and justification in the commit
// message — CLAUDE.md hard rule 6).
//
// Since district-01 left the game (wave 2, 2026-10-14) it runs on urban-jungle
// against the captain at difficulty 3 (level 2): its ring of eight counts 16, so
// it roams (fcop-re/outposts.md Q2), fields its free opening order, buys tanks
// and jets with its own points and claims an outpost. Player 0 holds its gate
// and fights whatever comes within 20 m. Since the captain
// shoots as the original's does (SIM_VERSION 54: no line of sight to pick a
// target, but walls stop its gun and missile) its tanks no longer reach the
// gate in these 150 s. As recorded at SIM_VERSION 61 (its requests go to the
// shared spawn queues, which run from a phase drawn at createSim): ten tanks
// and one jet, and the player goes down twice. Since SIM_VERSION 67 urban-jungle
// is the original's multi-deck arena and its kerbs and the extractor's spilled
// walls no longer stand on the roads (fcop-fidelity.md P15): the same ten tanks
// reach the player's gate and breach it at 102 s, and the player goes down once.
// Since SIM_VERSION 69 the player drives on the original's buttons (turning
// toward each route cell, forward once within 22.5° of it) and its Special fires
// from the latch's held state: holding its gate, it shoots the captain down once
// (at 89 s), so the captain claims nothing and its tanks — eighteen now, and the
// jet — do not breach in these 150 s; the player goes down once. Since
// SIM_VERSION 73 urban-jungle's consoles are the original's way round: the
// captain's jet patrols from the jet shop, its tanks join the road from the tank
// shop, and the walls about the player's shops are the extracted ones (the old
// carve for the misplaced ground console's leg closed, one bit by the tank shop
// opened). Player 0 is downed twice (87 s, 110 s) and never shoots the captain
// down; the captain buys ten tanks and the jet, claims an outpost, and its tanks
// breach the player's gate at tick 3357 (112 s). Since SIM_VERSION 75 the
// captain rethinks at the player's down, not 4 s later at the respawn (both
// downs are its own fire): the second down comes at 109 s and its tanks do not
// breach in these 150 s. Since SIM_VERSION 78 every hit radius is the
// original's (the player's mech 0.553 m walking, was 0.4; the captain's tanks
// 0.943, was 0.76; the route followers keep their traffic gaps by the same
// radii): the player goes down once, at 133 s, and the captain's ten tanks do
// not breach in the 150 s (the nearest dies 7.5 m short). Since SIM_VERSION 83
// the player's walker runs the original's state machine (the reset's step
// without control, each move finishing the legs' step before the next, a
// jump after its wind-up): it goes down twice, at 109 s and 137 s, and the
// captain's tanks still do not breach. Since SIM_VERSION 84 the captain's
// queues poll on the original's engine-tick countdowns: the same ten tanks and
// a jet, the claim, and the player down twice (98 s, 122 s); no breach. Since
// SIM_VERSION 87 a turret gun whose target is gone turns back to its rest yaw:
// the same ten tanks, the jet and the claim, the player down twice (96 s,
// 134 s); no breach. Since SIM_VERSION 99 the ring's grates carry a walker
// (convert.ts coverPits): the same ten tanks, the jet and the claim, the
// player down twice (94 s, 114 s), and between those it shoots the captain
// down (113 s); no breach. Since SIM_VERSION 100 every feature stands on the original's
// surface: the same beats. Since SIM_VERSION 102 the captain's missile and bomb
// fly at the original's speeds (the bomb on its arc): the same ten tanks, the
// jet and the claim, the player down twice, and the player no longer shoots the
// captain down; no breach.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_BREACH, EV_CLAIM, EV_DEATH, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

describe("golden-04-warden beats", () => {
  it("the Sky Captain roams, buys and claims, and downs the player holding its gate", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-04-warden.mrep"))),
    );
    expect(replay.mapId).toBe("urban-jungle");
    expect(replay.wardenPlayer).toBe(1);
    expect(replay.wardenDifficulty).toBe(3);
    const sim = createSim(getMapById(replay.mapId), replay.seed, {
      wardenPlayer: replay.wardenPlayer,
      wardenDifficulty: replay.wardenDifficulty,
      difficulties: replay.difficulties,
    });
    const inputs = createTickInputs();

    const bought = new Map<number, number>();
    let claims = 0;
    let wardenDeaths = 0;
    let avatarDeaths = 0;
    let breachTick = -1;
    let breachTeam = -1;

    for (let t = 0; t < replay.tickCount; t++) {
      readFrame(replay, t, inputs);
      step(sim, inputs);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = sim.events.data[o];
        if (type === EV_PURCHASE) {
          expect(sim.events.data[o + 2]).toBe(1); // only the captain buys
          const a = sim.events.data[o + 3];
          bought.set(a, (bought.get(a) ?? 0) + 1);
        } else if (type === EV_CLAIM) {
          claims += 1;
          expect(sim.events.data[o + 2]).toBe(1);
        } else if (type === EV_DEATH) {
          const archetype = sim.events.data[o + 3];
          if (archetype === ARCHETYPE.WARDEN) wardenDeaths += 1;
          if (archetype === ARCHETYPE.AVATAR) avatarDeaths += 1;
        } else if (type === EV_BREACH && breachTick < 0) {
          breachTick = t;
          breachTeam = sim.events.data[o + 2];
        }
      }
    }

    expect(bought.get(ARCHETYPE.RUNNER)).toBe(10);
    expect(bought.get(ARCHETYPE.GUARDIAN)).toBe(1);
    expect(claims).toBe(1);
    expect(wardenDeaths).toBe(0);
    expect(avatarDeaths).toBe(2);
    expect(breachTick).toBe(-1);
    expect(breachTeam).toBe(-1);
    expect(sim.winner).toBe(-1);
  });
});
