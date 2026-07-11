/// <reference types="@cloudflare/workers-types" />
// Lobby/signaling Durable Object (hosting.spec.md §3.2) — one instance per
// lobby code; brokers SDP/ICE between exactly two peers over WebSocket JSON.
// Skeleton (Phase H0): the pure LobbyLogic and the socket plumbing land in H1.

export class LobbyDO implements DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("lobby signaling not implemented yet (Phase H1)", { status: 501 });
  }
}
