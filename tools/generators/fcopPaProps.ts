// Copies the Precinct Assault pickup and lift models out of the private RE repo
// into the client's static assets, one folder per arena:
//
//   <RE>/extracted/findings/pa_props/<Mission>/obj_NNN.glb
//     -> packages/client/public/models/pa-props/<mapId>/obj_NNN.glb
//
// The RE side (tools/logic/pa_rules_data.py --models) packs, per arena, exactly
// the Cobjs its pickups and lifts use, as tools/gfx/extract_objects.py exports
// them (frame 0, the arena's own texture pages embedded). The same Cobj id is a
// different file on every arena — the geometry is shared, the textures are not —
// so the folder is the arena's, and render/pickups.ts and render/lifts.ts load
// `pa-props/<mapId>/obj_<cobj>.glb` for the `model` the map carries.
//
//   bun run gen:paprops [all | <mapId> | <Mission>] [--re-repo <path>]
//
// Committing original assets is allowed (CLAUDE.md "Assets"; CREDITS.md lists
// them). Authoring-time only.

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";

interface PackManifest {
  mission: string;
  props: { cobj_id: number; glb: string; role: string[] }[];
}

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The client path of an arena's pickup or lift model. */
export function paPropPath(mapId: string, cobj: number): string {
  return `models/pa-props/${mapId}/obj_${String(cobj).padStart(3, "0")}.glb`;
}

function main(): void {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  for (const arena of selectArenas(positional || "all")) {
    const src = join(reRepo, "extracted", "findings", "pa_props", arena.mission);
    const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as PackManifest;
    if (manifest.mission !== arena.mission) {
      throw new Error(`${arena.mapId}: pack is ${manifest.mission}, expected ${arena.mission}`);
    }
    const out = join(REPO_ROOT, "packages", "client", "public", "models", "pa-props", arena.mapId);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const p of manifest.props) {
      copyFileSync(
        join(src, p.glb),
        join(REPO_ROOT, "packages", "client", "public", paPropPath(arena.mapId, p.cobj_id)),
      );
    }
    console.log(
      `${arena.mapId}: ${manifest.props.map((p) => `${p.cobj_id} (${p.role.join("/")})`).join(", ")}`,
    );
  }
}

if (import.meta.main) main();
