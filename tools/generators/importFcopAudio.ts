// Import the original's sounds from a checkout of the RE repo
// (amigo-labs/fcop-reverse-engineering), unchanged.
//
//   extracted/audio/pa_sound_tables.json  -> docs/specs/fcop-re/pa-audio.json
//   extracted/audio/pa_voice_triggers.json -> docs/specs/fcop-re/pa-voice.json
//   extracted/sfx_v2/sNNN.wav (every sample a PA bank registers)
//                                          -> packages/client/public/sfx/sNNN.wav
//   extracted/voice/wav/v001..v086.wav     -> packages/client/public/sfx/voice/
//   extracted/music/<Mission>.wav (the six PA missions)
//                                          -> packages/client/public/music/
//
// Byte for byte: the files are the original's Cwav / speech / music images as
// the RE extractors wrote them. Nothing is trimmed, normalised, resampled or
// re-encoded — the original has no per-sound level, so a file's own level IS the
// level it plays at (fcop-fidelity.md, audio rows). The public copies are the
// committed source; `bun run gen:sfx` then builds the client's lookup from
// pa-audio.json and checks every file against it.
//
// Usage: bun run tools/generators/importFcopAudio.ts --re ../fcop-reverse-engineering

import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PUBLIC = join(ROOT, "packages", "client", "public");
const OUT_SFX = join(PUBLIC, "sfx");
const OUT_VOICE = join(OUT_SFX, "voice");
const OUT_MUSIC = join(PUBLIC, "music");
const SPECS = join(ROOT, "docs", "specs", "fcop-re");

/** The six Precinct Assault missions (tools/generators/fcopArenas.ts). */
const MISSIONS = ["Conft", "Slim", "Mp", "Joke", "Hk", "Ovmp"] as const;
/** Speech ids 0..85: line N is v{N+1:03d}.wav, identical in all six arenas. */
const VOICE_LINES = 86;

interface Tables {
  maps: Record<string, { slots: { samples: { file: string }[] }[] }>;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const re = argValue("--re");
if (!re) {
  console.error("usage: bun run tools/generators/importFcopAudio.ts --re <RE checkout>");
  process.exit(2);
}
const RE = resolve(re);

const tablesPath = join(RE, "extracted", "audio", "pa_sound_tables.json");
const tables = (await Bun.file(tablesPath).json()) as Tables;
await mkdir(SPECS, { recursive: true });
const specs = [join(SPECS, "pa-audio.json")];
await copyFile(tablesPath, specs[0]);
const voicePath = join(RE, "extracted", "audio", "pa_voice_triggers.json");
if (await Bun.file(voicePath).exists()) {
  specs.push(join(SPECS, "pa-voice.json"));
  await copyFile(voicePath, specs[1]);
}
// Both stay byte-identical to the RE's output (biome.json leaves them out).

// Every sample any PA bank registers.
const samples = new Set<string>();
for (const mission of MISSIONS) {
  const m = tables.maps[mission];
  if (!m) throw new Error(`pa_sound_tables.json has no ${mission}`);
  for (const slot of m.slots) for (const s of slot.samples) samples.add(s.file);
}

// Clear what an earlier import left so a sample a bank stopped naming goes too.
await mkdir(OUT_SFX, { recursive: true });
for (const f of await readdir(OUT_SFX)) {
  if (/^s\d{3}\.wav$/.test(f) || /^vo_.*\.wav$/.test(f)) await rm(join(OUT_SFX, f));
}
let bytes = 0;
for (const file of [...samples].sort()) {
  const from = join(RE, "extracted", "sfx_v2", file);
  await copyFile(from, join(OUT_SFX, file));
  bytes += Bun.file(from).size;
}

await mkdir(OUT_VOICE, { recursive: true });
for (let id = 0; id < VOICE_LINES; id++) {
  const name = `v${String(id + 1).padStart(3, "0")}.wav`;
  const from = join(RE, "extracted", "voice", "wav", name);
  await copyFile(from, join(OUT_VOICE, name));
  bytes += Bun.file(from).size;
}

await mkdir(OUT_MUSIC, { recursive: true });
for (const f of await readdir(OUT_MUSIC)) {
  if (/\.(mp3|wav)$/.test(f)) await rm(join(OUT_MUSIC, f));
}
for (const mission of MISSIONS) {
  const from = join(RE, "extracted", "music", `${mission}.wav`);
  await copyFile(from, join(OUT_MUSIC, `${mission}.wav`));
  bytes += Bun.file(from).size;
}

console.log(
  `importFcopAudio: ${samples.size} samples, ${VOICE_LINES} voice lines, ` +
    `${MISSIONS.length} music tracks, ${(bytes / 1048576).toFixed(1)} MB from ${RE}`,
);
console.log("Now run `bun run gen:sfx`.");
