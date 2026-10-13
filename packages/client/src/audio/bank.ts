// The shape of one arena's sound bank, as the original's loader leaves it
// (src/game/snd/sound_res.c in the RE repo): up to 130 slots, each a priority,
// a polyphony cap, a loop flag, an optional lead-in slot and up to four
// round-robin samples; and three script tables that name a slot by id — A and B
// below 70 (which one is the Cshd entry's byte 7), the high table from 70 up.
//
// The data itself is generated (audio/fcopAudio.generated.ts, `bun run gen:sfx`
// from docs/specs/fcop-re/pa-audio.json); this module only reads it.

/** One registered sample: which file, and the window of it the slot plays. */
export interface BankSample {
  /** Index into FCOP_SAMPLE_FILES. */
  readonly file: number;
  /** First frame of the window, in the file's own 22050 Hz frames. */
  readonly start: number;
  /** Window length in frames. */
  readonly frames: number;
}

export interface BankSlot {
  /** Cshd byte 4, clamped 1..10: the allocator's priority. */
  readonly priority: number;
  /** Cshd byte 5, clamped <= 4: how many may play at once. */
  readonly limit: number;
  /** Cshd byte 6: the buffer plays looping. */
  readonly loop: boolean;
  /** The lead-in slot that starts with this one on the table-A paths, -1 none. */
  readonly leadIn: number;
  readonly samples: readonly BankSample[];
}

export interface SoundBank {
  readonly slots: readonly BankSlot[];
  /** Script ids 0..69 -> slot, -1 none (DAT_004a1488). */
  readonly a: readonly number[];
  /** Script ids 0..69 -> slot, -1 none (DAT_004a1c00). */
  readonly b: readonly number[];
  /** Script ids 70..129 -> slot, -1 none (DAT_004a1bb0). */
  readonly h: readonly number[];
}

export const TABLE_A = 0;
export const TABLE_B = 1;

/** Ids from here on are the high table's, whatever table the caller named. */
const SPLIT = 70;
const LIMIT = 130;
/** The callers' bounds: table A's readers pass 0x47, table B's 0x45. */
const BOUND_A = 0x47;
const BOUND_B = 0x45;

/**
 * 0x00432c90: the slot a script id names on `table`, or -1. Id 0 is "no
 * sound"; a slot with no samples registered answers -1 too.
 */
export function slotFor(bank: SoundBank, table: number, id: number): number {
  let slot: number;
  if (id >= SPLIT) {
    if (id >= LIMIT) return -1;
    slot = bank.h[id - SPLIT] ?? -1;
  } else {
    const bound = table === TABLE_A ? BOUND_A : BOUND_B;
    if (id < 1 || id >= bound) return -1;
    slot = (table === TABLE_A ? bank.a[id] : bank.b[id]) ?? -1;
  }
  if (slot < 0) return -1;
  const s = bank.slots[slot];
  return s && s.samples.length > 0 ? slot : -1;
}
