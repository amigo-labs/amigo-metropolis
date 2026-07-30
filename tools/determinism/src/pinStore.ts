// On-disk format for verification pins — the one place that writes them.
//
// Two producers share it: pinServer.ts (a human pressing P in the browser) and
// pinDrive.ts (an agent calling metropolisPin). They must agree byte-for-byte,
// because the whole point of a reshoot is comparing one against the other.
//
// Layout under docs/verification/pins/:
//   index.json      newest-first list of every stored pin
//   latest/         plain copies of the most recent pin (no symlink: Windows)
//   <id>/           pin.json, prompt.txt, view.png, top.png, …

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Keep the directory browsable; pins are debug scratch, not history. */
export const PIN_KEEP = 50;

export interface PinShotFile {
  readonly file: string;
  readonly bytes: Uint8Array;
}

export interface PinIndexEntry {
  readonly id: string;
  readonly createdAt: string | null;
  readonly mapId: string | null;
  readonly notes: string;
  readonly parentId: string | null;
  readonly origin: string | null;
  readonly reproduction: string | null;
  readonly files: readonly string[];
}

export interface PinStore {
  readonly root: string;
  readonly write: (input: WritePinInput) => PinIndexEntry;
  readonly readIndex: () => PinIndexEntry[];
  readonly resolveId: (idOrLatest: string) => string | null;
  readonly readPin: (id: string) => unknown | null;
}

export interface WritePinInput {
  readonly id: string;
  /** Raw pin.json text exactly as the client serialised it — never re-encoded. */
  readonly pinText: string;
  readonly promptText: string;
  readonly shots: readonly PinShotFile[];
  readonly parentId?: string | null;
}

/** Filesystem-safe pin id; never let a request name a path. */
export function safeId(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return s.length > 0 ? s : "";
}

/**
 * Reads the fields the index needs out of a pin.json. Tolerant on purpose: a v1
 * pin has no origin/reproduction, and a hand-edited pin should not break `ls`.
 */
function summarise(id: string, pinText: string, files: readonly string[]): PinIndexEntry {
  let parsed: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(pinText);
    if (raw !== null && typeof raw === "object") parsed = raw as Record<string, unknown>;
  } catch {
    // Leave the summary empty rather than dropping the pin from the index.
  }
  const str = (key: string): string | null =>
    typeof parsed[key] === "string" ? (parsed[key] as string) : null;
  return {
    id,
    createdAt: str("createdAt"),
    mapId: str("mapId"),
    notes: str("notes") ?? "",
    parentId: str("parentId"),
    origin: str("origin"),
    reproduction: str("reproduction"),
    files,
  };
}

export function createPinStore(pinsRoot: string): PinStore {
  const LATEST = join(pinsRoot, "latest");
  const INDEX = join(pinsRoot, "index.json");

  const readIndex = (): PinIndexEntry[] => {
    if (!existsSync(INDEX)) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(INDEX, "utf8"));
      return Array.isArray(raw) ? (raw as PinIndexEntry[]) : [];
    } catch {
      return [];
    }
  };

  const write = (input: WritePinInput): PinIndexEntry => {
    const id = safeId(input.id) || `pin-${Date.now()}`;
    const dir = join(pinsRoot, id);
    mkdirSync(dir, { recursive: true });
    mkdirSync(LATEST, { recursive: true });

    writeFileSync(join(dir, "pin.json"), input.pinText);
    writeFileSync(join(dir, "prompt.txt"), input.promptText);
    writeFileSync(join(LATEST, "pin.json"), input.pinText);
    writeFileSync(join(LATEST, "prompt.txt"), input.promptText);

    // latest/ is refreshed as plain copies (Windows-friendly, no symlink), and
    // stale shots from a previous pin are cleared so latest/ never mixes two.
    for (const name of readdirSync(LATEST)) {
      if (name.endsWith(".png")) rmSync(join(LATEST, name), { force: true });
    }
    const files: string[] = ["pin.json", "prompt.txt"];
    for (const shot of input.shots) {
      const name = safeId(shot.file);
      if (name.length === 0) continue;
      writeFileSync(join(dir, name), shot.bytes);
      writeFileSync(join(LATEST, name), shot.bytes);
      files.push(name);
    }

    const entry = summarise(id, input.pinText, files);
    const merged: PinIndexEntry[] = [
      // parentId from the request fills in when pin.json did not carry one.
      { ...entry, parentId: entry.parentId ?? (safeId(input.parentId) || null) },
      ...readIndex().filter((e) => e.id !== id),
    ];
    const kept = merged.slice(0, PIN_KEEP);
    writeFileSync(INDEX, `${JSON.stringify(kept, null, 2)}\n`);

    // Prune directories that fell off the index; latest/ is not a pin.
    const keep = new Set(kept.map((e) => e.id));
    for (const name of readdirSync(pinsRoot, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name === "latest" || keep.has(name.name)) continue;
      rmSync(join(pinsRoot, name.name), { recursive: true, force: true });
    }
    return kept[0];
  };

  const resolveId = (idOrLatest: string): string | null => {
    if (idOrLatest === "latest") {
      const index = readIndex();
      if (index.length > 0) return index[0].id;
      // No index yet (pins from before this existed): fall back to latest/.
      return existsSync(join(LATEST, "pin.json")) ? "latest" : null;
    }
    const id = safeId(idOrLatest);
    return id.length > 0 && existsSync(join(pinsRoot, id, "pin.json")) ? id : null;
  };

  const readPin = (id: string): unknown | null => {
    const path = join(pinsRoot, id, "pin.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };

  return { root: pinsRoot, write, readIndex, resolveId, readPin };
}
