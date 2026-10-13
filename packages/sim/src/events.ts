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
 * engage_range was then 6 m (12 m since the original's range scale). On a PA arena
 * that was 72 emplacements firing several times further than they can shoot. So they get their own slot and put their actual
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
export function weaponShotPayload(weaponId: number, reach: number, powered = false): number {
  // A POSITIVE reach never packs to zero. `reachToShotPayload` rounds, so
  // anything under 5 cm would land on 0 dm, and 0 is how the renderer spells
  // "no reach travelled with this shot" — it falls back to the weapon's nominal
  // range there (fx.ts hitscanLook). Firing while flush against a wall would
  // then draw the full forty metres straight through it, which is the exact bug
  // this payload exists to fix, surviving at the boundary. One decimetre is the
  // shortest a real shot may report.
  let dm = reachToShotPayload(reach);
  if (dm <= 0) dm = reach > 0 ? 1 : 0;
  return (weaponId & SHOT_WEAPON_MASK) | (powered ? SHOT_POWERED : 0) | (dm << 8);
}

/** Low-byte bits of a `weaponShotPayload`: the catalog id, and the block flag. */
const SHOT_WEAPON_MASK = 0x7f;
/**
 * The shot came out of the slot's block B (its power-up magazine). The block
 * decides what the original plays — each block names its own sound and effects
 * (fcop-re/player-and-weapons.md, `sound_1c`) — and only the tick that fired
 * knows it: the snapshot after the last powered round already reads block A.
 */
const SHOT_POWERED = 0x80;

/** Catalog id out of a `weaponShotPayload`. */
export function shotPayloadWeaponId(payload: number): number {
  return payload & SHOT_WEAPON_MASK;
}

/** True when a `weaponShotPayload` came out of block B. */
export function shotPayloadPowered(payload: number): boolean {
  return (payload & SHOT_POWERED) !== 0;
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
/**
 * A gate breach: fired on the tick an enemy Runner/Juggernaut enters a gate,
 * which starts the MATCH_OUTRO_TICKS countdown. `winner` is set when it ends.
 */
export const EV_BREACH = 7; //    a=unit id, b=winning team
export const EV_CAPTURE = 8; //   a=turret id, b=team, c=turret spot index
export const EV_CLAIM = 9; //     a=console id, b=team, c=outpost index
// Precinct Assault events (rules.md §9). Appended, never renumbered: the client
// maps these to cues by index. Adding event types does NOT bump SIM_VERSION —
// events are transient and never hashed.
export const EV_ALARM = 10; //    a=x*16, b=y*16, c=team whose base is intruded
export const EV_PICKUP = 11; //   a=x*16, b=y*16, c=pickup kind
// 12 (EV_PRODUCE, free base production) and 13 (EV_CORE_HIT, core damage) are
// retired with the model they reported (SIM_VERSION 32): the original has neither
// free production nor a destructible core. The numbers stay reserved.
/**
 * The avatar committed to a walker <-> hover change (rules.md §2). Fired ONCE,
 * on the tick the mode byte flips, which is also the tick the transform lock
 * starts — so `c` is the whole window the presentation has to play in and the
 * client can run the morph off its own clock rather than a per-tick progress
 * field. The unit is move-locked for that window, so the position resolved from
 * `a` stays put and a static anchor is enough for the arcs.
 *
 * `b` is the mode being entered, not the one being left: the flip has already
 * happened when this fires, so the OUTGOING form is `1 - b`.
 */
export const EV_TRANSFORM = 14; // a=entity id, b=new mode (0 walker/1 hover), c=lock ticks
/**
 * Alert cues (fcop-fidelity.md R15). The original's scripts speak these as voice
 * lines (fcop-re/ai-and-rules.md §6); the client plays them. The other two alerts
 * the original voices already have events: base intrusion is EV_ALARM (c = the
 * intruded team, voice ids 2/3) and the gate being reached is EV_BREACH (b = the
 * winning team, voice ids 6/19).
 *
 * A side's base turret was hit, at most once per TURRET_ALERT_COOLDOWN_TICKS per
 * side (voice ids 4/5).
 */
export const EV_TURRET_UNDER_FIRE = 15; // a=turret id, b=its team
/** A side's base turret was destroyed (voice ids 0/1). */
export const EV_TURRET_LOST = 16; // a=turret id, b=its team, c=ring slot
/**
 * A purchase spot refused an action-key press (fcop-fidelity.md R17): the points
 * are short, the side already has 20 of that unit alive, or an outpost claim
 * zone was pressed with fewer than 30 points. The original's spot scripts answer
 * every press with an accept or a refuse sound (fcop-re/ai-and-rules.md §2); an
 * accepted purchase is EV_PURCHASE. c = the refused archetype, -1 for a claim.
 */
export const EV_PURCHASE_REFUSED = 17; // a=avatar id, b=player, c=archetype (-1 claim)
/**
 * A trigger pulled on an empty magazine (`player_fire_slot` 0x00458ed0: the
 * slot's cooldown has run out, block B is empty and block A is too). The
 * original plays sound script 13 for it, every frame the trigger is held.
 */
export const EV_DRY_FIRE = 18; // a=avatar id, b=player, c=slot (0 gun, 1 heavy, 2 special)
/**
 * A slot fired with exactly five rounds left in the block it fires from — the
 * same function, before the shot goes out; the original plays script 14.
 */
export const EV_LOW_AMMO = 19; // a=avatar id, b=player, c=slot
/**
 * A transform press refused: a change already running, or water under the mech
 * (`player_transform_step` 0x004421dc plays script 42 for it).
 */
export const EV_TRANSFORM_REFUSED = 20; // a=avatar id, b=player
/**
 * The Warden fired one of the Sky Captain's weapons that launch a round:
 * `EV_SHOT` with `SHOT_SLOT_LAUNCH` and `c` = this, the captain's world-weapon
 * row (8 the missile, 9 the bomb; its gun, row 7, is `SHOT_SLOT_HITSCAN`).
 * Turrets and units launch with `c` = 0; their row follows from what they are.
 */
export const SKY_WEAPON_MISSILE = 8;
export const SKY_WEAPON_BOMB = 9;

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
