/// <reference types="@cloudflare/workers-types" />
// Budget-gatekeeper Durable Object (hosting.spec.md §3.4) — the singleton that
// rations sessions against the Cloudflare free tier and enforces the graceful
// "sold out for today" behaviour instead of ever producing a bill.
// Skeleton (Phase H0): the pure GatekeeperLogic and persistence land in H4.

export class GatekeeperDO implements DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("budget gatekeeper not implemented yet (Phase H4)", { status: 501 });
  }
}
