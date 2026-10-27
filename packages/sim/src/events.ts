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
/**
 * The Sky Captain's mode changed (`ai->mode`, mirrored in state word 39, which
 * its idle-chatter script polls): from a decision pass, the respawn (roam) or
 * the construct (defend). b = the new mode (warden.ts SKY_MODE_*).
 */
export const EV_CAPTAIN_MODE = 21; // a=captain id, b=new mode
/**
 * The Sky Captain stored an announcement into state word 56, which its event
 * scripts poll (2: it turned its guns on the player's mech, 3: it went after a
 * badly hurt player mech, 4: it was repaired). Events 1 (the switch to attack),
 * 5..9 follow from EV_CAPTAIN_MODE, EV_HIT, EV_CAPTURE, EV_DEATH and EV_RESPAWN.
 */
export const EV_CAPTAIN_EVENT = 22; // a=captain id, b=event (2, 3, 4)
/**
 * The Sky Captain posted an order into a request word (its decision pass): the
 * scripts that spawn the units also announce the order. b = CAPTAIN_ORDER_*,
 * c = the outpost it is for, -1 its base.
 */
export const EV_CAPTAIN_ORDER = 23; // a=captain id, b=order kind, c=outpost (-1 base)
export const CAPTAIN_ORDER_TANKS = 0;
export const CAPTAIN_ORDER_JETS = 1;
export const CAPTAIN_ORDER_DREADNOUGHT = 2;
export const CAPTAIN_ORDER_FORTRESS = 3;
/**
 * A world round (`PROJ_ROUND`: a turret's, a unit's, the Dreadnought's guns',
 * the Sky Captain's missile) struck something or a wall, beside its
 * EV_EXPLOSION: c names what fired it, which decides the original's impact
 * effect (each type-98 row has its own; see roundSourceArchetype/-Team).
 */
export const EV_ROUND_IMPACT = 24; // a=x*16, b=y*16, c=archetype | (team + 1) << 4
/** EV_ROUND_IMPACT.c for a shooter. */
export function roundSource(archetype: number, team: number): number {
  return (archetype & 0xf) | ((team + 1) << 4);
}
/** The shooter's archetype out of EV_ROUND_IMPACT.c. */
export function roundSourceArchetype(c: number): number {
  return c & 0xf;
}
/** The shooter's team out of EV_ROUND_IMPACT.c (-1 neutral). */
export function roundSourceTeam(c: number): number {
  return (c >> 4) - 1;
}
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
/**
 * A lift leaves a stop (fcop-fidelity.md P12): a rider's press, or the end of
 * its dwell. Its travel sound (the record's, 70) runs while it moves.
 */
export const EV_LIFT_START = 25; // a=lift index (map.lifts), b=the stop it heads for
/** A lift reaches a stop: its arrival sound (71) plays at the lift. */
export const EV_LIFT_ARRIVE = 26; // a=lift index (map.lifts), b=the stop it reached
/**
 * A mech goes down with the original's "does not count" marker set — HARD's
 * deep water (fcop-fidelity.md P13): pushed just before its EV_DEATH, in the same
 * tick. `player_op4` reads and clears block +0xde first, and with it set raises
 * no wreck, no death effects and no wreck sound (0x00447650), and sets the short
 * 0.5 s respawn. The client draws and plays nothing for that EV_DEATH.
 */
export const EV_SUNK = 27; // a=avatar id, b=player
/**
 * The Riot Shield's powered sphere strikes a body with a charged arc
 * (`sustain_sphere_tick` 0x0044c8c1..0x0044c91f): a link of 32 segments, one
 * strand, (0x7f, 0x7f, 0xff), from the arc's point on the sphere to the body.
 * `c` is the arc's two angles (packArcAngles): its point is that direction on
 * the sphere, in the mech's axes, at the sphere's radius. Pushed before the
 * hurt's EV_HIT.
 */
export const EV_SHIELD_ARC = 28; // a=avatar id, b=struck entity id, c=the arc's angles
/**
 * One of a sphere's twelve arcs steps (`sustain_sphere_arc_step` 0x0044caf0):
 * a link of 8 segments, one strand, (0x30, 0x30, 0x40), from the arc's old point
 * on the sphere to its new one (0x0044cd3e). Both are packArcAngles values.
 */
export const EV_SHIELD_ARC_STEP = 29; // a=avatar id, b=the old angles, c=the new angles
/**
 * The killer's push (RE M3-OP; `cact_base_op4` 0x0041a2c0, the push
 * `mission_record_spawn_push` 0x00437aa0): a body killed by the contact of a
 * missile-class round (the original's actor type 2: every world round, the Hell
 * Fire 2000's, the Hyper Velocity Rocket's, the K-9 Drone's, the Fusion
 * Torpedo's) that was made before the round. Its death's context then carries
 * the round's heading and its damage word, and a shatter of its death flies
 * its pieces that way. Pushed just before the body's EV_DEATH.
 */
export const EV_KILL_PUSH = 30; // a=victim id, b=packDirection(round heading), c=round damage
/**
 * The powered Electric Gun jumps from its lock to another body (`player_arc`
 * 0x00459bd0): a link between the two actors' reference points (both ends
 * `cact_effect_end_create_actor` with point -1), the record's columns with its
 * segments halved, or with no record 6 segments, one strand, (0x7f, 0x7f,
 * 0xff), fade 0x4b0, amplitude 0x7fff. `c` is the shot's weaponShotPayload
 * (the gun, powered, no reach). Pushed before the jump's EV_HIT.
 */
export const EV_GUN_ARC = 31; // a=the lock (the jump's start), b=the body it jumps to, c=weaponShotPayload
/**
 * Another actor's touch (`cact_base_op11` operation 0x0b, 0x0041a7eb): a round
 * that struck a body by its contact, with no blast — the guided rounds, the
 * blastless missiles. It clears the high nibble of the body's +0x19, the death
 * mask its damage messages built (fcop-fidelity.md A19). Pushed just after the
 * contact's EV_HIT.
 */
export const EV_TOUCH = 32; // a=touched entity id

/** A unit direction as one event field: x, y and up, ten signed bits each (/ 511). */
export function packDirection(x: number, y: number, h: number): number {
  const len = Math.sqrt(x * x + y * y + h * h);
  if (len <= 0) return 0;
  const q = (v: number) => Math.floor((v / len) * 511 + 0.5) & 0x3ff;
  return q(x) | (q(y) << 10) | (q(h) << 20);
}

/** One axis (0 x, 1 y, 2 up) of a packDirection value, -1..1. */
export function directionAxis(packed: number, axis: number): number {
  const raw = (packed >> (10 * axis)) & 0x3ff;
  return ((raw << 22) >> 22) / 511;
}

/**
 * An arc's direction as one event field: its yaw in the low sixteen bits and its
 * pitch in the high, each the original's sixteen-bit angle (4096 a turn).
 */
export function packArcAngles(yaw: number, pitch: number): number {
  return (yaw & 0xffff) | (pitch << 16);
}

/** The yaw of a packArcAngles value, signed. */
export function arcYawOf(packed: number): number {
  return (packed << 16) >> 16;
}

/** The pitch of a packArcAngles value, signed. */
export function arcPitchOf(packed: number): number {
  return packed >> 16;
}
