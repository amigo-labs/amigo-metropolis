// Contract test for the COMMITTED pristine wall snapshots
// (tools/generators/fcop/<mission>-walls.json), which stage 2 reads instead of
// reading back its own output.
//
// The one that needs guarding is Mp. Issue #29 split its lattice per deck, so its
// `wallsV`/`wallsH` changed meaning — union over all decks → the ground deck
// alone — and "the committed file must re-emit byte-for-byte" could no longer be
// the drift canary for it. What replaces it asserts the property that made the
// split safe in the first place: attributing a wall to the deck it stands on must
// neither invent nor drop one, so ground | decks has to be the same lattice the
// file carried before. If a future extractor run loses a wall to a deck nobody
// walks on, this is what catches it.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fnv1aBytes, fnv1aInit } from "@metropolis/sim";
import { type FcopArena, selectArenas, wallsFile } from "../fcopArenas";
import { MP_UNION_PIN, unionWalls, type WallsSnapshot, wallsNote } from "../fcopWalls";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function readSnapshot(arena: FcopArena): WallsSnapshot {
  const path = join(REPO_ROOT, "tools", "generators", "fcop", wallsFile(arena));
  return JSON.parse(readFileSync(path, "utf8")) as WallsSnapshot;
}

/** The registry entry for a map id — the arena list is the single source. */
function arenaOf(mapId: string): FcopArena {
  const arena = selectArenas("all").find((a) => a.mapId === mapId);
  if (!arena) throw new Error(`no FCOP arena registered for ${mapId}`);
  return arena;
}

/** Hash '0'/'1' rows the way fcop-arenas.test.ts hashes a loaded lattice. */
function hashRows(rows: string[]): number {
  const size = rows.length;
  const bits = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) bits[j * size + i] = rows[j][i] === "1" ? 1 : 0;
  }
  return fnv1aBytes(fnv1aInit(), bits, 0, bits.length) >>> 0;
}

describe("committed wall snapshots", () => {
  for (const arena of selectArenas("all")) {
    const snap = readSnapshot(arena);

    it(`${arena.mapId}: is square, binary and carries the canonical note`, () => {
      expect(snap.mission).toBe(arena.mission);
      expect(snap.mapId).toBe(arena.mapId);
      expect(snap.note).toBe(wallsNote(arena.mission));
      for (const rows of [snap.wallsV, snap.wallsH]) {
        expect(rows.length).toBe(snap.size);
        for (const row of rows) {
          expect(row.length).toBe(snap.size);
          expect(/^[01]+$/.test(row)).toBe(true);
        }
      }
    });

    it(`${arena.mapId}: every deck lattice matches the grid`, () => {
      for (const layer of snap.layers ?? []) {
        for (const rows of [layer.wallsV, layer.wallsH]) {
          expect(rows.length).toBe(snap.size);
          for (const row of rows) expect(row.length).toBe(snap.size);
        }
      }
    });
  }

  it("la-cantina is the only layered snapshot, with both of Mp's decks", () => {
    for (const arena of selectArenas("all")) {
      const snap = readSnapshot(arena);
      const want = arena.mapId === "la-cantina" ? 2 : 0;
      expect(snap.layers?.length ?? 0).toBe(want);
    }
  });

  it("re-attributing Mp's walls per deck lost none of them", () => {
    const snap = readSnapshot(arenaOf("la-cantina"));
    // The union is the lattice mp-walls.json carried before #29 split it.
    expect(hashRows(unionWalls(snap, "wallsV"))).toBe(MP_UNION_PIN.wallsV);
    expect(hashRows(unionWalls(snap, "wallsH"))).toBe(MP_UNION_PIN.wallsH);
    // And the split is real: the ground deck carries strictly fewer walls than
    // the union, or nothing was attributed anywhere.
    const groundV = snap.wallsV.reduce((n, r) => n + (r.match(/1/g)?.length ?? 0), 0);
    const unionV = unionWalls(snap, "wallsV").reduce((n, r) => n + (r.match(/1/g)?.length ?? 0), 0);
    expect(groundV).toBeLessThan(unionV);
  });
});
