// DirectoryLogic unit tests (hosting.spec.md §3.3): the public-lobby list with
// staleness pruning, capping, and strict validation of the internal bodies.

import { describe, expect, test } from "bun:test";
import {
  DIRECTORY_ENTRY_TTL_MS,
  DIRECTORY_MAX_ENTRIES,
  DirectoryLogic,
  parseRegister,
  parseUnregister,
} from "@metropolis/server/directory";

const T0 = 5_000_000;

function entry(id: string, name = `Lobby ${id}`, hasPassword = false) {
  return { lobbyId: id, name, hasPassword };
}

describe("DirectoryLogic", () => {
  test("registers and lists newest first", () => {
    const dir = new DirectoryLogic();
    dir.register(entry("AAAAA"), T0);
    dir.register(entry("BBBBB", "Beta", true), T0 + 1000);
    expect(dir.list(T0 + 2000)).toEqual([
      { lobbyId: "BBBBB", name: "Beta", hasPassword: true },
      { lobbyId: "AAAAA", name: "Lobby AAAAA", hasPassword: false },
    ]);
  });

  test("re-registering refreshes instead of duplicating", () => {
    const dir = new DirectoryLogic();
    dir.register(entry("AAAAA"), T0);
    dir.register(entry("AAAAA", "Renamed"), T0 + 500);
    const list = dir.list(T0 + 1000);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Renamed");
  });

  test("re-registering moves a listing back to the front", () => {
    const dir = new DirectoryLogic();
    dir.register(entry("AAAAA"), T0);
    dir.register(entry("BBBBB"), T0 + 1000);
    dir.register(entry("AAAAA"), T0 + 2000); // refresh — now the newest
    expect(dir.list(T0 + 3000).map((l) => l.lobbyId)).toEqual(["AAAAA", "BBBBB"]);
  });

  test("unregister removes a listing and reports whether it existed", () => {
    const dir = new DirectoryLogic();
    dir.register(entry("AAAAA"), T0);
    expect(dir.unregister("AAAAA")).toBe(true);
    expect(dir.unregister("AAAAA")).toBe(false);
    expect(dir.list(T0)).toEqual([]);
  });

  test("stale entries age out — the directory never trusts perfect cleanup", () => {
    const dir = new DirectoryLogic();
    dir.register(entry("AAAAA"), T0);
    dir.register(entry("BBBBB"), T0 + 60_000);
    const later = T0 + DIRECTORY_ENTRY_TTL_MS;
    expect(dir.list(later).map((l) => l.lobbyId)).toEqual(["BBBBB"]);
  });

  test("caps the list by evicting the oldest entries", () => {
    const dir = new DirectoryLogic();
    for (let i = 0; i <= DIRECTORY_MAX_ENTRIES; i++) {
      const id = `L${String(i).padStart(4, "0")}`.toUpperCase().replace(/[^A-Z0-9]/g, "0");
      dir.register(entry(id.slice(0, 5)), T0 + i);
    }
    const list = dir.list(T0 + 1000);
    expect(list).toHaveLength(DIRECTORY_MAX_ENTRIES);
    // The very first registration is the one that fell off.
    expect(list.some((l) => l.lobbyId === "L0000")).toBe(false);
  });

  test("snapshot/hydrate round-trips across an eviction", () => {
    const dir = new DirectoryLogic();
    dir.register(entry("AAAAA"), T0);
    dir.register(entry("BBBBB", "Beta", true), T0 + 1);
    const revived = new DirectoryLogic();
    revived.hydrate(dir.snapshot());
    expect(revived.list(T0 + 2)).toEqual(dir.list(T0 + 2));
  });
});

describe("directory body validation", () => {
  test("parseRegister accepts a canonical body", () => {
    expect(parseRegister({ lobbyId: "ABC12", name: "x", hasPassword: false })).toEqual({
      lobbyId: "ABC12",
      name: "x",
      hasPassword: false,
    });
  });

  test("parseRegister rejects junk", () => {
    expect(parseRegister(null)).toBeNull();
    expect(parseRegister({ lobbyId: "abc12", name: "x", hasPassword: false })).toBeNull();
    expect(
      parseRegister({ lobbyId: "ABC12", name: "x".repeat(41), hasPassword: false }),
    ).toBeNull();
    expect(parseRegister({ lobbyId: "ABC12", name: "x", hasPassword: "no" })).toBeNull();
  });

  test("parseUnregister validates the lobby id", () => {
    expect(parseUnregister({ lobbyId: "ABC12" })).toBe("ABC12");
    expect(parseUnregister({ lobbyId: "nope" })).toBeNull();
    expect(parseUnregister("ABC12")).toBeNull();
  });
});
