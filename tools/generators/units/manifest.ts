// Stage B unit-model manifest (assets.md §1 Stage B, §4 glTF conventions).
//
// Single source of truth for the model pass: genUnitModels.ts consumes it to
// build packages/client/public/models/units/<key>.glb from the committed raw
// downloads, and packages/client/test/unitModels.test.ts asserts the committed
// output still matches it. Swapping a model = changing one entry here, dropping
// the raw file next to it, and re-running `bun run gen:units`.
//
// Two arrays, two contracts. UNIT_MODELS are gameplay archetypes, fitted to the
// greybox silhouettes. PROP_MODELS are the original arena scenery placements
// (see PROP_MODELS below) and are deliberately NOT fitted — their original
// proportions are the whole point.
//
// Conventions for the OUTPUT files (checked by the client test):
// - Y-up, meters, origin at the ground-contact center (bbox minY=0, XZ-centered)
// - +Z is forward (assets.md §4); the runtime loader rotates +Z onto the sim's
//   +X forward when it builds the InstancedMesh geometry
// - `footprint` is the target max horizontal extent in world units, matched to
//   the greybox silhouettes in render/greybox.ts so models stay honest against
//   the collision radii in packages/sim/src/balance.ts
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
    // Scale is height-led: the assembled walker is taller than it is wide, so a
    // pure footprint stretch ballooned past 6 m. ~2.8 m tall keeps presence next
    // to 1.6 m turrets without looking like a building.
    footprint: 2.6,
    maxHeight: 2.8,
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
    footprint: 3.3,
    maxHeight: 2.4,
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
    footprint: 2.0,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "guardian",
    raw: "fcop/mp-obj041-flyer.glb",
    source: {
      title: "Flyer (Mp Cobj 41)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    footprint: 3.2,
    maxTris: 1500,
    neutralizeColors: true,
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
    footprint: 4.1,
    maxTris: 5000,
    neutralizeColors: true,
  },
  {
    key: "fortress",
    raw: "fcop/mp-obj057-skycaptain-gunship.glb",
    source: {
      title: "Sky Captain gunship form (Mp Cobj 57)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    footprint: 5.0,
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
    raw: "fcop/mp-obj029-outpost-console.glb",
    source: {
      title: "Outpost flag console (Mp Cobj 29)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 2,
    footprint: 3.4,
    maxHeight: 3.2,
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
    footprint: 4.8,
    maxTris: 1500,
    neutralizeColors: true,
  },
];

export interface PropModelSpec {
  /**
   * Output name: packages/client/public/models/props/<key>.glb.
   * Always `prop-<cobj>` so render/props.ts can map a MapProp.model straight
   * onto a URL without a second lookup table.
   */
  readonly key: string;
  /** Original Cobj resource id, as carried by MapProp.model. */
  readonly cobj: number;
  /** Raw extraction, relative to tools/generators/units/raw/. */
  readonly raw: string;
  readonly source: UnitModelSource;
  readonly maxTris: number;
}

// Original la-cantina (Mp) scenery: the DynamicProp (act_type 11) placements
// carried in packages/sim/maps/la-cantina.json `props`. Render-only — the sim
// never reads them (determinismGuard.test.ts enforces that).
//
// Unlike UNIT_MODELS these keep their source scale and orientation: they are
// placed in the original's own frame at the original's own positions, so any
// fitting or re-orientation here would be a lie about the arena. There is no
// `footprint`, no `maxHeight` and no `rotateQuarterY` for that reason, and no
// `neutralizeColors` either — nothing tints scenery.
//
// What the eight are, from their geometry and the texture region each samples
// (page tex05 for the consoles, tex01/tex03 for the barrier):
// - Cobj 28 (16 placements): thin (5 cm), 1.5 m tall, yellow/black hazard
//   diagonals — a striped barrier. The only animated one; the pipeline keeps
//   frame 0.
// - Cobj 27/33/34/35/39/40 (2-4 each): small kiosks sampling the same atlas
//   strip as Cobj 29 — yellow unit-type icons (jet, tank, turret) and the
//   0-9 digit row. Siblings of the outpost console, differing in which part of
//   that strip they show.
// - Cobj 29 (4 placements): the outpost flag console. Its raw is already
//   committed for the `console` unit model above and is reused here rather
//   than duplicated — same bytes, different treatment (unfitted).
export const PROP_MODELS: readonly PropModelSpec[] = [
  {
    key: "prop-027",
    cobj: 27,
    raw: "fcop/mp-obj027-icon-console.glb",
    source: {
      title: "Scenery kiosk, unit-icon console variant (Mp Cobj 27)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-028",
    cobj: 28,
    raw: "fcop/mp-obj028-hazard-barrier.glb",
    source: {
      title: "Hazard-striped barrier (Mp Cobj 28)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-029",
    cobj: 29,
    raw: "fcop/mp-obj029-outpost-console.glb",
    source: {
      title: "Outpost flag console (Mp Cobj 29)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-033",
    cobj: 33,
    raw: "fcop/mp-obj033-icon-console.glb",
    source: {
      title: "Scenery kiosk, unit-icon console variant (Mp Cobj 33)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-034",
    cobj: 34,
    raw: "fcop/mp-obj034-icon-console.glb",
    source: {
      title: "Scenery kiosk, unit-icon console variant (Mp Cobj 34)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-035",
    cobj: 35,
    raw: "fcop/mp-obj035-icon-console.glb",
    source: {
      title: "Scenery kiosk, unit-icon console variant (Mp Cobj 35)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-039",
    cobj: 39,
    raw: "fcop/mp-obj039-icon-console.glb",
    source: {
      title: "Scenery kiosk, unit-icon console variant (Mp Cobj 39)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
  {
    key: "prop-040",
    cobj: 40,
    raw: "fcop/mp-obj040-icon-console.glb",
    source: {
      title: "Scenery kiosk, unit-icon console variant (Mp Cobj 40)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    maxTris: 1500,
  },
];
