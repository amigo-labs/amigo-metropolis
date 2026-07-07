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

  // Float fields (world-space 2D plane: posX/posY; height is vertical).
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly height: Float32Array;
  readonly yaw: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly hp: Float32Array;
  readonly aux: Float32Array;
  /** Generic per-archetype timer (transform lock / projectile TTL / respawn). */
  readonly timerA: Float32Array;
  /** Vertical velocity (jump/fall) or secondary timer. */
  readonly timerB: Float32Array;
  /** Weapon cooldowns in ticks (avatar: primary/heavy/special; turret: A). */
  readonly cooldownA: Float32Array;
  readonly cooldownB: Float32Array;
  readonly cooldownC: Float32Array;
  /** Aim direction (unit vector); projectiles reuse velX/velY instead. */
  readonly aimX: Float32Array;
  readonly aimY: Float32Array;

  // Uint16 fields.
  readonly ammoA: Uint16Array;
  readonly ammoB: Uint16Array;

  // Int16 fields.
  /** Owning entity id (projectiles) or -1. */
  readonly ownerId: Int16Array;

  // Byte fields.
  readonly alive: Uint8Array;
  readonly archetype: Uint8Array;
  readonly team: Int8Array;
  /** Renderer-facing state bits (ANIM_* in sim.ts). */
  readonly animState: Uint8Array;
  /** Avatar: 0 walker, 1 hover. Generic subtype byte for other archetypes. */
  readonly mode: Uint8Array;
}

const FLOAT_FIELDS = 15;
const U16_FIELDS = 2;
const I16_FIELDS = 1;
const BYTE_FIELDS = 5;

export function createEntityStore(cap: number = MAX_ENTITIES): EntityStore {
  const floatBytes = FLOAT_FIELDS * cap * 4;
  const u16Start = floatBytes;
  const i16Start = u16Start + U16_FIELDS * cap * 2;
  const byteStart = i16Start + I16_FIELDS * cap * 2;
  const fieldBytes = byteStart + BYTE_FIELDS * cap;
  // Free-list goes last so the field region is one contiguous hashable block;
  // its offset is rounded up so the Int32Array stays aligned for every cap.
  const freeListOffset = (fieldBytes + 3) & ~3;
  const buffer = new ArrayBuffer(freeListOffset + cap * 4);
  const f = (i: number) => new Float32Array(buffer, i * cap * 4, cap);
  return {
    cap,
    bytes: new Uint8Array(buffer),
    fieldBytes,
    high: 0,
    freeCount: 0,
    freeList: new Int32Array(buffer, freeListOffset, cap),
    posX: f(0),
    posY: f(1),
    height: f(2),
    yaw: f(3),
    velX: f(4),
    velY: f(5),
    hp: f(6),
    aux: f(7),
    timerA: f(8),
    timerB: f(9),
    cooldownA: f(10),
    cooldownB: f(11),
    cooldownC: f(12),
    aimX: f(13),
    aimY: f(14),
    ammoA: new Uint16Array(buffer, u16Start, cap),
    ammoB: new Uint16Array(buffer, u16Start + cap * 2, cap),
    ownerId: new Int16Array(buffer, i16Start, cap),
    alive: new Uint8Array(buffer, byteStart, cap),
    archetype: new Uint8Array(buffer, byteStart + cap, cap),
    team: new Int8Array(buffer, byteStart + 2 * cap, cap),
    animState: new Uint8Array(buffer, byteStart + 3 * cap, cap),
    mode: new Uint8Array(buffer, byteStart + 4 * cap, cap),
  };
}

/**
 * Allocates an entity id (recycled LIFO, else next dense id) with all other
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
  store.mode[id] = 0;
  store.posX[id] = 0;
  store.posY[id] = 0;
  store.height[id] = 0;
  store.yaw[id] = 0;
  store.velX[id] = 0;
  store.velY[id] = 0;
  store.hp[id] = 0;
  store.aux[id] = 0;
  store.timerA[id] = 0;
  store.timerB[id] = 0;
  store.cooldownA[id] = 0;
  store.cooldownB[id] = 0;
  store.cooldownC[id] = 0;
  store.aimX[id] = 0;
  store.aimY[id] = 0;
  store.ammoA[id] = 0;
  store.ammoB[id] = 0;
  store.ownerId[id] = 0;
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
