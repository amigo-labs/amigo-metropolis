// The original's live list, as the registry walks it (fcop-fidelity.md V3).
//
// `cact_link` (RE game/actor/factory.c 0x0043ad70) appends every new actor at
// the tail, so the live list is in creation order, oldest first, and
// `cact_registry_build` (0x0043b520) / `cact_registry_build_mp` (0x0043b7a0)
// walk it from the head. Metropolis rebuilds that order on the client:
//
//   - the actors the mission loads come first, in container order
//     (gen:presentation `loadActors`): each X1-Alpha behind its partner, the
//     type-14 and type-35 actors, the lifts, the type-11 records (standing by
//     their outposts' claims) and the Sky Captain of the level's band;
//   - then everything made since, in the order it first appeared: the
//     entities, the standing pickups and the type-11 actors a script spawns.
//     A turret brings its base part in front of it (`turret_construct`
//     0x0041bf90), a Dreadnought its mounts (`cact_handler_type28`).
//
// Each candidate carries its position (NaN when it is not alive), whether the
// registry may cull it (`noCull`: flag 8, which the X1 and its partner, every
// unit, every turret and every round carry) and what it is, so the radar can
// draw the members in registry order.
//
// What the client cannot see is ordered as follows: actors that appear on the
// same frame are appended by entity id, then pickup, then placement; an id the
// sim recycles between two frames into the same archetype keeps its place; an
// X1 or Sky Captain that is down keeps its place and its last position (the
// original's mech is the same actor through its respawn).
//
// Typed arrays, no allocation per frame.

import {
  ARCHETYPE,
  MATCH_PICKUPS,
  MATCH_WARDEN_DIFFICULTY,
  MAX_ENTITIES,
  SNAPSHOT_STRIDE,
  TURRET_CAPTURABLE,
  wardenLevel,
} from "@metropolis/sim";
import type { ArenaPresentation, SpawnedActors } from "../fcopPresentation.generated";
import { sideOfTeam } from "../sides";

/** A candidate with nothing to draw: a partner, a part, a mount, a fixed actor. */
export const LIVE_OTHER = 0;
/** An entity: `ref` is its snapshot index. */
export const LIVE_ENTITY = 1;
/** A standing pickup: `ref` is its index in the map's pickups. */
export const LIVE_PICKUP = 2;
/** A type-11 actor: `ref` is its scenery placement's index. */
export const LIVE_PLACED = 3;

/** The original's pickups live in one 24-bit word (MATCH_PICKUPS). */
const MAX_PICKUPS = 24;

/** This frame's registry candidates, in live-list order. */
export interface LiveCandidates {
  n: number;
  /** Map frame metres; NaN for a candidate that is not alive this frame. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** 1: never culled (flag 8). */
  readonly noCull: Uint8Array;
  readonly kind: Uint8Array;
  readonly ref: Int32Array;
}

export interface LiveList {
  readonly out: LiveCandidates;
  /**
   * Brings the order up to this frame and writes the candidates. `stands[j]` is
   * 1 while placement j stands (its outpost's claim decides).
   */
  build(match: Float32Array, snapshot: Float32Array, count: number, stands: Uint8Array): void;
}

/** A spawned unit's share when an arena brings no table (the debug maps). */
export const NO_SPAWNED: SpawnedActors = {
  noCull: {
    tank: false,
    jet: false,
    fortress: false,
    dreadnought: false,
    turret: false,
    neutralTurret: false,
    pickup: false,
  },
  turretParts: 0,
  dreadnoughtMounts: 0,
};

/** Whether an entity of `archetype` (snapshot aux `aux`) is never culled. */
export function entityNoCull(spawned: SpawnedActors, archetype: number, aux: number): boolean {
  switch (archetype) {
    case ARCHETYPE.AVATAR: // PLAYER_FLAGS_BOTH, player.c 0x00446b44
    case ARCHETYPE.WARDEN: // its type-37 records carry it
    case ARCHETYPE.PROJECTILE: // the round spawners' `or al, 8` (0x0044d099)
      return true;
    case ARCHETYPE.RUNNER:
      return spawned.noCull.tank;
    case ARCHETYPE.GUARDIAN:
      return spawned.noCull.jet;
    case ARCHETYPE.FORTRESS:
      return spawned.noCull.fortress;
    case ARCHETYPE.JUGGERNAUT:
      return spawned.noCull.dreadnought;
    case ARCHETYPE.TURRET:
      return aux === TURRET_CAPTURABLE ? spawned.noCull.neutralTurret : spawned.noCull.turret;
    default:
      return false;
  }
}

/** How many actors an entity's construct builds in front of it. */
export function subActorsOf(spawned: SpawnedActors, archetype: number): number {
  if (archetype === ARCHETYPE.TURRET) return spawned.turretParts;
  if (archetype === ARCHETYPE.JUGGERNAUT) return spawned.dreadnoughtMounts;
  return 0;
}

const KIND_X1 = 1;
const KIND_PARTNER = 2;
const KIND_CAPTAIN = 3;
const KIND_PLACED = 4;
const KIND_FIXED = 5;
const KIND_CODE = {
  x1: KIND_X1,
  partner: KIND_PARTNER,
  captain: KIND_CAPTAIN,
  placed: KIND_PLACED,
  fixed: KIND_FIXED,
};

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The live list of an arena. `placements` are its scenery placements (their
 * `record` names), `pickups` the map's pickups in MATCH_PICKUPS bit order.
 */
export function createLiveList(
  mapId: string,
  arena: ArenaPresentation,
  placements: readonly (Point & { readonly record: string })[],
  pickups: readonly Point[],
): LiveList {
  const load = arena.loadActors;
  const spawned = arena.spawned;
  const nPickups = pickups.length < MAX_PICKUPS ? pickups.length : MAX_PICKUPS;
  const nPlaced = placements.length;

  // The load list's bindings: an X1 (and its partner) to the avatar of its side,
  // the Sky Captain of the level's band to the warden, a type-11 record to its
  // placement.
  const kind = Uint8Array.from(load, (a) => KIND_CODE[a.kind]);
  const side = Int8Array.from(load, (a) => a.side ?? 0);
  const band = Int32Array.from(load, (a) => (a.levels ?? []).reduce((m, l) => m | (1 << l), 0));
  const loadPlacement = Int32Array.from(load, (a) =>
    a.kind === "placed" ? placements.findIndex((p) => p.record === a.record) : -1,
  );
  const loadedPlacement = new Uint8Array(nPlaced);
  for (let k = 0; k < load.length; k++) {
    if (loadPlacement[k] >= 0) loadedPlacement[loadPlacement[k]] = 1;
  }
  const bindsAvatar = load.some((a) => a.kind === "x1");
  const bindsWarden = load.some((a) => a.kind === "captain");
  const bindsConsole = load.some((a) => a.kind === "placed");
  /** Where each bound actor was last seen: it keeps its place while down. */
  const boundX = Float64Array.from(load, (a) => a.x);
  const boundY = Float64Array.from(load, (a) => a.y);
  const boundSeen = new Uint8Array(load.length);
  const boundIndex = new Int32Array(load.length);

  // The runtime slots: entity ids, then pickups, then spawned placements.
  const PICKUP0 = MAX_ENTITIES;
  const PLACED0 = MAX_ENTITIES + nPickups;
  const slots = PLACED0 + nPlaced;
  const next = new Int32Array(slots).fill(-1);
  const prev = new Int32Array(slots).fill(-1);
  const linked = new Uint8Array(slots);
  /** The archetype each linked entity slot was appended with. */
  const linkedArch = new Int16Array(MAX_ENTITIES).fill(-1);
  const present = new Uint8Array(slots);
  const arch = new Int16Array(MAX_ENTITIES).fill(-1);
  const index = new Int32Array(MAX_ENTITIES).fill(-1);
  let head = -1;
  let tail = -1;

  function unlink(s: number): void {
    const p = prev[s];
    const q = next[s];
    if (p >= 0) next[p] = q;
    else head = q;
    if (q >= 0) prev[q] = p;
    else tail = p;
    next[s] = -1;
    prev[s] = -1;
    linked[s] = 0;
  }
  function append(s: number): void {
    prev[s] = tail;
    next[s] = -1;
    if (tail >= 0) next[tail] = s;
    else head = s;
    tail = s;
    linked[s] = 1;
  }

  const most = 1 + Math.max(spawned.turretParts, spawned.dreadnoughtMounts);
  const cap = load.length + MAX_ENTITIES * most + nPickups + nPlaced;
  const out: LiveCandidates = {
    n: 0,
    x: new Float64Array(cap),
    y: new Float64Array(cap),
    noCull: new Uint8Array(cap),
    kind: new Uint8Array(cap),
    ref: new Int32Array(cap),
  };
  function put(x: number, y: number, noCull: boolean, what: number, ref: number): void {
    const n = out.n;
    out.x[n] = x;
    out.y[n] = y;
    out.noCull[n] = noCull ? 1 : 0;
    out.kind[n] = what;
    out.ref[n] = ref;
    out.n = n + 1;
  }
  function bind(k: number, i: number, snapshot: Float32Array): void {
    boundIndex[k] = i;
    boundSeen[k] = 1;
    boundX[k] = snapshot[i * SNAPSHOT_STRIDE + 3];
    boundY[k] = snapshot[i * SNAPSHOT_STRIDE + 4];
  }

  return {
    out,
    build(match, snapshot, count, stands) {
      // --- what lives this frame.
      present.fill(0);
      boundIndex.fill(-1);
      const level = wardenLevel(match[MATCH_WARDEN_DIFFICULTY]);
      for (let i = 0; i < count; i++) {
        const o = i * SNAPSHOT_STRIDE;
        const a = snapshot[o + 1];
        if (a === ARCHETYPE.AVATAR && bindsAvatar) {
          const s = sideOfTeam(mapId, snapshot[o + 2]);
          for (let k = 0; k < load.length; k++) {
            if ((kind[k] === KIND_X1 || kind[k] === KIND_PARTNER) && side[k] === s)
              bind(k, i, snapshot);
          }
          continue;
        }
        if (a === ARCHETYPE.WARDEN && bindsWarden) {
          for (let k = 0; k < load.length; k++) {
            if (kind[k] === KIND_CAPTAIN && ((band[k] >> level) & 1) === 1) bind(k, i, snapshot);
          }
          continue;
        }
        // A console is its outpost's type-11 record, loaded with the mission.
        if (a === ARCHETYPE.CONSOLE && bindsConsole) continue;
        const id = snapshot[o];
        present[id] = 1;
        arch[id] = a;
        index[id] = i;
      }
      const up = match[MATCH_PICKUPS] | 0;
      for (let k = 0; k < nPickups; k++) present[PICKUP0 + k] = (up >> k) & 1;
      for (let j = 0; j < nPlaced; j++) {
        if (loadedPlacement[j] === 0) present[PLACED0 + j] = stands[j];
      }

      // --- the dead leave; a recycled id of another archetype is a new actor.
      for (let s = head; s >= 0; ) {
        const q = next[s];
        if (present[s] === 0 || (s < MAX_ENTITIES && arch[s] !== linkedArch[s])) unlink(s);
        s = q;
      }
      // --- the new join at the tail.
      for (let s = 0; s < slots; s++) {
        if (present[s] === 0 || linked[s] === 1) continue;
        append(s);
        if (s < MAX_ENTITIES) linkedArch[s] = arch[s];
      }

      // --- the candidates, from the head.
      out.n = 0;
      for (let k = 0; k < load.length; k++) {
        const nc = load[k].noCull;
        switch (kind[k]) {
          case KIND_X1:
          case KIND_PARTNER:
            if (boundSeen[k] === 0) break;
            put(
              boundX[k],
              boundY[k],
              nc,
              kind[k] === KIND_X1 && boundIndex[k] >= 0 ? LIVE_ENTITY : LIVE_OTHER,
              boundIndex[k],
            );
            break;
          case KIND_CAPTAIN:
            if (boundSeen[k] === 0 || ((band[k] >> level) & 1) === 0) break;
            put(
              boundX[k],
              boundY[k],
              nc,
              boundIndex[k] >= 0 ? LIVE_ENTITY : LIVE_OTHER,
              boundIndex[k],
            );
            break;
          case KIND_PLACED: {
            const j = loadPlacement[k];
            put(j >= 0 && stands[j] === 1 ? load[k].x : Number.NaN, load[k].y, nc, LIVE_PLACED, j);
            break;
          }
          default:
            put(load[k].x, load[k].y, nc, LIVE_OTHER, -1);
        }
      }
      for (let s = head; s >= 0; s = next[s]) {
        if (s >= PLACED0) {
          const j = s - PLACED0;
          put(placements[j].x, placements[j].y, false, LIVE_PLACED, j);
          continue;
        }
        if (s >= PICKUP0) {
          const k = s - PICKUP0;
          put(pickups[k].x, pickups[k].y, spawned.noCull.pickup, LIVE_PICKUP, k);
          continue;
        }
        const i = index[s];
        const o = i * SNAPSHOT_STRIDE;
        const a = arch[s];
        const x = snapshot[o + 3];
        const y = snapshot[o + 4];
        const noCull = entityNoCull(spawned, a, snapshot[o + 9]);
        // A turret's base part clears flag 8 at its construct (TPREC_FLAG_KEEP,
        // turret_part.c 0x0041cfc5); a mount keeps its Dreadnought's
        // (CACT_MOUNT_SPAWN_FLAG_KEEP, mount.c 0x00425fdd).
        const partNoCull = a === ARCHETYPE.JUGGERNAUT && noCull;
        const parts = subActorsOf(spawned, a);
        for (let p = 0; p < parts; p++) put(x, y, partNoCull, LIVE_OTHER, -1);
        put(x, y, noCull, LIVE_ENTITY, i);
      }
    },
  };
}
