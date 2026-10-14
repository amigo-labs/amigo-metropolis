// The bindings file, as the original keeps it (`controls.txt`; RE
// input_bindings.h, bindings.c): fourteen lines per player, the first player's
// table then the second's, each "<Device>: <name>". Kept in localStorage
// instead of a file — the one platform difference — and read by the same rules:
//
// - the value starts two characters past the colon (the space the writer puts
//   there);
// - a key name the table does not know binds its first character, sign
//   extended; a joystick name it does not know, or a mouse binding, is refused;
// - ANY failure — a refused line, a missing one — loses everything: both
//   players' tables come back from preset 0, not just the bad line;
// - the writer spells only digits and capital letters itself and writes
//   "Unknown" for anything else, which the reader then refuses, so such a
//   binding is lost on the next load;
// - each line loses its last character (the original zeroes it, the newline),
//   so a last line without a newline loses a character of its own.

import {
  type Binding,
  DEVICE_JOYSTICK,
  DEVICE_KEYBOARD,
  JOY_NAMES,
  KEY_NAMES,
  presetTable,
  SLOT_COUNT,
} from "./bindings";

const DEVICE_NAMES = ["Keyboard", "Joystick", "Mouse"] as const;
const UNKNOWN = "Unknown";
/** The players a file holds. Metropolis drives one; the second keeps its table. */
export const PLAYERS = 2;
/** localStorage key: the file's contents. */
const STORAGE_KEY = "metropolis.controls";

/** One binding as the original writes it: "Keyboard: NumPad8", or "Unknown". */
export function formatBinding(b: Binding): string {
  if (b.device === DEVICE_KEYBOARD) {
    for (const [name, vk] of KEY_NAMES) if (vk === b.code) return `Keyboard: ${name}`;
    const digit = b.code >= 0x30 && b.code <= 0x39;
    const letter = b.code >= 0x41 && b.code <= 0x5a;
    return digit || letter ? `Keyboard: ${String.fromCharCode(b.code)}` : UNKNOWN;
  }
  if (b.device === DEVICE_JOYSTICK) {
    for (const [name, code] of JOY_NAMES) if (code === b.code) return `Joystick: ${name}`;
  }
  return UNKNOWN;
}

/** One line, as the original reads it; null when it refuses the line. */
export function parseBinding(line: string): Binding | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const device = DEVICE_NAMES.indexOf(line.slice(0, colon) as (typeof DEVICE_NAMES)[number]);
  if (device < 0) return null;
  const value = line.slice(colon + 2);
  if (device === DEVICE_KEYBOARD) {
    for (const [name, vk] of KEY_NAMES) if (name === value) return { device, code: vk };
    // The first byte, sign extended (`movsx`): how every plain letter and digit
    // binds without a row of its own. An empty value reads its terminator, 0.
    const byte = value.length > 0 ? value.charCodeAt(0) & 0xff : 0;
    return { device, code: (byte << 24) >> 24 };
  }
  if (device === DEVICE_JOYSTICK) {
    for (const [name, code] of JOY_NAMES) if (name === value) return { device, code };
  }
  return null; // the mouse, and a joystick name the table lacks
}

/** Both players' tables as the file's text. */
export function formatControls(tables: readonly (readonly Binding[])[]): string {
  const lines: string[] = [];
  for (let p = 0; p < PLAYERS; p++) {
    for (let s = 0; s < SLOT_COUNT; s++) lines.push(formatBinding(tables[p][s]));
  }
  return `${lines.join("\n")}\n`;
}

/** The file's text read back: both tables, or null on any failure. */
export function parseControls(text: string): Binding[][] | null {
  const raw = text.split("\n");
  const tables: Binding[][] = [];
  let at = 0;
  for (let p = 0; p < PLAYERS; p++) {
    const table: Binding[] = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
      // fgets: a line exists only while text remains; its last character —
      // the newline, or the last real character of an unterminated last line
      // — is zeroed.
      const terminated = at < raw.length - 1;
      if (!terminated && (at >= raw.length || raw[at].length === 0)) return null;
      const line = terminated ? raw[at] : raw[at].slice(0, -1);
      at++;
      const b = parseBinding(line);
      if (b === null) return null;
      table.push(b);
    }
    tables.push(table);
  }
  return tables;
}

/** Both players' preset-0 tables: what a missing or bad file gives. */
export function defaultControls(): Binding[][] {
  return [presetTable(0, 0), presetTable(1, 0)];
}

/** The stored tables, or the presets when there are none or they are bad. */
export function loadControls(): Binding[][] {
  try {
    const text = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (text) return parseControls(text) ?? defaultControls();
  } catch {
    // Storage blocked (private mode, a sandboxed frame): the presets.
  }
  return defaultControls();
}

/** Stores both tables in the file's form. */
export function saveControls(tables: readonly (readonly Binding[])[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, formatControls(tables));
  } catch {
    // Not persisted; the tables still apply for this session.
  }
}
