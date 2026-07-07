// Replay runner: re-simulates a replay and produces its per-tick hash
// sequence. Shared by golden tests, the tools/replay CLI and the browser
// cross-engine harness so "verify" means the same thing everywhere.

import { createTickInputs } from "./inputs";
import { getMapById } from "./map";
import { type ReplayData, readFrame } from "./replay";
import { createSim, hash, step } from "./sim";

/** Hash after every tick of the replay (length = tickCount). */
export function simulateReplayHashes(replay: ReplayData): Uint32Array {
  const map = getMapById(replay.mapId);
  const sim = createSim(map, replay.seed);
  const inputs = createTickInputs();
  const hashes = new Uint32Array(replay.tickCount);
  for (let t = 0; t < replay.tickCount; t++) {
    readFrame(replay, t, inputs);
    step(sim, inputs);
    hashes[t] = hash(sim);
  }
  return hashes;
}

/** Index of the first diverging tick, or -1 if the sequences match. */
export function firstDivergence(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}
