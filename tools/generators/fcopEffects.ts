// The original's effect records, as the client draws them (Phase 14 wave 4).
//
//   <RE>/extracted/effects/<Mission>.json   every (bank, id) record of the six
//                                           Precinct Assault arenas, decoded
//                                           (tools/gfx/pa_effects.py)
//   <RE>/extracted/effects/tables.json      units, rules, the executable's
//                                           constants (trail rects, the Mini
//                                           Gun ribbon, tracers)
//   <RE>/extracted/particles/particles.json the Cpyr atlas: per particle its
//   <RE>/extracted/particles/particles_page0.png  own A1R5G5B5 palette
//   <RE>/extracted/textures/<Mission>/tex10.png   the trail rect, the ribbon
//   ->
//   packages/client/src/effects/fcopEffects.generated.ts
//   packages/client/public/fx/particles.png   (the RE's page 0, unchanged)
//   packages/client/public/fx/particles.json  (the RE's, unchanged)
//   packages/client/public/fx/trails.png      (each arena's trail rect and
//                                              the ribbon's frames, cropped)
//
// Nothing here decides anything. It keeps the records a raise can reach — the
// world rows, the fifteen loadout records' blocks (the candidate impacts of the
// arced and dropped rounds included), the death classes, the mech's own wreck
// and transform — with their successors, folds identical records of the six
// arenas into one list, and writes the fields each class's drawer reads.
//
// Usage: bun run gen:fx [--re <RE checkout>] [--check]
//   --check regenerates in memory and fails when a committed file differs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FCOP_ARENAS } from "./fcopArenas";
import { type DecodedImage, decodePng, encodePng } from "./png";

const ROOT = join(import.meta.dir, "..", "..");
const OUT_TS = join(ROOT, "packages", "client", "src", "effects", "fcopEffects.generated.ts");
const PUBLIC_FX = join(ROOT, "packages", "client", "public", "fx");

/** trails.png's width: the trail rect (19) and the ribbon's frames (40) side by side. */
const TRAIL_ATLAS_W = 64;
/** One arena's row in trails.png: the trail rect is 64 texels tall. */
const TRAIL_ATLAS_ROW_H = 64;
/** Where the ribbon's frames go in each row (they sit at (215, 22) on tex10). */
const RIBBON_DST_X = 20;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The RE checkout: --re, FCOP_RE, or a sibling of this tree or its parent. */
export function findRe(): string | null {
  const given = argValue("--re") ?? process.env.FCOP_RE;
  if (given) return resolve(given);
  for (const up of ["..", join("..", ".."), join("..", "..", "..")]) {
    const p = resolve(ROOT, up, "fcop-reverse-engineering");
    if (existsSync(join(p, "extracted", "effects", "tables.json"))) return p;
  }
  return null;
}

// --- the export's shapes -----------------------------------------------------

interface RawHeader {
  type: number;
  successor: number;
  sound: number;
  angle_y: number;
  angle_x: number;
  offset: number;
  attach_point: number;
  repeats: number;
  flags: number;
}
interface RawDerivedHeader {
  lifetime_ticks: number;
  spawn_delay_ticks: number;
  repeat_period_ticks: number;
}
interface RawRecord {
  bank: number;
  id: number;
  type: number;
  header: RawHeader;
  header_derived: RawDerivedHeader;
  fields: Record<string, number | number[] | number[][] | string[]>;
  derived: Record<string, unknown>;
}
interface RawRaise {
  id?: number;
  raises?: { bank: number; id: number } | null;
  candidate?: { bank: number; id: number };
  chain?: { id: number }[];
  bank?: number;
}
interface RawWorldRow {
  projectile_cobj: number | null;
  launch_effect?: RawRaise | null;
  impact_effect?: RawRaise | null;
  fragment_effect?: RawRaise | null;
}
interface RawBlock {
  kind: number;
  [k: string]: unknown;
}
interface RawDeathStart {
  bank: number;
  id: number;
}
interface RawDeath {
  class: number;
  bank: number;
  start_ids: RawDeathStart[];
  by_damage_bit: Record<string, RawDeathStart[]>;
}
interface RawClass {
  groups: number[][];
  fallback: number;
}
interface RawMap {
  records: Record<string, Record<string, RawRecord>>;
  classes: Record<string, RawClass>;
  weapons: {
    world: Record<string, RawWorldRow>;
    player: Record<string, { A: RawBlock; B: RawBlock }>;
  };
  deaths: Record<string, RawDeath[]>;
}
interface RawParticle {
  index: number;
  id: number;
  size_pow2: number;
  sprites: {
    atlas_x: number;
    atlas_y: number;
    w: number;
    h: number;
    off_x: number;
    off_y: number;
  }[];
}
interface RawTables {
  exe: {
    trail_rects: { rows: { row: number; rect: number[] }[] };
    mini_gun_ribbon: {
      colour_from: number[];
      colour_to: number[];
      half_width_from: number;
      half_width_to: number;
      uv_frames: number[][];
      length: number;
    };
    tracers: Record<
      string,
      { rgb: number[]; length: number; width: number; speed: number | string }
    >;
  };
}
interface Manifest {
  id: number;
  sha256_16: string;
}

// --- reading -------------------------------------------------------------------

/** Every (bank, id) a raise can name on this arena, before successors. */
function roots(m: RawMap): [number, number][] {
  const out: [number, number][] = [];
  const add = (bank: number, id: number | undefined) => {
    if (id && id > 0) out.push([bank, id]);
  };
  const raise = (bank: number, e: RawRaise | null | undefined) => {
    if (!e) return;
    add(bank, e.id);
    if (e.raises) add(e.raises.bank, e.raises.id);
    if (e.candidate) add(e.candidate.bank, e.candidate.id);
  };
  for (const row of Object.values(m.weapons.world)) {
    raise(0, row.launch_effect);
    raise(0, row.impact_effect);
  }
  for (const w of Object.values(m.weapons.player)) {
    for (const blk of [w.A, w.B]) {
      for (const key of [
        "launch_effect",
        "muzzle_effect",
        "sustained_effect",
        "impact_effect",
        "fragment_effect",
      ]) {
        const e = blk[key] as RawRaise | string | null | undefined;
        if (e && typeof e === "object") raise(1, e);
      }
      const link = blk.link as RawRaise | null | undefined;
      if (link && typeof link === "object" && link.id) add(link.bank ?? 1, link.id);
    }
  }
  for (const rows of Object.values(m.deaths)) {
    for (const d of rows) {
      for (const s of d.start_ids) add(s.bank, s.id);
      for (const list of Object.values(d.by_damage_bit)) for (const s of list) add(s.bank, s.id);
      // The class row itself: every group's ids and the coin's fallback, the
      // way audio/cues.ts emitDeath raises them.
      const row = m.classes[String(d.class)];
      if (row) {
        for (const g of row.groups) for (const id of g) add(d.bank, id);
        add(d.bank, row.fallback);
      }
    }
  }
  // The mech's own: its wreck (player_op4: 3 and 9) and the transform (4).
  for (const id of [3, 4, 9]) add(1, id);
  return out;
}

function num(v: unknown): number {
  if (typeof v !== "number") throw new Error(`expected a number, got ${JSON.stringify(v)}`);
  return v;
}
function rgb(v: unknown): number[] {
  if (!Array.isArray(v) || v.length !== 3)
    throw new Error(`expected rgb, got ${JSON.stringify(v)}`);
  return v.map(num);
}

/** One record as the client's FxRecord (effects/records.ts). */
function visual(r: RawRecord): Record<string, unknown> {
  const h = r.header;
  const hd = r.header_derived;
  const f = r.fields;
  const d = r.derived;
  const head = {
    type: r.type,
    next: h.successor,
    delay: hd.spawn_delay_ticks,
    repeats: h.repeats,
    period: hd.repeat_period_ticks,
    life: hd.lifetime_ticks,
    flags: h.flags,
    offset: h.offset,
    placeY: h.angle_y,
    placeX: h.angle_x,
    attach: h.attach_point,
  };
  switch (r.type) {
    case 87: {
      const tex = d.texture as { rows: number[] } | null;
      return {
        ...head,
        halfWidth: num(f.head_half_width),
        widthRate: num(d.width_rate),
        stageRgb: (f.stage_rgb as number[][]).flatMap(rgb),
        stageTicks: (f.stage_ticks as number[]).map(num),
        spacing: num(f.spacing),
        emitAngleY: num(f.emit_angle_y),
        emitAngleX: num(f.emit_angle_x),
        emitSpeed: num(f.emit_speed),
        velocityJitter: num(f.velocity_jitter),
        gravity: num(f.gravity),
        drag: num(f.drag),
        trailFlags: num(d.instance_flags),
        rect: tex ? (tex.rows[0] ?? 0) : -1,
      };
    }
    case 88:
      return {
        ...head,
        scatter: num(f.far_end_scatter),
        segments: num(f.segments),
        strands: num(f.strands),
        rgb: rgb(f.rgb),
        fadeTicks: num(f.fade_ticks),
        amplitude: num(f.amplitude),
        endHalfWidth: num(f.end_half_width),
        linkFlags: num(f.link_flags),
      };
    case 89:
      return {
        ...head,
        radius: num(f.radius),
        wedgeCap: num(f.wedge_cap),
        radiusGrowth: num(f.radius_growth),
        centreTicks: num(f.centre_ramp_ticks),
        rimTicks: num(f.rim_ramp_ticks),
        centreFrom: rgb(f.centre_from),
        centreTo: rgb(f.centre_to),
        rimFrom: rgb(f.rim_from),
        rimTo: rgb(f.rim_to),
        emitAngleY: num(f.emit_angle_y),
        emitAngleX: num(f.emit_angle_x),
        speed: num(f.speed),
        gravityY: num(f.gravity_y),
        phaseLow: num(f.phase_low),
        startAngle: num(f.start_angle),
        flashFlags: num(f.flash_flags),
      };
    case 90:
      return {
        ...head,
        magnitudeLo: num(f.magnitude_lo),
        magnitudeHi: num(f.magnitude_hi),
        driftScaleLo: num(f.drift_scale_lo),
        driftScaleHi: num(f.drift_scale_hi),
        driftAngleY: num(f.drift_angle_y),
        driftAngleX: num(f.drift_angle_x),
        count: num(f.count),
        shatterFlags: num(f.shatter_flags),
      };
    case 92:
      return {
        ...head,
        growth: num(f.growth_rate),
        decay: num(f.rate_decay),
        maxRadius: num(f.max_radius),
        thickness: num(f.thickness),
        angleY: num(f.angle_y),
        angleX: num(f.angle_x),
        segments: num(d.segments_effective),
        inner: rgb(f.inner_rgb),
        outer: rgb(f.outer_rgb),
        fade: num(f.fade_rate),
        startRadius: num(f.start_radius),
        spinY: num(f.spin_y),
        spinX: num(f.spin_x),
        shellFlags: num(f.shell_flags),
      };
    case 93:
      return {
        ...head,
        particle: typeof d.particle_index === "number" ? d.particle_index : -1,
        size: num(f.size),
        emitAngleY: num(f.emit_angle_y),
        emitAngleX: num(f.emit_angle_x),
        speed: num(f.speed),
        fall: num(f.fall),
        colourFrom: rgb(f.colour_from),
        colourTo: rgb(f.colour_to),
        rampTicks: num(f.ramp_ticks),
        grow: num(f.grow),
        angleY: num(f.angle_y),
        angleX: num(f.angle_x),
        spinY: num(f.spin_y),
        spinX: num(f.spin_x),
        // The node's own flags are the low byte | 0x40 (0x0042f0b1); bit 8
        // (the drain) stays where the record has it.
        emitterFlags: num(f.emitter_flags),
      };
    case 94:
      return {
        ...head,
        nodeCount: num(f.node_count),
        nodeCap: num(f.node_cap),
        speedLo: num(f.speed_lo),
        speedHi: num(f.speed_hi),
        gravity: num(f.gravity),
        windAngleY: num(f.wind_angle_y),
        windAngleX: num(f.wind_angle_x),
        windSpeed: num(f.wind_speed),
        drag: num(f.drag),
        dragDivisor: num(f.drag_divisor),
        orientYaw: num(f.orient_yaw),
        orientPitch: num(f.orient_pitch),
        pitchLo: num(f.pitch_lo),
        pitchHi: num(f.pitch_hi),
        rectSize: num(d.rect_size_effective),
        colourA: rgb(f.colour_a),
        colourB: rgb(f.colour_b),
        rampTicks: num(f.ramp_ticks),
        rampFlags: num(f.ramp_flags),
        walkFlags: num(f.walk_flags),
        spawnRadius: num(f.spawn_radius),
        velocityJitter: num(f.velocity_jitter),
        positionJitter: num(f.position_jitter),
      };
    default:
      throw new Error(`record (${r.bank}, ${r.id}) has type ${r.type}, which no class draws`);
  }
}

/**
 * Each world row's projectile, by payload: the six arenas number their Cobjs
 * differently, so a row's id is checked against Mp's by `sha256_16` and the
 * row names the one model the client ships for it.
 */
const ROW_MODEL: Readonly<Record<number, string>> = {
  1: "round-row1",
  3: "round-row3",
  4: "round-row4",
  6: "round-row6",
  8: "round-row8",
  9: "round-row9",
};

// --- the run -------------------------------------------------------------------

export interface FxOutputs {
  ts: string;
  files: { path: string; bytes: Uint8Array }[];
  report: string;
}

export function generate(re: string): FxOutputs {
  const read = <T>(...p: string[]): T => JSON.parse(readFileSync(join(re, ...p), "utf8")) as T;
  const tables = read<RawTables>("extracted", "effects", "tables.json");
  const particlesJson = readFileSync(join(re, "extracted", "particles", "particles.json"));
  const particles = JSON.parse(particlesJson.toString("utf8")) as { particles: RawParticle[] };

  const records: string[] = [];
  const index = new Map<string, number>();
  const arenas: string[] = [];
  const rowPayload = new Map<number, string>();
  const trailRows: DecodedImage[] = [];
  let reachable = 0;

  for (const [ai, arena] of FCOP_ARENAS.entries()) {
    const m = read<RawMap>("extracted", "effects", `${arena.mission}.json`);
    const banks: Record<number, number>[] = [{}, {}];
    const seen = new Set<string>();
    const queue = roots(m);
    while (queue.length > 0) {
      const [bank, id] = queue.pop() as [number, number];
      const key = `${bank}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = m.records[String(bank)]?.[String(id)];
      if (!r) continue; // a raise of an empty slot draws nothing
      const v = JSON.stringify(visual(r));
      let i = index.get(v);
      if (i === undefined) {
        i = records.length;
        records.push(v);
        index.set(v, i);
      }
      banks[bank][id] = i;
      reachable++;
      if (r.header.successor > 0) queue.push([bank, r.header.successor]);
    }
    const sorted = (b: Record<number, number>) =>
      `{ ${Object.keys(b)
        .map(Number)
        .sort((x, y) => x - y)
        .map((id) => `${id}: ${b[id]}`)
        .join(", ")} }`;
    arenas.push(
      `  ${JSON.stringify(arena.mapId)}: { mission: ${JSON.stringify(arena.mission)}, trailRow: ${ai}, banks: [${sorted(banks[0])}, ${sorted(banks[1])}] },`,
    );

    // The rows' projectiles must be one payload on every arena.
    const manifest = read<Manifest[]>("extracted", "objects", arena.mission, "manifest.json");
    for (const [row, w] of Object.entries(m.weapons.world)) {
      if (!ROW_MODEL[Number(row)] || w.projectile_cobj === null) continue;
      const sha = manifest.find((o) => o.id === w.projectile_cobj)?.sha256_16;
      if (!sha)
        throw new Error(`${arena.mission} row ${row}: Cobj ${w.projectile_cobj} not exported`);
      const was = rowPayload.get(Number(row));
      if (was && was !== sha) {
        throw new Error(
          `${arena.mission} row ${row}: Cobj ${w.projectile_cobj} is payload ${sha}, Mp's is ${was} — the row needs a model per arena`,
        );
      }
      rowPayload.set(Number(row), sha);
    }

    // This arena's trail rect and the ribbon's frames, from its own tex10.
    const tex = decodePng(
      new Uint8Array(readFileSync(join(re, "extracted", "textures", arena.mission, "tex10.png"))),
    );
    trailRows.push(tex);
  }

  // trails.png: one 64-texel row per arena — the trail rect (row 0, the only
  // row a shipped record selects) at x 0, the ribbon's three frames at x 20.
  const trailRect = tables.exe.trail_rects.rows.find((r) => r.row === 0)?.rect;
  if (!trailRect) throw new Error("tables.json has no trail rect row 0");
  const [tx, ty, tw, th] = trailRect;
  const ribbon = tables.exe.mini_gun_ribbon;
  const rx0 = Math.min(...ribbon.uv_frames.map((f) => f[0]));
  const ry0 = Math.min(...ribbon.uv_frames.map((f) => f[1]));
  const rx1 = Math.max(...ribbon.uv_frames.map((f) => f[2]));
  const ry1 = Math.max(...ribbon.uv_frames.map((f) => f[3]));
  const atlasH = TRAIL_ATLAS_ROW_H * trailRows.length;
  const atlas = new Uint8Array(TRAIL_ATLAS_W * atlasH * 4);
  const blit = (
    src: DecodedImage,
    sx: number,
    sy: number,
    w: number,
    h: number,
    dx: number,
    dy: number,
  ) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((sy + y) * src.width + sx + x) * 4;
        const d = ((dy + y) * TRAIL_ATLAS_W + dx + x) * 4;
        atlas[d] = src.pixels[s];
        atlas[d + 1] = src.pixels[s + 1];
        atlas[d + 2] = src.pixels[s + 2];
        atlas[d + 3] = src.pixels[s + 3];
      }
    }
  };
  for (const [i, tex] of trailRows.entries()) {
    blit(tex, tx, ty, tw, th, 0, i * TRAIL_ATLAS_ROW_H);
    blit(tex, rx0, ry0, rx1 - rx0 + 1, ry1 - ry0 + 1, RIBBON_DST_X, i * TRAIL_ATLAS_ROW_H);
  }
  const trailsPng = encodePng({ width: TRAIL_ATLAS_W, height: atlasH, pixels: atlas });

  const parts = particles.particles.map((p) => {
    const s = p.sprites[0];
    return `  { id: ${p.id}, sizePow2: ${p.size_pow2}, x: ${s.atlas_x}, y: ${s.atlas_y}, w: ${s.w}, h: ${s.h}, offX: ${s.off_x}, offY: ${s.off_y} },`;
  });
  const tr = tables.exe.tracers;
  const tracer = (k: string) => {
    const t = tr[k];
    if (!t) throw new Error(`tables.json has no tracer ${k}`);
    // The Laser's speed is "base + (game_rand() & 0x1f000)": base and spread.
    const speed = typeof t.speed === "number" ? t.speed : Number.parseInt(String(t.speed), 16);
    const spread = typeof t.speed === "number" ? 0 : 0x1f000;
    return `{ rgb: ${JSON.stringify(t.rgb)}, length: ${t.length}, width: ${t.width}, speed: ${speed}, speedSpread: ${spread} }`;
  };
  const rows = [...rowPayload.keys()].sort((a, b) => a - b);

  const ts = `// GENERATED by tools/generators/fcopEffects.ts from the RE repo's effect export
// (extracted/effects/<Mission>.json, tables.json, extracted/particles/) — do not
// edit by hand. Re-run \`bun run gen:fx\`.
//
// The records a raise can reach on the six Precinct Assault arenas, folded:
// identical records of different arenas are one entry. Units and field
// meanings: effects/records.ts and the RE's docs/formats/effects.md.

import type { FxArena, FxParticle, FxRecord } from "./records";

/** Every distinct record, by the index the arenas' banks name. */
export const FX_RECORDS: readonly FxRecord[] = [
${records.map((r) => `  ${r},`).join("\n")}
];

/** Each arena's banks (0 the mission's, 1 the player's), by Metropolis map id. */
export const FX_ARENAS: Readonly<Record<string, FxArena>> = {
${arenas.join("\n")}
};

/** The Cpyr particles by index (public/fx/particles.png; particles.json). */
export const FX_PARTICLES: readonly FxParticle[] = [
${parts.join("\n")}
];

/** The model the client draws for each world row's round (one payload on all six arenas). */
export const FX_ROW_MODELS: Readonly<Record<number, string>> = {
${rows.map((r) => `  ${r}: ${JSON.stringify(ROW_MODEL[r])},`).join("\n")}
};

/** trails.png: one row per arena (FxArena.trailRow), its trail rect and the ribbon's frames. */
export const FX_TRAIL_ATLAS = {
  width: ${TRAIL_ATLAS_W},
  height: ${atlasH},
  rowHeight: ${TRAIL_ATLAS_ROW_H},
  /** Trail rect row 0 (exe 0x0048c568), at the row's x 0. */
  trail: { x: 0, w: ${tw}, h: ${th} },
  /** The Mini Gun ribbon's three frames (exe 0x0048c540), (u0, v0, u1, v1) in the row. */
  ribbon: ${JSON.stringify(ribbon.uv_frames.map(([a, b, c, d]) => [a - rx0 + RIBBON_DST_X, b - ry0, c - rx0 + RIBBON_DST_X, d - ry0]))},
} as const;

/** The constants the executable carries (tables.json exe). */
export const FX_EXE = {
  /** The Mini Gun ribbon (0x0048c520): colour, half-width x16, length in world units. */
  ribbon: { rgb: ${JSON.stringify(ribbon.colour_from)}, halfWidth: ${ribbon.half_width_from}, length: ${ribbon.length} },
  /** Tracers (0x0043c120): length x16, width (/4, x16), speed in world units a second. */
  tracers: {
    world: ${tracer("world_hitscan")},
    laserA: ${tracer("laser_block_a")},
    laserB: ${tracer("laser_block_b")},
  },
} as const;
`;

  const files = [
    {
      path: join(PUBLIC_FX, "particles.png"),
      bytes: new Uint8Array(
        readFileSync(join(re, "extracted", "particles", "particles_page0.png")),
      ),
    },
    { path: join(PUBLIC_FX, "particles.json"), bytes: new Uint8Array(particlesJson) },
    { path: join(PUBLIC_FX, "trails.png"), bytes: trailsPng },
  ];
  const report = `gen:fx: ${FCOP_ARENAS.length} arenas, ${reachable} reachable records -> ${records.length} distinct; ${particles.particles.length} particles; trails.png ${TRAIL_ATLAS_W}x${atlasH}`;
  return { ts, files, report };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function main(): void {
  const re = findRe();
  if (!re) {
    console.error("gen:fx: no RE checkout — pass --re <path> or set FCOP_RE");
    process.exit(2);
  }
  const check = process.argv.includes("--check");
  const out = generate(re);
  // Written as generated: biome.json leaves this one file's formatting alone, so
  // a record stays one line and --check compares bytes without a formatter.
  const all = [{ path: OUT_TS, bytes: new TextEncoder().encode(out.ts) }, ...out.files];
  if (check) {
    const stale = all.filter(
      (f) => !existsSync(f.path) || !sameBytes(new Uint8Array(readFileSync(f.path)), f.bytes),
    );
    for (const f of stale) console.error(`stale: ${f.path}`);
    console.log(out.report);
    if (stale.length > 0) process.exit(1);
    console.log("--check: every committed file matches");
    return;
  }
  for (const f of all) writeFileSync(f.path, f.bytes);
  console.log(out.report);
}

if (import.meta.main) main();
