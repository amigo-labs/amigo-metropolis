// The terrain trace (trace.ts; fcop-fidelity.md T1) against the decompiled
// original, bit for bit.
//
// test/fixtures/trace/<mission>.rays.gz: rays answered by the RE's own
// `terrain_trace_segment` (amigo-labs/fcop-reverse-engineering
// src/game/world/trace.c) over the shipped container, by
// tools/generators/re/traceRays.c. Each record: from {x, y, z}, to {x, y, z},
// hit_floors, the cell test's carried pick before the ray, then the answer:
// the result word, the hit point (0x7fffffff where retail writes none), the
// candidate count and the carried pick after. The rays run over the playable
// area and the whole grid: long and short, axis-aligned and diagonal from sample
// boundaries, vertical, on and about the topmost and lowest surfaces.
//
// The map's `trace` (gen:trace -> stage 2) is what the sim reads, so the map is
// what is tested: a difference in the plates or in the port fails here.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getMapById } from "../src/map";
import { newTraceScratch, terrainTraceSegment } from "../src/trace";

const ARENAS: readonly [string, string][] = [
  ["conft", "urban-jungle"],
  ["slim", "proving-ground"],
  ["mp", "la-cantina"],
  ["joke", "bug-hunt"],
  ["hk", "hollywood-keys"],
  ["ovmp", "venice-beach"],
];

const NONE = 0x7fffffff;
const RECORD = 14;

function rays(mission: string): Int32Array {
  const gz = readFileSync(join(import.meta.dir, "fixtures", "trace", `${mission}.rays.gz`));
  const raw = gunzipSync(gz);
  const words = new Int32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  expect(words[0] >>> 0).toBe(0x4352544d); // "MTRC"
  return words.subarray(2, 2 + words[1] * RECORD);
}

describe("terrainTraceSegment against the original's", () => {
  for (const [mission, mapId] of ARENAS) {
    it(`${mapId} (${mission}): every ray's result, hit point, candidates and carried pick`, () => {
      const trace = getMapById(mapId).trace;
      expect(trace).not.toBeNull();
      if (trace === null) return;
      const r = rays(mission);
      const st = newTraceScratch();
      const hit = new Int32Array(3);
      let mismatches = 0;
      let first = "";
      let hits = 0;
      for (let i = 0; i < r.length; i += RECORD) {
        st.pickBest = r[i + 7];
        hit[0] = NONE;
        hit[1] = NONE;
        hit[2] = NONE;
        const from = r.subarray(i, i + 3);
        const to = r.subarray(i + 3, i + 6);
        const result = terrainTraceSegment(trace, from, to, hit, r[i + 6], st);
        if (result !== 0) hits++;
        const ok =
          result === r[i + 8] &&
          hit[0] === r[i + 9] &&
          hit[1] === r[i + 10] &&
          hit[2] === r[i + 11] &&
          st.candidates === r[i + 12] &&
          st.pickBest === r[i + 13];
        if (!ok) {
          mismatches++;
          if (first === "") {
            first =
              `ray ${i / RECORD}: [${Array.from(from)}] -> [${Array.from(to)}] floors ${r[i + 6]}: ` +
              `got ${result} [${Array.from(hit)}] ${st.candidates} ${st.pickBest}, ` +
              `want ${r[i + 8]} [${r[i + 9]},${r[i + 10]},${r[i + 11]}] ${r[i + 12]} ${r[i + 13]}`;
          }
        }
      }
      expect(first).toBe("");
      expect(mismatches).toBe(0);
      // The fixture exercises both answers.
      expect(hits).toBeGreaterThan(r.length / RECORD / 10);
    });
  }
});
