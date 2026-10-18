// The original's sound module on WebAudio.
//
// Everything that decides WHAT is heard — which slot a script id names, the
// channel it gets or the one it steals, its level and pan, how long a cued
// sound holds, the movement loops, the ambient queue's eight-voice budget, the
// speech line and the ducking under it, the music — is the retail module's
// (src/game/snd/ in the RE repo), through audio/mixer.ts, audio/speech.ts and
// audio/bank.ts. This file only maps each of the 24 logical channels onto a
// WebAudio voice and loads the original's files.
//
// Browsers block audio until a user gesture, so nothing plays until unlock()
// runs inside one (self-armed on the first pointer/key/touch).
//
// Frame-loop discipline (CLAUDE.md renderer rule 1): a sound needs a fresh
// AudioBufferSourceNode — WebAudio has no other way — and that is the one
// allocation per play. Every channel's gain pair is built once at unlock, and
// the bookkeeping is typed arrays.

import { type BankSlot, type SoundBank, slotFor, TABLE_A, TABLE_B } from "./bank";
import {
  ChannelPool,
  channelGains,
  KIND_CUED,
  KIND_RESERVED,
  KIND_SCRIPT,
  lengthApprox,
  NO_SLOT,
  type PositionLevels,
  positionLevels,
  SND_CHANNELS,
  SND_CUE_HOLD,
  SND_CUES_PER_VIEWPORT,
  SND_LEVEL_MAX,
  SND_PAN_CENTRE,
  SND_QUEUE_VOICES,
  SND_RANGE,
  speechLevel,
  WORLD_UNITS_PER_METRE,
} from "./mixer";
import { SpeechQueue } from "./speech";

/** The original's three mixer levels, 0..127 ("Audio Controls", 0x00402930). */
export interface AudioLevels {
  /** "Sound Effects Volume" (DAT_00511e25). */
  sfx: number;
  /** "Music Volume" (DAT_00511e26). */
  music: number;
  /** "Movies Volume" (DAT_00511e27): the speech level. */
  movies: number;
}
export type LevelKind = keyof AudioLevels;

/** `FRONTEND_VOLUME_DEFAULT` 0x3f: what a missing registry value reads as. */
export const DEFAULT_LEVEL = 0x3f;
const STORAGE_KEY = "metropolis.audio.v2";

/** Parses the persisted levels. Pure, for test. */
export function parseAudioLevels(raw: string | null): AudioLevels {
  const out: AudioLevels = { sfx: DEFAULT_LEVEL, music: DEFAULT_LEVEL, movies: DEFAULT_LEVEL };
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as Partial<AudioLevels>;
    for (const k of ["sfx", "music", "movies"] as const) {
      const v = p[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = clampLevel(v);
    }
  } catch {
    // ignore malformed storage
  }
  return out;
}

/** The setters' clamp (0x004329f0): negative is silence, past 0x7f is 0x7f. */
export function clampLevel(v: number): number {
  if (v < 0) return 0;
  return v > SND_LEVEL_MAX ? SND_LEVEL_MAX : Math.trunc(v);
}

/** What the engine plays an arena's sounds from. */
export interface ArenaSounds {
  readonly bank: SoundBank;
  /** URL of every sample file the bank's slots index. */
  readonly sampleUrls: readonly string[];
  /** Speech line N's URL. */
  readonly voiceUrls: readonly string[];
  /** The arena's music, or "" for none. */
  readonly musicUrl: string;
}

/** The samples' own rate: every Cwav is 22050 Hz mono. */
const SAMPLE_RATE = 22050;
/** One sim tick in the original's 300 Hz units (frame_tail's `step`). */
export const TICK_STEP = 10;
/** Viewports the original keeps cue and loop state for. */
const VIEWPORTS = 2;
/** The speech line's channel: full volume, priority 10, kind 0 (0x00432310). */
const LINE_VOLUME = 0x7f;
const LINE_PRIORITY = 10;
/** The movement loop's stop / start cues are made 100 cheaper to steal (cue.c). */
const CUE_KEY_BOOST = 100;
/** snd_loop_set_mode: bit 5 enables, the low three bits are the mode. */
const LOOP_ENABLE = 0x20;
const LOOP_MODE_MASK = 7;
const LOOP_MODE_NONE = 7;
const LOOP_MODE_QUIET = 6;
const LOOP_SCRIPT_BASE = 0x22;
const LOOP_STOP_BASE = 0x32;
const LOOP_START_BASE = 0x38;
const LOOP_QUIET_SCRIPT = 0x3d;
/** "No loop" for snd_loop_set_script. */
export const LOOP_SCRIPT_NONE = 0xff;
/** Ambient queue records the engine keeps (one per sounding actor). */
export const QUEUE_RECORDS = 64;

export class AudioEngine {
  /** Every play, newest last, for the debug HUD and the headless check. */
  lastPlayed = "";
  private ctx: AudioContext | null = null;
  private unlocked = false;
  private readonly tryUnlock = (): void => this.unlock();
  private levels: AudioLevels = loadLevels();

  private arena: ArenaSounds | null = null;
  private bank: SoundBank | null = null;
  private readonly sampleBuffers: (AudioBuffer | null)[] = [];
  private readonly voiceBuffers: (AudioBuffer | null)[] = [];
  private musicBuffer: AudioBuffer | null = null;
  private loadGen = 0;

  // --- the pool and its WebAudio voices --------------------------------------
  private pool: ChannelPool | null = null;
  private readonly source: (AudioBufferSourceNode | null)[] = new Array(SND_CHANNELS).fill(null);
  private readonly gainL: GainNode[] = [];
  private readonly gainR: GainNode[] = [];
  private readonly splitter: ChannelSplitterNode[] = [];
  private readonly gains = new Float32Array(2);
  /** Round-robin cursor per slot (slot +0x31), stepped before use. */
  private readonly cursor = new Uint8Array(130);
  private readonly where: PositionLevels = { volume: 0, pan: SND_PAN_CENTRE };

  // --- the listener (snd_set_listener): the mech, facing the camera's way ---
  private lx = 0;
  private lz = 0;
  private rightX = 1;
  private rightZ = 0;

  // --- cued sounds: three per viewport (DAT_004a14d8) -------------------------
  private readonly cueHold = new Int32Array(VIEWPORTS * SND_CUES_PER_VIEWPORT);
  private readonly cueHeld = new Uint8Array(VIEWPORTS * SND_CUES_PER_VIEWPORT);
  private readonly cueSlot = new Int16Array(VIEWPORTS * SND_CUES_PER_VIEWPORT);
  private readonly cueChannel = new Int8Array(VIEWPORTS * SND_CUES_PER_VIEWPORT).fill(-1);
  private readonly cueGen = new Uint32Array(VIEWPORTS * SND_CUES_PER_VIEWPORT);

  // --- movement loops: one reserved channel per viewport (DAT_004a1ce8) -------
  private readonly loopChannel = new Int8Array(VIEWPORTS).fill(-1);
  private readonly loopLive = new Uint8Array(VIEWPORTS);
  private readonly loopMode = new Int16Array(VIEWPORTS).fill(LOOP_SCRIPT_NONE);
  private readonly loopScript = new Int16Array(VIEWPORTS);
  private readonly loopPlaced = new Uint8Array(VIEWPORTS);
  private readonly loopX = new Float32Array(VIEWPORTS);
  private readonly loopZ = new Float32Array(VIEWPORTS);

  // --- the ambient queue (queue.c, frame_tail.c) ------------------------------
  private readonly qSlot = new Int16Array(QUEUE_RECORDS).fill(-1);
  private readonly qX = new Float32Array(QUEUE_RECORDS);
  private readonly qZ = new Float32Array(QUEUE_RECORDS);
  private readonly qKey = new Int32Array(QUEUE_RECORDS);
  private readonly qChannel = new Int8Array(QUEUE_RECORDS).fill(-1);
  private readonly qGen = new Uint32Array(QUEUE_RECORDS);
  private readonly qOrder = new Int16Array(QUEUE_RECORDS);
  private readonly qVolume = new Int16Array(QUEUE_RECORDS);
  private readonly qPan = new Int16Array(QUEUE_RECORDS);
  private readonly qMark = new Uint8Array(QUEUE_RECORDS);

  // --- the pending-sound slot (*P[3], 0x00436250) -----------------------------
  private pending = 0;

  // --- speech (voice.c) and music (music.c) -----------------------------------
  readonly speech = new SpeechQueue();
  private lineChannel = -1;
  private lineGen = 0;
  private lineTicksLeft = 0;
  private musicChannel = -1;
  private musicWanted = false;
  private musicOffset = 0;
  private musicStartedAt = 0;
  private paused = false;

  /** Adds one-shot gesture listeners; the first user interaction unlocks audio. */
  armUnlock(): void {
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) {
      addEventListener(ev, this.tryUnlock, { once: true, passive: true });
    }
  }

  getLevels(): AudioLevels {
    return { ...this.levels };
  }

  /**
   * One slider. Like the original, the sfx and speech levels apply to what
   * starts from now on; the music level is carried to the playing stream at
   * once (`sound_set_level_b` calls `snd_music_apply_level`).
   */
  setLevel(kind: LevelKind, value: number): void {
    this.levels[kind] = clampLevel(value);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.levels));
    } catch {
      // ignore storage failures (private mode, quota)
    }
    if (kind === "music") this.applyMusicLevel();
  }

  /** Creates the context and the 24 channel voices. Idempotent. */
  unlock(): void {
    if (this.unlocked) return;
    const Ctx =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.unlocked = true;
    const ctx = new Ctx();
    this.ctx = ctx;
    void ctx.resume();
    for (let i = 0; i < SND_CHANNELS; i++) {
      // DirectSound's volume and pan as two channel gains: mono sources feed
      // both, the stereo music feeds them through its splitter.
      const merger = ctx.createChannelMerger(2);
      const l = ctx.createGain();
      const r = ctx.createGain();
      l.connect(merger, 0, 0);
      r.connect(merger, 0, 1);
      merger.connect(ctx.destination);
      const split = ctx.createChannelSplitter(2);
      split.connect(l, 0);
      split.connect(r, 1);
      this.gainL.push(l);
      this.gainR.push(r);
      this.splitter.push(split);
    }
    if (this.arena) void this.loadArena(this.arena);
  }

  /**
   * Switches to an arena's bank: the mission load, which resets the module
   * (0x00432b50: channels, slots, queue, cues, then the two loop channels) and
   * loads the samples, the speech and the music.
   */
  setArena(arena: ArenaSounds): void {
    this.arena = arena;
    this.bank = arena.bank;
    this.resetModule();
    if (this.unlocked) void this.loadArena(arena);
  }

  /** The match is under way: the music starts (`snd_set_active(1)` after load). */
  startMatch(): void {
    this.musicWanted = true;
    this.musicOffset = 0;
    this.paused = false;
    this.startMusic();
  }

  /** Back to the menu: everything stops (`snd_set_active(0)`). */
  stopMatch(): void {
    this.musicWanted = false;
    this.silenceAll(-1);
    this.stopMusic(false);
  }

  /**
   * The pause (0x00434530): the mission menu's sound (script 62) and then
   * everything silenced — the music too — except a speech line on the air.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.silenceAll(this.lineChannel);
    this.stopMusic(true);
    this.playScript(62, false, 0, 0);
  }

  /**
   * The in-game menu opening (0x00407d70): the speech line interrupted
   * (0x00417280 with 0) and the sound silenced (0x00434450 with 0) -- no sound
   * of its own, unlike the pause. `resume` brings it back.
   */
  suspend(): void {
    if (this.paused) return;
    this.paused = true;
    this.silenceAll(-1);
    this.stopMusic(true);
  }

  /** Out of the pause: the music resumes (`snd_set_active(1)`). */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.startMusic();
  }

  /**
   * The listener, once a frame (`snd_set_listener`): the local mech's position
   * in metres, and the camera's right vector for the pan.
   */
  setListener(x: number, z: number, rightX: number, rightZ: number): void {
    this.lx = x;
    this.lz = z;
    const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
    if (len > 1e-6) {
      this.rightX = rightX / len;
      this.rightZ = rightZ / len;
    }
  }

  /**
   * Whether a sound at (x, z) metres would be heard at all: inside SND_RANGE of
   * the listener by the original's octagonal estimate. The effect install asks
   * this before it plays an "at the player" sound flat.
   */
  inRange(x: number, z: number): boolean {
    return this.within(x, z, SND_RANGE / WORLD_UNITS_PER_METRE);
  }

  /** (x, z) metres lies within `metres` of the listener (octagonal estimate). */
  within(x: number, z: number, metres: number): boolean {
    const dx = Math.trunc((x - this.lx) * WORLD_UNITS_PER_METRE);
    const dz = Math.trunc((z - this.lz) * WORLD_UNITS_PER_METRE);
    return lengthApprox(dx, dz) < metres * WORLD_UNITS_PER_METRE;
  }

  // --- the play paths ----------------------------------------------------------

  /**
   * `snd_play_script` / `snd_play_script_at` (table B, kind 1): a one-shot at
   * (x, z) metres, or unplaced. Returns the channel, -1 when refused.
   */
  playScript(id: number, placed: boolean, x: number, z: number): number {
    if (!this.bank) return -1;
    const slot = slotFor(this.bank, TABLE_B, id);
    if (slot < 0) return -1;
    return this.start(slot, KIND_SCRIPT, placed, x, z, -1);
  }

  /**
   * `snd_play_cued` (table A, kind 0): a sound that must not stack. Asked for
   * again while it holds, its hold is refreshed; it stops 0.1 s after the last
   * ask. Brings the slot's lead-in on a fresh start.
   */
  playCued(viewport: number, id: number, placed: boolean, x: number, z: number): void {
    if (!this.bank || viewport < 0 || viewport >= VIEWPORTS) return;
    const slot = slotFor(this.bank, TABLE_A, id);
    if (slot < 0) return;
    const pool = this.pool;
    if (!pool) return;
    const base = viewport * SND_CUES_PER_VIEWPORT;
    let free = -1;
    for (let i = 0; i < SND_CUES_PER_VIEWPORT; i++) {
      const e = base + i;
      if (this.cueHold[e] !== 0) {
        if (this.cueSlot[e] === slot) {
          const c = this.cueChannel[e];
          if (c >= 0 && this.cueGen[e] === pool.generation[c]) {
            this.cueHold[e] = SND_CUE_HOLD;
            this.cueHeld[e] = 1;
            return;
          }
          this.cueHold[e] = 0;
        }
        if (this.cueHold[e] !== 0) continue;
      }
      if (free < 0) free = e;
    }
    if (free < 0) return;
    const channel = this.start(slot, KIND_CUED, placed, x, z, -1);
    if (channel < 0 && !placed) {
      this.cueHold[free] = 0;
      return;
    }
    this.cueHold[free] = SND_CUE_HOLD;
    this.cueHeld[free] = 1;
    this.cueSlot[free] = slot;
    this.cueChannel[free] = channel;
    this.cueGen[free] = channel >= 0 ? pool.generation[channel] : 0;
    this.leadIn(slot, placed, x, z);
  }

  /**
   * `snd_loop_set_mode` (0x004340c0): the walker's loop by an animation event
   * code — bit 5 enables, the low three bits are the mode. A new mode stops
   * the old loop with its stop cue (script 0x32 + mode); the same mode again
   * plays its repeat cue (0x38 + mode); mode 6 is the single cue 0x3d, mode 7
   * silence.
   */
  loopSetMode(viewport: number, state: number, placed: boolean, x: number, z: number): void {
    if ((state & LOOP_ENABLE) === 0 || viewport < 0 || viewport >= VIEWPORTS) return;
    const mode = state & LOOP_MODE_MASK;
    const pool = this.pool;
    if (!pool) return;
    if (this.loopLive[viewport] !== 0) {
      const current = this.loopMode[viewport];
      if (mode === current) {
        const c = this.playScript(current + LOOP_START_BASE, placed, x, z);
        if (c >= 0) pool.key[c] -= CUE_KEY_BOOST;
      } else {
        this.playScript(current + LOOP_STOP_BASE, placed, x, z);
        this.dropVoice(this.loopChannel[viewport]);
        this.loopLive[viewport] = 0;
      }
    }
    if (mode === LOOP_MODE_NONE || this.loopLive[viewport] !== 0) return;
    this.loopMode[viewport] = mode;
    if (mode !== LOOP_MODE_QUIET) {
      this.loopStart(viewport, mode + LOOP_SCRIPT_BASE, placed, x, z);
      return;
    }
    const c = this.playScript(LOOP_QUIET_SCRIPT, placed, x, z);
    if (c >= 0) pool.key[c] -= CUE_KEY_BOOST;
  }

  /**
   * `snd_loop_set_script` (0x004341d0): the same register set by a script id
   * outright, no start or stop cue; asking for the id already there does
   * nothing, so it is safe every frame. LOOP_SCRIPT_NONE is silence.
   */
  loopSetScript(viewport: number, id: number, placed: boolean, x: number, z: number): void {
    if (viewport < 0 || viewport >= VIEWPORTS) return;
    if (id === this.loopMode[viewport]) return;
    if (this.loopLive[viewport] !== 0) {
      this.dropVoice(this.loopChannel[viewport]);
      this.loopLive[viewport] = 0;
    }
    this.loopMode[viewport] = id;
    if (id === LOOP_SCRIPT_NONE) return;
    this.loopStart(viewport, id, placed, x, z);
  }

  /**
   * `snd_loop_replace` (frame_tail.c): a loop that is heard from where it
   * happens — the other player's mech — is re-measured every frame: stopped
   * when it leaves range, started again when it comes back, re-levelled
   * otherwise. Loops heard flat (the local mech's) are never re-measured.
   */
  loopFollow(viewport: number, x: number, z: number): void {
    const pool = this.pool;
    if (!pool || viewport < 0 || viewport >= VIEWPORTS) return;
    if (this.loopLive[viewport] === 0 || this.loopPlaced[viewport] === 0) return;
    this.loopX[viewport] = x;
    this.loopZ[viewport] = z;
    const c = this.loopChannel[viewport];
    if (!this.measure(true, x, z)) {
      this.dropVoice(c);
      return;
    }
    if (!this.source[c]) {
      if (!this.bank) return;
      const slot = slotFor(this.bank, TABLE_A, this.loopScript[viewport]);
      if (slot >= 0) this.start(slot, KIND_RESERVED, true, x, z, c);
      return;
    }
    pool.setLevels(c, this.where.pan, this.where.volume);
    this.applyGains(c);
  }

  /**
   * The ambient queue (`snd_queue_add`): record `index` sounds table-A script
   * `id` at (x, z) — every frame it is re-measured and the eight loudest get a
   * channel. `id` 0 removes the record.
   */
  queueSet(index: number, id: number, x: number, z: number): void {
    if (index < 0 || index >= QUEUE_RECORDS || !this.bank) return;
    const slot = id > 0 ? slotFor(this.bank, TABLE_A, id) : -1;
    if (slot !== this.qSlot[index]) {
      this.queueDrop(index);
      this.qSlot[index] = slot;
      // `snd_queue_add` links a record with a key of zero: it is heard only
      // once the next frame measures it.
      this.qKey[index] = 0;
    }
    this.qX[index] = x;
    this.qZ[index] = z;
    this.qMark[index] = 1;
  }

  /**
   * `snd_queue_live` (0x00432d80): record `index` holds a sound and the last
   * frame measured it in range (a non-zero key).
   */
  queueLive(index: number): boolean {
    if (index < 0 || index >= QUEUE_RECORDS) return false;
    return this.qSlot[index] >= 0 && this.qKey[index] !== 0;
  }

  /** The pending-sound slot: the last id written in a frame is the one played. */
  setPending(id: number): void {
    this.pending = id;
  }

  /** Op 0x0c: queue a speech line. */
  speak(id: number): void {
    this.speech.queue(id);
  }

  /** Op 0x0d: interrupt with a speech line. */
  speakNow(id: number): void {
    if (this.speech.interrupt(id)) this.stopLine();
  }

  /**
   * Once a sim tick (33 ms, 10 of the original's 300 Hz units): the frame
   * tail. The pending sound, the speech pump, the cue holds, the kind-1 key
   * decay, the queue's re-measure and its eight-voice budget.
   */
  frame(): void {
    const pool = this.pool;
    if (!pool || this.paused) return;
    if (this.pending !== 0) {
      this.playScript(this.pending, false, 0, 0);
      this.pending = 0;
    }
    this.speechFrame();
    for (let e = 0; e < VIEWPORTS * SND_CUES_PER_VIEWPORT; e++) {
      if (this.cueHold[e] === 0) continue;
      if (this.cueHeld[e] !== 0) {
        this.cueHeld[e]--;
        continue;
      }
      this.cueHold[e] -= TICK_STEP;
      if (this.cueHold[e] >= 1) continue;
      this.cueHold[e] = 0;
      const c = this.cueChannel[e];
      if (c >= 0 && this.cueGen[e] === pool.generation[c]) pool.release(c);
    }
    pool.decay(TICK_STEP);
    this.queueFrame();
  }

  // --- internals -------------------------------------------------------------

  private resetModule(): void {
    if (!this.bank) return;
    const bank = this.bank;
    for (let c = 0; c < SND_CHANNELS; c++) this.stopVoice(c);
    this.pool = new ChannelPool(
      {
        priority: (s) => bank.slots[s]?.priority ?? 1,
        limit: (s) => bank.slots[s]?.limit ?? 0,
      },
      bank.slots.length,
      (c) => this.stopVoice(c),
    );
    this.cursor.fill(0);
    this.cueHold.fill(0);
    this.cueHeld.fill(0);
    this.cueChannel.fill(-1);
    this.qSlot.fill(-1);
    this.qChannel.fill(-1);
    this.pending = 0;
    this.speech.reset();
    this.lineChannel = -1;
    // The two movement loops' reserved channels, then the music's: priority
    // 10 at full volume, the highest key there is, so nothing steals them.
    for (let v = 0; v < VIEWPORTS; v++) {
      this.loopChannel[v] = this.pool.alloc(SND_LEVEL_MAX, 10, KIND_RESERVED, NO_SLOT);
      this.loopLive[v] = 0;
      this.loopMode[v] = LOOP_SCRIPT_NONE;
    }
    this.musicChannel = this.pool.alloc(SND_LEVEL_MAX, 10, KIND_RESERVED, NO_SLOT);
  }

  private async loadArena(arena: ArenaSounds): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const gen = ++this.loadGen;
    this.sampleBuffers.length = 0;
    this.voiceBuffers.length = 0;
    const samples = await Promise.all(arena.sampleUrls.map((u) => this.fetchDecode(u)));
    if (gen !== this.loadGen) return;
    for (const b of samples) this.sampleBuffers.push(b);
    const voices = await Promise.all(arena.voiceUrls.map((u) => this.fetchDecode(u)));
    if (gen !== this.loadGen) return;
    for (const b of voices) this.voiceBuffers.push(b);
    this.musicBuffer = arena.musicUrl ? await this.fetchDecode(arena.musicUrl) : null;
    if (gen !== this.loadGen) return;
    if (this.musicWanted && !this.paused) this.startMusic();
  }

  /** Fetches and decodes one file. Null on 404, network error or bad data. */
  private async fetchDecode(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * `snd_start` (0x00433ff0) with `snd_slot_start` (0x00434560): measure,
   * allocate (or use `own`), step the round robin, play. -1 when refused.
   */
  private start(
    slot: number,
    kind: number,
    placed: boolean,
    x: number,
    z: number,
    own: number,
  ): number {
    const pool = this.pool;
    const bank = this.bank;
    if (!pool || !bank) return -1;
    const s = bank.slots[slot];
    if (!s || s.samples.length === 0) return -1;
    if (!this.measure(placed, x, z)) return -1;
    const channel = own >= 0 ? own : pool.alloc(this.where.volume, s.priority, kind, slot);
    if (channel < 0) return -1;
    let next = this.cursor[slot] + 1;
    if (next >= s.samples.length) next = 0;
    this.cursor[slot] = next;
    pool.setLevels(channel, this.where.pan, this.where.volume);
    if (!this.openVoice(channel, s, next)) {
      if (own < 0) pool.release(channel);
      return -1;
    }
    return channel;
  }

  /** `snd_play_lead_in` (0x00434640): the slot's head, kind 1, same place. */
  private leadIn(slot: number, placed: boolean, x: number, z: number): void {
    const lead = this.bank?.slots[slot]?.leadIn ?? -1;
    if (lead >= 0) this.start(lead, KIND_SCRIPT, placed, x, z, -1);
  }

  private loopStart(viewport: number, id: number, placed: boolean, x: number, z: number): void {
    this.loopLive[viewport] = 1;
    this.loopScript[viewport] = id;
    this.loopPlaced[viewport] = placed ? 1 : 0;
    this.loopX[viewport] = x;
    this.loopZ[viewport] = z;
    if (!this.bank) return;
    const slot = slotFor(this.bank, TABLE_A, id);
    if (slot < 0) return;
    const c = this.start(slot, KIND_RESERVED, placed, x, z, this.loopChannel[viewport]);
    if (c >= 0) this.leadIn(slot, placed, x, z);
  }

  /** `snd_position_levels` + `_adjust` into `this.where`; false when refused. */
  private measure(placed: boolean, x: number, z: number): boolean {
    const dx = Math.trunc((x - this.lx) * WORLD_UNITS_PER_METRE);
    const dz = Math.trunc((z - this.lz) * WORLD_UNITS_PER_METRE);
    return positionLevels(!placed, dx, dz, this.rightX, this.rightZ, this.levels.sfx, this.where);
  }

  private openVoice(channel: number, slot: BankSlot, index: number): boolean {
    const ctx = this.ctx;
    const sample = slot.samples[index];
    const buf = sample ? this.sampleBuffers[sample.file] : null;
    if (!ctx || !sample || !buf) return false;
    this.stopVoice(channel);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const t0 = sample.start / SAMPLE_RATE;
    const len = sample.frames / SAMPLE_RATE;
    src.connect(this.gainL[channel]);
    src.connect(this.gainR[channel]);
    this.applyGains(channel);
    if (slot.loop) {
      src.loop = true;
      src.loopStart = t0;
      src.loopEnd = t0 + len;
      src.start(0, t0);
    } else {
      src.start(0, t0, len);
    }
    this.source[channel] = src;
    this.lastPlayed = sample.file.toString();
    return true;
  }

  private applyGains(channel: number): void {
    const pool = this.pool;
    if (!pool) return;
    channelGains(pool.volume[channel], pool.pan[channel], this.gains);
    this.gainL[channel].gain.value = this.gains[0];
    this.gainR[channel].gain.value = this.gains[1];
  }

  /** Stops the WebAudio voice behind a channel (the pool's release callback). */
  private stopVoice(channel: number): void {
    const src = this.source[channel];
    if (!src) return;
    this.source[channel] = null;
    try {
      src.stop();
    } catch {
      // never started or already stopped
    }
    src.disconnect();
  }

  /** `snd_channel_drop_buffer`: the voice goes, the (reserved) channel stays. */
  private dropVoice(channel: number): void {
    if (channel >= 0) this.stopVoice(channel);
  }

  private queueDrop(index: number): void {
    const c = this.qChannel[index];
    const pool = this.pool;
    if (c >= 0 && pool && this.qGen[index] === pool.generation[c]) pool.release(c);
    this.qChannel[index] = -1;
  }

  /**
   * frame_tail's queue pass: every record re-measured; records the caller did
   * not renew this tick are dropped; then, loudest first, at most eight get a
   * channel — anything past the budget or out of range loses the one it had.
   */
  private queueFrame(): void {
    const pool = this.pool;
    const bank = this.bank;
    if (!pool || !bank) return;
    let n = 0;
    for (let i = 0; i < QUEUE_RECORDS; i++) {
      if (this.qSlot[i] < 0) continue;
      if (this.qMark[i] === 0) {
        this.queueDrop(i);
        this.qSlot[i] = -1;
        continue;
      }
      this.qMark[i] = 0;
      if (this.measure(true, this.qX[i], this.qZ[i])) {
        const s = bank.slots[this.qSlot[i]];
        this.qKey[i] = (s?.priority ?? 0) * 16 + this.where.volume;
        this.qVolume[i] = this.where.volume;
        this.qPan[i] = this.where.pan;
      } else {
        this.qKey[i] = 0;
      }
      this.qOrder[n++] = i;
    }
    // Loudest first (insertion sort over at most 64, no allocation).
    for (let a = 1; a < n; a++) {
      const r = this.qOrder[a];
      let b = a - 1;
      while (b >= 0 && this.qKey[this.qOrder[b]] < this.qKey[r]) {
        this.qOrder[b + 1] = this.qOrder[b];
        b--;
      }
      this.qOrder[b + 1] = r;
    }
    let heard = 0;
    for (let k = 0; k < n; k++) {
      const r = this.qOrder[k];
      const live = this.qChannel[r] >= 0 && this.qGen[r] === pool.generation[this.qChannel[r]];
      if (heard < SND_QUEUE_VOICES && this.qKey[r] !== 0) {
        if (!live) {
          const slot = this.qSlot[r];
          const s = bank.slots[slot];
          if (!s) continue;
          const c = pool.alloc(this.qVolume[r], s.priority, KIND_CUED, slot);
          if (c < 0) continue;
          pool.owned[c] = 1;
          this.where.volume = this.qVolume[r];
          this.where.pan = this.qPan[r];
          let next = this.cursor[slot] + 1;
          if (next >= s.samples.length) next = 0;
          this.cursor[slot] = next;
          pool.setLevels(c, this.qPan[r], this.qVolume[r]);
          if (!this.openVoice(c, s, next)) {
            pool.release(c);
            continue;
          }
          this.qChannel[r] = c;
          this.qGen[r] = pool.generation[c];
          this.leadIn(slot, true, this.qX[r], this.qZ[r]);
        } else {
          const c = this.qChannel[r];
          pool.setLevels(c, this.qPan[r], this.qVolume[r]);
          this.applyGains(c);
          pool.rekey(c, this.qKey[r]);
        }
        heard++;
      } else if (live) {
        this.queueDrop(r);
      }
    }
  }

  private speechFrame(): void {
    const pool = this.pool;
    if (!pool) return;
    if (this.lineChannel >= 0) {
      this.lineTicksLeft--;
      const gone = pool.generation[this.lineChannel] !== this.lineGen;
      if (gone || this.lineTicksLeft <= 0) this.stopLine();
    }
    const id = this.speech.pump();
    if (id < 0) return;
    const buf = this.voiceBuffers[id];
    const ctx = this.ctx;
    const c = pool.alloc(LINE_VOLUME, LINE_PRIORITY, KIND_CUED, NO_SLOT);
    if (!buf || !ctx || c < 0) {
      if (c >= 0) pool.release(c);
      this.speech.lineEnded();
      return;
    }
    this.stopVoice(c);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gainL[c]);
    src.connect(this.gainR[c]);
    // The line's own level escapes the ducking it starts (volume_raw stays -1).
    channelGains(speechLevel(this.levels.movies), SND_PAN_CENTRE, this.gains);
    this.gainL[c].gain.value = this.gains[0];
    this.gainR[c].gain.value = this.gains[1];
    src.start();
    this.source[c] = src;
    this.lineChannel = c;
    this.lineGen = pool.generation[c];
    // bytes * 300 / 22050 engine ticks, in sim ticks.
    this.lineTicksLeft = Math.ceil(buf.duration * 30) + 1;
    this.lastPlayed = `voice ${id}`;
    this.setDucking(true);
  }

  private stopLine(): void {
    const pool = this.pool;
    if (pool && this.lineChannel >= 0 && pool.generation[this.lineChannel] === this.lineGen) {
      pool.release(this.lineChannel);
    }
    this.lineChannel = -1;
    this.speech.lineEnded();
    this.setDucking(false);
  }

  /** `snd_duck` / `snd_unduck`: kinds 0 and 2 re-applied from their raw level. */
  private setDucking(on: boolean): void {
    const pool = this.pool;
    if (!pool || pool.ducking === on) return;
    pool.ducking = on;
    for (const kind of [KIND_CUED, KIND_RESERVED]) {
      for (let c = pool.head(kind); c >= 0; c = pool.after(c)) {
        const raw = pool.volumeRaw[c];
        if (raw < 0) continue;
        pool.setLevels(c, pool.pan[c], raw);
        this.applyGains(c);
      }
    }
  }

  /**
   * `snd_silence_all` (0x00434480): the movement loops off, every kind-1
   * channel and every kind-0 one but `keep` released. Kind 2 (the reserved
   * channels) is not walked; their voices are dropped by their owners.
   */
  private silenceAll(keep: number): void {
    const pool = this.pool;
    if (!pool) return;
    if (keep < 0 && this.lineChannel >= 0) this.stopLine();
    for (let v = 0; v < VIEWPORTS; v++) {
      if (this.loopLive[v] !== 0) this.dropVoice(this.loopChannel[v]);
      this.loopLive[v] = 0;
      this.loopMode[v] = LOOP_SCRIPT_NONE;
    }
    for (let c = pool.head(KIND_SCRIPT); c >= 0; c = pool.head(KIND_SCRIPT)) pool.release(c);
    let c = pool.head(KIND_CUED);
    while (c >= 0) {
      const next = pool.after(c);
      if (c !== keep) pool.release(c);
      c = next;
    }
    this.cueHold.fill(0);
    for (let i = 0; i < QUEUE_RECORDS; i++) this.qChannel[i] = -1;
  }

  private startMusic(): void {
    const ctx = this.ctx;
    const pool = this.pool;
    if (!ctx || !pool || !this.musicBuffer || !this.musicWanted || this.musicChannel < 0) return;
    if (this.source[this.musicChannel]) return;
    const c = this.musicChannel;
    const src = ctx.createBufferSource();
    src.buffer = this.musicBuffer;
    src.loop = true;
    src.connect(this.splitter[c]);
    pool.setLevels(c, SND_PAN_CENTRE, this.levels.music);
    this.applyGains(c);
    const offset = this.musicOffset % this.musicBuffer.duration;
    src.start(0, offset);
    this.musicStartedAt = ctx.currentTime - offset;
    this.source[c] = src;
  }

  private stopMusic(keepPlace: boolean): void {
    const ctx = this.ctx;
    if (this.musicChannel < 0) return;
    if (keepPlace && ctx && this.source[this.musicChannel]) {
      this.musicOffset = ctx.currentTime - this.musicStartedAt;
    } else if (!keepPlace) {
      this.musicOffset = 0;
    }
    this.stopVoice(this.musicChannel);
  }

  private applyMusicLevel(): void {
    const pool = this.pool;
    if (!pool || this.musicChannel < 0) return;
    pool.setLevels(this.musicChannel, SND_PAN_CENTRE, this.levels.music);
    this.applyGains(this.musicChannel);
  }
}

function loadLevels(): AudioLevels {
  try {
    return parseAudioLevels(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseAudioLevels(null);
  }
}
