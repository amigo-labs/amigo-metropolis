// Golden #3 (Phase 2 DoD mini-match, replayed on the Phase 3 economy):
// beyond the hash-sequence check in golden.test.ts, assert the scripted
// match actually plays out — the avatar clears the dummies and base East's
// ring on the enemy-owned-turret bounty, claims the outpost, forward-buys
// runners at 2× and breaches on the KNOWN tick before the ring respawns.
// If a balance retune shifts the match off these beats, this fails and the
// script needs adjusting WITH the regenerated golden (and a new pin).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { COST_OUTPOST_CLAIM, STARTING_POINTS } from "../src/balance";
import { EV_BREACH, EV_CLAIM, EV_DEATH, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

// Pinned after recording; regenerate together with the golden.
const BREACH_TICK_PIN = 2956;

describe("golden-03-match beats", () => {
  it("avatar snipe, outpost claim, forward wave, breach on the pinned tick", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-03-match.mrep"))),
    );
    expect(replay.mapId).toBe("district-01");
    const sim = createSim(getMapById(replay.mapId), replay.seed);
    const inputs = createTickInputs();
    expect(sim.points[0]).toBe(STARTING_POINTS);

    const purchases = [0, 0];
    let claims = 0;
    let claimTick = -1;
    let turretDeaths = 0;
    let runnerDeaths = 0;
    let avatarDeaths = 0;
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
        } else if (type === EV_CLAIM) {
          claims += 1;
          claimTick = t;
          expect(sim.events.data[o + 2]).toBe(0); // player 0 claims
        } else if (type === EV_DEATH) {
          const archetype = sim.events.data[o + 3];
          if (archetype === ARCHETYPE.TURRET) turretDeaths += 1;
          if (archetype === ARCHETYPE.RUNNER) runnerDeaths += 1;
          if (archetype === ARCHETYPE.AVATAR) avatarDeaths += 1;
        } else if (type === EV_BREACH) {
          breaches += 1;
          breachTick = t;
          breachTeam = sim.events.data[o + 2];
        }
      }
    }

    // Player 0 clears 2 dummies + all 4 ring turrets; the avatar survives.
    expect(turretDeaths).toBeGreaterThanOrEqual(6);
    expect(avatarDeaths).toBe(0);
    // The claim is funded by start + trickle + the enemy-owned turret bounty
    // (a 20-point start alone could never cover the 30-point claim).
    expect(claims).toBe(1);
    expect(STARTING_POINTS).toBeLessThan(COST_OUTPOST_CLAIM);
    // Forward runners bought at the outpost; feeders spawned on both sides.
    expect(purchases[0]).toBeGreaterThanOrEqual(4);
    expect(purchases[1]).toBeGreaterThanOrEqual(3);
    expect(runnerDeaths).toBeGreaterThanOrEqual(2); // player 1's feeders die
    // (the last feeder may still be mid-fight when the breach freezes the sim)
    // Exactly one breach, by team 0, after the claim, on the known tick.
    expect(breaches).toBe(1);
    expect(breachTeam).toBe(0);
    expect(breachTick).toBeGreaterThan(claimTick);
    expect(breachTick).toBe(BREACH_TICK_PIN);
    expect(sim.winner).toBe(0);
    // The replay ran well past the breach: the frozen tail is in the golden.
    expect(replay.tickCount).toBeGreaterThan(BREACH_TICK_PIN + 300);
  });
});
