// Golden replay safety net (architecture.md §6): every .mrep in test/goldens/
// is re-simulated and its full hash sequence compared against the committed
// .hashes.json. Any sim change that alters these hashes must regenerate the
// goldens in the same commit (bun tools/replay/src/cli.ts record ...) and
// justify it in the commit message — see CLAUDE.md hard rule 6.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSim,
  createTickInputs,
  decodeReplay,
  firstDivergence,
  getMapById,
  hash,
  type ReplayData,
  readFrame,
  SIM_VERSION,
  simulateReplayHashes,
  step,
} from "../src/index";

const GOLDENS = join(import.meta.dir, "goldens");

interface HashFile {
  simVersion: number;
  tickCount: number;
  hashes: number[];
}

function loadGolden(name: string): { replay: ReplayData; expected: HashFile } {
  const replay = decodeReplay(new Uint8Array(readFileSync(join(GOLDENS, `${name}.mrep`))));
  const expected = JSON.parse(readFileSync(join(GOLDENS, `${name}.hashes.json`), "utf8"));
  return { replay, expected };
}

const goldenNames = readdirSync(GOLDENS)
  .filter((f) => f.endsWith(".mrep"))
  .map((f) => f.replace(/\.mrep$/, ""));

describe("golden replays", () => {
  it("at least golden #1 exists", () => {
    expect(goldenNames).toContain("golden-01-drive");
  });

  for (const name of goldenNames) {
    it(`${name}: hash sequence matches the committed golden`, () => {
      const { replay, expected } = loadGolden(name);
      expect(expected.simVersion).toBe(SIM_VERSION);
      expect(expected.hashes.length).toBe(replay.tickCount);
      const got = simulateReplayHashes(replay);
      const div = firstDivergence(got, expected.hashes);
      if (div !== -1) {
        throw new Error(
          `${name} diverged at tick ${div}: got ${got[div]}, expected ${expected.hashes[div]}. ` +
            "If this sim change is intentional, bump SIM_VERSION and regenerate goldens " +
            "in the same commit.",
        );
      }
    });
  }

  it("golden #1 covers a full 60 s at 30 Hz", () => {
    const { replay } = loadGolden("golden-01-drive");
    expect(replay.tickCount).toBe(1800);
  });

  it("catches a deliberately broken determinism rule", () => {
    // Simulates golden #1 but injects a tiny state perturbation mid-run —
    // the kind of drift a nondeterministic Math.sin or stray float would
    // cause. The golden MUST flag every tick from the perturbation onward.
    const { replay, expected } = loadGolden("golden-01-drive");
    const map = getMapById(replay.mapId);
    const sim = createSim(map, replay.seed);
    const inputs = createTickInputs();
    const breakAt = 900;
    for (let t = 0; t < replay.tickCount; t++) {
      if (t === breakAt) {
        sim.ent.posX[0] += 0.0001; // one float32 nudge, far below visual notice
      }
      readFrame(replay, t, inputs);
      step(sim, inputs);
      const h = hash(sim);
      if (t < breakAt) {
        expect(h).toBe(expected.hashes[t]);
      } else {
        expect(h).not.toBe(expected.hashes[t]);
      }
    }
  });
});
