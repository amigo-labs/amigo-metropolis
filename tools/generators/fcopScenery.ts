// Copies each arena's scenery raws out of the private RE repo, unchanged:
//
//   <RE>/extracted/objects/<Mission>/obj_NNN.glb
//     -> tools/generators/units/raw/fcop-props/<Mission>/obj_NNN.glb
//
// for every Cobj that units/manifest.ts ARENA_SCENERY lists for the arena —
// the ids its `props` place, in its own mission's numbering. The RE exports
// them as tools/gfx/extract_objects.py does every Cobj (all frames, the
// mission's own texture pages embedded); `bun run gen:units` then builds
// packages/client/public/models/props/<mapId>/prop-NNN.glb from these raws,
// so the arena is regenerable without the RE repo.
//
// The same Cobj id is a different model on another arena, and an identical
// payload still samples each mission's own pages, so nothing here is shared
// across missions (manifest.ts says how the twins were matched).
//
//   bun run gen:scenery [all | <mapId> | <Mission>] [--check] [--re-repo <path>]
//
// `--check` compares the committed raws with the RE's exports and exits 1 on
// any difference. Authoring-time only.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";
import { ARENA_SCENERY, sceneryRaw } from "./units/manifest";

const RAW_DIR = join(import.meta.dir, "units", "raw");

function main(): void {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  const check = process.argv.includes("--check");
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  let stale = 0;
  for (const arena of selectArenas(positional || "all")) {
    const scenery = ARENA_SCENERY.find((a) => a.mapId === arena.mapId);
    if (!scenery) throw new Error(`${arena.mapId}: no ARENA_SCENERY entry`);
    if (scenery.mission !== arena.mission) {
      throw new Error(`${arena.mapId}: scenery says ${scenery.mission}, arena is ${arena.mission}`);
    }
    const src = join(reRepo, "extracted", "objects", arena.mission);
    const out = join(RAW_DIR, "fcop-props", arena.mission);
    if (!check) {
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
    }
    for (const [cobj] of scenery.props) {
      const name = `obj_${String(cobj).padStart(3, "0")}.glb`;
      const from = join(src, name);
      const to = join(RAW_DIR, sceneryRaw(arena.mission, cobj));
      if (!check) {
        copyFileSync(from, to);
        continue;
      }
      if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) {
        console.log(`${to} is not ${from}`);
        stale++;
      }
    }
    console.log(
      `${arena.mapId} (${arena.mission}): ${scenery.props.map(([c]) => c).join(", ")}` +
        (check ? " checked" : " copied"),
    );
  }
  if (stale > 0) {
    console.error(`${stale} stale scenery raw(s): run bun run gen:scenery`);
    process.exit(1);
  }
}

if (import.meta.main) main();
