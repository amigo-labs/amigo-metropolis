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
}

/** Ids 0x3d–0x44 and 0x64–0x76 play "at the player" (0x0042d020). */
export function effectAtPlayer(id: number): boolean {
  return (id >= 0x3d && id <= 0x44) || (id >= 0x64 && id <= 0x76);
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
  /** The effect ids a death installs, by what died (bank 0; the mech's bank 1). */
  readonly deaths: {
    readonly turret: readonly number[];
    readonly neutralTurret: readonly number[];
    readonly tank: readonly number[];
    readonly jet: readonly number[];
    readonly fortress: readonly number[];
    readonly dreadnought: readonly number[];
    readonly mech: readonly number[];
  };
  /** Prop sound emitters (type 96): metres in Metropolis' frame, script id. */
  readonly emitters: readonly { readonly x: number; readonly z: number; readonly sound: number }[];
  /** The arena's music URL. */
  readonly music: string;
}
