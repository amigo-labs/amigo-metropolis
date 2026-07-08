// Pure relay behaviour (room.ts). RoomLogic is deliberately Cloudflare-free so
// the whole lockstep-sequencing / handshake / desync / reconnect contract is
// provable under `bun test`; the DO adapter adds only socket plumbing on top.

import { describe, expect, it } from "bun:test";
import {
  ERR_BAD_REJOIN,
  ERR_PROTOCOL,
  ERR_ROOM_FULL,
  ERR_VERSION_MISMATCH,
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
  type NetMessage,
  type PlayerInput,
  PROTOCOL_VERSION,
  SIM_VERSION,
} from "@metropolis/sim";
import { type Outgoing, RoomLogic } from "../src/room";

const CONFIG: MatchConfig = {
  simVersion: SIM_VERSION,
  seed: 0xc0ffee,
  mapId: "district-01",
  wardenPlayer: -1,
  wardenDifficulty: 0,
};

const hello = (config = CONFIG): NetMessage => ({
  type: MSG_HELLO,
  protocol: PROTOCOL_VERSION,
  config,
});
const inp = (x: number): PlayerInput => ({ moveX: x, moveY: 0, aimX: 0, aimY: 0, buttons: 0 });
const input = (tick: number, x: number): NetMessage => ({ type: MSG_INPUT, tick, input: inp(x) });

/** Types of the outgoing messages, ignoring targets — handy for assertions. */
const types = (out: Outgoing[]): number[] => out.map((o) => o.msg.type);
const find = (out: Outgoing[], type: number): NetMessage | undefined =>
  out.find((o) => o.msg.type === type)?.msg;

/** Seats two players and returns the room ready to relay from tick 0. */
function startedRoom(): RoomLogic {
  const room = new RoomLogic();
  room.handleMessage("a", hello());
  room.handleMessage("b", hello());
  return room;
}

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

  it("welcomes a joiner into slot 1 and starts the match", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    const out = room.handleMessage("b", hello());
    expect(find(out, MSG_WELCOME)).toMatchObject({ slot: 1 });
    // Joiner is told the host is present, and START goes to both.
    expect(out.some((o) => o.msg.type === MSG_PEER && o.connId === "b")).toBe(true);
    const start = out.find((o) => o.msg.type === MSG_START);
    expect(start?.connId).toBe(null); // broadcast
    expect(room.isStarted).toBe(true);
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

  it("rejects a mismatched protocol version", () => {
    const room = new RoomLogic();
    const out = room.handleMessage("a", {
      type: MSG_HELLO,
      protocol: PROTOCOL_VERSION + 1,
      config: CONFIG,
    });
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_VERSION_MISMATCH });
  });

  it("treats a duplicate HELLO from an admitted conn as a protocol error", () => {
    const room = new RoomLogic();
    room.handleMessage("a", hello());
    const out = room.handleMessage("a", hello());
    expect(find(out, MSG_ERROR)).toEqual({ type: MSG_ERROR, code: ERR_PROTOCOL });
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
      expect(frame.inputs[0].moveX).toBe(10);
      expect(frame.inputs[1].moveX).toBe(20);
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
    expect(frames[0].inputs[0].moveX).toBe(3);
    expect(frames[0].inputs[1].moveX).toBe(30);
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
});
