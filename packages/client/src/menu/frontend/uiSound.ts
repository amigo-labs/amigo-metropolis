// The front end's UI sounds (ui_sounds.json; ui_sound.c 0x00409cf0):
// PlaySoundA(MAKEINTRESOURCE(id), NULL, SND_RESOURCE | SND_ASYNC) of the exe's
// WAVE resources, now public/sfx/ui/.
//
// PlaySound is one sound at a time: a new call stops the one playing. So
// START's slot 0 is cut by its slot 1 at once, as in the original. It is not
// the game's mixer either: the Audio dialog's sliders do not reach it.
// Menu world (docs/specs/ui.md): this allocates freely.

import { FE_UI_SOUNDS } from "./frontendData.generated";

/** The file a slot plays, or null for a slot the table does not have. */
export function uiSoundUrl(slot: number): string | null {
  return FE_UI_SOUNDS.find((s) => s.slot === slot)?.url ?? null;
}

/** The distinct files the nine slots name (0x9e is shipped but never played). */
export function uiSoundFiles(): string[] {
  return [...new Set(FE_UI_SOUNDS.map((s) => s.url))];
}

type Ctx = AudioContext;

export class UiSounds {
  private ctx: Ctx | null = null;
  private readonly raw = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly decoded = new Map<string, AudioBuffer>();
  private current: AudioBufferSourceNode | null = null;
  private wanted = 0;

  /** Starts fetching the files, so the first click is not late. */
  preload(): void {
    for (const url of uiSoundFiles()) this.fetchRaw(url);
  }

  private fetchRaw(url: string): Promise<ArrayBuffer | null> {
    let p = this.raw.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      this.raw.set(url, p);
    }
    return p;
  }

  private context(): Ctx | null {
    if (this.ctx) return this.ctx;
    const C =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    this.ctx = new C();
    return this.ctx;
  }

  /** Plays the slots in order; each stops the one before, as PlaySound does. */
  playAll(slots: readonly number[]): void {
    for (const s of slots) this.play(s);
  }

  play(slot: number): void {
    const url = uiSoundUrl(slot);
    const ctx = this.context();
    if (!url || !ctx) return;
    void ctx.resume();
    this.stop();
    const ticket = ++this.wanted;
    const buf = this.decoded.get(url);
    if (buf) {
      this.start(ctx, buf);
      return;
    }
    void this.fetchRaw(url).then(async (bytes) => {
      if (!bytes) return;
      try {
        const b = await ctx.decodeAudioData(bytes.slice(0));
        this.decoded.set(url, b);
        // Only the newest request plays: a later click already stopped this one.
        if (ticket === this.wanted) this.start(ctx, b);
      } catch {
        // An undecodable file is silence.
      }
    });
  }

  private start(ctx: Ctx, buf: AudioBuffer): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    this.current = src;
  }

  stop(): void {
    try {
      this.current?.stop();
    } catch {
      // already ended
    }
    this.current = null;
  }

  /**
   * Beep(400, 500): the controls screen's answer to a key it cannot name
   * (controls_dialog.c). A 400 Hz tone for half a second.
   */
  beep(hz = 400, ms = 500): void {
    const ctx = this.context();
    if (!ctx) return;
    void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = hz;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  }
}

/** One player for the whole client: the menu and the in-game dialog share it. */
export const uiSounds = new UiSounds();
