/// <reference types="@cloudflare/workers-types" />
// Lobby/signaling Durable Object (hosting.spec.md §3.2) — one instance per
// lobby code; brokers SDP/ICE between exactly two peers over WebSocket JSON.
// THE DO NEVER DECIDES — every decision lives in the pure, unit-tested
// LobbyLogic; this file is only plumbing: socket ↔ connId mapping, JSON
// (de)serialization, and executing LobbyEffects (directory register/unregister
// via the DIRECTORY singleton, alarm scheduling).
//
// Lobby state is deliberately in-memory only (no storage billing). If the DO
// is evicted mid-signaling (sub-minute window, so rare), surviving sockets
// show up with unknown connIds and are told the lobby closed — both clients
// simply retry with a fresh code. The persisted alarm still fires and finds
// nothing to do.

import { GATE_SESSION_TURN_MB } from "./gatekeeper";
import type { Env } from "./index";
import { LobbyLogic, type LobbyResult, type LobbyServerMsg } from "./lobby";
import { issueTurnCredentials, type LobbyIceConfig } from "./turn";

interface Attachment {
  connId: string;
}

export class LobbyDO implements DurableObject {
  private readonly logic = new LobbyLogic();
  private readonly conns = new Map<string, WebSocket>();
  /** connIds this instance has seen — distinguishes pre-eviction sockets. */
  private readonly known = new Set<string>();
  /** Budget reservation for this lobby's session (hosting.spec.md §3.4). */
  private sessionId: string | null = null;
  /** Actual DO events handled — the reconciliation's request count. */
  private requestCount = 0;
  private matched = false;
  private reconciled = false;
  /** One credential issue per lobby, shared by both peers' messages. */
  private icePromise: Promise<LobbyIceConfig | null> | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    this.requestCount++;
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const lobbyId = (url.pathname.split("/").filter(Boolean)[1] ?? "").toUpperCase();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const connId = crypto.randomUUID();
    server.serializeAttachment({ connId } satisfies Attachment);
    this.conns.set(connId, server);
    this.known.add(connId);
    await this.apply(this.logic.handleOpen(connId, lobbyId, Date.now()));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    this.requestCount++;
    const connId = this.connIdOf(ws);
    if (connId === null) return this.orphan(ws);
    let raw: unknown = null; // binary is never valid signaling → protocol error
    if (typeof data === "string") {
      try {
        raw = JSON.parse(data);
      } catch {
        raw = null;
      }
    }
    // Budget gate (hosting.spec.md §5): a lobby only opens if the gatekeeper
    // grants a session — enforced HERE so no client can skip the check.
    if (
      this.sessionId === null &&
      typeof raw === "object" &&
      raw !== null &&
      (raw as { t?: unknown }).t === "create"
    ) {
      const gate = await this.gateReserve();
      if (!gate.ok) {
        const msg: LobbyServerMsg = { t: "error", code: "soldOut", retryAtMs: gate.retryAtMs };
        try {
          ws.send(JSON.stringify(msg));
          ws.close(1000, "sold out");
        } catch {
          // already gone
        }
        return;
      }
      this.sessionId = gate.sessionId;
    }
    await this.apply(this.logic.handleMessage(connId, raw, Date.now()));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.requestCount++;
    const connId = this.connIdOf(ws);
    if (connId === null) return;
    this.conns.delete(connId);
    await this.apply(this.logic.handleDisconnect(connId, Date.now()));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    this.requestCount++;
    await this.apply(this.logic.handleAlarm(Date.now()));
  }

  // --- plumbing ---------------------------------------------------------------

  /** Resolves a socket to its connId, or null for a pre-eviction survivor. */
  private connIdOf(ws: WebSocket): string | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || !this.known.has(att.connId)) return null;
    return att.connId;
  }

  /** A socket from before an eviction: its lobby state is gone — say so. */
  private orphan(ws: WebSocket): void {
    const msg: LobbyServerMsg = { t: "closed", reason: "ttl" };
    try {
      ws.send(JSON.stringify(msg));
      ws.close(1000, "lobby state lost");
    } catch {
      // already gone
    }
  }

  /**
   * Asks the gatekeeper singleton for a session. A transport failure fails
   * OPEN (a gate glitch must not black out the game); an explicit denial is
   * honoured — that is the "sold out for today" path.
   */
  private async gateReserve(): Promise<
    { ok: true; sessionId: string | null } | { ok: false; retryAtMs?: number }
  > {
    const stub = this.env.GATEKEEPER.get(this.env.GATEKEEPER.idFromName("gatekeeper"));
    try {
      const res = await stub.fetch("https://gatekeeper/reserve", { method: "POST" });
      const body = (await res.json()) as
        | { ok: true; sessionId: string }
        | { ok: false; retryAtMs: number };
      return body.ok
        ? { ok: true, sessionId: body.sessionId }
        : { ok: false, retryAtMs: body.retryAtMs };
    } catch {
      return { ok: true, sessionId: null };
    }
  }

  /** Settles the reservation once the lobby is done (fire-and-forget). */
  private async gateReconcile(): Promise<void> {
    if (this.sessionId === null || this.reconciled) return;
    this.reconciled = true;
    const stub = this.env.GATEKEEPER.get(this.env.GATEKEEPER.idFromName("gatekeeper"));
    const body = JSON.stringify({
      sessionId: this.sessionId,
      // +1 for the reconcile call itself; TURN egress only accrues if the
      // peers actually matched (kept at the estimate — we never see the wire).
      requests: this.requestCount + 1,
      turnMb: this.matched ? GATE_SESSION_TURN_MB : 0,
    });
    try {
      await stub.fetch("https://gatekeeper/reconcile", { method: "POST", body });
    } catch {
      // tolerated — the reservation keeps its conservative estimate
    }
  }

  /** Short-lived TURN credentials (hosting.spec.md §6); null without a key. */
  private turnIce(): Promise<LobbyIceConfig | null> {
    if (!this.icePromise) {
      const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = this.env;
      this.icePromise =
        TURN_KEY_ID && TURN_KEY_API_TOKEN
          ? issueTurnCredentials(TURN_KEY_ID, TURN_KEY_API_TOKEN)
          : Promise.resolve(null);
    }
    return this.icePromise;
  }

  private async apply(result: LobbyResult): Promise<void> {
    for (const o of result.out) {
      if (o.msg.t === "closed" && o.msg.reason === "matched") this.matched = true;
      const ws = this.conns.get(o.connId);
      if (!ws) continue;
      // Peers need relay credentials with their seat assignment: attach them
      // to created (host) and joined (joiner) so the client can go relay-only.
      let msg: LobbyServerMsg = o.msg;
      if (msg.t === "created" || msg.t === "joined") {
        const ice = await this.turnIce();
        if (ice) msg = { ...msg, ice };
      }
      try {
        ws.send(JSON.stringify(msg));
        if (o.close) ws.close(1000, "lobby closed");
      } catch {
        // socket died mid-send; disconnect handling will follow
      }
      if (o.close) this.conns.delete(o.connId);
    }
    for (const e of result.effects) {
      switch (e.kind) {
        case "setAlarm":
          await this.ctx.storage.setAlarm(e.atMs);
          break;
        case "clearAlarm":
          await this.ctx.storage.deleteAlarm();
          break;
        case "register":
        case "unregister": {
          // Fire-and-forget: a directory glitch must never break signaling.
          const body = JSON.stringify(
            e.kind === "register"
              ? { lobbyId: e.lobbyId, name: e.name, hasPassword: e.hasPassword }
              : { lobbyId: e.lobbyId },
          );
          const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
          try {
            await stub.fetch(`https://directory/${e.kind}`, { method: "POST", body });
          } catch {
            // tolerated — the directory reaps stale entries on its own
          }
          break;
        }
      }
    }
    if (this.logic.status === "closed") await this.gateReconcile();
  }
}
