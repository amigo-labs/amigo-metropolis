// The menu DOM is browser-only, but its routing logic is pure and tested here:
// a menu choice must map to exactly the query string main.ts's deep-link path
// already understands, and room codes must round-trip through validation.

import { describe, expect, test } from "bun:test";
import { buildModeQuery, normalizeRoomCode, randomRoomCode } from "../src/menu";

describe("buildModeQuery", () => {
  test("solo sandbox uses the ?play marker", () => {
    expect(buildModeQuery({ mode: "solo" })).toBe("?play=1");
  });

  test("warden clamps difficulty into 1..10", () => {
    expect(buildModeQuery({ mode: "warden", difficulty: 4 })).toBe("?warden=4");
    expect(buildModeQuery({ mode: "warden", difficulty: 0 })).toBe("?warden=1");
    expect(buildModeQuery({ mode: "warden", difficulty: 99 })).toBe("?warden=10");
    expect(buildModeQuery({ mode: "warden", difficulty: 3.9 })).toBe("?warden=3");
    expect(buildModeQuery({ mode: "warden", difficulty: Number.NaN })).toBe("?warden=1");
  });

  test("p2p routes to the lobby-brokered mode", () => {
    expect(buildModeQuery({ mode: "p2p", code: "abcde" })).toBe("?p2p=ABCDE");
  });

  test("online upper-cases the room code", () => {
    expect(buildModeQuery({ mode: "online", code: "abcde" })).toBe("?online=ABCDE");
  });
});

describe("normalizeRoomCode", () => {
  test("accepts 5 alphanumerics, upper-cased and trimmed", () => {
    expect(normalizeRoomCode("  ab12x ")).toBe("AB12X");
    expect(normalizeRoomCode("ABCDE")).toBe("ABCDE");
  });

  test("rejects wrong length or bad characters", () => {
    expect(normalizeRoomCode("abcd")).toBeNull();
    expect(normalizeRoomCode("abcdef")).toBeNull();
    expect(normalizeRoomCode("ab-de")).toBeNull();
    expect(normalizeRoomCode("")).toBeNull();
  });
});

describe("randomRoomCode", () => {
  test("is always a valid 5-char code with unambiguous glyphs", () => {
    // Sweep the injected rand across its whole range → every alphabet index.
    for (let i = 0; i < 64; i++) {
      const r = i / 64;
      const code = randomRoomCode(() => r);
      expect(normalizeRoomCode(code)).toBe(code);
      expect(code).not.toMatch(/[OI01]/); // dropped ambiguous glyphs
    }
  });
});
