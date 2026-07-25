// Re-records every committed golden replay in one go.
//
//   bun run replay:record:all
//
// A SIM_VERSION bump invalidates the header of every golden, even the ones whose
// hash sequence is untouched (golden.test.ts asserts header.simVersion ===
// SIM_VERSION), so re-recording used to be six hand-typed CLI invocations. Doing
// it by hand is how a golden gets missed, and a missed golden looks exactly like
// a determinism regression.
//
// It prints, per golden, whether the hash SEQUENCE actually changed. That is the
// number that matters after a bump: a change means real behaviour moved on that
// map and must be justified in the commit message; "header only" means the bump
// was a no-op there, which is the claim the no-op invariant makes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIM_VERSION } from "@metropolis/sim";
import { SCRIPTS } from "./scripts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const GOLDENS = join(ROOT, "packages", "sim", "test", "goldens");
const CLI = join(import.meta.dir, "cli.ts");

/** Golden file stem per script name, matching what is committed. */
const GOLDEN_OF: Record<string, string> = {
  "drive-01": "golden-01-drive",
  "combat-01": "golden-02-combat",
  "match-01": "golden-03-match",
  "warden-01": "golden-04-warden",
  "fcop-01": "golden-05-fcop",
  "layered-01": "golden-06-layered",
  "pa-01": "golden-07-pa",
};

function hashesOf(stem: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(GOLDENS, `${stem}.hashes.json`), "utf8"));
    return JSON.stringify(raw.hashes ?? raw);
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  console.log(`re-recording ${Object.keys(GOLDEN_OF).length} goldens at sim v${SIM_VERSION}\n`);
  let changed = 0;
  for (const [script, stem] of Object.entries(GOLDEN_OF)) {
    if (!SCRIPTS[script]) throw new Error(`script "${script}" is no longer in SCRIPTS`);
    const before = hashesOf(stem);
    const proc = Bun.spawn(["bun", "run", CLI, "record", script, join(GOLDENS, `${stem}.mrep`)], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      console.error(`FAILED to record ${script}`);
      process.exit(1);
    }
    const after = hashesOf(stem);
    const moved = before !== "" && before !== after;
    if (moved) changed += 1;
    console.log(
      `  ${stem.padEnd(20)} ${moved ? "HASHES CHANGED — justify in the commit" : "header only"}`,
    );
    if (process.env.RECORD_ALL_VERBOSE) console.log(out.trim());
  }
  console.log(
    changed === 0
      ? "\nno hash sequence changed: the bump is a no-op on every golden's map"
      : `\n${changed} golden(s) changed behaviour — say why in the commit message`,
  );
}

await main();
