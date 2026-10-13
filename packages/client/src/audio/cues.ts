// Which of the original's sounds each game event plays, and from where.
//
// The sim speaks in events and snapshots; the original's code calls its sound
// module from inside the actors. This is the translation, call site by call
// site, with the retail address each one stands for (src/game/ in the RE repo):
//
//   player_fire_direct 0x00459637  gun kinds: the block's +0x1c, cued (table A)
//   player_fire_launch 0x004591f1  other kinds: +0x1c, one-shot (table B)
//   player_fire_slot   0x00458f57  empty: script 13; 0x00458f6f five left: 14
//   player_gauge_set   0x004482f0  health under a third, then at zero: 14
//   player_tick        0x00446fe5  transform: 21; refused (0x004421dc): 42
//   player_op4         0x00447610  the PA wreck: 65, effects 3 and 9 (bank 1)
//   player_hover_tick  0x0044267f  hover loop: 40 idle, 41 driving, 42 brake
//   cact_weapon_discharge 0x0044dfb4  world weapons: the row's +0x1c, at the shooter
//   cact_effect_install   0x0042d020  every effect: its +0x16, at it or at the player
//   cact_registry_build   0x0043b520  ambient loops: each actor's body[29], queued
//   mission_flush_pending_sound 0x00436250  63 accept / capture, 73 refuse, 83 pickup
//   Cfun ops 0x0c / 0x0d  speech lines (voice.c), by the scripts' rules
//
// "Placed" follows the original's split-screen rule, which is also its network
// rule: a sound that belongs to the local player is heard flat, one that
// belongs to the other player is heard from where it happens.

import {
  ARCHETYPE,
  EV_ALARM,
  EV_BREACH,
  EV_CAPTURE,
  EV_CLAIM,
  EV_DEATH,
  EV_DRY_FIRE,
  EV_EXPLOSION,
  EV_HIT,
  EV_LOW_AMMO,
  EV_PICKUP,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_SHOT,
  EV_TRANSFORM,
  EV_TRANSFORM_REFUSED,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
  EVENT_STRIDE,
  type EventBuffer,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_MOVE,
  MAX_PLAYERS,
  MOVE_CUE_BRAKE,
  MOVE_CUE_DRIVE,
  MOVE_CUE_TURN,
  matchSlotOffset,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  SHOT_SLOT_SPECIAL,
  SKY_WEAPON_BOMB,
  SKY_WEAPON_MISSILE,
  shotPayloadPowered,
  shotPayloadWeaponId,
  weaponById,
} from "@metropolis/sim";
import { type ArenaAudio, effectAtPlayer, type PlayerWeaponSounds } from "./arenaAudio";
import { type AudioEngine, LOOP_SCRIPT_NONE, QUEUE_RECORDS } from "./engine";

// --- script ids the original's code names outright --------------------------
const SCRIPT_EMPTY = 13;
const SCRIPT_LOW = 14;
const SCRIPT_TRANSFORM = 21;
const SCRIPT_TRANSFORM_REFUSED = 42;
const SCRIPT_WRECK = 65;
const HOVER_IDLE = 40;
const HOVER_MOVE = 41;
const HOVER_BRAKE = 42;
/** The mech's own effects (bank 1): its wreck (player_op4). */
const MECH_WRECK_EFFECTS = [3, 9] as const;
/** The transform's effect (bank 1, player_tick 0x00446fe5). */
const TRANSFORM_EFFECT = 4;
/** Pending-sound slot values the scripts write (ai-and-rules.md §6). */
const PENDING_ACCEPT = 63;
const PENDING_REFUSE = 73;
const PENDING_PICKUP = 83;
/** Script ids `snd_play_script` refuses for the other player's half (0x00433d90). */
function ownViewOnly(id: number): boolean {
  return id === 7 || id === 8 || id === 13 || id === 14;
}
/** Direct-path kinds (0x00458f93): Mini Gun, Electric, Laser, Flame. */
function directKind(kind: number): boolean {
  return (kind >= 0x0a && kind <= 0x0c) || kind === 0x0e;
}
/** `cact_registry_build`'s reach for the ambient queue: 0x22000 world units. */
const AMBIENT_RANGE_M = 0x22000 / 8192;
/** An ambient queue record nobody owns; emitters own keys from EMITTER_KEY down. */
const FREE = -1;
const EMITTER_KEY = -2;
/** Delayed effect successors waiting to install. */
const MAX_PENDING_EFFECTS = 64;

// --- speech -----------------------------------------------------------------
/** Outpost claims, I7..I14: slot-major pairs in the order outposts 2, 3, 1, 0. */
const CLAIM_LINE_BASE = 7;
const CLAIM_ORDER = [3, 2, 0, 1] as const; // outpost index -> pair index

/** Snapshot entity fields (sim.ts writeSnapshot). */
const S_ID = 0;
const S_ARCH = 1;
const S_TEAM = 2;
const S_X = 3;
const S_Y = 4;
const S_ANIM = 7;
const ANIM_HOVER = 1 << 1;

export interface CueContext {
  /** Entity snapshot of the tick the events came from (before it ran). */
  readonly snapshot: Float32Array;
  readonly count: number;
  readonly stride: number;
  readonly match: Float32Array;
  /** The local player's slot. */
  readonly localSlot: number;
  /** The Sky Captain's slot, -1 in a two-human match. */
  readonly captainSlot: number;
  /** The Sky Captain's level (0..9), for the opening announcement. */
  readonly captainLevel: number;
}

export class OriginalSounds {
  private data: ArenaAudio | null = null;
  private weapons: Readonly<Record<number, PlayerWeaponSounds>> = {};
  /** Per slot: the health gauge's state (2 full, 1 spending, 0 empty). */
  private readonly gauge = new Uint8Array(MAX_PLAYERS).fill(2);
  private readonly gaugeAvatar = new Int32Array(MAX_PLAYERS).fill(-1);
  /** Per slot: hover (1) or walker (0) as last seen, for the loop register. */
  private readonly form = new Int8Array(MAX_PLAYERS).fill(-1);
  /** Ambient queue record -> entity id, -1 free. */
  private readonly ambientOwner = new Int32Array(QUEUE_RECORDS).fill(FREE);
  private readonly ambientSeen = new Uint8Array(QUEUE_RECORDS);
  /** Delayed effects: bank, id, x, z, ticks left (0 = free). */
  private readonly fxBank = new Uint8Array(MAX_PENDING_EFFECTS);
  private readonly fxId = new Uint16Array(MAX_PENDING_EFFECTS);
  private readonly fxX = new Float32Array(MAX_PENDING_EFFECTS);
  private readonly fxZ = new Float32Array(MAX_PENDING_EFFECTS);
  private readonly fxLeft = new Int32Array(MAX_PENDING_EFFECTS);
  private readonly pos = new Float32Array(3);
  private announced = false;

  constructor(private readonly engine: AudioEngine) {}

  /** A new match on `data`'s arena. */
  begin(data: ArenaAudio, weapons: Readonly<Record<number, PlayerWeaponSounds>>): void {
    this.data = data;
    this.weapons = weapons;
    this.gauge.fill(2);
    this.gaugeAvatar.fill(-1);
    this.form.fill(-1);
    this.ambientOwner.fill(FREE);
    this.fxLeft.fill(0);
    this.announced = false;
  }

  /** One tick's events, then the per-tick state the original reads each frame. */
  tick(events: EventBuffer, ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    if (!this.announced) {
      this.announced = true;
      // fn55: the level announcement, `74 + level - 1` for a level above 0.
      if (ctx.captainSlot >= 0 && ctx.captainLevel > 0)
        this.engine.speak(74 + ctx.captainLevel - 1);
    }
    const d = events.data;
    for (let i = 0; i < events.count; i++) {
      const o = i * EVENT_STRIDE;
      this.event(d[o], d[o + 1], d[o + 2], d[o + 3], ctx);
    }
    this.avatars(ctx);
    this.ambient(ctx);
    this.delayedEffects();
    this.engine.frame();
  }

  // --- events ------------------------------------------------------------------

  private event(type: number, a: number, b: number, c: number, ctx: CueContext): void {
    const engine = this.engine;
    switch (type) {
      case EV_SHOT:
        this.shot(a, b, c, ctx);
        return;
      case EV_DRY_FIRE:
        this.playerScript(SCRIPT_EMPTY, b, a, ctx);
        return;
      case EV_LOW_AMMO:
        this.playerScript(SCRIPT_LOW, b, a, ctx);
        return;
      case EV_TRANSFORM:
        this.playerScript(SCRIPT_TRANSFORM, this.slotOfAvatar(a, ctx), a, ctx);
        if (this.locate(a, ctx)) this.installEffect(1, TRANSFORM_EFFECT, this.pos[0], this.pos[2]);
        return;
      case EV_TRANSFORM_REFUSED:
        this.playerScript(SCRIPT_TRANSFORM_REFUSED, b, a, ctx);
        return;
      case EV_PURCHASE:
        // The purchase spots' scripts (accept 63) answer a human's key press;
        // the Sky Captain buys through its request words and their scripts.
        if (b !== ctx.captainSlot) engine.setPending(PENDING_ACCEPT);
        this.purchaseLines(b, c, ctx);
        return;
      case EV_PURCHASE_REFUSED:
        engine.setPending(PENDING_REFUSE);
        return;
      case EV_CAPTURE:
        // turret_op10 runs the capture script, which writes the same 63.
        engine.setPending(PENDING_ACCEPT);
        if (b === ctx.captainSlot) this.captain([50, 51, 52]);
        return;
      case EV_PICKUP:
        // The ItemPickup's death script.
        engine.setPending(PENDING_PICKUP);
        return;
      case EV_CLAIM:
        this.claimLines(b, c, ctx);
        return;
      case EV_TURRET_LOST:
        engine.speak(b === 1 ? 1 : 0);
        return;
      case EV_ALARM:
        engine.speak(c === 1 ? 3 : 2);
        return;
      case EV_TURRET_UNDER_FIRE:
        engine.speak(b === 1 ? 5 : 4);
        return;
      case EV_BREACH:
        this.breachLines(b, ctx);
        return;
      case EV_DEATH:
        this.death(a, b, c, ctx);
        return;
      case EV_EXPLOSION:
        this.explosion(a / 16, b / 16, c);
        return;
      case EV_HIT:
        return;
      default:
        return;
    }
  }

  private shot(shooter: number, slot: number, c: number, ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    if (slot <= SHOT_SLOT_SPECIAL) {
      const player = this.slotOfAvatar(shooter, ctx);
      const w = weaponById(shotPayloadWeaponId(c));
      const rec = w ? this.weapons[w.code] : undefined;
      if (!rec) return;
      const blk = shotPayloadPowered(c) ? rec.b : rec.a;
      const placed = player !== ctx.localSlot;
      if (placed && !this.locate(shooter, ctx)) return;
      if (directKind(blk.kind)) {
        this.engine.playCued(placed ? 1 : 0, blk.sound, placed, this.pos[0], this.pos[2]);
      } else {
        this.engine.playScript(blk.sound, placed, this.pos[0], this.pos[2]);
      }
      return;
    }
    // A world weapon: the row's sound at the shooter, always placed.
    if (!this.locate(shooter, ctx)) return;
    const arch = this.archetypeOf(shooter, ctx);
    let row = 0;
    if (arch === ARCHETYPE.WARDEN) {
      row =
        slot === SHOT_SLOT_HITSCAN
          ? 7
          : c === SKY_WEAPON_MISSILE
            ? 8
            : c === SKY_WEAPON_BOMB
              ? 9
              : 0;
    } else if (slot === SHOT_SLOT_LAUNCH) {
      row = worldRow(arch);
    }
    const w = data.world[row];
    if (!w || w.sound === 0) return;
    this.engine.playScript(w.sound, true, this.pos[0], this.pos[2]);
  }

  /** `snd_play_script(id, actor)` for a player's own mech. */
  private playerScript(id: number, player: number, avatar: number, ctx: CueContext): void {
    const placed = player !== ctx.localSlot;
    if (placed && ownViewOnly(id)) return;
    if (placed && !this.locate(avatar, ctx)) return;
    this.engine.playScript(id, placed, this.pos[0], this.pos[2]);
  }

  private death(victim: number, _killer: number, archetype: number, ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    if (!this.locate(victim, ctx)) return;
    const x = this.pos[0];
    const z = this.pos[2];
    const team = this.teamOf(victim, ctx);
    switch (archetype) {
      case ARCHETYPE.AVATAR: {
        const player = this.slotOfAvatar(victim, ctx);
        this.playerScript(SCRIPT_WRECK, player, victim, ctx);
        for (const id of MECH_WRECK_EFFECTS) this.installEffect(1, id, x, z);
        if (ctx.captainSlot >= 0 && player !== ctx.captainSlot) this.captain([26, 27, 41, 42, 43]);
        return;
      }
      case ARCHETYPE.WARDEN:
        this.deathEffects(data.deaths.fortress, x, z);
        this.captain([28, 29, 44, 45]);
        return;
      case ARCHETYPE.TURRET:
        this.deathEffects(team < 0 ? data.deaths.neutralTurret : data.deaths.turret, x, z);
        return;
      case ARCHETYPE.RUNNER:
        this.deathEffects(data.deaths.tank, x, z);
        return;
      case ARCHETYPE.GUARDIAN:
        this.deathEffects(data.deaths.jet, x, z);
        return;
      case ARCHETYPE.JUGGERNAUT:
        this.deathEffects(data.deaths.dreadnought, x, z);
        if (team === 0 || team === 1) this.engine.speak(20 + team);
        return;
      case ARCHETYPE.FORTRESS:
        this.deathEffects(data.deaths.fortress, x, z);
        if (team === 0 || team === 1) this.engine.speak(22 + team);
        return;
      default:
        return;
    }
  }

  private deathEffects(ids: readonly number[], x: number, z: number): void {
    for (const id of ids) this.installEffect(0, id, x, z);
  }

  private explosion(x: number, z: number, kind: number): void {
    const data = this.data;
    if (!data) return;
    const fx = impactOf(kind, this.weapons, data);
    if (fx) this.installEffect(fx.bank, fx.id, x, z);
  }

  /**
   * `cact_effect_install` (0x0042d020): the record's sound — at the player
   * (flat, within 16 m) for the ids the install singles out, else where the
   * effect is — and its successor, at once or after its delay.
   */
  private installEffect(bank: number, id: number, x: number, z: number, depth = 0): void {
    const data = this.data;
    if (!data || id <= 0 || depth > 8) return;
    const rec = data.effects[bank === 1 ? 1 : 0][id];
    if (!rec) return;
    if (rec.sound !== 0) {
      if (effectAtPlayer(id)) {
        if (this.engine.inRange(x, z)) this.engine.playScript(rec.sound, false, 0, 0);
      } else {
        this.engine.playScript(rec.sound, true, x, z);
      }
    }
    if (rec.next > 0) {
      if (rec.delay <= 0) this.installEffect(bank, rec.next, x, z, depth + 1);
      else this.deferEffect(bank, rec.next, x, z, rec.delay);
    }
  }

  private deferEffect(bank: number, id: number, x: number, z: number, ticks: number): void {
    for (let i = 0; i < MAX_PENDING_EFFECTS; i++) {
      if (this.fxLeft[i] > 0) continue;
      this.fxBank[i] = bank;
      this.fxId[i] = id;
      this.fxX[i] = x;
      this.fxZ[i] = z;
      this.fxLeft[i] = ticks;
      return;
    }
  }

  private delayedEffects(): void {
    for (let i = 0; i < MAX_PENDING_EFFECTS; i++) {
      if (this.fxLeft[i] <= 0) continue;
      this.fxLeft[i]--;
      if (this.fxLeft[i] === 0)
        this.installEffect(this.fxBank[i], this.fxId[i], this.fxX[i], this.fxZ[i]);
    }
  }

  // --- speech --------------------------------------------------------------------

  private purchaseLines(player: number, archetype: number, ctx: CueContext): void {
    const team = player === 1 ? 1 : 0;
    if (archetype === ARCHETYPE.JUGGERNAUT) this.engine.speak(15 + team);
    else if (archetype === ARCHETYPE.FORTRESS) this.engine.speak(17 + team);
    else if (player === ctx.captainSlot) {
      // The captain's order scripts: tanks 30/46 at 50 %, jets one of 47..49.
      if (archetype === ARCHETYPE.RUNNER) {
        if (Math.random() < 0.5) this.captain([30, 46]);
      } else if (archetype === ARCHETYPE.GUARDIAN) this.captain([47, 48, 49]);
    }
  }

  private claimLines(team: number, outpost: number, ctx: CueContext): void {
    const pair = CLAIM_ORDER[outpost];
    if (pair !== undefined && (team === 0 || team === 1)) {
      this.engine.speakNow(CLAIM_LINE_BASE + pair * 2 + team);
    }
    if (ctx.captainSlot < 0) return;
    if (team === ctx.captainSlot) this.captain([32, 58, 59]);
    else this.captain([68, 69, 70]);
  }

  private breachLines(winner: number, ctx: CueContext): void {
    // fn02: slot 1's base overrun (I6), fn42: slot 0's (I19); in one-player
    // the captain then wins (36/37/62) or loses (65..67).
    if (winner === 0) {
      this.engine.speakNow(6);
      if (ctx.captainSlot === 1) this.captain([65, 66, 67]);
    } else {
      this.engine.speakNow(19);
      if (ctx.captainSlot === 1) this.captain([36, 37, 62]);
    }
  }

  /** A queued captain line, `base + rand(-n)` over the script's set. */
  private captain(lines: readonly number[]): void {
    const pick = lines[Math.floor(Math.random() * lines.length)];
    if (pick !== undefined) this.engine.speak(pick);
  }

  // --- per tick: the mechs' loops and gauges, the ambient queue ----------------

  private avatars(ctx: CueContext): void {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (p === ctx.captainSlot) continue;
      const o = matchSlotOffset(p);
      const avatar = ctx.match[o + MATCH_SLOT_AVATAR_ID];
      const viewport = p === ctx.localSlot ? 0 : 1;
      if (avatar < 0) {
        this.gaugeAvatar[p] = -1;
        if (this.form[p] !== -1) this.engine.loopSetScript(viewport, LOOP_SCRIPT_NONE, false, 0, 0);
        this.form[p] = -1;
        continue;
      }
      const placed = p !== ctx.localSlot;
      if (!this.locate(avatar, ctx)) continue;
      const x = this.pos[0];
      const z = this.pos[2];
      this.gaugeTick(p, avatar, ctx.match[o + MATCH_SLOT_HP_FRAC], placed);
      const hover = (this.animOf(avatar, ctx) & ANIM_HOVER) !== 0;
      const move = ctx.match[o + MATCH_SLOT_MOVE];
      if (hover) {
        let script = HOVER_IDLE;
        if ((move & MOVE_CUE_BRAKE) !== 0) script = HOVER_BRAKE;
        if ((move & (MOVE_CUE_DRIVE | MOVE_CUE_TURN)) !== 0) script = HOVER_MOVE;
        this.engine.loopSetScript(viewport, script, placed, x, z);
      } else if (this.form[p] === 1) {
        // The walker end of a transform: `snd_loop_set_script(0xff)`.
        this.engine.loopSetScript(viewport, LOOP_SCRIPT_NONE, placed, x, z);
      }
      this.form[p] = hover ? 1 : 0;
      if (placed) this.engine.loopFollow(viewport, x, z);
    }
  }

  /**
   * `player_gauge_set` (0x004482f0's caller): the health gauge's ceiling is a
   * third of the maximum. Falling under it from full plays the gauge's sound
   * (script 14), reaching zero from there plays it again; refilling to the
   * ceiling is silent.
   */
  private gaugeTick(p: number, avatar: number, hpFrac: number, placed: boolean): void {
    if (this.gaugeAvatar[p] !== avatar) {
      this.gaugeAvatar[p] = avatar;
      this.gauge[p] = 2;
    }
    const third = 1 / 3;
    if (hpFrac >= third) {
      this.gauge[p] = 2;
      return;
    }
    if (this.gauge[p] === 2) {
      this.gauge[p] = 1;
      if (!placed) this.engine.playScript(SCRIPT_LOW, false, 0, 0);
      return;
    }
    if (this.gauge[p] === 1 && hpFrac <= 0) {
      this.gauge[p] = 0;
      if (!placed) this.engine.playScript(SCRIPT_LOW, false, 0, 0);
    }
  }

  /**
   * `cact_registry_build`: each actor that carries an ambient script and is
   * within 0x22000 of the listener is queued; the engine's queue gives the
   * eight loudest a channel.
   */
  private ambient(ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    this.ambientSeen.fill(0);
    for (let k = 0; k < ctx.count; k++) {
      const o = k * ctx.stride;
      const id = ctx.snapshot[o + S_ID];
      const arch = ctx.snapshot[o + S_ARCH];
      const sound = ambientOf(arch, data);
      if (sound === 0) continue;
      const x = ctx.snapshot[o + S_X];
      const z = ctx.snapshot[o + S_Y];
      if (!this.engine.within(x, z, AMBIENT_RANGE_M)) continue;
      this.queueAmbient(id, sound, x, z);
    }
    // Prop emitters (type 96, `snd_emit_voice_follow` 0x00430100) queue the
    // same way, keyed below -1 so they never collide with an entity id.
    for (let k = 0; k < data.emitters.length; k++) {
      const e = data.emitters[k];
      if (!this.engine.within(e.x, e.z, AMBIENT_RANGE_M)) continue;
      this.queueAmbient(EMITTER_KEY - k, e.sound, e.x, e.z);
    }
    for (let r = 0; r < QUEUE_RECORDS; r++) {
      if (this.ambientOwner[r] !== FREE && this.ambientSeen[r] === 0) this.ambientOwner[r] = FREE;
    }
  }

  /** One sounding source into its queue record (found by owner, else a free one). */
  private queueAmbient(owner: number, sound: number, x: number, z: number): void {
    let rec = -1;
    let free = -1;
    for (let r = 0; r < QUEUE_RECORDS; r++) {
      if (this.ambientOwner[r] === owner) {
        rec = r;
        break;
      }
      if (free < 0 && this.ambientOwner[r] === FREE) free = r;
    }
    if (rec < 0) rec = free;
    if (rec < 0) return;
    this.ambientOwner[rec] = owner;
    this.ambientSeen[rec] = 1;
    this.engine.queueSet(rec, sound, x, z);
  }

  // --- snapshot lookups -------------------------------------------------------

  /** World position (metres) of an entity into `this.pos`. */
  private locate(id: number, ctx: CueContext): boolean {
    const o = this.find(id, ctx);
    if (o < 0) return false;
    this.pos[0] = ctx.snapshot[o + S_X];
    this.pos[2] = ctx.snapshot[o + S_Y];
    return true;
  }

  private find(id: number, ctx: CueContext): number {
    for (let k = 0; k < ctx.count; k++) {
      const o = k * ctx.stride;
      if (ctx.snapshot[o + S_ID] === id) return o;
    }
    return -1;
  }

  private archetypeOf(id: number, ctx: CueContext): number {
    const o = this.find(id, ctx);
    return o < 0 ? -1 : ctx.snapshot[o + S_ARCH];
  }

  private teamOf(id: number, ctx: CueContext): number {
    const o = this.find(id, ctx);
    return o < 0 ? -1 : ctx.snapshot[o + S_TEAM];
  }

  private animOf(id: number, ctx: CueContext): number {
    const o = this.find(id, ctx);
    return o < 0 ? 0 : ctx.snapshot[o + S_ANIM];
  }

  private slotOfAvatar(id: number, ctx: CueContext): number {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (ctx.match[matchSlotOffset(p) + MATCH_SLOT_AVATAR_ID] === id) return p;
    }
    return this.teamOf(id, ctx);
  }
}

/** The type-98 row a turret or unit fires (fcop-fx.md §4, combat.md). */
function worldRow(archetype: number): number {
  switch (archetype) {
    case ARCHETYPE.TURRET:
    case ARCHETYPE.JUGGERNAUT:
      return 3;
    case ARCHETYPE.RUNNER:
    case ARCHETYPE.GUARDIAN:
      return 1;
    case ARCHETYPE.FORTRESS:
      return 4;
    default:
      return 0;
  }
}

function ambientOf(archetype: number, data: ArenaAudio): number {
  switch (archetype) {
    case ARCHETYPE.RUNNER:
      return data.ambient.tank;
    case ARCHETYPE.GUARDIAN:
      return data.ambient.jet;
    case ARCHETYPE.FORTRESS:
      return data.ambient.fortress;
    case ARCHETYPE.JUGGERNAUT:
      return data.ambient.dreadnought;
    case ARCHETYPE.WARDEN:
      return data.ambient.captain;
    default:
      return 0;
  }
}

/** The impact effect an explosion of `kind` installs, from its weapon's record. */
function impactOf(
  kind: number,
  weapons: Readonly<Record<number, PlayerWeaponSounds>>,
  data: ArenaAudio,
): { bank: number; id: number } | null {
  const code = PROJ_CODE[kind];
  if (code !== undefined) {
    const w = weapons[code];
    return w && w.a.impactFx > 0 ? { bank: 1, id: w.a.impactFx } : null;
  }
  const row = PROJ_WORLD_ROW[kind];
  if (row !== undefined) {
    const w = data.world[row];
    return w && w.impactFx > 0 ? { bank: 0, id: w.impactFx } : null;
  }
  return null;
}

/** weapons.ts PROJ_* -> the player weapon whose round it is. */
const PROJ_CODE: Readonly<Record<number, number>> = {
  1: 0x10, // PROJ_HEAVY: Hell Fire 2000
  6: 0x20, // PROJ_MORTAR
  7: 0x13, // PROJ_HYPER
  10: 0x22, // PROJ_MINE
  11: 0x23, // PROJ_SHOCKWAVE
  12: 0x12, // PROJ_BEAM
};
/** weapons.ts PROJ_* -> the world row whose round it is. */
const PROJ_WORLD_ROW: Readonly<Record<number, number>> = {
  3: 9, // PROJ_WARDEN: the captain's bomb
  14: 3, // PROJ_ROUND: a turret's (see the audio rows in fcop-fidelity.md)
};
