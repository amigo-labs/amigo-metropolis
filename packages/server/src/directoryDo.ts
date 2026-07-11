/// <reference types="@cloudflare/workers-types" />
// Directory Durable Object (hosting.spec.md §3.3) — the singleton list of open
// PUBLIC lobbies. Private lobbies are shared by code and never appear here.
// Thin adapter over the pure, unit-tested DirectoryLogic: lobby DOs POST
// register/unregister (internal, via the DIRECTORY binding), clients GET
// /api/lobbies. The entry set is one small persisted record so listings
// survive an eviction.

import { type DirectoryEntry, DirectoryLogic, parseRegister, parseUnregister } from "./directory";

const STORE_KEY = "entries";

export class DirectoryDO implements DurableObject {
  private readonly logic = new DirectoryLogic();
  private readonly ready: Promise<void>;

  constructor(private readonly ctx: DurableObjectState) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<DirectoryEntry[]>(STORE_KEY);
      if (stored) this.logic.hydrate(stored);
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === "GET") {
      return Response.json({ lobbies: this.logic.list(Date.now()) });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (url.pathname.endsWith("/register")) {
      const entry = parseRegister(body);
      if (!entry) return new Response("bad register", { status: 400 });
      this.logic.register(entry, Date.now());
      await this.persist();
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/unregister")) {
      const lobbyId = parseUnregister(body);
      if (!lobbyId) return new Response("bad unregister", { status: 400 });
      if (this.logic.unregister(lobbyId)) await this.persist();
      return new Response(null, { status: 204 });
    }
    return new Response("unknown directory route", { status: 404 });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORE_KEY, this.logic.snapshot());
  }
}
