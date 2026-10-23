// Stage B unit-model manifest (assets.md §1 Stage B, §4 glTF conventions).
//
// Single source of truth for the model pass: genUnitModels.ts consumes it to
// build packages/client/public/models/units/<key>.glb from the committed raw
// downloads, and tools/generators/test/unitModels.test.ts asserts the committed
// output still matches it. Swapping a model = changing one entry here, dropping
// the raw file next to it, and re-running `bun run gen:units`.
//
// UNIT_MODELS are the models every arena shares (the X1-Alpha's two forms).
// Each arena's own units — its mission's Cobjs for every role — are
// ARENA_UNIT_MODELS below, listed by `bun run gen:paunits` rather than by hand.
//
// Two arrays, ONE scale. Every model here and in PROP_MODELS keeps the size the
// original authored it at, because the arena around them does: the FCOP terrain
// imports at one grid cell per metre, and the Cobj extractions are already in
// those metres.
//
// This used to say "UNIT_MODELS are gameplay archetypes, fitted to the greybox
// silhouettes … so models stay honest against the collision radii". Fitting was
// the mistake. It stretched every unit by a different factor — 1.02x for the
// Flyer, 1.85x for the heavy gunship, 2.87x for the X1-Alpha walker — so the
// unit set was not even internally consistent, let alone consistent with the
// arena. The proof was in this file: Cobj 29 was BOTH the `console` unit and
// the `prop-029` scenery, one raw file, and la-cantina drew it at 3.20 m and
// 1.47 m simultaneously. (Since Phase 14 wave 5 it is scenery alone: the
// outpost's console is the type-11 record the activation destroys.) The
// original's own base-mouth trigger volumes are 2.5 x 1.5 m, which the fitted
// 2.31 m-deep walker could not drive through.
//
// So `nativeScale` is on everywhere, and `footprint`/`maxHeight` are what they
// already were for the two turrets: SOFT UPPER BOUNDS the client test checks
// (unitModels.test.ts), measured off the raw, not targets to stretch to. A raw
// asset that grows past them fails loudly instead of silently rescaling.
//
// Conventions for the OUTPUT files (checked by the client test):
// - Y-up, meters, origin at the ground-contact center (bbox minY=0, XZ-centered)
// - +Z is forward (assets.md §4); the runtime loader rotates +Z onto the sim's
//   +X forward when it builds the InstancedMesh geometry
// - `footprint` is the max horizontal extent in world units; `ARCHETYPE_RADIUS`
//   in packages/sim/src/balance.ts is half of it, so the two stay in step
// - `maxTris` per assets.md §4: ~1500 standard, ~5000 Juggernaut/Fortress/Avatar

import {
  SCENERY_PLACEMENTS,
  type SceneryMorph,
} from "../../../packages/client/src/render/arenaScenery.generated";
import {
  UNIT_MODEL_FILES,
  type UnitMorph,
  type UnitTreatment,
} from "../../../packages/client/src/render/arenaUnits.generated";

export interface UnitModelSource {
  /** Human-readable model title on the source site. */
  readonly title: string;
  readonly author: string;
  /** Pinned per-model page URL (poly.pizza). */
  readonly url: string;
  readonly license: string;
}

export interface UnitModelSpec {
  /** Output name: packages/client/public/models/units/<key>.glb. */
  readonly key: string;
  /** Raw download, relative to tools/generators/units/raw/. */
  readonly raw: string;
  readonly source: UnitModelSource;
  /**
   * Quarter-turns around +Y to bring the source's forward axis onto +Z.
   *
   * The FCOP Cobj extraction already lands nose-on-+Z, so every Cobj-derived
   * model here is 0 — measure before deviating. `2` looks harmless on a
   * silhouette that is roughly symmetric front-to-back, and it is how the
   * hovertank and the Sky Captain jet ended up driving backwards: their tapered
   * ends pointed at -Z, i.e. away from travel. A per-Z-slice width profile of
   * the raw shows which end is the nose (narrow) and which is the body (wide).
   */
  readonly rotateQuarterY: 0 | 1 | 2 | 3;
  /** Target max horizontal extent (world units), from the greybox extents. */
  readonly footprint: number;
  /** Optional height cap (world units) for tall props like the console. */
  readonly maxHeight?: number;
  /**
   * Keep the raw glb's authored size (orient + ground only). For FCOP Cobj
   * assemblies already in map meters — do not stretch to `footprint`.
   * `footprint` / `maxHeight` then act as loose upper bounds for the test.
   */
  readonly nativeScale?: boolean;
  readonly maxTris: number;
  /**
   * Node names whose faces keep their texels under the team offset. The
   * original's team colour is a per-actor texture offset onto the side's half
   * of the page (render/teamUv.ts); the X1's partner draws it over the legs,
   * cockpit and both weapons but not the beacon lights (RE player_partner.c
   * 285-320). gen:units writes a 0/1 `_TEAMUV` vertex attribute when this is
   * set; a model without it takes the offset on every face.
   *
   * This replaced `neutralizeColors`, the desaturated atlas the per-instance
   * red / blue tint used to colour (Metropolis' own, fcop-fidelity.md G4).
   */
  readonly teamUvExclude?: readonly string[];
  /**
   * The largest empty horizontal slab the original itself authored, in metres.
   * The contract test refuses floating parts, which is how a pose the parts
   * were never posed in shows up; a Cobj whose part floats by design names its
   * gap here instead of loosening the test for everyone.
   */
  readonly authoredGap?: number;
}

// Original Future Cop: L.A.P.D. (1998) assets are explicitly permitted, incl.
// modified originals (docs/specs/assets.md §2). The raw glbs come from the
// Cobj extraction / X1 assembly in the private RE repo
// (extract_objects.py, extract_x1.py).
const EA = "Electronic Arts / Visual Sciences (Future Cop: L.A.P.D., 1998)";
const FCOP_LICENSE = "EA original, permitted per assets.md §2";
const RE_REPO = "https://github.com/amigo-labs/fcop-reverse-engineering";

export const UNIT_MODELS: readonly UnitModelSpec[] = [
  {
    // Assembled walker pose from extract_x1.py (legs + cockpit + twin guns +
    // beacon). Not a single Cobj: the X1 is five Cobj parts mounted via aRSL
    // slots; the RE pipeline bakes rest-pose Walker frames into x1_alpha.glb.
    key: "avatar-walker",
    raw: "fcop/x1-alpha-walker.glb",
    source: {
      title: "X1-Alpha walker form (assembled, Walker rest pose)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    // Native 0.59 x 0.98 x 0.80. The height cap used to read 2.8 "to keep
    // presence next to 1.6 m turrets", which stretched the X1 by 2.87x and made
    // it the tallest thing in the game by a wide margin — taller than the
    // consoles it walks up to, and too wide for its own base mouth. Presence is
    // the camera's job (render/camera.ts), not the asset's.
    footprint: 0.81,
    maxHeight: 0.98,
    nativeScale: true,
    maxTris: 5000,
    teamUvExclude: ["beacon_lights_mesh"],
  },
  {
    // Full hover assembly (same parts, hover rest pose) — not only the cockpit
    // Cobj, so transform walker↔hover keeps one silhouette family.
    key: "avatar-hover",
    raw: "fcop/x1-alpha-hover.glb",
    source: {
      title: "X1-Alpha hover form (assembled, Hover rest pose)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    // Native 0.59 x 0.48 x 1.24 — a skimmer, longer than it is wide and half
    // the walker's height, which is the silhouette change the transform is for.
    footprint: 1.25,
    maxHeight: 0.48,
    nativeScale: true,
    maxTris: 5000,
    teamUvExclude: ["beacon_lights_mesh"],
  },
];

/**
 * Projectile / weapon-effect model. Third family next to UNIT_MODELS and
 * PROP_MODELS, and the one with the strictest origin rule.
 *
 * Same `nativeScale` law as the units — these are Cobj assemblies already in map
 * meters — but unlike a unit these are NOT grounded and NOT XZ-centred. A
 * projectile's origin is its own pivot: the original authored the bolt centred
 * on its middle (Cobj 12's bbox centre sits 0.006 m off origin in Z, its ends at
 * ±0.51) and the sim positions the shell at that centre. Sliding minY to 0 would
 * push every bolt half its thickness above the line it is meant to travel.
 *
 * Which mesh belongs to which weapon comes from the original's own template
 * tables, not from taste — see `docs/specs/fcop-fx.md` §3/§4, which records per
 * row what is extracted and what is derived. The `role` field below is that
 * table's verdict in one line.
 */
export interface FxModelSpec {
  /** Output name: packages/client/public/models/fx/<key>.glb. */
  readonly key: string;
  /** Original Cobj resource id in the Mp container. */
  readonly cobj: number;
  readonly raw: string;
  readonly source: UnitModelSource;
  /** Where the original uses it, per docs/specs/fcop-fx.md. */
  readonly role: string;
  readonly rotateQuarterY: 0 | 1 | 2 | 3;
  /** Soft upper bound on the max horizontal extent, measured off the raw. */
  readonly footprint: number;
  /** Soft upper bound on height, measured off the raw. */
  readonly maxHeight: number;
  readonly maxTris: number;
  /**
   * Desaturate so the per-instance tint reads. ON for the whole family, and
   * this is the original's behaviour rather than ours: every type-99 row names
   * its mesh twice, in slot 0 and slot 3, and those are the two team variants
   * (the Hyper Velocity Rocket 44/45 and Mine 50/51 have identical raw payloads; the glow pair
   * 46/47 is one geometry in two colours). We ship one mesh and tint it.
   */
  readonly neutralizeColors: boolean;
}

// The eight type-99 rows and the two AI bolts that PA actually fires. Not
// shipped, but committed as raws under the same directory because they are the
// evidence for the table: obj 048 (Robo Dog, the 11-frame morph), obj 046/047
// (Fusion Torpedo / Plasma Flare glow), obj 052 (Grenade), obj 013 (the flat
// bolt of AI weapon 2) and obj 053 (AI weapon 6) — all weapons this game does
// not carry. See docs/specs/fcop-fx.md.
export const FX_MODELS: readonly FxModelSpec[] = [
  {
    key: "bolt-single",
    cobj: 12,
    raw: "fcop-fx/mp-obj012-bolt-single.glb",
    source: {
      title: "Single bolt (Mp Cobj 12, AI weapon 1)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "AI weapon_id 1 — ground units and aircraft",
    rotateQuarterY: 0,
    // Native 0.219 x 0.219 x 1.025: a 1 m beam of pure facer geometry. The
    // length is the point — the original throws an object this long, where
    // render/fx.ts used to draw a streak the full 40 m reach of the shot.
    footprint: 1.03,
    maxHeight: 0.22,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "bolt-twin",
    cobj: 14,
    raw: "fcop-fx/mp-obj014-bolt-twin.glb",
    source: {
      title: "Twin bolt (Mp Cobj 14, AI weapon 3)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "AI weapon_id 3 — turrets and neutral turrets (64 of 64 on la-cantina)",
    rotateQuarterY: 0,
    // Native 0.313 x 0.313 x 1.094 — two beams, so wider and slightly longer.
    footprint: 1.1,
    maxHeight: 0.32,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "rocket-heavy",
    cobj: 42,
    raw: "fcop-fx/mp-obj042-rocket-heavy.glb",
    source: {
      title: "Heavy rocket (Mp Cobj 42, AI weapon 4)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "AI weapon_id 4 — aircraft only; carries the Warden's bomb here",
    rotateQuarterY: 0,
    // Native 0.199 x 0.199 x 0.543 — the largest of the rocket family.
    footprint: 0.55,
    maxHeight: 0.2,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "rocket-helfire",
    cobj: 43,
    raw: "fcop-fx/mp-obj043-rocket-helfire.glb",
    source: {
      title: "Helfire rocket (Mp Cobj 43, player weapon row 6)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "player Helfire — our Hell Fire 2000, PROJ_HEAVY",
    rotateQuarterY: 0,
    // Native 0.182 x 0.148 x 0.389.
    footprint: 0.4,
    maxHeight: 0.15,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "rocket-hyper",
    cobj: 44,
    raw: "fcop-fx/mp-obj044-rocket-hyper.glb",
    source: {
      title: "Hyper Velocity Rocket (Mp Cobj 44, player weapon row 8)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    // Row 8 is EXE weapon 0x13. The RE name table reads it "Ant Missle?" — the
    // question mark is the extraction's own, not ours — while weapons.ts has
    // always carried the slot as the Hyper Velocity Rocket. Same slot, two
    // names, and this repo goes by the catalog: the asset is named for the
    // weapon players see. The extracted table keeps its own wording verbatim in
    // docs/specs/fcop-fx.md §3, where it is evidence rather than a label.
    role: "player weapon 0x13 — the Hyper Velocity Rocket, PROJ_HYPER",
    rotateQuarterY: 0,
    // Native 0.107 x 0.090 x 0.234 — the smallest body in the family.
    footprint: 0.24,
    maxHeight: 0.1,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "shell-mortar",
    cobj: 49,
    raw: "fcop-fx/mp-obj049-shell-mortar.glb",
    source: {
      title: "Mortar shell (Mp Cobj 49, player weapon row 11)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "player Mortar — PROJ_MORTAR and the legacy PROJ_SPECIAL",
    rotateQuarterY: 0,
    // Native 0.188 x 0.188 x 0.352 — round, unlike the pointed rockets.
    footprint: 0.36,
    maxHeight: 0.19,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "mine",
    cobj: 50,
    raw: "fcop-fx/mp-obj050-mine.glb",
    source: {
      title: "Mine (Mp Cobj 50, player weapon row 13)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    // The original blinks this one through a `color_anim` on face 4
    // (grey -> magenta, speed 16). The pipeline has no path for per-face colour
    // animation, so it ships static; the arming blink stays the client's job.
    role: "player Mine — PROJ_MINE",
    rotateQuarterY: 0,
    // Native 0.324 x 0.215 x 0.369.
    footprint: 0.38,
    maxHeight: 0.22,
    maxTris: 1500,
    neutralizeColors: true,
  },
  // The extra weapons' rounds (SimOptions.extraWeapons, SIM_VERSION 90): each
  // player row names its Cobj for both blocks (player-weapons.json `models`).
  {
    key: "drone-k9",
    cobj: 48,
    raw: "fcop-fx/mp-obj048-robodog.glb",
    source: {
      title: "K-9 Drone (Mp Cobj 48, the executable's Robo Dog, player weapon 0x15)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    // A morph of eleven frames in the original (its run); frame 0 here.
    role: "player K-9 Drone — PROJ_K9",
    rotateQuarterY: 0,
    // Native 0.223 x 0.367 x 0.715, standing on its origin.
    footprint: 0.72,
    maxHeight: 0.46,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "grenade",
    cobj: 52,
    raw: "fcop-fx/mp-obj052-grenade.glb",
    source: {
      title: "Grenade (Mp Cobj 52, player weapon 0x24)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "player Grenade Launcher — PROJ_GRENADE",
    rotateQuarterY: 0,
    // Native 0.207 x 0.238 x 0.180.
    footprint: 0.24,
    maxHeight: 0.24,
    maxTris: 1500,
    neutralizeColors: true,
  },
  // The Fusion Torpedo's and the Plasma Flare's round: Cobj 46, one star facer
  // and no faces, so the glb is its record (render/facers.ts draws it on the
  // rounds' buckets, render/greybox.ts projTorpedo / projPlasma).
  {
    key: "star-46",
    cobj: 46,
    raw: "fcop-fx/mp-obj046-glow-a.glb",
    source: {
      title: "Star glow (Mp Cobj 46, player weapons 0x14 and 0x21)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "player Fusion Torpedo and Plasma Flare — PROJ_TORPEDO, PROJ_PLASMA",
    rotateQuarterY: 0,
    // A star of radius 0.074 m at (0, 0.008, 0): its size is the facer's.
    footprint: 0.15,
    maxHeight: 0.15,
    maxTris: 1500,
    neutralizeColors: false,
  },
  // Block B's: Cobj 47, the same star in blue (31, 59, 128) — both rows name 46
  // in slot 0 and 47 in slot 3 (pa_models.json `player_weapons` 0x14 / 0x21).
  {
    key: "star-47",
    cobj: 47,
    raw: "fcop-fx/mp-obj047-glow-b.glb",
    source: {
      title: "Star glow (Mp Cobj 47, block B of player weapons 0x14 and 0x21)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "powered Fusion Torpedo and Plasma Flare — PROJ_TORPEDO, PROJ_PLASMA from block B",
    rotateQuarterY: 0,
    footprint: 0.15,
    maxHeight: 0.15,
    maxTris: 1500,
    neutralizeColors: false,
  },
  // The world rows' rounds that are models (Phase 14 wave 4): each type-98 row
  // names its projectile Cobj once — no team variant — so these keep the
  // original's own colours and are drawn untinted. One payload on all six
  // arenas (gen:fx checks the RE's sha256_16 per row), so Mp's raw stands for
  // every arena. Rows 1, 3 and 6 are bolts, Cobjs of line facers that this
  // export turns into white stand-in beams: render/fx.ts draws them from the
  // Cobjs themselves (gen:fx FX_BOLTS), so they have no model here.
  {
    key: "round-row4",
    cobj: 42,
    raw: "fcop-fx/mp-obj042-rocket-heavy.glb",
    source: {
      title: "Heavy rocket (Mp Cobj 42, world weapon row 4)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "world row 4 — the Flying Fortress; the original's own colours, untinted",
    rotateQuarterY: 0,
    footprint: 0.55,
    maxHeight: 0.2,
    maxTris: 1500,
    neutralizeColors: false,
  },
  {
    key: "round-row8",
    cobj: 43,
    raw: "fcop-fx/mp-obj043-rocket-helfire.glb",
    source: {
      title: "Helfire rocket (Mp Cobj 43, world weapon row 8)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "world row 8 — the Sky Captain's missile; the original's own colours, untinted",
    rotateQuarterY: 0,
    footprint: 0.4,
    maxHeight: 0.15,
    maxTris: 1500,
    neutralizeColors: false,
  },
  {
    key: "round-row9",
    cobj: 49,
    raw: "fcop-fx/mp-obj049-shell-mortar.glb",
    source: {
      title: "Mortar shell (Mp Cobj 49, world weapon row 9)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    role: "world row 9 — the Sky Captain's bomb; the original's own colours, untinted",
    rotateQuarterY: 0,
    footprint: 0.36,
    maxHeight: 0.19,
    maxTris: 1500,
    neutralizeColors: false,
  },
];

/**
 * One arena unit file: the Cobj an arena's role draws, in that arena's own
 * mission numbering and with its own texture pages
 * (packages/client/src/render/arenaUnits.generated.ts, `bun run gen:paunits`).
 * Output: packages/client/public/models/units/<file>.glb, where `file` is
 * `<mapId of the first arena that draws it>/obj_NNN`; every other arena whose
 * payload and sampled texels are identical points at the same file.
 */
export interface ArenaUnitModelSpec {
  /** Under models/units/, without `.glb`. */
  readonly file: string;
  readonly mission: string;
  readonly cobj: number;
  /** Raw extraction, relative to tools/generators/units/raw/ (copied unchanged). */
  readonly raw: string;
  readonly treatment: UnitTreatment;
  readonly usedBy: readonly string[];
  /**
   * The track the client plays (render/arenaUnits.ts): gen:units keeps a
   * morph's targets, and bakes a skeleton's frames into targets; null ships
   * frame 0.
   */
  readonly morph: UnitMorph | null;
  readonly source: UnitModelSource;
  readonly maxTris: number;
}

/**
 * Every unit of every arena, the arena's own model (fcop-fidelity.md G1). Until
 * Phase 14 wave 5 all six arenas drew Mp's files under fixed keys (`runner`,
 * `guardian`, `juggernaut`, `fortress`, `warden`, `console`) and two turret
 * assemblies glued together by hand (`raw/custom/`); Hk's tank, Ovmp's page-4
 * units and every one of Joke's are models of their own, so those arenas drew
 * another mission's units.
 *
 * The treatment is the role's (`gen:paunits` names it):
 * - `unit` (tank, jet, Flying Fortress, Sky Captain): grounded and XZ-centred
 *   like every unit before, FX attachments dropped;
 * - `part` (a turret's gun and base, the Dreadnought's hull and guns): the
 *   original's own origin kept, because the gun stands on the base's attach
 *   point 0, the Dreadnought's guns on the hull's attach points 0-3, and each
 *   turns about its own origin. Those points are in the raw's frame.
 */
export const ARENA_UNIT_MODELS: readonly ArenaUnitModelSpec[] = UNIT_MODEL_FILES.map((f) => ({
  file: f.file,
  mission: f.mission,
  cobj: f.cobj,
  raw: f.raw,
  treatment: f.treatment,
  usedBy: f.usedBy,
  morph: f.morph,
  source: {
    title: `${f.mission} Cobj ${f.cobj} (${f.treatment}; ${f.usedBy.join(", ")})`,
    author: EA,
    url: RE_REPO,
    license: FCOP_LICENSE,
  },
  maxTris: 5000,
}));

export interface PropModelSpec {
  /**
   * Output name: packages/client/public/models/props/<mapId>/<key>.glb.
   * Always `prop-<cobj>` so render/props.ts can map a scenery placement's
   * `cobj` (render/arenaScenery.generated.ts) straight onto a URL in the
   * arena's folder without a second lookup table.
   */
  readonly key: string;
  /** The arena whose scenery places it (render/arenaScenery.generated.ts). */
  readonly mapId: string;
  /** The arena's mission container: the Cobj id and its texels are this one's. */
  readonly mission: string;
  /** Original Cobj resource id in that mission, as a scenery placement carries it. */
  readonly cobj: number;
  /**
   * The Mp Cobj with the same payload (the same geometry and UVs), or null for
   * a model of the mission's own. Evidence, not a lookup: the texels still come
   * from the mission's own pages, so the file is never Mp's.
   */
  readonly mpTwin: number | null;
  /** Raw extraction, relative to tools/generators/units/raw/. */
  readonly raw: string;
  /**
   * The morph its records play (the outpost flag's cloth), which gen:units
   * keeps and render/props.ts steps; null ships frame 0. From the arena's
   * scenery table (render/arenaScenery.generated.ts, `bun run gen:scenery`).
   */
  readonly morph: SceneryMorph | null;
  /**
   * Keep the raw's own origin (a type-96 Prop): `snd_emit_build` stands the
   * model's origin at the record's height, and a lamp or a sign hangs below
   * its origin. The type-11 models stand on theirs (their min y is 0).
   */
  readonly keepOrigin: boolean;
  readonly source: UnitModelSource;
  readonly maxTris: number;
}

// Original scenery: the DynamicProp (act_type 11) records of every imported
// arena's mission — 36 per arena, 8 models each — which `bun run gen:scenery`
// reads out of the mission into render/arenaScenery.generated.ts with the
// height, yaw and claim state the original gives each one. Render-only.
//
// A placement's `model` is a Cobj id IN THAT ARENA'S OWN MISSION. The same id
// is a different model on another arena: the six missions number their Cobjs
// differently (Conft's Dreadnought hull is 37, its Fortress 42), so Conft 41 is
// a kiosk and not Mp's Flying Fortress. These all drew Mp's file for the id
// until Phase 14 wave 5, which put a Dreadnought hull (36) and a Flying
// Fortress (41) on urban-jungle and a Fortress on proving-ground as "parked
// vehicles", and left bug-hunt's 38 and hollywood-keys' 31 undrawn. Matching
// the payload hashes of the RE's exports (extracted/objects/<Mission>/
// manifest.json `sha256_16`) against Mp's gives every id its twin, below.
//
// The texels are each mission's own even where the payload is Mp's: an
// identical payload samples the mission's own texture pages, and every one of
// the 48 exports differs from every other. So each arena gets its own raws
// (raw/fcop-props/<Mission>/obj_NNN.glb, copied unchanged from the RE by
// `bun run gen:scenery`) and its own outputs, as the pickups and lifts do
// (`models/pa-props/<mapId>/`).
//
// Unlike UNIT_MODELS these keep their source scale and orientation: they are
// placed in the original's own frame at the original's own positions, so any
// fitting or re-orientation here would be a lie about the arena. There is no
// `footprint`, no `maxHeight` and no `rotateQuarterY` for that reason, and no
// `neutralizeColors` either — nothing tints scenery.
//
// What the models are, from their geometry, the texture region each samples
// (named by Mp's ids; page tex05 for the consoles, tex01/tex03 for the flags)
// and the records and scripts that place them (RE pa_models.json `terminal`
// and `scenery`, the outposts' activation scripts):
// - Mp 28 (16 placements): thin (5 cm), 1.5 m tall, yellow/black hazard
//   diagonals — read as a "striped barrier" until the RE named it: the outpost
//   flag, four per outpost (pa_models.json `outpost_flag`, groups 11-14). The
//   claim script sets the claimer's offset on it (v 25 / 51, the red and blue
//   flag on the same page; render/props.ts). A 6-frame morph, the cloth, which
//   gen:units keeps and render/props.ts plays.
// - Mp 29 (4 placements): the outpost's console on its pad, the one a mech
//   buys the outpost at; the activation destroys it (order 0x3c).
// - Mp 27 and 33 (4 each): the outpost's two terminals, at its activation and
//   claim spots (the tank and jet shop), spawned by the activation.
// - Mp 34 and 35 (2 each): the base terminals at the Dreadnought and Flying
//   Fortress purchase spots (spawned by tFUN 30 / 31).
// - Mp 39 and 40 (2 each): placed kiosks at the bases, by the triggers that
//   buy a jet (39) and a tank (40).
// All but the flag sample the same atlas strip — yellow unit-type icons (jet,
// tank, turret) and the 0-9 digit row — differing in which part they show.
// Ovmp's console and kiosks are payloads of its own (pages 4 and 8, the kiosks
// a little larger); only its flag is Mp's.
const SCENERY_KINDS: Readonly<Record<number, string>> = {
  27: "Outpost terminal at the activation spot",
  28: "Outpost flag",
  29: "Outpost console",
  33: "Outpost terminal at the claim spot",
  34: "Base terminal, Dreadnought purchase",
  35: "Base terminal, Flying Fortress purchase",
  39: "Base kiosk, jet purchase",
  40: "Base kiosk, tank purchase",
};

/** Ovmp's own payloads: what each is, by its geometry and its place in the set. */
const OWN_KINDS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  Ovmp: {
    27: "Outpost terminal at the activation spot (Ovmp's own)",
    29: "Outpost console (Ovmp's own)",
    33: "Outpost terminal at the claim spot (Ovmp's own)",
    34: "Base terminal, Dreadnought purchase (Ovmp's own)",
    35: "Base terminal, Flying Fortress purchase (Ovmp's own)",
    39: "Base kiosk, jet purchase (Ovmp's own)",
    40: "Base kiosk, tank purchase (Ovmp's own)",
  },
};

/** Each arena's scenery: [the mission's Cobj id, its Mp twin or null]. */
export const ARENA_SCENERY: readonly {
  readonly mapId: string;
  readonly mission: string;
  readonly props: readonly (readonly [cobj: number, mpTwin: number | null])[];
}[] = [
  {
    mapId: "la-cantina",
    mission: "Mp",
    props: [
      [27, 27],
      [28, 28],
      [29, 29],
      [33, 33],
      [34, 34],
      [35, 35],
      [39, 39],
      [40, 40],
    ],
  },
  {
    mapId: "urban-jungle",
    mission: "Conft",
    props: [
      [27, 27],
      [28, 28],
      [29, 29],
      [33, 33],
      [35, 34],
      [36, 35],
      [40, 39],
      [41, 40],
    ],
  },
  {
    mapId: "proving-ground",
    mission: "Slim",
    props: [
      [27, 27],
      [28, 28],
      [29, 29],
      [34, 33],
      [35, 34],
      [39, 35],
      [40, 39],
      [41, 40],
    ],
  },
  {
    mapId: "bug-hunt",
    mission: "Joke",
    props: [
      [27, 27],
      [28, 28],
      [29, 29],
      [33, 33],
      [34, 34],
      [38, 35],
      [39, 39],
      [40, 40],
    ],
  },
  {
    mapId: "hollywood-keys",
    mission: "Hk",
    props: [
      [27, 27],
      [28, 28],
      [29, 29],
      [31, 33],
      [34, 34],
      [35, 35],
      [39, 39],
      [40, 40],
    ],
  },
  {
    mapId: "venice-beach",
    mission: "Ovmp",
    props: [
      [27, null],
      [28, 28],
      [29, null],
      [33, null],
      [34, null],
      [35, null],
      [39, null],
      [40, null],
    ],
  },
];

/** Where an arena's scenery raw lives, relative to tools/generators/units/raw/. */
export function sceneryRaw(mission: string, cobj: number): string {
  return `fcop-props/${mission}/obj_${String(cobj).padStart(3, "0")}.glb`;
}

export const PROP_MODELS: readonly PropModelSpec[] = ARENA_SCENERY.flatMap((arena) =>
  arena.props.map(([cobj, mpTwin]) => {
    const kind = mpTwin === null ? OWN_KINDS[arena.mission]?.[cobj] : SCENERY_KINDS[mpTwin];
    if (!kind) throw new Error(`${arena.mission} Cobj ${cobj}: no scenery kind`);
    return {
      key: `prop-${String(cobj).padStart(3, "0")}`,
      mapId: arena.mapId,
      mission: arena.mission,
      cobj,
      mpTwin,
      raw: sceneryRaw(arena.mission, cobj),
      morph: SCENERY_PLACEMENTS[arena.mapId]?.morphs[cobj] ?? null,
      keepOrigin: false,
      source: {
        title: `${kind} (${arena.mission} Cobj ${cobj})`,
        author: EA,
        url: RE_REPO,
        license: FCOP_LICENSE,
      },
      maxTris: 1500,
    };
  }),
);

// The type-96 Props (fcop-fidelity.md G13): every model a Prop record of the
// arena's mission names, as the RE exports it (raw/fcop-props/<Mission>/,
// copied by `bun run gen:scenery`), into the same folder as the type-11
// scenery under the same `prop-<cobj>` name (one mission's Cobj ids are one
// namespace; gen:scenery refuses a Cobj that is both). The original builds a
// Prop as a sound emitter around its model (RE snd/emitter.c), not as an
// actor: what each one is the records and their models say, not a role. A
// model some record steps through its frames keeps them as morph targets
// (render/props.ts plays them). One of camera-facing facers only (Hk 65, Slim
// 63 and 83, Joke 62 and 82) is built too: a glb of its facers' records and
// the atlas they sample, no mesh (render/facers.ts draws them).
export const EMITTER_PROP_MODELS: readonly PropModelSpec[] = Object.entries(
  SCENERY_PLACEMENTS,
).flatMap(([mapId, scenery]) =>
  Object.entries(scenery.propModels)
    .filter(([, m]) => m.drawn)
    .map(([id, m]) => {
      const cobj = Number(id);
      const records = scenery.props.filter((p) => p.cobj === cobj);
      const animated = records.some((p) => p.anim !== "none");
      return {
        key: `prop-${String(cobj).padStart(3, "0")}`,
        mapId,
        mission: scenery.mission,
        cobj,
        mpTwin: null,
        raw: sceneryRaw(scenery.mission, cobj),
        morph: animated ? { frames: m.frames, period: 0 } : null,
        keepOrigin: true,
        source: {
          title: `Prop (${scenery.mission} Cobj ${cobj}, ${records.length} placement${records.length === 1 ? "" : "s"})`,
          author: EA,
          url: RE_REPO,
          license: FCOP_LICENSE,
        },
        maxTris: 1500,
      };
    }),
);
