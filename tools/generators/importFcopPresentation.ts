// Import the original's presentation data — the chase cameras, the head-up
// display, the radar and the map screen — from a checkout of the RE repo
// (amigo-labs/fcop-reverse-engineering).
//
//   extracted/presentation/camera.json   presets, camera lists, the seven names,
//                                        the steady-state eyes (tests), caption,
//                                        projection
//   extracted/presentation/hud.json      positions, atlas rects, palettes
//   extracted/presentation/radar_markers.json
//                                        the marker byte of every PA actor, per
//                                        arena: which units carry which, and the
//                                        static markers Metropolis has no entity for
//   extracted/fonts/font3.{png,json}     the HUD's font at 640 x 480
//   extracted/textures/GlblData/tex11.png
//                                        the weapon icons, the badge, the radar disc
//   extracted/textures/<Mission>/tex09.png
//                                        the lock reticle (16 x 16 at 0,210)
//   fixtures/missions/<Mission>          the type-35 objective record's eight
//                                        radar contacts (no export carries them yet)
//
//     -> packages/client/public/hud/{font3.png,tex11.png,reticles.png}
//     -> packages/client/src/render/fcopPresentation.generated.ts
//
// The PNGs are the original's texels; the only change is that pure black, the
// original's transparent texel, gets alpha 0 (tex11, the reticles). The font is
// copied byte for byte.
//
// Usage: bun run gen:presentation --re ../fcop-reverse-engineering
// Authoring-time only.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FCOP_ARENAS } from "./fcopArenas";
import { decodePng, encodePng } from "./png";

const ROOT = join(import.meta.dir, "..", "..");
const PUBLIC_HUD = join(ROOT, "packages", "client", "public", "hud");
const OUT_TS = join(ROOT, "packages", "client", "src", "render", "fcopPresentation.generated.ts");
/** actors.json frame -> Metropolis map frame (enrichArena.ts LOGIC_OFFSET_X / _Z). */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const reArg = argValue("--re") ?? process.env.FCOP_RE_REPO;
if (!reArg) {
  console.error("usage: bun run gen:presentation --re <RE checkout>");
  process.exit(2);
}
const RE = resolve(reArg);
const readJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(RE, ...p), "utf8")) as T;

const reCommit = (() => {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: RE });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
})();

// --- camera.json -------------------------------------------------------------

interface CameraJson {
  presets: { index: number; yaw_delta: number; pitch: number; height: number; offset: number[] }[];
  camera_lists: { bytes: number[] }[];
  entries: {
    index: number;
    list_row: number;
    flags: number;
    name: string | null;
  }[];
  camera_names: string[];
  cameras: {
    camera_name: number;
    name: string;
    available_in_pa: boolean;
    steady_state_walker_subject_y0: { eye: number[]; aim_point: number[] };
  }[];
  caption: { ticks: number; position_text320: number[]; colour: number };
  projection: { hfov_deg: number; vfov_deg: number };
}
const camera = readJson<CameraJson>("extracted", "presentation", "camera.json");

// --- hud.json ----------------------------------------------------------------

type Rect = [number, number, number, number];
interface Icon {
  u: number;
  v: number;
  w: number;
  h: number;
}
interface GaugeJson {
  backing_rect640: Rect;
  ticks_rect640: Rect[];
}
interface HudJson {
  font: { at_640x480: { max_glyph_height_px: number } };
  text_colours: { palettes: { rgb: number[] }[] };
  lock: {
    reticle: { u: number; v: number; w: number; h: number; size_px640: number };
    beam: { colour: number[] };
  };
  weapons: {
    slots: {
      icon: Icon;
      icon_box_px640: Rect;
      lower_count_px640: number[];
      upper_count_px640: number[];
    }[];
    extra_icons: { icon: Icon; box_px640: Rect }[];
    lower_count: { colour: number };
    upper_count: { colour_blink: number[] };
    icon_tint: { unlit: number[]; lit: number[] };
  };
  armour_gauge: {
    own: GaugeJson;
    invulnerable_blink: { gauge: GaugeJson; colour: number[] };
    opponent_gauge: { gauge: GaugeJson };
    backing: { colour: { rgb: number[] } };
    ticks: { colour: { rgb: number[] } };
  };
  score: {
    plate_rect640: Rect;
    plate_rect640_four_digits: Rect;
    text_px640: number[];
    text320_four_digits: number[];
    colour: { slot0: number; slot1: number; alarm: number };
    plate: { colour: { rgb: number[] } };
  };
  counts: { plate_rect640: Rect; text_px640: number[] };
  opponent_row: {
    score_plate_rect640: Rect;
    score_text_px640: number[];
    counts_plate_rect640: Rect;
    counts_text_px640: number[];
  };
  level_caption: { text_px640: number[]; colour: number };
  radar: {
    disc: {
      uv: { u0: number; v0: number; u1: number; v1: number };
      box_px640: Rect;
      centre_px640: number[];
    };
    range: { value: number };
    rotation: { scale_px_per_wu: number };
    rim: {
      tick: { inner_radius_px640: number; outer_radius_px640: number };
      white_tick: { colour: number[] };
      contact_arrows: { shape_radial_tangential: number[][] };
    };
    palette: { entries: { index: number; rgb: number[] | null; blinks?: boolean }[] };
  };
  pause_map: {
    pan: { rate_max: number };
    terrain_window: { samples_z: number; samples_x: number; px_per_sample_640: number };
    overview_54: {
      frame_rects_rect640: Rect[];
      border: { rgb: number[] };
      fill: { rgb: number[] };
      window_frame: { colour: { rgb: number[] } };
    };
  };
}
const hud = readJson<HudJson>("extracted", "presentation", "hud.json");

// --- radar_markers.json --------------------------------------------------------

interface MarkerActor {
  actor_id: number;
  resource: string;
  type: number;
  side_byte24: number;
  group_byte25: number;
  marker: number;
  kind: number;
  becomes_live_actor: boolean;
  on_radar_when_live: boolean;
  x: number;
  z: number;
  capture_markers?: { marker_if_team_a_captures: number; marker_if_team_b_captures: number };
}
interface MarkersJson {
  arenas: Record<
    string,
    {
      actors: MarkerActor[];
      claim_orders: { target: number; marker: number }[];
    }
  >;
}
const markers = readJson<MarkersJson>("extracted", "presentation", "radar_markers.json");

/** The marker a unit kind carries per side, checked identical on all six arenas. */
interface UnitMarkers {
  avatar: [number, number];
  captain: number;
  tank: [number, number];
  jet: [number, number];
  fortress: [number, number];
  dreadnought: [number, number];
  turret: [number, number];
  neutralTurret: number;
  capturedTurret: [number, number];
  pickup: number;
}

function sideMarker(
  actors: MarkerActor[],
  pick: (a: MarkerActor) => boolean,
  side: number,
): number {
  const set = new Set(actors.filter((a) => pick(a) && a.side_byte24 === side).map((a) => a.marker));
  if (set.size !== 1) throw new Error(`side ${side}: ${set.size} markers (${[...set]})`);
  return [...set][0];
}

function oneMarker(actors: MarkerActor[], pick: (a: MarkerActor) => boolean): number {
  const set = new Set(actors.filter(pick).map((a) => a.marker));
  if (set.size !== 1) throw new Error(`${set.size} markers (${[...set]})`);
  return [...set][0];
}

function unitMarkersOf(actors: MarkerActor[]): UnitMarkers {
  const csac = (type: number, kind?: number) => (a: MarkerActor) =>
    a.resource === "Csac" && a.type === type && (kind === undefined || a.kind === kind);
  const neutral = actors.filter(csac(36));
  const cap = new Set(
    neutral.map(
      (a) =>
        `${a.capture_markers?.marker_if_team_a_captures},${a.capture_markers?.marker_if_team_b_captures}`,
    ),
  );
  if (cap.size !== 1) throw new Error(`neutral turret capture markers differ: ${[...cap]}`);
  const [capA, capB] = [...cap][0].split(",").map(Number);
  return {
    avatar: [
      sideMarker(actors, (a) => a.resource === "Cact" && a.type === 1, 1),
      sideMarker(actors, (a) => a.resource === "Cact" && a.type === 1, 2),
    ],
    captain: oneMarker(actors, (a) => a.resource === "Cact" && a.type === 37),
    tank: [sideMarker(actors, csac(5), 1), sideMarker(actors, csac(5), 2)],
    // Type 9 is every aircraft: the jets are the sprites, the one diamond per side
    // is the Flying Fortress (its spawner; radar_markers.json summary).
    jet: [sideMarker(actors, csac(9, 0), 1), sideMarker(actors, csac(9, 0), 2)],
    fortress: [sideMarker(actors, csac(9, 2), 1), sideMarker(actors, csac(9, 2), 2)],
    dreadnought: [sideMarker(actors, csac(28), 1), sideMarker(actors, csac(28), 2)],
    turret: [sideMarker(actors, csac(8), 1), sideMarker(actors, csac(8), 2)],
    neutralTurret: oneMarker(actors, csac(36)),
    capturedTurret: [capA, capB],
    pickup: oneMarker(actors, csac(16)),
  };
}

// --- the type-35 objective record (fixtures/missions/<Mission>) ---------------

interface Contact {
  shown: number;
  colour: number;
  x: number;
  y: number;
}

/**
 * The radar contacts of the one type-35 actor of a PA mission: its payload's
 * shown word (+0x24), eight colour bytes and eight {z, x} halfwords << 9
 * (`objective_construct`, RE disasm/map-open.md M3-MS; `hud_radar_contacts`).
 * Read through the RE's own container walker (tools/gfx/fcop.py).
 */
function contactsOf(mission: string): Contact[] {
  const script = [
    "import sys, struct, json",
    `sys.path.insert(0, ${JSON.stringify(join(RE, "tools", "gfx"))})`,
    "from fcop import extract, parse",
    `b, res = parse(${JSON.stringify(join(RE, "fixtures", "missions", mission))})`,
    "out = []",
    "for r in res:",
    "    if r['type'] != 'Cact': continue",
    "    p = extract(b, r)",
    "    if p[0:4] != b'TCAt' or p[12] != 35: continue",
    "    pay = p[12:]",
    "    shown = struct.unpack_from('<I', pay, 0x24)[0]",
    "    cols = list(pay[0x28:0x30])",
    "    at = [list(struct.unpack_from('<2h', pay, 0x30 + 4 * i)) for i in range(8)]",
    "    out.append({'shown': shown, 'colours': cols, 'at': at})",
    "print(json.dumps(out))",
  ].join("\n");
  const r = Bun.spawnSync(["python3", "-I", "-c", script]);
  if (r.exitCode !== 0) throw new Error(`${mission}: type-35 read failed: ${r.stderr.toString()}`);
  const recs = JSON.parse(r.stdout.toString()) as {
    shown: number;
    colours: number[];
    at: [number, number][];
  }[];
  if (recs.length !== 1) throw new Error(`${mission}: ${recs.length} type-35 records, expected 1`);
  const rec = recs[0];
  const out: Contact[] = [];
  for (let i = 0; i < 8; i++) {
    const shown = (rec.shown >>> (3 * i)) & 7;
    if (shown === 0) continue;
    // Halfword 0 is position[2] (actors.json x), halfword 1 position[0] (z).
    const [hz, hx] = rec.at[i];
    out.push({
      shown,
      colour: rec.colours[i] & 0x1f,
      x: round4((hz * 512) / 8192 + LOGIC_OFFSET_X),
      y: round4((hx * 512) / 8192 + LOGIC_OFFSET_Z),
    });
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// --- per arena -----------------------------------------------------------------

interface ArenaOut {
  mission: string;
  team0Side: number;
  reticle: number;
  contacts: Contact[];
  staticMarkers: { marker: number; x: number; y: number }[];
  claimMarkers: { x: number; y: number; markers: [number, number] }[];
}

let unitMarkers: UnitMarkers | null = null;
const arenas: Record<string, ArenaOut> = {};
FCOP_ARENAS.forEach((arena, reticleIndex) => {
  const m = markers.arenas[arena.mission];
  if (!m) throw new Error(`radar_markers.json has no ${arena.mission}`);
  const units = unitMarkersOf(m.actors);
  if (unitMarkers === null) unitMarkers = units;
  else if (JSON.stringify(unitMarkers) !== JSON.stringify(units)) {
    throw new Error(`${arena.mission}: unit markers differ from the first arena's`);
  }

  // Which original side Metropolis' team 0 holds: the X1Alpha record standing on
  // the map's spawn 0. Side 1 on every arena since SIM_VERSION 79, when
  // enrichArena.ts began ordering the teams by the original's player slot rather
  // than along the field axis (La Cantina's team 0 was side 2); render/sides.ts
  // is the identity on that, and this is the generator's check of it.
  const map = JSON.parse(
    readFileSync(join(ROOT, "packages", "sim", "maps", `${arena.mapId}.json`), "utf8"),
  ) as { spawns: { x: number; y: number }[] };
  const x1 = m.actors.filter((a) => a.resource === "Cact" && a.type === 1);
  const s0 = map.spawns[0];
  let best = x1[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const a of x1) {
    const d = Math.hypot(a.x + LOGIC_OFFSET_X - s0.x, a.z + LOGIC_OFFSET_Z - s0.y);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  if (bestD > 0.5) throw new Error(`${arena.mapId}: no X1Alpha on spawn 0 (nearest ${bestD} m)`);
  if (best.side_byte24 !== 1) {
    throw new Error(`${arena.mapId}: spawn 0's X1Alpha is side ${best.side_byte24}, not 1`);
  }

  // Placed actors that carry a marker and live, which Metropolis draws as no
  // entity: the outposts' green diamonds, Hk's / Joke's / Slim's marked props.
  const staticMarkers = m.actors
    .filter(
      (a) =>
        a.resource === "Cact" &&
        a.on_radar_when_live &&
        a.type !== 1 && // the X1-Alpha: an entity
        a.type !== 37, // the Sky Captain: an entity
    )
    .map((a) => ({
      marker: a.marker,
      x: round4(a.x + LOGIC_OFFSET_X),
      y: round4(a.z + LOGIC_OFFSET_Z),
    }));

  // The outposts' corner posts: marker 0 until the claim script of either side
  // posts its byte onto the group (order 0x3e on group byte 25).
  const claimMarkers: ArenaOut["claimMarkers"] = [];
  for (const a of m.actors) {
    if (a.resource !== "Cact" || a.type !== 11 || a.marker !== 0) continue;
    const posted = [
      ...new Set(m.claim_orders.filter((o) => o.target === a.group_byte25).map((o) => o.marker)),
    ].sort();
    if (posted.length === 0) continue;
    if (posted.length !== 2) throw new Error(`${arena.mission} group ${a.group_byte25}: ${posted}`);
    claimMarkers.push({
      x: round4(a.x + LOGIC_OFFSET_X),
      y: round4(a.z + LOGIC_OFFSET_Z),
      markers: [posted[0], posted[1]],
    });
  }

  arenas[arena.mapId] = {
    mission: arena.mission,
    team0Side: best.side_byte24,
    reticle: reticleIndex,
    contacts: contactsOf(arena.mission),
    staticMarkers,
    claimMarkers,
  };
});

// --- images ----------------------------------------------------------------------

mkdirSync(PUBLIC_HUD, { recursive: true });

/** Black is the original's transparent texel: alpha 0, everything else opaque. */
function keyBlack(pixels: Uint8Array): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) pixels[i + 3] = 0;
  }
}

const tex11 = decodePng(
  new Uint8Array(readFileSync(join(RE, "extracted", "textures", "GlblData", "tex11.png"))),
);
const tex11Px = new Uint8Array(tex11.pixels);
keyBlack(tex11Px);
writeFileSync(join(PUBLIC_HUD, "tex11.png"), encodePng({ ...tex11, pixels: tex11Px }));

copyFileSync(join(RE, "extracted", "fonts", "font3.png"), join(PUBLIC_HUD, "font3.png"));

const ret = hud.lock.reticle;
const strip = new Uint8Array(ret.w * FCOP_ARENAS.length * ret.h * 4);
FCOP_ARENAS.forEach((arena, k) => {
  const page = decodePng(
    new Uint8Array(readFileSync(join(RE, "extracted", "textures", arena.mission, "tex09.png"))),
  );
  for (let y = 0; y < ret.h; y++) {
    for (let x = 0; x < ret.w; x++) {
      const src = ((ret.v + y) * page.width + ret.u + x) * 4;
      const dst = (y * ret.w * FCOP_ARENAS.length + k * ret.w + x) * 4;
      strip.set(page.pixels.subarray(src, src + 4), dst);
    }
  }
});
keyBlack(strip);
writeFileSync(
  join(PUBLIC_HUD, "reticles.png"),
  encodePng({ width: ret.w * FCOP_ARENAS.length, height: ret.h, pixels: strip }),
);

// --- font3 -------------------------------------------------------------------------

const font = readJson<{
  glyphs: {
    ascii: number;
    atlas_x: number;
    atlas_y: number;
    width: number;
    height: number;
    advance: number;
    offset_x: number;
    offset_y: number;
  }[];
}>("extracted", "fonts", "font3.json");
const glyphRows: string[] = [];
for (let c = 32; c < 128; c++) {
  const g = font.glyphs.find((x) => x.ascii === c);
  glyphRows.push(
    g
      ? `[${g.atlas_x}, ${g.atlas_y}, ${g.width}, ${g.height}, ${g.advance}, ${g.offset_x}, ${g.offset_y}]`
      : "null",
  );
}

// --- emit ------------------------------------------------------------------------

const j = (v: unknown): string => JSON.stringify(v);
const w = hud.weapons;
const ag = hud.armour_gauge;
const radar = hud.radar;
const pm = hud.pause_map;
const units = unitMarkers as unknown as UnitMarkers;

const ts = `// GENERATED by tools/generators/importFcopPresentation.ts — do not edit by hand.
// Re-run \`bun run gen:presentation --re <RE checkout>\`.
//
// The original's presentation, from amigo-labs/fcop-reverse-engineering
// @ ${reCommit}: extracted/presentation/camera.json, hud.json and
// radar_markers.json (tools/logic/presentation_data.py, every value cited there to
// the decompiled C), extracted/fonts/font3.json, and each PA mission's type-35
// objective record. Positions are in the Metropolis map frame (actors.json x + ${LOGIC_OFFSET_X}).

/** The RE commit the tables were read at. */
export const PRESENTATION_RE_COMMIT = ${j(reCommit)};

// --- cameras (camera.json) -----------------------------------------------------

/** A chase preset: yaw delta and pitch (4096 a turn), plane height and offset (world units). */
export interface ChasePreset {
  readonly yawDelta: number;
  readonly pitch: number;
  /** The preset's height column (the pitch curve's for 0-8; the occlusion probes read it). */
  readonly height: number;
  readonly offset: readonly [number, number, number];
}

/** The nineteen presets at 0x0048c2a8 (view_place.c view_presets). */
export const CHASE_PRESETS: readonly ChasePreset[] = [
${camera.presets.map((p) => `  { yawDelta: ${p.yaw_delta}, pitch: ${p.pitch}, height: ${p.height}, offset: ${j(p.offset)} },`).join("\n")}
];

/** The eight camera-list rows (byte 1 the primary, then fallbacks, -1 ends a row). */
export const CHASE_LISTS: readonly (readonly number[])[] = [
${camera.camera_lists.map((l) => `  ${j(l.bytes)},`).join("\n")}
];

/** A camera entry: its flag word (bit 0 close, 1 side, 2 occlude, 3 closer) and list row. */
export interface ChaseEntry {
  readonly flags: number;
  readonly listRow: number;
}

/** The fifteen entries; the Camera Key cycles entries 0-6, the demo anchor the rest. */
export const CHASE_ENTRIES: readonly ChaseEntry[] = [
${camera.entries.map((e) => `  { flags: ${e.flags}, listRow: ${e.list_row} },`).join("\n")}
];

/** The names the caption shows, by camera (draw_camera_names). */
export const CAMERA_NAMES: readonly string[] = ${j(camera.camera_names)};

/** Whether the camera is reachable in Precinct Assault (5 and 6 need a volume trigger). */
export const CAMERA_IN_PA: readonly boolean[] = ${j(camera.cameras.map((c) => c.available_in_pa))};

/**
 * The converged eye and aim point per camera for a walker standing at height 0
 * facing yaw 0, relative to it, in world units, runtime frame (position[0],
 * position[1], position[2]). Floating point: the game's integers differ by a few units.
 */
export const CAMERA_STEADY_EYES: readonly {
  readonly eye: readonly [number, number, number];
  readonly aimPoint: readonly [number, number, number];
}[] = [
${camera.cameras.map((c) => `  { eye: ${j(c.steady_state_walker_subject_y0.eye)}, aimPoint: ${j(c.steady_state_walker_subject_y0.aim_point)} },`).join("\n")}
];

/** The camera caption: ticks shown, pen in 320 x 240 text space, text colour. */
export const CAMERA_CAPTION = {
  ticks: ${camera.caption.ticks},
  text320: ${j(camera.caption.position_text320)} as readonly [number, number],
  colour: ${camera.caption.colour},
} as const;

/** The original's software projection at 640 x 480 (focal 1024 px). */
export const CAMERA_PROJECTION = {
  hfovDeg: ${camera.projection.hfov_deg},
  vfovDeg: ${camera.projection.vfov_deg},
} as const;

// --- font 3 (the HUD's at 640 x 480) ------------------------------------------------

/**
 * Glyphs by char code - 32: [atlas x, atlas y, width, height, advance, offset x,
 * offset y], px at 640 x 480; null where the font has none.
 */
export const FONT3_GLYPHS: readonly (readonly number[] | null)[] = [
${glyphRows.map((r) => `  ${r},`).join("\n")}
];

/** The tallest glyph, px. */
export const FONT3_HEIGHT = ${hud.font.at_640x480.max_glyph_height_px};

/** The twenty text colours (entry 15 of each 16-step ramp), sRGB. */
export const TEXT_COLOURS: readonly (readonly [number, number, number])[] = ${j(hud.text_colours.palettes.map((p) => p.rgb))};

// --- the HUD (hud.json, px at 640 x 480) -------------------------------------------------

type R = readonly [number, number, number, number];
type P = readonly [number, number];

export const HUD = {
  weapons: [
${w.slots.map((s) => `    { icon: ${j([s.icon.u, s.icon.v, s.icon.w, s.icon.h])} as R, box: ${j(s.icon_box_px640)} as R, lower: ${j(s.lower_count_px640)} as P, upper: ${j(s.upper_count_px640)} as P },`).join("\n")}
  ],
  badge: {
    icon: ${j([w.extra_icons[0].icon.u, w.extra_icons[0].icon.v, w.extra_icons[0].icon.w, w.extra_icons[0].icon.h])} as R,
    own: ${j(w.extra_icons[0].box_px640)} as R,
    opponent: ${j(w.extra_icons[1].box_px640)} as R,
  },
  iconUnlit: ${j(w.icon_tint.unlit)} as readonly number[],
  iconLit: ${j(w.icon_tint.lit)} as readonly number[],
  lowerCountColour: ${w.lower_count.colour},
  upperCountColours: ${j(w.upper_count.colour_blink)} as P,
  gauge: {
    own: { backing: ${j(ag.own.backing_rect640)} as R, ticks: ${j(ag.own.ticks_rect640)} as readonly R[] },
    invulnerable: { backing: ${j(ag.invulnerable_blink.gauge.backing_rect640)} as R, ticks: ${j(ag.invulnerable_blink.gauge.ticks_rect640)} as readonly R[] },
    opponent: { backing: ${j(ag.opponent_gauge.gauge.backing_rect640)} as R, ticks: ${j(ag.opponent_gauge.gauge.ticks_rect640)} as readonly R[] },
    backingRgb: ${j(ag.backing.colour.rgb)} as readonly number[],
    tickRgb: ${j(ag.ticks.colour.rgb)} as readonly number[],
    invulnerableRgb: ${j(ag.invulnerable_blink.colour)} as readonly number[],
  },
  score: {
    plate: ${j(hud.score.plate_rect640)} as R,
    plate4: ${j(hud.score.plate_rect640_four_digits)} as R,
    text: ${j(hud.score.text_px640)} as P,
    text4: ${j([hud.score.text320_four_digits[0] * 2, hud.score.text320_four_digits[1] * 2])} as P,
    colours: ${j([hud.score.colour.slot0, hud.score.colour.slot1])} as P,
    alarm: ${hud.score.colour.alarm},
    plateRgb: ${j(hud.score.plate.colour.rgb)} as readonly number[],
  },
  counts: { plate: ${j(hud.counts.plate_rect640)} as R, text: ${j(hud.counts.text_px640)} as P },
  opponent: {
    scorePlate: ${j(hud.opponent_row.score_plate_rect640)} as R,
    scoreText: ${j(hud.opponent_row.score_text_px640)} as P,
    countsPlate: ${j(hud.opponent_row.counts_plate_rect640)} as R,
    countsText: ${j(hud.opponent_row.counts_text_px640)} as P,
  },
  level: { text: ${j(hud.level_caption.text_px640)} as P, colour: ${hud.level_caption.colour} },
  reticle: { size: ${hud.lock.reticle.size_px640}, texels: ${hud.lock.reticle.w} },
  beamRgb: ${j(hud.lock.beam.colour)} as readonly number[],
  radar: {
    disc: ${j([radar.disc.uv.u0, radar.disc.uv.v0, radar.disc.uv.u1 - radar.disc.uv.u0, radar.disc.uv.v1 - radar.disc.uv.v0])} as R,
    box: ${j(radar.disc.box_px640)} as R,
    centre: ${j(radar.disc.centre_px640)} as P,
    rangeWu: ${radar.range.value},
    pxPerWu: ${radar.rotation.scale_px_per_wu},
    tickInner: ${radar.rim.tick.inner_radius_px640},
    tickOuter: ${radar.rim.tick.outer_radius_px640},
    tickRgb: ${j(radar.rim.white_tick.colour)} as readonly number[],
    arrow: ${j(radar.rim.contact_arrows.shape_radial_tangential)} as readonly P[],
  },
  pauseMap: {
    samples: ${j([pm.terrain_window.samples_z, pm.terrain_window.samples_x])} as P,
    pxPerSample: ${pm.terrain_window.px_per_sample_640},
    panRateMax: ${pm.pan.rate_max},
    frame: ${j(pm.overview_54.frame_rects_rect640)} as readonly R[],
    borderRgb: ${j(pm.overview_54.border.rgb)} as readonly number[],
    fillRgb: ${j(pm.overview_54.fill.rgb)} as readonly number[],
    windowRgb: ${j(pm.overview_54.window_frame.colour.rgb)} as readonly number[],
  },
} as const;

/** The radar's 32 colours (index = marker & 0x1f), sRGB as they reach the screen; 0 none. */
export const RADAR_PALETTE: readonly (readonly [number, number, number] | null)[] = ${j(radar.palette.entries.map((e) => e.rgb))};

// --- markers (radar_markers.json) ----------------------------------------------------------

/** The marker byte each unit kind carries, [side 1, side 2] where it has a side. */
export const UNIT_MARKERS = {
  avatar: ${j(units.avatar)} as P,
  captain: ${units.captain},
  tank: ${j(units.tank)} as P,
  jet: ${j(units.jet)} as P,
  fortress: ${j(units.fortress)} as P,
  dreadnought: ${j(units.dreadnought)} as P,
  turret: ${j(units.turret)} as P,
  neutralTurret: ${units.neutralTurret},
  capturedTurret: ${j(units.capturedTurret)} as P,
  pickup: ${units.pickup},
} as const;

/** One arena's presentation data. */
export interface ArenaPresentation {
  /** The original mission. */
  readonly mission: string;
  /** The original side (1 red, 2 blue) whose X1-Alpha stands on the map's spawn 0: 1 on every arena. */
  readonly team0Side: 1 | 2;
  /** Column of reticles.png (16 px each). */
  readonly reticle: number;
  /** The type-35 record's contacts: shown bits (0 rim arrow, 1 map ring, 2 radar blip), palette index, m. */
  readonly contacts: readonly { readonly shown: number; readonly colour: number; readonly x: number; readonly y: number }[];
  /** Placed actors with a marker that Metropolis has no entity for. */
  readonly staticMarkers: readonly { readonly marker: number; readonly x: number; readonly y: number }[];
  /** The outposts' corner posts: [side 1's, side 2's] marker once claimed. */
  readonly claimMarkers: readonly { readonly x: number; readonly y: number; readonly markers: P }[];
}

export const ARENA_PRESENTATION: Readonly<Record<string, ArenaPresentation>> = ${j(arenas)} as unknown as Readonly<Record<string, ArenaPresentation>>;
`;

writeFileSync(OUT_TS, ts);
const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", OUT_TS], { cwd: ROOT });
if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
console.log(
  `importFcopPresentation: ${FCOP_ARENAS.length} arenas, RE ${reCommit.slice(0, 8)} -> ${OUT_TS}`,
);
