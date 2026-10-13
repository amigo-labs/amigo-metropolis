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
//   player_tick        0x00446fe5  transform: 21 and effect 4; refused (0x004421dc): 42
//   player_op4         0x00447610  the PA wreck: 65, effects 3 and 9 (bank 1)
//   player_hover_tick  0x0044267f  hover loop: 40 idle, 41 driving, 42 brake
//   cact_weapon_discharge 0x0044dfb4  world weapons: the row's +0x1c, at the shooter
//   cact_effect_install   0x0042d020  every effect: its +0x16, at it or at the player
//   cact_effect_emit      0x0042b910  a death's effects, by class, mask and coin
//   cact_registry_build   0x0043b520  ambient loops: each actor's body[29], queued
//   snd_emit_voice_follow 0x00430100  prop emitters, queued
//   mission_flush_pending_sound 0x00436250  63 accept / capture, 73 refuse, 83 pickup
//   Cfun ops 0x0c / 0x0d  speech, by the scripts' own rules (pa-voice.json)
//
// "Placed" follows the original's split-screen rule, which is also its network
// rule: a sound that belongs to the local player is heard flat, one that
// belongs to the other player is heard from where it happens.
//
// The random draws the original makes from its game stream (a death's coin,
// a script's dice) are drawn here from the client's own: they decide what is
// heard, never what happens, so they stay out of the lockstep sim.

import {
  ARCHETYPE,
  CAPTAIN_ORDER_DREADNOUGHT,
  CAPTAIN_ORDER_FORTRESS,
  CAPTAIN_ORDER_JETS,
  CAPTAIN_ORDER_TANKS,
  EV_ALARM,
  EV_BREACH,
  EV_CAPTAIN_EVENT,
  EV_CAPTAIN_MODE,
  EV_CAPTAIN_ORDER,
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
  EV_RESPAWN,
  EV_ROUND_IMPACT,
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
  MAX_ENTITIES,
  MAX_PLAYERS,
  MOVE_CUE_BRAKE,
  MOVE_CUE_DRIVE,
  MOVE_CUE_TURN,
  matchSlotOffset,
  roundSourceArchetype,
  roundSourceTeam,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  SHOT_SLOT_SPECIAL,
  SKY_MODE_DEFEND,
  SKY_MODE_ROAM,
  SKY_WEAPON_BOMB,
  SKY_WEAPON_MISSILE,
  shotPayloadPowered,
  shotPayloadWeaponId,
  shotPayloadWeaponReach,
  TURRET_CAPTURABLE,
  weaponById,
} from "@metropolis/sim";
import type {
  ArenaAudio,
  DeathClass,
  PlayerWeaponSounds,
  VoiceRule,
  WeaponBlockSounds,
} from "./arenaAudio";
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
/** The mech's own effects (bank 1): its wreck (player_op4) and the transform. */
const MECH_WRECK_EFFECTS = [3, 9] as const;
const TRANSFORM_EFFECT = 4;
/** Pending-sound slot values the scripts write. */
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
/** Delayed effect successors waiting to install. */
const MAX_PENDING_EFFECTS = 64;
/** An ambient queue record nobody owns; emitters own keys from EMITTER_KEY down. */
const FREE = -1;
const EMITTER_KEY = -2;
/** The death mask's bits (cact_base_op11): hit kinds 2, 4, 8, 16 -> groups 1..4. */
const MASK_BITS = 0x1e;
/** The captain's chatter cooldown: 180 of the scripts' 1/60 s = 3 s. */
const CHATTER_COOLDOWN_TICKS = 90;
/** fn55: line `74 + level - 1`, for a level of 1 and up. */
const LEVEL_LINE_BASE = 74;
/** The captain's level bands for its class rows 220..223 (sky_construct). */
function captainClassIndex(level: number): number {
  return level < 3 ? 0 : level < 6 ? 1 : level < 9 ? 2 : 3;
}

/** Snapshot entity fields (sim.ts writeSnapshot). */
const S_ID = 0;
const S_ARCH = 1;
const S_TEAM = 2;
const S_X = 3;
const S_Y = 4;
const S_YAW = 6;
const S_ANIM = 7;
const S_AUX = 9;
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
  /** The Sky Captain's level (0..9), for the announcement and its class. */
  readonly captainLevel: number;
}

/** One voice rule's state: armed by an event, polled on its own period. */
interface VoiceState {
  pending: boolean;
  countdown: number;
  spent: boolean;
}

export class OriginalSounds {
  private data: ArenaAudio | null = null;
  private weapons: Readonly<Record<number, PlayerWeaponSounds>> = {};
  /** Per slot: the health gauge's state (2 full, 1 spending, 0 empty). */
  private readonly gauge = new Uint8Array(MAX_PLAYERS).fill(2);
  private readonly gaugeAvatar = new Int32Array(MAX_PLAYERS).fill(-1);
  /** Per slot: hover (1) or walker (0) as last seen, for the loop register. */
  private readonly form = new Int8Array(MAX_PLAYERS).fill(-1);
  /** Ambient queue record -> owner (entity id, or an emitter key). */
  private readonly ambientOwner = new Int32Array(QUEUE_RECORDS).fill(FREE);
  private readonly ambientSeen = new Uint8Array(QUEUE_RECORDS);
  /** Delayed effects: bank, id, x, z, ticks left (0 = free). */
  private readonly fxBank = new Uint8Array(MAX_PENDING_EFFECTS);
  private readonly fxId = new Uint16Array(MAX_PENDING_EFFECTS);
  private readonly fxX = new Float32Array(MAX_PENDING_EFFECTS);
  private readonly fxZ = new Float32Array(MAX_PENDING_EFFECTS);
  private readonly fxLeft = new Int32Array(MAX_PENDING_EFFECTS);
  /** Each actor's death mask: OR of the hit kinds its op-0x0e hits carried. */
  private readonly mask = new Uint8Array(MAX_ENTITIES);
  /** Per player, this tick's direct-fire hit kind and pending impact effect. */
  private readonly shotKind = new Uint8Array(MAX_PLAYERS);
  private readonly shotImpact = new Int16Array(MAX_PLAYERS);
  private readonly pos = new Float32Array(3);
  /** id -> snapshot offset, rebuilt each tick. */
  private readonly index = new Int32Array(MAX_ENTITIES).fill(-1);
  // --- speech -----------------------------------------------------------------
  private voice: VoiceState[] = [];
  /** The captain's shared chatter cooldown (timer 10; Joke's and Slim's 12). */
  private chatterTimer = 0;
  /** State word 56: the captain's pending announcement, 0 none. */
  private word56 = 0;
  /** State word 39: the captain's mode, as its idle-chatter script reads it. */
  private captainMode = SKY_MODE_DEFEND;
  private levelLine = -1;
  private started = false;

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
    this.mask.fill(0);
    this.voice = data.voice.map((v) => ({ pending: false, countdown: v.poll, spent: false }));
    this.chatterTimer = 0;
    this.word56 = 0;
    // sky_construct leaves the captain defending (mode 2).
    this.captainMode = SKY_MODE_DEFEND;
    this.started = false;
  }

  /** One tick's events, then the per-tick state the original reads each frame. */
  tick(events: EventBuffer, ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    this.buildIndex(ctx);
    if (!this.started) {
      this.started = true;
      if (ctx.captainSlot >= 0) {
        this.levelLine = ctx.captainLevel >= 1 ? LEVEL_LINE_BASE + ctx.captainLevel - 1 : -1;
        this.arm("captain_level_announce", -1, -1);
        // sky_construct posts the free opening order into the base's tank and
        // jet words (level 1 and up), which their scripts announce.
        if (ctx.captainLevel >= 1) {
          this.arm("captain_orders_tanks", -1, -2);
          this.arm("captain_orders_jets", -1, -2);
        }
      }
    }
    this.shotKind.fill(0);
    this.shotImpact.fill(-1);
    const d = events.data;
    for (let i = 0; i < events.count; i++) {
      const o = i * EVENT_STRIDE;
      this.event(d[o], d[o + 1], d[o + 2], d[o + 3], ctx);
    }
    this.avatars(ctx);
    this.ambient(ctx);
    this.delayedEffects();
    this.voiceTick(ctx);
    this.engine.frame();
  }

  // --- events ------------------------------------------------------------------

  private event(type: number, a: number, b: number, c: number, ctx: CueContext): void {
    const engine = this.engine;
    switch (type) {
      case EV_SHOT:
        this.shot(a, b, c, ctx);
        return;
      case EV_HIT:
        this.hit(a, b, ctx);
        return;
      case EV_DRY_FIRE:
        this.playerScript(SCRIPT_EMPTY, b, a, ctx);
        return;
      case EV_LOW_AMMO:
        this.playerScript(SCRIPT_LOW, b, a, ctx);
        return;
      case EV_TRANSFORM:
        this.playerScript(SCRIPT_TRANSFORM, this.slotOfAvatar(a, ctx), a, ctx);
        if (this.locate(a)) this.installEffect(1, TRANSFORM_EFFECT, this.pos[0], this.pos[2]);
        return;
      case EV_TRANSFORM_REFUSED:
        this.playerScript(SCRIPT_TRANSFORM_REFUSED, b, a, ctx);
        return;
      case EV_PURCHASE:
        // A human's purchase spot answers its key press (accept 63) and the
        // heavy spots speak; the Sky Captain buys through its request words
        // (EV_CAPTAIN_ORDER).
        if (b !== ctx.captainSlot) {
          engine.setPending(PENDING_ACCEPT);
          if (c === ARCHETYPE.JUGGERNAUT) this.arm("dreadnought_bought", b, -1, 1);
          else if (c === ARCHETYPE.FORTRESS) this.arm("flying_fortress_bought", b, -1, 1);
        }
        return;
      case EV_CAPTAIN_ORDER:
        this.captainOrder(b, c);
        return;
      case EV_PURCHASE_REFUSED:
        engine.setPending(PENDING_REFUSE);
        return;
      case EV_CAPTURE:
        // turret_op10 runs the capture script, which writes the same 63.
        engine.setPending(PENDING_ACCEPT);
        if (b === ctx.captainSlot) this.word56 = 6; // 0x0041cbdd
        return;
      case EV_PICKUP:
        // The ItemPickup's death script.
        engine.setPending(PENDING_PICKUP);
        return;
      case EV_CLAIM:
        this.claim(b, c, ctx);
        return;
      case EV_TURRET_LOST:
        this.arm("base_turret_destroyed", b, -1, 1);
        return;
      case EV_ALARM:
        this.arm("base_intrusion", c, -1);
        return;
      case EV_TURRET_UNDER_FIRE:
        this.arm("base_turret_under_fire", b, -1);
        return;
      case EV_BREACH:
        // b is the winner; the overrun base is the loser's.
        this.arm("base_overrun", b === 0 ? 1 : 0, -1);
        this.arm(b === 0 ? "captain_loses" : "captain_wins", -1, -1);
        return;
      case EV_DEATH:
        this.death(a, b, c, ctx);
        return;
      case EV_RESPAWN:
        this.respawn(b, ctx);
        return;
      case EV_EXPLOSION:
        this.explosion(a / 16, b / 16, c);
        return;
      case EV_ROUND_IMPACT: {
        const w = this.data?.world[worldRow(roundSourceArchetype(c), roundSourceTeam(c))];
        if (w) this.installEffect(0, w.impactFx, a / 16, b / 16);
        return;
      }
      case EV_CAPTAIN_MODE:
        // The decision pass's switch into mode 1 is event 1 (0x00421042).
        if (b === 1 && this.captainMode !== 1) this.word56 = 1;
        this.captainMode = b;
        return;
      case EV_CAPTAIN_EVENT:
        this.word56 = b;
        return;
      default:
        return;
    }
  }

  private shot(shooter: number, slot: number, c: number, ctx: CueContext): void {
    const data = this.data;
    if (!data || !this.locate(shooter)) return;
    const x = this.pos[0];
    const z = this.pos[2];
    if (slot <= SHOT_SLOT_SPECIAL) {
      const player = this.slotOfAvatar(shooter, ctx);
      const w = weaponById(shotPayloadWeaponId(c));
      const rec = w ? this.weapons[w.code] : undefined;
      if (!w || !rec) return;
      const blk = shotPayloadPowered(c) ? rec.b : rec.a;
      const placed = player !== ctx.localSlot;
      const direct = directKind(blk.kind);
      if (direct) this.engine.playCued(placed ? 1 : 0, blk.sound, placed, x, z);
      else this.engine.playScript(blk.sound, placed, x, z);
      this.installEffect(1, blk.launchFx, x, z);
      if (player >= 0 && player < MAX_PLAYERS) {
        this.shotKind[player] = blk.hitKind;
        this.shotImpact[player] = direct ? blk.impactFx : -1;
        if (direct) this.lineEnd(player, shooter, shotPayloadWeaponReach(c), w.range, blk, ctx);
      }
      return;
    }
    // A world weapon: the row's sound and launch effect at the shooter.
    const arch = this.archetypeOf(shooter, ctx);
    let row = 0;
    if (arch === ARCHETYPE.WARDEN) {
      if (slot === SHOT_SLOT_HITSCAN) row = 7;
      else if (c === SKY_WEAPON_MISSILE) row = 8;
      else if (c === SKY_WEAPON_BOMB) row = 9;
    } else if (slot === SHOT_SLOT_LAUNCH) {
      row = worldRow(arch, this.teamOf(shooter, ctx));
    }
    const w = data.world[row];
    if (!w || row === 0) return;
    if (w.sound !== 0) this.engine.playScript(w.sound, true, x, z);
    this.installEffect(0, w.launchFx, x, z);
  }

  /**
   * The direct path raises its impact where the line ended when it reached a
   * point: a body it hit (`hit`, below) or a wall short of its reach. A line
   * that ran its full length into nothing raises none.
   */
  private lineEnd(
    player: number,
    shooter: number,
    reach: number,
    range: number,
    blk: WeaponBlockSounds,
    ctx: CueContext,
  ): void {
    if (reach <= 0 || reach >= range - 0.05) return;
    const o = this.offsetOf(shooter);
    if (o < 0) return;
    const yaw = ctx.snapshot[o + S_YAW];
    const x = ctx.snapshot[o + S_X] + Math.cos(yaw) * reach;
    const z = ctx.snapshot[o + S_Y] + Math.sin(yaw) * reach;
    // Raised here once; a body the same line hit adds nothing more.
    this.shotImpact[player] = -1;
    this.installEffect(1, blk.impactFx, x, z);
  }

  /** A damage message: the target's death mask, a direct line's impact, event 5. */
  private hit(target: number, attacker: number, ctx: CueContext): void {
    if (attacker < 0 || attacker >= MAX_PLAYERS) return;
    const k = this.shotKind[attacker];
    if (k > 1 && target >= 0 && target < MAX_ENTITIES) this.mask[target] |= k & MASK_BITS;
    const fx = this.shotImpact[attacker];
    if (fx > 0 && this.locate(target)) {
      this.shotImpact[attacker] = -1;
      this.installEffect(1, fx, this.pos[0], this.pos[2]);
    }
    // Every hit by player slot 0 on the captain rewrites word 56 (0x00421164).
    if (attacker === 0 && this.archetypeOf(target, ctx) === ARCHETYPE.WARDEN) this.word56 = 5;
  }

  /** `snd_play_script(id, actor)` for a player's own mech. */
  private playerScript(id: number, player: number, avatar: number, ctx: CueContext): void {
    const placed = player !== ctx.localSlot;
    if (placed && ownViewOnly(id)) return;
    if (placed && !this.locate(avatar)) return;
    this.engine.playScript(id, placed, this.pos[0], this.pos[2]);
  }

  private death(victim: number, killer: number, archetype: number, ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    const team = this.teamOf(victim, ctx);
    let mask = 0;
    if (victim >= 0 && victim < MAX_ENTITIES) {
      mask = this.mask[victim];
      this.mask[victim] = 0;
    }
    if (!this.locate(victim)) return;
    const x = this.pos[0];
    const z = this.pos[2];
    const d = data.deaths;
    switch (archetype) {
      case ARCHETYPE.AVATAR: {
        this.emitDeath(d.mech[0], mask, x, z);
        for (const id of MECH_WRECK_EFFECTS) this.installEffect(1, id, x, z);
        this.playerScript(SCRIPT_WRECK, this.slotOfAvatar(victim, ctx), victim, ctx);
        return;
      }
      case ARCHETYPE.WARDEN:
        this.emitDeath(d.captain[captainClassIndex(ctx.captainLevel)], mask, x, z);
        // Its death script: flag 27 (the shot-down line) and the chatter cooldown.
        this.arm("captain_shot_down", -1, -1);
        this.chatterTimer = CHATTER_COOLDOWN_TICKS;
        return;
      case ARCHETYPE.TURRET: {
        const neutral = this.auxOf(victim) === TURRET_CAPTURABLE;
        this.emitDeath(neutral ? d.neutralTurret[0] : d.turret[0], mask, x, z);
        if (neutral && ctx.captainSlot >= 0 && team >= 0) {
          // Taken-turret death scoring: events 8 and 7 (0x0041bf03, 0x0041be82).
          if (team === ctx.captainSlot) this.word56 = 8;
          else if (killer === ctx.captainSlot) this.word56 = 7;
        }
        return;
      }
      case ARCHETYPE.RUNNER:
        this.emitDeath(d.tank[0], mask, x, z);
        return;
      case ARCHETYPE.GUARDIAN:
        this.emitDeath(d.jet[0], mask, x, z);
        return;
      case ARCHETYPE.JUGGERNAUT:
        this.emitDeath(d.dreadnought[team === 1 ? 1 : 0] ?? d.dreadnought[0], mask, x, z);
        this.arm("dreadnought_destroyed", team, -1, 1);
        return;
      case ARCHETYPE.FORTRESS:
        this.emitDeath(d.fortress[0], mask, x, z);
        this.arm("flying_fortress_destroyed", team, -1, 1);
        return;
      default:
        return;
    }
  }

  /**
   * `cact_effect_emit` (0x0042b910) in mode 2: each group whose bit the death
   * mask carries raises its id; none raised falls back to group 0, which draws
   * the class's fallback instead on an odd coin when its flags allow.
   */
  private emitDeath(row: DeathClass | undefined, mask: number, x: number, z: number): void {
    if (!row) return;
    let raised = false;
    for (let g = 1; g <= 4; g++) {
      if ((mask & (1 << g)) === 0) continue;
      const id = row.groups[g] ?? 0;
      if (id === 0) continue;
      this.installEffect(row.bank, id, x, z);
      raised = true;
    }
    if (raised) return;
    let id = row.groups[0] ?? 0;
    if (row.alternate && Math.random() < 0.5) id = row.fallback;
    if (id !== 0) this.installEffect(row.bank, id, x, z);
  }

  private respawn(player: number, ctx: CueContext): void {
    if (player < 0) return;
    if (player === ctx.captainSlot) {
      this.word56 = 9; // sky_respawn 0x00422cc6
      this.captainMode = SKY_MODE_ROAM;
    } else if (player === 0 && ctx.captainSlot >= 0) {
      // Player slot 0's reloc_28 runs at the respawn and sets flag 22: the gloat.
      this.arm("captain_gloats_player_down", -1, -1);
    }
  }

  private explosion(x: number, z: number, kind: number): void {
    const data = this.data;
    if (!data) return;
    const code = PROJ_CODE[kind];
    if (code !== undefined) {
      const w = this.weapons[code];
      if (w) this.installEffect(1, w.a.impactFx, x, z);
      return;
    }
    // The captain's bomb (row 9); world rounds come with EV_ROUND_IMPACT.
    if (kind === PROJ_WARDEN) this.installEffect(0, data.world[9]?.impactFx ?? 0, x, z);
  }

  /**
   * `cact_effect_install` (0x0042d020): dropped outright when no viewer is
   * within 0x20000; otherwise the record's sound — flat for the ids the
   * install sends to the player, else where the effect is — and its successor,
   * at once or after its delay.
   */
  private installEffect(bank: number, id: number, x: number, z: number, depth = 0): void {
    const data = this.data;
    if (!data || id <= 0 || depth > 12) return;
    if (!this.engine.inRange(x, z)) return;
    const rec = data.effects[bank === 1 ? 1 : 0][id];
    if (!rec) return;
    if (rec.sound !== 0) this.engine.playScript(rec.sound, !rec.atPlayer, x, z);
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
      if (this.fxLeft[i] === 0) {
        this.installEffect(this.fxBank[i], this.fxId[i], this.fxX[i], this.fxZ[i]);
      }
    }
  }

  // --- speech --------------------------------------------------------------------

  private captainOrder(kind: number, outpost: number): void {
    // Its base's words carry no outpost: -2 picks the rule without one.
    const at = outpost < 0 ? -2 : outpost;
    if (kind === CAPTAIN_ORDER_TANKS) this.arm("captain_orders_tanks", -1, at);
    else if (kind === CAPTAIN_ORDER_JETS) this.arm("captain_orders_jets", -1, at);
    else if (kind === CAPTAIN_ORDER_DREADNOUGHT) this.arm("dreadnought_bought", -1, -1, 0);
    else if (kind === CAPTAIN_ORDER_FORTRESS) this.arm("flying_fortress_bought", -1, -1, 0);
  }

  private claim(team: number, outpost: number, ctx: CueContext): void {
    if (team === ctx.captainSlot) {
      // fn22..25: the outpost's line and the captain's own chatter.
      this.arm("outpost_bought", -1, outpost, 0);
      this.arm("captain_chatter_outpost_bought", -1, outpost);
      return;
    }
    // The pad's actor script: the outpost's line for the claiming slot.
    this.arm("outpost_bought", team, outpost, 1);
    // fn40: player slot 0's claim zone sets flag 23.
    if (team === 0) this.arm("captain_chatter_player_claimed_outpost", -1, -1);
  }

  /**
   * Arms every rule of `trigger` that matches `slot` (-1 any), `outpost` (-1
   * any, -2 only a rule without one) and the kind of script (-1 either).
   * Actor scripts speak at once; mission functions on their next poll.
   */
  private arm(trigger: string, slot: number, outpost: number, script = -1): void {
    const data = this.data;
    if (!data) return;
    const rules = data.voice;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.trigger !== trigger) continue;
      if (script >= 0 && r.script !== script) continue;
      if (slot >= 0 && r.slot >= 0 && r.slot !== slot) continue;
      if (outpost === -2 && r.outpost >= 0) continue;
      if (outpost >= 0 && r.outpost >= 0 && r.outpost !== outpost) continue;
      if (r.poll <= 0) this.say(r, i);
      else this.voice[i].pending = true;
    }
  }

  /**
   * Once a tick: the chatter cooldown runs down and every mission function
   * polls on its own period (the scripts' repeating calls). A pending rule
   * whose gate passes rolls its chance; the cooldown gates and re-arms the
   * captain's chatter. The captain's announcement (word 56) is one slot each
   * new event overwrites, taken by its function when its gate passes; the
   * idle chatter polls the captain's mode.
   */
  private voiceTick(ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    if (this.chatterTimer > 0) this.chatterTimer--;
    const solo = ctx.captainSlot >= 0;
    const rules = data.voice;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.poll <= 0) continue;
      const st = this.voice[i];
      if (--st.countdown > 0) continue;
      st.countdown = r.poll;
      if (st.spent || (r.oneViewport && !solo)) continue;
      const event = CAPTAIN_EVENT_RULES[r.trigger];
      if (event !== undefined) {
        if (this.word56 !== event) continue;
        if (r.chatter && this.chatterTimer > 0) continue; // stays pending
        this.word56 = 0;
        this.say(r, i);
        continue;
      }
      if (r.trigger === "captain_idle_chatter") {
        if (this.captainMode !== SKY_MODE_ROAM || this.chatterTimer > 0) continue;
        this.say(r, i);
        continue;
      }
      if (!st.pending) continue;
      st.pending = false;
      if (r.chatter && this.chatterTimer > 0) continue; // consumed, not said
      this.say(r, i);
    }
  }

  /** The rule's dice, its line, and what it leaves behind. */
  private say(r: VoiceRule, i: number): void {
    const st = this.voice[i];
    if (r.once) st.spent = true;
    if (r.trigger === "captain_level_announce") {
      if (this.levelLine >= 0) this.engine.speak(this.levelLine);
      return;
    }
    if (Math.random() >= r.p) return;
    const line = r.lines[Math.floor(Math.random() * r.lines.length)];
    if (line === undefined) return;
    if (r.op === 1) this.engine.speakNow(line);
    else this.engine.speak(line);
    if (r.chatter) this.chatterTimer = CHATTER_COOLDOWN_TICKS;
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
      if (!this.locate(avatar)) continue;
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
        // The walker end of a transform: `snd_loop_set_script(0xff)`. The
        // walker's own loop follows its leg animation's event codes, which
        // waits on the X1's animations (fcop-fidelity.md, audio rows).
        this.engine.loopSetScript(viewport, LOOP_SCRIPT_NONE, placed, x, z);
      }
      this.form[p] = hover ? 1 : 0;
      if (placed) this.engine.loopFollow(viewport, x, z);
    }
  }

  /**
   * `player_gauge_set`: the health gauge's ceiling is a third of the maximum.
   * Falling under it from full plays the gauge's sound (script 14), reaching
   * zero from there plays it again; refilling to the ceiling is silent.
   */
  private gaugeTick(p: number, avatar: number, hpFrac: number, placed: boolean): void {
    if (this.gaugeAvatar[p] !== avatar) {
      this.gaugeAvatar[p] = avatar;
      this.gauge[p] = 2;
    }
    if (hpFrac >= 1 / 3) {
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
   * within 0x22000 of the listener is queued; prop emitters (type 96) too. The
   * engine's queue gives the eight loudest a channel.
   */
  private ambient(ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    this.ambientSeen.fill(0);
    for (let k = 0; k < ctx.count; k++) {
      const o = k * ctx.stride;
      const sound = ambientOf(ctx.snapshot[o + S_ARCH], data);
      if (sound === 0) continue;
      const x = ctx.snapshot[o + S_X];
      const z = ctx.snapshot[o + S_Y];
      if (!this.engine.within(x, z, AMBIENT_RANGE_M)) continue;
      this.queueAmbient(ctx.snapshot[o + S_ID], sound, x, z);
    }
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

  private ctxSnapshot: Float32Array | null = null;

  private buildIndex(ctx: CueContext): void {
    this.ctxSnapshot = ctx.snapshot;
    this.index.fill(-1);
    for (let k = 0; k < ctx.count; k++) {
      const o = k * ctx.stride;
      const id = ctx.snapshot[o + S_ID];
      if (id >= 0 && id < MAX_ENTITIES) this.index[id] = o;
    }
  }

  private offsetOf(id: number): number {
    return id >= 0 && id < MAX_ENTITIES ? this.index[id] : -1;
  }

  /** World position (metres) of an entity into `this.pos`. */
  private locate(id: number): boolean {
    const o = this.offsetOf(id);
    const snap = this.ctxSnapshot;
    if (o < 0 || !snap) return false;
    this.pos[0] = snap[o + S_X];
    this.pos[2] = snap[o + S_Y];
    return true;
  }

  private archetypeOf(id: number, ctx: CueContext): number {
    const o = this.offsetOf(id);
    return o < 0 ? -1 : ctx.snapshot[o + S_ARCH];
  }

  private teamOf(id: number, ctx: CueContext): number {
    const o = this.offsetOf(id);
    return o < 0 ? -1 : ctx.snapshot[o + S_TEAM];
  }

  private animOf(id: number, ctx: CueContext): number {
    const o = this.offsetOf(id);
    return o < 0 ? 0 : ctx.snapshot[o + S_ANIM];
  }

  private auxOf(id: number): number {
    const o = this.offsetOf(id);
    const snap = this.ctxSnapshot;
    return o < 0 || !snap ? -1 : snap[o + S_AUX];
  }

  private slotOfAvatar(id: number, ctx: CueContext): number {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (ctx.match[matchSlotOffset(p) + MATCH_SLOT_AVATAR_ID] === id) return p;
    }
    return this.teamOf(id, ctx);
  }
}

/** The captain's event word values each poller takes (fn46..fn54). */
const CAPTAIN_EVENT_RULES: Readonly<Record<string, number>> = {
  captain_pushes_on_player_base: 1,
  captain_fires_on_player: 2,
  captain_hunts_hurt_player: 3,
  captain_repaired: 4,
  player_hit_captain: 5,
  captain_captured_turret: 6,
  captain_destroyed_player_turret: 7,
  player_side_destroyed_captain_turret: 8,
  captain_respawned: 9,
};

/**
 * The type-98 row a shooter fires (the arenas' shooter records): turrets and
 * the Dreadnought's guns 3, the first side's tanks and jets 1, the second's 6,
 * the Flying Fortress 4, the captain's missile 8.
 */
function worldRow(archetype: number, team: number): number {
  switch (archetype) {
    case ARCHETYPE.TURRET:
    case ARCHETYPE.JUGGERNAUT:
      return 3;
    case ARCHETYPE.RUNNER:
    case ARCHETYPE.GUARDIAN:
      return team === 1 ? 6 : 1;
    case ARCHETYPE.FORTRESS:
      return 4;
    case ARCHETYPE.WARDEN:
      return 8;
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

/** weapons.ts PROJ_* -> the player weapon whose round it is. */
const PROJ_CODE: Readonly<Record<number, number>> = {
  1: 0x10, // PROJ_HEAVY: Hell Fire 2000
  6: 0x20, // PROJ_MORTAR
  7: 0x13, // PROJ_HYPER
  10: 0x22, // PROJ_MINE
  11: 0x23, // PROJ_SHOCKWAVE
  12: 0x12, // PROJ_BEAM
};
/** weapons.ts PROJ_WARDEN: the captain's bomb. */
const PROJ_WARDEN = 3;
