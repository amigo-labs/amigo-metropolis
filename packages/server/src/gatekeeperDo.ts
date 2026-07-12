/// <reference types="@cloudflare/workers-types" />
// Budget-gatekeeper Durable Object (hosting.spec.md §3.4) — the singleton that
// rations sessions against the Cloudflare free tier. Thin adapter over the
// pure, unit-tested GatekeeperLogic: LobbyDOs POST /reserve before opening a
// lobby and /reconcile when it closes; clients GET /api/budget so the UI can
// grey out hosting before a doomed attempt. Counters persist as one small
// record so an eviction never forgets what today already spent.

import { GatekeeperLogic, type GateSnapshot } from "./gatekeeper";

const STORE_KEY = "gate";

export class GatekeeperDO implements DurableObject {
  private readonly logic = new GatekeeperLogic();
  private readonly ready: Promise<void>;

  constructor(private readonly ctx: DurableObjectState) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get<GateSnapshot>(STORE_KEY);
      if (snap) this.logic.hydrate(snap);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method === "GET") {
      return Response.json(this.logic.status(Date.now()));
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/reserve")) {
      const result = this.logic.reserve(Date.now());
      if (result.ok) await this.persist();
      return Response.json(result);
    }
    if (url.pathname.endsWith("/reconcile")) {
      let body: { sessionId?: unknown; requests?: unknown; turnMb?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (
        typeof body.sessionId !== "string" ||
        typeof body.requests !== "number" ||
        typeof body.turnMb !== "number"
      ) {
        return new Response("bad reconcile", { status: 400 });
      }
      const ok = this.logic.reconcile(body.sessionId, body.requests, body.turnMb, Date.now());
      if (ok) await this.persist();
      return new Response(null, { status: ok ? 204 : 404 });
    }
    return new Response("unknown gatekeeper route", { status: 404 });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORE_KEY, this.logic.snapshot());
  }
}
