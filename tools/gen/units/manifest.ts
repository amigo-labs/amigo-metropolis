// Stage B unit-model manifest (assets.md §1 Stage B, §4 glTF conventions).
//
// Single source of truth for the model pass: genUnitModels.ts consumes it to
// build packages/client/public/models/units/<key>.glb from the committed raw
// downloads, and packages/client/test/unitModels.test.ts asserts the committed
// output still matches it. Swapping a model = changing one entry here, dropping
// the raw file next to it, and re-running `bun run gen:units`.
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
  /** Raw download, relative to tools/gen/units/raw/. */
  readonly raw: string;
  readonly source: UnitModelSource;
  /** Quarter-turns around +Y to bring the source's forward axis onto +Z. */
  readonly rotateQuarterY: 0 | 1 | 2 | 3;
  /** Target max horizontal extent (world units), from the greybox extents. */
  readonly footprint: number;
  /** Optional height cap (world units) for tall props like the console. */
  readonly maxHeight?: number;
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

const CC0 = "CC0 1.0";
// Original Future Cop: L.A.P.D. (1998) assets are explicitly permitted, incl.
// modified originals (docs/specs/assets.md §2). The raw glbs come from the
// Cobj extraction in the private RE repo (extract_objects.py).
const EA = "Electronic Arts / Visual Sciences (Future Cop: L.A.P.D., 1998)";
const FCOP_LICENSE = "EA original, permitted per assets.md §2";
const RE_REPO = "https://github.com/amigo-labs/fcop-reverse-engineering";

const QUATERNIUS = "Quaternius";

export const UNIT_MODELS: readonly UnitModelSpec[] = [
  {
    key: "avatar-walker",
    raw: "quaternius/mech-o3Ps8z8ByP.glb",
    source: {
      title: "Mech",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/o3Ps8z8ByP",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 2.6,
    maxTris: 5000,
    neutralizeColors: true,
  },
  {
    key: "avatar-hover",
    raw: "fcop/mp-obj016-x1alpha-hover.glb",
    source: {
      title: "X1-Alpha hover form (Mp Cobj 16)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 0,
    footprint: 3.3,
    maxTris: 1500,
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
    rotateQuarterY: 2,
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
    key: "turret",
    raw: "fcop/mp-obj032-neutral-turret.glb",
    source: {
      title: "Neutral turret (Mp Cobj 32)",
      author: EA,
      url: RE_REPO,
      license: FCOP_LICENSE,
    },
    rotateQuarterY: 2,
    footprint: 3.2,
    maxHeight: 2.6,
    maxTris: 1500,
    neutralizeColors: false,
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
    rotateQuarterY: 2,
    footprint: 4.8,
    maxTris: 1500,
    neutralizeColors: true,
  },
];
