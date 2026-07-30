import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPinStore, PIN_KEEP, safeId } from "../src/pinStore";

const dirs: string[] = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "pinstore-"));
  dirs.push(root);
  return createPinStore(root);
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const png = (byte: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, byte]);

function pinText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    createdAt: "2026-07-30T12:34:56.789Z",
    mapId: "la-cantina",
    notes: "turret beside its pad",
    origin: "hotkey",
    reproduction: "static",
    parentId: null,
    ...over,
  });
}

describe("safeId", () => {
  test("strips path traversal and anything not filename-safe", () => {
    expect(safeId("../../etc/passwd")).toBe("....etcpasswd");
    expect(safeId("20260730-123456")).toBe("20260730-123456");
    expect(safeId("a/b\\c:d*e")).toBe("abcde");
  });

  test("returns empty for nothing usable, so callers pick a fallback", () => {
    expect(safeId("")).toBe("");
    expect(safeId(null)).toBe("");
    expect(safeId("///")).toBe("");
  });

  test("caps length", () => {
    expect(safeId("a".repeat(200)).length).toBe(64);
  });
});

describe("write", () => {
  test("writes the pin, its shots and prompt, and mirrors them into latest/", () => {
    const store = tempStore();
    const entry = store.write({
      id: "20260730-120000",
      pinText: pinText(),
      promptText: "the prompt",
      shots: [
        { file: "view.png", bytes: png(1) },
        { file: "top.png", bytes: png(2) },
      ],
    });

    expect(entry.id).toBe("20260730-120000");
    expect(entry.files).toEqual(["pin.json", "prompt.txt", "view.png", "top.png"]);
    for (const f of ["pin.json", "prompt.txt", "view.png", "top.png"]) {
      expect(existsSync(join(store.root, "20260730-120000", f))).toBe(true);
      expect(existsSync(join(store.root, "latest", f))).toBe(true);
    }
    // pin.json is passed through verbatim — never re-encoded.
    expect(readFileSync(join(store.root, "20260730-120000", "pin.json"), "utf8")).toBe(pinText());
  });

  test("summarises pin.json into the index", () => {
    const store = tempStore();
    store.write({
      id: "a",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    const [entry] = store.readIndex();
    expect(entry.mapId).toBe("la-cantina");
    expect(entry.notes).toBe("turret beside its pad");
    expect(entry.origin).toBe("hotkey");
    expect(entry.reproduction).toBe("static");
    expect(entry.createdAt).toBe("2026-07-30T12:34:56.789Z");
  });

  test("keeps a malformed pin.json in the index instead of dropping it", () => {
    const store = tempStore();
    const entry = store.write({
      id: "broken",
      pinText: "{not json",
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    expect(entry.id).toBe("broken");
    expect(entry.mapId).toBeNull();
    expect(entry.notes).toBe("");
    expect(store.readIndex()).toHaveLength(1);
  });

  test("index is newest-first and a rewrite of the same id does not duplicate it", () => {
    const store = tempStore();
    store.write({
      id: "one",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    store.write({
      id: "two",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(2) }],
    });
    store.write({
      id: "one",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(3) }],
    });
    expect(store.readIndex().map((e) => e.id)).toEqual(["one", "two"]);
  });

  test("clears stale shots out of latest/ so it never mixes two pins", () => {
    const store = tempStore();
    store.write({
      id: "with-top",
      pinText: pinText(),
      promptText: "",
      shots: [
        { file: "view.png", bytes: png(1) },
        { file: "top.png", bytes: png(2) },
      ],
    });
    store.write({
      id: "view-only",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(3) }],
    });
    expect(existsSync(join(store.root, "latest", "view.png"))).toBe(true);
    // The previous pin's top.png must not linger and be read as this pin's.
    expect(existsSync(join(store.root, "latest", "top.png"))).toBe(false);
  });

  test("falls back to a generated id when nothing usable is given", () => {
    const store = tempStore();
    const entry = store.write({
      id: "///",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    expect(entry.id).toMatch(/^pin-\d+$/);
  });
});

describe("parentId chaining", () => {
  test("takes parentId from pin.json", () => {
    const store = tempStore();
    const entry = store.write({
      id: "child",
      pinText: pinText({ parentId: "parent" }),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    expect(entry.parentId).toBe("parent");
  });

  test("falls back to the request field when pin.json carries none", () => {
    const store = tempStore();
    const entry = store.write({
      id: "child",
      pinText: pinText({ parentId: null }),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
      parentId: "from-request",
    });
    expect(entry.parentId).toBe("from-request");
  });

  test("sanitises a parentId from the request", () => {
    const store = tempStore();
    const entry = store.write({
      id: "child",
      pinText: pinText({ parentId: null }),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
      parentId: "../escape",
    });
    expect(entry.parentId).toBe("..escape");
  });
});

describe("pruning", () => {
  test(`keeps the newest ${PIN_KEEP} and deletes the directories that fell off`, () => {
    const store = tempStore();
    for (let i = 0; i < PIN_KEEP + 3; i++) {
      store.write({
        id: `pin${String(i).padStart(3, "0")}`,
        pinText: pinText(),
        promptText: "",
        shots: [{ file: "view.png", bytes: png(i & 0xff) }],
      });
    }
    const index = store.readIndex();
    expect(index).toHaveLength(PIN_KEEP);
    // Newest first: the last written is at the head, the first three are gone.
    expect(index[0].id).toBe(`pin${String(PIN_KEEP + 2).padStart(3, "0")}`);
    expect(existsSync(join(store.root, "pin000"))).toBe(false);
    expect(existsSync(join(store.root, "pin002"))).toBe(false);
    expect(existsSync(join(store.root, index[0].id))).toBe(true);
    // Pruning must never touch latest/.
    expect(existsSync(join(store.root, "latest", "pin.json"))).toBe(true);
  });
});

describe("resolveId + readPin", () => {
  test("'latest' resolves to the newest indexed pin", () => {
    const store = tempStore();
    store.write({
      id: "old",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    store.write({
      id: "new",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(2) }],
    });
    expect(store.resolveId("latest")).toBe("new");
  });

  test("resolves an explicit id and rejects an unknown one", () => {
    const store = tempStore();
    store.write({
      id: "known",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    expect(store.resolveId("known")).toBe("known");
    expect(store.resolveId("missing")).toBeNull();
    expect(store.resolveId("latest")).toBe("known");
  });

  test("'latest' is null on an empty store", () => {
    expect(tempStore().resolveId("latest")).toBeNull();
  });

  test("readPin parses the stored json, and returns null for an unknown id", () => {
    const store = tempStore();
    store.write({
      id: "p",
      pinText: pinText(),
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    const pin = store.readPin("p") as { mapId: string; version: number };
    expect(pin.mapId).toBe("la-cantina");
    expect(pin.version).toBe(2);
    expect(store.readPin("nope")).toBeNull();
  });

  test("readPin returns null rather than throwing on malformed json", () => {
    const store = tempStore();
    store.write({
      id: "bad",
      pinText: "{oops",
      promptText: "",
      shots: [{ file: "view.png", bytes: png(1) }],
    });
    expect(store.readPin("bad")).toBeNull();
  });
});
