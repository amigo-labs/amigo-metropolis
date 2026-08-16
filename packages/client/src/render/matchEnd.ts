// Match-end wording: pure and DOM-free (the dialog itself is raw DOM in
// main.ts, frame-loop world). Split out so the strings are testable — they
// depend on which side won AND which win condition the arena runs (rules.md
// §1 gate breach vs §9 core destruction).

export interface MatchEndText {
  readonly title: string;
  readonly subtitle: string;
}

export function matchEndText(winner: number, slot: number, hasCore: boolean): MatchEndText {
  const won = winner === slot;
  if (hasCore) {
    return {
      title: won ? "VICTORY" : "DEFEAT",
      subtitle: won ? "Enemy base razed" : "Your base was razed",
    };
  }
  return {
    title: won ? "VICTORY" : "DEFEAT",
    subtitle: won ? "Your unit breached the enemy gate" : "The enemy breached your gate",
  };
}

/** mm:ss for the stats row; ticks at 30 Hz. */
export function matchClock(tick: number, tickHz: number): string {
  const s = Math.max(0, Math.floor(tick / tickHz));
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest}`;
}
