// Golden #3 (match): beyond the hash-sequence check in golden.test.ts, assert
// the two-player match on la-cantina plays out. Both players walk to their own
// ground consoles and buy five tanks, one per press; then they meet in the
// middle and fight with every weapon, each walking back out after its respawns.
// The tanks drive the original's roads into each other and the rings, and the
// downs are paid at the respawn (fcop-fidelity.md R4). Whether a tank slips
// through a ring is the roads' coin flips: pinned below as recorded (the gate-box
// win, its outro and the freeze are golden07.test's to prove).
// Since district-01 left the game (wave 2, 2026-10-14) this replaces the
// district-01 mini-match. The script steers by the live state at recording time.
// If a rule change shifts the match off these beats, this fails and the script
// needs adjusting WITH the regenerated golden (and a new pin).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_BREACH, EV_DEATH, EV_PURCHASE, EV_RESPAWN, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

// Pinned after recording; regenerate together with the golden.
// 3349 -> 1438 at SIM_VERSION 55: captures measured by the original's
// octagonal estimate change which plate guns the tanks take on the way.
// 1438 -> none at SIM_VERSION 60: the heavy-zone poll's draw at createSim moves
// the PRNG stream, and no tank's route gets through (2 of seeds c0ffee/1-7
// breach, both by player 0's tanks).
// none -> 2498 at SIM_VERSION 69: both players drive on the original's
// buttons, turning toward each route cell before they walk it, and fire Special
// from its latch's held state, so the fight in the middle plays out
// differently; one of player 0's tanks gets through player 1's ring at 83 s.
// 2498 -> none at SIM_VERSION 78: every hit radius is the original's (the mech
// 0.553 m walking, was 0.4; the tank 0.943, was 0.76), so the fight's and the
// rings' rounds find more: the mechs go down 11 times in the 200 s (were 5), both
// rings lose a turret, and all ten tanks die short of the gates (the nearest 19 m
// off; player 0's breaching tank was killed at 25.6 m).
// none -> 2483 at SIM_VERSION 79: la-cantina's teams take the original's player
// slots, so each player starts, buys and fights from the other base; the mechs
// go down 5 times, nine tanks die, and one of player 1's gets through player 0's
// ring into the gate box at 82.8 s (player 0's nearest came to 21.4 m).
// 2483 -> 2289 at SIM_VERSION 83: the mechs walk on the original's walker state
// machine (the reset's step without control, each move finishing the legs' step
// before the next, the jumps after their wind-ups), so the fight in the middle
// plays out differently: the mechs go down 4 times, and one of player 0's tanks
// gets through player 1's ring into the gate box at 76.3 s.
// 2289 -> none at SIM_VERSION 84: the spawn queues poll on the original's
// engine-tick countdowns (from `rand % period`, periods no longer rounded to
// sim ticks), so each side's five tanks leave on other ticks and meet the fight
// and the rings otherwise: all ten die short of the gates (player 0's nearest
// came to 20.7 m, player 1's to 31.8 m), and the mechs go down 12 times.
// none as before at SIM_VERSION 86: the turrets stand at their record's yaw
// (pi/2 - a until then); the mechs still go down 12 times, the ten tanks die
// short (player 0's nearest now 29.4 m off, player 1's 31.6 m).
// none as before at SIM_VERSION 87: a turret gun whose target is gone turns
// back to its rest yaw (it kept its last aim); the mechs still go down 12
// times, the ten tanks die short (player 0's nearest 27.4 m off, player 1's
// 31.7 m), and one ring turret falls (none did).
// 2316 at SIM_VERSION 94: la-cantina's ground keeps its kerbs (stage 2's carve
// had written the bare lattice back over them), so player 0's tanks drive the
// original's kerbed streets through to the gate and breach at 77.2 s; the mechs
// go down 4 times.
// 2217 at SIM_VERSION 106: the turrets pitch, fire from their gun's muzzle and
// test their arc in three dimensions, and the Dreadnought's level guns refuse
// what lies more than 22.5° below them (fcop-fidelity.md G12, I6); the fights
// play differently and player 0's tank breaches at 79.8 s.
// 2363 at SIM_VERSION 107: a capture is asked only of a pair the broad phase's
// 4 m cells offer (fcop-fidelity.md R12), so the script's first capture comes
// later (the replay diverges at tick 821) and player 0's tanks breach at 78.8 s.
// 2309 with both (77.0 s).
// 2316 -> none at SIM_VERSION 108: a wall stops a mech's move with the
// original's push back off it and turns its facing along it, and the hover
// rides its slopes on the ground, so the script's walks and the fight play out
// otherwise: the mechs go down 11 times and all ten tanks die short of the gates.
// 2395 on top of SIM_VERSION 105-107 (79.8 s): player 0's tank breaches again,
// the mechs go down 4 times.
// 2921 at SIM_VERSION 111: the tanks walk the original's route cursor (a leg
// ahead, the corners cut, the legs' approximate lengths; fcop-fidelity.md U1);
// player 0's tank breaches at 97.4 s, the mechs go down 5 times.
// 2265 at SIM_VERSION 112: a round meets a body by the original's pair test
// (its own model's hit boxes against the body's, the mech's legs and cockpit by
// frame) and the reference points stand at their boxes' centres; player 0's
// tank breaches at 75.5 s, the mechs go down 3 times.
const BREACH_TICK_PIN = 2265;
const BREACH_TEAM_PIN = 0;

describe("golden-03-match beats", () => {
  it("purchases on both sides, fights, downs paid at the respawn, the breach as pinned", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-03-match.mrep"))),
    );
    expect(replay.mapId).toBe("la-cantina");
    const sim = createSim(getMapById(replay.mapId), replay.seed);
    const inputs = createTickInputs();

    const purchases = [0, 0];
    const respawns = [0, 0];
    let avatarDeaths = 0;
    let runnerDeaths = 0;
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
          expect(sim.events.data[o + 3]).toBe(ARCHETYPE.RUNNER);
        } else if (type === EV_RESPAWN) {
          const p = sim.events.data[o + 2];
          if (p >= 0) respawns[p] += 1;
        } else if (type === EV_DEATH) {
          const archetype = sim.events.data[o + 3];
          if (archetype === ARCHETYPE.AVATAR) avatarDeaths += 1;
          if (archetype === ARCHETYPE.RUNNER) runnerDeaths += 1;
        } else if (type === EV_BREACH) {
          breaches += 1;
          breachTick = t;
          breachTeam = sim.events.data[o + 2];
        }
      }
    }

    expect(purchases).toEqual([5, 5]);
    // Both go down, and come back every time.
    expect(avatarDeaths).toBeGreaterThanOrEqual(2);
    expect(respawns[0]).toBeGreaterThanOrEqual(1);
    expect(respawns[1]).toBeGreaterThanOrEqual(1);
    expect(runnerDeaths).toBeGreaterThanOrEqual(3);
    // The breach as recorded: player 0's tank at 79.8 s since SIM_VERSION 106
    // (77.2 s from 94; none from 84; the same side's at 82.8 s from 79).
    expect(breaches).toBe(BREACH_TICK_PIN < 0 ? 0 : 1);
    expect(breachTick).toBe(BREACH_TICK_PIN);
    expect(breachTeam).toBe(BREACH_TICK_PIN < 0 ? -1 : BREACH_TEAM_PIN);
    expect(sim.winner).toBe(BREACH_TICK_PIN < 0 ? -1 : BREACH_TEAM_PIN);
  });
});
