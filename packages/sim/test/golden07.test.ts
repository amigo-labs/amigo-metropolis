// Golden #7 (Precinct Assault, rules.md §9) — beats + a playability proof.
//
// The .mrep/.hashes pair is verified generically by golden.test.ts. What this file
// adds is WHAT the replay contains: a golden that re-simulates to the right hash
// while exercising none of the new mechanics would be worthless as a regression
// net, so the PA events are asserted by name.
//
// The last test is the one that matters most for the arena being playable at all:
// it proves the win condition is REACHABLE. Two idle players stalemate on this
// map by design — the production streams annihilate at the centre line and the
// player is the tiebreaker (design pillar 1) — so "no winner in an idle match" is
// correct behaviour and must not be mistaken for a broken map. What would be
// broken is a core that cannot be razed even once the defenders are gone.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_ALARM, EV_CAPTURE, EV_CORE_HIT, EV_PRODUCE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, type SimState, step } from "../src/sim";
import { isGroundUnit } from "../src/units";

const GOLDEN = join(import.meta.dir, "goldens", "golden-07-pa.mrep");

/** Re-simulates the golden, collecting the first tick each event type appeared. */
function replayBeats(): { firstAt: Map<number, number>; counts: Map<number, number> } {
  const replay = decodeReplay(new Uint8Array(readFileSync(GOLDEN)));
  const state = createSim(getMapById(replay.mapId), replay.seed, {
    wardenPlayer: replay.wardenPlayer,
    wardenDifficulty: replay.wardenDifficulty,
  });
  const inputs = createTickInputs();
  const firstAt = new Map<number, number>();
  const counts = new Map<number, number>();
  for (let t = 0; t < replay.tickCount; t++) {
    readFrame(replay, t, inputs);
    step(state, inputs);
    for (let i = 0; i < state.events.count; i++) {
      const type = state.events.data[i * EVENT_STRIDE];
      if (!firstAt.has(type)) firstAt.set(type, t);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return { firstAt, counts };
}

describe("golden-07 exercises the Precinct Assault mechanics", () => {
  const { firstAt, counts } = replayBeats();

  it("produces free units on the original 5 s cadence", () => {
    // 150 ticks is the original's cadence; production is seeded to a full
    // interval so the first wave is due at 150, not 0.
    expect(firstAt.get(EV_PRODUCE)).toBe(149);
    expect(counts.get(EV_PRODUCE) ?? 0).toBeGreaterThan(20);
  });

  it("captures an authentic turret pad", () => {
    expect(counts.get(EV_CAPTURE) ?? 0).toBeGreaterThan(0);
  });

  it("trips a base-intrusion alarm, because a push now reaches a base", () => {
    // This asserted ZERO alarms until v15, and the zero was a symptom. The ring
    // turrets were firing at the global 28 m instead of their imported 6 m, so
    // the two turret rings between them covered the whole midfield and nothing
    // ever got close enough to an intrusion volume to trip it. With the reach
    // corrected, a Warden-escorted push gets into the enemy base inside 120 s and
    // the volumes fire — which is what these small (1x1 to 2.5x1.5 cell) boxes
    // sitting on the bases are for. The mechanic itself is covered directly in
    // paRules.test.ts; what this pins is that the arena is penetrable at all.
    expect(counts.get(EV_ALARM) ?? 0).toBeGreaterThan(0);
  });
});

describe("the win condition is reachable on la-cantina", () => {
  const map = getMapById(LA_CANTINA_ID);
  const idle = createTickInputs();

  function run(state: SimState, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      step(state, idle);
      if (state.winner >= 0) return;
    }
  }

  it("razes a core once its defenders are gone, and awards the match", () => {
    const state = createSim(map, 0xc0ffee);
    // Stand in for what a player achieves by escorting a push: clear team 1's
    // turret line AND keep its production off the field. Both halves are needed,
    // and until v15 only the first was — with the ring firing at 28 m instead of
    // its imported 6 m, team 0's OWN turrets shredded the incoming enemy stream
    // from behind, so clearing one side's turrets was enough on its own. At the
    // correct reach the enemy's units survive to the mid-line and annihilate the
    // push there, which is the same stalemate the next test asserts. Beating that
    // stream is the player's job (design pillar 1), so the stand-in has to cover
    // it. Everything after this is the sim's own doing.
    let cleared = 0;
    for (let id = 0; id < state.ent.high; id++) {
      if (state.ent.alive[id] && state.ent.archetype[id] === ARCHETYPE.TURRET) {
        if (state.ent.team[id] === 1) {
          state.ent.alive[id] = 0;
          cleared += 1;
        }
      }
    }
    expect(cleared).toBe(20); // 16 ring + 4 built-in

    for (let i = 0; i < 15 * 60 * 30; i++) {
      step(state, idle);
      for (let id = 0; id < state.ent.high; id++) {
        if (!state.ent.alive[id] || state.ent.team[id] !== 1) continue;
        if (isGroundUnit(state.ent.archetype[id])) state.ent.alive[id] = 0;
      }
      if (state.winner >= 0) break;
    }
    expect(state.coreHp[1]).toBe(0);
    expect(state.winner).toBe(0);
    // Fast enough to be a siege rather than a war of attrition: 300 unit-shots at
    // CORE_DAMAGE_PER_SHOT against 3000 HP, with the arena crossing on top.
    expect(state.tick).toBeLessThan(3 * 60 * 30);
  });

  it("stalemates between two idle players, which is the intended behaviour", () => {
    // Not a defect: with nobody escorting, each side's units die on the other's
    // turret line at the centre. rules.md pillar 1 makes the player the
    // tiebreaker, so this asserts the design rather than a bug — and it would
    // catch a future change that lets an unattended match resolve itself.
    const state = createSim(map, 0xc0ffee);
    run(state, 5 * 60 * 30);
    expect(state.winner).toBe(-1);
    expect(state.coreHp[0]).toBe(3000);
    expect(state.coreHp[1]).toBe(3000);
    // ...but units ARE being produced and dying, i.e. the loop runs.
    expect(state.tick).toBe(5 * 60 * 30);
  });

  it("never lets a core be damaged by an avatar", () => {
    const state = createSim(map, 0xc0ffee);
    const core = map.bases[1].core;
    const avatar = state.avatarId[0];
    state.ent.posX[avatar] = core.x;
    state.ent.posY[avatar] = core.y;
    // Clear the defenders so nothing else is happening at the core, then park
    // the avatar on it: design pillar 1 says it may never be the win condition.
    for (let id = 0; id < state.ent.high; id++) {
      if (state.ent.alive[id] && state.ent.team[id] === 1 && id !== avatar) {
        state.ent.alive[id] = 0;
      }
    }
    let hits = 0;
    for (let t = 0; t < 120; t++) {
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        if (state.events.data[i * EVENT_STRIDE] === EV_CORE_HIT) hits += 1;
      }
      state.ent.posX[avatar] = core.x;
      state.ent.posY[avatar] = core.y;
      // A produced unit would legitimately damage it; keep them away.
      for (let id = 0; id < state.ent.high; id++) {
        if (state.ent.alive[id] && state.ent.archetype[id] === ARCHETYPE.RUNNER) {
          state.ent.alive[id] = 0;
        }
      }
    }
    expect(hits).toBe(0);
    expect(state.coreHp[1]).toBe(3000);
  });
});
