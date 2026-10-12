// Match-end wording (render/matchEnd.ts): the strings depend on which side won.
// Every arena ends at a gate since SIM_VERSION 32 — the original has no core.

import { describe, expect, test } from "bun:test";
import { TICK_HZ } from "@metropolis/sim";
import { matchClock, matchEndText } from "../src/render/matchEnd";

describe("matchEndText", () => {
  test("victory and defeat at the gate", () => {
    expect(matchEndText(1, 1)).toEqual({
      title: "VICTORY",
      subtitle: "Your unit breached the enemy gate",
    });
    expect(matchEndText(0, 1)).toEqual({
      title: "DEFEAT",
      subtitle: "The enemy breached your gate",
    });
  });
});

describe("matchClock", () => {
  test("formats ticks as m:ss", () => {
    expect(matchClock(0, TICK_HZ)).toBe("0:00");
    expect(matchClock(30 * TICK_HZ, TICK_HZ)).toBe("0:30");
    expect(matchClock(61 * TICK_HZ, TICK_HZ)).toBe("1:01");
    expect(matchClock(600 * TICK_HZ, TICK_HZ)).toBe("10:00");
  });
});
