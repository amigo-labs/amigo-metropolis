// Transcode the original's 27 movies for the browser.
//
//   <originals>/<name>.mpg      FCOP_MOVIES_DIR (or --movies): the install's
//                               Movies\ directory -- in no repository, by the
//                               owner's decision; only these re-encodes are
//   <RE>/fixtures/movies/manifest.json   FCOP_RE_REPO (or --re): each
//                               original's size and sha256, where the EXE
//                               plays it (RE docs/formats/movies.md)
//     -> packages/client/public/movies/<name>.mp4
//     -> packages/client/src/menu/frontend/movies.generated.ts
//
// **Needs ffmpeg** (with libsvtav1) and ffprobe on PATH. The originals are
// MPEG-1 system streams, which no browser plays. All 27 are encoded, though
// a Precinct Assault session plays nine (`ea_logo`, `intro`, `multibrf`, the
// six PA `po_*`): the rest (`credits`, `cwrules`, `brief1`-`8`, the campaign's
// `po_*`) would otherwise exist nowhere once the originals are gone.
//
// The format, the owner's (2026-10-26): AV1 + AAC-LC in MP4, one file per
// movie, no second codec. AV1 is the smallest; AAC-in-MP4 the pairing every
// AV1-capable browser plays. Safari decodes AV1 only on hardware with an AV1
// decoder (A17 Pro / M3 and later): elsewhere the player's canPlayType test or
// the element's error falls back to no movie, as before the import. The
// original's picture size and 30 fps are kept; the video is SVT-AV1
// constant-quality CRF 40 at preset 6 (1998 MPEG-1 at 1.15 Mbit/s, soft
// already: CRF 46 smears the PA fly-overs' gratings, 40 keeps them), the audio
// AAC-LC 64 kbit/s stereo at the source's 44.1 kHz (the sources are true
// stereo). One encoder thread (`lp=1`), bitexact flags and `+faststart` (the
// index first, so a fetch can start playing) make a re-run byte-identical on
// the same ffmpeg build; the build's version is recorded, and
// `--check --reencode` compares bytes only when it matches.
//
// Usage: FCOP_MOVIES_DIR=<originals> FCOP_RE_REPO=<RE checkout> bun run gen:movies
//        [--check [--reencode]] [--jobs N]
//   --check     the committed files and the module against the record: every
//               listed file present with its size and sha256, nothing else in
//               public/movies/, the module what the record gives, the encode's
//               arguments unchanged; with the RE checkout the record's
//               sources against the RE's manifest; with the originals each
//               source's bytes too. A source that is absent is skipped, said
//               once.
//   --reencode  (with --check and the originals) transcode again into a temp
//               dir and compare the bytes (only on the recorded ffmpeg version).

import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OUT_DIR = join(ROOT, "packages", "client", "public", "movies");
const OUT_TS = join(ROOT, "packages", "client", "src", "menu", "frontend", "movies.generated.ts");

/** The encode, between `-i <src>` and the output path. */
const ENCODE = [
  ["-map", "0:v:0", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1"],
  ["-c:v", "libsvtav1", "-preset", "6", "-crf", "40", "-g", "300"],
  ["-svtav1-params", "lp=1:pin=0", "-pix_fmt", "yuv420p"],
  ["-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "2"],
  ["-movflags", "+faststart", "-fflags", "+bitexact", "-flags:v", "+bitexact"],
  ["-flags:a", "+bitexact", "-f", "mp4"],
].flat();

interface SourceMovie {
  name: string;
  bytes: number;
  sha256: string;
  mpeg: { width: number; height: number; fps: number };
  probe?: { duration_s: number };
}

export interface MovieRecord {
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds: number;
  readonly bytes: number;
  readonly sha256: string;
  /** The MIME type with its codecs, for canPlayType. */
  readonly type: string;
  readonly source: { readonly name: string; readonly bytes: number; readonly sha256: string };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function ffmpegVersion(): string {
  const r = Bun.spawnSync(["ffmpeg", "-hide_banner", "-version"]);
  if (r.exitCode !== 0) throw new Error("gen:movies needs ffmpeg on PATH");
  return (
    r.stdout
      .toString()
      .split("\n")[0]
      .match(/ffmpeg version (\S+)/)?.[1] ?? "unknown"
  );
}

async function encode(src: string, out: string): Promise<void> {
  const p = Bun.spawn(
    ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1"].concat(
      ["-i", src],
      ENCODE,
      [out],
    ),
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await p.exited;
  if (code !== 0)
    throw new Error(`ffmpeg failed on ${src}: ${await new Response(p.stderr).text()}`);
}

/** Runs `jobs` at a time. */
async function pool<T>(items: T[], jobs: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, run));
}

/** `video/mp4; codecs="av01.P.LLT.DD, mp4a.40.2"` from the encoded file. */
function mimeOf(path: string): string {
  const r = Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,profile,level",
    "-of",
    "json",
    path,
  ]);
  if (r.exitCode !== 0) throw new Error(`gen:movies needs ffprobe on PATH (${path})`);
  const streams = (
    JSON.parse(r.stdout.toString()) as {
      streams: { codec_name: string; profile?: string; level?: number }[];
    }
  ).streams;
  const v = streams.find((x) => x.codec_name === "av1");
  const a = streams.find((x) => x.codec_name === "aac");
  if (!v || !a || v.profile !== "Main" || a.profile !== "LC" || v.level === undefined) {
    throw new Error(`${path}: not AV1 Main + AAC-LC`);
  }
  // AV1 Main profile 0, seq_level_idx, Main tier, 8 bit (yuv420p).
  return `video/mp4; codecs="av01.0.${String(v.level).padStart(2, "0")}M.08, mp4a.40.2"`;
}

function moduleText(records: MovieRecord[], ffmpeg: string): string {
  const byName: Record<string, MovieRecord> = {};
  for (const r of records) byName[r.source.name] = r;
  const total = records.reduce((s, r) => s + r.bytes, 0);
  const sourceTotal = records.reduce((s, r) => s + r.source.bytes, 0);
  const header = [
    "// GENERATED by tools/generators/importFcopMovies.ts from the original's",
    "// movies (in no repository) and the RE repo's fixtures/movies/manifest.json",
    "// -- do not edit by hand. Re-run `bun run gen:movies`.",
    "//",
    "// All 27, by their original names, as AV1 + AAC in MP4 under /movies/ at the",
    `// original's picture size and 30 fps: ${total} bytes (the MPEG-1 originals:`,
    `// ${sourceTotal}). Where and how each plays: RE docs/formats/movies.md and`,
    "// menu/frontend/movie.ts.",
    "",
    'import type { FeMovie } from "./types";',
    "",
  ].join("\n");
  const body = [
    'export const FE_MOVIE_BASE = "/movies/";',
    `export const FE_MOVIES: Readonly<Record<string, FeMovie>> = ${JSON.stringify(byName)};`,
    `export const FE_MOVIE_ENCODE = ${JSON.stringify({ ffmpeg, args: ENCODE.join(" ") })} as const;`,
  ].join("\n\n");
  const fmt = Bun.spawnSync(
    [join(ROOT, "node_modules", ".bin", "biome"), "format", `--stdin-file-path=${OUT_TS}`],
    { stdin: new TextEncoder().encode(`${header}\n${body}\n`), cwd: ROOT },
  );
  if (fmt.exitCode !== 0) throw new Error(new TextDecoder().decode(fmt.stderr));
  return new TextDecoder().decode(fmt.stdout);
}

/** The record the committed module carries (FE_MOVIES, FE_MOVIE_ENCODE). */
async function committedRecord(): Promise<{
  records: MovieRecord[];
  ffmpeg: string;
  args: string;
} | null> {
  if (!existsSync(OUT_TS)) return null;
  const mod = (await import(OUT_TS)) as {
    FE_MOVIES: Record<string, MovieRecord>;
    FE_MOVIE_ENCODE: { ffmpeg: string; args: string };
  };
  return {
    records: Object.values(mod.FE_MOVIES),
    ffmpeg: mod.FE_MOVIE_ENCODE.ffmpeg,
    args: mod.FE_MOVIE_ENCODE.args,
  };
}

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const reencode = process.argv.includes("--reencode");
  const jobs = Math.max(1, Number(argValue("--jobs") ?? 2) | 0);
  const reArg = argValue("--re") ?? process.env.FCOP_RE_REPO;
  const moviesArg = argValue("--movies") ?? process.env.FCOP_MOVIES_DIR;
  const srcDir = moviesArg ? resolve(moviesArg) : null;
  const haveSources = srcDir !== null && existsSync(srcDir);

  /** The RE's record of the originals, by name. */
  let manifest: Map<string, SourceMovie> | null = null;
  if (reArg) {
    const path = join(resolve(reArg), "fixtures", "movies", "manifest.json");
    const m = (await Bun.file(path).json()) as { movies: SourceMovie[] };
    manifest = new Map(m.movies.map((x) => [x.name, x]));
  }

  /** An original, held to the RE's manifest. */
  const readSource = async (meta: SourceMovie): Promise<Uint8Array> => {
    const bytes = new Uint8Array(await Bun.file(join(srcDir as string, meta.name)).arrayBuffer());
    if (bytes.length !== meta.bytes || sha256(bytes) !== meta.sha256) {
      throw new Error(`${meta.name} in ${srcDir} is not the original the RE's manifest names`);
    }
    return bytes;
  };

  if (check) {
    let stale = 0;
    const rec = await committedRecord();
    if (!rec) {
      console.error(`stale: ${OUT_TS} is missing`);
      return 1;
    }
    if (rec.args !== ENCODE.join(" ")) {
      console.error("stale: the encode's arguments changed since the module was written");
      stale++;
    }
    if (manifest) {
      const names = rec.records.map((r) => r.source.name).sort();
      const want = [...manifest.keys()].sort();
      if (JSON.stringify(names) !== JSON.stringify(want)) {
        console.error(
          `stale: the module has ${names.length} movies, the RE's manifest ${want.length}`,
        );
        stale++;
      }
    } else {
      console.log("--check: no FCOP_RE_REPO, the sources' record is not compared");
    }
    if (!haveSources) console.log("--check: no FCOP_MOVIES_DIR, the originals are not read");
    for (const r of rec.records) {
      const path = join(OUT_DIR, r.file);
      const f = Bun.file(path);
      if (!(await f.exists())) {
        console.error(`missing: ${path}`);
        stale++;
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length !== r.bytes || sha256(bytes) !== r.sha256) {
        console.error(`stale: ${path} is not the recorded encode`);
        stale++;
      }
      const meta = manifest?.get(r.source.name);
      if (manifest && (!meta || meta.sha256 !== r.source.sha256 || meta.bytes !== r.source.bytes)) {
        console.error(`stale: ${r.source.name} is not the original the RE's manifest names`);
        stale++;
      }
      if (meta && haveSources) await readSource(meta);
    }
    const listed = new Set(rec.records.map((r) => r.file));
    for (const f of readdirSync(OUT_DIR)) {
      if (!listed.has(f)) {
        console.error(`not from gen:movies: ${join(OUT_DIR, f)}`);
        stale++;
      }
    }
    if ((await Bun.file(OUT_TS).text()) !== moduleText(rec.records, rec.ffmpeg)) {
      console.error(`stale: ${OUT_TS} is not what its record gives`);
      stale++;
    }
    if (reencode) {
      const version = ffmpegVersion();
      if (!haveSources || !manifest) {
        console.log("--reencode skipped: it needs FCOP_MOVIES_DIR and FCOP_RE_REPO");
      } else if (version !== rec.ffmpeg) {
        console.log(`--reencode skipped: ffmpeg ${version}, the record's ${rec.ffmpeg}`);
      } else {
        const tmp = mkdtempSync(join(tmpdir(), "gen-movies-"));
        try {
          await pool(rec.records, jobs, async (r) => {
            const out = join(tmp, r.file);
            await encode(join(srcDir as string, r.source.name), out);
            const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
            if (sha256(bytes) !== r.sha256) {
              console.error(`stale: ${r.file} re-encodes to other bytes`);
              stale++;
            }
          });
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    }
    if (stale) return 1;
    console.log(`--check: ${rec.records.length} movies match the record`);
    return 0;
  }

  if (!manifest || !haveSources) {
    console.error(
      "usage: FCOP_MOVIES_DIR=<originals> FCOP_RE_REPO=<RE checkout> bun run gen:movies [--check [--reencode]]",
    );
    return 2;
  }
  const ffmpeg = ffmpegVersion();
  await mkdir(OUT_DIR, { recursive: true });
  const records: MovieRecord[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "gen-movies-"));
  try {
    await pool([...manifest.values()], jobs, async (meta) => {
      const src = await readSource(meta);
      const file = meta.name.replace(/\.mpg$/, ".mp4");
      const out = join(tmp, file);
      const t0 = performance.now();
      await encode(join(srcDir as string, meta.name), out);
      const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
      const type = mimeOf(out);
      renameSync(out, join(OUT_DIR, file));
      records.push({
        file,
        width: meta.mpeg.width,
        height: meta.mpeg.height,
        fps: meta.mpeg.fps,
        seconds: meta.probe?.duration_s ?? 0,
        bytes: bytes.length,
        sha256: sha256(bytes),
        type,
        source: { name: meta.name, bytes: src.length, sha256: meta.sha256 },
      });
      const s = ((performance.now() - t0) / 1000).toFixed(0);
      console.log(`${meta.name} ${src.length} -> ${file} ${bytes.length} (${s} s)`);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  records.sort((a, b) => (a.source.name < b.source.name ? -1 : 1));
  // Drop what an earlier run left.
  const keep = new Set(records.map((r) => r.file));
  for (const f of readdirSync(OUT_DIR)) if (!keep.has(f)) rmSync(join(OUT_DIR, f));
  await Bun.write(OUT_TS, moduleText(records, ffmpeg));
  const total = records.reduce((s, r) => s + r.bytes, 0);
  const sourceTotal = records.reduce((s, r) => s + r.source.bytes, 0);
  console.log(
    `wrote ${records.length} movies, ${total} bytes (originals ${sourceTotal}), ${OUT_TS}`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
