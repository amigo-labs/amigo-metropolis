// The tracks the arena's units play (fcop-fidelity.md G9; RE `cact_anim_step`,
// block.c 221-363). Every actor with an animated model starts its AnmD track 0
// at frame 0 when it is built (`cact_anim_init`) and steps it every tick by the
// delta its handler hands the step: the frame delta on the aircraft, turrets and
// mounts (the jet's rotor, Joke's wing beat, its Fortress and Sky Captain), and
// `velocity_84 * dt` on a type-5 or type-28 actor's mode-2 track (RE type5.c
// 469-472) — Joke's tank, whose legs walk with the ground it covers. (Joke's
// Dreadnought hull walks the same way, but its guns stand on the frame it
// shows, so its walk is the sim's since SIM_VERSION 85: render/arenaUnits.ts
// reads the frame off the gun snapshot.)
//
// The snapshot carries no velocity and no spawn tick, so the client keeps both
// per entity id: when it first drew the entity, and how far its interpolated
// position has moved since, frame to frame. The clock is the sim's own time (a
// paused match stops every track). Render-only: nothing here reaches the sim,
// and nothing allocates after construction.

import { MAX_ENTITIES } from "@metropolis/sim";
import type { UnitMorph } from "./arenaUnits.generated";

/** The engine clock a time-driven track's period is counted in (RE fcop/clock.h). */
const ENGINE_HZ = 300;
/** World units a metre: a distance-driven track's period (RE route_tick.c `travelled`). */
const WU_PER_M = 8192;
/**
 * A step longer than this between two frames is not travel: a respawn into a
 * reused id within one tick, or a teleport. A distance-driven track starts
 * over, as a new actor's would.
 */
const TELEPORT_M = 2;

/**
 * Per entity id, the client's copy of its actor's animation block: when it was
 * first drawn (the track starts at frame 0 there), and for a distance-driven
 * track the frame and the clock `cact_anim_step` keeps, stepped by the distance
 * travelled. Owned by the renderer; nothing here reaches the sim.
 */
export class TrackClock {
  /** Render frame each id was last drawn on; a gap means a new actor. */
  private readonly seen = new Uint32Array(MAX_ENTITIES);
  private readonly kind = new Int16Array(MAX_ENTITIES).fill(-1);
  private readonly born = new Float64Array(MAX_ENTITIES);
  private readonly last = new Float32Array(MAX_ENTITIES * 3);
  /** Distance-driven tracks: the frame, and world units into it. */
  private readonly frame = new Int16Array(MAX_ENTITIES);
  private readonly wu = new Float64Array(MAX_ENTITIES);
  /** The render frame (starts at 1, so a fresh id never looks seen). */
  private tick = 1;

  /** Seconds of sim time: the time-driven tracks' clock. */
  clock = 0;

  /** One render frame on: `simDtSec` of sim time passed. */
  advance(simDtSec: number): void {
    this.clock += simDtSec;
    this.tick++;
  }

  /**
   * The frame entity `id` (drawn as `archetype` at three-space x, y, z) shows
   * of `track` this render frame. Call once per entity per frame.
   */
  frameOf(
    id: number,
    archetype: number,
    track: UnitMorph,
    x: number,
    y: number,
    z: number,
  ): number {
    if (id < 0 || id >= MAX_ENTITIES) return 0;
    const o = id * 3;
    const dx = x - this.last[o];
    const dy = y - this.last[o + 1];
    const dz = z - this.last[o + 2];
    const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const fresh = this.seen[id] !== this.tick - 1 || this.kind[id] !== archetype;
    this.seen[id] = this.tick;
    this.kind[id] = archetype;
    this.last[o] = x;
    this.last[o + 1] = y;
    this.last[o + 2] = z;
    if (fresh) {
      // `cact_anim_init`: track 0 at its first frame, the clock at zero.
      this.born[id] = this.clock;
      this.frame[id] = 0;
      this.wu[id] = 0;
      return 0;
    }
    if (track.drivenBy === "time") {
      const ticks = (this.clock - this.born[id]) * ENGINE_HZ;
      return Math.floor(ticks / track.period) % track.frames;
    }
    if (step > TELEPORT_M) {
      this.frame[id] = 0;
      this.wu[id] = 0;
      return 0;
    }
    // `cact_anim_step`: the clock gains the step and a frame passes each time
    // it is past the period; the end links back to the first frame.
    let wu = this.wu[id] + step * WU_PER_M;
    let frame = this.frame[id];
    while (wu > track.period) {
      wu -= track.period;
      frame = frame + 1 >= track.frames ? 0 : frame + 1;
    }
    this.wu[id] = wu;
    this.frame[id] = frame;
    return frame;
  }
}
