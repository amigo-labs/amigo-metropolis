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

const STORAGE_KEY = "metropolis.audio.v1";
const DEFAULT_VOLUMES: Volumes = { master: 0.8, sfx: 1, music: 0 };
const MAX_VOICES = 24;
/** Cues that can fire many times per tick and would stack into noise. */
const COALESCE = new Set(["shot", "hit", "explosion"]);

function loadVolumes(): Volumes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Volumes>;
      return {
        master: clamp01(p.master ?? DEFAULT_VOLUMES.master),
        sfx: clamp01(p.sfx ?? DEFAULT_VOLUMES.sfx),
        music: clamp01(p.music ?? DEFAULT_VOLUMES.music),
      };
    }
  } catch {
    // ignore malformed storage
  }
  return { ...DEFAULT_VOLUMES };
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
  private musicBuffer: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private volumes: Volumes = loadVolumes();
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
    return { ...this.volumes };
  }

  setVolume(kind: VolumeKind, value: number): void {
    this.volumes[kind] = clamp01(value);
    this.persist();
    this.applyGains();
    // Don't leave the loop running muted at 0 (wastes CPU/battery on mobile);
    // ensureMusic() spins up a fresh source when it's turned back up.
    if (this.unlocked) {
      if (this.volumes.music > 0) this.ensureMusic();
      else this.stopMusic();
    }
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
    const music = renderMusicLoop(rate);
    this.musicBuffer = this.ctx.createBuffer(1, music.length, rate);
    this.musicBuffer.copyToChannel(music, 0);

    if (this.volumes.music > 0) this.ensureMusic();
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

  private ensureMusic(): void {
    if (!this.ctx || !this.musicGain || !this.musicBuffer || this.musicSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.musicBuffer;
    src.loop = true;
    src.connect(this.musicGain);
    src.start();
    this.musicSource = src;
  }

  /** A looping source can't be restarted, so stop + drop it; ensureMusic remakes it. */
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
    if (this.masterGain) this.masterGain.gain.value = this.volumes.master;
    if (this.sfxGain) this.sfxGain.gain.value = this.volumes.sfx;
    if (this.musicGain) this.musicGain.gain.value = this.volumes.music;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.volumes));
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }
}
