// audio/cues.ts: which of the original's sound calls each sim event makes.
// A recording stand-in replaces the engine, so this pins the translation —
// the retail call sites listed at the top of cues.ts — without WebAudio.

import { describe, expect, test } from "bun:test";
import {
  ARCHETYPE,
  createEventBuffer,
  EV_CAPTAIN_EVENT,
  EV_CAPTURE,
  EV_CLAIM,
  EV_DEATH,
  EV_DRY_FIRE,
  EV_LIFT_ARRIVE,
  EV_LOW_AMMO,
  EV_PICKUP,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_ROUND_IMPACT,
  EV_SHOT,
  EV_SUNK,
  EV_TRANSFORM_REFUSED,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
  LIFT_SNAP_MOVING,
  LIFT_SNAP_STRIDE,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_MOVE,
  MATCH_SNAPSHOT_LEN,
  MOVE_CUE_BRAKE,
  MOVE_CUE_DRIVE,
  matchSlotOffset,
  pushEvent,
  roundSource,
  SHOT_SLOT_GUN,
  SHOT_SLOT_HEAVY,
  SHOT_SLOT_LAUNCH,
  SNAPSHOT_STRIDE,
  weaponShotPayload,
} from "@metropolis/sim";
import { loadedBank, slotFor, TABLE_A, TABLE_B } from "../src/audio/bank";
import { type CueContext, OriginalSounds, type WalkerLoops } from "../src/audio/cues";
import { type AudioEngine, DEFAULT_LEVEL, parseAudioLevels } from "../src/audio/engine";
import { FCOP_ARENA_AUDIO, FCOP_PLAYER_WEAPONS } from "../src/audio/fcopAudio.generated";
import { createX1Walk } from "../src/render/x1Walk";

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
  loopSetMode(viewport: number, state: number): void {
    this.calls.push(`mode ${viewport} 0x${state.toString(16)}`);
  }
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
    lifts: new Float32Array(0),
    ...over,
  };
}

/**
 * Runs `events` in one tick, then `after` quiet ticks (mission functions speak
 * on their poll), and returns the calls bar the loops and the queue.
 */
function run(
  events: [number, number, number, number][],
  ctx = context(),
  after = 0,
  mapId = "la-cantina",
): string[] {
  const rec = new Recorder();
  const sounds = new OriginalSounds(rec as unknown as AudioEngine);
  const data = FCOP_ARENA_AUDIO[mapId];
  if (!data) throw new Error(mapId);
  sounds.begin(data, FCOP_PLAYER_WEAPONS, []);
  const buf = createEventBuffer();
  for (const [t, a, b, c] of events) pushEvent(buf, t, a, b, c);
  sounds.tick(buf, ctx);
  const quiet = createEventBuffer();
  for (let i = 0; i < after; i++) sounds.tick(quiet, ctx);
  return rec.calls.filter(
    (c) => !c.startsWith("loop") && !c.startsWith("queue") && !c.startsWith("mode"),
  );
}

/** Runs `fn` with Math.random fixed at `value`. */
function withRandom<T>(value: number, fn: () => T): T {
  const real = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
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
  test("a downed mech's wreck plays 65; a sunk one (HARD's water) plays nothing", () => {
    const down = run([[EV_DEATH, AVATAR0, 1, ARCHETYPE.AVATAR]]);
    expect(down).toContain("script 65");
    expect(
      run([
        [EV_SUNK, AVATAR0, 0, 0],
        [EV_DEATH, AVATAR0, -1, ARCHETYPE.AVATAR],
      ]),
    ).toEqual([]);
    // The marker is the named mech's, and this tick's only.
    expect(
      run([
        [EV_SUNK, AVATAR1, 1, 0],
        [EV_DEATH, AVATAR0, 1, ARCHETYPE.AVATAR],
      ]),
    ).toContain("script 65");
  });
  test("the health gauge sounds once under a third, once more at zero", () => {
    const ctx = context();
    const rec = new Recorder();
    const sounds = new OriginalSounds(rec as unknown as AudioEngine);
    const data = FCOP_ARENA_AUDIO["la-cantina"];
    if (!data) throw new Error("la-cantina");
    sounds.begin(data, FCOP_PLAYER_WEAPONS, []);
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
  test("the opening announces the captain's level, 74 + level - 1, on fn55's poll", () => {
    const levels = (ctx: CueContext) =>
      run([], ctx, 30).filter((c) => /^speak (7[4-9]|8[0-2])$/.test(c));
    expect(levels(context({ captainSlot: 1, captainLevel: 3 }))).toEqual(["speak 76"]);
    expect(levels(context({ captainSlot: 1, captainLevel: 0 }))).toEqual([]);
    // Not in a two-player game: fn55 is one-viewport only.
    expect(levels(context({ captainLevel: 3 }))).toEqual([]);
  });

  test("the base's turret under fire speaks on its function's poll, not at once", () => {
    expect(run([[EV_TURRET_UNDER_FIRE, 70, 0, 0]])).toEqual([]);
    expect(run([[EV_TURRET_UNDER_FIRE, 70, 0, 0]], context(), 30)).toEqual(["speak 4"]);
  });

  test("the captain's announcements wait for the chatter cooldown, then roll their dice", () => {
    const solo = context({ captainSlot: 1, captainLevel: 0 });
    // Event 2 (its guns on the player) plays at 50 %: a low roll speaks 33/34.
    const said = withRandom(0, () => run([[EV_CAPTAIN_EVENT, 99, 2, 0]], solo, 60));
    expect(said).toContain("speak 33");
    // The roll fails: nothing.
    expect(withRandom(0.99, () => run([[EV_CAPTAIN_EVENT, 99, 2, 0]], solo, 60))).toEqual([]);
  });
});

describe("effects", () => {
  test("a world round's impact comes from its shooter's row", () => {
    // A turret's (row 3) impact effect plays script 30, positioned.
    const turret = roundSource(ARCHETYPE.TURRET, 1);
    expect(run([[EV_ROUND_IMPACT, 5 * 16, 5 * 16, turret]])).toEqual(["script 30 placed"]);
    // The second side's tanks fire row 6, whose impact is silent.
    const tank = roundSource(ARCHETYPE.RUNNER, 1);
    expect(run([[EV_ROUND_IMPACT, 5 * 16, 5 * 16, tank]])).toEqual([]);
  });

  test("a death emits its class's group 0, or the fallback on the coin", () => {
    const ctx = context();
    const snapshot = new Float32Array(SNAPSHOT_STRIDE * 3);
    snapshot.set(ctx.snapshot);
    snapshot.set([80, ARCHETYPE.RUNNER, 1, 5, 5, 0, 0, 0, 0, 0], SNAPSHOT_STRIDE * 2);
    const dies = (r: number) =>
      withRandom(r, () =>
        run([[EV_DEATH, 80, -1, ARCHETYPE.RUNNER]], { ...ctx, snapshot, count: 3 }),
      );
    // Class 26: group 0 is effect 9 (script 27), the fallback 17 (script 26).
    expect(dies(0.9)).toEqual(["script 27 placed"]);
    expect(dies(0.1)).toEqual(["script 26 placed"]);
  });
});

describe("the load gates", () => {
  test("a weapon nobody carries leaves its samples out of the bank", () => {
    const data = FCOP_ARENA_AUDIO["la-cantina"];
    if (!data) throw new Error("la-cantina");
    // A26, the Mini-Gun's loop, loads only for a loadout with code 0x00.
    expect(slotFor(loadedBank(data.bank, new Set([0x00])), TABLE_A, 26)).toBeGreaterThanOrEqual(0);
    expect(slotFor(loadedBank(data.bank, new Set([0x01])), TABLE_A, 26)).toBe(-1);
    // The pickup (high 83) is never gated.
    expect(slotFor(loadedBank(data.bank, new Set()), TABLE_B, 83)).toBeGreaterThanOrEqual(0);
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
      sounds.begin(data, FCOP_PLAYER_WEAPONS, []);
      sounds.tick(createEventBuffer(), ctx);
      return rec.calls.filter((c) => c.startsWith("loop 0"));
    };
    expect(loops(0)).toEqual(["loop 0 40"]);
    expect(loops(MOVE_CUE_DRIVE)).toEqual(["loop 0 41"]);
    expect(loops(MOVE_CUE_BRAKE)).toEqual(["loop 0 42"]);
  });
});

describe("the walker loop (fcop-fidelity.md A9)", () => {
  /** A slot-0 X1 animation with `codes` passed this tick, in `form`. */
  function walker(form: number, codes: number[]): WalkerLoops {
    const w = createX1Walk();
    w.owner[0] = AVATAR0;
    w.owner[1] = -1;
    w.form[0] = form;
    codes.forEach((c, k) => {
      w.codes[k] = c;
    });
    w.codeCount[0] = codes.length;
    return w;
  }
  function heard(ticks: WalkerLoops[], local = 0): string[] {
    const rec = new Recorder();
    const sounds = new OriginalSounds(rec as unknown as AudioEngine);
    const data = FCOP_ARENA_AUDIO["la-cantina"];
    if (!data) throw new Error("la-cantina");
    sounds.begin(data, FCOP_PLAYER_WEAPONS, []);
    for (const w of ticks)
      sounds.tick(createEventBuffer(), context({ walker: w, localSlot: local }));
    return rec.calls.filter((c) => c.startsWith("mode") || c.startsWith("loop 0"));
  }

  test("hands every code the legs passed to snd_loop_set_mode, in order", () => {
    expect(heard([walker(0, [0x23, 0x27])])).toEqual(["mode 0 0x23", "mode 0 0x27"]);
  });

  test("the other player's mech is its own viewport, heard from where it walks", () => {
    expect(heard([walker(0, [0x21])], 1)).toEqual(["mode 1 0x21"]);
  });

  test("while the hover's tick runs -- the ramp back included -- the hover loop plays", () => {
    // ANIM_HOVER is clear (the sim's mode flips on the ramp's first tick), but
    // the hover form runs until the walker end, then the register goes to 0xff.
    expect(heard([walker(1, [0x23]), walker(0, [0x27])])).toEqual([
      "loop 0 40",
      "loop 0 255",
      "mode 0 0x27",
    ]);
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

describe("lifts (fcop-fidelity.md P12)", () => {
  // Every PA lift's record names travel script 70 and arrival script 71.
  function lifted(moving: number, events: [number, number, number, number][]): string[] {
    const rec = new Recorder();
    const sounds = new OriginalSounds(rec as unknown as AudioEngine);
    const data = FCOP_ARENA_AUDIO["proving-ground"];
    if (!data) throw new Error("proving-ground");
    sounds.begin(data, FCOP_PLAYER_WEAPONS, [
      { x: 104, y: 65 },
      { x: 136, y: 175 },
    ]);
    const lifts = new Float32Array(2 * LIFT_SNAP_STRIDE);
    lifts[LIFT_SNAP_STRIDE + LIFT_SNAP_MOVING] = moving;
    const buf = createEventBuffer();
    for (const [t, a, b, c] of events) pushEvent(buf, t, a, b, c);
    sounds.tick(buf, context({ lifts }));
    return rec.calls.filter((c) => !c.startsWith("loop"));
  }

  test("a moving lift holds its travel script in the ambient queue", () => {
    expect(lifted(1, [])).toContain("queue 70");
    expect(lifted(0, [])).not.toContain("queue 70");
  });

  test("a lift reaching a stop plays its arrival script at the lift", () => {
    expect(lifted(0, [[EV_LIFT_ARRIVE, 1, 1, 0]])).toContain("script 71 placed");
  });
});
