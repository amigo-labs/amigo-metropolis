// WebAudio wrapper (assets.md §5: "a tiny WebAudio wrapper, no audio library
// dependency"). Drains the sim's per-tick event ring buffer and plays a
// pre-rendered sfxr buffer per cue, mixed through master/sfx/music gains.
//
// Browsers block audio until a user gesture, so playback is inert until
// unlock() runs inside one (self-armed on the first pointer/key/touch). Before
// that — and in headless tests, which use the pure synth directly and never
// construct this — pump() still counts cues and tracks lastCue for the debug
// HUD, so the event pipe is observable end to end exactly like the old stub.
//
// Frame-loop discipline: pump() runs once per tick. A one-shot sound needs a
// fresh AudioBufferSourceNode (WebAudio has no other way), but everything else
// is preallocated — the onended handler is bound once, not per voice — and a
// voice cap plus per-tick coalescing of the spammy cues keep it bounded.

import {
  EV_BREACH,
  EV_CAPTURE,
  EV_CLAIM,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_PURCHASE,
  EV_RESPAWN,
  EV_SHOT,
  EVENT_STRIDE,
  type EventBuffer,
} from "@metropolis/sim";
import { renderMusicLoop } from "./music";
import { DETUNE_CUES, PRESETS } from "./presets";
import { renderSfxr } from "./sfxr";
import { MUSIC_OPTIONS, type MusicSelection, parseMusicSelection } from "./tracks";

const cueByType: string[] = [];
cueByType[EV_SHOT] = "shot";
cueByType[EV_EXPLOSION] = "explosion";
cueByType[EV_HIT] = "hit";
cueByType[EV_DEATH] = "death";
cueByType[EV_RESPAWN] = "respawn";
cueByType[EV_PURCHASE] = "purchase";
cueByType[EV_BREACH] = "breach";
cueByType[EV_CAPTURE] = "capture";
cueByType[EV_CLAIM] = "claim";

export type VolumeKind = "master" | "sfx" | "music";
export interface Volumes {
  master: number;
  sfx: number;
  music: number;
}
/** Everything persisted under STORAGE_KEY: volumes plus the music track pick. */
export interface AudioSettings extends Volumes {
  track: MusicSelection;
}

const STORAGE_KEY = "metropolis.audio.v1";
const DEFAULT_VOLUMES: Volumes = { master: 0.8, sfx: 1, music: 0 };
const MAX_VOICES = 24;
/** Cues that can fire many times per tick and would stack into noise. */
const COALESCE = new Set(["shot", "hit", "explosion"]);

/**
 * Parses the persisted settings JSON. Pure so tests can cover it without a
 * DOM. Legacy 3-field payloads (pre-track) parse to track "off", which sounds
 * identical to what those users had.
 */
export function parseAudioSettings(raw: string | null): AudioSettings {
  const out: AudioSettings = { ...DEFAULT_VOLUMES, track: "off" };
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as Partial<AudioSettings>;
    out.master = clamp01(typeof p.master === "number" ? p.master : out.master);
    out.sfx = clamp01(typeof p.sfx === "number" ? p.sfx : out.sfx);
    out.music = clamp01(typeof p.music === "number" ? p.music : out.music);
    out.track = parseMusicSelection(p.track);
  } catch {
    // ignore malformed storage
  }
  return out;
}

function loadSettings(): AudioSettings {
  try {
    return parseAudioSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseAudioSettings(null);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class AudioEngine {
  /** Total cues seen, indexed by EV_* type — debug HUD parity with the old stub. */
  readonly counts = new Uint32Array(16);
  /** Most recent non-shot cue (shots fire constantly and would drown it). */
  lastCue = "";

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Decoded/rendered music, cached per selection so re-picks are instant. */
  private readonly musicBuffers = new Map<MusicSelection, AudioBuffer>();
  private musicSource: AudioBufferSourceNode | null = null;
  /** Bumped per load/switch; a stale async decode must not start playback. */
  private musicLoadGen = 0;
  private settings: AudioSettings = loadSettings();
  private activeVoices = 0;
  private readonly onVoiceEnded = (): void => {
    if (this.activeVoices > 0) this.activeVoices--;
  };
  private unlocked = false;
  private readonly tryUnlock = (): void => this.unlock();

  /** Adds one-shot gesture listeners; the first user interaction unlocks audio. */
  armUnlock(): void {
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) {
      addEventListener(ev, this.tryUnlock, { once: true, passive: true });
    }
  }

  getVolumes(): Volumes {
    const { master, sfx, music } = this.settings;
    return { master, sfx, music };
  }

  setVolume(kind: VolumeKind, value: number): void {
    this.settings[kind] = clamp01(value);
    this.persist();
    this.applyGains();
    // Don't leave the loop running muted at 0 (wastes CPU/battery on mobile);
    // startSelectedMusic() spins up a fresh source when it's turned back up.
    if (this.unlocked) {
      if (this.settings.music > 0) this.startSelectedMusic();
      else this.stopMusic();
    }
  }

  getMusicTrack(): MusicSelection {
    return this.settings.track;
  }

  /**
   * Persists the pick and switches playback. Resolves "missing" when a file
   * track can't be fetched/decoded (placeholder mp3 not dropped in yet) — the
   * selection then reverts to "off" so a reload doesn't retry a dead URL.
   */
  async setMusicTrack(sel: MusicSelection): Promise<"ok" | "missing"> {
    // The picker interaction is itself a gesture, so unlocking here is legal
    // (mirrors preview()). No-op when already unlocked.
    this.unlock();
    this.settings.track = sel;
    this.persist();
    this.stopMusic();
    if (sel === "off") return "ok";
    const gen = ++this.musicLoadGen;
    const buf = await this.loadMusicBuffer(sel);
    if (!buf) {
      if (this.settings.track === sel) {
        this.settings.track = "off";
        this.persist();
      }
      return "missing";
    }
    if (gen === this.musicLoadGen && this.settings.track === sel && this.settings.music > 0) {
      this.startMusicSource(buf);
    }
    return "ok";
  }

  /** Creates the context + gain graph, pre-renders every buffer. Idempotent. */
  unlock(): void {
    if (this.unlocked) return;
    const Ctx =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.unlocked = true;
    this.ctx = new Ctx();
    void this.ctx.resume();

    this.masterGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.applyGains();

    const rate = this.ctx.sampleRate;
    for (const name of Object.keys(PRESETS)) {
      const pcm = renderSfxr(PRESETS[name], rate);
      const audioBuf = this.ctx.createBuffer(1, pcm.length, rate);
      audioBuf.copyToChannel(pcm, 0);
      this.buffers.set(name, audioBuf);
    }
    // Music is loaded on demand (per selected track), not at unlock — see
    // startSelectedMusic(); the synth loop renders lazily through the same path.
    this.startSelectedMusic();
  }

  pump(events: EventBuffer): void {
    // Track which coalesced cues already fired this tick (bitset over EV type).
    let coalescedMask = 0;
    for (let i = 0; i < events.count; i++) {
      const type = events.data[i * EVENT_STRIDE];
      if (type <= 0 || type >= this.counts.length) continue;
      this.counts[type] += 1;
      const cue = cueByType[type];
      if (!cue) continue;
      if (type !== EV_SHOT) this.lastCue = cue;
      if (!this.unlocked) continue;
      if (COALESCE.has(cue)) {
        const bit = 1 << type;
        if (coalescedMask & bit) continue;
        coalescedMask |= bit;
      }
      this.play(cue);
    }
  }

  /** Unlocks (if needed) and plays one cue — for the settings "test" button. */
  preview(cue: string): void {
    this.unlock();
    this.play(cue);
  }

  private play(cue: string): void {
    if (!this.ctx || !this.sfxGain || this.activeVoices >= MAX_VOICES) return;
    const buffer = this.buffers.get(cue);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    if (DETUNE_CUES.has(cue)) src.playbackRate.value = 0.94 + Math.random() * 0.12;
    src.onended = this.onVoiceEnded;
    src.connect(this.sfxGain);
    src.start();
    this.activeVoices++;
  }

  /** Starts the persisted selection if audible and not already playing. */
  private startSelectedMusic(): void {
    const sel = this.settings.track;
    if (sel === "off" || this.settings.music === 0 || this.musicSource) return;
    const gen = ++this.musicLoadGen;
    void this.loadMusicBuffer(sel).then((buf) => {
      if (!buf || gen !== this.musicLoadGen || this.settings.track !== sel) return;
      if (this.settings.music > 0 && !this.musicSource) this.startMusicSource(buf);
    });
  }

  /**
   * Returns the cached buffer for `sel`, rendering (synth) or fetching+decoding
   * (file tracks) on first use. Null on any failure — 404s are expected while
   * the mp3 slots are placeholders.
   */
  private async loadMusicBuffer(sel: MusicSelection): Promise<AudioBuffer | null> {
    if (!this.ctx || sel === "off") return null;
    const cached = this.musicBuffers.get(sel);
    if (cached) return cached;
    let buf: AudioBuffer | null = null;
    if (sel === "synth") {
      const rate = this.ctx.sampleRate;
      const pcm = renderMusicLoop(rate);
      buf = this.ctx.createBuffer(1, pcm.length, rate);
      buf.copyToChannel(pcm, 0);
    } else {
      const url = MUSIC_OPTIONS.find((o) => o.id === sel)?.url;
      if (!url) return null;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      } catch {
        return null; // network error or undecodable file
      }
    }
    this.musicBuffers.set(sel, buf);
    return buf;
  }

  private startMusicSource(buffer: AudioBuffer): void {
    if (!this.ctx || !this.musicGain || this.musicSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.musicGain);
    src.start();
    this.musicSource = src;
  }

  /** A looping source can't be restarted, so stop + drop it; startSelectedMusic remakes it. */
  private stopMusic(): void {
    if (!this.musicSource) return;
    try {
      this.musicSource.stop();
    } catch {
      // already stopped
    }
    this.musicSource.disconnect();
    this.musicSource = null;
  }

  private applyGains(): void {
    if (this.masterGain) this.masterGain.gain.value = this.settings.master;
    if (this.sfxGain) this.sfxGain.gain.value = this.settings.sfx;
    if (this.musicGain) this.musicGain.gain.value = this.settings.music;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }
}
