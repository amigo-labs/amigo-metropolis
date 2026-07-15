/// <reference types="@cloudflare/workers-types" />
// Preview/staging Worker entry (wrangler --env preview): serves the built
// client for UI validation ONLY. It deliberately implements NO Durable
// Objects — Cloudflare generates no preview URLs for Workers that do — so
// the online paths answer with an explicit 503 instead of relaying. Real
// matches (relay + P2P handshake) exist only on the production Worker.

interface PreviewEnv {
  ASSETS: Fetcher;
}

const ONLINE_PATH = /^\/(room|lobby|api)\//;

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (ONLINE_PATH.test(pathname)) {
      return new Response("online modes are disabled on the preview deployment", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<PreviewEnv>;
