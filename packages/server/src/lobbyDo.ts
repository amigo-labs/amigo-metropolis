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

import type { Env } from "./index";
import { LobbyLogic, type LobbyResult, type LobbyServerMsg } from "./lobby";

interface Attachment {
  connId: string;
}

export class LobbyDO implements DurableObject {
  private readonly logic = new LobbyLogic();
  private readonly conns = new Map<string, WebSocket>();
  /** connIds this instance has seen — distinguishes pre-eviction sockets. */
  private readonly known = new Set<string>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
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
    await this.apply(this.logic.handleMessage(connId, raw, Date.now()));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const connId = this.connIdOf(ws);
    if (connId === null) return;
    this.conns.delete(connId);
    await this.apply(this.logic.handleDisconnect(connId, Date.now()));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
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

  private async apply(result: LobbyResult): Promise<void> {
    for (const o of result.out) {
      const ws = this.conns.get(o.connId);
      if (!ws) continue;
      try {
        ws.send(JSON.stringify(o.msg));
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
            e.kind === "register" ? { lobbyId: e.lobbyId, name: e.name } : { lobbyId: e.lobbyId },
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
  }
}
