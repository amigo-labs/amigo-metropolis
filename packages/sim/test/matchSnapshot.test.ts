// writeMatchSnapshot: the per-match half of the sim -> renderer contract
// (architecture.md §3). The HUD reads this instead of reaching into SimState,
// so the two things that matter are that the numbers are right and that
// producing them cannot disturb the sim.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { BTN_FORWARD, createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import {
  createSim,
  hash,
  MATCH_ENTITY_COUNT,
  MATCH_OUTRO_LEFT,
  MATCH_OUTRO_WINNER,
  MATCH_SLOT_AMMO_GUN,
  MATCH_SLOT_AMMO_HEAVY,
  MATCH_SLOT_AMMO_SPECIAL,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_HP_MAX,
  MATCH_SLOT_INVULN,
  MATCH_SLOT_ISSUED_GUN,
  MATCH_SLOT_ISSUED_HEAVY,
  MATCH_SLOT_ISSUED_SPECIAL,
  MATCH_SLOT_LOCK,
  MATCH_SLOT_MOVE,
  MATCH_SLOT_OUTPOSTS,
  MATCH_SLOT_POINTS,
  MATCH_SLOT_POWER,
  MATCH_SLOT_RESPAWN_TICKS,
  MATCH_SLOT_TERMINALS,
  MATCH_SLOT_UNITS,
  MATCH_SNAPSHOT_LEN,
  MATCH_SNAPSHOT_SLOT_STRIDE,
  MATCH_TICK,
  MATCH_WINNER,
  MOVE_CUE_DRIVE,
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

  it("carries no capture or buy progress: both are one key press (R12, R17)", () => {
    // MATCH_SLOT_CAPTURE_FRAC (slot field 9) reported a 3 s hold until SIM_VERSION
    // 34, and MATCH_SLOT_BUY_FRAC (field 8) the 0.5 s purchase hold until
    // SIM_VERSION 51. The original captures and sells on one key press, so there
    // is nothing to report and the slot block lost both fields; the Gun magazine,
    // the lock and the power bits follow the units count, then the movement
    // command the original's sounds are chosen from, and last (SIM_VERSION 80)
    // whether the base's heavy terminals stand; then the issued magazines, the
    // health the fraction is of and the invulnerability left (pure reads).
    expect(MATCH_SLOT_UNITS).toBe(7);
    expect(MATCH_SLOT_AMMO_GUN).toBe(8);
    expect(MATCH_SLOT_LOCK).toBe(9);
    expect(MATCH_SLOT_POWER).toBe(10);
    expect(MATCH_SLOT_MOVE).toBe(11);
    expect(MATCH_SLOT_TERMINALS).toBe(12);
    expect(MATCH_SLOT_ISSUED_GUN).toBe(13);
    expect(MATCH_SLOT_ISSUED_HEAVY).toBe(14);
    expect(MATCH_SLOT_ISSUED_SPECIAL).toBe(15);
    expect(MATCH_SLOT_HP_MAX).toBe(16);
    expect(MATCH_SLOT_INVULN).toBe(17);
    expect(MATCH_SNAPSHOT_SLOT_STRIDE).toBe(18);
  });

  it("reports the avatar's movement command, which the original's sounds follow", () => {
    const sim = createSim(getMapById("la-cantina"), 3);
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_FORWARD;
    step(sim, inputs);
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_MOVE] & MOVE_CUE_DRIVE).toBe(MOVE_CUE_DRIVE);
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_MOVE] & MOVE_CUE_DRIVE).toBe(0);
  });

  it("reports the post-breach outro, and nothing while none runs", () => {
    // Replaces the core-HP bars (MATCH_SLOT_CORE_FRAC): the original has no core
    // (fcop-fidelity.md R1). What the HUD can show instead is the breach that
    // decided the match while the outro plays.
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    expect(out[MATCH_OUTRO_LEFT]).toBe(0);
    expect(out[MATCH_OUTRO_WINNER]).toBe(-1);

    sim.outroTimer = 100;
    sim.outroWinner = 1;
    writeMatchSnapshot(sim, out);
    expect(out[MATCH_OUTRO_LEFT]).toBe(100);
    expect(out[MATCH_OUTRO_WINNER]).toBe(1);
  });

  it("reports the Gun magazine and the lock (fcop-fidelity.md W1, W2)", () => {
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    sim.gunAmmo[0] = 1234;
    sim.lockTarget[0] = sim.avatarId[1];
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_AMMO_GUN]).toBe(1234);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_LOCK]).toBe(sim.avatarId[1]);
    sim.lockTarget[0] = -1;
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_LOCK]).toBe(-1);
  });

  it("reports a powered slot and counts its block-B magazine (fcop-fidelity.md P8)", () => {
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_POWER]).toBe(0);
    sim.powerAmmo[1] = 18; // player 0's Heavy
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_POWER]).toBe(2);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_AMMO_HEAVY]).toBe(18);
  });

  it("reports the issued magazines while a slot fires its block B (hud_weapons.c)", () => {
    // The HUD's lower count is block A always; the ammo fields count the
    // magazine the slot fires from, which is block B while powered.
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    const a = sim.avatarId[0];
    sim.gunAmmo[0] = 400;
    sim.ent.ammoA[a] = 12;
    sim.ent.ammoB[a] = 3;
    sim.powerAmmo[0] = 90;
    sim.powerAmmo[1] = 18;
    writeMatchSnapshot(sim, out);
    const o = matchSlotOffset(0);
    expect(out[o + MATCH_SLOT_AMMO_GUN]).toBe(90);
    expect(out[o + MATCH_SLOT_ISSUED_GUN]).toBe(400);
    expect(out[o + MATCH_SLOT_AMMO_HEAVY]).toBe(18);
    expect(out[o + MATCH_SLOT_ISSUED_HEAVY]).toBe(12);
    expect(out[o + MATCH_SLOT_AMMO_SPECIAL]).toBe(3);
    expect(out[o + MATCH_SLOT_ISSUED_SPECIAL]).toBe(3);
  });

  it("reports the health the fraction is of and the invulnerability left", () => {
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    const o = matchSlotOffset(0);
    const a = sim.avatarId[0];
    expect(out[o + MATCH_SLOT_HP_MAX]).toBeGreaterThan(0);
    expect(out[o + MATCH_SLOT_HP_FRAC]).toBeCloseTo(sim.ent.hp[a] / out[o + MATCH_SLOT_HP_MAX], 6);
    expect(out[o + MATCH_SLOT_INVULN]).toBe(0);
    sim.buffInvuln[0] = 321;
    writeMatchSnapshot(sim, out);
    expect(out[o + MATCH_SLOT_INVULN]).toBe(321);
  });

  it("overwrites every field, so a reused buffer never shows a stale value", () => {
    // main.ts keeps one buffer for the whole match and refills it each tick.
    const sim = freshSim();
    const out = new Float32Array(MATCH_SNAPSHOT_LEN).fill(999);
    writeMatchSnapshot(sim, out);
    expect(Array.from(out).some((v) => v === 999)).toBe(false);
  });
});
