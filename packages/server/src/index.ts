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

// Durable Object classes must be exported from the Worker entry module.
export { DirectoryDO } from "./directoryDo";
export { GatekeeperDO } from "./gatekeeperDo";
export { LobbyDO } from "./lobbyDo";

export interface Env {
  ROOM: DurableObjectNamespace;
  // Handshake layer for the P2P online path (hosting.spec.md): per-code lobby
  // signaling plus the directory and budget-gatekeeper singletons.
  LOBBY: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  GATEKEEPER: DurableObjectNamespace;
  // Static client assets (the Vite build). Configured in wrangler.toml so this
  // one Worker serves the game AND the relay from a single origin.
  ASSETS: Fetcher;
  // Cloudflare Realtime TURN key for issuing short-lived credentials
  // (hosting.spec.md §6). Optional: absent in dev, set via wrangler vars/secret.
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const ROOM_CODE = /^[A-Z0-9]{5}$/;
const FRAME_KEY = "f:";

/** Both singletons are addressed by a fixed name — one instance per deploy. */
function singleton(ns: DurableObjectNamespace, name: string): DurableObjectStub {
  return ns.get(ns.idFromName(name));
}

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
    // P2P handshake layer (hosting.spec.md). Lobby codes share the room-code
    // alphabet; the namespaces stay distinct because the DO classes differ.
    if (parts[0] === "lobby" && parts[1]) {
      const code = parts[1].toUpperCase();
      if (!ROOM_CODE.test(code)) return new Response("bad lobby code", { status: 400 });
      return env.LOBBY.get(env.LOBBY.idFromName(code)).fetch(request);
    }
    if (parts[0] === "api" && parts[1] === "lobbies") {
      return singleton(env.DIRECTORY, "directory").fetch(request);
    }
    if (parts[0] === "api" && parts[1] === "budget") {
      return singleton(env.GATEKEEPER, "gatekeeper").fetch(request);
    }
    if (parts[0] === "api") return new Response("unknown api route", { status: 404 });
    // Anything that isn't a relay route is the client app. run_worker_first pins
    // only "/room/*" to the Worker, so this is just a safety net for a codeless
    // relay path like "/room/": hand it to the asset layer, which SPA-falls-back
    // to the app shell. (A bare "/room" never reaches here — it doesn't match
    // "/room/*", so the asset layer serves it directly.)
    return env.ASSETS.fetch(request);
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
        // Guard corrupted storage: a bad key or undecodable buffer must not
        // throw out of the constructor and brick the room on wake. Skip it and
        // let hydrate() trust only the contiguous prefix up to any gap.
        const tick = Number(key.slice(FRAME_KEY.length));
        if (!Number.isInteger(tick) || tick < 0) continue;
        try {
          const msg = decodeMessage(new Uint8Array(buf));
          if (msg.type === MSG_FRAME) frames[tick] = msg.inputs;
        } catch {
          // corrupted frame — leave a gap; hydrate stops the history there
        }
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
