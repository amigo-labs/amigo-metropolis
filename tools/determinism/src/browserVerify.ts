// Cross-engine determinism check (Phase 0 DoD): re-simulates every golden
// replay in Chromium (V8) and in the local Bun process (JavaScriptCore — the
// engine WebKit/Safari uses) and asserts both produce exactly the committed
// hash sequence. Two independently implemented JS engines agreeing on 1800
// consecutive state hashes is the strongest automated evidence we can get
// that the sim only uses IEEE-exact operations.
//
//   bun tools/determinism/src/browserVerify.ts
//
// Requires a Chromium binary; override the path via CHROMIUM_PATH.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeReplay, firstDivergence, simulateReplayHashes } from "@metropolis/sim";
import { chromium } from "playwright-core";

const GOLDENS_DIR = join(import.meta.dir, "..", "..", "..", "packages", "sim", "test", "goldens");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "browserHarness.ts")],
  target: "browser",
});
if (!bundle.success) {
  console.error("harness bundle failed:", bundle.logs);
  process.exit(1);
}
const harnessJs = await bundle.outputs[0].text();

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
await page.addScriptTag({ content: harnessJs });

const engineVersion = await page.evaluate(() => navigator.userAgent);
console.log(`browser engine: ${engineVersion}`);
console.log(`local engine:   Bun ${Bun.version} (JavaScriptCore)`);

let ok = true;
const goldens = readdirSync(GOLDENS_DIR).filter((f) => f.endsWith(".mrep"));
for (const file of goldens) {
  const bytes = new Uint8Array(readFileSync(join(GOLDENS_DIR, file)));
  const committed = JSON.parse(
    readFileSync(join(GOLDENS_DIR, file.replace(/\.mrep$/, ".hashes.json")), "utf8"),
  ).hashes as number[];

  const jscHashes = simulateReplayHashes(decodeReplay(bytes));
  const v8Hashes = await page.evaluate(
    (b) => globalThis.runReplayHashes(b),
    Array.from(bytes) as number[],
  );

  const vsJsc = firstDivergence(v8Hashes, jscHashes);
  const vsGolden = firstDivergence(v8Hashes, committed);
  if (vsJsc !== -1 || vsGolden !== -1) {
    console.error(
      `${file}: DIVERGENCE — V8 vs JSC at tick ${vsJsc}, V8 vs golden at tick ${vsGolden}`,
    );
    ok = false;
  } else {
    console.log(`${file}: OK — V8, JSC and committed golden agree on ${committed.length} hashes`);
  }
}

await browser.close();
process.exit(ok ? 0 : 1);
