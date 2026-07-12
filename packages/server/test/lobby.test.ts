// LobbyLogic unit tests — the full signaling lifecycle (hosting.spec.md §3.2,
// §6) without any Cloudflare runtime: create/join, SDP/ICE relay for exactly
// two peers, TTL reaping, and the directory/alarm effects the DO must execute.

import { describe, expect, test } from "bun:test";
import {
  LOBBY_CONNECT_TTL_MS,
  LOBBY_OPEN_TTL_MS,
  LOBBY_SIGNALING_TTL_MS,
  type LobbyEffect,
  LobbyLogic,
  type LobbyOutgoing,
  type LobbyResult,
  parseLobbyClientMsg,
} from "@metropolis/server/lobby";
import type { MatchConfig } from "@metropolis/sim";

const T0 = 1_000_000;
const CFG: MatchConfig = {
  simVersion: 7,
  seed: 123,
  mapId: "district01",
  wardenPlayer: -1,
  wardenDifficulty: 0,
};

function createMsg(visibility: "public" | "private" = "public"): unknown {
  return { t: "create", name: "Test Arena", visibility, config: CFG };
}

/** Opens a lobby with host "h"; returns the create result. */
function openLobby(logic: LobbyLogic, visibility: "public" | "private" = "public"): LobbyResult {
  logic.handleOpen("h", "ABCDE", T0);
  return logic.handleMessage("h", createMsg(visibility), T0);
}

/** Seats joiner "j"; returns the join result. */
function seatJoiner(logic: LobbyLogic): LobbyResult {
  logic.handleOpen("j", "ABCDE", T0 + 1000);
  return logic.handleMessage("j", { t: "join", simVersion: 7 }, T0 + 1000);
}

function msgsTo(out: LobbyOutgoing[], connId: string): LobbyOutgoing[] {
  return out.filter((o) => o.connId === connId);
}

function effectKinds(effects: LobbyEffect[]): string[] {
  return effects.map((e) => e.kind);
}

describe("LobbyLogic lifecycle", () => {
  test("first connect arms the connect TTL", () => {
    const logic = new LobbyLogic();
    const r = logic.handleOpen("h", "ABCDE", T0);
    expect(r.effects).toEqual([{ kind: "setAlarm", atMs: T0 + LOBBY_CONNECT_TTL_MS }]);
    expect(logic.status).toBe("idle");
  });

  test("create opens the lobby, registers a public one, arms the open TTL", () => {
    const logic = new LobbyLogic();
    const r = openLobby(logic);
    expect(r.out).toEqual([{ connId: "h", msg: { t: "created", lobbyId: "ABCDE" } }]);
    expect(r.effects).toEqual([
      { kind: "setAlarm", atMs: T0 + LOBBY_OPEN_TTL_MS },
      { kind: "register", lobbyId: "ABCDE", name: "Test Arena", hasPassword: false },
    ]);
    expect(logic.status).toBe("open");
  });

  test("a private lobby never registers with the directory", () => {
    const logic = new LobbyLogic();
    const r = openLobby(logic, "private");
    expect(effectKinds(r.effects)).toEqual(["setAlarm"]);
  });

  test("join hands the config to the joiner, flags the host, delists", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    const r = seatJoiner(logic);
    expect(msgsTo(r.out, "j")[0].msg).toEqual({ t: "joined", config: CFG });
    expect(msgsTo(r.out, "h")[0].msg).toEqual({ t: "peerJoined" });
    expect(r.effects).toEqual([
      { kind: "setAlarm", atMs: T0 + 1000 + LOBBY_SIGNALING_TTL_MS },
      { kind: "unregister", lobbyId: "ABCDE" },
    ]);
    expect(logic.status).toBe("signaling");
  });

  test("simVersion mismatch rejects the joiner but keeps the lobby open", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    logic.handleOpen("j", "ABCDE", T0);
    const r = logic.handleMessage("j", { t: "join", simVersion: 8 }, T0);
    expect(r.out).toEqual([
      { connId: "j", msg: { t: "error", code: "versionMismatch" }, close: true },
    ]);
    expect(logic.status).toBe("open");
    // …and the seat is still takeable.
    logic.handleDisconnect("j", T0);
    expect(seatJoiner(logic).out.length).toBe(2);
  });

  test("a third peer is turned away with 'full'", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    seatJoiner(logic);
    logic.handleOpen("x", "ABCDE", T0);
    const r = logic.handleMessage("x", { t: "join", simVersion: 7 }, T0);
    expect(r.out).toEqual([{ connId: "x", msg: { t: "error", code: "full" }, close: true }]);
  });

  test("join before create reads as 'closed' (nothing here)", () => {
    const logic = new LobbyLogic();
    logic.handleOpen("j", "ABCDE", T0);
    const r = logic.handleMessage("j", { t: "join", simVersion: 7 }, T0);
    expect(r.out[0].msg).toEqual({ t: "error", code: "closed" });
  });

  test("signal relays opaquely in both directions", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    seatJoiner(logic);
    const offer = { sdp: "v=0 offer", type: "offer" };
    const hostToJoiner = logic.handleMessage("h", { t: "signal", data: offer }, T0);
    expect(hostToJoiner.out).toEqual([{ connId: "j", msg: { t: "signal", data: offer } }]);
    const ice = { candidate: "candidate:1 1 udp …" };
    const joinerToHost = logic.handleMessage("j", { t: "signal", data: ice }, T0);
    expect(joinerToHost.out).toEqual([{ connId: "h", msg: { t: "signal", data: ice } }]);
  });

  test("signal while alone is 'noPeer'; from an unseated socket it is fatal", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    const alone = logic.handleMessage("h", { t: "signal", data: 1 }, T0);
    expect(alone.out).toEqual([{ connId: "h", msg: { t: "error", code: "noPeer" } }]);
    logic.handleOpen("x", "ABCDE", T0);
    const stranger = logic.handleMessage("x", { t: "signal", data: 1 }, T0);
    expect(stranger.out).toEqual([
      { connId: "x", msg: { t: "error", code: "protocol" }, close: true },
    ]);
  });

  test("matchStarted closes the lobby for everyone and disarms the alarm", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    seatJoiner(logic);
    const r = logic.handleMessage("j", { t: "matchStarted" }, T0 + 5000);
    expect(r.out).toEqual([
      { connId: "h", msg: { t: "closed", reason: "matched" }, close: true },
      { connId: "j", msg: { t: "closed", reason: "matched" }, close: true },
    ]);
    expect(effectKinds(r.effects)).toEqual(["clearAlarm"]);
    expect(logic.status).toBe("closed");
  });

  test("host leaving kills the lobby and delists it", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    seatJoiner(logic);
    const r = logic.handleDisconnect("h", T0 + 2000);
    expect(r.out).toEqual([{ connId: "j", msg: { t: "closed", reason: "hostLeft" }, close: true }]);
    // Delisted already at join; only the alarm is left to clear.
    expect(effectKinds(r.effects)).toEqual(["clearAlarm"]);
    expect(logic.status).toBe("closed");
  });

  test("host leaving an open public lobby also unregisters it", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    const r = logic.handleDisconnect("h", T0 + 2000);
    expect(effectKinds(r.effects)).toEqual(["clearAlarm", "unregister"]);
  });

  test("joiner bailing mid-signaling reopens and relists the lobby", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    seatJoiner(logic);
    const r = logic.handleDisconnect("j", T0 + 2000);
    expect(r.out).toEqual([{ connId: "h", msg: { t: "peerLeft" } }]);
    expect(r.effects).toEqual([
      { kind: "setAlarm", atMs: T0 + 2000 + LOBBY_OPEN_TTL_MS },
      { kind: "register", lobbyId: "ABCDE", name: "Test Arena", hasPassword: false },
    ]);
    expect(logic.status).toBe("open");
    expect(seatJoiner(logic).out.length).toBe(2);
  });

  test("TTL alarm reaps an open lobby", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    const r = logic.handleAlarm(T0 + LOBBY_OPEN_TTL_MS);
    expect(r.out).toEqual([{ connId: "h", msg: { t: "closed", reason: "ttl" }, close: true }]);
    expect(effectKinds(r.effects)).toEqual(["clearAlarm", "unregister"]);
    expect(logic.status).toBe("closed");
  });

  test("a stale alarm re-arms for the live deadline instead of reaping", () => {
    const logic = new LobbyLogic();
    openLobby(logic); // deadline: T0 + OPEN_TTL
    seatJoiner(logic); // deadline: T0 + 1000 + SIGNALING_TTL
    const r = logic.handleAlarm(T0 + 5000);
    expect(r.out).toEqual([]);
    expect(r.effects).toEqual([{ kind: "setAlarm", atMs: T0 + 1000 + LOBBY_SIGNALING_TTL_MS }]);
    expect(logic.status).toBe("signaling");
  });

  test("idle ghost (connect, never create) is reaped by the connect TTL", () => {
    const logic = new LobbyLogic();
    logic.handleOpen("h", "ABCDE", T0);
    const r = logic.handleAlarm(T0 + LOBBY_CONNECT_TTL_MS);
    expect(r.out).toEqual([{ connId: "h", msg: { t: "closed", reason: "ttl" }, close: true }]);
    expect(logic.status).toBe("closed");
  });

  test("messages to a closed lobby answer 'closed' and drop the socket", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    logic.handleMessage("h", { t: "matchStarted" }, T0); // protocol err (not signaling)
    logic.handleAlarm(T0 + LOBBY_OPEN_TTL_MS);
    const r = logic.handleMessage("h", { t: "signal", data: 1 }, T0);
    expect(r.out).toEqual([{ connId: "h", msg: { t: "error", code: "closed" }, close: true }]);
  });

  test("late arrival to a closed lobby learns the real close reason", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    seatJoiner(logic);
    logic.handleMessage("h", { t: "matchStarted" }, T0);
    const r = logic.handleOpen("x", "ABCDE", T0 + 9000);
    expect(r.out).toEqual([{ connId: "x", msg: { t: "closed", reason: "matched" }, close: true }]);
  });

  test("malformed payloads are fatal protocol errors", () => {
    const logic = new LobbyLogic();
    logic.handleOpen("h", "ABCDE", T0);
    const r = logic.handleMessage("h", { t: "definitely-not-a-message" }, T0);
    expect(r.out).toEqual([{ connId: "h", msg: { t: "error", code: "protocol" }, close: true }]);
  });

  test("double create is a fatal protocol error", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    logic.handleOpen("x", "ABCDE", T0);
    const r = logic.handleMessage("x", createMsg(), T0);
    expect(r.out).toEqual([{ connId: "x", msg: { t: "error", code: "protocol" }, close: true }]);
  });
});

describe("parseLobbyClientMsg", () => {
  const goodCreate = createMsg() as Record<string, unknown>;

  test("accepts the canonical shapes", () => {
    expect(parseLobbyClientMsg(goodCreate)).not.toBeNull();
    expect(parseLobbyClientMsg({ t: "join", simVersion: 7 })).toEqual({
      t: "join",
      simVersion: 7,
    });
    expect(parseLobbyClientMsg({ t: "signal", data: { x: 1 } })).toEqual({
      t: "signal",
      data: { x: 1 },
    });
    expect(parseLobbyClientMsg({ t: "matchStarted" })).toEqual({ t: "matchStarted" });
  });

  test("rejects junk", () => {
    expect(parseLobbyClientMsg(null)).toBeNull();
    expect(parseLobbyClientMsg("create")).toBeNull();
    expect(parseLobbyClientMsg({ t: "create" })).toBeNull();
    expect(parseLobbyClientMsg({ t: "join", simVersion: "7" })).toBeNull();
    expect(parseLobbyClientMsg({ t: "signal" })).toBeNull();
  });

  test("rejects a config that is not an online-1v1 config", () => {
    const warden = { ...goodCreate, config: { ...CFG, wardenPlayer: 1, wardenDifficulty: 5 } };
    expect(parseLobbyClientMsg(warden)).toBeNull();
    const badSeed = { ...goodCreate, config: { ...CFG, seed: -1 } };
    expect(parseLobbyClientMsg(badSeed)).toBeNull();
    const badMap = { ...goodCreate, config: { ...CFG, mapId: "über-map" } };
    expect(parseLobbyClientMsg(badMap)).toBeNull();
  });

  test("rejects an over-long lobby name", () => {
    const longName = { ...goodCreate, name: "x".repeat(41) };
    expect(parseLobbyClientMsg(longName)).toBeNull();
  });
});

describe("LobbyLogic passwords (server-side gate)", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  function openLocked(logic: LobbyLogic): void {
    logic.handleOpen("h", "ABCDE", T0);
    logic.handleMessage(
      "h",
      { t: "create", name: "Locked", visibility: "public", config: CFG, passwordHash: HASH_A },
      T0,
    );
  }

  test("a locked lobby registers as password-protected", () => {
    const logic = new LobbyLogic();
    logic.handleOpen("h", "ABCDE", T0);
    const r = logic.handleMessage(
      "h",
      { t: "create", name: "Locked", visibility: "public", config: CFG, passwordHash: HASH_A },
      T0,
    );
    expect(r.effects).toContainEqual({
      kind: "register",
      lobbyId: "ABCDE",
      name: "Locked",
      hasPassword: true,
    });
  });

  test("wrong or missing password is rejected without seating — retry allowed", () => {
    const logic = new LobbyLogic();
    openLocked(logic);
    logic.handleOpen("j", "ABCDE", T0);
    const missing = logic.handleMessage("j", { t: "join", simVersion: 7 }, T0);
    expect(missing.out).toEqual([{ connId: "j", msg: { t: "error", code: "badPassword" } }]);
    const wrong = logic.handleMessage("j", { t: "join", simVersion: 7, passwordHash: HASH_B }, T0);
    expect(wrong.out).toEqual([{ connId: "j", msg: { t: "error", code: "badPassword" } }]);
    expect(logic.status).toBe("open"); // nothing about the host was released
    const right = logic.handleMessage("j", { t: "join", simVersion: 7, passwordHash: HASH_A }, T0);
    expect(right.out.map((o) => o.msg.t).sort()).toEqual(["joined", "peerJoined"]);
    expect(logic.status).toBe("signaling");
  });

  test("an open lobby ignores a supplied password", () => {
    const logic = new LobbyLogic();
    openLobby(logic);
    logic.handleOpen("j", "ABCDE", T0);
    const r = logic.handleMessage("j", { t: "join", simVersion: 7, passwordHash: HASH_B }, T0);
    expect(r.out.map((o) => o.msg.t).sort()).toEqual(["joined", "peerJoined"]);
  });

  test("a malformed password hash is a protocol error", () => {
    const logic = new LobbyLogic();
    openLocked(logic);
    logic.handleOpen("j", "ABCDE", T0);
    const r = logic.handleMessage("j", { t: "join", simVersion: 7, passwordHash: "HUNTER2" }, T0);
    expect(r.out).toEqual([{ connId: "j", msg: { t: "error", code: "protocol" }, close: true }]);
    expect(
      parseLobbyClientMsg({ t: "join", simVersion: 7, passwordHash: "A".repeat(64) }),
    ).toBeNull();
  });
});
