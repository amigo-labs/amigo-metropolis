// Renderer rule 1 for the X1: its per-tick animation (render/x1Walk.ts
// tickX1Walk, aimX1) and its per-frame placement (render/avatarRig.ts placeX1)
// allocate nothing. Bun's engine does not report young allocations, so the
// harness (x1AllocHarness.ts) is bundled and run under node, whose heapUsed
// does: over a scripted match the heap must grow by less than a quarter of what
// one small array a tick adds, measured as a slope over two run lengths.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const node = Bun.which("node");

describe("the X1's frame loop", () => {
  test.skipIf(!node)(
    "allocates nothing per tick or per frame",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "x1alloc-"));
      try {
        const built = await Bun.build({
          entrypoints: [join(import.meta.dir, "x1AllocHarness.ts")],
          target: "node",
          outdir: dir,
        });
        expect(built.success).toBe(true);
        // A process the JIT deoptimises mid-measure boxes doubles a tick for all of
        // its runs; an allocation in the code shows in every process, so the best
        // of three decides.
        let best = { clean: Number.POSITIVE_INFINITY, leaky: 0 };
        for (
          let attempt = 0;
          attempt < 3 && !(best.clean < (best.leaky - best.clean) / 4);
          attempt++
        ) {
          const run = Bun.spawnSync([
            node as string,
            "--expose-gc",
            "--max-semi-space-size=64",
            join(dir, "x1AllocHarness.js"),
          ]);
          expect(run.exitCode).toBe(0);
          const out = JSON.parse(run.stdout.toString().trim().split("\n").pop() ?? "{}") as {
            clean: number;
            leaky: number;
          };
          if (out.clean < best.clean) best = out;
        }
        // Bytes a tick. The control (one small array a tick) must register, or the
        // measure proves nothing; the X1's own paths must stay well under it.
        expect(best.leaky - best.clean).toBeGreaterThan(16);
        expect(best.clean).toBeLessThan((best.leaky - best.clean) / 4);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60000,
  );
});
