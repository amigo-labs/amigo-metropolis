// Wire-protocol codec round-trips (protocol.ts). Every message type must
// survive encode → decode byte-for-byte, since the DO and both clients depend
// on it being the single source of the format. Malformed buffers must throw
// rather than silently decode garbage (the DO feeds it untrusted network data).

import { describe, expect, it } from "bun:test";
import {
  decodeMessage,
  ERR_ROOM_FULL,
  encodeMessage,
  MAX_PLAYERS,
  type MatchConfig,
  MSG_DESYNC,
  MSG_ERROR,
  MSG_FRAME,
  MSG_HASH,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PEER,
  MSG_REJOIN,
  MSG_START,
  MSG_WELCOME,
  messageType,
  type NetMessage,
  type PlayerInput,
  PROTOCOL_VERSION,
  SIM_VERSION,
} from "../src/index";

const CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: 0xc0ffee,
  mapId: "district-01",
  wardenPlayer: -1,
  wardenDifficulty: 0,
};

const INPUT_A: PlayerInput = { moveX: -127, moveY: 127, aimX: -1, aimY: 42, buttons: 0b101010 };
const INPUT_B: PlayerInput = { moveX: 0, moveY: -1, aimX: 100, aimY: -100, buttons: 255 };

function roundTrip(msg: NetMessage): NetMessage {
  return decodeMessage(encodeMessage(msg));
}

describe("protocol codec", () => {
  it("round-trips HELLO with config", () => {
    const got = roundTrip({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: CONFIG });
    expect(got).toEqual({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: CONFIG });
  });

  it("round-trips a warden config (wardenPlayer + difficulty)", () => {
    const warden: MatchConfig = { ...CONFIG, wardenPlayer: 1, wardenDifficulty: 8 };
    const got = roundTrip({ type: MSG_WELCOME, slot: 0, config: warden });
    expect(got).toEqual({ type: MSG_WELCOME, slot: 0, config: warden });
  });

  it("round-trips REJOIN", () => {
    const msg: NetMessage = {
      type: MSG_REJOIN,
      protocol: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      slot: 1,
      haveTick: 123456,
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it("round-trips INPUT with signed axes preserved", () => {
    const msg: NetMessage = { type: MSG_INPUT, tick: 900, input: INPUT_A };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it("round-trips HASH with a full u32 hash", () => {
    const msg: NetMessage = { type: MSG_HASH, tick: 30, hash: 0xdeadbeef };
    const got = roundTrip(msg);
    expect(got).toEqual(msg);
    if (got.type === MSG_HASH) expect(got.hash).toBe(0xdeadbeef);
  });

  it("round-trips FRAME with MAX_PLAYERS inputs", () => {
    const inputs = [INPUT_A, INPUT_B].slice(0, MAX_PLAYERS);
    const msg: NetMessage = { type: MSG_FRAME, tick: 7, inputs };
    const got = roundTrip(msg);
    expect(got).toEqual(msg);
  });

  it("round-trips START / PEER / DESYNC / ERROR", () => {
    expect(roundTrip({ type: MSG_START, startTick: 0 })).toEqual({ type: MSG_START, startTick: 0 });
    expect(roundTrip({ type: MSG_PEER, slot: 1, present: true })).toEqual({
      type: MSG_PEER,
      slot: 1,
      present: true,
    });
    expect(roundTrip({ type: MSG_PEER, slot: 0, present: false })).toEqual({
      type: MSG_PEER,
      slot: 0,
      present: false,
    });
    expect(roundTrip({ type: MSG_DESYNC, tick: 60 })).toEqual({ type: MSG_DESYNC, tick: 60 });
    expect(roundTrip({ type: MSG_ERROR, code: ERR_ROOM_FULL })).toEqual({
      type: MSG_ERROR,
      code: ERR_ROOM_FULL,
    });
  });

  it("messageType peeks the tag without full decode", () => {
    expect(messageType(encodeMessage({ type: MSG_START, startTick: 0 }))).toBe(MSG_START);
    expect(messageType(new Uint8Array(0))).toBe(0);
  });

  it("throws on an unknown tag and on a truncated body", () => {
    expect(() => decodeMessage(new Uint8Array([250]))).toThrow(/unknown message tag/);
    // MSG_INPUT tag with no tick/input bytes following.
    expect(() => decodeMessage(new Uint8Array([MSG_INPUT]))).toThrow(/truncated/);
  });

  it("rejects a config with a non-ASCII mapId on decode", () => {
    const bytes = encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: CONFIG });
    // Corrupt the first mapId byte (after tag,protocol,simVersion,seed,warden×2,len).
    bytes[1 + 1 + 2 + 4 + 1 + 1 + 1] = 0x80;
    expect(() => decodeMessage(bytes)).toThrow(/ASCII/);
  });

  it("rejects an out-of-range warden difficulty on decode", () => {
    const bad: MatchConfig = { ...CONFIG, wardenPlayer: 0, wardenDifficulty: 8 };
    const bytes = encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: bad });
    // wardenDifficulty byte sits at offset tag(1)+protocol(1)+simVersion(2)+seed(4)+wardenPlayer(1).
    bytes[1 + 1 + 2 + 4 + 1] = 11;
    expect(() => decodeMessage(bytes)).toThrow(/wardenDifficulty/);
  });
});
