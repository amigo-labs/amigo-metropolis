/// <reference types="@cloudflare/workers-types" />
// Cloudflare Worker + Durable Object lockstep relay (architecture.md §5).
//
// The Worker routes `wss://…/room/<CODE>` to a DO named by the 5-char code; the
// DO relays inputs between the (max 2) sockets in that room. THE SERVER NEVER
// SIMULATES — every decision lives in the pure, unit-tested RoomLogic; this
// file is only the socket plumbing: assign a connection id per socket, decode
// bytes → RoomLogic, route the Outgoing[] back to sockets, and persist the
// minimum needed to survive hibernation.
//
// Hibernation (WebSocket Hibernation API): an idle room's DO may be evicted
// while its sockets live on. We persist the match config + confirmed frame
// history to DO storage and rebuild RoomLogic in the constructor, re-seating
// the surviving sockets from their attachments. That keeps reconnect
// fast-forward correct even across an eviction, and idle rooms cost nothing.
//
// Not exercised by `bun test` (no Workers runtime here); it is typechecked and
// kept thin over the tested RoomLogic. End-to-end validation on real Cloudflare
// (wrangler dev / deploy) is the open Phase 6 item, alongside the two-network
// playtest — see PLAN.md.

import {
  decodeMessage,
  ERR_PROTOCOL,
  encodeMessage,
  type MatchConfig,
  MSG_ERROR,
  MSG_FRAME,
  MSG_START,
  MSG_WELCOME,
  type NetMessage,
  type PlayerInput,
} from "@metropolis/sim";
import { type Outgoing, RoomLogic } from "./room";

export interface Env {
  ROOM: DurableObjectNamespace;
}

const ROOM_CODE = /^[A-Z0-9]{5}$/;
const FRAME_KEY = "f:";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "room" && parts[1]) {
      const code = parts[1].toUpperCase();
      if (!ROOM_CODE.test(code)) return new Response("bad room code", { status: 400 });
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(request);
    }
    return new Response("metropolis relay — open a WebSocket to /room/<CODE>", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

/** Per-socket state that survives hibernation (kept tiny — see the API docs). */
interface Attachment {
  connId: string;
  slot: number;
}

export class Room implements DurableObject {
  private readonly room = new RoomLogic();
  /** connId → live socket, rebuilt from attachments on wake. */
  private readonly conns = new Map<string, WebSocket>();
  private configPersisted = false;
  private readonly ready: Promise<void>;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {
    // Rebuild match state before handling any event after an eviction.
    this.ready = ctx.blockConcurrencyWhile(() => this.restore());
  }

  private async restore(): Promise<void> {
    const config = await this.ctx.storage.get<MatchConfig>("config");
    if (config) {
      this.configPersisted = true;
      const started = (await this.ctx.storage.get<number>("started")) === 1;
      const stored = await this.ctx.storage.list<ArrayBuffer>({ prefix: FRAME_KEY });
      const frames: PlayerInput[][] = [];
      for (const [key, buf] of stored) {
        const tick = Number(key.slice(FRAME_KEY.length));
        const msg = decodeMessage(new Uint8Array(buf));
        if (msg.type === MSG_FRAME) frames[tick] = msg.inputs;
      }
      this.room.hydrate(config, started, frames);
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att) {
        this.conns.set(att.connId, ws);
        if (att.slot >= 0) this.room.reseat(att.connId, att.slot);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernatable accept: the runtime, not a held reference, keeps the socket.
    this.ctx.acceptWebSocket(server);
    const connId = crypto.randomUUID();
    server.serializeAttachment({ connId, slot: -1 } satisfies Attachment);
    this.conns.set(connId, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    await this.ready;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (typeof data === "string") {
      this.sendTo(ws, { type: MSG_ERROR, code: ERR_PROTOCOL });
      return;
    }
    let msg: NetMessage;
    try {
      msg = decodeMessage(new Uint8Array(data));
    } catch {
      this.sendTo(ws, { type: MSG_ERROR, code: ERR_PROTOCOL });
      return;
    }
    await this.dispatch(this.room.handleMessage(att.connId, msg), ws, att);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ready;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.conns.delete(att.connId);
    await this.dispatch(this.room.handleDisconnect(att.connId), ws, att);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  /** Routes RoomLogic output to sockets and persists durable side effects. */
  private async dispatch(out: Outgoing[], self: WebSocket, att: Attachment): Promise<void> {
    for (const o of out) {
      // Record this socket's assigned slot so a post-hibernation restore can
      // re-seat it without a fresh handshake.
      if (o.msg.type === MSG_WELCOME && o.connId === att.connId && att.slot < 0) {
        att.slot = o.msg.slot;
        self.serializeAttachment({ connId: att.connId, slot: att.slot } satisfies Attachment);
      }
      if (o.connId === null) {
        for (const ws of this.conns.values()) this.sendTo(ws, o.msg);
      } else {
        const ws = this.conns.get(o.connId);
        if (ws) this.sendTo(ws, o.msg);
      }
      await this.persist(o.msg);
    }
  }

  /** Persists match config, start flag, and confirmed frames for reconnect. */
  private async persist(msg: NetMessage): Promise<void> {
    if (msg.type === MSG_WELCOME && !this.configPersisted) {
      this.configPersisted = true;
      await this.ctx.storage.put("config", msg.config);
    } else if (msg.type === MSG_START) {
      await this.ctx.storage.put("started", 1);
    } else if (msg.type === MSG_FRAME) {
      // One put per confirmed tick; the DO output gate coalesces writes. A
      // heavier match could batch these, but 30 Hz for a 1v1 is well within a
      // DO's write budget.
      await this.ctx.storage.put(FRAME_KEY + msg.tick, encodeMessage(msg).buffer);
    }
  }

  private sendTo(ws: WebSocket, msg: NetMessage): void {
    ws.send(encodeMessage(msg));
  }
}
