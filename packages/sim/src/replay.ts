// Replay byte format. A replay is {mapId, seed, version, inputFrames[]}
// (architecture.md §6) plus, since format 2, the match's Warden config — the
// AI runs inside the sim, so replay-stable AI matches need it in the header —
// since format 4, each player's difficulty and, since format 5, the extra
// weapons the match offers and each player's loadout. The per-tick frame encoding
// doubles as the network input-frame format (§5), so this file defines it
// exactly once.
//
// Little-endian layout (format 5):
//   offset 0  u8×4  magic "MREP"
//          4  u16   format version (5)
//          6  u16   simVersion the replay was recorded against
//          8  u32   seed
//         12  u32   tickCount
//         16  u8    wardenPlayer (0xff = no Warden)
//         17  u8    wardenDifficulty (0 when no Warden)
//         18  u8×MAX_PLAYERS  difficulty per player (balance.ts DIFFICULTY_*:
//                   0 HARD, 1 NORMAL, 2 EASY; the Warden's slot reads none)
//         20  u8    extraWeapons (SimOptions.extraWeapons, weapons.ts EXTRA_WEAPON_*)
//         21  u8×3×MAX_PLAYERS  loadout per player: gun, heavy, special index
//         27  u8    mapId byte length, followed by that many ASCII bytes
//   then tickCount frames of MAX_PLAYERS × 2 bytes:
//         buttons u16 (the original's button word, inputs.ts)
// Formats 1 and 2 carried stick and aim axes (5 bytes a player), which no sim
// since SIM_VERSION 68 reads; format 3 carried no difficulty, which every sim
// since SIM_VERSION 72 reads; format 4 carried neither the extra weapons nor
// the loadouts, which a match since SIM_VERSION 90 may need. All four are refused.

import { DIFFICULTY_NORMAL, DIFFICULTY_ROWS, MAX_PLAYERS } from "./balance";
import type { TickInputs } from "./inputs";
import { SIM_VERSION } from "./version";
import {
  DEFAULT_LOADOUT,
  EXTRA_WEAPONS_ALL,
  GUNS,
  HEAVIES,
  type Loadout,
  SPECIALS,
} from "./weapons";

export const REPLAY_FORMAT_VERSION = 5;
const MAGIC = [0x4d, 0x52, 0x45, 0x50]; // "MREP"
/** Header offset of the per-player difficulty bytes (format 4). */
const DIFFICULTIES_AT = 18;
/** Header offset of the extra-weapons byte, then the loadouts (format 5). */
const EXTRA_AT = DIFFICULTIES_AT + MAX_PLAYERS;
const LOADOUTS_AT = EXTRA_AT + 1;
/** Header offset of the mapId's length byte. */
const MAP_ID_AT = LOADOUTS_AT + 3 * MAX_PLAYERS;
const PLAYER_BYTES = 2;
export const FRAME_BYTES = MAX_PLAYERS * PLAYER_BYTES;

export interface ReplayData {
  readonly formatVersion: number;
  readonly simVersion: number;
  readonly seed: number;
  readonly mapId: string;
  readonly tickCount: number;
  /** Player slot driven by the Warden AI, -1 for a match without one. */
  readonly wardenPlayer: number;
  /** Warden difficulty 1–10; 0 when wardenPlayer is -1. */
  readonly wardenDifficulty: number;
  /** Each player's difficulty (DIFFICULTY_*), MAX_PLAYERS entries. */
  readonly difficulties: readonly number[];
  /** SimOptions.extraWeapons: the original's five extra weapons the match offers. */
  readonly extraWeapons: number;
  /** Each player's loadout (catalogue indices), MAX_PLAYERS entries. */
  readonly loadouts: readonly Loadout[];
  /** Raw frame bytes, tickCount * FRAME_BYTES. */
  readonly frames: Uint8Array;
}

/** Match config carried by replays and passed to createSim. */
export interface WardenConfig {
  readonly player: number;
  readonly difficulty: number;
}

/** Every player NORMAL, the original's default pick. */
export const DEFAULT_DIFFICULTIES: readonly number[] = new Array(MAX_PLAYERS).fill(
  DIFFICULTY_NORMAL,
);

/** The match's weapon rules a replay carries beside its difficulties (format 5). */
export interface ReplayWeapons {
  /** SimOptions.extraWeapons; 0 when absent. */
  readonly extraWeapons?: number;
  /** Slot-indexed; a missing slot carries the default kit. */
  readonly loadouts?: readonly (Loadout | undefined)[];
}

/**
 * Allocates an all-idle replay of the given length (fill via writeFrame).
 * `difficulties` is slot-indexed; a missing slot is NORMAL.
 */
export function createReplayData(
  mapId: string,
  seed: number,
  tickCount: number,
  warden?: WardenConfig,
  difficulties?: readonly number[],
  weapons?: ReplayWeapons,
): ReplayData {
  const d: number[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) d.push(difficulties?.[p] ?? DIFFICULTY_NORMAL);
  const l: Loadout[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) l.push(weapons?.loadouts?.[p] ?? DEFAULT_LOADOUT);
  return {
    formatVersion: REPLAY_FORMAT_VERSION,
    simVersion: SIM_VERSION,
    seed: seed >>> 0,
    mapId,
    tickCount,
    wardenPlayer: warden ? warden.player : -1,
    wardenDifficulty: warden ? warden.difficulty : 0,
    difficulties: d,
    extraWeapons: weapons?.extraWeapons ?? 0,
    loadouts: l,
    frames: new Uint8Array(tickCount * FRAME_BYTES),
  };
}

/** True for a difficulty a header may carry: an integer row 0..DIFFICULTY_ROWS - 1. */
export function isDifficulty(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < DIFFICULTY_ROWS;
}

/** True for a byte a header may carry as extraWeapons: the five bits, nothing above. */
export function isExtraWeapons(v: unknown): v is number {
  return Number.isInteger(v) && ((v as number) & ~EXTRA_WEAPONS_ALL) === 0 && (v as number) >= 0;
}

const SLOT_LISTS = [GUNS, HEAVIES, SPECIALS] as const;

/** True for a loadout a header may carry: an index into each slot's catalogue. */
export function isReplayLoadout(l: Loadout | undefined): boolean {
  if (!l) return false;
  const v = [l.gun, l.heavy, l.special];
  for (let s = 0; s < 3; s++) {
    if (!Number.isInteger(v[s]) || v[s] < 0 || v[s] >= SLOT_LISTS[s].length) return false;
  }
  return true;
}

export function writeFrame(replay: ReplayData, tick: number, inputs: TickInputs): void {
  let o = tick * FRAME_BYTES;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const buttons = inputs.players[p].buttons;
    replay.frames[o] = buttons & 0xff;
    replay.frames[o + 1] = (buttons >>> 8) & 0xff;
    o += PLAYER_BYTES;
  }
}

/** Decodes frame `tick` into `out` without allocating. */
export function readFrame(replay: ReplayData, tick: number, out: TickInputs): void {
  let o = tick * FRAME_BYTES;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    out.players[p].buttons = replay.frames[o] | (replay.frames[o + 1] << 8);
    o += PLAYER_BYTES;
  }
}

export function encodeReplay(replay: ReplayData): Uint8Array {
  if (replay.mapId.length > 255) {
    throw new Error(`mapId too long (${replay.mapId.length} > 255)`);
  }
  // Enforce the same invariants the decoder checks, so a hand-built
  // ReplayData can never encode a header that silently normalizes (or fails
  // to round-trip). Integer checks matter: byte writes would truncate.
  if (replay.wardenPlayer >= 0) {
    if (!Number.isInteger(replay.wardenPlayer) || replay.wardenPlayer >= MAX_PLAYERS) {
      throw new Error(`bad wardenPlayer ${replay.wardenPlayer}`);
    }
    if (
      !Number.isInteger(replay.wardenDifficulty) ||
      replay.wardenDifficulty < 1 ||
      replay.wardenDifficulty > 10
    ) {
      throw new Error(`bad wardenDifficulty ${replay.wardenDifficulty}`);
    }
  } else {
    if (replay.wardenPlayer !== -1) {
      throw new Error(`bad wardenPlayer ${replay.wardenPlayer}`);
    }
    if (replay.wardenDifficulty !== 0) {
      throw new Error("wardenDifficulty set without a wardenPlayer");
    }
  }
  if (replay.difficulties.length !== MAX_PLAYERS) {
    throw new Error(`difficulties needs ${MAX_PLAYERS} entries`);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (!isDifficulty(replay.difficulties[p])) {
      throw new Error(`bad difficulty ${replay.difficulties[p]}`);
    }
  }
  if (!isExtraWeapons(replay.extraWeapons)) {
    throw new Error(`bad extraWeapons ${replay.extraWeapons}`);
  }
  if (replay.loadouts.length !== MAX_PLAYERS) {
    throw new Error(`loadouts needs ${MAX_PLAYERS} entries`);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (!isReplayLoadout(replay.loadouts[p])) throw new Error(`bad loadout for slot ${p}`);
  }
  const mapIdAt = MAP_ID_AT;
  const headerBytes = mapIdAt + 1 + replay.mapId.length;
  const out = new Uint8Array(headerBytes + replay.frames.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = MAGIC[2];
  out[3] = MAGIC[3];
  out[4] = REPLAY_FORMAT_VERSION & 0xff;
  out[5] = (REPLAY_FORMAT_VERSION >>> 8) & 0xff;
  out[6] = replay.simVersion & 0xff;
  out[7] = (replay.simVersion >>> 8) & 0xff;
  writeU32(out, 8, replay.seed);
  writeU32(out, 12, replay.tickCount);
  out[16] = replay.wardenPlayer >= 0 ? replay.wardenPlayer : 0xff;
  out[17] = replay.wardenPlayer >= 0 ? replay.wardenDifficulty : 0;
  for (let p = 0; p < MAX_PLAYERS; p++) out[DIFFICULTIES_AT + p] = replay.difficulties[p];
  out[EXTRA_AT] = replay.extraWeapons;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const l = replay.loadouts[p];
    out[LOADOUTS_AT + p * 3] = l.gun;
    out[LOADOUTS_AT + p * 3 + 1] = l.heavy;
    out[LOADOUTS_AT + p * 3 + 2] = l.special;
  }
  out[mapIdAt] = replay.mapId.length;
  for (let i = 0; i < replay.mapId.length; i++) {
    const c = replay.mapId.charCodeAt(i);
    if (c > 0x7f) throw new Error(`mapId must be ASCII: ${replay.mapId}`);
    out[mapIdAt + 1 + i] = c;
  }
  out.set(replay.frames, headerBytes);
  return out;
}

export function decodeReplay(bytes: Uint8Array): ReplayData {
  if (
    bytes.length < 17 ||
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new Error("not a MREP replay file");
  }
  const formatVersion = bytes[4] | (bytes[5] << 8);
  if (formatVersion !== REPLAY_FORMAT_VERSION) {
    throw new Error(`unsupported replay format version ${formatVersion}`);
  }
  const simVersion = bytes[6] | (bytes[7] << 8);
  const seed = readU32(bytes, 8);
  const tickCount = readU32(bytes, 12);
  const mapIdAt = MAP_ID_AT;
  if (bytes.length < mapIdAt + 1) throw new Error("truncated replay header");
  const wardenPlayer = bytes[16] === 0xff ? -1 : bytes[16];
  const wardenDifficulty = bytes[17];
  const difficulties: number[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const d = bytes[DIFFICULTIES_AT + p];
    if (!isDifficulty(d)) throw new Error(`bad difficulty ${d}`);
    difficulties.push(d);
  }
  const extraWeapons = bytes[EXTRA_AT];
  if (!isExtraWeapons(extraWeapons)) throw new Error(`bad extraWeapons ${extraWeapons}`);
  const loadouts: Loadout[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const l = {
      gun: bytes[LOADOUTS_AT + p * 3],
      heavy: bytes[LOADOUTS_AT + p * 3 + 1],
      special: bytes[LOADOUTS_AT + p * 3 + 2],
    };
    if (!isReplayLoadout(l)) throw new Error(`bad loadout for slot ${p}`);
    loadouts.push(l);
  }
  if (wardenPlayer >= MAX_PLAYERS) {
    throw new Error(`bad wardenPlayer ${wardenPlayer}`);
  }
  if (wardenPlayer >= 0 && (wardenDifficulty < 1 || wardenDifficulty > 10)) {
    throw new Error(`bad wardenDifficulty ${wardenDifficulty}`);
  }
  if (wardenPlayer < 0 && wardenDifficulty !== 0) {
    throw new Error("wardenDifficulty set without a wardenPlayer");
  }
  const mapIdLen = bytes[mapIdAt];
  const headerBytes = mapIdAt + 1 + mapIdLen;
  let mapId = "";
  for (let i = 0; i < mapIdLen; i++) {
    const c = bytes[mapIdAt + 1 + i];
    if (c > 0x7f) {
      throw new Error("replay mapId must be ASCII");
    }
    mapId += String.fromCharCode(c);
  }
  const expected = headerBytes + tickCount * FRAME_BYTES;
  if (bytes.length !== expected) {
    throw new Error(`replay length mismatch: got ${bytes.length}, expected ${expected}`);
  }
  return {
    formatVersion,
    simVersion,
    seed,
    mapId,
    tickCount,
    wardenPlayer,
    wardenDifficulty,
    difficulties,
    extraWeapons,
    loadouts,
    frames: bytes.slice(headerBytes),
  };
}

function writeU32(out: Uint8Array, offset: number, v: number): void {
  out[offset] = v & 0xff;
  out[offset + 1] = (v >>> 8) & 0xff;
  out[offset + 2] = (v >>> 16) & 0xff;
  out[offset + 3] = (v >>> 24) & 0xff;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
    bytes[offset + 3] * 0x1000000
  );
}
