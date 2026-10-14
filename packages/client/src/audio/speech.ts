// The original's speech queue: a ring of eight voice lines, one on the air at a
// time, transcribed from src/game/snd/voice.c in the RE repo.
//
// Two ways in, the Cfun voice ops: `queue` (op 0x0c, `cfun_voice_play`
// 0x00416f10) appends at the back and drops the line when the ring is full;
// `interrupt` (op 0x0d, `cfun_voice_stop` 0x00416f60) stops the line that is
// speaking and puts the new one in front. The pump (0x004170f0) runs once a
// frame: with a line on the air it does nothing, otherwise it pops the front
// and starts it — unless that id is the line it last started, which it retires
// without playing. So the same line never plays twice in a row.
//
// Pure bookkeeping; audio/engine.ts plays and stops the lines.

export const VOICE_SLOTS = 8;

export class SpeechQueue {
  private readonly ids = new Int16Array(VOICE_SLOTS);
  private count = 0;
  private front = 0;
  /** DAT_004a0400: the id the pump last started, -1 before the first. */
  private lastStarted = -1;
  /** A line is on the air. */
  speaking = false;

  reset(): void {
    this.count = 0;
    this.front = 0;
    this.lastStarted = -1;
    this.speaking = false;
  }

  /** Lines waiting. */
  get pending(): number {
    return this.count;
  }

  /** Op 0x0c: append; a full ring drops the line. */
  queue(id: number): void {
    if (this.count >= VOICE_SLOTS) return;
    this.ids[(this.front + this.count) & (VOICE_SLOTS - 1)] = id;
    this.count++;
  }

  /**
   * Op 0x0d. On an idle queue the same as `queue`. Otherwise the line on the
   * air is stopped (the caller is told through the return value) and the new
   * one goes in front; a full ring overwrites the old front instead of growing.
   * Returns true when the line on the air must be stopped now.
   */
  interrupt(id: number): boolean {
    if (this.count <= 0 && !this.speaking) {
      this.queue(id);
      return false;
    }
    const stop = this.speaking;
    this.speaking = false;
    const slot = this.front - 1 < 0 ? VOICE_SLOTS - 1 : this.front - 1;
    this.ids[slot] = id;
    this.front = slot;
    if (this.count < VOICE_SLOTS) this.count++;
    return stop;
  }

  /**
   * Once a frame. Returns the id to start now, or -1 (nothing, or a repeat of
   * the last line retired unplayed).
   */
  pump(): number {
    if (this.count <= 0 || this.speaking) return -1;
    const id = this.ids[this.front];
    const start = id !== this.lastStarted;
    if (start) {
      this.lastStarted = id;
      this.speaking = true;
    }
    this.count--;
    this.front = (this.front + 1) & (VOICE_SLOTS - 1);
    return start ? id : -1;
  }

  /** The line on the air finished (or was stopped). */
  lineEnded(): void {
    this.speaking = false;
  }
}
