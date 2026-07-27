// Snapshots the PRISTINE stage-1 wall lattice of each FCOP arena into
// tools/generators/fcop/<mission>-walls.json.
//
//   bun run gen:walls [all | <mapId> | <Mission>] [--force]
//
// WHY
// Stage 2 (enrichArena.ts) both reads and writes packages/sim/maps/<id>.json, and
// it edits walls. Reading walls back out of its own output would make the result
// depend on how many times the generator had been run — every re-run would erode
// the lattice a little further. So stage 2 reads the walls from a committed
// snapshot instead, and its output is a function of committed inputs alone.
//
// WHERE THE SNAPSHOT COMES FROM
// Stage 1 (convert.ts) produces the pristine lattice, but it needs a private
// heightmap dump and cannot run in-tree. It does not have to: an arena that stage
// 2 has never touched still carries its pristine lattice in its committed map
// JSON, so the snapshot is derivable here. Once stage 2 has run on an arena, that
// is no longer true — which makes this a ONE-WAY RATCHET. Every arena's snapshot
// must be committed BEFORE it is first enriched, or its pristine lattice exists
// nowhere in this repo and only stage 1 can recover it.
//
// mp-walls.json is exactly that case: la-cantina was enriched in #26, so this
// tool cannot regenerate it. It verifies it instead, re-emitting the committed
// file through the same writer the new snapshots use. That is the self-check — if
// the emitter ever drifts, Mp fails first and loudly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MapJson } from "@metropolis/sim";
import { type FcopArena, selectArenas, wallsFile } from "./fcopArenas";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Key order is the file format: mp-walls.json was authored in this order. */
export interface WallsSnapshot {
  mission: string;
  mapId: string;
  size: number;
  note: string;
  wallsV: string[];
  wallsH: string[];
}

/**
 * The committed note, verbatim apart from the mission name.
 *
 * Deliberately not extended with a `source` field or a second sentence about
 * which route produced it: mp-walls.json has to keep reproducing byte-for-byte,
 * and that check is worth more than a richer header. The route is documented at
 * the top of this file instead.
 */
export function wallsNote(mission: string): string {
  return (
    `Pristine sim-frame wall lattice as emitted by stage 1 ` +
    `(tools/generators/convert.ts) from the original ${mission} tile data. ` +
    `Committed so stage 2 (enrichArena.ts) is a pure function of committed ` +
    `inputs instead of reading back its own output.`
  );
}

export function serializeSnapshot(s: WallsSnapshot): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

/**
 * Has stage 2 already rewritten this map?
 *
 * `laneGraph` is the marker: it is emitted only by stage 2 and by nothing else in
 * the pipeline, so its presence means the map's walls have been carved.
 */
export function isEnriched(raw: MapJson): boolean {
  return raw.laneGraph !== undefined;
}

function snapshotPath(arena: FcopArena): string {
  return join(REPO_ROOT, "tools", "generators", "fcop", wallsFile(arena));
}

function readMap(arena: FcopArena): MapJson {
  const path = join(REPO_ROOT, "packages", "sim", "maps", `${arena.mapId}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as MapJson;
}

export function snapshotFromMapJson(arena: FcopArena, raw: MapJson): WallsSnapshot {
  const { wallsV, wallsH } = raw;
  if (!wallsV || !wallsH) {
    throw new Error(`${arena.mapId} carries no wall arrays — nothing to snapshot`);
  }
  for (const [name, rows] of [
    ["wallsV", wallsV],
    ["wallsH", wallsH],
  ] as const) {
    if (rows.length !== raw.size) {
      throw new Error(`${arena.mapId} ${name} has ${rows.length} rows, size is ${raw.size}`);
    }
    for (let j = 0; j < rows.length; j++) {
      if (rows[j].length !== raw.size) {
        throw new Error(
          `${arena.mapId} ${name}[${j}] is ${rows[j].length} chars, size is ${raw.size}`,
        );
      }
      if (!/^[01]+$/.test(rows[j])) {
        throw new Error(`${arena.mapId} ${name}[${j}] has characters outside {0,1}`);
      }
    }
  }
  return {
    mission: arena.mission,
    mapId: arena.mapId,
    size: raw.size,
    note: wallsNote(arena.mission),
    wallsV: [...wallsV],
    wallsH: [...wallsH],
  };
}

/**
 * Re-emits the committed snapshot through serializeSnapshot and diffs the bytes.
 *
 * The point is to exercise the writer on an arena whose pristine lattice is no
 * longer recoverable, so a change to the format or the note is caught rather than
 * silently applied to the five arenas that CAN be regenerated.
 */
export function verifySnapshotBytes(arena: FcopArena): boolean {
  const path = snapshotPath(arena);
  const want = readFileSync(path, "utf8");
  const parsed = JSON.parse(want) as WallsSnapshot;
  const got = serializeSnapshot({
    mission: parsed.mission,
    mapId: parsed.mapId,
    size: parsed.size,
    note: wallsNote(arena.mission),
    wallsV: parsed.wallsV,
    wallsH: parsed.wallsH,
  });
  if (want === got) {
    console.log(`${arena.mapId} (${arena.mission}): committed snapshot verified, ${parsed.size}²`);
    return true;
  }
  console.log(
    `${arena.mapId} (${arena.mission}): PROBLEM the committed snapshot is not what this ` +
      "writer emits — the format or the note has drifted",
  );
  return false;
}

function snapshot(arena: FcopArena, force: boolean): boolean {
  const path = snapshotPath(arena);
  const raw = readMap(arena);

  if (isEnriched(raw)) {
    if (!existsSync(path)) {
      throw new Error(
        `${arena.mapId} has already been enriched and has no committed ${wallsFile(arena)}: ` +
          "its pristine wall lattice is not recoverable in-tree — only stage 1 (convert.ts, " +
          "private heightmaps) can produce it",
      );
    }
    return verifySnapshotBytes(arena);
  }

  const text = serializeSnapshot(snapshotFromMapJson(arena, raw));
  if (existsSync(path)) {
    const have = readFileSync(path, "utf8");
    if (have === text) {
      console.log(`${arena.mapId} (${arena.mission}): unchanged`);
      return true;
    }
    if (!force) {
      console.log(
        `${arena.mapId} (${arena.mission}): PROBLEM the committed snapshot differs from the ` +
          "map's current walls — stage 1 was re-run; pass --force to replace it",
      );
      return false;
    }
  }
  writeFileSync(path, text);
  console.log(`${arena.mapId} (${arena.mission}): wrote ${wallsFile(arena)}, ${raw.size}²`);
  return true;
}

function main(): void {
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const force = process.argv.includes("--force");
  let bad = 0;
  for (const arena of selectArenas(which)) if (!snapshot(arena, force)) bad++;
  if (bad > 0) process.exit(1);
}

if (import.meta.main) main();
