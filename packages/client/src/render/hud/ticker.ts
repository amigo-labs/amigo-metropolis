// Objective-ticker classification: which sim events become a HUD ticker row,
// and with what text. Pure and DOM-free so it is testable without a browser;
// hud.ts owns the rows, the expiry and the repeat suppression.

import { EV_ALARM, EV_CAPTURE, EV_CLAIM, EV_CORE_HIT } from "@metropolis/sim";

export const TICKER_KINDS = 4;
export const TK_CAPTURE = 0;
export const TK_CLAIM = 1;
export const TK_ALARM = 2;
export const TK_CORE = 3;

// Pre-built strings indexed by [kind][team] — the pump never builds a string
// (renderer rule 1; it runs on the sim-step path). Team colour is meaning
// (ui.md §3): slot 0 is blue, slot 1 red, like the score column.
export const TICKER_TEXT: readonly (readonly [string, string])[] = [
  ["TURRET CAPTURED — BLUE", "TURRET CAPTURED — RED"],
  ["OUTPOST CLAIMED — BLUE", "OUTPOST CLAIMED — RED"],
  ["INTRUSION — BLUE BASE", "INTRUSION — RED BASE"],
  ["CORE UNDER ATTACK — BLUE", "CORE UNDER ATTACK — RED"],
];

/**
 * Classifies one event into a ticker key `kind * 2 + team`, or -1 for events
 * the ticker does not show. `b`/`c` are the event's payload fields — which one
 * carries the team differs per type (events.ts).
 */
export function classifyTickerEvent(type: number, b: number, c: number): number {
  let kind: number;
  let team: number;
  if (type === EV_CAPTURE) {
    kind = TK_CAPTURE;
    team = b;
  } else if (type === EV_CLAIM) {
    kind = TK_CLAIM;
    team = b;
  } else if (type === EV_ALARM) {
    kind = TK_ALARM;
    team = c;
  } else if (type === EV_CORE_HIT) {
    kind = TK_CORE;
    team = c;
  } else {
    return -1;
  }
  if (team !== 0 && team !== 1) return -1;
  return kind * 2 + team;
}
