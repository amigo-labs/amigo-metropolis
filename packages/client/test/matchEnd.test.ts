// Match-end wording (render/matchEnd.ts): the strings depend on which side
// won and which win condition the arena runs — §1 gate breach vs §9 core raze.

import { describe, expect, test } from "bun:test";
import { TICK_HZ } from "@metropolis/sim";
import { matchClock, matchEndText } from "../src/render/matchEnd";

describe("matchEndText", () => {
  test("victory and defeat on a core (§9) arena", () => {
    expect(matchEndText(0, 0, true)).toEqual({
      title: "VICTORY",
      subtitle: "Enemy base razed",
    });
    expect(matchEndText(1, 0, true)).toEqual({
      title: "DEFEAT",
      subtitle: "Your base was razed",
    });
  });

  test("victory and defeat on a gate (§1) arena", () => {
    expect(matchEndText(1, 1, false)).toEqual({
      title: "VICTORY",
      subtitle: "Your unit breached the enemy gate",
    });
    expect(matchEndText(0, 1, false)).toEqual({
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
