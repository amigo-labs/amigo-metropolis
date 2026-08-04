// Directional focus resolution. The DOM half (navFocus.ts) is browser-only, but
// the geometry is pure and tested here against the layouts the menu actually
// produces — a stacked column, the 2x2 mode grid, the wrapping arena picker and
// a row of side-by-side controls.

import { describe, expect, test } from "bun:test";
import { buildRows, type NavRect, resolveNav } from "../src/ui/navResolve";

/** Box helper: r(left, top, width, height). */
const r = (left: number, top: number, w: number, h: number): NavRect => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

/** N boxes stacked vertically, 40 high with an 8 gap — the weapons column. */
function column(n: number): NavRect[] {
  return Array.from({ length: n }, (_, i) => r(30, i * 48, 300, 40));
}

/** `cols`-wide grid of 96x96 cards with a 10 gap — the arena picker. */
function grid(count: number, cols: number): NavRect[] {
  return Array.from({ length: count }, (_, i) =>
    r(30 + (i % cols) * 106, 200 + Math.floor(i / cols) * 106, 96, 96),
  );
}

describe("buildRows", () => {
  test("a stacked column is one element per row", () => {
    expect(buildRows(column(4))).toEqual([[0], [1], [2], [3]]);
  });

  test("a 3-wide grid of 6 groups into two rows, each left to right", () => {
    expect(buildRows(grid(6, 3))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  test("boxes of different heights still share a row when they overlap", () => {
    // A tall arena card beside a short button: comparing `top` alone would
    // split these, which is the bug this rule exists to prevent.
    const rects = [r(0, 100, 96, 96), r(120, 130, 80, 30)];
    expect(buildRows(rects)).toEqual([[0, 1]]);
  });

  test("rows come out top to bottom regardless of input order", () => {
    const rects = [r(0, 300, 50, 20), r(0, 100, 50, 20), r(0, 200, 50, 20)];
    expect(buildRows(rects)).toEqual([[1], [2], [0]]);
  });
});

describe("resolveNav — column", () => {
  const rects = column(4);

  test("down and up walk one step", () => {
    expect(resolveNav(rects, 0, "down")).toBe(1);
    expect(resolveNav(rects, 2, "up")).toBe(1);
  });

  test("does not wrap at either end", () => {
    expect(resolveNav(rects, 0, "up")).toBe(0);
    expect(resolveNav(rects, 3, "down")).toBe(3);
  });

  test("left and right do nothing when a row holds one element", () => {
    expect(resolveNav(rects, 1, "left")).toBe(1);
    expect(resolveNav(rects, 1, "right")).toBe(1);
  });
});

describe("resolveNav — arena picker", () => {
  test("3x2: right walks the row, down keeps the column", () => {
    const rects = grid(6, 3);
    expect(resolveNav(rects, 0, "right")).toBe(1);
    expect(resolveNav(rects, 1, "down")).toBe(4);
    expect(resolveNav(rects, 4, "up")).toBe(1);
  });

  test("2x3 after a narrower reflow: same code, different wrap", () => {
    // repeat(auto-fill, ...) changes its column count on resize. Rects are read
    // fresh per move, so the resolver simply sees a different grid.
    const rects = grid(6, 2);
    expect(resolveNav(rects, 0, "right")).toBe(1);
    expect(resolveNav(rects, 1, "down")).toBe(3);
    expect(resolveNav(rects, 4, "up")).toBe(2);
  });

  test("right stops at the end of a row instead of wrapping to the next", () => {
    const rects = grid(6, 3);
    expect(resolveNav(rects, 2, "right")).toBe(2);
  });

  test("a short last row still catches a downward move", () => {
    // 5 cards over 3 columns: row 2 holds only [3, 4]. Coming down from card 2
    // (rightmost) must land on the nearest one that exists, not fall through.
    const rects = grid(5, 3);
    expect(resolveNav(rects, 2, "down")).toBe(4);
  });
});

describe("resolveNav — mixed rows", () => {
  test("side-by-side controls are reached horizontally, not vertically", () => {
    // [room code][Join] then the error line and the host button below.
    const rects = [r(30, 0, 200, 36), r(240, 0, 80, 36), r(30, 48, 290, 36)];
    expect(resolveNav(rects, 0, "right")).toBe(1);
    expect(resolveNav(rects, 0, "down")).toBe(2);
    expect(resolveNav(rects, 1, "down")).toBe(2);
    // Back up from the wide button: its centre (175) sits nearer the code field
    // (130) than Join (280), so that is where it lands.
    expect(resolveNav(rects, 2, "up")).toBe(0);
  });

  test("moving up from a wide row lands on the horizontally nearest box", () => {
    // Footer: four links in a row, one wide button beneath. Coming back up from
    // the button should reach the link above it, not always the first one.
    const rects = [r(0, 0, 60, 30), r(70, 0, 60, 30), r(140, 0, 60, 30), r(120, 40, 80, 30)];
    expect(resolveNav(rects, 3, "up")).toBe(2);
  });
});

describe("resolveNav — edges", () => {
  test("no focusables resolves to -1", () => {
    expect(resolveNav([], 0, "down")).toBe(-1);
  });

  test("no current focus enters at the first element in any direction", () => {
    // Focus falls to <body> whenever a re-render removes the focused node.
    const rects = column(3);
    expect(resolveNav(rects, -1, "down")).toBe(0);
    expect(resolveNav(rects, -1, "up")).toBe(0);
    expect(resolveNav(rects, 99, "left")).toBe(0);
  });
});
