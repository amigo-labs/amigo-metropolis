// The original's mixer, as pure arithmetic and one logical channel pool.
//
// Everything here is transcribed from the decompiled retail sound module in
// amigo-labs/fcop-reverse-engineering (src/game/snd/channel.c, listener.c,
// cue.c, frame_tail.c; math/vec.c) and has no WebAudio in it, so the rules can
// be pinned by tests without an AudioContext. audio/engine.ts maps each logical
// channel onto a WebAudio voice; which sound plays, at what level, and which
// one is refused or stolen is decided here, as the original decides it.
//
// Units are the original's: levels 0..127, world units (8192 a metre = one
// Metropolis cell), the 300 Hz engine clock for holds and key decay.

/** 0x7f: a level, a pan position and every slider run 0..127. */
export const SND_LEVEL_MAX = 127;
/** `SND_RANGE` 0x20000: inaudible at and past 16 m (8192 world units a metre). */
export const SND_RANGE = 0x20000;
/** World units in one metre / Metropolis cell. */
export const WORLD_UNITS_PER_METRE = 8192;
/** Pan positions: 0 hard left, 0x40 centre, 0x7f hard right. */
export const SND_PAN_CENTRE = 0x40;
export const SND_PAN_RIGHT = 0x7f;

/** 24 channels (retail DAT_0050e900). */
export const SND_CHANNELS = 24;
/** Channel kinds: 0 cued / queued / speech, 1 one-shot scripts, 2 reserved. */
export const KIND_CUED = 0;
export const KIND_SCRIPT = 1;
export const KIND_RESERVED = 2;
/** No slot behind a channel (the reserved loop and music channels). */
export const NO_SLOT = -1;
/** The +100 a kind-1 channel's key carries (0x00433b30). */
const KIND1_KEY_BIAS = 100;

/** `snd_play_cued`'s hold: 0x1e engine ticks (0.1 s at 300 Hz). */
export const SND_CUE_HOLD = 0x1e;
/** Three cue entries per viewport (retail DAT_004a14d8). */
export const SND_CUES_PER_VIEWPORT = 3;
/** The ambient queue hands out at most eight channels a frame. */
export const SND_QUEUE_VOICES = 8;
/** The frame step is clamped before it ages anything (frame_tail.c). */
export const SND_FRAME_STEP_MAX = 0x3c;

/**
 * Volume curve, 0x004318e0: hundredths of a decibel of attenuation for a level.
 * 127 is 0, 0 is -1666 — the whole range is about seventeen decibels, never
 * silence. Truncating divides by 127 and by -6, as retail's magic multiplies are.
 */
export function attenuationCentiDb(level: number): number {
  const scaled = 10000 - Math.trunc((level * 10000) / SND_LEVEL_MAX);
  const value = Math.trunc(scaled / -6) | 0;
  if (value < -10000) return -10000;
  return value > 0 ? 0 : value;
}

/**
 * Pan curve, 0x00431960: DirectSound pan in hundredths of a decibel for a pan
 * position. Positive attenuates the LEFT channel by that much, negative the
 * right; the shipped positions reach ±1666.
 */
export function panCentiDb(level: number): number {
  const scaled = 10000 - Math.trunc((level * 20000) / SND_LEVEL_MAX);
  const value = Math.trunc(scaled / -6) | 0;
  if (value < -10000) return -10000;
  return value > 10000 ? 10000 : value;
}

/** Hundredths of a decibel -> linear gain. */
export function centiDbToGain(cdb: number): number {
  return 10 ** (cdb / 2000);
}

/**
 * The two channel gains DirectSound would apply for a (volume, pan) pair: the
 * volume attenuates both, the pan attenuates the far side. Written into `out`
 * as [left, right].
 */
export function channelGains(volume: number, pan: number, out: Float32Array): void {
  const v = centiDbToGain(attenuationCentiDb(volume));
  const p = panCentiDb(pan);
  out[0] = p > 0 ? v * centiDbToGain(-p) : v;
  out[1] = p < 0 ? v * centiDbToGain(p) : v;
}

/**
 * 0x00457b40, the octagonal length estimate every sound distance uses: exact on
 * the axes, a few per cent long on the diagonals. Integer world units in and out.
 */
export function lengthApprox(dx: number, dz: number): number {
  let hi = Math.abs(dx | 0);
  let lo = Math.abs(dz | 0);
  if (lo > hi) {
    const t = hi;
    hi = lo;
    lo = t;
  }
  if (lo > hi >> 1) {
    const sum = hi + lo;
    const blend = (sum * 37 * 2 + hi + (lo << 5)) >> 7;
    const spread = hi - lo;
    return (spread >> 2) - (spread >> 6) + blend;
  }
  return (lo >> 2) - (lo >> 6) + hi;
}

/** What `snd_position_levels` + `snd_position_adjust` answer for one sound. */
export interface PositionLevels {
  /** Volume level 0..127. */
  volume: number;
  /** Pan position 0..127. */
  pan: number;
}

/**
 * 0x00432f00 + 0x004333a0 for one listener. A sound at the origin is
 * unpositioned: full sfx level, centred. Otherwise the level falls linearly to
 * nothing at SND_RANGE, and the pan is the offset's component along the
 * listener's right, `(x >> 10) + 0x40` clamped to 0..0x7f — so a full swing
 * spans the same 16 m. Returns false (refused) out of range.
 *
 * `rightX`/`rightZ` is the listener's unit right vector in world axes; it
 * replaces retail's rotation by the camera's facing word, which the RE has not
 * tied to a writer (fcop-fidelity.md, audio rows).
 */
export function positionLevels(
  unplaced: boolean,
  dx: number,
  dz: number,
  rightX: number,
  rightZ: number,
  sfxLevel: number,
  out: PositionLevels,
): boolean {
  if (unplaced) {
    out.volume = sfxLevel;
    out.pan = SND_PAN_CENTRE;
    return true;
  }
  const d = lengthApprox(dx, dz);
  if (d > SND_RANGE - 1) {
    out.volume = 0;
    out.pan = SND_PAN_CENTRE;
    return false;
  }
  let v = sfxLevel - ((d * sfxLevel) >> 17);
  if (v < 0) v = 0;
  if (v > sfxLevel) v = sfxLevel;
  out.volume = v;
  const x = Math.trunc(dx * rightX + dz * rightZ);
  let p = (x >> 10) + SND_PAN_CENTRE;
  if (p < 0) p = 0;
  if (p > SND_PAN_RIGHT) p = SND_PAN_RIGHT;
  out.pan = p;
  return true;
}

/** Speech level from the "Movies Volume" slider: min(127, c + c/2). */
export function speechLevel(movies: number): number {
  const v = movies + (movies >> 1);
  return v > SND_LEVEL_MAX ? SND_LEVEL_MAX : v;
}

/** Ducking halves a level with an arithmetic shift (0x004345d0). */
export function duck(level: number): number {
  return level >> 1;
}

/** Per-slot state the pool needs: the original's polyphony cap. */
export interface SlotLimits {
  /** The slot's priority (Cshd byte 4, clamped 1..10). */
  priority(slot: number): number;
  /** The slot's polyphony limit (Cshd byte 5, clamped <= 4). */
  limit(slot: number): number;
}

/**
 * The 24-channel pool of channel.c, with its three live lists, the per-slot
 * key-ordered lists, generations and both ways of stealing (0x00433b30). Only
 * bookkeeping: the engine owns the WebAudio voice behind each index and is told
 * through `onRelease` when a channel is taken away.
 *
 * Typed arrays throughout, so allocation and release are allocation-free.
 */
export class ChannelPool {
  readonly kind = new Int8Array(SND_CHANNELS);
  readonly key = new Int32Array(SND_CHANNELS);
  readonly slot = new Int16Array(SND_CHANNELS);
  readonly generation = new Uint32Array(SND_CHANNELS);
  /** Raw volume level (before ducking), -1 when it is not to be re-applied. */
  readonly volumeRaw = new Int16Array(SND_CHANNELS);
  readonly volume = new Int16Array(SND_CHANNELS);
  readonly pan = new Int16Array(SND_CHANNELS);
  /** Nonzero: a queue record owns this channel and is told when it goes. */
  readonly owned = new Uint8Array(SND_CHANNELS);

  private readonly next = new Int8Array(SND_CHANNELS);
  private readonly prev = new Int8Array(SND_CHANNELS);
  private readonly slotNext = new Int8Array(SND_CHANNELS);
  private readonly slotPrev = new Int8Array(SND_CHANNELS);
  private readonly live = new Int8Array(3);
  private free = 0;
  private freeCount = SND_CHANNELS;
  private nextGeneration = 1;
  /** Per-slot head of the key-ordered playing list, and the playing count. */
  private readonly slotHead: Int8Array;
  private readonly slotPlaying: Uint8Array;
  ducking = false;

  constructor(
    private readonly slots: SlotLimits,
    slotCount: number,
    private readonly onRelease: (channel: number) => void,
  ) {
    this.slotHead = new Int8Array(slotCount).fill(-1);
    this.slotPlaying = new Uint8Array(slotCount);
    this.reset();
  }

  /** 0x00432b50's pool half: everything free, every list empty, no ducking. */
  reset(): void {
    this.ducking = false;
    this.live.fill(-1);
    for (let i = 0; i < SND_CHANNELS; i++) {
      this.generation[i] = 0;
      this.kind[i] = 0;
      this.key[i] = 0;
      this.slot[i] = NO_SLOT;
      this.owned[i] = 0;
      this.volumeRaw[i] = -1;
      this.next[i] = i + 1 < SND_CHANNELS ? i + 1 : -1;
      this.prev[i] = -1;
      this.slotNext[i] = -1;
      this.slotPrev[i] = -1;
    }
    this.slotHead.fill(-1);
    this.slotPlaying.fill(0);
    this.free = 0;
    this.freeCount = SND_CHANNELS;
  }

  /** Channels currently playing `slot`. */
  playing(slot: number): number {
    return this.slotPlaying[slot] ?? 0;
  }

  /** Head of a live list (kind 1's is sorted, quietest first), -1 if empty. */
  head(kind: number): number {
    return this.live[kind === 0 || kind === 2 ? kind : 1];
  }

  /** The next channel on the same live list, -1 at the end. */
  after(channel: number): number {
    return this.next[channel];
  }

  isLive(channel: number): boolean {
    return this.generation[channel] !== 0;
  }

  /**
   * 0x00433b30. A channel for a sound of this `volume` and `priority`, or -1.
   * With room in the slot, the pool's free list, and failing that the kind-1
   * list's head if it is cheaper. With the slot at its cap, only the slot's own
   * cheapest voice, if it is cheaper and is kind 1 or owned.
   */
  alloc(volume: number, priority: number, kind: number, slot: number): number {
    const key = priority * 16 + volume;
    let victim = -1;
    let taken = -1;
    if (slot === NO_SLOT || this.slotPlaying[slot] < this.slots.limit(slot)) {
      taken = this.take();
      if (taken < 0) {
        const h = this.live[1];
        if (h >= 0 && this.key[h] < key) victim = h;
      }
    } else {
      const h = this.slotHead[slot];
      if (h >= 0 && this.key[h] < key && (this.kind[h] === 1 || this.owned[h] !== 0)) {
        victim = h;
      }
    }
    if (victim >= 0) {
      this.release(victim);
      taken = this.take();
    }
    if (taken < 0) return -1;
    this.slot[taken] = slot;
    this.volume[taken] = volume;
    this.kind[taken] = kind;
    this.owned[taken] = 0;
    this.key[taken] = kind === 1 ? key + KIND1_KEY_BIAS : key;
    this.generation[taken] = this.nextGeneration;
    this.volumeRaw[taken] = -1;
    this.nextGeneration = (this.nextGeneration + 1) >>> 0;
    if (this.nextGeneration === 0) this.nextGeneration = 1;
    this.link(taken);
    return taken;
  }

  /**
   * 0x004345d0: store the levels a channel plays at. The raw volume is kept so
   * ducking can be undone; the effective one is halved while speech ducks.
   */
  setLevels(channel: number, pan: number, volume: number): void {
    this.volumeRaw[channel] = volume;
    this.volume[channel] = this.ducking ? duck(volume) : volume;
    this.pan[channel] = pan;
  }

  /** 0x00433980. Idempotent; tells the engine to stop the voice. */
  release(channel: number): void {
    if (this.generation[channel] === 0) return;
    this.generation[channel] = 0;
    this.onRelease(channel);
    const list = this.listOf(channel);
    const p = this.prev[channel];
    const n = this.next[channel];
    if (p < 0) this.live[list] = n;
    else this.next[p] = n;
    if (n >= 0) this.prev[n] = p;
    this.next[channel] = this.free;
    this.prev[channel] = -1;
    this.free = channel;
    this.freeCount++;
    const s = this.slot[channel];
    if (s !== NO_SLOT) this.slotUnlink(channel, s);
    this.owned[channel] = 0;
  }

  /** Re-key a channel and re-thread its slot list (the queue's re-measure). */
  rekey(channel: number, key: number): void {
    if (this.key[channel] === key) return;
    this.key[channel] = key;
    const s = this.slot[channel];
    if (s !== NO_SLOT) {
      this.slotUnlink(channel, s);
      this.slotLink(channel, s);
    }
  }

  /** The frame tail's decay: every kind-1 key above zero loses `step`. */
  decay(step: number): void {
    for (let c = this.live[1]; c >= 0; c = this.next[c]) {
      if (this.key[c] > 0) this.key[c] -= step;
    }
  }

  private listOf(channel: number): number {
    const k = this.kind[channel];
    return k === 0 || k === 2 ? k : 1;
  }

  private take(): number {
    if (this.freeCount === 0) return -1;
    const c = this.free;
    this.free = this.next[c];
    this.freeCount--;
    return c;
  }

  /** 0x00433c40: kinds 0 and 2 push on the front, kind 1 inserts by key. */
  private link(channel: number): void {
    const list = this.listOf(channel);
    if (list !== 1) {
      const h = this.live[list];
      if (h >= 0) this.prev[h] = channel;
      this.next[channel] = h;
      this.prev[channel] = -1;
      this.live[list] = channel;
    } else {
      let before = -1;
      let at = this.live[1];
      while (at >= 0) {
        if (this.key[channel] < this.key[at]) break;
        before = at;
        at = this.next[at];
      }
      this.prev[channel] = before;
      this.next[channel] = at;
      if (before < 0) this.live[1] = channel;
      else this.next[before] = channel;
      if (at >= 0) this.prev[at] = channel;
    }
    const s = this.slot[channel];
    if (s !== NO_SLOT) this.slotLink(channel, s);
  }

  /** 0x00433a90: insert before the first strictly greater key. */
  private slotLink(channel: number, s: number): void {
    let before = -1;
    let at = this.slotHead[s];
    while (at >= 0) {
      if (this.key[channel] < this.key[at]) break;
      before = at;
      at = this.slotNext[at];
    }
    this.slotPrev[channel] = before;
    this.slotNext[channel] = at;
    if (before < 0) this.slotHead[s] = channel;
    else this.slotNext[before] = channel;
    if (at >= 0) this.slotPrev[at] = channel;
    this.slotPlaying[s]++;
  }

  /** 0x00433a50. */
  private slotUnlink(channel: number, s: number): void {
    const p = this.slotPrev[channel];
    const n = this.slotNext[channel];
    if (p >= 0) this.slotNext[p] = n;
    else this.slotHead[s] = n;
    if (n >= 0) this.slotPrev[n] = p;
    this.slotPlaying[s]--;
    this.slotNext[channel] = -1;
    this.slotPrev[channel] = -1;
  }
}
