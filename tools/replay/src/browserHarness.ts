// Browser-side harness for cross-engine determinism verification. Bundled by
// browserVerify.ts and injected into a page; exposes one global that
// re-simulates a replay and returns its per-tick hash sequence.

import { decodeReplay, simulateReplayHashes } from "@metropolis/sim";

declare global {
  var runReplayHashes: (bytes: number[]) => number[];
}

globalThis.runReplayHashes = (bytes: number[]): number[] =>
  Array.from(simulateReplayHashes(decodeReplay(new Uint8Array(bytes))));
