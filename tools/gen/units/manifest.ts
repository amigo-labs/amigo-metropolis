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
   * Desaturate baked vertex colors toward luminance so the whole-unit
   * instanceColor team tint (render/greybox.ts tintFor) reads cleanly.
   * Off for models whose own colors should survive the neutral/team tint.
   */
  readonly neutralizeColors: boolean;
}

const CC0 = "CC0 1.0";
const QUATERNIUS = "Quaternius";
const KENNEY = "Kenney";

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
    raw: "kenney/craft-speeder-WwqxZN5pq6.glb",
    source: {
      title: "Craft Speeder",
      author: KENNEY,
      url: "https://poly.pizza/m/WwqxZN5pq6",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 3.3,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "runner",
    raw: "quaternius/tank-FA5daiyZQq.glb",
    source: {
      title: "Tank",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/FA5daiyZQq",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 2.0,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "guardian",
    raw: "quaternius/spaceship-DbGajMHrvp.glb",
    source: {
      title: "Spaceship",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/DbGajMHrvp",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 3.2,
    maxTris: 1500,
    neutralizeColors: true,
  },
  {
    key: "juggernaut",
    raw: "quaternius/tank-cW3zvvkMOM.glb",
    source: {
      title: "Tank",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/cW3zvvkMOM",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 4.1,
    maxTris: 5000,
    neutralizeColors: true,
  },
  {
    key: "fortress",
    raw: "quaternius/spaceship-H4OXkd9lWz.glb",
    source: {
      title: "Spaceship",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/H4OXkd9lWz",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 5.0,
    maxTris: 5000,
    neutralizeColors: true,
  },
  {
    key: "turret",
    raw: "quaternius/turret-gun-ekTQhbJId7.glb",
    source: {
      title: "Turret Gun",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/ekTQhbJId7",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 3.2,
    maxTris: 1500,
    neutralizeColors: false,
  },
  {
    key: "console",
    raw: "quaternius/scifi-computer-U0xmt6tUlL.glb",
    source: {
      title: "Scifi Computer",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/U0xmt6tUlL",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 3.4,
    maxHeight: 3.2,
    maxTris: 1500,
    neutralizeColors: false,
  },
  {
    key: "warden",
    raw: "quaternius/spaceship-PQzePrvBCD.glb",
    source: {
      title: "Spaceship",
      author: QUATERNIUS,
      url: "https://poly.pizza/m/PQzePrvBCD",
      license: CC0,
    },
    rotateQuarterY: 0,
    footprint: 4.8,
    maxTris: 1500,
    neutralizeColors: true,
  },
];
