// What one arena's sounds are, beyond the bank: which script id each source
// plays and which effect records an impact or a death installs. Generated from
// the RE repo's tables (audio/fcopAudio.generated.ts); typed here.

import type { SoundBank } from "./bank";

/** One block of a player weapon's type-99 record, the bytes sound needs. */
export interface WeaponBlockSounds {
  /** Byte 0: the round's kind. 0x0a..0x0c and 0x0e take the direct path. */
  readonly kind: number;
  /** +0x1c: the fire sound's script id. */
  readonly sound: number;
  /** +0x1a: the impact effect (bank 1). */
  readonly impactFx: number;
  /** +0x1b: the flash / launch effect (bank 1). */
  readonly launchFx: number;
  /**
   * The kind its damage message carries, which the target's death mask
   * collects (0: none — rounds, missiles and blasts send no such message).
   */
  readonly hitKind: number;
}

export interface PlayerWeaponSounds {
  readonly a: WeaponBlockSounds;
  readonly b: WeaponBlockSounds;
}

/** One type-98 row: the world weapons turrets, units and the Sky Captain fire. */
export interface WorldWeaponSounds {
  /** +0x1c: fired through `snd_play_script_at` at the shooter. 0 = silent. */
  readonly sound: number;
  /** +0x1a: the impact effect (bank 0). */
  readonly impactFx: number;
  /** +0x1b: the launch effect (bank 0). */
  readonly launchFx: number;
}

/** One effect record (types 87..94) as `cact_effect_install` reads it. */
export interface EffectRecord {
  /** +0x16: the script id played when it installs, 0 none (table B). */
  readonly sound: number;
  /** The successor it installs, 0 none. */
  readonly next: number;
  /** The successor's delay in sim ticks (0: at once). */
  readonly delay: number;
  /** Ids 0x3d–0x44 and 0x64–0x76 play their sound at the player (0x0042d3d6). */
  readonly atPlayer: boolean;
}

/**
 * One class row of the effect table (type 91): what `cact_effect_emit`
 * (0x0042b910) raises for an actor of that class when it dies.
 */
export interface DeathClass {
  /** The effect bank: 0, the mech's 1. */
  readonly bank: number;
  /** The fallback id, raised instead of group 0's on the coin. */
  readonly fallback: number;
  /** Class flags bit 0 clear: group 0 may draw the fallback, one in two. */
  readonly alternate: boolean;
  /** Each group's id; group i (1..4) answers bit i of the death mask. */
  readonly groups: readonly number[];
}

/** One voice op the arena's scripts carry, and its rule (pa-voice.json). */
export interface VoiceRule {
  readonly trigger: string;
  /** 0 a mission function (polled), 1 an actor script (runs at once). */
  readonly script: number;
  /** 0 queue (op 0x0c), 1 interrupt (op 0x0d). */
  readonly op: number;
  /** The lines, one drawn uniformly. */
  readonly lines: readonly number[];
  /** The chance it plays when its gate passes. */
  readonly p: number;
  /** The function's poll period in sim ticks, 0 for an actor script. */
  readonly poll: number;
  /** Gated on, and re-arming, the captain's shared chatter cooldown. */
  readonly chatter: boolean;
  /** The function runs once a round. */
  readonly once: boolean;
  readonly outpost: number;
  readonly slot: number;
  /** Only in a one-viewport game (against the Sky Captain). */
  readonly oneViewport: boolean;
}

export interface ArenaAudio {
  /** The original's mission container, e.g. "Mp". */
  readonly mission: string;
  readonly bank: SoundBank;
  /** Type-98 rows by `weapon_id` (index 0 unused). */
  readonly world: readonly WorldWeaponSounds[];
  /** Ambient loop script ids (record body[29]) by what makes them. 0 = none. */
  readonly ambient: {
    readonly tank: number;
    readonly jet: number;
    readonly fortress: number;
    readonly dreadnought: number;
    readonly captain: number;
  };
  /** Effect records by bank (0 mission, 1 the player's GlblData bank), by id. */
  readonly effects: readonly [
    Readonly<Record<number, EffectRecord>>,
    Readonly<Record<number, EffectRecord>>,
  ];
  /** The class rows a death emits from, by what died, in class order. */
  readonly deaths: {
    readonly turret: readonly DeathClass[];
    readonly neutralTurret: readonly DeathClass[];
    readonly tank: readonly DeathClass[];
    readonly jet: readonly DeathClass[];
    readonly fortress: readonly DeathClass[];
    readonly dreadnought: readonly DeathClass[];
    readonly captain: readonly DeathClass[];
    readonly mech: readonly DeathClass[];
  };
  /** Prop sound emitters (type 96): metres in Metropolis' frame, script id. */
  readonly emitters: readonly { readonly x: number; readonly z: number; readonly sound: number }[];
  /** Every voice op of the arena's scripts. */
  readonly voice: readonly VoiceRule[];
  /** The arena's music URL. */
  readonly music: string;
}
