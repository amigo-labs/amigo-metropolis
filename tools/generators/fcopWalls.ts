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
//
// #29 UPDATE. Mp's snapshot was regenerated once, from a stage-1 run against the
// RE heightmap dump, to gain its per-deck lattices — the one route the header
// above allows. Its `wallsV`/`wallsH` are now the GROUND deck rather than the
// union over all decks. The byte-for-byte check could not survive a change of
// meaning, so the invariant that replaces it is stronger about the thing that
// actually matters: `MP_UNION_PIN` asserts the union of ground + decks is the
// same lattice, bit for bit, that the file carried before the split. Walls were
// re-attributed, not invented or dropped.

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
  /**
   * Per-deck lattices on a LAYERED arena (issue #29), index 0 == layer 1. Absent
   * on the single-storey arenas, whose snapshots stay byte-identical.
   *
   * On a layered arena `wallsV`/`wallsH` above are the GROUND deck's walls, not
   * the union over all decks the extractor's top-level fields carry. The union is
   * not lost — it is exactly `wallsV | layers[].wallsV`, which
   * `unionMatches` re-checks against the pre-split lattice.
   */
  layers?: { wallsV: string[]; wallsH: string[] }[];
}

/**
 * FNV-1a over the union of a snapshot's ground and deck lattices.
 *
 * WHY A HASH OF THE UNION
 * Splitting Mp's lattice per deck changed what `wallsV`/`wallsH` mean for that
 * one arena (union → ground), so "the committed file must re-emit byte-for-byte"
 * could not survive the split as the drift canary. What DOES survive is the
 * property that makes the split safe: re-attributing a wall to the deck it stands
 * on must not create or destroy one. These are the union hashes of Mp's lattice
 * as committed BEFORE #29 — verified equal, bit for bit, when the split landed
 * (2002 vertical + 2007 horizontal segments, zero either way).
 */
export const MP_UNION_PIN = { wallsV: 3671048181, wallsH: 626664648 } as const;

/** Union of ground + deck lattices, as '0'/'1' rows. */
export function unionWalls(s: WallsSnapshot, axis: "wallsV" | "wallsH"): string[] {
  const rows = s[axis].map((r) => r.split(""));
  for (const layer of s.layers ?? []) {
    const lr = layer[axis];
    for (let j = 0; j < rows.length; j++) {
      for (let i = 0; i < rows[j].length; i++) {
        if (lr[j][i] === "1") rows[j][i] = "1";
      }
    }
  }
  return rows.map((r) => r.join(""));
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
  const checkRows = (name: string, rows: string[]): void => {
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
  };
  checkRows("wallsV", wallsV);
  checkRows("wallsH", wallsH);

  // A layered arena's decks each carry their own lattice; snapshot them too, or
  // stage 2 would load the arena with deck collision missing.
  const layers: { wallsV: string[]; wallsH: string[] }[] = [];
  for (const [L, layer] of (raw.layers ?? []).entries()) {
    if (!layer.wallsV || !layer.wallsH) continue;
    checkRows(`layer ${L + 1} wallsV`, layer.wallsV);
    checkRows(`layer ${L + 1} wallsH`, layer.wallsH);
    layers.push({ wallsV: [...layer.wallsV], wallsH: [...layer.wallsH] });
  }

  return {
    mission: arena.mission,
    mapId: arena.mapId,
    size: raw.size,
    note: wallsNote(arena.mission),
    wallsV: [...wallsV],
    wallsH: [...wallsH],
    ...(layers.length > 0 ? { layers } : {}),
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
    ...(parsed.layers ? { layers: parsed.layers } : {}),
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
