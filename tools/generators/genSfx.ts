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
const OUT_TS = join(ROOT, "packages", "client", "src", "audio", "fcopAudio.generated.ts");

/** Sim ticks are 33 ms: the original's 300 Hz units / 10. */
const UNITS_PER_TICK = 10;
const VOICE_LINES = 86;

interface RawSample {
  file: string;
  frames: number;
  window_start: number;
  window_frames: number;
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
  extra: { delay_ticks: number };
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
  deaths?: Record<string, { bank: number; start_ids: number[] }>;
  emitters: { x: number; z: number; sound: number }[];
}
interface RawTables {
  maps: Record<string, RawMap>;
}

const tables = (await Bun.file(SPEC).json()) as RawTables;

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
              `{ file: ${fileOf(x.file)}, start: ${x.window_start}, frames: ${x.window_frames} }`,
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
      .map(
        ([id, r]) =>
          `${id}: { sound: ${r.sound}, next: ${r.successor}, delay: ${Math.round((r.extra.delay_ticks ?? 0) / UNITS_PER_TICK)} }`,
      );
    return `{ ${rows.join(", ")} }`;
  });
  const deaths = m.deaths ?? {};
  const death = (k: string): string => ts(deaths[k]?.start_ids ?? []);
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
    deaths: { turret: ${death("turret")}, neutralTurret: ${death("neutral_turret")}, tank: ${death("tank")}, jet: ${death("jet")}, fortress: ${death("fortress")}, dreadnought: ${death("dreadnought")}, mech: ${death("mech")} },
    emitters: ${ts(m.emitters.map((e) => ({ x: e.x, z: e.z, sound: e.sound })))},
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
        const blk = (b: RawBlock) =>
          `{ kind: ${b.extra.kind}, sound: ${b.sound}, impactFx: ${b.impact_fx}, launchFx: ${b.launch_fx} }`;
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
console.log(
  `gen:sfx: ${FCOP_ARENAS.length} arenas, ${files.length} sample files, ${VOICE_LINES} voice lines -> ${OUT_TS}`,
);
