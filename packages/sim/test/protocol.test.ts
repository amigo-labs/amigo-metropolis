// Wire-protocol codec round-trips (protocol.ts). Every message type must
// survive encode → decode byte-for-byte, since the DO and both clients depend
// on it being the single source of the format. Malformed buffers must throw
// rather than silently decode garbage (the DO feeds it untrusted network data).

import { describe, expect, it } from "bun:test";
import {
  BTN_BACK,
  BTN_GUN,
  BTN_JINK_LEFT,
  DEFAULT_LOADOUTS,
  DIFFICULTY_EASY,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
  decodeMessage,
  ERR_ROOM_FULL,
  encodeMessage,
  GUNS,
  LOBBY_EXTRA_WEAPONS,
  LOBBY_NAME,
  LOBBY_NAME_BYTES,
  LOBBY_P1_LOADOUT,
  LOBBY_P1_READY,
  LOBBY_P1_SELECTION,
  LOBBY_P2_LOADOUT,
  LOBBY_P2_READY,
  LOBBY_P2_SELECTION,
  LOBBY_SETUP_CHOICE,
  type LobbyMessage,
  MAX_PLAYERS,
  type MatchConfig,
  MSG_BEGIN,
  MSG_DESYNC,
  MSG_ERROR,
  MSG_FRAME,
  MSG_HASH,
  MSG_HELLO,
  MSG_INPUT,
  MSG_LOBBY,
  MSG_PEER,
  MSG_REJOIN,
  MSG_START,
  MSG_WELCOME,
  messageType,
  type NetMessage,
  PLAYER_INPUT_BYTES,
  type PlayerInput,
  PROTOCOL_VERSION,
  peekProtocol,
  SIM_VERSION,
} from "../src/index";

const CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: 0xc0ffee,
  mapId: "la-cantina",
  wardenPlayer: -1,
  wardenDifficulty: 0,
  difficulties: [DIFFICULTY_NORMAL, DIFFICULTY_NORMAL],
  loadouts: DEFAULT_LOADOUTS,
  extraWeapons: 0,
};

// The button word is a u16 (inputs.ts): Move Backward is its top bit.
const INPUT_A: PlayerInput = { buttons: BTN_BACK | BTN_GUN | BTN_JINK_LEFT };
const INPUT_B: PlayerInput = { buttons: 0xffff };

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

  it("round-trips each player's difficulty (protocol 3)", () => {
    const picked: MatchConfig = { ...CONFIG, difficulties: [DIFFICULTY_HARD, DIFFICULTY_EASY] };
    const got = roundTrip({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: picked });
    expect(got).toEqual({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: picked });
    // One byte a player after the Warden's two, as in the replay header.
    const bytes = encodeMessage({ type: MSG_WELCOME, slot: 1, config: picked });
    const at = 1 + 1 + 2 + 4 + 1 + 1;
    expect([bytes[at], bytes[at + 1], bytes[at + 2]]).toEqual([0, 2, "la-cantina".length]);
  });

  it("refuses a difficulty off the three rows, on encode and on decode", () => {
    for (const bad of [[3, 1], [1, -1], [1, 1.5], [1]]) {
      expect(() =>
        encodeMessage({
          type: MSG_HELLO,
          protocol: PROTOCOL_VERSION,
          config: { ...CONFIG, difficulties: bad },
        }),
      ).toThrow(/difficult/);
    }
    const bytes = encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: CONFIG });
    // Slot 1's byte: tag, protocol, simVersion, seed, warden x2, slot 0.
    bytes[1 + 1 + 2 + 4 + 1 + 1 + 1] = 3; // the original's debug row
    expect(() => decodeMessage(bytes)).toThrow(/bad difficulty 3/);
  });

  it("round-trips REJOIN", () => {
    const msg: NetMessage = {
      type: MSG_REJOIN,
      protocol: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      slot: 1,
      fromTick: 123456,
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it("round-trips INPUT with the button word's high bits preserved", () => {
    const msg: NetMessage = { type: MSG_INPUT, tick: 900, input: INPUT_A };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it("round-trips each player's loadout after the mapId (protocol 4)", () => {
    const kit: MatchConfig = {
      ...CONFIG,
      loadouts: [
        { gun: 2, heavy: 1, special: 2 },
        { gun: GUNS.length - 1, heavy: 0, special: 1 },
      ],
    };
    const got = roundTrip({ type: MSG_WELCOME, slot: 1, config: kit });
    expect(got).toEqual({ type: MSG_WELCOME, slot: 1, config: kit });
    // The prefix keeps the replay header's offsets; three bytes a player follow.
    const bytes = encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: kit });
    const at = 1 + 1 + 2 + 4 + 1 + 1 + MAX_PLAYERS + 1 + CONFIG.mapId.length;
    expect([...bytes.subarray(at)]).toEqual([2, 1, 2, GUNS.length - 1, 0, 1, 0]);
    // The extra-weapons mask is the last byte, five bits.
    const on = encodeMessage({
      type: MSG_HELLO,
      protocol: PROTOCOL_VERSION,
      config: { ...kit, extraWeapons: 0b11001 },
    });
    expect(on[on.length - 1]).toBe(0b11001);
    expect(decodeMessage(on)).toMatchObject({ config: { extraWeapons: 0b11001 } });
    on[on.length - 1] = 0x20;
    expect(() => decodeMessage(on)).toThrow(/extraWeapons/);
    expect(() =>
      encodeMessage({ type: MSG_BEGIN, config: { ...kit, extraWeapons: 0x40 } }),
    ).toThrow(/extraWeapons/);
  });

  it("refuses a loadout off the catalogue, on encode and on decode", () => {
    for (const bad of [
      [{ gun: GUNS.length, heavy: 0, special: 0 }, DEFAULT_LOADOUTS[1]],
      [{ gun: 0, heavy: -1, special: 0 }, DEFAULT_LOADOUTS[1]],
      [DEFAULT_LOADOUTS[0]],
    ]) {
      expect(() =>
        encodeMessage({
          type: MSG_HELLO,
          protocol: PROTOCOL_VERSION,
          config: { ...CONFIG, loadouts: bad },
        }),
      ).toThrow(/loadout/);
    }
    const bytes = encodeMessage({ type: MSG_BEGIN, config: CONFIG });
    bytes[bytes.length - 2] = 99; // slot 1's special
    expect(() => decodeMessage(bytes)).toThrow(/bad loadout/);
  });

  it("round-trips BEGIN and a START that carries the agreed config (protocol 4)", () => {
    const agreed: MatchConfig = { ...CONFIG, difficulties: [DIFFICULTY_HARD, DIFFICULTY_EASY] };
    expect(roundTrip({ type: MSG_BEGIN, config: agreed })).toEqual({
      type: MSG_BEGIN,
      config: agreed,
    });
    expect(roundTrip({ type: MSG_START, startTick: 0, config: agreed })).toEqual({
      type: MSG_START,
      startTick: 0,
      config: agreed,
    });
  });

  it("round-trips the original's lobby messages under their ids", () => {
    const all: LobbyMessage[] = [
      { id: LOBBY_SETUP_CHOICE, index: 0, value: 4 },
      { id: LOBBY_NAME, name: "Jürgen" },
      { id: LOBBY_NAME, name: "" },
      { id: LOBBY_P1_SELECTION, selection: DIFFICULTY_HARD },
      { id: LOBBY_P2_SELECTION, selection: DIFFICULTY_EASY },
      { id: LOBBY_P1_LOADOUT, codes: [0x00, 0x10, 0x20] },
      { id: LOBBY_P2_LOADOUT, codes: [0x03, 0x12, 0x23] },
      { id: LOBBY_P1_READY, ready: true },
      { id: LOBBY_P2_READY, ready: false },
      { id: LOBBY_EXTRA_WEAPONS, mask: 0b10110 },
    ];
    for (const lobby of all) {
      expect(roundTrip({ type: MSG_LOBBY, lobby })).toEqual({ type: MSG_LOBBY, lobby });
    }
    expect([LOBBY_SETUP_CHOICE, LOBBY_NAME, LOBBY_P1_READY, LOBBY_P2_READY]).toEqual([
      0x09, 0x0a, 0x10, 0x15,
    ]);
    const bytes = encodeMessage({
      type: MSG_LOBBY,
      lobby: { id: LOBBY_P2_LOADOUT, codes: [0x01, 0x12, 0x23] },
    });
    expect([...bytes]).toEqual([MSG_LOBBY, 0x0e, 0x01, 0x12, 0x23]);
  });

  it("refuses a malformed lobby message, on encode and on decode", () => {
    const enc = (lobby: LobbyMessage) => () => encodeMessage({ type: MSG_LOBBY, lobby });
    expect(enc({ id: LOBBY_NAME, name: "x".repeat(LOBBY_NAME_BYTES + 1) })).toThrow(/long/);
    expect(enc({ id: LOBBY_NAME, name: "\u4e16" })).toThrow(/single-byte/);
    expect(enc({ id: LOBBY_P1_SELECTION, selection: 3 })).toThrow(/selection/);
    // A code of another slot, or none of the slot's five original codes
    // (0x04 and 0x11 are the holes 0x0040c2d0's table leaves; 0x05 and 0x15
    // are codes, F7).
    expect(enc({ id: LOBBY_P1_LOADOUT, codes: [0x10, 0x10, 0x20] })).toThrow(/code/);
    expect(enc({ id: LOBBY_P1_LOADOUT, codes: [0x04, 0x10, 0x20] })).toThrow(/code/);
    expect(enc({ id: LOBBY_P1_LOADOUT, codes: [0x00, 0x11, 0x20] })).toThrow(/code/);
    expect(enc({ id: LOBBY_P1_LOADOUT, codes: [0x05, 0x15, 0x24] })).not.toThrow();
    expect(enc({ id: LOBBY_SETUP_CHOICE, index: 2, value: 0 })).toThrow(/index/);
    expect(() => decodeMessage(new Uint8Array([MSG_LOBBY, 0x17, 0]))).toThrow(/lobby message/);
    expect(() => decodeMessage(new Uint8Array([MSG_LOBBY, 0x10, 2]))).toThrow(/ready/);
    expect(() => decodeMessage(new Uint8Array([MSG_LOBBY, 0x0d, 0, 0x10, 0x30]))).toThrow(/code/);
    expect(() =>
      decodeMessage(new Uint8Array([MSG_LOBBY, 0x0a, 29, ...new Array(29).fill(65)])),
    ).toThrow(/long/);
  });

  it("peeks a HELLO's protocol byte even when its body does not decode", () => {
    const hello = encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: CONFIG });
    expect(peekProtocol(hello)).toBe(PROTOCOL_VERSION);
    // A protocol-3 HELLO: no loadouts after the mapId.
    const old = hello.slice(0, hello.length - 3 * MAX_PLAYERS - 1);
    old[1] = 3;
    expect(() => decodeMessage(old)).toThrow();
    expect(peekProtocol(old)).toBe(3);
    expect(peekProtocol(encodeMessage({ type: MSG_HASH, tick: 1, hash: 2 }))).toBeNull();
    expect(peekProtocol(new Uint8Array([MSG_HELLO]))).toBeNull();
  });

  it("carries one player's input as a u16 LE word (since protocol 2)", () => {
    expect(PROTOCOL_VERSION).toBe(5);
    expect(PLAYER_INPUT_BYTES).toBe(2);
    const bytes = encodeMessage({ type: MSG_INPUT, tick: 900, input: INPUT_A });
    // tag(1) + tick(4) + buttons(2): 0x8410 is 10 84.
    expect(bytes.length).toBe(1 + 4 + PLAYER_INPUT_BYTES);
    expect([...bytes.subarray(5)]).toEqual([0x10, 0x84]);
    const frame = encodeMessage({ type: MSG_FRAME, tick: 7, inputs: [INPUT_A, INPUT_B] });
    expect(frame.length).toBe(1 + 4 + MAX_PLAYERS * PLAYER_INPUT_BYTES);
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

  it("round-trips PEER / DESYNC / ERROR", () => {
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
    expect(messageType(encodeMessage({ type: MSG_START, startTick: 0, config: CONFIG }))).toBe(
      MSG_START,
    );
    expect(messageType(new Uint8Array(0))).toBe(0);
  });

  it("throws on an unknown tag and on a truncated body", () => {
    expect(() => decodeMessage(new Uint8Array([250]))).toThrow(/unknown message tag/);
    // MSG_INPUT tag with no tick/input bytes following.
    expect(() => decodeMessage(new Uint8Array([MSG_INPUT]))).toThrow(/truncated/);
  });

  it("rejects trailing bytes after a well-formed message", () => {
    const good = encodeMessage({ type: MSG_START, startTick: 0, config: CONFIG });
    const padded = new Uint8Array(good.length + 1);
    padded.set(good);
    padded[good.length] = 0x99; // one garbage byte past the body
    expect(() => decodeMessage(padded)).toThrow(/trailing/);
  });

  it("rejects a non-ASCII mapId on encode (symmetric with decode)", () => {
    const bad: MatchConfig = { ...CONFIG, mapId: "district-é" };
    expect(() =>
      encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: bad }),
    ).toThrow(/ASCII/);
  });

  it("rejects a config with a non-ASCII mapId on decode", () => {
    const bytes = encodeMessage({ type: MSG_HELLO, protocol: PROTOCOL_VERSION, config: CONFIG });
    // Corrupt the first mapId byte (after tag,protocol,simVersion,seed,warden×2,
    // the difficulties, len).
    bytes[1 + 1 + 2 + 4 + 1 + 1 + MAX_PLAYERS + 1] = 0x80;
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
