// The original's controls (input.spec.md): the presets, the bindings file's
// rules (input/controlsStore.ts), the joystick's per-axis dead zone and d-pad
// (input/gamepad.ts), and the keyboard sampled into the button word
// (input/keyboard.ts).

import { describe, expect, it } from "bun:test";
import {
  BTN_ACTION,
  BTN_BACK,
  BTN_CHANGE_TARGET,
  BTN_FORWARD,
  BTN_GUN,
  BTN_HEAVY,
  BTN_JUMP,
  BTN_SPECIAL,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  type PlayerInput,
  TRANSFORM_CHORD,
} from "@metropolis/sim";
import {
  bindingName,
  codesOfKey,
  DEVICE_JOYSTICK,
  DEVICE_KEYBOARD,
  JOY_DOWN,
  JOY_LEFT,
  JOY_RIGHT,
  JOY_UP,
  keyOfCode,
  PRESETS,
  presetTable,
  SLOT_BITS,
  SLOT_COUNT,
} from "../src/input/bindings";
import {
  defaultControls,
  formatBinding,
  formatControls,
  parseBinding,
  parseControls,
} from "../src/input/controlsStore";
import { firstJoyControl, joyControlDown, type PadState } from "../src/input/gamepad";
import { PlayerOneInput } from "../src/input/keyboard";

describe("the presets (bindings.c)", () => {
  it("binds player 1's keypad, Space / Alt / Ctrl, Z, M and Tab", () => {
    const names = presetTable(0, 0).map(bindingName);
    expect(names).toEqual([
      "NumPad8",
      "NumPad5",
      "NumPad6",
      "NumPad4",
      "Space",
      "NumPad2",
      "Ctrl",
      "Z",
      "M",
      "Tab",
      "NumPad7",
      "NumPad9",
      "Alt",
      "NumPad0",
    ]);
  });

  it("gives both players the same two gamepad presets, and different keyboards", () => {
    expect(PRESETS[0][1]).toEqual(PRESETS[1][1]);
    expect(PRESETS[0][2]).toEqual(PRESETS[1][2]);
    expect(PRESETS[0][0]).not.toEqual(PRESETS[1][0]);
    // The Sidewinder: the stick moves and turns, the transform is Button4 + Button5.
    const side = presetTable(0, 1);
    expect(side.slice(0, 4).map((b) => b.code)).toEqual([JOY_UP, JOY_DOWN, JOY_RIGHT, JOY_LEFT]);
    expect([bindingName(side[5]), bindingName(side[13])]).toEqual(["Button4", "Button5"]);
  });

  it("maps every slot to its own bit of the word", () => {
    expect(new Set(SLOT_BITS).size).toBe(SLOT_COUNT);
  });

  it("reads Ctrl and Alt as either key of the pair, and captures them as one", () => {
    expect(codesOfKey(0x11)).toEqual(["ControlLeft", "ControlRight"]);
    expect(codesOfKey(0x12)).toEqual(["AltLeft", "AltRight"]);
    expect(keyOfCode("ControlRight")).toBe(0x11);
    expect(keyOfCode("Numpad8")).toBe(0x68);
    expect(keyOfCode("KeyZ")).toBe(0x5a);
    expect(keyOfCode("NoSuchKey")).toBe(-1);
  });
});

describe("the bindings file (controlsStore.ts)", () => {
  it("round-trips both players' tables, fourteen lines each", () => {
    const text = formatControls(defaultControls());
    expect(text.split("\n").length).toBe(2 * SLOT_COUNT + 1);
    expect(text.startsWith("Keyboard: NumPad8\nKeyboard: NumPad5\n")).toBe(true);
    expect(parseControls(text)).toEqual(defaultControls());
  });

  it("binds a key name it does not know by its first character", () => {
    expect(parseBinding("Keyboard: Q")).toEqual({ device: DEVICE_KEYBOARD, code: 0x51 });
    expect(parseBinding("Keyboard: Quux")).toEqual({ device: DEVICE_KEYBOARD, code: 0x51 });
    // A joystick name it does not know, and the mouse, are refused.
    expect(parseBinding("Joystick: Button99")).toBeNull();
    expect(parseBinding("Joystick: Button16")).toEqual({ device: DEVICE_JOYSTICK, code: 16 });
    expect(parseBinding("Mouse: Left")).toBeNull();
    expect(parseBinding("no colon")).toBeNull();
  });

  it("loses everything on one bad line, not just that line", () => {
    const lines = formatControls(defaultControls()).split("\n");
    lines[27] = "Mouse: Left"; // player 2's last line
    expect(parseControls(lines.join("\n"))).toBeNull();
    // A file a line short too.
    expect(parseControls(lines.slice(0, 20).join("\n"))).toBeNull();
  });

  it("writes only digits and capitals itself: a lower-case key is lost on the next load", () => {
    expect(formatBinding({ device: DEVICE_KEYBOARD, code: 0x51 })).toBe("Keyboard: Q");
    expect(formatBinding({ device: DEVICE_KEYBOARD, code: 0x71 })).toBe("Unknown");
    const tables = defaultControls();
    tables[0][7] = { device: DEVICE_KEYBOARD, code: 0x71 }; // 'q', as the reader accepts it
    expect(parseControls(formatControls(tables))).toBeNull();
  });

  it("cuts each line's last character, so an unterminated file loses one more", () => {
    const text = formatControls(defaultControls());
    // Without the final newline, "Keyboard: NumPad1" reads as "NumPad" -> 'N'.
    const parsed = parseControls(text.slice(0, -1));
    expect(parsed?.[1][13]).toEqual({ device: DEVICE_KEYBOARD, code: 0x4e });
  });
});

/** A pad in the Gamepad API's shape. */
function pad(axes: number[], pressed: number[] = [], mapping = "standard"): PadState {
  const buttons = Array.from({ length: 17 }, (_, b) => ({ pressed: pressed.includes(b) }));
  return { axes, buttons, mapping };
}

describe("the joystick (gamepad.ts)", () => {
  it("reads each axis past a quarter of its travel, for its sign", () => {
    expect(joyControlDown(pad([0.24, 0]), JOY_RIGHT)).toBe(false);
    expect(joyControlDown(pad([0.26, 0]), JOY_RIGHT)).toBe(true);
    expect(joyControlDown(pad([-0.5, 0]), JOY_LEFT)).toBe(true);
    expect(joyControlDown(pad([0, -0.9]), JOY_UP)).toBe(true);
    expect(joyControlDown(pad([0, 0.9]), JOY_DOWN)).toBe(true);
    // Per axis, not a circle: a diagonal past 25 % on both sets both.
    const diag = pad([0.3, -0.3]);
    expect(joyControlDown(diag, JOY_RIGHT) && joyControlDown(diag, JOY_UP)).toBe(true);
    // The second stick is not read.
    expect(joyControlDown(pad([0, 0, 1, 1]), JOY_RIGHT)).toBe(false);
  });

  it("reads a standard pad's d-pad as the stick, and buttons 0..16", () => {
    expect(joyControlDown(pad([0, 0], [12]), JOY_UP)).toBe(true);
    expect(joyControlDown(pad([0, 0], [15]), JOY_RIGHT)).toBe(true);
    expect(joyControlDown(pad([0, 0], [12], ""), JOY_UP)).toBe(false);
    expect(joyControlDown(pad([0, 0], [4]), 4)).toBe(true);
    expect(joyControlDown(pad([0, 0], [16]), 16)).toBe(true);
    expect(firstJoyControl(pad([0, 0], [5]))).toBe(5);
    expect(firstJoyControl(pad([0, 0], [13]))).toBe(JOY_DOWN);
    expect(firstJoyControl(pad([0, 0]))).toBe(-1);
  });
});

/** A window stand-in: events only. */
function fakeWindow(): Window & { key(type: string, code: string): void } {
  const t = new EventTarget() as unknown as Window & { key(type: string, code: string): void };
  t.key = (type, code) => {
    const e = new Event(type) as Event & { code: string; repeat: boolean };
    e.code = code;
    e.repeat = false;
    t.dispatchEvent(e);
  };
  return t;
}

describe("player 1's keyboard (keyboard.ts)", () => {
  it("samples the keypad preset into the word", () => {
    const w = fakeWindow();
    const input = new PlayerOneInput(w);
    const out: PlayerInput = { buttons: 0 };
    w.key("keydown", "Numpad8");
    w.key("keydown", "Numpad6");
    w.key("keydown", "Space");
    w.key("keydown", "AltRight");
    w.key("keydown", "ControlLeft");
    w.key("keydown", "KeyZ");
    input.sample(out);
    expect(out.buttons).toBe(
      BTN_FORWARD | BTN_TURN_RIGHT | BTN_GUN | BTN_HEAVY | BTN_SPECIAL | BTN_JUMP,
    );
    w.key("keyup", "Numpad8");
    w.key("keyup", "Numpad6");
    w.key("keyup", "Space");
    w.key("keyup", "AltRight");
    w.key("keyup", "ControlLeft");
    w.key("keyup", "KeyZ");
    // The chord: NumPad0 + NumPad2.
    w.key("keydown", "Numpad0");
    w.key("keydown", "Numpad2");
    input.sample(out);
    expect(out.buttons).toBe(TRANSFORM_CHORD);
    expect(TRANSFORM_CHORD).toBe(BTN_CHANGE_TARGET | BTN_ACTION);
  });

  it("takes a new table, and the Map Key's press while capturing", () => {
    const w = fakeWindow();
    const input = new PlayerOneInput(w);
    const table = presetTable(0, 0);
    table[1] = { device: DEVICE_KEYBOARD, code: 0x53 }; // Move Backward on S
    table[3] = { device: DEVICE_KEYBOARD, code: 0x41 }; // Turn Left on A
    input.setTable(table);
    const out: PlayerInput = { buttons: 0 };
    w.key("keydown", "KeyS");
    w.key("keydown", "KeyA");
    input.sample(out);
    expect(out.buttons).toBe(BTN_BACK | BTN_TURN_LEFT);
    expect(input.hint).toContain("Move Backward S");
    let maps = 0;
    input.onMap = () => {
      maps++;
    };
    w.key("keydown", "KeyM");
    expect(maps).toBe(0); // not while the match is not capturing keys
    input.capture = true;
    w.key("keyup", "KeyM");
    w.key("keydown", "KeyM");
    expect(maps).toBe(1);
  });
});
