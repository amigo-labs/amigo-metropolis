// writeMatchSnapshot: the per-match half of the sim -> renderer contract
// (architecture.md §3). The HUD reads this instead of reaching into SimState,
// so the two things that matter are that the numbers are right and that
// producing them cannot disturb the sim.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import {
  createSim,
  hash,
  MATCH_ENTITY_COUNT,
  MATCH_SLOT_AMMO_HEAVY,
  MATCH_SLOT_AMMO_SPECIAL,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_OUTPOSTS,
  MATCH_SLOT_POINTS,
  MATCH_SLOT_RESPAWN_TICKS,
  MATCH_SLOT_UNITS,
  MATCH_SNAPSHOT_LEN,
  MATCH_TICK,
  MATCH_WINNER,
  matchSlotOffset,
  SNAPSHOT_STRIDE,
  step,
  writeMatchSnapshot,
  writeSnapshot,
} from "../src/sim";

function freshSim() {
  return createSim(getMapById("urban-jungle"), 12345);
}

describe("writeMatchSnapshot", () => {
  it("cannot move the sim hash", () => {
    // The whole reason the HUD may use this: it is a read. If writing a match
    // snapshot could perturb state, every golden would be at its mercy.
    const sim = freshSim();
    const inputs = createTickInputs();
    for (let i = 0; i < 40; i++) step(sim, inputs);

    const before = hash(sim);
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    for (let i = 0; i < 5; i++) writeMatchSnapshot(sim, out);
    expect(hash(sim)).toBe(before);
  });

  it("reports tick, winner and both scores", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    for (let i = 0; i < 25; i++) step(sim, inputs);

    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);

    expect(out[MATCH_TICK]).toBe(sim.tick);
    expect(out[MATCH_WINNER]).toBe(sim.winner);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_POINTS]).toBe(sim.points[0]);
    expect(out[matchSlotOffset(1) + MATCH_SLOT_POINTS]).toBe(sim.points[1]);
  });

  it("agrees with the entity snapshot on live count and unit counts", () => {
    // The old text HUD counted units by scanning the entity snapshot for
    // archetypes RUNNER..FORTRESS. Both readouts are on screen together under
    // ?debug, so a disagreement would be visible — pin them to each other.
    const sim = freshSim();
    const inputs = createTickInputs();
    for (let i = 0; i < 120; i++) step(sim, inputs);

    const entities = new Float32Array(4096 * SNAPSHOT_STRIDE);
    const count = writeSnapshot(sim, entities);
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);

    expect(out[MATCH_ENTITY_COUNT]).toBe(count);

    const expected = [0, 0];
    for (let i = 0; i < count; i++) {
      const o = i * SNAPSHOT_STRIDE;
      const archetype = entities[o + 1];
      const team = entities[o + 2];
      if (archetype >= ARCHETYPE.RUNNER && archetype <= ARCHETYPE.FORTRESS) {
        if (team === 0 || team === 1) expected[team] += 1;
      }
    }
    expect(out[matchSlotOffset(0) + MATCH_SLOT_UNITS]).toBe(expected[0]);
    expect(out[matchSlotOffset(1) + MATCH_SLOT_UNITS]).toBe(expected[1]);
  });

  it("reports the live avatar's health as a fraction and its ammo", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    step(sim, inputs);

    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    const o = matchSlotOffset(0);

    expect(out[o + MATCH_SLOT_AVATAR_ID]).toBe(sim.avatarId[0]);
    // Untouched at tick 1, so full health — and a fraction, not raw hp.
    expect(out[o + MATCH_SLOT_HP_FRAC]).toBe(1);
    expect(out[o + MATCH_SLOT_AMMO_HEAVY]).toBe(sim.ent.ammoA[sim.avatarId[0]]);
    expect(out[o + MATCH_SLOT_AMMO_SPECIAL]).toBe(sim.ent.ammoB[sim.avatarId[0]]);
    expect(out[o + MATCH_SLOT_RESPAWN_TICKS]).toBe(0);
  });

  it("reports zero health and the respawn timer while dead", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    step(sim, inputs);

    // Kill the avatar outright, then let the death be processed.
    const a = sim.avatarId[0];
    sim.ent.hp[a] = 0;
    step(sim, inputs);

    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    const o = matchSlotOffset(0);

    expect(sim.avatarId[0]).toBe(-1);
    expect(out[o + MATCH_SLOT_AVATAR_ID]).toBe(-1);
    expect(out[o + MATCH_SLOT_HP_FRAC]).toBe(0);
    expect(out[o + MATCH_SLOT_RESPAWN_TICKS]).toBe(sim.respawnTimer[0]);
    expect(out[o + MATCH_SLOT_RESPAWN_TICKS]).toBeGreaterThan(0);
  });

  it("counts outposts per owning slot and ignores neutral ones", () => {
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);

    expect(sim.outpostOwner.length).toBeGreaterThan(1);
    sim.outpostOwner.fill(-1);
    sim.outpostOwner[0] = 0;
    sim.outpostOwner[1] = 1;
    writeMatchSnapshot(sim, out);

    expect(out[matchSlotOffset(0) + MATCH_SLOT_OUTPOSTS]).toBe(1);
    expect(out[matchSlotOffset(1) + MATCH_SLOT_OUTPOSTS]).toBe(1);
  });

  it("overwrites every field, so a reused buffer never shows a stale value", () => {
    // main.ts keeps one buffer for the whole match and refills it each tick.
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN).fill(999);
    writeMatchSnapshot(sim, out);
    expect(Array.from(out).some((v) => v === 999)).toBe(false);
  });
});
