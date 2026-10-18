// The original's weapon effects, drawn (Phase 14 wave 4).
//
// Every effect is one of the original's records (types 87..94), installed by
// the effect chain (effects/chain.ts) from the raise sites the sound cues
// already keep (audio/cues.ts: a shot's muzzle or launch, a line's or a
// round's impact, a death's class row, the mech's wreck and transform). This
// module is the chain's other listener: each install becomes an instance of
// its record's class, drawn the way the RE reads that class's drawer:
//
//   87 trail      render/fx/ribbons.ts   a camera-facing ribbon through its nodes
//   88 link       render/fx/ribbons.ts   jagged strands between two ends
//   89 flash      render/fx/flashes.ts   a disc fan or a spike star
//   90 shatter    render/fx/shatter.ts   the dying model's faces flying apart
//   92 shell      render/fx/shells.ts    an expanding ring or sphere
//   93 particle   render/fx/particles.ts a Cpyr particle at the record's colour
//   94 nodes      render/fx/nodes.ts     a burst of flat screen rectangles
//
// What the executable draws without a record comes from the sim's events
// here (`pump`): the tracers (the Laser's two, the Sky Captain's gun) and the
// Mini Gun's ribbon (tables.json exe). The world rounds whose Cobj is line
// facers (rows 1, 3 and 6) are drawn here too, from the entity pass (`bolt`).
//
// Everything runs on the sim's clock in the original's engine ticks (300 a
// second), so effects freeze with a paused sim. Pools are fixed-size and
// filled in place; nothing allocates once a match runs.

import {
  EV_SHOT,
  EVENT_STRIDE,
  type EventBuffer,
  MAX_ENTITIES,
  MUZZLE_HEIGHT,
  MUZZLE_OFFSET,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_SPECIAL,
  shotPayloadPowered,
  shotPayloadToReach,
  shotPayloadWeaponId,
  shotPayloadWeaponReach,
  weaponById,
} from "@metropolis/sim";
import * as THREE from "three";
import type { EffectChain, EffectListener, RaiseAt } from "../effects/chain";
import { FX_ARENAS } from "../effects/fcopEffects.generated";
import { ENGINE_HZ, type FxRecord } from "../effects/records";
import { type FxPoses, FxView, POSE_STRIDE } from "./fx/common";
import { Flashes } from "./fx/flashes";
import { Nodes } from "./fx/nodes";
import { PARTICLE_ATLAS_URL, Particles } from "./fx/particles";
import { Ribbons } from "./fx/ribbons";
import { Shatter, type ShatterSource } from "./fx/shatter";
import { Shells } from "./fx/shells";

export type { FxPoses } from "./fx/common";
export { POSE_STRIDE } from "./fx/common";

const TRAILS_ATLAS_URL = "/fx/trails.png";
/** The Mini Gun's code (`weapons.ts` 0x00) and the Laser's (0x01). */
const MINI_GUN = 0x00;
const LASER = 0x01;
/** The Mini Gun's byte is set by each shot and cleared when none comes: a sim tick and a frame. */
const RIBBON_HOLD = 15;

/**
 * Fills `out` with world pose `[x, height, z, yaw]` for the event, or returns
 * false when the event has no resolvable position (skip the effect).
 * Supplied by the host (main.ts) — same role as the audio position resolver.
 */
export type FxPoseResolver = (
  type: number,
  a: number,
  b: number,
  c: number,
  out: Float32Array,
) => boolean;

export interface FxOptions {
  /** The rendered pose of every entity this frame (main.ts's entity pass). */
  readonly poses?: FxPoses;
  /** The ground under (x, z), metres: the node and trail floor tests. */
  readonly ground?: (x: number, z: number) => number;
  /** A dying archetype's model, for the shatter. */
  readonly shatter?: ShatterSource;
  /** The drawing buffer's height in device pixels (the 640x480 rects scale to it). */
  readonly viewportHeight?: () => number;
}

export interface ShotFx {
  /** The executable's own drawings off this tick's events (tracers, the ribbon). */
  pump(events: EventBuffer, resolve: FxPoseResolver): void;
  /**
   * A world round of `row` drawn this frame at (x, y, z) metres, heading `yaw`
   * and climbing at `pitch` radians: its Cobj's line facers. False when the
   * row's round is a model instead (the caller draws its bucket).
   */
  bolt(row: number, x: number, y: number, z: number, yaw: number, pitch: number): boolean;
  /**
   * Age live effects and rewrite their buffers (once per frame). `simDtSec`
   * is how far the sim moved this frame: the effects run on the sim's clock.
   * Without it they fall back to the frame's own delta.
   */
  update(dtSec: number, camera?: THREE.Camera, simDtSec?: number): void;
  /** A new match on `mapId`: its trail texels, nothing in flight. */
  begin(mapId: string): void;
  /** Drop every live effect immediately (match teardown). */
  reset(): void;
  /** Live instances per class (tests and the debug HUD). */
  debugCounts(): {
    flashes: number;
    shells: number;
    particles: number;
    nodes: number;
    trails: number;
    links: number;
    tracers: number;
    ribbons: number;
    /** Bolts the last frame drew. */
    bolts: number;
    shatter: number;
  };
  /** True once the original's particle atlas is bound. */
  readonly atlasReady: boolean;
}

const pose = new Float32Array(5);

export function createFx(scene: THREE.Scene, chain: EffectChain, options: FxOptions = {}): ShotFx {
  const flashes = new Flashes(scene);
  const shells = new Shells(scene);
  const particles = new Particles(scene);
  const nodes = new Nodes(scene);
  const ribbons = new Ribbons(scene);
  const shatter = new Shatter(scene);
  const view = new FxView();
  const poses = options.poses ?? null;
  if (options.ground) {
    nodes.groundAt = options.ground;
    ribbons.groundAt = options.ground;
  }
  if (options.shatter) shatter.source = options.shatter;

  const listener: EffectListener = {
    install(bank: number, id: number, rec: FxRecord | undefined, at: Readonly<RaiseAt>): void {
      void bank;
      void id;
      if (!rec) return;
      switch (rec.type) {
        case 87:
          ribbons.trail(bank, id, rec, at, at.hold);
          return;
        case 88:
          ribbons.link(rec, at);
          return;
        case 89:
          flashes.spawn(rec, at);
          return;
        case 90:
          shatter.spawn(rec, at);
          return;
        case 92:
          shells.spawn(rec, at);
          return;
        case 93:
          particles.spawn(rec, at);
          return;
        case 94:
          nodes.burst(rec, at);
          return;
        default:
          return;
      }
    },
    hold(bank: number, id: number, attach: number, ticks: number): void {
      ribbons.hold(bank, id, attach, ticks);
    },
    rebind(token: number, entity: number): void {
      flashes.rebind(token, entity);
      shells.rebind(token, entity);
      particles.rebind(token, entity);
      ribbons.rebind(token, entity);
    },
  };
  chain.addListener(listener);

  if (typeof document !== "undefined") {
    const loader = new THREE.TextureLoader();
    loader.load(PARTICLE_ATLAS_URL, (t) => particles.setAtlas(t));
    loader.load(TRAILS_ATLAS_URL, (t) => ribbons.setAtlas(t));
  }

  function pump(events: EventBuffer, resolve: FxPoseResolver): void {
    const data = events.data;
    for (let i = 0; i < events.count; i++) {
      const o = i * EVENT_STRIDE;
      if (data[o] !== EV_SHOT) continue;
      const shooter = data[o + 1];
      const slot = data[o + 2];
      const c = data[o + 3];
      if (!resolve(EV_SHOT, shooter, slot, c, pose)) continue;
      const yaw = pose[3];
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const mx = pose[0] + cos * MUZZLE_OFFSET;
      const my = pose[1] + MUZZLE_HEIGHT;
      const mz = pose[2] + sin * MUZZLE_OFFSET;
      if (slot <= SHOT_SLOT_SPECIAL) {
        const w = weaponById(shotPayloadWeaponId(c));
        if (!w) continue;
        if (w.code === MINI_GUN) {
          ribbons.ribbon(shooter, mx, my, mz, yaw, RIBBON_HOLD);
        } else if (w.code === LASER) {
          // DAT_0048c854 / 0048c858: block B red, block A green.
          const reach = shotPayloadWeaponReach(c) || w.range;
          ribbons.tracer(
            shotPayloadPowered(c) ? "laserB" : "laserA",
            mx,
            my,
            mz,
            mx + cos * reach,
            my,
            mz + sin * reach,
          );
        }
      } else if (slot === SHOT_SLOT_HITSCAN) {
        // The world hitscan (row 7, the Sky Captain's gun): its tracer.
        const reach = shotPayloadToReach(c);
        ribbons.tracer("world", mx, my, mz, mx + cos * reach, my, mz + sin * reach);
      }
    }
  }

  function update(dtSec: number, camera?: THREE.Camera, simDtSec?: number): void {
    const dt = Math.max(0, (simDtSec ?? dtSec) * ENGINE_HZ);
    view.set(camera, options.viewportHeight ? options.viewportHeight() : 480);
    flashes.update(dt, poses, view);
    shells.update(dt, poses, view);
    particles.update(dt, poses, view);
    ribbons.update(dt, poses, view, particles, MUZZLE_OFFSET, MUZZLE_HEIGHT);
    particles.flush();
    nodes.update(dt, poses, view);
    shatter.update(dt);
  }

  function reset(): void {
    flashes.reset();
    shells.reset();
    particles.reset();
    nodes.reset();
    ribbons.reset();
    shatter.reset();
  }

  function bolt(row: number, x: number, y: number, z: number, yaw: number, pitch: number): boolean {
    const c = Math.cos(pitch);
    return ribbons.bolt(row, x, y, z, Math.cos(yaw) * c, Math.sin(pitch), Math.sin(yaw) * c);
  }

  return {
    pump,
    bolt,
    update,
    reset,
    begin(mapId: string): void {
      reset();
      ribbons.setTrailRow(FX_ARENAS[mapId]?.trailRow ?? FX_ARENAS["la-cantina"]?.trailRow ?? 0);
    },
    get atlasReady() {
      return particles.atlasReady;
    },
    debugCounts: () => {
      const r = ribbons.counts();
      return {
        flashes: flashes.count,
        shells: shells.count,
        particles: particles.count,
        nodes: nodes.count,
        trails: r.trails,
        links: r.links,
        tracers: r.tracers,
        ribbons: r.ribbons,
        bolts: r.bolts,
        shatter: shatter.faces(),
      };
    },
  };
}

/** The pose table main.ts fills for the effects that ride an entity. */
export function createFxPoses(): FxPoses {
  return {
    table: new Float32Array(MAX_ENTITIES * POSE_STRIDE),
    live: new Uint8Array(MAX_ENTITIES),
  };
}
