// Replay byte format, version 1. A replay is {mapId, seed, version,
// inputFrames[]} (architecture.md §6); the per-tick frame encoding doubles as
// the network input-frame format (§5), so this file defines it exactly once.
//
// Little-endian layout:
//   offset 0  u8×4  magic "MREP"
//          4  u16   format version (1)
//          6  u16   simVersion the replay was recorded against
//          8  u32   seed
//         12  u32   tickCount
//         16  u8    mapId byte length, followed by that many ASCII bytes
//   then tickCount frames of MAX_PLAYERS × 5 bytes:
//         moveX i8, moveY i8, aimX i8, aimY i8, buttons u8

import { MAX_PLAYERS } from "./balance";
import type { TickInputs } from "./inputs";
import { SIM_VERSION } from "./version";

export const REPLAY_FORMAT_VERSION = 1;
const MAGIC = [0x4d, 0x52, 0x45, 0x50]; // "MREP"
const PLAYER_BYTES = 5;
export const FRAME_BYTES = MAX_PLAYERS * PLAYER_BYTES;

export interface ReplayData {
  readonly formatVersion: number;
  readonly simVersion: number;
  readonly seed: number;
  readonly mapId: string;
  readonly tickCount: number;
  /** Raw frame bytes, tickCount * FRAME_BYTES. */
  readonly frames: Uint8Array;
}

/** Allocates an all-idle replay of the given length (fill via writeFrame). */
export function createReplayData(mapId: string, seed: number, tickCount: number): ReplayData {
  return {
    formatVersion: REPLAY_FORMAT_VERSION,
    simVersion: SIM_VERSION,
    seed: seed >>> 0,
    mapId,
    tickCount,
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
  const headerBytes = 17 + replay.mapId.length;
  const out = new Uint8Array(headerBytes + replay.frames.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = MAGIC[2];
  out[3] = MAGIC[3];
  out[4] = replay.formatVersion & 0xff;
  out[5] = (replay.formatVersion >>> 8) & 0xff;
  out[6] = replay.simVersion & 0xff;
  out[7] = (replay.simVersion >>> 8) & 0xff;
  writeU32(out, 8, replay.seed);
  writeU32(out, 12, replay.tickCount);
  out[16] = replay.mapId.length;
  for (let i = 0; i < replay.mapId.length; i++) {
    const c = replay.mapId.charCodeAt(i);
    if (c > 0x7f) throw new Error(`mapId must be ASCII: ${replay.mapId}`);
    out[17 + i] = c;
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
  const mapIdLen = bytes[16];
  const headerBytes = 17 + mapIdLen;
  let mapId = "";
  for (let i = 0; i < mapIdLen; i++) {
    const c = bytes[17 + i];
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
