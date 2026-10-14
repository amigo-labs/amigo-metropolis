// The original's mixer arithmetic and channel pool (audio/mixer.ts), pinned
// against the formulas in the RE repo's src/game/snd/channel.c, listener.c and
// math/vec.c.

import { describe, expect, test } from "bun:test";
import {
  attenuationCentiDb,
  ChannelPool,
  channelGains,
  KIND_CUED,
  KIND_SCRIPT,
  lengthApprox,
  NO_SLOT,
  type PositionLevels,
  panCentiDb,
  positionLevels,
  SND_CHANNELS,
  SND_RANGE,
  speechLevel,
} from "../src/audio/mixer";
import { SpeechQueue } from "../src/audio/speech";

describe("level and pan curves (0x004318e0 / 0x00431960)", () => {
  test("volume: 127 is unattenuated, 0 is -16.66 dB, never silent", () => {
    expect(attenuationCentiDb(127)).toBe(0);
    expect(attenuationCentiDb(0)).toBe(-1666);
    // trunc((10000 - trunc(63*10000/127)) / -6) = trunc((10000-4960)/-6) = -840
    expect(attenuationCentiDb(63)).toBe(-840);
  });

  test("pan: 0 attenuates the right, 127 the left, 0x40 is centre", () => {
    expect(panCentiDb(0)).toBe(-1666);
    expect(panCentiDb(127)).toBe(1666);
    expect(panCentiDb(0x40)).toBe(13);
  });

  test("channel gains follow DirectSound's pan semantics", () => {
    const out = new Float32Array(2);
    channelGains(127, 127, out);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[0]).toBeCloseTo(10 ** (-1666 / 2000), 6);
    channelGains(127, 0, out);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(10 ** (-1666 / 2000), 6);
  });
});

describe("octagonal length (0x00457b40)", () => {
  test("exact on the axes", () => {
    expect(lengthApprox(8192, 0)).toBe(8192);
    expect(lengthApprox(0, -8192)).toBe(8192);
  });
  test("the diagonal blend", () => {
    // hi = lo = 8192: blend = (16384*74 + 8192 + 8192*32) >> 7 = 11584; spread 0.
    // (8192 * sqrt 2 = 11585.)
    expect(lengthApprox(8192, 8192)).toBe(11584);
  });
  test("the near-axis arm: hi + lo/4 - lo/64", () => {
    expect(lengthApprox(10000, 1000)).toBe(10000 + (1000 >> 2) - (1000 >> 6));
  });
});

describe("position levels (0x00432f00 / 0x004333a0)", () => {
  const out: PositionLevels = { volume: 0, pan: 0 };
  test("unplaced sounds play at the sfx level, centred", () => {
    expect(positionLevels(true, 0, 0, 1, 0, 100, out)).toBe(true);
    expect(out).toEqual({ volume: 100, pan: 0x40 });
  });
  test("linear falloff to nothing at 16 m, refused past it", () => {
    expect(positionLevels(false, SND_RANGE / 2, 0, 0, 1, 127, out)).toBe(true);
    expect(out.volume).toBe(127 - ((65536 * 127) >> 17));
    expect(positionLevels(false, SND_RANGE, 0, 0, 1, 127, out)).toBe(false);
  });
  test("pan is (lateral >> 10) + 0x40, clamped", () => {
    positionLevels(false, 8192, 0, 1, 0, 127, out);
    expect(out.pan).toBe((8192 >> 10) + 0x40);
    positionLevels(false, -100000, 0, 1, 0, 127, out);
    expect(out.pan).toBe(0);
  });
  test("speech level: min(127, c + c/2)", () => {
    expect(speechLevel(64)).toBe(96);
    expect(speechLevel(100)).toBe(127);
  });
});

describe("channel pool (0x00433b30 and friends)", () => {
  const limits = { priority: () => 7, limit: (s: number) => (s === 0 ? 2 : 4) };
  const released: number[] = [];
  const pool = new ChannelPool(limits, 4, (c) => released.push(c));

  test("hands out all 24, then steals the cheapest kind-1 only if cheaper", () => {
    pool.reset();
    for (let i = 0; i < SND_CHANNELS; i++) {
      expect(pool.alloc(50, 7, KIND_SCRIPT, NO_SLOT)).toBeGreaterThanOrEqual(0);
    }
    // key 7*16+40 = 152 against kind-1 keys 7*16+50+100 = 262: refused.
    expect(pool.alloc(40, 7, KIND_SCRIPT, NO_SLOT)).toBe(-1);
    // A cued sound at priority 10, volume 127: 287 > 262, steals the head.
    released.length = 0;
    expect(pool.alloc(127, 10, KIND_CUED, NO_SLOT)).toBeGreaterThanOrEqual(0);
    expect(released.length).toBe(1);
  });

  test("a slot at its cap steals only its own cheapest kind-1 voice", () => {
    pool.reset();
    const a = pool.alloc(30, 7, KIND_SCRIPT, 0);
    const b = pool.alloc(60, 7, KIND_SCRIPT, 0);
    expect(pool.playing(0)).toBe(2);
    released.length = 0;
    // Quieter than both: refused.
    expect(pool.alloc(10, 7, KIND_SCRIPT, 0)).toBe(-1);
    // The voices it would steal carry kind 1's +100 and the request does not:
    // at the same priority even full volume (7*16+127 = 239) loses to `a`'s
    // 7*16+30+100 = 242. Priority 10 at 100 (260) takes `a`, the slot's head.
    expect(pool.alloc(127, 7, KIND_SCRIPT, 0)).toBe(-1);
    const c = pool.alloc(100, 10, KIND_SCRIPT, 0);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(released).toEqual([a]);
    expect(pool.isLive(b)).toBe(true);
    expect(pool.playing(0)).toBe(2);
  });

  test("cued (kind 0) voices are not stolen at a slot's cap", () => {
    pool.reset();
    pool.alloc(10, 7, KIND_CUED, 0);
    pool.alloc(10, 7, KIND_CUED, 0);
    expect(pool.alloc(127, 10, KIND_SCRIPT, 0)).toBe(-1);
  });

  test("kind-1 keys decay by the frame step until they reach zero", () => {
    pool.reset();
    const c = pool.alloc(50, 7, KIND_SCRIPT, NO_SLOT);
    const k = pool.key[c];
    pool.decay(10);
    expect(pool.key[c]).toBe(k - 10);
  });

  test("release is idempotent and frees the slot's count", () => {
    pool.reset();
    const c = pool.alloc(50, 7, KIND_SCRIPT, 1);
    pool.release(c);
    pool.release(c);
    expect(pool.playing(1)).toBe(0);
    expect(pool.isLive(c)).toBe(false);
  });

  test("ducking halves the effective level, keeps the raw one", () => {
    pool.reset();
    const c = pool.alloc(100, 7, KIND_CUED, NO_SLOT);
    pool.ducking = true;
    pool.setLevels(c, 0x40, 101);
    expect(pool.volume[c]).toBe(50);
    expect(pool.volumeRaw[c]).toBe(101);
  });
});

describe("speech queue (voice.c)", () => {
  test("one line at a time, in order", () => {
    const q = new SpeechQueue();
    q.queue(4);
    q.queue(7);
    expect(q.pump()).toBe(4);
    expect(q.pump()).toBe(-1); // 4 on the air
    q.lineEnded();
    expect(q.pump()).toBe(7);
  });

  test("a repeat of the last line is retired unplayed", () => {
    const q = new SpeechQueue();
    q.queue(4);
    expect(q.pump()).toBe(4);
    q.lineEnded();
    q.queue(4);
    expect(q.pump()).toBe(-1);
    expect(q.pending).toBe(0);
  });

  test("interrupt stops the line on the air and goes in front", () => {
    const q = new SpeechQueue();
    q.queue(1);
    q.queue(2);
    expect(q.pump()).toBe(1);
    expect(q.interrupt(9)).toBe(true);
    expect(q.pump()).toBe(9);
    q.lineEnded();
    expect(q.pump()).toBe(2);
  });

  test("a full ring drops appended lines", () => {
    const q = new SpeechQueue();
    for (let i = 0; i < 10; i++) q.queue(i);
    expect(q.pending).toBe(8);
  });
});
