// The Textures option: Classic (the original's texels) is what a player who
// never chose sees, HD is the option, and a stored choice survives
// (fcop-fidelity.md G3).

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_TEX_PREF, loadTexPref, variantOfPref } from "../src/render/texVariants";

const realStorage = (globalThis as { localStorage?: unknown }).localStorage;

function storing(record: string | null): void {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => record,
  };
}

afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = realStorage;
});

describe("texture preference", () => {
  test("Classic is the default", () => {
    expect(DEFAULT_TEX_PREF).toBe("original");
    storing(null);
    expect(loadTexPref()).toBe("original");
    storing(JSON.stringify({ bloom: true }));
    expect(loadTexPref()).toBe("original");
    storing("not json");
    expect(loadTexPref()).toBe("original");
  });

  test("a stored choice is kept, HD included", () => {
    storing(JSON.stringify({ textures: "hd" }));
    expect(loadTexPref()).toBe("hd");
    storing(JSON.stringify({ textures: "original" }));
    expect(loadTexPref()).toBe("original");
  });

  test("each preference names its own atlas variant", () => {
    expect(variantOfPref("original")).toBe("original");
    expect(variantOfPref("hd")).toBe("hd");
  });
});
