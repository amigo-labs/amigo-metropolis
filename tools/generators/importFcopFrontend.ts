// Import the original's front end from a checkout of the RE repo
// (amigo-labs/fcop-reverse-engineering), unchanged.
//
//   extracted/frontend/screens.json   the bitmap screen: sets, groups, panels,
//                                     menus, the map buttons, the loadout
//   extracted/frontend/dialogs.json   the Win32 dialog templates
//   extracted/frontend/ui_sounds.json the nine UI sound slots
//     -> packages/client/src/menu/frontend/frontendData.generated.ts
//   extracted/frontend/bmpNNN.png     every picture the two screen sets
//                                     Metropolis shows (Precinct Assault one
//                                     player, and networked) and the loading bar
//     -> packages/client/public/ui/frontend/
//   extracted/previews/loading/*.png  the six Precinct Assault loading screens
//     -> packages/client/public/ui/frontend/loading/
//   extracted/frontend_sfx/wave_0x*.wav  the UI sounds the slots name
//     -> packages/client/public/sfx/ui/
//
// Byte for byte: the PNGs are the RE extractor's lossless decode of febmp.bin
// and the Ld*.bmp files, the WAVs the exe's WAVE resources. Nothing is scaled,
// re-encoded or recoloured. The generated TS re-shapes the JSON and decides
// nothing; every block keeps its `src` citation into the decompiled C.
//
// Usage: bun run gen:frontend [--re-repo <RE checkout>] [--check]
//   --check  rebuilds everything in memory and exits 1 when a committed file
//            differs from what the RE's exports would give (nothing is written).

import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { requireReRepo } from "./reRepo";

const ROOT = join(import.meta.dir, "..", "..");
const PUBLIC = join(ROOT, "packages", "client", "public");
const OUT_PICS = join(PUBLIC, "ui", "frontend");
const OUT_LOADING = join(OUT_PICS, "loading");
const OUT_SFX = join(PUBLIC, "sfx", "ui");
const OUT_TS = join(
  ROOT,
  "packages",
  "client",
  "src",
  "menu",
  "frontend",
  "frontendData.generated.ts",
);

/** The screen sets Metropolis shows: solo against the Sky Captain, and online. */
const SETS = ["pa_1p", "net_pa"] as const;
/** The dialogs the front end opens, by dialogs.json key. */
const DIALOGS = [
  "options",
  "controls",
  "audio",
  "save_load",
  "profile",
  "in_game",
  "join",
  "host",
] as const;
/** The Precinct Assault table's containers -> Metropolis' arena ids (fcopArenas.ts). */
const MAP_IDS: Record<string, string> = {
  Slim: "proving-ground",
  ConFt: "urban-jungle",
  hk: "hollywood-keys",
  Ovmp: "venice-beach",
  Mp: "la-cantina",
  Joke: "bug-hunt",
};

const check = process.argv.includes("--check");
const RE = requireReRepo();
const FRONTEND = join(RE, "extracted", "frontend");

interface RawPicture {
  id: number;
  file: string;
  w: number;
  h: number;
  label: string;
}
interface RawPanel {
  ordinal: number;
  kind: number;
  x: number;
  y: number;
  w: number;
  h: number;
  pictures: { plain: RawPicture | null; pressed: RawPicture | null; hover: RawPicture | null };
  flags_initial: number;
  repaint: number;
  callback: { name: string; does: string; src: string };
}
interface RawMenu {
  x: number;
  y: number;
  selected_initial: number;
  flags_initial: number;
  animated: boolean;
  entries: RawPicture[];
}
interface RawGroup {
  key: string;
  role: string;
  origin: [number, number];
  backdrop: RawPicture | null;
  extra: { name: string; does: string; src: string } | null;
  panels?: RawPanel[];
  menus?: RawMenu[];
}
interface RawControl {
  id: number;
  class: string;
  style_names: string[];
  dlu: [number, number, number, number];
  text: string | null;
  runtime_text: string | null;
}
interface RawDialog {
  id: number;
  key: string | null;
  what: string;
  procedure: string | null;
  template: {
    style_names: string[];
    ex_style: string;
    dlu: [number, number, number, number];
    font: { point_size: number; face: string };
    title: string | null;
    controls: RawControl[];
  };
  runtime_texts: { caption: string | null } | null;
  behaviour?: string[];
}

const screens = await Bun.file(join(FRONTEND, "screens.json")).json();
const dialogs = (await Bun.file(join(FRONTEND, "dialogs.json")).json()) as { dialogs: RawDialog[] };
const uiSounds = await Bun.file(join(FRONTEND, "ui_sounds.json")).json();

const pictures = new Set<string>();
function pic(p: RawPicture | null | undefined) {
  if (!p) return null;
  pictures.add(p.file);
  return { id: p.id, file: p.file, w: p.w, h: p.h, label: p.label };
}

const sets: Record<string, Record<string, string>> = {};
for (const s of screens.screen_sets as {
  name: string;
  used_when: string;
  groups: Record<string, string>;
}[]) {
  if ((SETS as readonly string[]).includes(s.name))
    sets[s.name] = { ...s.groups, used_when: s.used_when };
}
const groupKeys = new Set<string>();
for (const name of SETS) {
  const s = sets[name];
  if (!s) throw new Error(`screens.json has no set ${name}`);
  for (const k of ["main", "left", "right", "radio"]) groupKeys.add(s[k]);
}

const groups: Record<string, unknown> = {};
for (const key of [...groupKeys].sort()) {
  const g = screens.groups[key] as RawGroup;
  if (!g) throw new Error(`screens.json has no group ${key}`);
  groups[key] = {
    key,
    role: g.role,
    origin: g.origin,
    backdrop: pic(g.backdrop),
    extra: g.extra ? { name: g.extra.name, src: g.extra.src } : null,
    panels: (g.panels ?? []).map((p) => ({
      ordinal: p.ordinal,
      kind: p.kind,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      plain: pic(p.pictures.plain),
      pressed: pic(p.pictures.pressed),
      hover: pic(p.pictures.hover),
      flags: p.flags_initial,
      repaint: p.repaint !== 0,
      callback: p.callback.name,
      src: p.callback.src,
    })),
    menus: (g.menus ?? []).map((m) => ({
      x: m.x,
      y: m.y,
      selected: m.selected_initial,
      flags: m.flags_initial,
      animated: m.animated,
      entries: m.entries.map((e) => pic(e)),
    })),
  };
}

// The map buttons, with the loading screen each row names and Metropolis' id.
const loadingFiles: string[] = [];
const paMaps = (screens.pa_maps.buttons as Record<string, unknown>[]).map((b) => {
  const container = b.container as string;
  const mapId = MAP_IDS[container];
  if (!mapId) throw new Error(`no Metropolis arena for PA row ${container}`);
  const loading = (b.loading_bitmap as string).replace(/\.bmp$/i, ".png");
  loadingFiles.push(loading);
  return {
    ordinal: b.ordinal,
    container,
    name: b.name,
    mapId,
    titlePlate: pic(b.title_plate as RawPicture),
    loading,
    briefing: b.briefing,
    postMovie: b.post_movie,
  };
});

const lo = screens.loadout;
const loadout = {
  slots: (lo.slots as { slot: number; role: string; entries: Record<string, unknown>[] }[]).map(
    (s) => ({
      slot: s.slot,
      role: s.role,
      entries: s.entries.map((e) => ({
        entry: e.entry,
        code: e.code,
        weapon: e.weapon,
        availableOutsideCampaign: e.available_outside_campaign,
        needsOptionByte: e.needs_option_byte,
      })),
    }),
  ),
  availabilityOutsideCampaign: lo.availability_outside_campaign,
  default: lo.default,
  skipRule: lo.skip_rule,
  timerTicks: lo.animated_strips.timer_ticks,
  src: lo.src,
};

const portraits = screens.portraits;
const portraitData = {
  left: { at: portraits.left.at, pa: pic(portraits.left.pa) },
  right: { at: portraits.right.at, pa: pic(portraits.right.pa) },
  src: portraits.src,
};
const ls = screens.loading_screen;
const loadingScreen = {
  barFrame: { ...pic(ls.bar_frame), at: ls.bar_frame.at },
  barFill: { ...pic(ls.bar_fill), at: ls.bar_fill.at },
  src: ls.src,
};
const ct = screens.connected_to;
const connectedTo = {
  font: ct.font,
  caption: { text: ct.lines[0].text, at: ct.lines[0].at, rgb: ct.lines[0].rgb },
  peer: { at: [ct.lines[0].at[0], ct.lines[0].at[1]], rgb: ct.lines[1].rgb },
  src: ct.src,
};
const nd = screens.new_game_defaults;
const defaults = {
  pick0: nd.pick0_pa_map,
  difficulty: nd.difficulty_both,
  paLevels: nd.pa_levels,
  paLevelPicks: nd.pa_level_picks,
  bugHuntUnlocked: nd.bug_hunt_unlocked,
  src: nd.src,
};
const paRules = {
  bugHuntUnlock: screens.pa_maps.bug_hunt_unlock,
  completedStamp: screens.pa_maps.completed_stamp.shown_when,
  netLock: screens.pa_maps.net_lock,
  briefingButton: screens.pa_maps.briefing_button,
  level: screens.sky_captain_level.limit,
  levelSrc: screens.sky_captain_level.src,
};

const dialogOut: Record<string, unknown> = {};
for (const key of DIALOGS) {
  const d = dialogs.dialogs.find((x) => x.key === key);
  if (!d) throw new Error(`dialogs.json has no ${key}`);
  const t = d.template;
  dialogOut[key] = {
    id: d.id,
    what: d.what,
    procedure: d.procedure,
    dlu: t.dlu,
    font: { face: t.font.face, size: t.font.point_size },
    styles: t.style_names,
    exStyle: Number.parseInt(t.ex_style, 16),
    // The runtime caption (0x00402860) wins over the template's own.
    caption: d.runtime_texts?.caption ?? t.title,
    controls: t.controls.map((c) => ({
      id: c.id,
      cls: c.class,
      dlu: c.dlu,
      // The procedure's texts replace the template's (0x00402860).
      text: c.runtime_text ?? c.text,
      styles: c.style_names,
    })),
  };
}

const waves = new Set<string>();
const slots = (
  uiSounds.slots as {
    slot: number;
    wave: string;
    file: string;
    plays_when: string[];
    src: string[];
  }[]
).map((s) => {
  const file = s.file.split("/").pop() as string;
  waves.add(file);
  return {
    slot: s.slot,
    wave: s.wave,
    url: `/sfx/ui/${file}`,
    playsWhen: s.plays_when,
    src: s.src,
  };
});

pictures.add(loadingScreen.barFrame.file as string);
pictures.add(loadingScreen.barFill.file as string);

const header = `// GENERATED by tools/generators/importFcopFrontend.ts from the RE repo's
// extracted/frontend/{screens,dialogs,ui_sounds}.json — do not edit by hand.
// Re-run \`bun run gen:frontend\`.
//
// The original's bitmap front end (640 x 480, top-left origin) for the two
// screen sets Metropolis shows, the Win32 dialog templates it opens (geometry
// in dialog units) and the nine UI sound slots. Pictures are files under
// /ui/frontend/ (febmp game id N is bmp{N-1}.png); every block cites the
// decompiled C it was read from.

import type {
  FeDialog,
  FeGroup,
  FeLoadout,
  FeMapButton,
  FeUiSound,
} from "./types";
`;

const body = [
  `export const FE_SETS = ${JSON.stringify(sets)} as const;`,
  `export const FE_GROUPS: Readonly<Record<string, FeGroup>> = ${JSON.stringify(groups)};`,
  `export const FE_PA_MAPS: readonly FeMapButton[] = ${JSON.stringify(paMaps)};`,
  `export const FE_PA_RULES = ${JSON.stringify(paRules)} as const;`,
  `export const FE_LOADOUT: FeLoadout = ${JSON.stringify(loadout)};`,
  `export const FE_PORTRAITS = ${JSON.stringify(portraitData)} as const;`,
  `export const FE_LOADING_SCREEN = ${JSON.stringify(loadingScreen)} as const;`,
  `export const FE_CONNECTED_TO = ${JSON.stringify(connectedTo)} as const;`,
  `export const FE_NEW_GAME_DEFAULTS = ${JSON.stringify(defaults)} as const;`,
  `export const FE_DIALOGS: Readonly<Record<"${DIALOGS.join('" | "')}", FeDialog>> = ${JSON.stringify(dialogOut)};`,
  `export const FE_UI_SOUNDS: readonly FeUiSound[] = ${JSON.stringify(slots)};`,
].join("\n\n");

const fmt = Bun.spawnSync(
  [join(ROOT, "node_modules", ".bin", "biome"), "format", `--stdin-file-path=${OUT_TS}`],
  { stdin: new TextEncoder().encode(`${header}\n${body}\n`), cwd: ROOT },
);
if (fmt.exitCode !== 0) {
  console.error(new TextDecoder().decode(fmt.stderr));
  process.exit(1);
}
const ts = new TextDecoder().decode(fmt.stdout);

// --- write or check ------------------------------------------------------------
const copies: [string, string][] = [];
for (const f of [...pictures].sort()) copies.push([join(FRONTEND, f), join(OUT_PICS, f)]);
for (const f of loadingFiles) {
  copies.push([join(RE, "extracted", "previews", "loading", f), join(OUT_LOADING, f)]);
}
for (const f of [...waves].sort())
  copies.push([join(RE, "extracted", "frontend_sfx", f), join(OUT_SFX, f)]);

let stale = 0;
let bytes = 0;
if (check) {
  for (const [from, to] of copies) {
    const a = Bun.file(from);
    const b = Bun.file(to);
    if (
      !(await b.exists()) ||
      Bun.hash(await a.arrayBuffer()) !== Bun.hash(await b.arrayBuffer())
    ) {
      console.error(`stale: ${to}`);
      stale++;
    }
  }
  const committed = Bun.file(OUT_TS);
  if (!(await committed.exists()) || (await committed.text()) !== ts) {
    console.error(`stale: ${OUT_TS}`);
    stale++;
  }
  // Nothing beyond what the RE names may sit in the copied folders.
  const wanted = new Set(copies.map(([, to]) => to));
  for (const dir of [OUT_PICS, OUT_LOADING, OUT_SFX]) {
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, f);
      if (f.endsWith(".png") || f.endsWith(".wav")) {
        if (!wanted.has(p)) {
          console.error(`not from the RE: ${p}`);
          stale++;
        }
      }
    }
  }
  if (stale > 0) {
    console.error(`importFcopFrontend --check: ${stale} file(s) differ from ${RE}`);
    process.exit(1);
  }
  console.log(`importFcopFrontend --check: ${copies.length} files and the data match ${RE}`);
} else {
  for (const dir of [OUT_PICS, OUT_LOADING, OUT_SFX]) {
    await mkdir(dir, { recursive: true });
    for (const f of await readdir(dir)) {
      if (f.endsWith(".png") || f.endsWith(".wav")) await rm(join(dir, f));
    }
  }
  for (const [from, to] of copies) {
    await Bun.write(to, Bun.file(from));
    bytes += Bun.file(from).size;
  }
  await Bun.write(OUT_TS, ts);
  console.log(
    `importFcopFrontend: ${pictures.size} pictures, ${loadingFiles.length} loading screens, ` +
      `${waves.size} UI sounds (${(bytes / 1024).toFixed(0)} KB) and the data from ${RE}`,
  );
}
