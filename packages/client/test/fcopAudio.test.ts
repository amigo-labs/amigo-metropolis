// The generated sound banks (audio/fcopAudio.generated.ts, from the RE repo's
// pa_sound_tables.py) pinned at the points the decompiled code and the shipped
// containers fix, arena by arena. If a re-import moves one of these, either the
// RE's loader simulation changed or the import went wrong — both worth a stop.

import { describe, expect, test } from "bun:test";
import { slotFor, TABLE_A, TABLE_B } from "../src/audio/bank";
import {
  FCOP_ARENA_AUDIO,
  FCOP_PLAYER_WEAPONS,
  FCOP_SAMPLE_FILES,
  FCOP_VOICE_FILES,
} from "../src/audio/fcopAudio.generated";

const ARENAS = [
  "urban-jungle",
  "proving-ground",
  "la-cantina",
  "bug-hunt",
  "hollywood-keys",
  "venice-beach",
];

/** The file names a script id's slot plays, in registration order. */
function files(mapId: string, table: number, id: number): string[] {
  const data = FCOP_ARENA_AUDIO[mapId];
  if (!data) throw new Error(mapId);
  const slot = slotFor(data.bank, table, id);
  if (slot < 0) return [];
  return data.bank.slots[slot].samples.map((s) => FCOP_SAMPLE_FILES[s.file] ?? "?");
}

describe("the six arenas' banks", () => {
  test("every FCOP arena has one, with its own music", () => {
    for (const id of ARENAS) {
      const data = FCOP_ARENA_AUDIO[id];
      expect(data).toBeDefined();
      expect(data?.music).toBe(`/music/${data?.mission}.wav`);
    }
  });

  test("purchase accept (B63) and refuse (high 73) are the same sounds everywhere", () => {
    for (const id of ARENAS) {
      expect(files(id, TABLE_B, 63)).toEqual(["/sfx/s057.wav"]);
      expect(files(id, TABLE_B, 73)).toEqual(["/sfx/s004.wav"]);
    }
  });

  test("the pickup sound (high 83): s017, Joke's own s121", () => {
    for (const id of ARENAS) {
      expect(files(id, TABLE_B, 83)).toEqual([
        id === "bug-hunt" ? "/sfx/s121.wav" : "/sfx/s017.wav",
      ]);
    }
  });

  test("one id, two tables: A26 is the Mini-Gun's loop, B26 a one-shot", () => {
    const data = FCOP_ARENA_AUDIO["la-cantina"];
    if (!data) throw new Error("la-cantina");
    const a = slotFor(data.bank, TABLE_A, 26);
    const b = slotFor(data.bank, TABLE_B, 26);
    expect(files("la-cantina", TABLE_A, 26)).toEqual(["/sfx/s072.wav"]);
    expect(data.bank.slots[a].loop).toBe(true);
    expect(a).not.toBe(b);
    expect(files("la-cantina", TABLE_B, 26)).toEqual(["/sfx/s046.wav"]);
  });

  test("a looping sample with a lead-in plays its tail, and the head from its own slot", () => {
    const data = FCOP_ARENA_AUDIO["la-cantina"];
    if (!data) throw new Error("la-cantina");
    const slot = data.bank.slots[slotFor(data.bank, TABLE_A, 29)]; // the Flamethrower
    expect(slot.samples[0]).toMatchObject({ start: 12511 });
    expect(slot.leadIn).toBeGreaterThanOrEqual(0);
    const head = data.bank.slots[slot.leadIn];
    expect(head.loop).toBe(false);
    expect(head.samples[0]).toMatchObject({ start: 0, frames: 12511 });
  });

  test("the PA wreck (B65) is four variants, Joke's its own", () => {
    expect(files("la-cantina", TABLE_B, 65)).toEqual([
      "/sfx/s013.wav",
      "/sfx/s014.wav",
      "/sfx/s015.wav",
      "/sfx/s016.wav",
    ]);
    expect(files("bug-hunt", TABLE_B, 65)).toHaveLength(4);
  });

  test("world weapons: turrets fire 80, Venice Beach's tanks, jets and Fortress are silent", () => {
    for (const id of ARENAS) {
      const w = FCOP_ARENA_AUDIO[id]?.world ?? [];
      if (id === "venice-beach") {
        expect(w[1]?.sound).toBe(0);
        expect(w[4]?.sound).toBe(0);
        expect(w[6]?.sound).toBe(0);
      } else {
        expect(w[3]?.sound).toBe(80);
        expect(w[1]?.sound).toBe(78);
      }
    }
  });

  test("movement: walker loops A34..39, hover A40..42", () => {
    expect(files("la-cantina", TABLE_A, 34)).toEqual(["/sfx/s021.wav"]);
    expect(files("la-cantina", TABLE_A, 40)).toEqual(["/sfx/s038.wav"]);
    expect(files("la-cantina", TABLE_A, 41)).toEqual(["/sfx/s039.wav"]);
    expect(files("la-cantina", TABLE_A, 42)).toEqual(["/sfx/s040.wav"]);
  });

  test("the player's weapons: the Mini-Gun is a direct kind on A26 / A27", () => {
    const mini = FCOP_PLAYER_WEAPONS[0x00];
    expect(mini?.a).toMatchObject({ kind: 0x0a, sound: 26 });
    expect(mini?.b.sound).toBe(27);
    expect(FCOP_PLAYER_WEAPONS[0x10]?.a.sound).toBe(45);
  });

  test("86 speech lines", () => {
    expect(FCOP_VOICE_FILES).toHaveLength(86);
    expect(FCOP_VOICE_FILES[0]).toBe("/sfx/voice/v001.wav");
  });
});
