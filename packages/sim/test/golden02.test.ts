// Golden #2 (Phase 1 DoD): beyond the hash-sequence check in golden.test.ts,
// assert the combat script actually exercises every Phase 1 system — kill,
// death, respawn, both movement modes, open-water hover, jumps, explosions.
// If a balance retune shifts the script off these beats, this fails and the
// script needs adjusting WITH the regenerated golden.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_DEATH, EV_EXPLOSION, EV_RESPAWN, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById, isWater } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { ANIM_AIRBORNE, createSim, MODE_HOVER, step } from "../src/sim";

describe("golden-02-combat beats", () => {
  it("covers kill, death, respawn, hover, water, jumps and explosions", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-02-combat.mrep"))),
    );
    expect(replay.mapId).toBe("district-01");
    const map = getMapById(replay.mapId);
    const sim = createSim(map, replay.seed);
    const inputs = createTickInputs();

    let turretKills = 0;
    let avatarDeaths = 0;
    let avatarRespawns = 0;
    let dummyRespawns = 0;
    let hoverTicks = 0;
    let overWaterTicks = 0;
    let jumps = 0;
    let explosions = 0;
    let prevAirborne = false;

    for (let t = 0; t < replay.tickCount; t++) {
      readFrame(replay, t, inputs);
      step(sim, inputs);
      const a = sim.avatarId[0];
      if (a >= 0) {
        if (sim.ent.mode[a] === MODE_HOVER) {
          hoverTicks += 1;
          if (isWater(map, sim.ent.posX[a], sim.ent.posY[a])) overWaterTicks += 1;
        } else {
          const airborne = (sim.ent.animState[a] & ANIM_AIRBORNE) !== 0;
          if (airborne && !prevAirborne) jumps += 1;
          prevAirborne = airborne;
        }
      }
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = sim.events.data[o];
        if (type === EV_DEATH) {
          if (sim.events.data[o + 3] === ARCHETYPE.TURRET) turretKills += 1;
          if (sim.events.data[o + 3] === ARCHETYPE.AVATAR) avatarDeaths += 1;
        } else if (type === EV_RESPAWN) {
          if (sim.events.data[o + 2] >= 0) avatarRespawns += 1;
          else dummyRespawns += 1;
        } else if (type === EV_EXPLOSION) {
          explosions += 1;
        }
      }
    }

    expect(turretKills).toBeGreaterThanOrEqual(1);
    expect(sim.points[0]).toBeGreaterThanOrEqual(2);
    expect(avatarDeaths).toBeGreaterThanOrEqual(1);
    expect(avatarRespawns).toBeGreaterThanOrEqual(1);
    expect(dummyRespawns).toBeGreaterThanOrEqual(1);
    expect(hoverTicks).toBeGreaterThan(300); // sustained hover phase
    expect(overWaterTicks).toBeGreaterThan(50); // genuine open-water crossing
    expect(jumps).toBeGreaterThanOrEqual(2);
    expect(explosions).toBeGreaterThanOrEqual(3); // heavy + special detonations
  });
});
