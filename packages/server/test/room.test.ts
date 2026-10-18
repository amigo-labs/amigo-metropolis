// Pure relay behaviour (room.ts). RoomLogic is deliberately Cloudflare-free so
// the whole lockstep-sequencing / handshake / desync / reconnect contract is
// provable under `bun test`; the DO adapter adds only socket plumbing on top.

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_DIFFICULTIES,
  DEFAULT_LOADOUTS,
  decodeMessage,
  ERR_BAD_REJOIN,
  ERR_PROTOCOL,
  ERR_ROOM_FULL,
  ERR_VERSION_MISMATCH,
  encodeMessage,
  LOBBY_NAME,
  LOBBY_P1_READY,
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
  type NetMessage,
  type PlayerInput,
  PROTOCOL_VERSION,
  SIM_VERSION,
} from "@metropolis/sim";
import { type Outgoing, RoomLogic } from "../src/room";

const CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: 0xc0ffee,
  mapId: "la-cantina",
  wardenPlayer: -1,
  wardenDifficulty: 0,
  difficulties: DEFAULT_DIFFICULTIES,
  loadouts: DEFAULT_LOADOUTS,
  campaignWeapons: false,
};
/** What the host's lobby agreed: both players' own picks. */
const AGREED: MatchConfig = {
  ...CONFIG,
  mapId: "urban-jungle",
  difficulties: [0, 2],
  campaignWeapons: true,
  loadouts: [
    { gun: 2, heavy: 1, special: 0 },
    { gun: 1, heavy: 0, special: 2 },
  ],
};

const hello = (config = CONFIG): NetMessage => ({
  type: MSG_HELLO,
  protocol: PROTOCOL_VERSION,
  config,
});
const inp = (x: number): PlayerInput => ({ buttons: x });
const input = (tick: number, x: number): NetMessage => ({ type: MSG_INPUT, tick, input: inp(x) });

/** Types of the outgoing messages, ignoring targets — handy for assertions. */
const types = (out: Outgoing[]): number[] => out.map((o) => o.msg.type);
const find = (out: Outgoing[], type: number): NetMessage | undefined =>
  out.find((o) => o.msg.type === type)?.msg;

/** Seats two players in the lobby (protocol 4: not started). */
function fullLobby(): RoomLogic {
  const room = new RoomLogic();
  room.handleMessage("a", hello());
  room.handleMessage("b", hello());
  return room;
}

/** Seats two players, the host begins, and the room relays from tick 0. */
function startedRoom(): RoomLogic {
  const room = fullLobby();
  room.handleMessage("a", { type: MSG_BEGIN, config: CONFIG });
  return room;
}

const lobbyMsg: NetMessage = { type: MSG_LOBBY, lobby: { id: LOBBY_NAME, name: "Ryan" } };

describe("RoomLogic handshake", () => {
  it("welcomes the host into slot 0 and does not start alone", () => {
    const room = new RoomLogic();
    const out = room.handleMessage("a", hello());
    const welcome = find(out, MSG_WELCOME);
    expect(welcome).toMatchObject({ type: MSG_WELCOME, slot: 0, config: CONFIG });
    expect(types(out)).toContain(MSG_PEER);
    expect(types(out)).not.toContain(MSG_START);
    expect(room.isStarted).toBe(false);
  });

  it("welcomes a joiner into slot 1 and opens the lobby, not the match (protocol 4)", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    const out = room.handleMessage("b", hello());
    expect(find(out, MSG_WELCOME)).toMatchObject({ slot: 1 });
    // Joiner is told the host is present, the host that the joiner is.
    expect(out.some((o) => o.msg.type === MSG_PEER && o.connId === "b")).toBe(true);
    expect(out.find((o) => o.msg.type === MSG_PEER && o.connId === null)?.msg).toEqual({
      type: MSG_PEER,
      slot: 1,
      present: true,
    });
    expect(types(out)).not.toContain(MSG_START);
    expect(room.isStarted).toBe(false);
  });

  it("rejects a third player as ROOM_FULL", () => {
    const room = startedRoom();
    const out = room.handleMessage("c", hello());
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_ROOM_FULL });
  });

  it("rejects a mismatched simVersion", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    const out = room.handleMessage("b", hello({ ...CONFIG, simVersion: SIM_VERSION + 1 }));
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_VERSION_MISMATCH });
  });

  it("refuses a protocol-3 HELLO that does not decode as a version mismatch", () => {
    const room = new RoomLogic();
    const bytes = encodeMessage(hello());
    const old = bytes.slice(0, bytes.length - 7); // protocol 3: no loadouts, no rule
    old[1] = 3;
    expect(() => decodeMessage(old)).toThrow();
    expect(room.handleUndecodable("a", old)).toEqual([
      { connId: "a", msg: { type: MSG_ERROR, code: ERR_VERSION_MISMATCH } },
    ]);
    // Anything else that does not decode is noise.
    expect(room.handleUndecodable("a", new Uint8Array([MSG_INPUT, 1]))).toEqual([
      { connId: "a", msg: { type: MSG_ERROR, code: ERR_PROTOCOL } },
    ]);
    expect(room.isStarted).toBe(false);
  });

  it("rejects a mismatched protocol version", () => {
    const room = new RoomLogic();
    const out = room.handleMessage("a", {
      type: MSG_HELLO,
      protocol: PROTOCOL_VERSION + 1,
      config: CONFIG,
    });
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_VERSION_MISMATCH });
  });

  it("welcomes both players with the host's difficulties (protocol 3)", () => {
    const room = new RoomLogic();
    const picked: MatchConfig = { ...CONFIG, difficulties: [0, 2] };
    room.handleMessage("a", hello(picked));
    // The joiner's own config is checked for its simVersion only.
    const out = room.handleMessage("b", hello());
    const welcome = find(out, MSG_WELCOME);
    expect(welcome).toMatchObject({ slot: 1, config: { difficulties: [0, 2] } });
    // ...and it goes out on the wire as it came in.
    expect(decodeMessage(encodeMessage(welcome as NetMessage))).toEqual(welcome as NetMessage);
  });

  it("takes no fresh HELLO into a running match", () => {
    const room = startedRoom();
    room.handleDisconnect("b");
    const out = room.handleMessage("c", hello());
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_ROOM_FULL });
  });

  it("forgets an emptied lobby's host, so the next HELLO opens it afresh", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    room.handleDisconnect("a");
    const out = room.handleMessage("c", hello(AGREED));
    expect(find(out, MSG_WELCOME)).toMatchObject({ slot: 0, config: AGREED });
  });

  it("treats a duplicate HELLO from an admitted conn as a protocol error", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    const out = room.handleMessage("a", hello());
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_PROTOCOL });
  });
});

describe("RoomLogic networked lobby (protocol 4)", () => {
  it("forwards a lobby message to the other slot only, unread", () => {
    const room = fullLobby();
    expect(room.handleMessage("a", lobbyMsg)).toEqual([{ connId: "b", msg: lobbyMsg }]);
    const ready: NetMessage = { type: MSG_LOBBY, lobby: { id: LOBBY_P1_READY, ready: true } };
    expect(room.handleMessage("b", ready)).toEqual([{ connId: "a", msg: ready }]);
  });

  it("has nobody to tell while alone or once the match is on", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    expect(room.handleMessage("a", lobbyMsg)).toEqual([]);
    const started = startedRoom();
    expect(started.handleMessage("b", lobbyMsg)).toEqual([]);
    expect(find(room.handleMessage("ghost", lobbyMsg), MSG_ERROR)).toEqual({
      type: MSG_ERROR,
      code: ERR_PROTOCOL,
    });
  });

  it("seals the host's BEGIN and starts both on the agreed config", () => {
    const room = fullLobby();
    const out = room.handleMessage("a", { type: MSG_BEGIN, config: AGREED });
    expect(out).toEqual([{ connId: null, msg: { type: MSG_START, startTick: 0, config: AGREED } }]);
    expect(room.isStarted).toBe(true);
    // A rejoin is welcomed with the agreed config, not the host's HELLO.
    room.handleDisconnect("b");
    const back = room.handleMessage("b2", {
      type: MSG_REJOIN,
      protocol: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      slot: 1,
      fromTick: 0,
    });
    expect(find(back, MSG_WELCOME)).toMatchObject({ slot: 1, config: AGREED });
  });

  it("refuses a BEGIN from the joiner, from a host alone, twice, or on another sim", () => {
    const err = (out: Outgoing[]) => find(out, MSG_ERROR);
    const room = fullLobby();
    expect(err(room.handleMessage("b", { type: MSG_BEGIN, config: AGREED }))).toEqual({
      type: MSG_ERROR,
      code: ERR_PROTOCOL,
    });
    expect(
      err(room.handleMessage("a", { type: MSG_BEGIN, config: { ...AGREED, simVersion: 0 } })),
    ).toEqual({ type: MSG_ERROR, code: ERR_VERSION_MISMATCH });
    expect(room.isStarted).toBe(false);
    room.handleMessage("a", { type: MSG_BEGIN, config: AGREED });
    expect(err(room.handleMessage("a", { type: MSG_BEGIN, config: AGREED }))).toEqual({
      type: MSG_ERROR,
      code: ERR_PROTOCOL,
    });
    const alone = new RoomLogic();
    alone.handleMessage("a", hello());
    expect(err(alone.handleMessage("a", { type: MSG_BEGIN, config: AGREED }))).toEqual({
      type: MSG_ERROR,
      code: ERR_PROTOCOL,
    });
  });
});

describe("RoomLogic input sequencing", () => {
  it("broadcasts a FRAME only when both slots' inputs for the tick are in", () => {
    const room = startedRoom();
    expect(room.handleMessage("a", input(0, 10))).toEqual([]); // waiting on b
    const out = room.handleMessage("b", input(0, 20));
    const frame = find(out, MSG_FRAME);
    expect(frame).toBeDefined();
    if (frame?.type === MSG_FRAME) {
      expect(frame.tick).toBe(0);
      expect(frame.inputs[0].buttons).toBe(10);
      expect(frame.inputs[1].buttons).toBe(20);
    }
    expect(room.sequencedTicks).toBe(1);
  });

  it("confirms ticks strictly in order, waiting on the slower slot", () => {
    const room = startedRoom();
    room.handleMessage("a", input(0, 1));
    room.handleMessage("a", input(1, 1));
    room.handleMessage("a", input(2, 1)); // a is ahead, nothing confirmed yet
    expect(room.sequencedTicks).toBe(0);
    expect(types(room.handleMessage("b", input(0, 2)))).toEqual([MSG_FRAME]); // only tick 0
    expect(room.sequencedTicks).toBe(1);
    // b catches up: each late input confirms exactly its now-complete tick, in
    // order, one frame per message.
    expect(types(room.handleMessage("b", input(1, 2)))).toEqual([MSG_FRAME]);
    expect(types(room.handleMessage("b", input(2, 2)))).toEqual([MSG_FRAME]);
    expect(room.sequencedTicks).toBe(3);
  });

  it("rejects input from an unknown connection", () => {
    const room = startedRoom();
    const out = room.handleMessage("ghost", input(0, 1));
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_PROTOCOL });
  });
});

describe("RoomLogic desync detection", () => {
  it("stays silent while hashes agree and flags DESYNC when they differ", () => {
    const room = startedRoom();
    expect(room.handleMessage("a", { type: MSG_HASH, tick: 30, hash: 0xabc })).toEqual([]);
    // Matching hash from b → no desync.
    expect(room.handleMessage("b", { type: MSG_HASH, tick: 30, hash: 0xabc })).toEqual([]);
    // A later tick where they disagree.
    room.handleMessage("a", { type: MSG_HASH, tick: 60, hash: 0x111 });
    const out = room.handleMessage("b", { type: MSG_HASH, tick: 60, hash: 0x222 });
    const desync = find(out, MSG_DESYNC);
    expect(desync).toEqual({ type: MSG_DESYNC, tick: 60 });
    expect(out.find((o) => o.msg.type === MSG_DESYNC)?.connId).toBe(null); // broadcast to both
  });
});

describe("RoomLogic reconnect", () => {
  it("vacates a slot on disconnect and flags the peer", () => {
    const room = startedRoom();
    const out = room.handleDisconnect("b");
    expect(find(out, MSG_PEER)).toEqual({ type: MSG_PEER, slot: 1, present: false });
  });

  it("fast-forwards a rejoining client with the confirmed frame history", () => {
    const room = startedRoom();
    for (let t = 0; t < 5; t++) {
      room.handleMessage("a", input(t, t));
      room.handleMessage("b", input(t, t * 10));
    }
    expect(room.sequencedTicks).toBe(5);
    room.handleDisconnect("b");
    // b rejoins wanting frames from tick 3 onward → gets 3 and 4.
    const out = room.handleMessage("b2", {
      type: MSG_REJOIN,
      protocol: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      slot: 1,
      fromTick: 3,
    });
    expect(find(out, MSG_WELCOME)).toMatchObject({ slot: 1 });
    const frames = out
      .filter((o) => o.msg.type === MSG_FRAME)
      .map((o) => o.msg as Extract<NetMessage, { type: typeof MSG_FRAME }>);
    expect(frames.map((f) => f.tick)).toEqual([3, 4]);
    // Frame history carries BOTH slots' original inputs.
    expect(frames[0].inputs[0].buttons).toBe(3);
    expect(frames[0].inputs[1].buttons).toBe(30);
    // Match continues from where it stalled.
    room.handleMessage("a", input(5, 5));
    expect(types(room.handleMessage("b2", input(5, 50)))).toContain(MSG_FRAME);
  });

  it("refuses to rejoin an occupied slot", () => {
    const room = startedRoom();
    const out = room.handleMessage("c", {
      type: MSG_REJOIN,
      protocol: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      slot: 0,
      fromTick: 0,
    });
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_BAD_REJOIN });
  });

  it("resumes exactly after a DO eviction (hydrate + reseat)", () => {
    // A room ran 3 ticks, then the Durable Object was evicted; the sockets
    // survived. Rebuild from persisted config + frame history.
    const frames: PlayerInput[][] = [];
    for (let t = 0; t < 3; t++) frames.push([inp(t), inp(t * 10)]);
    const room = new RoomLogic();
    room.hydrate(CONFIG, true, frames);
    room.reseat("a", 0);
    room.reseat("b", 1);
    expect(room.isStarted).toBe(true);
    expect(room.sequencedTicks).toBe(3);
    // Both sockets send the next tick → it confirms straight away, carrying on.
    room.handleMessage("a", input(3, 3));
    const out = room.handleMessage("b", input(3, 33));
    const frame = find(out, MSG_FRAME);
    expect(frame).toMatchObject({ type: MSG_FRAME, tick: 3 });
    expect(room.sequencedTicks).toBe(4);
  });

  it("hydrates a config stored before protocol 3 as both players NORMAL", () => {
    const { difficulties: _, loadouts: __, campaignWeapons: ___, ...stored } = CONFIG;
    const room = new RoomLogic();
    room.hydrate(stored as unknown as MatchConfig, true, []);
    const out = room.handleMessage("a", {
      type: MSG_REJOIN,
      protocol: PROTOCOL_VERSION,
      simVersion: SIM_VERSION,
      slot: 0,
      fromTick: 0,
    });
    const welcome = find(out, MSG_WELCOME) as NetMessage;
    expect(welcome).toMatchObject({
      config: { difficulties: [1, 1], loadouts: DEFAULT_LOADOUTS, campaignWeapons: false },
    });
    expect(() => encodeMessage(welcome)).not.toThrow();
  });

  it("trusts only the contiguous prefix when hydrated history is sparse", () => {
    // Corrupt/sparse storage: tick 2 is missing. The room must resume at the
    // gap (sequenced through 0,1), not claim it reached tick 4.
    const frames: PlayerInput[][] = [];
    frames[0] = [inp(0), inp(0)];
    frames[1] = [inp(1), inp(1)];
    frames[3] = [inp(3), inp(3)]; // tick 2 hole
    const room = new RoomLogic();
    room.hydrate(CONFIG, true, frames);
    room.reseat("a", 0);
    room.reseat("b", 1);
    expect(room.sequencedTicks).toBe(2);
    // Play resumes by re-confirming tick 2, then flows into the next tick.
    expect(types(room.handleMessage("a", input(2, 2)))).toEqual([]);
    expect(types(room.handleMessage("b", input(2, 22)))).toEqual([MSG_FRAME]);
    expect(room.sequencedTicks).toBe(3);
  });
});
