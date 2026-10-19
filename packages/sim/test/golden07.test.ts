// Golden #7 (Precinct Assault, rules.md §9) — beats + a playability proof.
//
// The .mrep/.hashes pair is verified generically by golden.test.ts. What this file
// adds is WHAT the replay contains: a golden that re-simulates to the right hash
// while exercising none of the new mechanics would be worthless as a regression
// net, so the PA events are asserted by name.
//
// The second describe is the one that matters most for the arena being playable
// at all: it proves the win condition is REACHABLE. Since SIM_VERSION 32 that is
// the original's — an enemy Runner (tank) or Juggernaut (Dreadnought) in the gate
// box — and nothing is produced for free, so an idle match is simply quiet. What
// would be broken is a road that cannot carry a unit into the enemy gate once
// the defenders are gone.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { MATCH_OUTRO_TICKS } from "../src/balance";
import { EV_ALARM, EV_BREACH, EV_CAPTURE, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";
import { isGroundUnit } from "../src/units";

const GOLDEN = join(import.meta.dir, "goldens", "golden-07-pa.mrep");

/** Re-simulates the golden, collecting the first tick each event type appeared. */
function replayBeats(): {
  firstAt: Map<number, number>;
  counts: Map<number, number>;
  playerCaptures: number;
} {
  const replay = decodeReplay(new Uint8Array(readFileSync(GOLDEN)));
  const state = createSim(getMapById(replay.mapId), replay.seed, {
    wardenPlayer: replay.wardenPlayer,
    wardenDifficulty: replay.wardenDifficulty,
    difficulties: replay.difficulties,
  });
  const inputs = createTickInputs();
  const firstAt = new Map<number, number>();
  const counts = new Map<number, number>();
  let playerCaptures = 0;
  for (let t = 0; t < replay.tickCount; t++) {
    readFrame(replay, t, inputs);
    step(state, inputs);
    for (let i = 0; i < state.events.count; i++) {
      const type = state.events.data[i * EVENT_STRIDE];
      if (type === EV_CAPTURE && state.events.data[i * EVENT_STRIDE + 2] === 0) playerCaptures += 1;
      if (!firstAt.has(type)) firstAt.set(type, t);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return { firstAt, counts, playerCaptures };
}

describe("golden-07 exercises the Precinct Assault mechanics", () => {
  const { counts, playerCaptures } = replayBeats();

  it("fields only units somebody bought", () => {
    // The original has no free production (fcop-fidelity.md I7): the script's
    // hold at the ground console and the Warden's own purchases are the only
    // source of units, so purchases happen and they are the whole field.
    expect(counts.get(EV_PURCHASE) ?? 0).toBeGreaterThan(0);
  });

  it("captures an authentic turret pad", () => {
    expect(counts.get(EV_CAPTURE) ?? 0).toBeGreaterThan(0);
    // ...and the player's capture is the action-key press (fcop-fidelity.md R12):
    // the script taps it by the (107.5, 129.6) pad, the nearest to side 1's base
    // since SIM_VERSION 79 (it was (94.8, 91.7) from the other base). Until
    // SIM_VERSION 34 every capture here was the Warden's — the scripted avatar
    // was stuck on a wall.
    expect(playerCaptures).toBeGreaterThan(0);
  });

  it("trips a base-intrusion alarm, because a push now reaches a base", () => {
    // This asserted ZERO alarms until v15, and the zero was a symptom: the ring
    // turrets fired at the global 28 m, so nothing ever got close enough to an
    // intrusion volume to trip it. Since v31 the volumes have the original's size
    // (Mp's base zone is 40 x 24 m, not 2.5 x 1.5) and they fire on any enemy
    // avatar or unit inside. The mechanic itself is covered directly in
    // paRules.test.ts; what this pins is that the replay reaches a base at all.
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

  it("carries a Runner into the enemy gate once the defenders are gone", () => {
    const state = createSim(map, 0xc0ffee);
    // Stand in for what a player achieves by escorting a push: clear team 1's
    // turret line. Everything after this is the sim's own doing — one bought
    // Runner driving the original road from its console into the gate.
    let cleared = 0;
    for (let id = 0; id < state.ent.high; id++) {
      if (state.ent.alive[id] && state.ent.archetype[id] === ARCHETYPE.TURRET) {
        if (state.ent.team[id] === 1) {
          state.ent.alive[id] = 0;
          cleared += 1;
        }
      }
    }
    expect(cleared).toBe(8); // the team-unique ring; no guns stand on the base
    // Where a bought tank appears: the base's tank spawner (R18).
    const c = map.bases[0].tankSpawn;
    spawnUnit(state, ARCHETYPE.RUNNER, 0, c.x, c.y, undefined, false, c.layer);

    let breachAt = -1;
    for (let i = 0; i < 5 * 60 * 30; i++) {
      step(state, idle);
      for (let id = 0; id < state.ent.high; id++) {
        if (!state.ent.alive[id] || state.ent.team[id] !== 1) continue;
        if (state.ent.archetype[id] === ARCHETYPE.TURRET) state.ent.alive[id] = 0;
      }
      // The idle defender's avatar is parked out of the Runner's way too: a
      // Runner halts to shoot anything in its reach, and against the original's
      // 1250-HP mech (SIM_VERSION 41) that duel, not the road, would set the time.
      const foe = state.avatarId[1];
      if (foe >= 0) {
        state.ent.posX[foe] = 1;
        state.ent.posY[foe] = 1;
      }
      for (let k = 0; k < state.events.count; k++) {
        if (state.events.data[k * EVENT_STRIDE] === EV_BREACH) breachAt = state.tick;
      }
      if (state.winner >= 0) break;
    }
    expect(state.winner).toBe(0);
    expect(breachAt).toBeGreaterThan(0);
    expect(state.tick - breachAt).toBe(MATCH_OUTRO_TICKS);
    // The road is ~19 s spawner to gate at a Runner's step (enrichArena report),
    // but the original's route followers take a coin at every junction (U1/U2):
    // 96 s at this seed since SIM_VERSION 61.
    expect(breachAt).toBeLessThan(2 * 60 * 30);
  });

  it("an idle match fields nothing and never resolves itself", () => {
    // Not a defect: nothing is produced for free (the original's spawners are
    // shut in PA), so with nobody buying there is nobody to push. rules.md pillar
    // 1 makes the player the tiebreaker; this would catch a future change that
    // lets an unattended match resolve itself.
    const state = createSim(map, 0xc0ffee);
    run(state, 5 * 60 * 30);
    expect(state.winner).toBe(-1);
    expect(state.tick).toBe(5 * 60 * 30);
    for (let id = 0; id < state.ent.high; id++) {
      if (state.ent.alive[id]) expect(isGroundUnit(state.ent.archetype[id])).toBe(false);
    }
  });

  it("never lets an avatar in the enemy gate decide the match", () => {
    // Design pillar 1, and the original's rule: the gate watches tanks and the
    // Dreadnought, not the avatar (fcop-re/ai-and-rules.md §5).
    const state = createSim(map, 0xc0ffee);
    const gate = map.bases[1].gate;
    const avatar = state.avatarId[0];
    for (let id = 0; id < state.ent.high; id++) {
      if (state.ent.alive[id] && state.ent.team[id] === 1 && id !== avatar) {
        state.ent.alive[id] = 0;
      }
    }
    for (let t = 0; t < 120; t++) {
      state.ent.posX[avatar] = gate.x;
      state.ent.posY[avatar] = gate.y;
      step(state, idle);
    }
    expect(state.outroWinner).toBe(-1);
    expect(state.winner).toBe(-1);
  });
});
