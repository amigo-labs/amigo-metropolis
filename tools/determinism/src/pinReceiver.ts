// The HTTP side of receiving a pin: multipart in, pinStore out.
//
// Shared because two processes must accept the identical upload — pinServer.ts
// for a human in a real browser, and pinDrive.ts for its own headless client.
// pinDrive cannot just assume `pin:serve` is running: it isn't, in an unattended
// run, and a headless browser's download fallback goes nowhere.

import type { PinStore } from "./pinStore";
import { safeId } from "./pinStore";

/** Shot form fields the client may send. "view" keeps its v1 name. */
const SHOT_FIELDS: readonly (readonly [string, string])[] = [
  ["view", "view.png"],
  ["top", "top.png"],
];

/**
 * CORS is required here, unlike on the pin:drive control server: the client
 * posting a pin is a page served from the vite dev server on another port, so
 * the POST is cross-origin. Removing this silently breaks pin saving.
 */
export function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function json(body: unknown, status = 200): Response {
  return cors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function textOf(entry: Blob | string | null): Promise<string | null> {
  if (entry instanceof Blob) return await entry.text();
  return typeof entry === "string" ? entry : null;
}

/** Parses a POST /pin upload and writes it through the store. */
export async function receivePin(store: PinStore, req: Request): Promise<Response> {
  const form = await req.formData();
  const id = safeId(String(form.get("id") ?? "")) || `pin-${Date.now()}`;

  const pinText = await textOf(form.get("pin"));
  if (pinText === null || pinText.length === 0) return json({ error: "missing pin" }, 400);

  const shots: { file: string; bytes: Uint8Array }[] = [];
  for (const [field, file] of SHOT_FIELDS) {
    const entry = form.get(field);
    if (entry instanceof Blob) {
      shots.push({ file, bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
  }
  if (shots.length === 0) return json({ error: "missing view" }, 400);

  const entry = store.write({
    id,
    pinText,
    promptText: (await textOf(form.get("prompt"))) ?? "",
    shots,
    parentId: safeId(String(form.get("parentId") ?? "")) || null,
  });

  console.log(`[pin] saved ${entry.id} (${entry.files.join(", ")}) → ${store.root} (+ latest/)`);
  return json({ ok: true, id: entry.id, path: `docs/verification/pins/${entry.id}` });
}

/**
 * Serves the pin endpoints on loopback. Returns the running server so a caller
 * can report its port and stop it.
 */
export function servePinReceiver(store: PinStore, port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return json({ ok: true, pins: store.root });
      }
      // Newest-first listing so an agent can find the pin from before a fix
      // without guessing directory names.
      if (req.method === "GET" && url.pathname === "/pins") {
        return json({ ok: true, pins: store.readIndex() });
      }
      if (req.method === "POST" && url.pathname === "/pin") {
        try {
          return await receivePin(store, req);
        } catch (e) {
          // Detail goes to the terminal the user is already watching, not over
          // the wire: this endpoint answers Access-Control-Allow-Origin: *, so
          // any page open in their browser can POST here and read the reply,
          // and node's fs errors embed absolute paths.
          console.error("[pin] error", e);
          return json({ error: "pin could not be written — see the pin:serve log" }, 500);
        }
      }
      return cors(new Response("not found", { status: 404 }));
    },
  });
}
