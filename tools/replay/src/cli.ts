// Replay recorder/verifier CLI (PLAN Phase 0; `bisect` lands with netcode).
//
//   bun tools/replay/src/cli.ts record <script> <out.mrep> [seed]
//   bun tools/replay/src/cli.ts write-hashes <replay.mrep> <out.hashes.json>
//   bun tools/replay/src/cli.ts verify <replay.mrep> <expected.hashes.json>
//   bun tools/replay/src/cli.ts verify-goldens
//
// Exit code 0 = verified, 1 = mismatch/usage error.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createReplayData,
  createTickInputs,
  decodeReplay,
  encodeReplay,
  firstDivergence,
  type ReplayData,
  SIM_VERSION,
  simulateReplayHashes,
  TEST_MAP_ID,
  writeFrame,
} from "@metropolis/sim";
import { SCRIPTS } from "./scripts";

const GOLDENS_DIR = join(import.meta.dir, "..", "..", "..", "packages", "sim", "test", "goldens");

interface HashFile {
  simVersion: number;
  mapId: string;
  seed: number;
  tickCount: number;
  /** Absent in pre-Phase-4 hash files — treated as "no Warden". */
  wardenPlayer?: number;
  wardenDifficulty?: number;
  hashes: number[];
}

function hashFileFor(replay: ReplayData, hashes: Uint32Array): HashFile {
  return {
    simVersion: replay.simVersion,
    mapId: replay.mapId,
    seed: replay.seed,
    tickCount: replay.tickCount,
    wardenPlayer: replay.wardenPlayer,
    wardenDifficulty: replay.wardenDifficulty,
    hashes: Array.from(hashes),
  };
}

function verifyReplay(replayPath: string, hashesPath: string): boolean {
  const replay = decodeReplay(new Uint8Array(readFileSync(replayPath)));
  const expected = JSON.parse(readFileSync(hashesPath, "utf8")) as HashFile;
  if (expected.simVersion !== SIM_VERSION) {
    console.error(
      `${basename(replayPath)}: recorded for sim v${expected.simVersion}, current is v${SIM_VERSION} — regenerate goldens`,
    );
    return false;
  }
  // The hashes file must describe THIS replay, otherwise a divergence report
  // would point at the wrong problem.
  if (
    expected.simVersion !== replay.simVersion ||
    expected.mapId !== replay.mapId ||
    expected.seed !== replay.seed ||
    expected.tickCount !== replay.tickCount ||
    (expected.wardenPlayer ?? -1) !== replay.wardenPlayer ||
    (expected.wardenDifficulty ?? 0) !== replay.wardenDifficulty ||
    expected.hashes.length !== replay.tickCount
  ) {
    console.error(
      `${basename(replayPath)}: hashes file does not match replay header — ` +
        `expected (v${expected.simVersion}, ${expected.mapId}, seed ${expected.seed}, ` +
        `${expected.tickCount} ticks, ${expected.hashes.length} hashes) vs replay ` +
        `(v${replay.simVersion}, ${replay.mapId}, seed ${replay.seed}, ${replay.tickCount} ticks)`,
    );
    return false;
  }
  const got = simulateReplayHashes(replay);
  const div = firstDivergence(got, expected.hashes);
  if (div !== -1) {
    console.error(
      `${basename(replayPath)}: hash mismatch at tick ${div} ` +
        `(got ${got[div]}, expected ${expected.hashes[div]})`,
    );
    return false;
  }
  console.log(`${basename(replayPath)}: OK (${replay.tickCount} ticks, ${got.length} hashes)`);
  return true;
}

function cmdRecord(scriptName: string, outPath: string, seedArg?: string): number {
  const entry = SCRIPTS[scriptName];
  if (!entry) {
    console.error(`unknown script "${scriptName}" — available: ${Object.keys(SCRIPTS).join(", ")}`);
    return 1;
  }
  const seed = seedArg ? Number(seedArg) >>> 0 : 0xc0ffee;
  const replay = createReplayData(entry.mapId ?? TEST_MAP_ID, seed, entry.ticks, entry.warden);
  const inputs = createTickInputs();
  for (let t = 0; t < entry.ticks; t++) {
    entry.script(t, inputs);
    writeFrame(replay, t, inputs);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, encodeReplay(replay));
  const hashes = simulateReplayHashes(replay);
  const hashesPath = `${outPath.replace(/\.mrep$/, "")}.hashes.json`;
  writeFileSync(hashesPath, `${JSON.stringify(hashFileFor(replay, hashes), null, 2)}\n`);
  console.log(
    `recorded ${scriptName}: ${entry.ticks} ticks, seed ${seed}, sim v${SIM_VERSION}\n` +
      `  ${outPath}\n  ${hashesPath}\n  final hash ${hashes[hashes.length - 1]}`,
  );
  return 0;
}

function cmdWriteHashes(replayPath: string, outPath: string): number {
  const replay = decodeReplay(new Uint8Array(readFileSync(replayPath)));
  const hashes = simulateReplayHashes(replay);
  writeFileSync(outPath, `${JSON.stringify(hashFileFor(replay, hashes), null, 2)}\n`);
  console.log(`wrote ${hashes.length} hashes to ${outPath}`);
  return 0;
}

function cmdVerifyGoldens(): number {
  const files = readdirSync(GOLDENS_DIR).filter((f) => f.endsWith(".mrep"));
  if (files.length === 0) {
    console.error(`no goldens found in ${GOLDENS_DIR}`);
    return 1;
  }
  let ok = true;
  for (const f of files) {
    const hashesPath = join(GOLDENS_DIR, f.replace(/\.mrep$/, ".hashes.json"));
    ok = verifyReplay(join(GOLDENS_DIR, f), hashesPath) && ok;
  }
  return ok ? 0 : 1;
}

const [cmd, a, b, c] = process.argv.slice(2);
let code: number;
switch (cmd) {
  case "record":
    code = a && b ? cmdRecord(a, b, c) : usage();
    break;
  case "write-hashes":
    code = a && b ? cmdWriteHashes(a, b) : usage();
    break;
  case "verify":
    code = a && b ? (verifyReplay(a, b) ? 0 : 1) : usage();
    break;
  case "verify-goldens":
    code = cmdVerifyGoldens();
    break;
  default:
    code = usage();
}
process.exit(code);

function usage(): number {
  console.error(
    "usage:\n" +
      "  replay record <script> <out.mrep> [seed]\n" +
      "  replay write-hashes <replay.mrep> <out.hashes.json>\n" +
      "  replay verify <replay.mrep> <expected.hashes.json>\n" +
      "  replay verify-goldens",
  );
  return 1;
}
