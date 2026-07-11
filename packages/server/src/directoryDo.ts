/// <reference types="@cloudflare/workers-types" />
// Directory Durable Object (hosting.spec.md §3.3) — the singleton list of open
// PUBLIC lobbies. Private lobbies are shared by code and never appear here.
// Skeleton (Phase H0): the pure DirectoryLogic and persistence land in H3.

export class DirectoryDO implements DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("lobby directory not implemented yet (Phase H3)", { status: 501 });
  }
}
