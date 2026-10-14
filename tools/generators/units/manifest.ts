// Stage B unit-model manifest (assets.md §1 Stage B, §4 glTF conventions).
//
// Single source of truth for the model pass: genUnitModels.ts consumes it to
// build packages/client/public/models/units/<key>.glb from the committed raw
// downloads, and packages/client/test/unitModels.test.ts asserts the committed
// output still matches it. Swapping a model = changing one entry here, dropping
// the raw file next to it, and re-running `bun run gen:units`.
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
// arena. The proof sits inside this file: Cobj 29 is BOTH the `console` unit and
// the `prop-029` scenery, one raw file, and la-cantina drew it at 3.20 m and
// 1.47 m simultaneously. The original's own base-mouth trigger volumes are
// 2.5 x 1.5 m, which the fitted 2.31 m-deep walker could not drive through.
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
   * Desaturate the model's colors (baked vertex colors, or the packed atlas
   * texture) toward luminance so the whole-unit instanceColor team tint
   * (render/greybox.ts tintFor) reads cleanly — the equivalent of FCOP's own
   * grey team-variant textures. Off for models whose own colors should
   * survive the neutral/team tint (turret, console).
   */
  readonly neutralizeColors: boolean;
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
    neutralizeColors: true,
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
    neutralizeColors: true,
  },
  {
    key: "runner",
    raw: "fcop/mp-obj030-hovertank.glb",
    source: {
      title: "Hovertank (Mp Cobj 30)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    // 0 like every other Cobj: the extraction already puts the nose on +Z.
    rotateQuarterY: 0,
    // Native 1.05 x 0.40 x 1.52 — longer than the X1 and half its height.
    footprint: 1.53,
    maxHeight: 0.4,
    nativeScale: true,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    // The Precinct Assault jet: every jet spawner of every PA mission names
    // Cobj 22 (RE extracted/logic/<Mission>/pa_rules.json `spawners`, kind
    // "jet"). This entry used to carry Cobj 41, the Flying Fortress — the
    // `fortress` entry below — so the jet flew as a 3.15 m bomber. Mp's
    // payload is also Conft's, Slim's and Hk's; Ovmp's samples page 4, and
    // Joke's is a model of its own (every arena draws Mp's: open).
    //
    // Cobj 22 is a 3-frame morph (extract_objects.py anim_kind "morph"): its
    // rotor, the 54 vertices of the top hub and blades at y 0.11-0.16, turns
    // about the hub from frame to frame. One InstancedMesh per archetype
    // cannot drive per-instance morph weights through this pipeline, so
    // gen:units keeps frame 0 and the rotor stands still (open: assets.md §4).
    key: "guardian",
    raw: "fcop/mp-obj022-jet.glb",
    source: {
      title: "Jet (Mp Cobj 22, morph frame 0)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    // Native 1.40 x 0.42 x 1.50: rotor and stub wings 1.40 m across, the cabin
    // nose on +Z and the tail boom on -Z.
    footprint: 1.51,
    maxHeight: 0.43,
    nativeScale: true,
    maxTris: 1500,
    neutralizeColors: true,
    // The rotor has no mast: its hub (y 0.113) floats 5.1 cm over the cabin
    // roof (y 0.063) in every frame, as authored.
    authoredGap: 0.051,
  },
  {
    key: "juggernaut",
    raw: "fcop/mp-obj036-heavy-gunship.glb",
    source: {
      title: "Heavy gunship (Mp Cobj 36)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    // Native 1.20 x 0.63 x 2.22 — was stretched 1.85x.
    footprint: 2.22,
    maxHeight: 0.63,
    nativeScale: true,
    maxTris: 5000,
    neutralizeColors: true,
  },
  {
    // The Flying Fortress: the spawners of kind "flying_fortress" name Cobj 41
    // (Mp, Hk, Joke, Ovmp) or 42 (Conft, Slim) — Mp's payload on Mp, Conft,
    // Slim and Hk; Ovmp's samples page 4, Joke's is a model of its own (every
    // arena draws Mp's: open). This entry used to carry Cobj 57, one of the four
    // Sky Captain models (Mp actors 287/295/296/297 = Cobj 54/56/57/58, one
    // loaded per difficulty level), while the Fortress's own model stood in
    // for the jet above.
    key: "fortress",
    raw: "fcop/mp-obj041-flying-fortress.glb",
    source: {
      title: "Flying Fortress (Mp Cobj 41)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    // Native 3.15 x 0.68 x 2.14 — a flying wing, the widest thing on the
    // field; the pointed nose on +Z, the raised wing tips aft.
    footprint: 3.15,
    maxHeight: 0.69,
    nativeScale: true,
    maxTris: 5000,
    neutralizeColors: true,
  },
  {
    // Mode "Standard": capturable/dummy. FCOP Mp base 32 + gun 31 (assembly C).
    // nativeScale: raw assembly is already in map meters (~1.4×1.6).
    key: "turret-standard",
    raw: "custom/turret-standard.glb",
    source: {
      title: "Turret Standard (Mp Cobj 32 base + 31 gun)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 2,
    footprint: 1.5,
    maxHeight: 1.7,
    nativeScale: true,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    // Mode "Defense": base-ring. FCOP Mp base 21 + gun 20 (assembly E).
    // nativeScale: raw is smaller (~0.95 m) — keep FCOP relative size.
    key: "turret-defense",
    raw: "custom/turret-defense.glb",
    source: {
      title: "Turret Defense (Mp Cobj 21 base + 20 gun)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 2,
    footprint: 1.0,
    maxHeight: 1.0,
    nativeScale: true,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "console",
    // la-cantina's own scenery raw for Cobj 29: one file for both treatments.
    raw: "fcop-props/Mp/obj_029.glb",
    source: {
      title: "Outpost flag console (Mp Cobj 29)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 2,
    // Native 1.00 x 1.47 x 1.12 — the size la-cantina's prop-029 ships at. Fitting
    // drew this at 3.20 m next to its own 1.47 m twin, in the same arena.
    footprint: 1.12,
    maxHeight: 1.48,
    nativeScale: true,
    maxTris: 1500,
    neutralizeColors: false,
  },
  {
    key: "warden",
    raw: "fcop/mp-obj054-skycaptain-jet.glb",
    source: {
      title: "Sky Captain jet (Mp Cobj 54)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    // 0 like every other Cobj: the extraction already puts the nose on +Z.
    rotateQuarterY: 0,
    // Hull-only 1.49 x 0.42 x 1.13. The raw's second primitive is a 1 m
    // tex10 searchlight pair (combined 1.49 x 0.71 x 2.04); gen:units drops
    // it so the beams do not bake into the dark cones in warden-iso.png.
    footprint: 1.5,
    maxHeight: 0.42,
    nativeScale: true,
    maxTris: 1500,
    neutralizeColors: true,
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
];

export interface PropModelSpec {
  /**
   * Output name: packages/client/public/models/props/<mapId>/<key>.glb.
   * Always `prop-<cobj>` so render/props.ts can map a MapProp.model straight
   * onto a URL in the arena's folder without a second lookup table.
   */
  readonly key: string;
  /** The arena (packages/sim/maps/<mapId>.json) whose `props` place it. */
  readonly mapId: string;
  /** The arena's mission container: the Cobj id and its texels are this one's. */
  readonly mission: string;
  /** Original Cobj resource id in that mission, as carried by MapProp.model. */
  readonly cobj: number;
  /**
   * The Mp Cobj with the same payload (the same geometry and UVs), or null for
   * a model of the mission's own. Evidence, not a lookup: the texels still come
   * from the mission's own pages, so the file is never Mp's.
   */
  readonly mpTwin: number | null;
  /** Raw extraction, relative to tools/generators/units/raw/. */
  readonly raw: string;
  readonly source: UnitModelSource;
  readonly maxTris: number;
}

// Original scenery: the DynamicProp (act_type 11) placements every imported
// arena carries in packages/sim/maps/<mapId>.json `props` — 36 per arena, 8
// models each. Render-only — the sim never reads them (determinismGuard.test.ts
// enforces that).
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
// What the models are, from their geometry and the texture region each samples
// (named by Mp's ids; page tex05 for the consoles, tex01/tex03 for the barrier):
// - Mp 28 (16 placements): thin (5 cm), 1.5 m tall, yellow/black hazard
//   diagonals — a striped barrier. A 6-frame morph; the pipeline keeps frame 0.
// - Mp 27/33/34/35/39/40 (2-4 each): small kiosks sampling the same atlas
//   strip as Cobj 29 — yellow unit-type icons (jet, tank, turret) and the 0-9
//   digit row. Siblings of the outpost console, differing in which part of
//   that strip they show.
// - Mp 29 (4 placements): the outpost flag console, the same bytes as the
//   `console` unit's raw.
// Ovmp's console and kiosks are payloads of its own (pages 4 and 8, the kiosks
// a little larger); only its barrier is Mp's.
const SCENERY_KINDS: Readonly<Record<number, string>> = {
  27: "Scenery kiosk, unit-icon console variant",
  28: "Hazard-striped barrier",
  29: "Outpost flag console",
  33: "Scenery kiosk, unit-icon console variant",
  34: "Scenery kiosk, unit-icon console variant",
  35: "Scenery kiosk, unit-icon console variant",
  39: "Scenery kiosk, unit-icon console variant",
  40: "Scenery kiosk, unit-icon console variant",
};

/** Ovmp's own payloads: what each is, by its geometry and its place in the set. */
const OWN_KINDS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  Ovmp: {
    27: "Scenery kiosk (Ovmp's own)",
    29: "Outpost flag console (Ovmp's own)",
    33: "Scenery kiosk (Ovmp's own)",
    34: "Scenery kiosk (Ovmp's own)",
    35: "Scenery kiosk (Ovmp's own)",
    39: "Scenery kiosk (Ovmp's own)",
    40: "Scenery kiosk (Ovmp's own)",
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
