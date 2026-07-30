// Ship a verification pin to the local pin server, or fall back to downloads.

import type { VerificationPin } from "./pinTypes";

export const DEFAULT_PIN_SERVER = "http://127.0.0.1:8787";

export interface PinExportResult {
  readonly ok: boolean;
  readonly via: "server" | "download";
  readonly message: string;
  readonly id?: string;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function postPin(
  baseUrl: string,
  pin: VerificationPin,
  png: Blob,
  prompt: string,
  id: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const form = new FormData();
  form.set("id", id);
  form.set(
    "pin",
    new Blob([JSON.stringify(pin, null, 2)], { type: "application/json" }),
    "pin.json",
  );
  form.set("view", png, "view.png");
  form.set("prompt", new Blob([prompt], { type: "text/plain" }), "prompt.txt");
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/pin`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${text}`.trim() };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id ?? id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Prefer the local pin server (writes docs/verification/pins/…). On failure,
 * download pin.json + view.png + prompt.txt so the user can still hand them off.
 */
export async function exportPin(
  pin: VerificationPin,
  png: Blob,
  prompt: string,
  id: string,
  serverUrl: string = DEFAULT_PIN_SERVER,
): Promise<PinExportResult> {
  const posted = await postPin(serverUrl, pin, png, prompt, id);
  if (posted.ok) {
    return {
      ok: true,
      via: "server",
      id: posted.id,
      message: `Pin gespeichert → docs/verification/pins/latest/ (${posted.id})`,
    };
  }
  downloadBlob(png, `${id}-view.png`);
  downloadBlob(
    new Blob([JSON.stringify(pin, null, 2)], { type: "application/json" }),
    `${id}-pin.json`,
  );
  downloadBlob(new Blob([prompt], { type: "text/plain" }), `${id}-prompt.txt`);
  return {
    ok: true,
    via: "download",
    id,
    message: `Pin-Server offline (${posted.error}) — Downloads gestartet. bun run pin:serve`,
  };
}

export function captureCanvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
