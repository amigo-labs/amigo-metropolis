// Online lockstep wire protocol (architecture.md §5). Binary from day one —
// tiny fixed-size buffers, no JSON on the hot path. This lives in `sim` for the
// same reason the replay frame codec does: the per-tick input frame IS the
// replay frame, and the sim owns the one canonical definition of it. Nothing
// here touches the deterministic tick — it is pure byte (de)serialization, like
// replay.ts, so it does not affect the sim hash or SIM_VERSION.
//
// A message is a u8 type tag followed by a fixed little-endian body. The tag
// namespace is split so client→server and server→client can never be confused:
// 1–9 are client-authored, 10+ are server-authored.
//
// The MatchConfig header (seed / warden / mapId) mirrors the replay header body
// (replay.ts) field-for-field: an online match and its recorded replay carry
// the exact same match parameters, so the two definitions stay in lock-step.

import { MAX_PLAYERS } from "./balance";
import type { PlayerInput } from "./inputs";

/**
 * Wire framing version, independent of SIM_VERSION. Bumped only when the byte
 * layout below changes; SIM_VERSION handles gameplay/hash changes. A room
 * rejects clients whose SIM_VERSION differs (goldens would already be broken),
 * and this guards the framing itself.
 */
export const PROTOCOL_VERSION = 1;

// --- Message type tags -------------------------------------------------------
// Client → server (1–9).
export const MSG_HELLO = 1; // fresh join: carries the match config
export const MSG_REJOIN = 2; // reconnect: reclaim a slot, ask for history
export const MSG_INPUT = 3; // this client's input for one (future) tick
export const MSG_HASH = 4; // this client's state hash at one tick
// Server → client (10+).
export const MSG_WELCOME = 10; // slot assignment + authoritative config
export const MSG_START = 11; // both slots filled — begin stepping
export const MSG_FRAME = 12; // confirmed inputs for one tick (all players)
export const MSG_PEER = 13; // a peer connected / disconnected
export const MSG_DESYNC = 14; // hash mismatch — end match, dump replays
export const MSG_ERROR = 15; // join rejected

// --- Error codes (MSG_ERROR body) --------------------------------------------
export const ERR_VERSION_MISMATCH = 1; // simVersion (or protocol) differs
export const ERR_ROOM_FULL = 2; // both slots already occupied
export const ERR_BAD_REJOIN = 3; // slot not reclaimable
export const ERR_PROTOCOL = 4; // malformed / unexpected message

/** Match parameters agreed at join time; superset of SimOptions + map + seed. */
export interface MatchConfig {
  /** SIM_VERSION the host is running; a joiner must match exactly. */
  readonly simVersion: number;
  readonly seed: number;
  readonly mapId: string;
  /** Player slot driven by the Warden AI, -1 for none (online 1v1 uses -1). */
  readonly wardenPlayer: number;
  /** Warden difficulty 1–10; 0 when wardenPlayer is -1. */
  readonly wardenDifficulty: number;
}

export const PLAYER_INPUT_BYTES = 5;

export type NetMessage =
  | { readonly type: typeof MSG_HELLO; readonly protocol: number; readonly config: MatchConfig }
  | {
      readonly type: typeof MSG_REJOIN;
      readonly protocol: number;
      readonly simVersion: number;
      readonly slot: number;
      /** Highest tick the client has already simulated. */
      readonly haveTick: number;
    }
  | { readonly type: typeof MSG_INPUT; readonly tick: number; readonly input: PlayerInput }
  | { readonly type: typeof MSG_HASH; readonly tick: number; readonly hash: number }
  | { readonly type: typeof MSG_WELCOME; readonly slot: number; readonly config: MatchConfig }
  | { readonly type: typeof MSG_START; readonly startTick: number }
  | {
      readonly type: typeof MSG_FRAME;
      readonly tick: number;
      /** Exactly MAX_PLAYERS entries, slot-indexed. */
      readonly inputs: PlayerInput[];
    }
  | { readonly type: typeof MSG_PEER; readonly slot: number; readonly present: boolean }
  | { readonly type: typeof MSG_DESYNC; readonly tick: number }
  | { readonly type: typeof MSG_ERROR; readonly code: number };

// --- Cursor helpers (little-endian) ------------------------------------------

class Writer {
  private readonly view: DataView;
  private o = 0;
  constructor(byteLength: number) {
    this.view = new DataView(new ArrayBuffer(byteLength));
  }
  u8(v: number): void {
    this.view.setUint8(this.o, v & 0xff);
    this.o += 1;
  }
  i8(v: number): void {
    this.view.setInt8(this.o, v);
    this.o += 1;
  }
  u16(v: number): void {
    this.view.setUint16(this.o, v & 0xffff, true);
    this.o += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }
  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(): Uint8Array {
    if (this.o !== this.view.byteLength) {
      throw new Error(`writer underfilled: ${this.o}/${this.view.byteLength}`);
    }
    return new Uint8Array(this.view.buffer);
  }
}

class Reader {
  private readonly view: DataView;
  private o = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (this.o + n > this.view.byteLength) throw new Error("truncated message");
  }
  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.o);
    this.o += 1;
    return v;
  }
  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.o);
    this.o += 1;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  ascii(len: number): string {
    this.need(len);
    let s = "";
    for (let i = 0; i < len; i++) {
      const c = this.buf[this.o + i];
      if (c > 0x7f) throw new Error("mapId must be ASCII");
      s += String.fromCharCode(c);
    }
    this.o += len;
    return s;
  }
}

// --- Config header (shared by HELLO / WELCOME) -------------------------------
// Bytes: simVersion u16, seed u32, wardenPlayer u8 (0xff = -1),
// wardenDifficulty u8, mapIdLen u8, mapId ASCII. Matches replay.ts offsets 6→.

function configBytes(config: MatchConfig): number {
  if (config.mapId.length > 255) throw new Error("mapId too long");
  return 2 + 4 + 1 + 1 + 1 + config.mapId.length;
}

function writeConfig(w: Writer, config: MatchConfig): void {
  w.u16(config.simVersion);
  w.u32(config.seed);
  w.u8(config.wardenPlayer >= 0 ? config.wardenPlayer : 0xff);
  w.u8(config.wardenPlayer >= 0 ? config.wardenDifficulty : 0);
  w.u8(config.mapId.length);
  w.ascii(config.mapId);
}

function readConfig(r: Reader): MatchConfig {
  const simVersion = r.u16();
  const seed = r.u32();
  const rawWarden = r.u8();
  const wardenPlayer = rawWarden === 0xff ? -1 : rawWarden;
  const wardenDifficulty = r.u8();
  const mapIdLen = r.u8();
  const mapId = r.ascii(mapIdLen);
  if (wardenPlayer >= MAX_PLAYERS) throw new Error(`bad wardenPlayer ${wardenPlayer}`);
  if (wardenPlayer >= 0 && (wardenDifficulty < 1 || wardenDifficulty > 10)) {
    throw new Error(`bad wardenDifficulty ${wardenDifficulty}`);
  }
  if (wardenPlayer < 0 && wardenDifficulty !== 0) {
    throw new Error("wardenDifficulty set without a wardenPlayer");
  }
  return { simVersion, seed, mapId, wardenPlayer, wardenDifficulty };
}

function writeInput(w: Writer, input: PlayerInput): void {
  w.i8(input.moveX);
  w.i8(input.moveY);
  w.i8(input.aimX);
  w.i8(input.aimY);
  w.u8(input.buttons);
}

function readInput(r: Reader): PlayerInput {
  return { moveX: r.i8(), moveY: r.i8(), aimX: r.i8(), aimY: r.i8(), buttons: r.u8() };
}

// --- Public codec ------------------------------------------------------------

/** Reads just the type tag without decoding the body (0 for an empty buffer). */
export function messageType(bytes: Uint8Array): number {
  return bytes.length > 0 ? bytes[0] : 0;
}

export function encodeMessage(msg: NetMessage): Uint8Array {
  switch (msg.type) {
    case MSG_HELLO: {
      const w = new Writer(1 + 1 + configBytes(msg.config));
      w.u8(MSG_HELLO);
      w.u8(msg.protocol);
      writeConfig(w, msg.config);
      return w.bytes();
    }
    case MSG_REJOIN: {
      const w = new Writer(1 + 1 + 2 + 1 + 4);
      w.u8(MSG_REJOIN);
      w.u8(msg.protocol);
      w.u16(msg.simVersion);
      w.u8(msg.slot);
      w.u32(msg.haveTick);
      return w.bytes();
    }
    case MSG_INPUT: {
      const w = new Writer(1 + 4 + PLAYER_INPUT_BYTES);
      w.u8(MSG_INPUT);
      w.u32(msg.tick);
      writeInput(w, msg.input);
      return w.bytes();
    }
    case MSG_HASH: {
      const w = new Writer(1 + 4 + 4);
      w.u8(MSG_HASH);
      w.u32(msg.tick);
      w.u32(msg.hash);
      return w.bytes();
    }
    case MSG_WELCOME: {
      const w = new Writer(1 + 1 + configBytes(msg.config));
      w.u8(MSG_WELCOME);
      w.u8(msg.slot);
      writeConfig(w, msg.config);
      return w.bytes();
    }
    case MSG_START: {
      const w = new Writer(1 + 4);
      w.u8(MSG_START);
      w.u32(msg.startTick);
      return w.bytes();
    }
    case MSG_FRAME: {
      if (msg.inputs.length !== MAX_PLAYERS) throw new Error("FRAME needs MAX_PLAYERS inputs");
      const w = new Writer(1 + 4 + MAX_PLAYERS * PLAYER_INPUT_BYTES);
      w.u8(MSG_FRAME);
      w.u32(msg.tick);
      for (let p = 0; p < MAX_PLAYERS; p++) writeInput(w, msg.inputs[p]);
      return w.bytes();
    }
    case MSG_PEER: {
      const w = new Writer(1 + 1 + 1);
      w.u8(MSG_PEER);
      w.u8(msg.slot);
      w.u8(msg.present ? 1 : 0);
      return w.bytes();
    }
    case MSG_DESYNC: {
      const w = new Writer(1 + 4);
      w.u8(MSG_DESYNC);
      w.u32(msg.tick);
      return w.bytes();
    }
    case MSG_ERROR: {
      const w = new Writer(1 + 1);
      w.u8(MSG_ERROR);
      w.u8(msg.code);
      return w.bytes();
    }
    default: {
      const _exhaustive: never = msg;
      throw new Error(`unknown message ${(_exhaustive as { type: number }).type}`);
    }
  }
}

export function decodeMessage(bytes: Uint8Array): NetMessage {
  const r = new Reader(bytes);
  const type = r.u8();
  switch (type) {
    case MSG_HELLO:
      return { type: MSG_HELLO, protocol: r.u8(), config: readConfig(r) };
    case MSG_REJOIN:
      return {
        type: MSG_REJOIN,
        protocol: r.u8(),
        simVersion: r.u16(),
        slot: r.u8(),
        haveTick: r.u32(),
      };
    case MSG_INPUT:
      return { type: MSG_INPUT, tick: r.u32(), input: readInput(r) };
    case MSG_HASH:
      return { type: MSG_HASH, tick: r.u32(), hash: r.u32() };
    case MSG_WELCOME:
      return { type: MSG_WELCOME, slot: r.u8(), config: readConfig(r) };
    case MSG_START:
      return { type: MSG_START, startTick: r.u32() };
    case MSG_FRAME: {
      const tick = r.u32();
      const inputs: PlayerInput[] = [];
      for (let p = 0; p < MAX_PLAYERS; p++) inputs.push(readInput(r));
      return { type: MSG_FRAME, tick, inputs };
    }
    case MSG_PEER:
      return { type: MSG_PEER, slot: r.u8(), present: r.u8() !== 0 };
    case MSG_DESYNC:
      return { type: MSG_DESYNC, tick: r.u32() };
    case MSG_ERROR:
      return { type: MSG_ERROR, code: r.u8() };
    default:
      throw new Error(`unknown message tag ${type}`);
  }
}
