// Pure directional-focus math — NO DOM, so it is unit-testable under `bun test`.
// The stateful part (querying focusables, polling gamepads, moving focus) lives
// in navFocus.ts. Same split as gamepadMapping.ts vs gamepad.ts.
//
// The model is "visual rows", not DOM order. Every focusable is grouped with the
// ones it overlaps vertically; left/right walks a row, up/down steps between
// rows keeping the horizontal position. One rule covers every layout the menu
// has — the single-file column, the 2x2 mode grid, the wrapping arena picker,
// and side-by-side controls like [room code][Join] — so there is no grid special
// case and no marker attribute to keep in sync with the CSS.
//
// DOM order would get the last one wrong: [room code][Join] sit side by side, so
// reaching Join by pressing "down" is exactly the kind of thing that makes a
// pad-driven menu feel broken.

export type NavDir = "up" | "down" | "left" | "right";

/** A focusable's screen box. Matches the shape of a DOMRect (subset). */
export interface NavRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Two boxes share a row when their vertical spans overlap by at least half the
 * shorter box. Comparing raw `top` values would split a row whenever a tall
 * arena card sits next to a short button; comparing centres would merge rows
 * that merely touch.
 */
function sameRow(a: NavRect, b: NavRect): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (overlap <= 0) return false;
  const shorter = Math.min(a.bottom - a.top, b.bottom - b.top);
  return shorter <= 0 ? true : overlap / shorter >= 0.5;
}

/**
 * Groups indices into visual rows, top to bottom, each row ordered left to
 * right. A row extends while the next box still overlaps the row's first box.
 */
export function buildRows(rects: readonly NavRect[]): number[][] {
  const order = rects.map((_, i) => i).sort((i, j) => rects[i].top - rects[j].top);
  const rows: number[][] = [];
  for (const i of order) {
    const row = rows.find((r) => sameRow(rects[r[0]], rects[i]));
    if (row) row.push(i);
    else rows.push([i]);
  }
  for (const row of rows) row.sort((i, j) => rects[i].left - rects[j].left);
  return rows;
}

/** Horizontal centre, used to keep the column position across a row change. */
function centreX(r: NavRect): number {
  return (r.left + r.right) / 2;
}

/**
 * The next index to focus, or `current` when the move runs off the edge.
 * Deliberately does not wrap: in a scrolling rail, wrapping from the last
 * control back to the title reads as a glitch rather than a feature.
 *
 * Returns -1 only when there is nothing focusable at all.
 */
export function resolveNav(rects: readonly NavRect[], current: number, dir: NavDir): number {
  if (rects.length === 0) return -1;
  // No current focus (fresh mount, or focus fell to <body> after a re-render):
  // any direction enters at the first element.
  if (current < 0 || current >= rects.length) return buildRows(rects)[0][0];

  const rows = buildRows(rects);
  const rowIndex = rows.findIndex((r) => r.includes(current));
  if (rowIndex < 0) return current;
  const row = rows[rowIndex];

  if (dir === "left" || dir === "right") {
    const at = row.indexOf(current);
    const next = dir === "left" ? at - 1 : at + 1;
    return next >= 0 && next < row.length ? row[next] : current;
  }

  const targetRow = rows[dir === "up" ? rowIndex - 1 : rowIndex + 1];
  if (!targetRow) return current;
  // Keep the horizontal position: land on whichever box in the target row is
  // nearest, so walking down a column of same-width buttons stays in a line.
  const x = centreX(rects[current]);
  let best = targetRow[0];
  let bestDist = Math.abs(centreX(rects[best]) - x);
  for (const i of targetRow) {
    const d = Math.abs(centreX(rects[i]) - x);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}
