// The original's Win32 dialogs rebuilt in HTML: the DLU geometry, the
// controls screen's fields, the profile preview. Pure parts only (the dialogs
// themselves use hooks; see menuScreens.test.tsx's note).

import { describe, expect, test } from "bun:test";
import { presetTable, SLOT_NAMES } from "../src/input/bindings";
import { formatBinding } from "../src/input/controlsStore";
import { AUDIO_ROWS } from "../src/menu/dialogs/AudioDialog";
import { bindingOfKey, CONTROLS_FIELD_IDS } from "../src/menu/dialogs/ControlsDialog";
import { HD_TEXTURES_DLU } from "../src/menu/dialogs/OptionsDialog";
import { PROFILE_ROW_SLOT, profileLine, profileLines } from "../src/menu/dialogs/ProfileDialog";
import { FE_DIALOGS } from "../src/menu/frontend/frontendData.generated";
import {
  baseUnitsOf,
  CAPTION_HEIGHT,
  centreOnScreen,
  DLG_FRAME,
  dialogWindowSize,
  mapDialogRect,
  mulDiv,
} from "../src/menu/win9x/dlu";

describe("dialog units", () => {
  test("MulDiv rounds to nearest", () => {
    expect(mulDiv(277, 6, 4)).toBe(416); // 415.5
    expect(mulDiv(158, 13, 8)).toBe(257); // 256.75
    expect(mulDiv(7, 6, 4)).toBe(11); // 10.5
    expect(mulDiv(0, 13, 8)).toBe(0);
  });

  test("MS Sans Serif 8's base units are 6 x 13", () => {
    const bu = baseUnitsOf(FE_DIALOGS.options.font);
    expect([bu.cx, bu.cy]).toEqual([6, 13]);
    expect(baseUnitsOf({ face: "MS Shell Dlg", size: 8 }).cx).toBe(6);
  });

  test("MapDialogRect converts each edge, so widths follow the rounded edges", () => {
    const bu = baseUnitsOf(FE_DIALOGS.options.font);
    // OK (7, 139, 50, 14): left 10.5 -> 11, right 85.5 -> 86; top 225.875 ->
    // 226, bottom 248.625 -> 249: Windows' familiar 75 x 23 push button.
    expect(mapDialogRect([7, 139, 50, 14], bu)).toEqual({
      left: 11,
      top: 226,
      width: 75,
      height: 23,
    });
  });

  test("the options dialog: 277 x 158 DLU, the modal frame and the client edge", () => {
    const d = FE_DIALOGS.options;
    expect(d.dlu).toEqual([0, 0, 277, 158]);
    expect(d.exStyle & 0x200).toBe(0x200);
    const w = dialogWindowSize(d.dlu, baseUnitsOf(d.font), false, true);
    expect([w.client.width, w.client.height]).toEqual([416, 257]);
    expect([w.width, w.height]).toEqual([416 + 2 * (DLG_FRAME + 2), 257 + 2 * (DLG_FRAME + 2)]);
    expect(centreOnScreen(w.width, w.height)).toEqual({
      left: Math.floor((640 - w.width) / 2),
      top: Math.floor((480 - w.height) / 2),
    });
  });

  test("a captioned dialog adds the caption bar", () => {
    const d = FE_DIALOGS.audio;
    expect(d.styles).toContain("WS_CAPTION");
    expect(d.caption).toBe("Audio"); // the runtime caption over "Audio Controls"
    const bu = baseUnitsOf(d.font);
    const plain = dialogWindowSize(d.dlu, bu, false, false);
    expect(dialogWindowSize(d.dlu, bu, true, false).height).toBe(plain.height + CAPTION_HEIGHT);
  });

  test("every dialog fits the 640 x 480 screen", () => {
    for (const d of Object.values(FE_DIALOGS)) {
      const w = dialogWindowSize(
        d.dlu,
        baseUnitsOf(d.font),
        d.styles.includes("WS_CAPTION"),
        (d.exStyle & 0x200) !== 0,
      );
      expect(w.width).toBeLessThanOrEqual(640);
      expect(w.height).toBeLessThanOrEqual(480);
    }
  });

  test("the HD textures addition sits in the options dialog's free row", () => {
    const d = FE_DIALOGS.options;
    const [x, y, , h] = HD_TEXTURES_DLU;
    const audio = d.controls.find((c) => c.id === 1100)?.dlu as readonly number[];
    const ok = d.controls.find((c) => c.id === 1001)?.dlu as readonly number[];
    expect(x).toBe(7);
    expect(y).toBeGreaterThanOrEqual(audio[1] + audio[3]);
    expect(y + h).toBeLessThanOrEqual(ok[1]);
  });
});

describe("the controls screen", () => {
  const d = FE_DIALOGS.controls;
  test("Small Fonts 7, 394 x 238 DLU, Player 1 and Player 2", () => {
    expect(d.font).toEqual({ face: "Small Fonts", size: 7 });
    expect(d.dlu).toEqual([0, 0, 394, 238]);
    const texts = d.controls.map((c) => c.text);
    expect(texts).toContain("Player 1");
    expect(texts).toContain("Player 2");
    expect(texts.filter((t) => t === "Select Default Profile")).toHaveLength(2);
  });

  test("each slot's field sits beside its label, player 1 at x 51, player 2 at x 235", () => {
    const labels = d.controls.filter((c) => c.cls === "Static" && !c.styles.includes("WS_BORDER"));
    for (let player = 0; player < 2; player++) {
      CONTROLS_FIELD_IDS[player].forEach((id, slot) => {
        const field = d.controls.find((c) => c.id === id);
        expect(field?.styles).toContain("WS_BORDER");
        expect(field?.dlu[0]).toBe(player === 0 ? 51 : 235);
        // The label nearest in height names the slot.
        const y = (field?.dlu[1] ?? 0) + (field?.dlu[3] ?? 0) / 2;
        const nearest = labels
          .filter((l) => l.dlu[0] === 161)
          .reduce((a, b) =>
            Math.abs(a.dlu[1] + a.dlu[3] / 2 - y) <= Math.abs(b.dlu[1] + b.dlu[3] / 2 - y) ? a : b,
          );
        expect(nearest.text).toBe(SLOT_NAMES[slot]);
      });
    }
  });

  test("the hook writes a nameable key; an unnameable one is passed on", () => {
    expect(formatBinding(bindingOfKey("Numpad8") ?? { device: 0, code: -1 })).toBe(
      "Keyboard: NumPad8",
    );
    expect(bindingOfKey("KeyQ")).toEqual({ device: 0, code: 0x51 });
    expect(bindingOfKey("Escape")).toBeNull();
    expect(bindingOfKey("NoSuchKey")).toBeNull();
  });

  test("the profile preview: the slot's name padded to twenty, then the binding", () => {
    expect(PROFILE_ROW_SLOT).toHaveLength(14);
    expect(new Set(PROFILE_ROW_SLOT).size).toBe(14);
    const lines = profileLines(0, 0);
    expect(lines[0]).toBe(`Move Forward${" ".repeat(8)}: Keyboard: NumPad8`);
    expect(profileLine(5, presetTable(0, 1)[5]).slice(0, 22)).toBe("Action Key          : ");
  });
});

describe("the audio dialog", () => {
  test("three trackbars in the original's order", () => {
    expect(
      AUDIO_ROWS.map(([, label]) => FE_DIALOGS.audio.controls.find((c) => c.id === label)?.text),
    ).toEqual(["Sound Effects Volume", "Music Volume", "Movies Volume"]);
  });
});
