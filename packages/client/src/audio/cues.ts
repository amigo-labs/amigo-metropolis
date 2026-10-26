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
  ARCHETYPE_RADIUS,
  CAPTAIN_ORDER_DREADNOUGHT,
  CAPTAIN_ORDER_FORTRESS,
  CAPTAIN_ORDER_JETS,
  CAPTAIN_ORDER_TANKS,
  directionAxis,
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
  EV_KILL_PUSH,
  EV_LIFT_ARRIVE,
  EV_LOW_AMMO,
  EV_PICKUP,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_RESPAWN,
  EV_ROUND_IMPACT,
  EV_SHOT,
  EV_SUNK,
  EV_TRANSFORM,
  EV_TRANSFORM_REFUSED,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
  EVENT_STRIDE,
  type EventBuffer,
  LIFT_SNAP_MOVING,
  LIFT_SNAP_STRIDE,
  MATCH_SLOT_AVATAR_ID,
  MATCH_SLOT_HP_FRAC,
  MATCH_SLOT_MOVE,
  MAX_ENTITIES,
  MAX_PLAYERS,
  MOVE_CUE_BRAKE,
  MOVE_CUE_DRIVE,
  MOVE_CUE_TURN,
  MUZZLE_HEIGHT,
  MUZZLE_OFFSET,
  matchSlotOffset,
  PROJ_ROUND,
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
  shotPayloadToReach,
  shotPayloadWeaponId,
  shotPayloadWeaponReach,
  TURRET_CAPTURABLE,
  weaponById,
} from "@metropolis/sim";
import {
  EffectChain,
  type EffectListener,
  fxArenaFor,
  makeRaiseAt,
  type RaiseAt,
} from "../effects/chain";
import { DEFAULT_SCALE, type FxRecord, IMPACT_SCALE } from "../effects/records";
import { SIDE_BLUE, sideOfTeam } from "../render/sides";
import { X1_CODES_PER_TICK } from "../render/x1Walk";
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
/**
 * Kinds that launch a round (0x004590d0): every one but the direct path, the
 * sphere (0x0d), the shockwave on the mech (0x0f) and the aimed sustain (0x11).
 */
function roundKind(kind: number): boolean {
  return !directKind(kind) && kind !== 0x0d && kind !== 0x0f && kind !== 0x11;
}
/** `cact_registry_build`'s reach for the ambient queue: 0x22000 world units. */
const AMBIENT_RANGE_M = 0x22000 / 8192;
/** An ambient queue record nobody owns; emitters own keys from EMITTER_KEY down. */
const FREE = -1;
const EMITTER_KEY = -2;
/**
 * The emitters' voice table (snd/emitter.c): 32 slots; a claim holds its slot
 * 300 engine ticks, each frame it is drawn again 900; past that, a sound still
 * live in the queue is held 300 more, else let go (`snd_emit_tick` 0x0042f550,
 * `snd_emit_voice_follow` 0x00430100).
 */
const EMITTER_SLOTS = 32;
const EMITTER_HOLD_CLAIM = 300;
const EMITTER_HOLD_DRAWN = 900;
const EMITTER_HOLD_LIVE = 300;
/** Engine ticks a sim tick: the emitters' frame delta. */
const EMITTER_TICK_STEP = 10;
/** Lifts own ambient keys from LIFT_KEY down, clear of the emitters'. */
const LIFT_KEY = -1000;
/**
 * Every Precinct Assault lift's sounds (RE pa_rules.json `lifts`): the travel
 * script, held in the ambient queue while it moves, and the arrival script,
 * played once at the lift as it reaches a stop (`elevator.c`).
 */
const LIFT_TRAVEL_SCRIPT = 70;
const LIFT_ARRIVAL_SCRIPT = 71;
/** The loadout kinds whose +0x1b is not a round's (tables.json rules.kinds). */
const KIND_DIRECT_ELECTRIC = 0x0b;
const KIND_ATTACHED_SUSTAIN = 0x0e;
const KIND_SHOCKWAVE = 0x0f;
const KIND_AIMED_SUSTAIN = 0x11;
/** The sustains' countdowns, engine ticks (fcop/sustain.h: 0x32 attached, 0x96 aimed). */
const SUSTAIN_ATTACHED_TICKS = 0x32;
const SUSTAIN_AIMED_TICKS = 0x96;
/** Engine ticks a sim tick: the sustains count down by it. */
const ENGINE_TICKS_A_TICK = 10;
/**
 * The middle of each archetype's model above its snapshot height, metres
 * (half the native heights, render/greybox.ts): where a death's or an
 * entity's effect stands. Indexed like ARCHETYPE.
 */
const CENTRE_UP: readonly number[] = [0.5, 0.2, 0.2, 0.32, 0.34, 0.7, 0, 0.7, 0.2];
/** A round as a raiser: ARCHETYPE_RADIUS[PROJECTILE] (0.15 m) >> 4 in x16. */
const ROUND_SCALE = Math.round(0.15 * 512);
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
const S_HEIGHT = 5;
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
  /** The lifts' snapshot (writeLiftSnapshot), LIFT_SNAP_STRIDE per lift. */
  readonly lifts: Float32Array;
  /** The ground under (x, z), metres, for an effect with no height of its own. */
  readonly ground?: (x: number, z: number) => number;
  /**
   * The X1s' animation this tick (render/x1Walk.ts): each slot's form -- the
   * hover's tick runs through both ramps -- and the event codes its legs
   * passed, which drive the walker's movement loop (`snd_loop_set_mode`).
   */
  readonly walker?: WalkerLoops;
  /**
   * Per prop emitter (ArenaAudio.emitters), 1 where `snd_emit_draw_block` draws
   * it this tick: in the eye's 5 x 5 block of cells and on screen
   * (render/drawWindow.ts). Absent, the listener's 0x22000 stands in.
   */
  readonly emitterDrawn?: Uint8Array;
}

/** What the movement loop reads off the X1's animation, per player slot. */
export interface WalkerLoops {
  readonly owner: Int32Array;
  readonly form: Uint8Array;
  readonly codes: Uint8Array;
  readonly codeCount: Uint8Array;
}

/** One voice rule's state: armed by an event, polled on its own period. */
interface VoiceState {
  pending: boolean;
  countdown: number;
  spent: boolean;
}

/**
 * One axis of the killer's push (`mission_record_spawn_push` 0x00437aa0), x16
 * world units a second: the heading as a 16.16 word, `>> 4`, times the scale
 * `(i16)(damage << 3)` (`shl ax, 3`: a halfword, so it wraps), `>> 8`.
 */
export function killPush(axis: number, damage: number): number {
  const heading = Math.trunc(axis * 0x10000);
  const scale = ((damage << 3) << 16) >> 16;
  return ((heading >> 4) * scale) >> 8;
}

export class OriginalSounds implements EffectListener {
  private data: ArenaAudio | null = null;
  /** The Metropolis map id, for the side each team holds (render/sides.ts). */
  private mapId = "";
  private lifts: readonly { x: number; y: number }[] = [];
  private weapons: Readonly<Record<number, PlayerWeaponSounds>> = {};
  /** Per slot: the health gauge's state (2 full, 1 spending, 0 empty). */
  private readonly gauge = new Uint8Array(MAX_PLAYERS).fill(2);
  private readonly gaugeAvatar = new Int32Array(MAX_PLAYERS).fill(-1);
  /** Per slot: hover (1) or walker (0) as last seen, for the loop register. */
  private readonly form = new Int8Array(MAX_PLAYERS).fill(-1);
  /** Ambient queue record -> owner (entity id, or an emitter key). */
  private readonly ambientOwner = new Int32Array(QUEUE_RECORDS).fill(FREE);
  private readonly ambientSeen = new Uint8Array(QUEUE_RECORDS);
  /** Per prop emitter: its voice slot held, its countdown, its queue record. */
  private emitHeld = new Uint8Array(0);
  private emitCountdown = new Float64Array(0);
  private emitRecord = new Int16Array(0);
  /** Delayed effects: bank, id, x, z, ticks left (0 = free). */
  /** The placement of the raise being made (filled per call, never kept). */
  private readonly at = makeRaiseAt();
  /** The token the current shot's round rides until it is known (-1: no round). */
  private roundToken = -1;
  /** Per player slot: the sustained effect alive (a flame's, a beam's) and its countdown. */
  private readonly sustainFx = new Int16Array(MAX_PLAYERS);
  private readonly sustainLeft = new Float32Array(MAX_PLAYERS).fill(-1);
  /** Each actor's death mask: OR of the hit kinds its op-0x0e hits carried. */
  private readonly mask = new Uint8Array(MAX_ENTITIES);
  /**
   * The avatar this tick's EV_SUNK named (-1 none): its EV_DEATH, next in the
   * same tick, raises nothing — `player_op4` with the +0xde marker set.
   */
  private sunk = -1;
  /** This tick's EV_KILL_PUSH, for the EV_DEATH that follows it (-1 none). */
  private pushVictim = -1;
  private pushDir = 0;
  private pushDamage = 0;
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

  /**
   * The effect chain both the sounds and the picture hang off: every install
   * this class makes goes through it, and render/fx.ts listens on it too.
   */
  readonly effects: EffectChain;

  constructor(
    private readonly engine: AudioEngine,
    effects?: EffectChain,
  ) {
    this.effects = effects ?? new EffectChain();
    this.effects.addListener(this);
    // `cact_effect_install` drops an install no viewport is within 0x20000 of.
    this.effects.gate = (x, z) => this.engine.inRange(x, z);
  }

  /**
   * A new match on `data`'s arena, with its lifts (map.lifts: where each
   * stands). `mapId` is the map render/sides.ts reads a team's original side
   * from, which picks the side's world rows and death classes.
   */
  begin(
    data: ArenaAudio,
    weapons: Readonly<Record<number, PlayerWeaponSounds>>,
    lifts: readonly { x: number; y: number }[],
    mapId = "",
  ): void {
    this.data = data;
    this.mapId = mapId;
    this.weapons = weapons;
    this.lifts = lifts;
    this.gauge.fill(2);
    this.gaugeAvatar.fill(-1);
    this.form.fill(-1);
    this.ambientOwner.fill(FREE);
    this.emitHeld = new Uint8Array(data.emitters.length);
    this.emitCountdown = new Float64Array(data.emitters.length);
    this.emitRecord = new Int16Array(data.emitters.length).fill(-1);
    this.effects.begin(fxArenaFor(data.mission));
    this.sustainFx.fill(0);
    this.sustainLeft.fill(-1);
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
    this.sunk = -1;
    this.pushVictim = -1;
    const d = events.data;
    for (let i = 0; i < events.count; i++) {
      const o = i * EVENT_STRIDE;
      this.event(d[o], d[o + 1], d[o + 2], d[o + 3], ctx);
    }
    this.avatars(ctx);
    this.ambient(ctx);
    // The sustain nodes count down by the frame's delta (fcop/sustain.h).
    for (let p = 0; p < MAX_PLAYERS; p++) this.sustainLeft[p] -= ENGINE_TICKS_A_TICK;
    this.effects.tick();
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
        // Effect 4 (link 88 -> flash 89, bank 1) on the mech itself.
        if (this.atEntity(a, ctx, true)) this.raise(1, TRANSFORM_EFFECT);
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
      case EV_LIFT_ARRIVE: {
        const l = this.lifts[a];
        if (l) engine.playScript(LIFT_ARRIVAL_SCRIPT, true, l.x, l.y);
        return;
      }
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
      case EV_SUNK:
        this.sunk = a;
        return;
      case EV_KILL_PUSH:
        this.pushVictim = a;
        this.pushDir = b;
        this.pushDamage = c;
        return;
      case EV_DEATH:
        this.death(a, b, c, ctx);
        return;
      case EV_RESPAWN:
        this.respawn(b, ctx);
        return;
      case EV_EXPLOSION:
        this.explosion(a / 16, b / 16, c, ctx);
        return;
      case EV_ROUND_IMPACT: {
        // The round's death raises its class byte, the row's +0x1a, with the
        // round as the raiser (cact_effect_emit 0x0042b938).
        const side = sideOfTeam(this.mapId, roundSourceTeam(c));
        const w = this.data?.world[worldRow(roundSourceArchetype(c), side)];
        if (w) {
          this.atRound(a / 16, b / 16, ctx);
          this.raise(0, w.impactFx);
        }
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
      // A round the block launches carries its impact (+0x1a), raised in the
      // partner's bank, 1, at its death (effects/rounds.ts).
      this.roundToken = roundKind(blk.kind)
        ? this.launchToken(shooter, 0, ctx, BANK_PLAYER, blk.impactFx, shotPayloadPowered(c))
        : -1;
      const placed = player !== ctx.localSlot;
      const direct = directKind(blk.kind);
      if (direct) this.engine.playCued(placed ? 1 : 0, blk.sound, placed, x, z);
      else this.engine.playScript(blk.sound, placed, x, z);
      this.launchEffect(shooter, player, blk, shotPayloadWeaponReach(c) || w.range, ctx);
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
      row = worldRow(arch, sideOfTeam(this.mapId, this.teamOf(shooter, ctx)));
    }
    const w = data.world[row];
    if (!w || row === 0) return;
    if (w.sound !== 0) this.engine.playScript(w.sound, true, x, z);
    if (slot === SHOT_SLOT_HITSCAN) {
      // A hitscan (kind 0x0c) cancels the launch effect and raises the impact
      // where the line ends, at the impact's scale (cact_weapon_discharge
      // 0x0044dc86); its tracer is render/fx.ts's.
      if (!this.atMuzzle(shooter, ctx, false)) return;
      const reach = shotPayloadToReach(c);
      this.at.x += Math.cos(this.at.yaw) * reach;
      this.at.z += Math.sin(this.at.yaw) * reach;
      this.at.scale = IMPACT_SCALE;
      this.raise(0, w.impactFx);
      return;
    }
    // The launch effect rides the new round (0x0044df29), which also wears
    // the row's projectile model.
    if (!this.atMuzzle(shooter, ctx, false)) return;
    this.at.attach =
      slot === SHOT_SLOT_LAUNCH ? this.launchToken(shooter, row, ctx, BANK_WORLD, w.impactFx) : -1;
    this.raise(0, w.launchFx);
  }

  /**
   * A loadout block's +0x1b (player_fire 0x00458ed0): the direct path's
   * muzzle flash on the gun (the Electric Gun's a link to the line's end); the
   * flame's and the beam's sustained effect, raised once and held while the
   * weapon keeps firing (`sustain_attached_find` / `sustain_aimed_find`); the
   * shockwave's on the mech itself; every other kind's on the round it
   * launches (0x004593ec).
   */
  private launchEffect(
    shooter: number,
    player: number,
    blk: WeaponBlockSounds,
    reach: number,
    ctx: CueContext,
  ): void {
    const id = blk.launchFx;
    if (id <= 0) return;
    if (blk.kind === KIND_SHOCKWAVE) {
      if (this.atEntity(shooter, ctx, true)) this.raise(1, id);
      return;
    }
    if (!this.atMuzzle(shooter, ctx, true)) return;
    const hold =
      blk.kind === KIND_ATTACHED_SUSTAIN
        ? SUSTAIN_ATTACHED_TICKS
        : blk.kind === KIND_AIMED_SUSTAIN
          ? SUSTAIN_AIMED_TICKS
          : 0;
    if (hold > 0 && player >= 0 && player < MAX_PLAYERS) {
      // A live sustain is refreshed, not raised again.
      if (this.sustainFx[player] === id && this.sustainLeft[player] >= 0) {
        this.sustainLeft[player] = hold;
        this.effects.hold(1, id, shooter, hold);
        return;
      }
      this.sustainFx[player] = id;
      this.sustainLeft[player] = hold;
      this.at.hold = hold;
    }
    if (blk.kind === KIND_DIRECT_ELECTRIC) {
      this.at.endX = this.at.x + Math.cos(this.at.yaw) * reach;
      this.at.endY = this.at.y;
      this.at.endZ = this.at.z + Math.sin(this.at.yaw) * reach;
    }
    if (roundKind(blk.kind)) {
      this.at.attach = this.roundToken;
      this.at.attachForward = 0;
      this.at.attachUp = 0;
    }
    this.raise(1, id);
  }

  /**
   * Notes a launch from the shooter's muzzle (sim `spawnStraight`: MUZZLE_OFFSET
   * along its facing) for the next snapshot's new round, and returns the token
   * its launch effects ride until then.
   */
  private launchToken(
    shooter: number,
    row: number,
    ctx: CueContext,
    bank: number,
    impact: number,
    powered = false,
  ): number {
    const o = this.offsetOf(shooter);
    if (o < 0) return -1;
    const yaw = ctx.snapshot[o + S_YAW];
    const x = ctx.snapshot[o + S_X] + Math.cos(yaw) * MUZZLE_OFFSET;
    const z = ctx.snapshot[o + S_Y] + Math.sin(yaw) * MUZZLE_OFFSET;
    return this.effects.rounds.launch(x, z, row, bank, impact, powered, shooter);
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
    if (!this.atMuzzle(shooter, ctx, false)) return;
    this.at.x += Math.cos(this.at.yaw) * reach;
    this.at.z += Math.sin(this.at.yaw) * reach;
    // Context kind 5, scale word 0x800: the impact's 0x80 whatever the record says.
    this.at.scale = IMPACT_SCALE;
    // Raised here once; a body the same line hit adds nothing more.
    this.shotImpact[player] = -1;
    this.raise(1, blk.impactFx);
  }

  /** A damage message: the target's death mask, a direct line's impact, event 5. */
  private hit(target: number, attacker: number, ctx: CueContext): void {
    if (attacker < 0 || attacker >= MAX_PLAYERS) return;
    const k = this.shotKind[attacker];
    if (k > 1 && target >= 0 && target < MAX_ENTITIES) this.mask[target] |= k & MASK_BITS;
    const fx = this.shotImpact[attacker];
    if (fx > 0 && this.atEntity(target, ctx, false)) {
      this.shotImpact[attacker] = -1;
      this.at.scale = IMPACT_SCALE;
      this.raise(1, fx);
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
    // Its rounds still in flight have lost their owner (effects/rounds.ts).
    this.effects.rounds.died(victim);
    const data = this.data;
    if (!data) return;
    const team = this.teamOf(victim, ctx);
    let mask = 0;
    if (victim >= 0 && victim < MAX_ENTITIES) {
      mask = this.mask[victim];
      this.mask[victim] = 0;
    }
    // The death's raiser is the dying actor: its place, facing, model (the
    // shatter's) and scale (its radius >> 4).
    if (!this.atEntity(victim, ctx, false)) return;
    if (this.pushVictim === victim) {
      // `cact_base_op4`'s context (0x0041a30f..0x0041a330): the killer's
      // heading and its +0x1a, which the push turns into ((heading >> 4) *
      // scale) >> 8 with scale the halfword +0x1a << 3 (0x00437aa0).
      this.at.pushX = killPush(directionAxis(this.pushDir, 0), this.pushDamage);
      this.at.pushY = killPush(directionAxis(this.pushDir, 2), this.pushDamage);
      this.at.pushZ = killPush(directionAxis(this.pushDir, 1), this.pushDamage);
      this.pushVictim = -1;
    }
    const d = data.deaths;
    switch (archetype) {
      case ARCHETYPE.AVATAR: {
        // A sunk mech (HARD's deep water) goes down with no wreck, no death
        // effects and no wreck sound (fcop-fidelity.md P13).
        if (victim === this.sunk) return;
        this.emitDeath(d.mech[0], mask);
        for (const id of MECH_WRECK_EFFECTS) this.raise(1, id);
        this.playerScript(SCRIPT_WRECK, this.slotOfAvatar(victim, ctx), victim, ctx);
        return;
      }
      case ARCHETYPE.WARDEN:
        this.emitDeath(d.captain[captainClassIndex(ctx.captainLevel)], mask);
        // Its death script: flag 27 (the shot-down line) and the chatter cooldown.
        this.arm("captain_shot_down", -1, -1);
        this.chatterTimer = CHATTER_COOLDOWN_TICKS;
        return;
      case ARCHETYPE.TURRET: {
        const neutral = this.auxOf(victim) === TURRET_CAPTURABLE;
        this.emitDeath(neutral ? d.neutralTurret[0] : d.turret[0], mask);
        if (neutral && ctx.captainSlot >= 0 && team >= 0) {
          // Taken-turret death scoring: events 8 and 7 (0x0041bf03, 0x0041be82).
          if (team === ctx.captainSlot) this.word56 = 8;
          else if (killer === ctx.captainSlot) this.word56 = 7;
        }
        return;
      }
      case ARCHETYPE.RUNNER:
        this.emitDeath(d.tank[0], mask);
        return;
      case ARCHETYPE.GUARDIAN:
        this.emitDeath(d.jet[0], mask);
        return;
      case ARCHETYPE.JUGGERNAUT:
        // Class 202 (flash 61, orange) is side 1's, 203 (flash 68, blue) side 2's.
        this.emitDeath(
          d.dreadnought[sideOfTeam(this.mapId, team) === SIDE_BLUE ? 1 : 0] ?? d.dreadnought[0],
          mask,
        );
        this.arm("dreadnought_destroyed", team, -1, 1);
        return;
      case ARCHETYPE.FORTRESS:
        this.emitDeath(d.fortress[0], mask);
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
  private emitDeath(row: DeathClass | undefined, mask: number): void {
    if (!row) return;
    let raised = false;
    for (let g = 1; g <= 4; g++) {
      if ((mask & (1 << g)) === 0) continue;
      const id = row.groups[g] ?? 0;
      if (id === 0) continue;
      this.raise(row.bank, id);
      raised = true;
    }
    if (raised) return;
    let id = row.groups[0] ?? 0;
    if (row.alternate && Math.random() < 0.5) id = row.fallback;
    if (id !== 0) this.raise(row.bank, id);
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

  /**
   * A launched round's death (`cact_base_op4` -> `cact_effect_emit`
   * 0x0042b910): every launched round carries the direct flag 0x40000, so its
   * +0x20 — its block's +0x1a — is raised as the effect id itself (0x0042b92e),
   * no class row read, in its owner's bank (0x0042bf50: 1 for the player's
   * partner, 0 the Sky Captain's bomb). The round as the raiser. The id and
   * bank come with the round from its launch (effects/rounds.ts); a round
   * whose launch the client did not see (a burst's fragments, which are copies)
   * takes its kind's block A, or the bomb's row 9.
   */
  private explosion(x: number, z: number, kind: number, ctx: CueContext): void {
    const data = this.data;
    if (!data) return;
    const code = PROJ_CODE[kind];
    if (code !== undefined || kind === PROJ_WARDEN) {
      this.atRound(x, z, ctx);
      const rounds = this.effects.rounds;
      if (rounds.lastImpactId > 0) {
        this.raise(rounds.lastImpactBank, rounds.lastImpactId);
      } else if (code !== undefined) {
        const w = this.weapons[code];
        if (w) this.raise(BANK_PLAYER, w.a.impactFx);
      } else {
        this.raise(BANK_WORLD, data.world[9]?.impactFx ?? 0);
      }
      return;
    }
    // World rounds come with EV_ROUND_IMPACT.
    if (kind === PROJ_ROUND) {
      // Forget the round now, so an id it frees this tick reads as new.
      this.effects.rounds.impact(x, z, ctx.snapshot, ctx.count, ctx.stride);
    }
  }

  // --- the raise's placement ----------------------------------------------------

  /** `this.at` at a point (metres: x, height, z), riding nothing. */
  private atPoint(x: number, y: number, z: number): RaiseAt {
    const at = this.at;
    at.x = x;
    at.y = y;
    at.z = z;
    at.yaw = 0;
    at.attach = -1;
    at.attachForward = 0;
    at.attachUp = 0;
    at.scale = 0;
    at.raiserScale = DEFAULT_SCALE;
    at.endX = Number.NaN;
    at.endY = Number.NaN;
    at.endZ = Number.NaN;
    at.archetype = -1;
    at.modelY = Number.NaN;
    at.team = -1;
    at.repeat = false;
    at.hold = 0;
    at.pushX = 0;
    at.pushY = 0;
    at.pushZ = 0;
    return at;
  }

  /**
   * `this.at` on an entity: the middle of its model, its facing, its
   * archetype, team and scale (radius >> 4, x16) — riding it when `ride`.
   */
  private atEntity(id: number, ctx: CueContext, ride: boolean): boolean {
    const o = this.offsetOf(id);
    if (o < 0 || !this.locate(id)) return false;
    const snap = ctx.snapshot;
    const arch = snap[o + S_ARCH];
    const up = CENTRE_UP[arch] ?? 0;
    const at = this.atPoint(snap[o + S_X], snap[o + S_HEIGHT] + up, snap[o + S_Y]);
    at.yaw = snap[o + S_YAW];
    at.archetype = arch;
    at.modelY = snap[o + S_HEIGHT];
    at.team = snap[o + S_TEAM];
    at.raiserScale = Math.round((ARCHETYPE_RADIUS[arch] ?? 0.25) * 512) || DEFAULT_SCALE;
    if (ride) {
      at.attach = id;
      at.attachUp = up;
    }
    return true;
  }

  /**
   * `this.at` at an entity's muzzle: MUZZLE_OFFSET along its facing and
   * MUZZLE_HEIGHT up, where the sim launches its rounds — riding it when
   * `ride` (the gun block's point, context 0x60).
   */
  private atMuzzle(id: number, ctx: CueContext, ride: boolean): boolean {
    const o = this.offsetOf(id);
    if (o < 0 || !this.locate(id)) return false;
    const snap = ctx.snapshot;
    const yaw = snap[o + S_YAW];
    const at = this.atPoint(
      snap[o + S_X] + Math.cos(yaw) * MUZZLE_OFFSET,
      snap[o + S_HEIGHT] + MUZZLE_HEIGHT,
      snap[o + S_Y] + Math.sin(yaw) * MUZZLE_OFFSET,
    );
    at.yaw = yaw;
    if (ride) {
      at.attach = id;
      at.attachForward = MUZZLE_OFFSET;
      at.attachUp = MUZZLE_HEIGHT;
    }
    return true;
  }

  /**
   * `this.at` where a round died at (x, z): at the round's own height (the
   * tick's snapshot still holds it), the round the raiser.
   */
  private atRound(x: number, z: number, ctx: CueContext): void {
    const h = this.effects.rounds.impact(x, z, ctx.snapshot, ctx.count, ctx.stride);
    const ground = ctx.ground ? ctx.ground(x, z) : 0;
    this.atPoint(x, Number.isNaN(h) ? ground + MUZZLE_HEIGHT : h, z);
    this.at.raiserScale = ROUND_SCALE;
  }

  /**
   * `cact_effect_install` (0x0042d020) at `this.at`: the chain
   * (effects/chain.ts) drops it when no viewer is within 0x20000, installs it
   * — the record's sound below, its picture in render/fx.ts — and runs its
   * successors and repeats.
   */
  private raise(bank: number, id: number): void {
    this.effects.raise(bank, id, this.at);
  }

  /**
   * An install's sound: its +0x16, flat for the ids the install sends to the
   * player, else where the effect is. A type-94 record's repeat is a burst on
   * the same instance (its handler claims operation 1), not an install, so it
   * is silent.
   */
  install(bank: number, id: number, rec: FxRecord | undefined, at: Readonly<RaiseAt>): void {
    const sound = this.data?.effects[bank === 1 ? 1 : 0][id];
    if (!sound || sound.sound === 0) return;
    if (at.repeat && rec?.type === 94) return;
    this.engine.playScript(sound.sound, !sound.atPlayer, at.x, at.z);
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
      // The form whose tick runs: the animation's, which keeps the hover through
      // the ramp back (the sim's mode byte flips on the ramp's first tick).
      const walker = ctx.walker && ctx.walker.owner[p] === avatar ? ctx.walker : null;
      const hover = walker ? walker.form[p] === 1 : (this.animOf(avatar, ctx) & ANIM_HOVER) !== 0;
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
      if (!hover && walker) {
        // The walker's loop: every code its legs' tracks passed this tick, in
        // order (player_walk.c 704-706, 718-721; fcop-fidelity.md A9).
        const n = walker.codeCount[p];
        const at = p * X1_CODES_PER_TICK;
        for (let k = 0; k < n; k++) {
          this.engine.loopSetMode(viewport, walker.codes[at + k], placed, x, z);
        }
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
    this.emitters(ctx, data);
    // A moving lift holds its travel script, as a moving actor's does.
    for (let k = 0; k < this.lifts.length; k++) {
      const o = k * LIFT_SNAP_STRIDE + LIFT_SNAP_MOVING;
      if (o >= ctx.lifts.length || ctx.lifts[o] !== 1) continue;
      const l = this.lifts[k];
      if (!this.engine.within(l.x, l.y, AMBIENT_RANGE_M)) continue;
      this.queueAmbient(LIFT_KEY - k, LIFT_TRAVEL_SCRIPT, l.x, l.y);
    }
    for (let r = 0; r < QUEUE_RECORDS; r++) {
      if (this.ambientOwner[r] !== FREE && this.ambientSeen[r] === 0) this.ambientOwner[r] = FREE;
    }
  }

  /**
   * The prop emitters' voices (`snd_emit_tick`, then `snd_emit_draw_block` with
   * `snd_emit_voice_follow`): a drawn emitter claims one of the 32 slots and
   * queues its sound where it stands, or refreshes the slot it holds; a slot's
   * countdown runs on the frame delta, and once it is spent the voice is held
   * on while the queue still hears it, else let go. Only a drawn emitter
   * claims, so one that the eye has left keeps sounding while it is in range.
   */
  private emitters(ctx: CueContext, data: ArenaAudio): void {
    const drawn = ctx.emitterDrawn;
    let held = 0;
    for (let k = 0; k < data.emitters.length; k++) held += this.emitHeld[k];
    for (let k = 0; k < data.emitters.length; k++) {
      const e = data.emitters[k];
      if (this.emitHeld[k] !== 0) {
        this.emitCountdown[k] -= EMITTER_TICK_STEP;
        if (this.emitCountdown[k] < 0) {
          if (this.engine.queueLive(this.emitRecord[k])) {
            this.emitCountdown[k] = EMITTER_HOLD_LIVE;
          } else {
            this.emitHeld[k] = 0;
            this.emitRecord[k] = -1;
            held--;
          }
        }
      }
      const isDrawn = drawn ? drawn[k] !== 0 : this.engine.within(e.x, e.z, AMBIENT_RANGE_M);
      if (isDrawn) {
        if (this.emitHeld[k] !== 0) {
          this.emitCountdown[k] = EMITTER_HOLD_DRAWN;
        } else if (held < EMITTER_SLOTS) {
          const rec = this.queueAmbient(EMITTER_KEY - k, e.sound, e.x, e.z);
          if (rec >= 0) {
            this.emitHeld[k] = 1;
            this.emitCountdown[k] = EMITTER_HOLD_CLAIM;
            this.emitRecord[k] = rec;
            held++;
          }
        }
      }
      // A held voice keeps its queue record.
      if (this.emitHeld[k] !== 0) this.queueAmbient(EMITTER_KEY - k, e.sound, e.x, e.z);
    }
  }

  /** One sounding source into its queue record (found by owner, else a free one); -1 none. */
  private queueAmbient(owner: number, sound: number, x: number, z: number): number {
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
    if (rec < 0) return -1;
    this.ambientOwner[rec] = owner;
    this.ambientSeen[rec] = 1;
    this.engine.queueSet(rec, sound, x, z);
    return rec;
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
/** The type-98 row a world shooter fires: `side` is the original's (1 red, 2 blue). */
function worldRow(archetype: number, side: number): number {
  switch (archetype) {
    case ARCHETYPE.TURRET:
    case ARCHETYPE.JUGGERNAUT:
      return 3;
    case ARCHETYPE.RUNNER:
    case ARCHETYPE.GUARDIAN:
      // Side 1's tanks and jets fire row 1, side 2's row 6 (RE weapons.world users).
      return side === SIDE_BLUE ? 6 : 1;
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
  15: 0x15, // PROJ_K9: the K-9 Drone
  16: 0x24, // PROJ_GRENADE
  17: 0x14, // PROJ_TORPEDO: the Fusion Torpedo
  18: 0x21, // PROJ_PLASMA: the Plasma Flare
};
/** `cact_effect_bank` 0x0042bf50: the player's partner's bank, and every other owner's. */
const BANK_PLAYER = 1;
const BANK_WORLD = 0;
/** weapons.ts PROJ_WARDEN: the captain's bomb. */
const PROJ_WARDEN = 3;
