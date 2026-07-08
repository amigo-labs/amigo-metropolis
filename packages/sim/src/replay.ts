// Replay byte format. A replay is {mapId, seed, version, inputFrames[]}
// (architecture.md §6) plus, since format 2, the match's Warden config — the
// AI runs inside the sim, so replay-stable AI matches need it in the header.
// The per-tick frame encoding doubles as the network input-frame format (§5),
// so this file defines it exactly once.
//
// Little-endian layout (format 2):
//   offset 0  u8×4  magic "MREP"
//          4  u16   format version (2)
//          6  u16   simVersion the replay was recorded against
//          8  u32   seed
//         12  u32   tickCount
//         16  u8    wardenPlayer (0xff = no Warden)
//         17  u8    wardenDifficulty (0 when no Warden)
//         18  u8    mapId byte length, followed by that many ASCII bytes
//   then tickCount frames of MAX_PLAYERS × 5 bytes:
//         moveX i8, moveY i8, aimX i8, aimY i8, buttons u8
// Format 1 (still decoded) is identical minus the two Warden bytes: the
// mapId length sits at offset 16 and the match has no Warden.

import { MAX_PLAYERS } from "./balance";
import type { TickInputs } from "./inputs";
import { SIM_VERSION } from "./version";

export const REPLAY_FORMAT_VERSION = 2;
const MAGIC = [0x4d, 0x52, 0x45, 0x50]; // "MREP"
const PLAYER_BYTES = 5;
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
  /** Raw frame bytes, tickCount * FRAME_BYTES. */
  readonly frames: Uint8Array;
}

/** Match config carried by replays and passed to createSim. */
export interface WardenConfig {
  readonly player: number;
  readonly difficulty: number;
}

/** Allocates an all-idle replay of the given length (fill via writeFrame). */
export function createReplayData(
  mapId: string,
  seed: number,
  tickCount: number,
  warden?: WardenConfig,
): ReplayData {
  return {
    formatVersion: REPLAY_FORMAT_VERSION,
    simVersion: SIM_VERSION,
    seed: seed >>> 0,
    mapId,
    tickCount,
    wardenPlayer: warden ? warden.player : -1,
    wardenDifficulty: warden ? warden.difficulty : 0,
    frames: new Uint8Array(tickCount * FRAME_BYTES),
  };
}

export function writeFrame(replay: ReplayData, tick: number, inputs: TickInputs): void {
  let o = tick * FRAME_BYTES;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const input = inputs.players[p];
    replay.frames[o] = input.moveX & 0xff;
    replay.frames[o + 1] = input.moveY & 0xff;
    replay.frames[o + 2] = input.aimX & 0xff;
    replay.frames[o + 3] = input.aimY & 0xff;
    replay.frames[o + 4] = input.buttons & 0xff;
    o += PLAYER_BYTES;
  }
}

/** Decodes frame `tick` into `out` without allocating. */
export function readFrame(replay: ReplayData, tick: number, out: TickInputs): void {
  let o = tick * FRAME_BYTES;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const input = out.players[p];
    input.moveX = (replay.frames[o] << 24) >> 24;
    input.moveY = (replay.frames[o + 1] << 24) >> 24;
    input.aimX = (replay.frames[o + 2] << 24) >> 24;
    input.aimY = (replay.frames[o + 3] << 24) >> 24;
    input.buttons = replay.frames[o + 4];
    o += PLAYER_BYTES;
  }
}

export function encodeReplay(replay: ReplayData): Uint8Array {
  if (replay.mapId.length > 255) {
    throw new Error(`mapId too long (${replay.mapId.length} > 255)`);
  }
  if (replay.wardenPlayer >= 0) {
    if (replay.wardenPlayer >= MAX_PLAYERS) {
      throw new Error(`bad wardenPlayer ${replay.wardenPlayer}`);
    }
    if (replay.wardenDifficulty < 1 || replay.wardenDifficulty > 10) {
      throw new Error(`bad wardenDifficulty ${replay.wardenDifficulty}`);
    }
  }
  const headerBytes = 19 + replay.mapId.length;
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
  out[18] = replay.mapId.length;
  for (let i = 0; i < replay.mapId.length; i++) {
    const c = replay.mapId.charCodeAt(i);
    if (c > 0x7f) throw new Error(`mapId must be ASCII: ${replay.mapId}`);
    out[19 + i] = c;
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
  if (formatVersion !== 1 && formatVersion !== REPLAY_FORMAT_VERSION) {
    throw new Error(`unsupported replay format version ${formatVersion}`);
  }
  const simVersion = bytes[6] | (bytes[7] << 8);
  const seed = readU32(bytes, 8);
  const tickCount = readU32(bytes, 12);
  let wardenPlayer = -1;
  let wardenDifficulty = 0;
  let mapIdAt = 16;
  if (formatVersion === 2) {
    if (bytes.length < 19) throw new Error("truncated replay header");
    wardenPlayer = bytes[16] === 0xff ? -1 : bytes[16];
    wardenDifficulty = bytes[17];
    mapIdAt = 18;
    if (wardenPlayer >= MAX_PLAYERS) {
      throw new Error(`bad wardenPlayer ${wardenPlayer}`);
    }
    if (wardenPlayer >= 0 && (wardenDifficulty < 1 || wardenDifficulty > 10)) {
      throw new Error(`bad wardenDifficulty ${wardenDifficulty}`);
    }
    if (wardenPlayer < 0 && wardenDifficulty !== 0) {
      throw new Error("wardenDifficulty set without a wardenPlayer");
    }
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
