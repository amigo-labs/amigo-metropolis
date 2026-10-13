// The original's sounds, as the client's lookup (#27, assets.md §5).
//
//   docs/specs/fcop-re/pa-audio.json   (the RE repo's pa_sound_tables.json:
//                                       the retail loader run over GlblData and
//                                       each Precinct Assault mission)
//   packages/client/public/sfx|music   (the original's files, imported unchanged
//                                       by importFcopAudio.ts)
//   -> packages/client/src/audio/fcopAudio.generated.ts
//
// Every slot, every script-table cell, every weapon, ambient, effect and death
// byte the client plays from, per arena. Nothing here decides anything: it
// re-shapes the RE's tables into arrays and checks that every file they name is
// committed. A missing file fails the run, so a bank can never point at nothing.
//
// Usage: bun run gen:sfx   (from the repo root)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { FCOP_ARENAS } from "./fcopArenas";

const ROOT = join(import.meta.dir, "..", "..");
const PUBLIC = join(ROOT, "packages", "client", "public");
const SPEC = join(ROOT, "docs", "specs", "fcop-re", "pa-audio.json");
const VOICE_SPEC = join(ROOT, "docs", "specs", "fcop-re", "pa-voice.json");
const WEAPONS_SPEC = join(ROOT, "docs", "specs", "fcop-re", "player-weapons.json");
/**
 * enrichArena.ts LOGIC_OFFSET_X / _Z: the actor frame to the sim's grid. The
 * RE gives an emitter's position in the extract_logic frame (its logic_x is the
 * raw z / 8192, its logic_z the raw x / 8192).
 */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;
const OUT_TS = join(ROOT, "packages", "client", "src", "audio", "fcopAudio.generated.ts");

/** Sim ticks are 33 ms: the original's 300 Hz units / 10. */
const UNITS_PER_TICK = 10;
const VOICE_LINES = 86;

interface RawSample {
  file: string;
  frames: number;
  window_start: number;
  window_frames: number;
  extra: { gate: { weapon: string } | null };
}
interface RawSlot {
  index: number;
  priority: number;
  limit: number;
  loop: boolean;
  lead_in_slot: number | null;
  samples: RawSample[];
}
interface RawBlock {
  sound: number;
  impact_fx: number;
  launch_fx: number;
  extra: { kind: number };
}
interface RawEffect {
  sound: number;
  successor: number;
  at_player: boolean;
  extra: {
    delay_ticks: number;
    successor_at_repeat_end: boolean;
    repeats: number;
    repeat_period_ticks: number;
  };
}
interface RawDeath {
  bank: number;
  class: number;
  extra: { class_row: { fallback: number; flags: number; groups: number[][] } | null };
}
interface RawVoice {
  trigger: string;
  where: string;
  op: "queue" | "interrupt";
  lines: number[];
  probability: number;
  poll_period_s: number | null;
  repeat: number | null;
  cooldown_timer: number | null;
  one_viewport_only: boolean;
  outpost?: number | null;
  slot?: number | null;
}
interface RawMap {
  slots: RawSlot[];
  table_a: Record<string, number>;
  table_b: Record<string, number>;
  table_h: Record<string, number>;
  world_weapons: Record<
    string,
    { sound: number; effect: number; extra: { impact_effect: number } }
  >;
  player_weapons: Record<string, { A: RawBlock; B: RawBlock }>;
  actors: { role?: string; ambient: number; class: number }[];
  effects: Record<string, Record<string, RawEffect>>;
  deaths: Record<string, RawDeath[]>;
  emitters: { sound: number; flag: number; extra: { logic_x: number; logic_z: number } }[];
}
interface RawTables {
  maps: Record<string, RawMap>;
}

const tables = (await Bun.file(SPEC).json()) as RawTables;
const voices = (await Bun.file(VOICE_SPEC).json()) as { maps: Record<string, RawVoice[]> };
const weaponSpec = (await Bun.file(WEAPONS_SPEC).json()) as {
  weapons: Record<string, { A_normal: { raw: { msg_kind_1f: number } } }>;
};

/** Effect delays and poll periods: the original's 300 Hz units / 10 a sim tick. */
function ticks(units: number): number {
  return Math.round(units / UNITS_PER_TICK);
}

/**
 * A successor's delay as `cact_effect_install` / the instance timers run it:
 * the +0x24 countdown, or, with +0x32 bit 11, the repeat count times the
 * period. A bit-11 record with no count or no period never fires its
 * successor (-1).
 */
function successorDelay(r: RawEffect): number {
  if (r.extra.successor_at_repeat_end) {
    const n = r.extra.repeats;
    const period = r.extra.repeat_period_ticks;
    return n > 0 && period > 0 ? ticks(n * period) : -1;
  }
  return ticks(r.extra.delay_ticks ?? 0);
}

/**
 * The hit-message kind a weapon's damage carries, which builds the death mask
 * (pa_sound_tables.json _rules.extra.death_mask): the direct path sends the
 * block's +0x1f, the Flamethrower's sustained sweep 2 (0x0044b4ff), the
 * Shockwave's strike 8 (0x0044c4eb); rounds, missiles and blasts send none.
 */
function hitKind(code: number, direct: boolean): number {
  if (code === 0x02) return 2;
  if (code === 0x23) return 8;
  if (!direct && code !== 0x12) return 0;
  const w = weaponSpec.weapons[`0x${code.toString(16).padStart(2, "0")}`];
  return w?.A_normal.raw.msg_kind_1f ?? 0;
}

// One list of files for all arenas: a sample shared by two banks is one fetch.
const files: string[] = [];
const fileIndex = new Map<string, number>();
function fileOf(name: string): number {
  let i = fileIndex.get(name);
  if (i === undefined) {
    if (!existsSync(join(PUBLIC, "sfx", name))) {
      throw new Error(`public/sfx/${name} is missing — run importFcopAudio.ts`);
    }
    i = files.length;
    files.push(name);
    fileIndex.set(name, i);
  }
  return i;
}

function table(cells: Record<string, number>, from: number, length: number): number[] {
  const out = new Array<number>(length).fill(-1);
  for (const [id, slot] of Object.entries(cells)) {
    const k = Number(id) - from;
    if (k >= 0 && k < length) out[k] = slot;
  }
  return out;
}

const ts = (v: unknown): string => JSON.stringify(v);

const arenas: string[] = [];
let weapons = "";
for (const arena of FCOP_ARENAS) {
  const m = tables.maps[arena.mission];
  if (!m) throw new Error(`pa-audio.json has no ${arena.mission}`);
  const slots = [...m.slots]
    .sort((a, b) => a.index - b.index)
    .map(
      (s) =>
        `{ priority: ${s.priority}, limit: ${s.limit}, loop: ${s.loop}, leadIn: ${s.lead_in_slot ?? -1}, samples: [${s.samples
          .map(
            (x) =>
              `{ file: ${fileOf(x.file)}, start: ${x.window_start}, frames: ${x.window_frames}, gate: ${x.extra.gate ? Number(x.extra.gate.weapon) : -1} }`,
          )
          .join(", ")}] }`,
    );
  const world: string[] = ["{ sound: 0, impactFx: 0, launchFx: 0 }"];
  for (let row = 1; row <= 9; row++) {
    const w = m.world_weapons[String(row)];
    world.push(
      w
        ? `{ sound: ${w.sound}, impactFx: ${w.extra.impact_effect}, launchFx: ${w.effect} }`
        : "{ sound: 0, impactFx: 0, launchFx: 0 }",
    );
  }
  const ambient = (role: string): number => m.actors.find((a) => a.role === role)?.ambient ?? 0;
  const effects = [0, 1].map((bank) => {
    const recs = m.effects[String(bank)] ?? {};
    const rows = Object.entries(recs)
      .filter(([, r]) => r.sound !== 0 || r.successor !== 0)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([id, r]) => {
        const delay = successorDelay(r);
        const next = delay < 0 ? 0 : r.successor;
        return `${id}: { sound: ${r.sound}, next: ${next}, delay: ${Math.max(0, delay)}, atPlayer: ${r.at_player} }`;
      });
    return `{ ${rows.join(", ")} }`;
  });
  // Each role's class rows, in class order (the Dreadnought's 202 is slot 0's
  // and 203 slot 1's; the captain's 220..223 go by its level).
  const death = (k: string): string =>
    ts(
      [...(m.deaths[k] ?? [])]
        .sort((a, b) => a.class - b.class)
        .map((d) => {
          // A class with no row in the table raises nothing (0x0042b947).
          const row = d.extra.class_row ?? { fallback: 0, flags: 1, groups: [] };
          return {
            bank: d.bank,
            fallback: row.fallback,
            alternate: (row.flags & 1) === 0,
            groups: row.groups.map((g) => g[0] ?? 0),
          };
        }),
    );
  const vs = voices.maps[arena.mission];
  if (!vs) throw new Error(`pa-voice.json has no ${arena.mission}`);
  const chatter = vs.find((v) => v.trigger === "captain_idle_chatter")?.cooldown_timer;
  const voice = vs.map((v) => ({
    trigger: v.trigger,
    script: v.where.startsWith("mission") ? 0 : 1,
    op: v.op === "interrupt" ? 1 : 0,
    lines: v.lines,
    p: v.probability,
    poll: v.poll_period_s ? Math.round(v.poll_period_s * 30) : 0,
    chatter: chatter !== undefined && v.cooldown_timer === chatter,
    once: v.repeat === 1,
    outpost: v.outpost ?? -1,
    slot: v.slot ?? -1,
    oneViewport: v.one_viewport_only,
  }));
  arenas.push(`  ${ts(arena.mapId)}: {
    mission: ${ts(arena.mission)},
    bank: {
      slots: [
        ${slots.join(",\n        ")},
      ],
      a: ${ts(table(m.table_a, 0, 70))},
      b: ${ts(table(m.table_b, 0, 70))},
      h: ${ts(table(m.table_h, 70, 60))},
    },
    world: [${world.join(", ")}],
    ambient: { tank: ${ambient("tank")}, jet: ${ambient("jet")}, fortress: ${ambient("fortress")}, dreadnought: ${ambient("dreadnought")}, captain: ${ambient("sky_captain")} },
    effects: [${effects.join(", ")}],
    deaths: { turret: ${death("turret")}, neutralTurret: ${death("neutral_turret")}, tank: ${death("tank")}, jet: ${death("jet")}, fortress: ${death("fortress")}, dreadnought: ${death("dreadnought")}, captain: ${death("sky_captain")}, mech: ${death("mech")} },
    emitters: ${ts(
      m.emitters
        .filter((e) => (e.flag & 0x40) !== 0)
        .map((e) => ({
          x: Math.round((e.extra.logic_x + LOGIC_OFFSET_X) * 1000) / 1000,
          z: Math.round((e.extra.logic_z + LOGIC_OFFSET_Z) * 1000) / 1000,
          sound: e.sound,
        })),
    )},
    voice: ${ts(voice)},
    music: ${ts(`/music/${arena.mission}.wav`)},
  },`);
  if (!existsSync(join(PUBLIC, "music", `${arena.mission}.wav`))) {
    throw new Error(`public/music/${arena.mission}.wav is missing — run importFcopAudio.ts`);
  }
  if (!weapons) {
    // The type-99 table is identical in every mission container
    // (player-weapons.json's source note); take the first arena's.
    weapons = Object.entries(m.player_weapons)
      .map(([code, w]) => {
        const direct = (b: RawBlock) =>
          (b.extra.kind >= 0x0a && b.extra.kind <= 0x0c) || b.extra.kind === 0x0e;
        const blk = (b: RawBlock) =>
          `{ kind: ${b.extra.kind}, sound: ${b.sound}, impactFx: ${b.impact_fx}, launchFx: ${b.launch_fx}, hitKind: ${hitKind(Number(code), direct(b))} }`;
        return `  ${Number(code)}: { a: ${blk(w.A)}, b: ${blk(w.B)} },`;
      })
      .join("\n");
  }
}

for (let id = 0; id < VOICE_LINES; id++) {
  const name = `v${String(id + 1).padStart(3, "0")}.wav`;
  if (!existsSync(join(PUBLIC, "sfx", "voice", name))) {
    throw new Error(`public/sfx/voice/${name} is missing — run importFcopAudio.ts`);
  }
}

const generated = `// GENERATED by tools/generators/genSfx.ts from docs/specs/fcop-re/pa-audio.json
// — do not edit by hand. Re-run \`bun run gen:sfx\`.
//
// The original's sound banks, one per arena, as its loader leaves them (the RE
// repo's tools/audio/pa_sound_tables.py), and the bytes that say which script
// each source plays. The files are the original's own, unchanged
// (tools/generators/importFcopAudio.ts).

import type { ArenaAudio, PlayerWeaponSounds } from "./arenaAudio";

/** Every sample file a bank registers, under /sfx/. */
export const FCOP_SAMPLE_FILES: readonly string[] = ${ts(files.map((f) => `/sfx/${f}`))};

/** Speech line N, under /sfx/voice/ (identical in all six arenas). */
export const FCOP_VOICE_FILES: readonly string[] = ${ts(
  Array.from(
    { length: VOICE_LINES },
    (_, i) => `/sfx/voice/v${String(i + 1).padStart(3, "0")}.wav`,
  ),
)};

/** The player's fifteen weapons by code: each block's kind, sound and effects. */
export const FCOP_PLAYER_WEAPONS: Readonly<Record<number, PlayerWeaponSounds>> = {
${weapons}
};

/** Each FCOP arena's sounds, by Metropolis map id. */
export const FCOP_ARENA_AUDIO: Readonly<Record<string, ArenaAudio>> = {
${arenas.join("\n")}
};
`;
await Bun.write(OUT_TS, generated);
// Committed as the formatter writes it, so a re-run is a no-op diff.
const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", OUT_TS], { cwd: ROOT });
if (fmt.exitCode !== 0) throw new Error(`biome format failed: ${fmt.stderr.toString()}`);
console.log(
  `gen:sfx: ${FCOP_ARENAS.length} arenas, ${files.length} sample files, ${VOICE_LINES} voice lines -> ${OUT_TS}`,
);
