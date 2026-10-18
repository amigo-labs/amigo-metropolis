// The results page's figures (fcop-fidelity.md V7): the original's twenty
// `player_stat` keys (retail 0x004480d0, RE game/actor/player_stat.c), counted
// per side in hashed sim state and read through writeResultsSnapshot.
//
// The original keeps them in three places, and so does Metropolis:
//  - twelve halfwords per side (keys 0..0xb; a player's view block +0x00, the
//    Sky Captain's `sky_ai` +0x28): the unit rows' Created / Destroyed, Turrets
//    Destroyed / Claimed, Walker Kills / Deaths (SimState.statHalves);
//  - three mission-state words per side: Outposts Claimed (word 33 + slot, the
//    outposts a side holds: claims are permanent), Current Points (25 + slot,
//    SimState.points) and Points Scored (31 + slot, SimState.pointsScored);
//  - two stamps and two timers on the frame clock (FRAME_CLOCK_PER_TICK): First
//    Death and First Outpost, Time as Walker and Time as Hovercraft
//    (SimState.firstDeath, firstOutpost, formTime).
//
// What raises each one, and when, is the RE's results.json `stats[]` and the C
// it cites; the comments at each writer in sim.ts name the address.

import { ARCHETYPE } from "./archetypes";
import { FRAME_CLOCK_PER_TICK, MAX_PLAYERS } from "./balance";
import type { SimState } from "./sim";

/** player_stat keys, the results page's vocabulary (RE fcop/actor_player.h). */
export const STAT_TANKS_DESTROYED = 0;
export const STAT_TANKS_CREATED = 1;
export const STAT_JETS_DESTROYED = 2;
export const STAT_JETS_CREATED = 3;
export const STAT_DREADNOUGHTS_DESTROYED = 4;
export const STAT_DREADNOUGHTS_CREATED = 5;
export const STAT_FORTRESSES_DESTROYED = 6;
export const STAT_FORTRESSES_CREATED = 7;
/** Captured neutral turrets this side held that died ("Destroyed" is a side's loss). */
export const STAT_TURRETS_DESTROYED = 8;
/** Neutral turrets this side captured (its mech, its tanks or the Sky Captain). */
export const STAT_TURRETS_CLAIMED = 9;
/** Mechs this side's own craft put down (the other X1, or the Sky Captain). */
export const STAT_WALKER_KILLS = 10;
/** Times this side's mech (or Sky Captain) went down, any cause. */
export const STAT_WALKER_DEATHS = 11;
export const STAT_OUTPOSTS_CLAIMED = 12;
export const STAT_CURRENT_POINTS = 13;
export const STAT_POINTS_SCORED = 14;
export const STAT_FIRST_DEATH = 15;
export const STAT_FIRST_OUTPOST = 16;
export const STAT_TIME_WALKER = 17;
export const STAT_TIME_HOVER = 18;
export const STAT_TOTAL_TIME = 19;
/** Keys per side. */
export const STAT_KEYS = 20;
/** Keys 15 and up are times on the frame clock (300 units a second). */
export const STAT_FIRST_TIME_KEY = STAT_FIRST_DEATH;
/** The halfword run, keys 0..11 (SimState.statHalves stride). */
export const STAT_HALVES = 12;

/** The results snapshot: STAT_KEYS floats per player slot, slot-major. */
export const RESULTS_SNAPSHOT_LEN = MAX_PLAYERS * STAT_KEYS;

/** Offset of slot `s`'s block in the results snapshot. */
export function resultsSlotOffset(slot: number): number {
  return slot * STAT_KEYS;
}

/** The frame clock at the end of the running tick: tick n's events stamp n + 1 ticks. */
export function statClock(state: SimState): number {
  return (state.tick + 1) * FRAME_CLOCK_PER_TICK;
}

/** One more of halfword `key` for side `team`; a halfword, so it wraps as the original's. */
export function bumpStat(state: SimState, team: number, key: number): void {
  if (team !== 0 && team !== 1) return;
  const at = team * STAT_HALVES + key;
  state.statHalves[at] = state.statHalves[at] + 1;
}

/**
 * A unit's class row, the original's Csac class byte: tank 1, jet 2,
 * Dreadnought 3, Flying Fortress 4 — Metropolis' RUNNER..FORTRESS, in order.
 * The Destroyed key is 2 * (class - 1), Created one more. -1 for anything else.
 */
export function unitStatKey(archetype: number, created: boolean): number {
  if (archetype < ARCHETYPE.RUNNER || archetype > ARCHETYPE.FORTRESS) return -1;
  return 2 * (archetype - ARCHETYPE.RUNNER) + (created ? 1 : 0);
}

/**
 * A side's mech (or Sky Captain) went down: its deaths, and its First Death
 * stamped once (`player_op4` 0x00447764 / 0x00447780; the captain's
 * 0x00420df9: sky_ai +0x48 and +0x3e).
 */
export function noteDown(state: SimState, team: number): void {
  if (team !== 0 && team !== 1) return;
  bumpStat(state, team, STAT_WALKER_DEATHS);
  if (state.firstDeath[team] === 0) state.firstDeath[team] = statClock(state);
}

/** Outposts side `team` holds: the original's state word 33 + slot. */
export function outpostsHeld(state: SimState, team: number): number {
  let n = 0;
  for (let k = 0; k < state.outpostOwner.length; k++) if (state.outpostOwner[k] === team) n += 1;
  return n;
}

/**
 * The player tick's two-sided arm (`player_tick` 0x00446f41..0x00446f7c), for
 * each player's live mech — not while it is down, not the Sky Captain: the frame
 * delta into the timer of its form (walker 0, hover 1), and First Outpost
 * stamped once, on the first tick the side holds an outpost.
 */
export function systemStats(state: SimState): void {
  const ent = state.ent;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (p === state.wardenPlayer) continue;
    const a = state.avatarId[p];
    if (a < 0) continue;
    const row = ent.mode[a] !== 0 ? 1 : 0;
    state.formTime[p * 2 + row] += FRAME_CLOCK_PER_TICK;
    if (state.firstOutpost[p] === 0 && outpostsHeld(state, p) > 0) {
      state.firstOutpost[p] = statClock(state);
    }
  }
}

/**
 * Writes each slot's twenty figures into `out` (length RESULTS_SNAPSHOT_LEN) as
 * `player_stat` answers them for that side's block. The Sky Captain's side is
 * the original's NULL block: its halfwords and its two stamps, slot 1's three
 * state words (here its own slot's), 0 for the two form timers, and the
 * player's Total Time for its own (player_stat.c 0x004481c3). Times are frame
 * clock units. A pure read: never hashed, never mutates state.
 */
export function writeResultsSnapshot(state: SimState, out: Float32Array): void {
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    const o = resultsSlotOffset(slot);
    for (let k = 0; k < STAT_HALVES; k++) out[o + k] = state.statHalves[slot * STAT_HALVES + k];
    out[o + STAT_OUTPOSTS_CLAIMED] = outpostsHeld(state, slot);
    out[o + STAT_CURRENT_POINTS] = state.points[slot];
    out[o + STAT_POINTS_SCORED] = state.pointsScored[slot];
    out[o + STAT_FIRST_DEATH] = state.firstDeath[slot];
    out[o + STAT_FIRST_OUTPOST] = state.firstOutpost[slot];
    const captain = slot === state.wardenPlayer;
    out[o + STAT_TIME_WALKER] = captain ? 0 : state.formTime[slot * 2];
    out[o + STAT_TIME_HOVER] = captain ? 0 : state.formTime[slot * 2 + 1];
    const of = captain ? slot ^ 1 : slot;
    out[o + STAT_TOTAL_TIME] = state.formTime[of * 2] + state.formTime[of * 2 + 1];
  }
}
