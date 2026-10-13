// audio/cues.ts: which of the original's sound calls each sim event makes.
// A recording stand-in replaces the engine, so this pins the translation —
// the retail call sites listed at the top of cues.ts — without WebAudio.

import { describe, expect, test } from "bun:test";
import {
  ARCHETYPE,
  createEventBuffer,
  EV_CAPTURE,
  EV_CLAIM,
  EV_DRY_FIRE,
  EV_LOW_AMMO,
  EV_PICKUP,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_SHOT,
  EV_TRANSFORM_REFUSED,
  EV_TURRET_LOST,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_MOVE,
  MATCH_SNAPSHOT_LEN,
  MOVE_CUE_BRAKE,
  MOVE_CUE_DRIVE,
  matchSlotOffset,
  pushEvent,
  SHOT_SLOT_GUN,
  SHOT_SLOT_HEAVY,
  SHOT_SLOT_LAUNCH,
  SNAPSHOT_STRIDE,
  weaponShotPayload,
} from "@metropolis/sim";
import { type CueContext, OriginalSounds } from "../src/audio/cues";
import { type AudioEngine, DEFAULT_LEVEL, parseAudioLevels } from "../src/audio/engine";
import { FCOP_ARENA_AUDIO, FCOP_PLAYER_WEAPONS } from "../src/audio/fcopAudio.generated";

class Recorder {
  calls: string[] = [];
  playScript(id: number, placed: boolean): number {
    this.calls.push(`script ${id}${placed ? " placed" : ""}`);
    return 0;
  }
  playCued(viewport: number, id: number, placed: boolean): void {
    this.calls.push(`cued ${viewport} ${id}${placed ? " placed" : ""}`);
  }
  loopSetScript(viewport: number, id: number): void {
    this.calls.push(`loop ${viewport} ${id}`);
  }
  loopSetMode(): void {}
  loopFollow(): void {}
  queueSet(_r: number, id: number): void {
    this.calls.push(`queue ${id}`);
  }
  setPending(id: number): void {
    this.calls.push(`pending ${id}`);
  }
  speak(id: number): void {
    this.calls.push(`speak ${id}`);
  }
  speakNow(id: number): void {
    this.calls.push(`speakNow ${id}`);
  }
  frame(): void {}
  inRange(): boolean {
    return true;
  }
  within(): boolean {
    return true;
  }
}

const AVATAR0 = 10;
const AVATAR1 = 11;

function context(over: Partial<CueContext> = {}): CueContext {
  const snapshot = new Float32Array(SNAPSHOT_STRIDE * 2);
  snapshot.set([AVATAR0, ARCHETYPE.AVATAR, 0, 5, 5, 0, 0, 0, 1, 0], 0);
  snapshot.set([AVATAR1, ARCHETYPE.AVATAR, 1, 9, 9, 0, 0, 0, 1, 0], SNAPSHOT_STRIDE);
  const match = new Float32Array(MATCH_SNAPSHOT_LEN);
  match[matchSlotOffset(0) + MATCH_SLOT_AVATAR_ID] = AVATAR0;
  match[matchSlotOffset(1) + MATCH_SLOT_AVATAR_ID] = AVATAR1;
  match[matchSlotOffset(0) + MATCH_SLOT_HP_FRAC] = 1;
  match[matchSlotOffset(1) + MATCH_SLOT_HP_FRAC] = 1;
  return {
    snapshot,
    count: 2,
    stride: SNAPSHOT_STRIDE,
    match,
    localSlot: 0,
    captainSlot: -1,
    captainLevel: 0,
    ...over,
  };
}

function run(events: [number, number, number, number][], ctx = context()): string[] {
  const rec = new Recorder();
  const sounds = new OriginalSounds(rec as unknown as AudioEngine);
  const data = FCOP_ARENA_AUDIO["la-cantina"];
  if (!data) throw new Error("la-cantina");
  sounds.begin(data, FCOP_PLAYER_WEAPONS);
  const buf = createEventBuffer();
  for (const [t, a, b, c] of events) pushEvent(buf, t, a, b, c);
  sounds.tick(buf, ctx);
  return rec.calls.filter((c) => !c.startsWith("loop") && !c.startsWith("queue"));
}

describe("the pending-sound slot", () => {
  test("a purchase answers 63, a refusal 73, a capture 63, a pickup 83", () => {
    expect(run([[EV_PURCHASE, 50, 0, ARCHETYPE.RUNNER]])).toEqual(["pending 63"]);
    expect(run([[EV_PURCHASE_REFUSED, AVATAR0, 0, ARCHETYPE.RUNNER]])).toEqual(["pending 73"]);
    expect(run([[EV_CAPTURE, 60, 0, 3]])).toEqual(["pending 63"]);
    expect(run([[EV_PICKUP, 0, 0, 1]])).toEqual(["pending 83"]);
  });
});

describe("the mech's own sounds", () => {
  test("the Mini-Gun is cued (table A), heard flat for the local mech", () => {
    expect(run([[EV_SHOT, AVATAR0, SHOT_SLOT_GUN, weaponShotPayload(0, 12)]])).toEqual([
      "cued 0 26",
    ]);
  });
  test("its block B names its own sound", () => {
    expect(run([[EV_SHOT, AVATAR0, SHOT_SLOT_GUN, weaponShotPayload(0, 12, true)]])).toEqual([
      "cued 0 27",
    ]);
  });
  test("the Hell Fire launches a one-shot (table B); the other mech's is placed", () => {
    expect(run([[EV_SHOT, AVATAR0, SHOT_SLOT_HEAVY, weaponShotPayload(3, 0)]])).toEqual([
      "script 45",
    ]);
    expect(run([[EV_SHOT, AVATAR1, SHOT_SLOT_HEAVY, weaponShotPayload(3, 0)]])).toEqual([
      "script 45 placed",
    ]);
  });
  test("empty and five-left are the local mech's only (scripts 13 / 14)", () => {
    expect(run([[EV_DRY_FIRE, AVATAR0, 0, 0]])).toEqual(["script 13"]);
    expect(run([[EV_LOW_AMMO, AVATAR0, 0, 0]])).toEqual(["script 14"]);
    expect(run([[EV_DRY_FIRE, AVATAR1, 1, 0]])).toEqual([]);
  });
  test("a refused transform plays 42", () => {
    expect(run([[EV_TRANSFORM_REFUSED, AVATAR0, 0, 0]])).toEqual(["script 42"]);
  });
  test("the health gauge sounds once under a third, once more at zero", () => {
    const ctx = context();
    const rec = new Recorder();
    const sounds = new OriginalSounds(rec as unknown as AudioEngine);
    const data = FCOP_ARENA_AUDIO["la-cantina"];
    if (!data) throw new Error("la-cantina");
    sounds.begin(data, FCOP_PLAYER_WEAPONS);
    const empty = createEventBuffer();
    const hp = matchSlotOffset(0) + MATCH_SLOT_HP_FRAC;
    for (const frac of [1, 0.5, 0.3, 0.2, 0, 0]) {
      ctx.match[hp] = frac;
      sounds.tick(empty, ctx);
    }
    expect(rec.calls.filter((c) => c.startsWith("script"))).toEqual(["script 14", "script 14"]);
  });
});

describe("world weapons", () => {
  test("a turret's launch plays its row's sound at the turret", () => {
    const ctx = context();
    const snapshot = new Float32Array(SNAPSHOT_STRIDE * 3);
    snapshot.set(ctx.snapshot);
    snapshot.set([70, ARCHETYPE.TURRET, 1, 3, 3, 0, 0, 0, 1, 0], SNAPSHOT_STRIDE * 2);
    expect(run([[EV_SHOT, 70, SHOT_SLOT_LAUNCH, 0]], { ...ctx, snapshot, count: 3 })).toEqual([
      "script 80 placed",
    ]);
  });
});

describe("speech", () => {
  test("a base turret lost speaks 0 / 1 by side", () => {
    expect(run([[EV_TURRET_LOST, 70, 1, 0]])).toEqual(["speak 1"]);
  });
  test("an outpost claim interrupts with its line: outposts 2, 3, 1, 0 pairwise from 7", () => {
    expect(run([[EV_CLAIM, 40, 0, 2]])).toEqual(["speakNow 7"]);
    expect(run([[EV_CLAIM, 40, 1, 0]])).toEqual(["speakNow 14"]);
  });
  test("heavy purchases speak 15..18 by side", () => {
    expect(run([[EV_PURCHASE, 50, 1, ARCHETYPE.JUGGERNAUT]])).toEqual(["pending 63", "speak 16"]);
    expect(run([[EV_PURCHASE, 50, 0, ARCHETYPE.FORTRESS]])).toEqual(["pending 63", "speak 17"]);
  });
  test("the opening announces the captain's level, 74 + level - 1", () => {
    expect(run([], context({ captainSlot: 1, captainLevel: 3 }))).toEqual(["speak 76"]);
    expect(run([], context({ captainSlot: 1, captainLevel: 0 }))).toEqual([]);
  });
});

describe("the hover loop", () => {
  test("idle 40, driving 41, braking 42 — from the command, not the speed", () => {
    const loops = (move: number): string[] => {
      const ctx = context();
      ctx.snapshot[7] = 1 << 1; // ANIM_HOVER
      ctx.match[matchSlotOffset(0) + MATCH_SLOT_MOVE] = move;
      const rec = new Recorder();
      const sounds = new OriginalSounds(rec as unknown as AudioEngine);
      const data = FCOP_ARENA_AUDIO["la-cantina"];
      if (!data) throw new Error("la-cantina");
      sounds.begin(data, FCOP_PLAYER_WEAPONS);
      sounds.tick(createEventBuffer(), ctx);
      return rec.calls.filter((c) => c.startsWith("loop 0"));
    };
    expect(loops(0)).toEqual(["loop 0 40"]);
    expect(loops(MOVE_CUE_DRIVE)).toEqual(["loop 0 41"]);
    expect(loops(MOVE_CUE_BRAKE)).toEqual(["loop 0 42"]);
  });
});

describe("the three sliders", () => {
  test("default to 0x3f, the original's missing-registry value", () => {
    expect(DEFAULT_LEVEL).toBe(0x3f);
    expect(parseAudioLevels(null)).toEqual({ sfx: 63, music: 63, movies: 63 });
  });
  test("clamp like the setters: negative is silence, past 127 is 127", () => {
    expect(parseAudioLevels('{"sfx":-4,"music":300,"movies":12.7}')).toEqual({
      sfx: 0,
      music: 127,
      movies: 12,
    });
    expect(parseAudioLevels("not json")).toEqual({ sfx: 63, music: 63, movies: 63 });
  });
});
