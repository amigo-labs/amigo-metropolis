// The front end's config and its save file, in localStorage.
//
// The live config (the maps' levels, the picks, the loadouts) is kept across a
// reload: a browser tab closing is not the original's QUIT, and the brief keeps
// the progress (fcop-fidelity.md F4). SAVE GAME / LOAD GAME are the original's
// twenty named slots (save_dialog.c): a save copies the config into the
// selected slot under the typed name, a load copies a slot's config back.

import { type FeConfig, normalizeConfig, recordPaWin, rowOfMap } from "./model";

const CONFIG_KEY = "metropolis.frontend.v1";
const SAVES_KEY = "metropolis.saves.v1";

/** save.cfg's twenty slots; an empty one lists as "-EMPTY-" (0x004867cc). */
export const SAVE_SLOTS = 20;
export const EMPTY_SLOT = "-EMPTY-";
/** The slot name's bytes, the terminator included (0x19). */
export const SAVE_NAME_MAX = 24;

export interface SaveSlot {
  name: string;
  config: FeConfig;
}

export interface SaveFile {
  /** The slot word: the list's last selection. */
  slot: number;
  slots: (SaveSlot | null)[];
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota: the config still holds for this session.
  }
}

export function loadConfig(): FeConfig {
  return normalizeConfig(read(CONFIG_KEY));
}

export function storeConfig(config: FeConfig): void {
  write(CONFIG_KEY, config);
}

export function emptySaveFile(): SaveFile {
  return { slot: 0, slots: new Array<SaveSlot | null>(SAVE_SLOTS).fill(null) };
}

/** The save file as the dialog's WM_INITDIALOG reads it; anything unreadable is empty. */
export function parseSaveFile(raw: unknown): SaveFile {
  const out = emptySaveFile();
  if (raw === null || typeof raw !== "object") return out;
  const r = raw as { slot?: unknown; slots?: unknown };
  const slots = Array.isArray(r.slots) ? r.slots : [];
  for (let i = 0; i < SAVE_SLOTS; i++) {
    const s = slots[i] as { name?: unknown; config?: unknown } | null | undefined;
    if (s && typeof s.name === "string" && s.name.length > 0) {
      out.slots[i] = { name: s.name.slice(0, SAVE_NAME_MAX), config: normalizeConfig(s.config) };
    }
  }
  const slot = typeof r.slot === "number" ? Math.trunc(r.slot) : 0;
  out.slot = slot >= 0 && slot < SAVE_SLOTS ? slot : 0;
  return out;
}

export function loadSaveFile(): SaveFile {
  return parseSaveFile(read(SAVES_KEY));
}

export function storeSaveFile(file: SaveFile): void {
  write(SAVES_KEY, file);
}

/** The combo's twenty lines. */
export function slotNames(file: SaveFile): string[] {
  return file.slots.map((s) => s?.name ?? EMPTY_SLOT);
}

/**
 * The save worker (0x00403f10): the typed name into the selected slot with a
 * copy of the config. Answers the refusal's text, or null on success.
 */
export function saveToSlot(
  file: SaveFile,
  slot: number,
  name: string,
  config: FeConfig,
): string | null {
  const trimmed = name.slice(0, SAVE_NAME_MAX);
  if (trimmed.length === 0) return "Must enter a name.";
  if (slot < 0 || slot >= SAVE_SLOTS) return "Must enter a name.";
  file.slot = slot;
  file.slots[slot] = { name: trimmed, config: normalizeConfig(JSON.parse(JSON.stringify(config))) };
  return null;
}

/** The load worker (0x00403e20): a named slot's config, or null for "Not a valid save.". */
export function loadFromSlot(file: SaveFile, slot: number): FeConfig | null {
  const s = file.slots[slot];
  if (!s) return null;
  file.slot = slot;
  return normalizeConfig(JSON.parse(JSON.stringify(s.config)));
}

/**
 * A won match against the Sky Captain, credited to the stored config
 * (recordPaWin): `mapId`'s row at `level` (1..10). Answers what moved:
 * nothing, the next level, or -- frame_step_game's finished arm (0x004096b6),
 * the map's level byte 9 or more -- the map finished, which also plays the
 * map's post-mission movie (0x00409762).
 */
export function recordSoloWin(mapId: string, level: number): "none" | "level" | "finished" {
  const row = rowOfMap(mapId);
  if (row < 0) return "none";
  const config = loadConfig();
  const before = config.paLevel[row];
  if (!recordPaWin(config, row, level - 1)) return "none";
  storeConfig(config);
  return before >= 9 ? "finished" : "level";
}
