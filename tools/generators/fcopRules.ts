// Reads the reverse-engineered Precinct Assault RULES of each arena out of the
// private RE repo and writes them into this repo as a committed, deterministic
// artifact (tools/generators/fcop/<mission>-rules.json), next to the actor and
// Cnet extraction fcopLogic.ts writes.
//
// The RE side (tools/logic/pa_rules_data.py -> extracted/logic/<Mission>/
// pa_rules.json) reads what the mission scripts and records do: the X1Alpha
// facing, the material code of every terrain sample (water, the base floors that
// hurt the enemy mech), the heavy-unit zones and the function that opens them,
// the tank queues and their periods, the spawner every unit leaves from, the
// shop's trigger boxes, Hk's spawn guards, the pickups and the lifts. The
// arithmetic behind each value is in that file's `_conventions`; this copy keeps
// the values and the raw words the enrich stage converts, and drops the script
// traces.
//
//   bun run gen:parules [all | <mapId> | <Mission>] [--re-repo <path>]
//
// Same CLI as gen:palogic. Authoring-time only: the committed JSON is the
// artifact, and enrichArena.ts is the only reader.
//
// FRAME: positions stay in the actors.json frame (x = runtime position[2] /
// 8192, z = runtime position[0] / 8192), exactly as the logic artifact's. The
// enrich stage applies the same LOGIC_OFFSET to both.
//
// SLOTS: the original's player slot 0 is X1Alpha actor 12, slot 1 actor 16. The
// RE file's `side` 1/2 is slot 0/1. Which Metropolis team a slot is falls out of
// the enrich stage's base pairing, so this file never says "team".

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FcopArena, rulesFile, selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";
import { requireReRepo } from "./reRepo";

// ---------------------------------------------------------------------------
// The RE file, as far as this reads it
// ---------------------------------------------------------------------------

interface ReX1 {
  actor_id: number;
  slot: number;
  x: number;
  z: number;
  facing_raw: number;
  hover: boolean;
  layer: number;
}

interface RePlate {
  code: number;
  height_m: number;
}

interface ReSurface {
  grid: { cols: number; rows: number; answered_cols: number; answered_rows: number };
  alphabet: string;
  rows: string[];
  stacked: { x: number; z: number; plates: RePlate[] }[];
  water: { levels: { min_m: number; max_m: number }[]; rows: string[] };
  damage_floors: { code: number; hurts_slot: number; walker_damage_per_step: number }[];
}

interface ReZone {
  actor_id: number;
  x: number;
  z: number;
  role: string;
  slot?: number;
  unit?: string;
  template?: number;
  price?: number;
  radius_raw: number;
  outpost?: number;
  sells_tank?: { template: number; queue_fn: string; price: number };
  sells_jet?: { template: number; price: number };
}

interface ReEnable {
  slot: number;
  points_at_least: number;
  poll_units: number;
  enables: number[];
  also_requests: number[];
}

interface ReFed {
  by: string;
}

interface ReQueue {
  fn: string;
  template: number;
  kind: string;
  side: number;
  period_units: number;
  outpost: { outpost: number; slot: number; via: string } | null;
  fed_by: ReFed[];
}

interface ReSpawner {
  template: number;
  kind: string;
  side: number;
  x: number;
  z: number;
  net_id: number | null;
  tsac: { limit: number };
}

interface ReBox {
  raw: { width: number; length: number; height: number };
}

interface ReBuy {
  actor_id: number;
  x: number;
  z: number;
  watch_slot: number;
  box: ReBox;
  price: number;
  sells: { kind: string; template: number; queue_fn?: string };
}

interface ReGuard {
  actor_id: number;
  x: number;
  z: number;
  watch_slot: number;
  box: ReBox;
  damage: number;
  latch_reset_by: { fn: string; period_units: number }[];
}

interface RePickup {
  template: number;
  x: number;
  z: number;
  kind: string;
  ammo_slots: number[];
  power_up_slots: number[];
  effect: { cloak_ticks: number; invulnerability_ticks: number };
  tsac: { period_units: number };
  box_raw: { half_0: number; half_1: number; half_2: number };
  height_offset_raw: number;
  cobj: number;
  requested_by: { by: string }[];
}

interface ReStop {
  raw: number;
  dwell_raw: number;
  dwell_ticks: number;
}

interface ReLift {
  actor_id: number;
  x: number;
  z: number;
  ground_m: number;
  starts_at: number;
  first_move_toward: number;
  stops: ReStop[];
  speed_raw: { forward: number; backward: number };
  speed_wu_per_tick: { forward: number; backward: number };
  yaw_raw: number;
  mode: number;
  tag: number;
  tag_hurts_slot: number | null;
  travel_sound: number;
  arrival_sound: number;
  cobj: number;
  footprint: {
    offset_m: { x0: number; x1: number; z0: number; z1: number };
    reach_m: number;
    top_above_position_m: number;
  };
}

interface ReRules {
  map: string;
  x1alpha: ReX1[];
  surface: ReSurface;
  zones: ReZone[];
  heavy_zone_enable: ReEnable[];
  start_functions: { fn: string }[];
  queues: ReQueue[];
  spawners: ReSpawner[];
  buy_triggers: ReBuy[];
  damage_triggers: ReGuard[];
  pickups: RePickup[];
  elevators: ReLift[];
}

// ---------------------------------------------------------------------------
// The committed artifact
// ---------------------------------------------------------------------------

/** One stacked terrain sample: its floor plates, top first. */
export interface RulesStacked {
  x: number;
  z: number;
  plates: { code: number; heightM: number }[];
}

/** tools/generators/fcop/<mission>-rules.json. */
export interface FcopRules {
  mission: string;
  mapId: string;
  source: { repo: string; commit: string; tool: string };
  frame: string;
  /** The two X1Alpha records: facing raw (4096 = one turn), negative = hover. */
  x1alpha: { id: number; slot: number; x: number; z: number; facingRaw: number; hover: boolean }[];
  surface: {
    cols: number;
    rows: number;
    /** The query answers nothing past these (the last cell row and column). */
    answeredCols: number;
    answeredRows: number;
    /** `alphabet[i]` is material code i; '.' is no floor plate. */
    alphabet: string;
    /** codes[z][x]: the code of the sample's highest floor plate. */
    codes: string[];
    /** Samples whose plates carry different codes (a floor under a roof). */
    stacked: RulesStacked[];
    /** Code-1 samples index these: the plate's corner height range in metres. */
    waterLevels: { minM: number; maxM: number }[];
    waterRows: string[];
  };
  /** Codes 14/15: one damage a movement step to that slot's mech only. */
  damageFloors: { code: number; hurtsSlot: number; damagePerStep: number }[];
  heavyZones: {
    id: number;
    slot: number;
    unit: "dreadnought" | "flying_fortress";
    x: number;
    z: number;
    radiusRaw: number;
    price: number;
    template: number;
  }[];
  /**
   * Each outpost's shop per slot: its activation zone queues a tank from
   * `tankTemplate` on `tankQueueFn`, its claim zone spawns a jet from
   * `jetTemplate` at once.
   */
  outpostShop: {
    outpost: number;
    slot: number;
    tankTemplate: number;
    tankQueueFn: string;
    tankPrice: number;
    jetTemplate: number;
    jetPrice: number;
  }[];
  /**
   * The polled function that opens a slot's two heavy zones for good (fn30 /
   * fn31), and the Csac templates its code requests in the same run: the two
   * type-11 terminals that stand by the zones from then on.
   */
  heavyEnable: {
    slot: number;
    pointsAtLeast: number;
    pollUnits: number;
    zones: number[];
    terminals: number[];
  }[];
  queues: {
    fn: string;
    template: number;
    kind: string;
    slot: number;
    /** Authored units, 1/60 s. */
    periodUnits: number;
    outpost: number | null;
    /** A mech's purchase feeds it (a Cact touch or trigger script). */
    humanFed: boolean;
    /** The one-player script (the Sky Captain's side) feeds it. */
    captainFed: boolean;
  }[];
  /** Every spawner a queue, a shop trigger or a heavy zone asks for. */
  spawners: {
    template: number;
    kind: string;
    slot: number;
    x: number;
    z: number;
    netId: number | null;
    limit: number;
  }[];
  buyTriggers: {
    id: number;
    slot: number;
    x: number;
    z: number;
    widthRaw: number;
    lengthRaw: number;
    heightRaw: number;
    price: number;
    kind: string;
    template: number;
    queueFn: string | null;
  }[];
  /** Hk's two boxes that hurt the enemy mech in a base instead of a floor. */
  spawnGuards: {
    id: number;
    hurtsSlot: number;
    x: number;
    z: number;
    widthRaw: number;
    lengthRaw: number;
    heightRaw: number;
    damage: number;
    resetUnits: number;
  }[];
  pickups: {
    template: number;
    x: number;
    z: number;
    kind: string;
    ammoSlots: number[];
    powerUpSlots: number[];
    /** Engine ticks (300 Hz). */
    cloakTicks: number;
    invulnerabilityTicks: number;
    /** |tSAC period|, authored units: the respawn after a collection. */
    respawnUnits: number;
    /** Record halfwords +0x26, +0x28, +0x2a: runtime axes 0 (z), 1 (y), 2 (x). */
    halfRaw: number[];
    heightOffsetRaw: number;
    cobj: number;
    /** A start function requests it at the first poll of the match. */
    atStart: boolean;
  }[];
  lifts: {
    id: number;
    x: number;
    z: number;
    groundM: number;
    startsAt: number;
    firstMoveToward: number;
    stopsRaw: number[];
    dwellRaw: number[];
    /** Engine ticks (300 Hz). */
    dwellTicks: number[];
    speedRaw: { forward: number; backward: number };
    /** World units (8192 a metre) an engine tick. */
    speedWuPerTick: { forward: number; backward: number };
    yawRaw: number;
    mode: number;
    tag: number;
    hurtsSlot: number | null;
    travelSound: number;
    arrivalSound: number;
    cobj: number;
    footprint: { x0: number; x1: number; z0: number; z1: number; reachM: number; topM: number };
  }[];
}

const slotOfSide = (side: number): number => {
  if (side !== 1 && side !== 2) throw new Error(`side ${side} is neither 1 nor 2`);
  return side - 1;
};

/**
 * The Csac templates a heavy-zone poll requests (`spawn_actor(t, 0x47, 0)` in
 * fn30 / fn31's code, RE `also_requests`): on every PA mission two type-11
 * DynamicProps, the Dreadnought's and the Flying Fortress's terminals.
 */
function terminalsOf(arena: FcopArena, re: ReRules, e: ReEnable): number[] {
  const out = [...e.also_requests].sort((a, b) => a - b);
  for (const t of out) {
    const s = re.spawners.find((q) => q.template === t);
    if (s?.kind !== "dynamic_prop") {
      throw new Error(`${arena.mapId}: slot ${e.slot}'s heavy poll requests ${t}, no terminal`);
    }
  }
  if (out.length !== 2) {
    throw new Error(`${arena.mapId}: slot ${e.slot}'s heavy poll requests ${out.length}, want 2`);
  }
  return out;
}

/** The RE file's rows, trimmed to what the enrich stage reads. */
export function buildRules(arena: FcopArena, re: ReRules, source: FcopRules["source"]): FcopRules {
  if (re.map !== arena.mission) {
    throw new Error(`${arena.mapId}: pa_rules.json is ${re.map}, expected ${arena.mission}`);
  }
  const startFns = new Set(re.start_functions.map((f) => f.fn));

  const heavyZones = re.zones
    .filter((z) => z.role === "dreadnought_purchase" || z.role === "flying_fortress_purchase")
    .map((z) => {
      if (z.slot === undefined || z.template === undefined || z.price === undefined) {
        throw new Error(`${arena.mapId}: heavy zone ${z.actor_id} lacks its slot/template/price`);
      }
      return {
        id: z.actor_id,
        slot: z.slot,
        unit: (z.role === "dreadnought_purchase" ? "dreadnought" : "flying_fortress") as
          | "dreadnought"
          | "flying_fortress",
        x: z.x,
        z: z.z,
        radiusRaw: z.radius_raw,
        price: z.price,
        template: z.template,
      };
    })
    .sort((a, b) => a.slot - b.slot || a.unit.localeCompare(b.unit));

  const outpostShop: FcopRules["outpostShop"] = [];
  for (const z of re.zones) {
    if (z.role !== "outpost_activation" || !z.sells_tank) continue;
    const claim = re.zones.find(
      (c) => c.role === "outpost_claim" && c.outpost === z.outpost && c.slot === z.slot,
    );
    if (z.outpost === undefined || z.slot === undefined || !claim?.sells_jet) {
      throw new Error(`${arena.mapId}: outpost zone ${z.actor_id} lacks its claim zone's jet`);
    }
    outpostShop.push({
      outpost: z.outpost,
      slot: z.slot,
      tankTemplate: z.sells_tank.template,
      tankQueueFn: z.sells_tank.queue_fn,
      tankPrice: z.sells_tank.price,
      jetTemplate: claim.sells_jet.template,
      jetPrice: claim.sells_jet.price,
    });
  }
  outpostShop.sort((a, b) => a.outpost - b.outpost || a.slot - b.slot);

  const queues = re.queues.map((q) => ({
    fn: q.fn,
    template: q.template,
    kind: q.kind,
    slot: slotOfSide(q.side),
    periodUnits: q.period_units,
    outpost: q.outpost ? q.outpost.outpost : null,
    humanFed: q.fed_by.some((f) => f.by.startsWith("Cact")),
    captainFed: q.fed_by.some((f) => f.by.startsWith("fn")),
  }));

  const wanted = new Set<number>([
    ...queues.map((q) => q.template),
    ...heavyZones.map((z) => z.template),
    ...re.buy_triggers.map((b) => b.sells.template),
    ...outpostShop.flatMap((o) => [o.tankTemplate, o.jetTemplate]),
  ]);
  const spawners = re.spawners
    .filter((s) => wanted.has(s.template))
    .map((s) => ({
      template: s.template,
      kind: s.kind,
      slot: slotOfSide(s.side),
      x: s.x,
      z: s.z,
      netId: s.net_id,
      limit: s.tsac.limit,
    }))
    .sort((a, b) => a.template - b.template);
  for (const t of wanted) {
    if (!spawners.some((s) => s.template === t)) {
      throw new Error(`${arena.mapId}: template ${t} is asked for but has no spawner`);
    }
  }

  return {
    mission: arena.mission,
    mapId: arena.mapId,
    source,
    frame:
      "actors.json: x = runtime position[2] / 8192, z = runtime position[0] / 8192 (metres); " +
      "raw words as the records store them",
    x1alpha: re.x1alpha.map((x) => ({
      id: x.actor_id,
      slot: x.slot,
      x: x.x,
      z: x.z,
      facingRaw: x.facing_raw,
      hover: x.hover,
    })),
    surface: {
      cols: re.surface.grid.cols,
      rows: re.surface.grid.rows,
      answeredCols: re.surface.grid.answered_cols,
      answeredRows: re.surface.grid.answered_rows,
      alphabet: re.surface.alphabet,
      codes: re.surface.rows,
      stacked: re.surface.stacked.map((s) => ({
        x: s.x,
        z: s.z,
        plates: s.plates.map((p) => ({ code: p.code, heightM: p.height_m })),
      })),
      waterLevels: re.surface.water.levels.map((l) => ({ minM: l.min_m, maxM: l.max_m })),
      waterRows: re.surface.water.rows,
    },
    damageFloors: re.surface.damage_floors.map((f) => ({
      code: f.code,
      hurtsSlot: f.hurts_slot,
      damagePerStep: f.walker_damage_per_step,
    })),
    heavyZones,
    outpostShop,
    heavyEnable: re.heavy_zone_enable.map((e) => ({
      slot: e.slot,
      pointsAtLeast: e.points_at_least,
      pollUnits: e.poll_units,
      zones: [...e.enables].sort((a, b) => a - b),
      terminals: terminalsOf(arena, re, e),
    })),
    queues,
    spawners,
    buyTriggers: re.buy_triggers.map((b) => ({
      id: b.actor_id,
      slot: b.watch_slot,
      x: b.x,
      z: b.z,
      widthRaw: b.box.raw.width,
      lengthRaw: b.box.raw.length,
      heightRaw: b.box.raw.height,
      price: b.price,
      kind: b.sells.kind,
      template: b.sells.template,
      queueFn: b.sells.queue_fn ?? null,
    })),
    spawnGuards: re.damage_triggers.map((g) => {
      if (g.latch_reset_by.length !== 1) {
        throw new Error(
          `${arena.mapId}: guard ${g.actor_id} has ${g.latch_reset_by.length} resets`,
        );
      }
      return {
        id: g.actor_id,
        hurtsSlot: g.watch_slot,
        x: g.x,
        z: g.z,
        widthRaw: g.box.raw.width,
        lengthRaw: g.box.raw.length,
        heightRaw: g.box.raw.height,
        damage: g.damage,
        resetUnits: g.latch_reset_by[0].period_units,
      };
    }),
    pickups: re.pickups.map((p) => ({
      template: p.template,
      x: p.x,
      z: p.z,
      kind: p.kind,
      ammoSlots: p.ammo_slots,
      powerUpSlots: p.power_up_slots,
      cloakTicks: p.effect.cloak_ticks,
      invulnerabilityTicks: p.effect.invulnerability_ticks,
      respawnUnits: Math.abs(p.tsac.period_units),
      halfRaw: [p.box_raw.half_0, p.box_raw.half_1, p.box_raw.half_2],
      heightOffsetRaw: p.height_offset_raw,
      cobj: p.cobj,
      atStart: p.requested_by.some((r) => startFns.has(r.by)),
    })),
    lifts: re.elevators.map((e) => ({
      id: e.actor_id,
      x: e.x,
      z: e.z,
      groundM: e.ground_m,
      startsAt: e.starts_at,
      firstMoveToward: e.first_move_toward,
      stopsRaw: e.stops.map((s) => s.raw),
      dwellRaw: e.stops.map((s) => s.dwell_raw),
      dwellTicks: e.stops.map((s) => s.dwell_ticks),
      speedRaw: e.speed_raw,
      speedWuPerTick: e.speed_wu_per_tick,
      yawRaw: e.yaw_raw,
      mode: e.mode,
      tag: e.tag,
      hurtsSlot: e.tag_hurts_slot,
      travelSound: e.travel_sound,
      arrivalSound: e.arrival_sound,
      cobj: e.cobj,
      footprint: {
        x0: e.footprint.offset_m.x0,
        x1: e.footprint.offset_m.x1,
        z0: e.footprint.offset_m.z0,
        z1: e.footprint.offset_m.z1,
        reachM: e.footprint.reach_m,
        topM: e.footprint.top_above_position_m,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LINE_WIDTH = 100;

/**
 * JSON with two-space indent, an array of plain values on one line when it fits:
 * the shape the repo formatter prints, so the artifact passes `bun run lint` as
 * written.
 */
export function formatJson(v: unknown, indent = ""): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((e) => e === null || typeof e !== "object")) {
      const flat = `[${v.map((e) => JSON.stringify(e)).join(", ")}]`;
      // The key and the trailing comma share the line; leave them room.
      if (indent.length + flat.length + 30 <= LINE_WIDTH) return flat;
    }
    return `[\n${v.map((e) => inner + formatJson(e, inner)).join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  const rec = v as Record<string, unknown>;
  const body = keys.map((k) => `${inner}${JSON.stringify(k)}: ${formatJson(rec[k], inner)}`);
  return `{\n${body.join(",\n")}\n${indent}}`;
}

function main(): void {
  const reRepo = requireReRepo();
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  const named = positional || argOf("map", argOf("mission", "all"));

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", reRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    console.warn(`[gen:parules] could not read the RE repo commit at ${reRepo}`);
  }

  for (const arena of selectArenas(named)) {
    const src = join(reRepo, "extracted", "logic", arena.mission, "pa_rules.json");
    const re = JSON.parse(readFileSync(src, "utf8")) as ReRules;
    const rules = buildRules(arena, re, {
      repo: "amigo-labs/fcop-reverse-engineering",
      commit,
      tool: "tools/logic/pa_rules_data.py",
    });
    const out = join(REPO_ROOT, "tools", "generators", "fcop", rulesFile(arena));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${formatJson(rules)}\n`);
    console.log(
      `wrote ${out}: heavy zones ${rules.heavyZones.length}, queues ${rules.queues.length}, ` +
        `spawners ${rules.spawners.length}, shop ${rules.buyTriggers.length}, ` +
        `guards ${rules.spawnGuards.length}, pickups ${rules.pickups.length}, ` +
        `lifts ${rules.lifts.length}`,
    );
  }
}

if (import.meta.main) main();
