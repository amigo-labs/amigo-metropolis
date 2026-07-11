// Pure lobby/signaling logic for one lobby — the brain of the LobbyDO
// (hosting.spec.md §3.2), with ZERO Cloudflare dependencies so it runs (and is
// exhaustively tested) under `bun test`, exactly like RoomLogic. The DO
// (lobbyDo.ts) is a thin adapter: it maps WebSockets to connection ids, hands
// each decoded JSON message here with the current wall-clock, and executes the
// returned Outgoing[] (socket sends/closes) and LobbyEffect[] (directory
// register/unregister, alarm scheduling).
//
// A lobby brokers the WebRTC handshake between EXACTLY two peers: the host
// creates it, a joiner is admitted, SDP/ICE blobs are relayed opaquely, and
// once the peers report their DataChannel open the lobby closes — the match
// itself runs peer-to-peer over TURN and never touches this DO again. State is
// in-memory only (no storage billing); ghost lobbies are reaped by alarm TTLs.
//
// JSON (not the binary protocol) is deliberate: signaling is a handful of
// SDP-sized text blobs, not the 30 Hz hot path.

import type { MatchConfig } from "@metropolis/sim";

// --- Lifecycle timeouts (wall-clock ms; server-side, not gameplay) -----------

/** A socket that connects but never creates/joins is dropped after this. */
export const LOBBY_CONNECT_TTL_MS = 60_000;
/** An open lobby nobody joins closes after this (ghost-lobby reaper). */
export const LOBBY_OPEN_TTL_MS = 10 * 60_000;
/** Join → DataChannel-open must complete within this, or the lobby closes. */
export const LOBBY_SIGNALING_TTL_MS = 90_000;

export const LOBBY_NAME_MAX = 40;

// --- Wire schema (JSON over the lobby WebSocket) ------------------------------

export type LobbyVisibility = "public" | "private";

export type LobbyClientMsg =
  | {
      readonly t: "create";
      readonly name: string;
      readonly visibility: LobbyVisibility;
      readonly config: MatchConfig;
      /** SHA-256 hex of the lobby password (hashed client-side); absent = open. */
      readonly passwordHash?: string;
    }
  | { readonly t: "join"; readonly simVersion: number; readonly passwordHash?: string }
  | { readonly t: "signal"; readonly data: unknown }
  | { readonly t: "matchStarted" };

export type LobbyCloseReason = "ttl" | "hostLeft" | "matched";

export type LobbyErrorCode =
  | "protocol" // malformed / out-of-order message
  | "closed" // lobby is not (or no longer) joinable
  | "full" // both seats taken
  | "versionMismatch" // joiner runs a different SIM_VERSION
  | "badPassword" // wrong (or missing) password hash
  | "noPeer"; // signal sent while alone

export type LobbyServerMsg =
  | { readonly t: "created"; readonly lobbyId: string }
  | { readonly t: "joined"; readonly config: MatchConfig }
  | { readonly t: "peerJoined" }
  | { readonly t: "signal"; readonly data: unknown }
  | { readonly t: "peerLeft" }
  | { readonly t: "closed"; readonly reason: LobbyCloseReason }
  | { readonly t: "error"; readonly code: LobbyErrorCode };

/** One message to send; `close` drops that socket after delivery. */
export interface LobbyOutgoing {
  readonly connId: string;
  readonly msg: LobbyServerMsg;
  readonly close?: boolean;
}

/** Side effects the DO adapter must execute (pure logic never does I/O). */
export type LobbyEffect =
  | {
      readonly kind: "register";
      readonly lobbyId: string;
      readonly name: string;
      readonly hasPassword: boolean;
    }
  | { readonly kind: "unregister"; readonly lobbyId: string }
  | { readonly kind: "setAlarm"; readonly atMs: number }
  | { readonly kind: "clearAlarm" };

export interface LobbyResult {
  readonly out: LobbyOutgoing[];
  readonly effects: LobbyEffect[];
}

export type LobbyStatus = "idle" | "open" | "signaling" | "closed";

// --- Message validation --------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Accepts only online-1v1 configs (no Warden slot — hosting.spec.md §1). */
function parseConfig(v: unknown): MatchConfig | null {
  if (!isRecord(v)) return null;
  const { simVersion, seed, mapId, wardenPlayer, wardenDifficulty } = v;
  if (
    !Number.isInteger(simVersion) ||
    (simVersion as number) < 0 ||
    (simVersion as number) > 0xffff
  )
    return null;
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff) return null;
  if (typeof mapId !== "string" || mapId.length === 0 || mapId.length > 255 || !isAscii(mapId))
    return null;
  if (wardenPlayer !== -1 || wardenDifficulty !== 0) return null;
  return {
    simVersion: simVersion as number,
    seed: seed as number,
    mapId,
    wardenPlayer: -1,
    wardenDifficulty: 0,
  };
}

/** A client-side SHA-256 digest: exactly 64 lowercase hex chars. */
function isPasswordHash(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/** Strict shape check for untrusted client JSON; null = malformed. */
export function parseLobbyClientMsg(v: unknown): LobbyClientMsg | null {
  if (!isRecord(v)) return null;
  switch (v.t) {
    case "create": {
      if (typeof v.name !== "string" || v.name.length > LOBBY_NAME_MAX) return null;
      if (v.visibility !== "public" && v.visibility !== "private") return null;
      const config = parseConfig(v.config);
      if (!config) return null;
      if (v.passwordHash !== undefined && !isPasswordHash(v.passwordHash)) return null;
      const base = { t: "create", name: v.name, visibility: v.visibility, config } as const;
      return v.passwordHash === undefined ? base : { ...base, passwordHash: v.passwordHash };
    }
    case "join": {
      if (!Number.isInteger(v.simVersion)) return null;
      if (v.passwordHash !== undefined && !isPasswordHash(v.passwordHash)) return null;
      const base = { t: "join", simVersion: v.simVersion as number } as const;
      return v.passwordHash === undefined ? base : { ...base, passwordHash: v.passwordHash };
    }
    case "signal":
      return "data" in v ? { t: "signal", data: v.data } : null;
    case "matchStarted":
      return { t: "matchStarted" };
    default:
      return null;
  }
}

// --- Logic ----------------------------------------------------------------------

export class LobbyLogic {
  private state: LobbyStatus = "idle";
  private lobbyId = "";
  private name = "";
  private visibility: LobbyVisibility = "private";
  private config: MatchConfig | null = null;
  private passwordHash: string | null = null;
  private hostConn: string | null = null;
  private joinerConn: string | null = null;
  /** Sockets connected but not yet seated (pre-create/join). */
  private readonly pending = new Set<string>();
  /** Currently listed in the public directory. */
  private registered = false;
  /** Wall-clock deadline for the current status (0 = none). */
  private deadlineAt = 0;
  /** Why the lobby closed (echoed to late arrivals). */
  private closedReason: LobbyCloseReason = "ttl";

  get status(): LobbyStatus {
    return this.state;
  }

  /** A socket connected; the adapter passes the lobby code from the URL. */
  handleOpen(connId: string, lobbyId: string, nowMs: number): LobbyResult {
    if (this.lobbyId === "") this.lobbyId = lobbyId;
    if (this.state === "closed") {
      const msg: LobbyServerMsg = { t: "closed", reason: this.closedReason };
      return { out: [{ connId, msg, close: true }], effects: [] };
    }
    this.pending.add(connId);
    // Arm the ghost reaper as soon as anything touches the lobby.
    if (this.state === "idle" && this.deadlineAt === 0) {
      return { out: [], effects: this.deadline(nowMs + LOBBY_CONNECT_TTL_MS) };
    }
    return { out: [], effects: [] };
  }

  handleMessage(connId: string, raw: unknown, nowMs: number): LobbyResult {
    const msg = parseLobbyClientMsg(raw);
    if (!msg) return this.errTo(connId, "protocol", /*close*/ true);
    if (this.state === "closed") return this.errTo(connId, "closed", true);
    switch (msg.t) {
      case "create":
        return this.onCreate(connId, msg, nowMs);
      case "join":
        return this.onJoin(connId, msg, nowMs);
      case "signal":
        return this.onSignal(connId, msg.data);
      case "matchStarted":
        return this.onMatchStarted(connId);
    }
  }

  handleDisconnect(connId: string, nowMs: number): LobbyResult {
    this.pending.delete(connId);
    if (connId === this.hostConn && this.state !== "closed") {
      // The creator left before the match — the lobby dies with them.
      this.hostConn = null;
      return this.close("hostLeft");
    }
    if (connId === this.joinerConn && this.state === "signaling") {
      // Joiner bailed mid-handshake: back to open, relist, restart the TTL.
      this.joinerConn = null;
      this.state = "open";
      const out: LobbyOutgoing[] = [];
      if (this.hostConn) out.push({ connId: this.hostConn, msg: { t: "peerLeft" } });
      const effects = this.deadline(nowMs + LOBBY_OPEN_TTL_MS);
      if (this.visibility === "public" && !this.registered) {
        this.registered = true;
        effects.push({
          kind: "register",
          lobbyId: this.lobbyId,
          name: this.name,
          hasPassword: this.passwordHash !== null,
        });
      }
      return { out, effects };
    }
    return { out: [], effects: [] };
  }

  /** Alarm fired: reap if the current deadline passed, else re-arm (stale alarm). */
  handleAlarm(nowMs: number): LobbyResult {
    if (this.state === "closed" || this.deadlineAt === 0) return { out: [], effects: [] };
    if (nowMs < this.deadlineAt) {
      return { out: [], effects: [{ kind: "setAlarm", atMs: this.deadlineAt }] };
    }
    return this.close("ttl");
  }

  // --- message handlers ---------------------------------------------------------

  private onCreate(
    connId: string,
    msg: LobbyClientMsg & { t: "create" },
    nowMs: number,
  ): LobbyResult {
    if (this.state !== "idle" || !this.pending.has(connId)) {
      return this.errTo(connId, "protocol", true);
    }
    this.pending.delete(connId);
    this.state = "open";
    this.hostConn = connId;
    this.name = msg.name;
    this.visibility = msg.visibility;
    this.config = msg.config;
    this.passwordHash = msg.passwordHash ?? null;
    const out: LobbyOutgoing[] = [{ connId, msg: { t: "created", lobbyId: this.lobbyId } }];
    const effects = this.deadline(nowMs + LOBBY_OPEN_TTL_MS);
    if (msg.visibility === "public") {
      this.registered = true;
      effects.push({
        kind: "register",
        lobbyId: this.lobbyId,
        name: this.name,
        hasPassword: this.passwordHash !== null,
      });
    }
    return { out, effects };
  }

  private onJoin(connId: string, msg: LobbyClientMsg & { t: "join" }, nowMs: number): LobbyResult {
    if (!this.pending.has(connId) || connId === this.hostConn) {
      return this.errTo(connId, "protocol", true);
    }
    if (this.state === "idle") return this.errTo(connId, "closed", true);
    if (this.state !== "open") return this.errTo(connId, "full", true);
    const config = this.config as MatchConfig;
    if (msg.simVersion !== config.simVersion) {
      return this.errTo(connId, "versionMismatch", true);
    }
    // Server-side password gate (hosting.spec.md §3.2): nothing about the host
    // (config, signaling) leaves this DO until the hash matches. Non-fatal so
    // a typo can be retried on the same socket.
    if (this.passwordHash !== null && msg.passwordHash !== this.passwordHash) {
      return this.errTo(connId, "badPassword");
    }
    this.pending.delete(connId);
    this.joinerConn = connId;
    this.state = "signaling";
    const out: LobbyOutgoing[] = [{ connId, msg: { t: "joined", config } }];
    if (this.hostConn) out.push({ connId: this.hostConn, msg: { t: "peerJoined" } });
    const effects = this.deadline(nowMs + LOBBY_SIGNALING_TTL_MS);
    if (this.registered) {
      // Two seats, both taken — delist while the handshake runs.
      this.registered = false;
      effects.push({ kind: "unregister", lobbyId: this.lobbyId });
    }
    return { out, effects };
  }

  private onSignal(connId: string, data: unknown): LobbyResult {
    const peer =
      connId === this.hostConn
        ? this.joinerConn
        : connId === this.joinerConn
          ? this.hostConn
          : undefined;
    if (peer === undefined) return this.errTo(connId, "protocol", true);
    if (peer === null) return this.errTo(connId, "noPeer");
    return { out: [{ connId: peer, msg: { t: "signal", data } }], effects: [] };
  }

  private onMatchStarted(connId: string): LobbyResult {
    if (connId !== this.hostConn && connId !== this.joinerConn) {
      return this.errTo(connId, "protocol", true);
    }
    if (this.state !== "signaling") return this.errTo(connId, "protocol");
    // The peers are talking over TURN — this DO's job is done. Closing the
    // sockets here is what makes a match cost a handful of DO requests total.
    return this.close("matched");
  }

  // --- helpers --------------------------------------------------------------------

  /** Closes the lobby: notify+drop every socket, delist, disarm the alarm. */
  private close(reason: LobbyCloseReason): LobbyResult {
    this.state = "closed";
    this.closedReason = reason;
    this.deadlineAt = 0;
    const out: LobbyOutgoing[] = [];
    for (const connId of this.allConns()) {
      out.push({ connId, msg: { t: "closed", reason }, close: true });
    }
    const effects: LobbyEffect[] = [{ kind: "clearAlarm" }];
    if (this.registered) {
      this.registered = false;
      effects.push({ kind: "unregister", lobbyId: this.lobbyId });
    }
    return { out, effects };
  }

  private allConns(): string[] {
    const conns: string[] = [];
    if (this.hostConn) conns.push(this.hostConn);
    if (this.joinerConn) conns.push(this.joinerConn);
    conns.push(...this.pending);
    return conns;
  }

  private deadline(atMs: number): LobbyEffect[] {
    this.deadlineAt = atMs;
    return [{ kind: "setAlarm", atMs }];
  }

  private errTo(connId: string, code: LobbyErrorCode, close = false): LobbyResult {
    const msg: LobbyServerMsg = { t: "error", code };
    return { out: [close ? { connId, msg, close: true } : { connId, msg }], effects: [] };
  }
}
