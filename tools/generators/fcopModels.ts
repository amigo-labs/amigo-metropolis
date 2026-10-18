// Reads what the sim needs from each Precinct Assault arena's MODELS out of the
// private RE repo and writes it into this repo as a committed, deterministic
// artifact (tools/generators/fcop/<mission>-models.json), next to the logic and
// rules extractions.
//
// The RE side (tools/gfx/pa_models.py -> extracted/logic/<Mission>/
// pa_models.json, docs/formats/pa-models.md) names the Cobj each role draws and
// carries what the glb does not: the attach points. The Dreadnought's gun i
// stands on its hull's attach point i (vertex 4DGI[0x30 + i], `mount.c`
// 526-546), turns `((word_48 << 8) / 218) >> 4` angle units per 1/300 s
// (`mount.c` 1136) and fires only inside its front sector (`discharge.c`
// 949-977); its round leaves from the gun model's own point 0.
//
//   bun run gen:pamodels [all | <mapId> | <Mission>] [--re-repo <path>]
//
// FRAME: every point is in its model's glb frame as the RE writes it (Cobj i16 /
// 512 with x negated, y up, +z forward, metres). The sim turns it into the hull's
// frame (map.ts MapGunMount). Authoring-time only: enrichArena.ts is the reader.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FcopArena, modelsFile, selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";

const REPO_ROOT = join(import.meta.dir, "..", "..");

interface ReGunSide {
  shooter: { weapon_id: number; front_sector_only: boolean };
  word_48: number;
  home_yaw_word_4a: number;
  mount_flags: number;
  turn_rate_per_tick: number;
}
interface ReGun {
  gun: number;
  cobj: number;
  point_index: number;
  hull_point: { index: number; vertex: number; glb_xyz: number[] };
  by_side: Record<string, ReGunSide>;
}
interface ReModels {
  roles: {
    dreadnought: { parts: { part: string; cobj: number }[]; guns: ReGun[] }[];
  };
  models: Record<
    string,
    { sha256_16: string; attach?: { points: { index: number; glb_xyz: number[] }[] } }
  >;
}

/** One gun as the sim reads it. */
export interface ModelsGun {
  readonly gun: number;
  readonly cobj: number;
  /** The hull's attach point the gun stands on, hull glb frame. */
  readonly point: readonly number[];
  /** The gun model's point 0, its muzzle, gun glb frame. */
  readonly muzzle: readonly number[];
  /** Angle units (4096 a turn) per 1/300 s. */
  readonly turnPerTick: number;
  readonly frontSectorOnly: boolean;
}

export interface ModelsArtifact {
  readonly mission: string;
  readonly source: { readonly repo: string; readonly commit: string; readonly tool: string };
  readonly dreadnought: {
    readonly hull: number;
    readonly hullSha: string;
    readonly guns: readonly ModelsGun[];
  };
}

function buildModels(arena: FcopArena, re: ReModels, source: ModelsArtifact["source"]) {
  const roles = re.roles.dreadnought;
  if (roles.length !== 1)
    throw new Error(`${arena.mission}: ${roles.length} Dreadnought model sets`);
  const role = roles[0];
  const hull = role.parts.find((p) => p.part === "hull");
  if (!hull) throw new Error(`${arena.mission}: the Dreadnought has no hull part`);
  const guns = role.guns.map((g, i): ModelsGun => {
    if (g.gun !== i || g.point_index !== i || g.hull_point.index !== i) {
      throw new Error(`${arena.mission}: gun ${i} does not stand on hull point ${i}`);
    }
    const sides = Object.values(g.by_side);
    const key = (s: ReGunSide) =>
      JSON.stringify([
        s.word_48,
        s.home_yaw_word_4a,
        s.mount_flags,
        s.turn_rate_per_tick,
        s.shooter.weapon_id,
        s.shooter.front_sector_only,
      ]);
    if (sides.length !== 2 || key(sides[0]) !== key(sides[1])) {
      throw new Error(`${arena.mission}: gun ${i}'s two sides disagree`);
    }
    const s = sides[0];
    // The home yaw 0 is the hull's forward and no flag limits the traverse or
    // animates the fire: the sim models exactly that mount (mount.c 270-394).
    if (s.home_yaw_word_4a !== 0 || s.mount_flags !== 0) {
      throw new Error(`${arena.mission}: gun ${i} has a home yaw or mount flags`);
    }
    if (((s.word_48 << 8) / 218) >> 4 !== s.turn_rate_per_tick) {
      throw new Error(`${arena.mission}: gun ${i}'s turn rate is not word_48's`);
    }
    const muzzle = re.models[String(g.cobj)]?.attach?.points.find((p) => p.index === 0);
    if (!muzzle) throw new Error(`${arena.mission}: gun model ${g.cobj} has no point 0`);
    return {
      gun: i,
      cobj: g.cobj,
      point: g.hull_point.glb_xyz,
      muzzle: muzzle.glb_xyz,
      turnPerTick: s.turn_rate_per_tick,
      frontSectorOnly: s.shooter.front_sector_only,
    };
  });
  const artifact: ModelsArtifact = {
    mission: arena.mission,
    source,
    dreadnought: { hull: hull.cobj, hullSha: re.models[String(hull.cobj)].sha256_16, guns },
  };
  return artifact;
}

function main(): void {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  const named = positional || argOf("map", argOf("mission", "all"));
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", reRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    console.warn(`[gen:pamodels] could not read the RE repo commit at ${reRepo}`);
  }
  for (const arena of selectArenas(named)) {
    const src = join(reRepo, "extracted", "logic", arena.mission, "pa_models.json");
    const re = JSON.parse(readFileSync(src, "utf8")) as ReModels;
    const models = buildModels(arena, re, {
      repo: "amigo-labs/fcop-reverse-engineering",
      commit,
      tool: "tools/gfx/pa_models.py",
    });
    const out = join(REPO_ROOT, "tools", "generators", "fcop", modelsFile(arena));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(models, null, 2)}\n`);
    // The repo's formatter has the last word on layout, so a re-run is a no-op.
    const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", out], { cwd: REPO_ROOT });
    if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
    console.log(`wrote ${out}: Dreadnought hull ${models.dreadnought.hull}, 4 guns`);
  }
}

if (import.meta.main) main();
