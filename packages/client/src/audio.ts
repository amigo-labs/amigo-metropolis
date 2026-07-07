// Audio stub (PLAN Phase 2): drains the sim's per-tick event ring buffer and
// resolves every event to a named cue. Real playback (jsfxr) lands in Phase 7
// — until then the stub counts cues and remembers the latest one so the debug
// HUD can prove the event pipe works end to end. Call pump() after EVERY
// step(): events are transient and cleared on the next tick.

import {
  EV_BREACH,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_PURCHASE,
  EV_RESPAWN,
  EV_SHOT,
  EVENT_STRIDE,
  type EventBuffer,
} from "@metropolis/sim";

const cues: string[] = [];
cues[EV_SHOT] = "shot";
cues[EV_EXPLOSION] = "explosion";
cues[EV_HIT] = "hit";
cues[EV_DEATH] = "death";
cues[EV_RESPAWN] = "respawn";
cues[EV_PURCHASE] = "purchase";
cues[EV_BREACH] = "breach";

export class AudioStub {
  /** Total cues seen, indexed by event type. */
  readonly counts = new Uint32Array(cues.length);
  /** Most recent non-shot cue (shots fire constantly and would drown it). */
  lastCue = "";

  pump(events: EventBuffer): void {
    for (let i = 0; i < events.count; i++) {
      const type = events.data[i * EVENT_STRIDE];
      if (type <= 0 || type >= this.counts.length) continue;
      this.counts[type] += 1;
      if (type !== EV_SHOT) this.lastCue = cues[type];
      // Phase 7: trigger jsfxr playback for cues[type] here.
    }
  }
}
