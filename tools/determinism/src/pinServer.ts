// Local verification-pin receiver. Fly-mode client POSTs pin.json + view.png +
// prompt.txt; this writes docs/verification/pins/<id>/ and refreshes latest/.
//
//   bun run pin:serve          # from repo root
//
// Loopback only. No auth. Debug tooling — not production.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PIN_SERVER_PORT ?? "8787");
const ROOT = join(import.meta.dir, "..", "..", "..");
const PINS = join(ROOT, "docs", "verification", "pins");
const LATEST = join(PINS, "latest");

function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function safeId(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return s.length > 0 ? s : `pin-${Date.now()}`;
}

async function handlePin(req: Request): Promise<Response> {
  const form = await req.formData();
  const id = safeId(String(form.get("id") ?? ""));
  const pinEntry = form.get("pin");
  const viewEntry = form.get("view");
  const promptEntry = form.get("prompt");

  const pinText =
    pinEntry instanceof Blob
      ? await pinEntry.text()
      : typeof pinEntry === "string"
        ? pinEntry
        : null;
  if (pinText === null || pinText.length === 0) {
    return cors(new Response(JSON.stringify({ error: "missing pin" }), { status: 400 }));
  }
  if (!(viewEntry instanceof Blob)) {
    return cors(new Response(JSON.stringify({ error: "missing view" }), { status: 400 }));
  }

  const dir = join(PINS, id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(LATEST, { recursive: true });

  const viewBuf = new Uint8Array(await viewEntry.arrayBuffer());
  const promptText =
    promptEntry instanceof Blob
      ? await promptEntry.text()
      : typeof promptEntry === "string"
        ? promptEntry
        : "";

  writeFileSync(join(dir, "pin.json"), pinText);
  writeFileSync(join(dir, "view.png"), viewBuf);
  writeFileSync(join(dir, "prompt.txt"), promptText);
  // Refresh latest/ as plain copies (Windows-friendly; no symlink required).
  writeFileSync(join(LATEST, "pin.json"), pinText);
  writeFileSync(join(LATEST, "view.png"), viewBuf);
  writeFileSync(join(LATEST, "prompt.txt"), promptText);

  console.log(`[pin] saved ${id} → ${dir} (+ latest/)`);
  return cors(
    new Response(JSON.stringify({ ok: true, id, path: `docs/verification/pins/${id}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return cors(
        new Response(JSON.stringify({ ok: true, pins: PINS }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (req.method === "POST" && url.pathname === "/pin") {
      try {
        return await handlePin(req);
      } catch (e) {
        console.error("[pin] error", e);
        return cors(
          new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
            status: 500,
          }),
        );
      }
    }
    return cors(new Response("not found", { status: 404 }));
  },
});

console.log(`[pin] listening on http://127.0.0.1:${server.port}`);
console.log(`[pin] writing to ${PINS}`);
