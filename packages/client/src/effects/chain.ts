// The original's effect install and its instance timers: one scheduler that
// both the sound and the picture of every effect hang off.
//
// In the original an effect is one call, `cact_effect_install` (0x0042d020):
// it plays the record's sound (+0x16), builds the class instance that draws
// it, raises the successor at once when the spawn delay is zero, and leaves
// the instance's timers (`cact_effect_instance_timers` 0x0042dbd0, run every
// frame) to publish the successor after +0x24, or with +0x32 bit 11 when the
// repeats run out, and to re-raise the record's own id every repeat period as
// a one-shot. An install with no viewport within 0x20000 is dropped whole.
//
// So the chain is walked once here and every listener — the sound cues, the
// renderer — is told about each install. Nothing in it is random and nothing
// in it reaches the sim. Times are in engine ticks (1/300 s); one sim tick is
// ten of them, the original's own frame step at 30 frames a second, so a
// repeat period under ten ticks repeats once a sim tick, as the original's
// timer does once a frame.
//
// The timers outlive the picture: an instance whose lifetime ends with repeats
// or a spawn delay left is parked — not drawn — until they are done
// (`cact_effect_instance_tick` 0x0042daf0), so a chain is never cut short by
// its own record's lifetime.

import { FX_ARENAS, FX_RECORDS } from "./fcopEffects.generated";
import {
  ENGINE_TICKS_PER_SIM_TICK,
  FXF_DIE_WITH_REFERENCE,
  FXF_SUCCESSOR_AT_REPEAT_END,
  type FxArena,
  type FxRecord,
} from "./records";
import { RoundTracker } from "./rounds";

/** Where and how a raise happens: the original's placement context, in the client's frame. */
export interface RaiseAt {
  /** Three's frame, metres: x, height, z (= the sim's x, height, y). */
  x: number;
  y: number;
  z: number;
  /** The raiser's facing or the line's direction, sim yaw in radians. */
  yaw: number;
  /**
   * The entity the effect rides (it follows it), -1 none. Below -1: the round
   * a shot is about to launch, `ROUND_TOKEN - n` for launch n of this tick,
   * until `rebind` names the entity.
   */
  attach: number;
  /**
   * The raise point in the attached entity's frame: metres along its facing
   * and up. A record that follows its reference (+0x32 bit 8) is drawn there.
   */
  attachForward: number;
  attachUp: number;
  /** A context scale (the impact's 0x80), 0 for the record's own field. */
  scale: number;
  /** The raiser's scale, x16: an actor's radius >> 4, 0x100 for none. */
  raiserScale: number;
  /** The far end of a link (type 88), metres; NaN for none (scattered). */
  endX: number;
  endY: number;
  endZ: number;
  /** The raiser's archetype (what a shatter breaks), -1 none. */
  archetype: number;
  /** A re-raise of the record's own id by its repeats: a one-shot. */
  repeat: boolean;
}

export function makeRaiseAt(): RaiseAt {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    attach: -1,
    attachForward: 0,
    attachUp: 0,
    scale: 0,
    raiserScale: 0x100,
    endX: Number.NaN,
    endY: Number.NaN,
    endZ: Number.NaN,
    archetype: -1,
    repeat: false,
  };
}

export function copyRaiseAt(from: Readonly<RaiseAt>, to: RaiseAt): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.yaw = from.yaw;
  to.attach = from.attach;
  to.attachForward = from.attachForward;
  to.attachUp = from.attachUp;
  to.scale = from.scale;
  to.raiserScale = from.raiserScale;
  to.endX = from.endX;
  to.endY = from.endY;
  to.endZ = from.endZ;
  to.archetype = from.archetype;
  to.repeat = from.repeat;
}

/** The effect banks of the arena whose mission is `mission` (e.g. "Mp"), or null. */
export function fxArenaFor(mission: string): FxArena | null {
  for (const arena of Object.values(FX_ARENAS)) if (arena.mission === mission) return arena;
  return null;
}

export { ROUND_TOKEN } from "./rounds";

export interface EffectListener {
  /**
   * One install of (bank, id). `rec` is the record, undefined for a slot the
   * arena leaves empty. `at` is only valid during the call.
   */
  install(bank: number, id: number, rec: FxRecord | undefined, at: Readonly<RaiseAt>): void;
  /**
   * A sustained weapon fired again while its effect lives (the sustain's
   * refresh, `sustain_attached_find` / `sustain_aimed_find`): the instance of
   * (bank, id) riding `attach` is held for `ticks` more engine ticks.
   */
  hold?(bank: number, id: number, attach: number, ticks: number): void;
  /** A launch's round is known (`entity`), or never came (-1). */
  rebind?(token: number, entity: number): void;
}

/** Timers waiting at once: a chain's successors and repeats. */
export const MAX_TIMERS = 256;
/** A successor chain installed at once can recurse; the deepest shipped is 7. */
const MAX_DEPTH = 16;

export class EffectChain {
  private arena: FxArena | null = null;
  private readonly listeners: EffectListener[] = [];
  /** The install's viewport test (0x0042d0ab): false drops the install whole. */
  gate: ((x: number, z: number) => boolean) | null = null;
  /**
   * Re-reads an attached raise's position when a timer publishes: the child
   * inherits the instance's placement, which rides its reference. False when
   * the entity is gone.
   */
  locate: ((entity: number, at: RaiseAt) => boolean) | null = null;

  // --- the timers, structure of arrays ---
  private readonly live = new Uint8Array(MAX_TIMERS);
  private readonly bank = new Uint8Array(MAX_TIMERS);
  private readonly id = new Uint16Array(MAX_TIMERS);
  private readonly next = new Uint16Array(MAX_TIMERS);
  private readonly delayLeft = new Float64Array(MAX_TIMERS);
  private readonly atEnd = new Uint8Array(MAX_TIMERS);
  private readonly spent = new Uint8Array(MAX_TIMERS);
  private readonly repeats = new Int16Array(MAX_TIMERS);
  private readonly period = new Float64Array(MAX_TIMERS);
  private readonly periodLeft = new Float64Array(MAX_TIMERS);
  private readonly rearm = new Uint8Array(MAX_TIMERS);
  private readonly dieWithRef = new Uint8Array(MAX_TIMERS);
  /** The pass a timer was made in: one made during a pass waits for the next. */
  private readonly born = new Uint32Array(MAX_TIMERS);
  private pass = 0;
  private readonly where: RaiseAt[] = [];
  /** The raise a timer publishes, filled from its slot. */
  private readonly publish = makeRaiseAt();
  /** A re-raise's at-once successor, which is no repeat itself. */
  private readonly child = makeRaiseAt();
  /** The rounds the launches ride (effects/rounds.ts). */
  readonly rounds = new RoundTracker();

  constructor() {
    for (let i = 0; i < MAX_TIMERS; i++) this.where.push(makeRaiseAt());
    this.rounds.addListener((token, entity) => this.rebind(token, entity));
  }

  addListener(l: EffectListener): void {
    if (!this.listeners.includes(l)) this.listeners.push(l);
  }

  /** A new match on `arena`'s records (null: nothing installs). Drops every timer. */
  begin(arena: FxArena | null): void {
    this.arena = arena;
    this.reset();
  }

  reset(): void {
    this.live.fill(0);
    this.rounds.reset();
  }

  /** The sustain's refresh, passed to every listener that keeps instances. */
  hold(bank: number, id: number, attach: number, ticks: number): void {
    for (let i = 0; i < this.listeners.length; i++)
      this.listeners[i].hold?.(bank, id, attach, ticks);
  }

  /** The record (bank, id) names on this arena, if any. */
  record(bank: number, id: number): FxRecord | undefined {
    const index = this.arena?.banks[bank === 1 ? 1 : 0][id];
    return index === undefined ? undefined : FX_RECORDS[index];
  }

  /** Live timers (tests). */
  pending(): number {
    let n = 0;
    for (let i = 0; i < MAX_TIMERS; i++) n += this.live[i];
    return n;
  }

  /**
   * `cact_effect_install`: the install, the successor at once when its delay
   * is zero (inside the install, 0x0042d5dc), and a timer for a delayed
   * successor and the repeats. `oneShot` is what the timers make of a child
   * raised from the record's own id (0x0042db5d): it keeps the install and an
   * at-once successor, and loses its timers — no delayed successor, no
   * repeats.
   */
  raise(bank: number, id: number, at: Readonly<RaiseAt>, oneShot = false, depth = 0): void {
    if (id <= 0 || depth > MAX_DEPTH) return;
    if (this.gate && !this.gate(at.x, at.z)) return;
    const rec = this.record(bank, id);
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i].install(bank, id, rec, at);
    if (!rec) return;

    const atEnd = (rec.flags & FXF_SUCCESSOR_AT_REPEAT_END) !== 0;
    const repeats = rec.repeats > 0 && rec.period > 0;
    let waiting = 0;
    if (rec.next > 0) {
      if (!atEnd && rec.delay <= 0) {
        // The successor is a new install with timers of its own, whatever
        // this one becomes.
        if (at.repeat) {
          copyRaiseAt(at, this.child);
          this.child.repeat = false;
          this.raise(bank, rec.next, this.child, false, depth + 1);
        } else {
          this.raise(bank, rec.next, at, false, depth + 1);
        }
      } else if (!atEnd || repeats) {
        waiting = rec.next;
      }
    }
    if (oneShot || (waiting === 0 && !repeats)) return;
    const t = this.free();
    if (t < 0) return;
    this.live[t] = 1;
    this.bank[t] = bank;
    this.id[t] = id;
    this.next[t] = waiting;
    this.atEnd[t] = atEnd ? 1 : 0;
    this.delayLeft[t] = atEnd || waiting === 0 ? -1 : rec.delay;
    this.spent[t] = 0;
    this.repeats[t] = repeats ? rec.repeats : -1;
    this.period[t] = repeats ? rec.period : 0;
    this.periodLeft[t] = this.period[t];
    this.rearm[t] = 0;
    this.dieWithRef[t] = (rec.flags & FXF_DIE_WITH_REFERENCE) !== 0 ? 1 : 0;
    this.born[t] = this.pass;
    copyRaiseAt(at, this.where[t]);
    this.where[t].repeat = false;
  }

  /** One sim tick of every timer, in `cact_effect_instance_timers`' order. */
  tick(): void {
    const dt = ENGINE_TICKS_PER_SIM_TICK;
    this.pass++;
    for (let t = 0; t < MAX_TIMERS; t++) {
      if (this.live[t] === 0 || this.born[t] === this.pass) continue;
      let out = 0;
      let fromRecord = false;
      // The spawn delay.
      if (this.atEnd[t] === 0 && this.spent[t] === 0 && this.delayLeft[t] >= 0) {
        this.delayLeft[t] -= dt;
        if (this.delayLeft[t] <= 0) {
          out = this.next[t];
          this.spent[t] = 1;
        }
      }
      // The re-arm a repeat period left: the record's own id, as a one-shot.
      if (this.rearm[t] !== 0 && out === 0) {
        out = this.id[t];
        fromRecord = true;
        this.rearm[t] = 0;
      }
      // The repeat period.
      if (this.periodLeft[t] > 0) {
        this.periodLeft[t] -= dt;
        if (this.periodLeft[t] <= 0) {
          this.periodLeft[t] = this.period[t];
          if (this.repeats[t] > 0) {
            this.repeats[t]--;
            if (this.repeats[t] === 0) {
              this.repeats[t] = -1;
              this.periodLeft[t] = 0;
              if (this.atEnd[t] !== 0) {
                // Retail leaves `from_record` as the re-arm above set it: a
                // successor published on a re-arm pass is made a one-shot.
                out = this.next[t];
                this.spent[t] = 1;
              }
            }
          }
          if (this.repeats[t] >= 0) this.rearm[t] = 1;
        }
      }

      const where = this.where[t];
      if (out > 0) {
        copyRaiseAt(where, this.publish);
        // A repeat is the record's own id; a quirk's one-shot successor is an
        // install like any other.
        this.publish.repeat = fromRecord && out === this.id[t];
        let gone = false;
        if (where.attach >= 0 && this.locate && !this.locate(where.attach, this.publish)) {
          // The reference left: the instance stops, or retires with bit 12.
          where.attach = -1;
          this.publish.attach = -1;
          gone = true;
        }
        if (!(gone && this.dieWithRef[t] !== 0)) {
          // Successors follow the reference's current place from here on.
          where.x = this.publish.x;
          where.y = this.publish.y;
          where.z = this.publish.z;
          where.yaw = this.publish.yaw;
          this.raise(this.bank[t], out, this.publish, fromRecord);
        }
        if (gone && this.dieWithRef[t] !== 0) this.live[t] = 0;
      }
      const delayDone = this.atEnd[t] !== 0 || this.spent[t] !== 0 || this.delayLeft[t] < 0;
      const repeatsDone = this.repeats[t] < 0 && this.rearm[t] === 0;
      if (delayDone && repeatsDone) this.live[t] = 0;
    }
  }

  /** A launch's round is known: every timer riding the token rides the round. */
  rebind(token: number, entity: number): void {
    for (let t = 0; t < MAX_TIMERS; t++) {
      if (this.live[t] !== 0 && this.where[t].attach === token) this.where[t].attach = entity;
    }
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i].rebind?.(token, entity);
  }

  private free(): number {
    for (let t = 0; t < MAX_TIMERS; t++) if (this.live[t] === 0) return t;
    return -1;
  }
}
