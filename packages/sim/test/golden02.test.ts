// Golden #2 (combat): beyond the hash-sequence check in golden.test.ts, assert
// the combat script actually exercises what it is for — a kill with every
// weapon in turn, both movement modes and the change between them, jumps and
// blasts. Since district-01 left the game (wave 2 of the original-only rule,
// 2026-10-14) it runs on urban-jungle, steering by the live state at recording
// time. If a rule change shifts the script off these beats, this fails and the
// script needs adjusting WITH the regenerated golden.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { STARTING_POINTS } from "../src/balance";
import { EV_DEATH, EV_EXPLOSION, EV_TRANSFORM, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { ANIM_AIRBORNE, createSim, MODE_HOVER, step } from "../src/sim";

describe("golden-02-combat beats", () => {
  it("covers a turret kill, hover, the change both ways, jumps and explosions", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-02-combat.mrep"))),
    );
    expect(replay.mapId).toBe("urban-jungle");
    const map = getMapById(replay.mapId);
    const sim = createSim(map, replay.seed);
    const inputs = createTickInputs();

    let turretKills = 0;
    let transforms = 0;
    let hoverTicks = 0;
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
        } else {
          const airborne = (sim.ent.animState[a] & ANIM_AIRBORNE) !== 0;
          if (airborne && !prevAirborne) jumps += 1;
          prevAirborne = airborne;
        }
      }
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = sim.events.data[o];
        if (type === EV_DEATH && sim.events.data[o + 3] === ARCHETYPE.TURRET) turretKills += 1;
        else if (type === EV_TRANSFORM) transforms += 1;
        else if (type === EV_EXPLOSION) explosions += 1;
      }
    }

    // A neutral plate gun: it pays nobody (fcop-fidelity.md R4), so nothing moves
    // the balances.
    expect(turretKills).toBe(1);
    expect(sim.points[0]).toBe(STARTING_POINTS);
    expect(sim.points[1]).toBe(STARTING_POINTS);
    expect(transforms).toBe(2); // to hover and back
    expect(hoverTicks).toBeGreaterThan(300); // a sustained hover phase
    expect(jumps).toBeGreaterThanOrEqual(2);
    expect(explosions).toBeGreaterThanOrEqual(3); // heavy + special detonations
  });
});
