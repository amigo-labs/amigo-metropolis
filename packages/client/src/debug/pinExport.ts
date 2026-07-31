// Ship a verification pin to the local pin server, or fall back to downloads.

import type { PinShot, VerificationPin } from "./pinTypes";

export const DEFAULT_PIN_SERVER = "http://127.0.0.1:8787";

export interface PinExportResult {
  readonly ok: boolean;
  readonly via: "server" | "download";
  readonly message: string;
  readonly id?: string;
}

/** One rendered shot: the metadata that goes into pin.json plus its bytes. */
export interface ExportShot {
  readonly meta: PinShot;
  readonly blob: Blob;
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
  shots: readonly ExportShot[],
  prompt: string,
  id: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const form = new FormData();
  form.set("id", id);
  if (pin.parentId) form.set("parentId", pin.parentId);
  form.set(
    "pin",
    new Blob([JSON.stringify(pin, null, 2)], { type: "application/json" }),
    "pin.json",
  );
  // "view" stays the primary shot's field name so a v1-era receiver still works;
  // any further shots ride along under their own file names.
  for (const shot of shots) {
    const field = shot.meta.file === "view.png" ? "view" : shot.meta.file.replace(/\.png$/, "");
    form.set(field, shot.blob, shot.meta.file);
  }
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
 * download the shots + pin.json + prompt.txt so the user can still hand them off.
 *
 * Downloads are prefixed `pin-`: the browser drops them wherever the user's
 * download dir points, which has been the repo root before now, and
 * `.gitignore` only excuses that under a name it can match.
 */
export async function exportPin(
  pin: VerificationPin,
  shots: readonly ExportShot[],
  prompt: string,
  id: string,
  serverUrl: string = DEFAULT_PIN_SERVER,
): Promise<PinExportResult> {
  const posted = await postPin(serverUrl, pin, shots, prompt, id);
  if (posted.ok) {
    return {
      ok: true,
      via: "server",
      id: posted.id,
      message: `Pin gespeichert → docs/verification/pins/latest/ (${posted.id})`,
    };
  }
  for (const shot of shots) {
    downloadBlob(shot.blob, `pin-${id}-${shot.meta.file}`);
  }
  downloadBlob(
    new Blob([JSON.stringify(pin, null, 2)], { type: "application/json" }),
    `pin-${id}-pin.json`,
  );
  downloadBlob(new Blob([prompt], { type: "text/plain" }), `pin-${id}-prompt.txt`);
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
