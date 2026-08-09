// Per-tick event ring buffer (architecture.md §3): things that don't
// interpolate — shots, hits, explosions, deaths — flow to renderer/audio/UI
// through here. Events are TRANSIENT: cleared at the start of every tick,
// never part of the state hash (they are derived from state transitions).

/**
 * 512, not 256: on a Precinct Assault arena (rules.md §9) the 32 capturable
 * turrets, 32 ring turrets and 8 built-in base weapons can all fire on the same
 * tick, which is ~140 SHOT+HIT events before deaths, production and alarms. At
 * 256 the tail was silently dropped — harmless for the hash (events are never
 * hashed) but it is exactly how an alert cue goes missing.
 */
export const EVENT_CAPACITY = 512;
export const EVENT_STRIDE = 4; // [type, a, b, c]

export const EV_SHOT = 1; //      a=shooter id, b=weapon slot, c=payload (see below)

/**
 * `EV_SHOT.b` values, and what `c` means for each.
 *
 * Slots 0/1/2 are the avatar's gun/heavy/special and pack BOTH a weapons.ts
 * catalog id and the shot's reach into `c` (see `weaponShotPayload`).
 *
 * Turrets, ground units and the Warden's cannon have no catalog entry — their
 * reach comes from the arena's imported weapon profile, from UNIT_RANGE, or from
 * balance.ts. They used to push `b=0, c=0`, which the renderer resolved to
 * weaponById(0) = the Mini-Gun, and drew a 40 m tracer for a turret whose
 * engage_range is 6 m. On a PA arena that is 72 emplacements firing seven times
 * further than they can shoot. So they get their own slot and put their actual
 * reach in `c`, in DECIMETRES (reach * 10, rounded) to stay integral.
 *
 * REACH IS THE SHOT'S, NOT THE WEAPON'S. Both encodings carry how far this
 * particular shot travelled — to the body it hit, to the wall that stopped it,
 * or the full range when it reached neither. The avatar slots used to carry the
 * catalog id alone and the renderer filled in the weapon's nominal range, so a
 * burst into a wall three metres away still drew a forty-metre bolt straight
 * through it. Emplacements had the same gap on a smaller scale: they reported
 * the profile's range rather than the distance to the target they had just hit.
 */
export const SHOT_SLOT_GUN = 0;
export const SHOT_SLOT_HEAVY = 1;
export const SHOT_SLOT_SPECIAL = 2;
/** Non-catalog hitscan: `c` = reach in decimetres, not a weapon id. */
export const SHOT_SLOT_HITSCAN = 3;
/** Non-catalog projectile launch: muzzle flash only, the shell is an entity. */
export const SHOT_SLOT_LAUNCH = 4;

/** Reach (metres) -> the integer `c` carries for SHOT_SLOT_HITSCAN. */
export function reachToShotPayload(reach: number): number {
  return Math.round(reach * 10);
}

/** Inverse of reachToShotPayload. */
export function shotPayloadToReach(payload: number): number {
  return payload / 10;
}

/**
 * Avatar slots (0/1/2): pack the catalog weapon id with this shot's reach.
 *
 * Low byte = weapon id (the catalog has ten entries, ids < 16), everything
 * above = reach in decimetres like `reachToShotPayload`. A 40 m shot packs to
 * 400 << 8, well inside the Int32Array slot the event buffer already uses, so
 * this is a payload change and not a format change — and events are never
 * hashed, so no SIM_VERSION with it.
 */
export function weaponShotPayload(weaponId: number, reach: number): number {
  const dm = reachToShotPayload(reach);
  return (weaponId & 0xff) | ((dm < 0 ? 0 : dm) << 8);
}

/** Catalog id out of a `weaponShotPayload`. */
export function shotPayloadWeaponId(payload: number): number {
  return payload & 0xff;
}

/** Reach (metres) out of a `weaponShotPayload`. */
export function shotPayloadWeaponReach(payload: number): number {
  return (payload >> 8) / 10;
}
export const EV_EXPLOSION = 2; // a=x*16, b=y*16 (quantized), c=projectile kind
export const EV_HIT = 3; //       a=target id, b=attacker player, c=damage
export const EV_DEATH = 4; //     a=victim id, b=killer player (-1 none), c=archetype
export const EV_RESPAWN = 5; //   a=entity id, b=player
export const EV_PURCHASE = 6; //  a=entity id, b=player, c=archetype
export const EV_BREACH = 7; //    a=unit id, b=winning team
export const EV_CAPTURE = 8; //   a=turret id, b=team, c=turret spot index
export const EV_CLAIM = 9; //     a=console id, b=team, c=outpost index
// Precinct Assault events (rules.md §9). Appended, never renumbered: the client
// maps these to cues by index. Adding event types does NOT bump SIM_VERSION —
// events are transient and never hashed.
export const EV_ALARM = 10; //    a=x*16, b=y*16, c=team whose base is intruded
export const EV_PICKUP = 11; //   a=x*16, b=y*16, c=pickup kind
export const EV_PRODUCE = 12; //  a=unit id, b=team, c=archetype
export const EV_CORE_HIT = 13; // a=x*16, b=y*16, c=team whose core was hit

export interface EventBuffer {
  count: number;
  readonly data: Int32Array;
}

export function createEventBuffer(): EventBuffer {
  return { count: 0, data: new Int32Array(EVENT_CAPACITY * EVENT_STRIDE) };
}

export function clearEvents(buf: EventBuffer): void {
  buf.count = 0;
}

/** Appends an event; silently drops when full (renderer-only data). */
export function pushEvent(buf: EventBuffer, type: number, a: number, b: number, c: number): void {
  if (buf.count === EVENT_CAPACITY) return;
  const o = buf.count * EVENT_STRIDE;
  buf.data[o] = type;
  buf.data[o + 1] = a;
  buf.data[o + 2] = b;
  buf.data[o + 3] = c;
  buf.count += 1;
}
