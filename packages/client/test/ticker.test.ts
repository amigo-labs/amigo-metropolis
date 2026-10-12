// The objective ticker's pure half: which events become a row, and with what
// text. The DOM half (rows, expiry, repeat suppression) lives in hud.ts and is
// exercised manually — client tests run without a DOM.

import { describe, expect, test } from "bun:test";
import { EV_ALARM, EV_BREACH, EV_CAPTURE, EV_CLAIM, EV_HIT, EV_SHOT } from "@metropolis/sim";
import {
  classifyTickerEvent,
  TICKER_KINDS,
  TICKER_TEXT,
  TK_ALARM,
  TK_BREACH,
  TK_CAPTURE,
  TK_CLAIM,
} from "../src/render/hud/ticker";

describe("objective ticker classification", () => {
  test("capture/claim/breach carry the team in b", () => {
    expect(classifyTickerEvent(EV_BREACH, 1, 0)).toBe(TK_BREACH * 2 + 1);
    expect(classifyTickerEvent(EV_CAPTURE, 0, 7)).toBe(TK_CAPTURE * 2 + 0);
    expect(classifyTickerEvent(EV_CAPTURE, 1, 7)).toBe(TK_CAPTURE * 2 + 1);
    expect(classifyTickerEvent(EV_CLAIM, 1, 2)).toBe(TK_CLAIM * 2 + 1);
  });

  test("alarm carries the team in c", () => {
    expect(classifyTickerEvent(EV_ALARM, 123, 0)).toBe(TK_ALARM * 2 + 0);
  });

  test("combat noise is not a ticker row", () => {
    expect(classifyTickerEvent(EV_SHOT, 0, 0)).toBe(-1);
    expect(classifyTickerEvent(EV_HIT, 1, 1)).toBe(-1);
  });

  test("a neutral or out-of-range team never classifies", () => {
    expect(classifyTickerEvent(EV_CAPTURE, -1, 0)).toBe(-1);
    expect(classifyTickerEvent(EV_ALARM, 0, 2)).toBe(-1);
  });

  test("every (kind, team) key has its display string", () => {
    expect(TICKER_TEXT.length).toBe(TICKER_KINDS);
    for (const pair of TICKER_TEXT) {
      expect(pair[0]).toContain("BLUE");
      expect(pair[1]).toContain("RED");
    }
  });
});
