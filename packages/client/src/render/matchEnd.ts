// Match-end wording: pure and DOM-free (the dialog itself is raw DOM in
// main.ts, frame-loop world). Split out so the strings are testable — they
// depend on which side won. Every arena ends at a gate since SIM_VERSION 32
// (rules.md §1; the original has no destructible core, §9).

export interface MatchEndText {
  readonly title: string;
  readonly subtitle: string;
}

export function matchEndText(winner: number, slot: number): MatchEndText {
  const won = winner === slot;
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
