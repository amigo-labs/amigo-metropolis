// Structure-of-Arrays entity storage (architecture.md §2): fixed capacity,
// dense ids with a free-list, every field a view into ONE ArrayBuffer so the
// state hash can walk raw bytes. Iteration MUST always be `for id in
// [0, high)` skipping !alive[id] — dense id order is the only iteration order
// that is identical on every peer.

import type { Archetype } from "./archetypes";
import { MAX_ENTITIES } from "./balance";

export interface EntityStore {
  readonly cap: number;
  /** Whole-buffer byte view; [0, fieldBytes) is the canonically hashable region. */
  readonly bytes: Uint8Array;
  /** Byte length of the entity-field region (everything except the free-list). */
  readonly fieldBytes: number;
  /** Dense id high watermark: valid ids are [0, high). Grows only. */
  high: number;
  /** Number of recycled ids currently on the free-list stack. */
  freeCount: number;
  readonly freeList: Int32Array;

  // Float fields (world-space 2D plane: posX/posY; height is terrain-sampled).
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly height: Float32Array;
  readonly yaw: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly hp: Float32Array;
  readonly aux: Float32Array;

  // Byte fields.
  readonly alive: Uint8Array;
  readonly archetype: Uint8Array;
  readonly team: Int8Array;
  readonly animState: Uint8Array;
}

const FLOAT_FIELDS = 8;
const BYTE_FIELDS = 4;

export function createEntityStore(cap: number = MAX_ENTITIES): EntityStore {
  const floatBytes = FLOAT_FIELDS * cap * 4;
  const fieldBytes = floatBytes + BYTE_FIELDS * cap;
  // Free-list goes last so the field region is one contiguous hashable block.
  // fieldBytes is a multiple of 4 for every cap, keeping the Int32Array aligned.
  const buffer = new ArrayBuffer(fieldBytes + cap * 4);
  const f = (i: number) => new Float32Array(buffer, i * cap * 4, cap);
  return {
    cap,
    bytes: new Uint8Array(buffer),
    fieldBytes,
    high: 0,
    freeCount: 0,
    freeList: new Int32Array(buffer, fieldBytes, cap),
    posX: f(0),
    posY: f(1),
    height: f(2),
    yaw: f(3),
    velX: f(4),
    velY: f(5),
    hp: f(6),
    aux: f(7),
    alive: new Uint8Array(buffer, floatBytes, cap),
    archetype: new Uint8Array(buffer, floatBytes + cap, cap),
    team: new Int8Array(buffer, floatBytes + 2 * cap, cap),
    animState: new Uint8Array(buffer, floatBytes + 3 * cap, cap),
  };
}

/**
 * Allocates an entity id (recycled LIFO, else next dense id) with all float
 * fields zero. Returns -1 when the store is full — callers must skip the
 * spawn deterministically, never throw mid-tick.
 */
export function spawn(store: EntityStore, archetype: Archetype, team: number): number {
  let id: number;
  if (store.freeCount > 0) {
    store.freeCount -= 1;
    id = store.freeList[store.freeCount];
  } else {
    if (store.high === store.cap) return -1;
    id = store.high;
    store.high += 1;
  }
  store.alive[id] = 1;
  store.archetype[id] = archetype;
  store.team[id] = team;
  return id;
}

/**
 * Frees an entity id and zeroes ALL its fields so the byte region stays
 * canonical — a freed slot must hash identically to a never-used one.
 */
export function despawn(store: EntityStore, id: number): void {
  store.alive[id] = 0;
  store.archetype[id] = 0;
  store.team[id] = 0;
  store.animState[id] = 0;
  store.posX[id] = 0;
  store.posY[id] = 0;
  store.height[id] = 0;
  store.yaw[id] = 0;
  store.velX[id] = 0;
  store.velY[id] = 0;
  store.hp[id] = 0;
  store.aux[id] = 0;
  store.freeList[store.freeCount] = id;
  store.freeCount += 1;
}

/** Live entity count (walks the dense range; use sparingly outside tests). */
export function countAlive(store: EntityStore): number {
  let n = 0;
  for (let id = 0; id < store.high; id++) {
    n += store.alive[id];
  }
  return n;
}
