// The results page's layout maths (render/results/resultsLayout.ts;
// fcop-fidelity.md V7) against the original's rules: results.c's centring and
// line positions, cfnt_text_width / cfnt_text_draw at 640 x 480 (the HUD's
// font), the figures' formats, the heads in their sides' colours and the footer.

import { describe, expect, test } from "bun:test";
import {
  RESULTS_SNAPSHOT_LEN,
  STAT_CURRENT_POINTS,
  STAT_FIRST_DEATH,
  STAT_KEYS,
  STAT_TANKS_CREATED,
  STAT_TOTAL_TIME,
} from "@metropolis/sim";
import { FONT3_GLYPHS } from "../src/render/fcopPresentation.generated";
import {
  RESULTS_COLUMNS,
  RESULTS_RECTS,
  RESULTS_TEXTS,
} from "../src/render/results/fcopResults.generated";
import {
  COLOUR_BLINK,
  footerText,
  formatFigure,
  headTexts,
  layoutPage,
  layoutText,
  levelText,
  lineX,
  pageTextWidth,
  spanX,
  type TextRun,
} from "../src/render/results/resultsLayout";
import { SIDE_BLUE, SIDE_RED } from "../src/render/sides";

const advance = (c: string): number => FONT3_GLYPHS[c.charCodeAt(0) - 32]?.[4] ?? 0;

describe("the generated page data", () => {
  test("carries the 25 strings, the four rects and the eleven columns", () => {
    expect(RESULTS_TEXTS.length).toBe(25);
    expect(RESULTS_TEXTS[0]).toBe("W I N N E R");
    expect(RESULTS_TEXTS[24]).toBe("press \x13the CAMERA key\x12 to quit");
    expect(RESULTS_RECTS.map((r) => r.rect)).toEqual([
      [20, 62, 600, 356],
      [20, 38, 300, 24],
      [320, 38, 300, 24],
      [20, 418, 600, 24],
    ]);
    expect(RESULTS_RECTS[1].rgb).toEqual([192, 0, 0]); // side 1's head, red
    expect(RESULTS_RECTS[2].rgb).toEqual([0, 0, 192]);
    expect(RESULTS_COLUMNS.length).toBe(11);
    // Twenty figures a side, keys 0..19 each once.
    for (const side of [0, 1]) {
      const keys = RESULTS_COLUMNS.filter((c) => c.side === side)
        .flatMap((c) => c.lines.map((l) => l.key ?? -1))
        .sort((a, b) => a - b);
      expect(keys).toEqual([...Array(STAT_KEYS).keys()]);
    }
  });

  test("lays the lines out by the formatter's rule: from y 0x21, 9 a byte, a half line 5", () => {
    const labels = RESULTS_COLUMNS[0].lines.map((l) => l.y);
    expect(labels).toEqual([42, 51, 60, 69, 92, 115, 129, 138, 147, 161, 170, 179, 188, 197]);
  });
});

describe("text metrics", () => {
  test("measures the advances of the printable bytes only", () => {
    expect(advance("A")).toBeGreaterThan(0);
    expect(pageTextWidth("AA")).toBe(2 * advance("A"));
    expect(pageTextWidth("A\x13A\x12")).toBe(2 * advance("A"));
  });

  test("centres a line on its column, truncating toward zero", () => {
    const w = pageTextWidth("Tanks");
    expect(lineX(160, "Tanks")).toBe(160 - Math.trunc(w / 4));
    expect(spanX(300, 10, "W I N N E R")).toBe(
      Math.trunc((300 - pageTextWidth("W I N N E R")) / 4) + 10,
    );
  });

  test("starts the pen at (2x, 2y) and splits a run at each colour code", () => {
    const out: TextRun[] = [];
    layoutText("ab\x13cd\x12e", 10, 20, 8, out);
    expect(out).toEqual([
      { text: "ab", x: 20, y: 40, colour: 8 },
      { text: "cd", x: 20 + advance("a") + advance("b"), y: 40, colour: 9 },
      {
        text: "e",
        x: 20 + advance("a") + advance("b") + advance("c") + advance("d"),
        y: 40,
        colour: 8,
      },
    ]);
  });
});

describe("figures", () => {
  test("prints counts as %ld and times as mm:ss of (v + 150) / 300", () => {
    expect(formatFigure(STAT_TANKS_CREATED, 12)).toBe("12");
    expect(formatFigure(STAT_CURRENT_POINTS, 0)).toBe("0");
    expect(formatFigure(STAT_FIRST_DEATH, 0)).toBe("00:00");
    expect(formatFigure(STAT_FIRST_DEATH, 149)).toBe("00:00");
    expect(formatFigure(STAT_FIRST_DEATH, 150)).toBe("00:01");
    expect(formatFigure(STAT_TOTAL_TIME, 300 * 75)).toBe("01:15");
    expect(formatFigure(STAT_TOTAL_TIME, 300 * 3600)).toBe("60:00");
    // The original's truncating divides on a negative time (results.c's note).
    expect(formatFigure(STAT_TOTAL_TIME, -45151)).toBe("-2:-30");
  });

  test("names the level just played", () => {
    expect(levelText(3)).toBe("LEVEL 03");
    expect(levelText(10)).toBe("LEVEL 10");
  });
});

describe("heads and footer", () => {
  test("puts WINNER over the side that won", () => {
    expect(headTexts(0)).toEqual(["W I N N E R", "L O S E R"]);
    expect(headTexts(1)).toEqual(["L O S E R", "W I N N E R"]);
  });

  test("offers only quit online, the next level after a solo win, else play again", () => {
    expect(footerText(true, false, 0)).toBe(RESULTS_TEXTS[24]);
    expect(footerText(false, true, 0)).toBe(RESULTS_TEXTS[23]);
    expect(footerText(false, true, 1)).toBe(RESULTS_TEXTS[22]);
    expect(footerText(false, false, 0)).toBe(RESULTS_TEXTS[22]);
  });
});

describe("the page", () => {
  const figures = new Float32Array(RESULTS_SNAPSHOT_LEN);
  figures[STAT_TANKS_CREATED] = 7;
  figures[STAT_KEYS + STAT_TANKS_CREATED] = 3;

  test("colours each head by the side its slot holds", () => {
    const red = layoutPage({ figures, winner: 0, online: false, level: 4, sides: [1, 2] });
    expect(red.rects[1].rgb).toEqual(RESULTS_RECTS[1].rgb);
    expect(red.rects[2].rgb).toEqual(RESULTS_RECTS[2].rgb);
    // La Cantina: Metropolis' slot 0 holds side 2 (render/sides.ts).
    const blue = layoutPage({
      figures,
      winner: 0,
      online: false,
      level: 4,
      sides: [SIDE_BLUE, SIDE_RED],
    });
    expect(blue.rects[1].rect).toEqual(RESULTS_RECTS[1].rect);
    expect(blue.rects[1].rgb).toEqual(RESULTS_RECTS[2].rgb);
    expect(blue.rects[2].rgb).toEqual(RESULTS_RECTS[1].rgb);
  });

  test("draws each side's figures in its own columns, the level blinking", () => {
    const solo = layoutPage({ figures, winner: 0, online: false, level: 4, sides: [1, 2] });
    const online = layoutPage({ figures, winner: 0, online: true, level: 0, sides: [1, 2] });
    // The level line is the only blinking text, and only in one viewport.
    expect(solo.runs.filter((r) => r.colour === COLOUR_BLINK).map((r) => r.text)).toEqual([
      "LEVEL 04",
    ]);
    expect(online.runs.some((r) => r.colour === COLOUR_BLINK)).toBe(false);
    // Tanks Created: x 40 (left) and 280 (right) of 320, y 42.
    expect(solo.runs).toContainEqual({ text: "7", x: lineX(40, "7") * 2, y: 84, colour: 8 });
    expect(solo.runs).toContainEqual({ text: "3", x: lineX(280, "3") * 2, y: 84, colour: 8 });
    // The footer's key names in yellow (colour 9), the rest white (8).
    const footer = solo.runs.filter((r) => r.y === 420);
    expect(footer.map((r) => r.colour)).toEqual([8, 9, 8, 9, 8]);
    expect(footer[1].text).toBe("the MAP key");
  });
});
