// The original's control bindings (input.spec.md §2; RE docs/behavior/
// camera-and-movement.md "Input"): fourteen slots per player, each bound to one
// key or one joystick control, sampled into the button word the sim reads
// (inputs.ts). Escape is a fifteenth, fixed binding. Keys are the original's
// Windows virtual-key codes; the browser reports physical keys, so each code
// maps to the KeyboardEvent.code values that produce it.
//
// Client code: never reaches the sim except as the word it builds.

import {
  BTN_ACTION,
  BTN_BACK,
  BTN_CAMERA,
  BTN_CHANGE_TARGET,
  BTN_FORWARD,
  BTN_GUN,
  BTN_HEAVY,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_MAP,
  BTN_SPECIAL,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
} from "@metropolis/sim";

/** Binding slots per player. */
export const SLOT_COUNT = 14;

/** Each slot's name, as the original's controls screen labels its row. */
export const SLOT_NAMES: readonly string[] = [
  "Move Forward",
  "Move Backward",
  "Turn Right",
  "Turn Left",
  "Gun Weapon",
  "Action Key",
  "Special Weapon",
  "Jump",
  "Map Key",
  "Camera Key",
  "Jink Left",
  "Jink Right",
  "Heavy Weapon",
  "Change Target",
];

/** The bit of the button word each slot sets (after the original's permutation). */
export const SLOT_BITS: readonly number[] = [
  BTN_FORWARD,
  BTN_BACK,
  BTN_TURN_RIGHT,
  BTN_TURN_LEFT,
  BTN_GUN,
  BTN_ACTION,
  BTN_SPECIAL,
  BTN_JUMP,
  BTN_MAP,
  BTN_CAMERA,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_HEAVY,
  BTN_CHANGE_TARGET,
];

/**
 * The order the controls screen lists the slots in: left before right, the
 * jinks after the turns, the three weapons together.
 */
export const SLOT_ROW_ORDER: readonly number[] = [0, 1, 3, 2, 10, 11, 4, 12, 6, 5, 13, 7, 8, 9];

export const DEVICE_KEYBOARD = 0;
export const DEVICE_JOYSTICK = 1;

/** One slot's binding: a device and its code (a virtual key, or a joystick control). */
export interface Binding {
  device: number;
  code: number;
}

/** Joystick codes: buttons are 0..16, the stick's four directions 0x12..0x15. */
export const JOY_LEFT = 0x12;
export const JOY_RIGHT = 0x13;
export const JOY_UP = 0x14;
export const JOY_DOWN = 0x15;
/** The highest joystick button a binding can name. */
export const JOY_BUTTON_MAX = 16;

const k = (code: number): Binding => ({ device: DEVICE_KEYBOARD, code });
const j = (code: number): Binding => ({ device: DEVICE_JOYSTICK, code });

/** The shipped presets' names, in the original's order. */
export const PRESET_NAMES: readonly string[] = ["Keyboard", "Sidewinder Gamepad", "Gravis Gamepad"];

/**
 * The shipped presets per player (`bindings.c`): preset 0 is each player's
 * keyboard layout, 1 and 2 the two gamepads, the same for both players.
 * Preset 0 is the default.
 */
export const PRESETS: readonly (readonly (readonly Binding[])[])[] = [
  [
    // Player 1: the numeric keypad, the weapons on Space / Alt / Ctrl.
    [
      k(0x68),
      k(0x65),
      k(0x66),
      k(0x64),
      k(0x20),
      k(0x62),
      k(0x11),
      k(0x5a),
      k(0x4d),
      k(0x09),
      k(0x67),
      k(0x69),
      k(0x12),
      k(0x60),
    ],
    [
      j(0x14),
      j(0x15),
      j(0x13),
      j(0x12),
      j(0),
      j(4),
      j(2),
      j(3),
      j(8),
      j(9),
      j(6),
      j(7),
      j(1),
      j(5),
    ],
    [
      j(0x14),
      j(0x15),
      j(0x13),
      j(0x12),
      j(1),
      j(7),
      j(2),
      j(3),
      j(8),
      j(9),
      j(4),
      j(5),
      j(0),
      j(6),
    ],
  ],
  [
    // Player 2: the keypad again, the weapons and keys on its operators.
    [
      k(0x68),
      k(0x65),
      k(0x66),
      k(0x64),
      k(0x6a),
      k(0x60),
      k(0x6b),
      k(0x6f),
      k(0x62),
      k(0x6e),
      k(0x67),
      k(0x69),
      k(0x6d),
      k(0x61),
    ],
    [
      j(0x14),
      j(0x15),
      j(0x13),
      j(0x12),
      j(0),
      j(4),
      j(2),
      j(3),
      j(8),
      j(9),
      j(6),
      j(7),
      j(1),
      j(5),
    ],
    [
      j(0x14),
      j(0x15),
      j(0x13),
      j(0x12),
      j(1),
      j(7),
      j(2),
      j(3),
      j(8),
      j(9),
      j(4),
      j(5),
      j(0),
      j(6),
    ],
  ],
];

/** A fresh copy of a preset's table. */
export function presetTable(player: number, preset: number): Binding[] {
  return PRESETS[player][preset].map((b) => ({ device: b.device, code: b.code }));
}

/**
 * The original's key names (`bindings.c`), name -> virtual key. Its two bracket
 * rows are swapped against Windows' codes ("]" is 0xdb, "[" is 0xdd); kept.
 */
export const KEY_NAMES: readonly (readonly [string, number])[] = [
  ["Left", 0x25],
  ["Right", 0x27],
  ["Up", 0x26],
  ["Down", 0x28],
  ["NumPad0", 0x60],
  ["NumPad1", 0x61],
  ["NumPad2", 0x62],
  ["NumPad3", 0x63],
  ["NumPad4", 0x64],
  ["NumPad5", 0x65],
  ["NumPad6", 0x66],
  ["NumPad7", 0x67],
  ["NumPad8", 0x68],
  ["NumPad9", 0x69],
  ["NumPad -", 0x6d],
  ["+", 0x6b],
  ["*", 0x6a],
  ["NumPad /", 0x6f],
  ["Ctrl", 0x11],
  ["LShift", 0xa0],
  ["RShift", 0xa1],
  ["LCtrl", 0xa2],
  ["RCtrl", 0xa3],
  ["F5", 0x74],
  ["F6", 0x75],
  ["F7", 0x76],
  ["F8", 0x77],
  ["Space", 0x20],
  [" ", 0x20],
  ["End", 0x23],
  ["Home", 0x24],
  ["Insert", 0x2d],
  ["Delete", 0x2e],
  ["Help", 0x2f],
  ["Tab", 0x09],
  ["Alt", 0x12],
  ["Backspace", 0x08],
  ["Page Up", 0x21],
  ["Page Down", 0x22],
  ["NumPad .", 0x6e],
  ["Menu", 0x5d],
  ["=", 0xbb],
  [",", 0xbc],
  ["-", 0xbd],
  [".", 0xbe],
  ["]", 0xdb],
  ["[", 0xdd],
  ["'", 0xde],
  ["\\", 0xdc],
  ["/", 0xbf],
  [";", 0xba],
  ["`", 0xc0],
];

/** The original's joystick control names (`bindings.c`), name -> code. */
export const JOY_NAMES: readonly (readonly [string, number])[] = [
  ["Left", JOY_LEFT],
  ["Right", JOY_RIGHT],
  ["Up", JOY_UP],
  ["Down", JOY_DOWN],
  ...Array.from({ length: JOY_BUTTON_MAX + 1 }, (_, b) => [`Button${b}`, b] as const),
];

/**
 * The physical keys (KeyboardEvent.code) that press each virtual key. Ctrl and
 * Alt are VK_CONTROL and VK_MENU, which either key of the pair sets.
 */
const VK_CODES = new Map<number, readonly string[]>([
  [0x08, ["Backspace"]],
  [0x09, ["Tab"]],
  [0x0d, ["Enter", "NumpadEnter"]],
  [0x10, ["ShiftLeft", "ShiftRight"]],
  [0x11, ["ControlLeft", "ControlRight"]],
  [0x12, ["AltLeft", "AltRight"]],
  [0x14, ["CapsLock"]],
  [0x1b, ["Escape"]],
  [0x20, ["Space"]],
  [0x21, ["PageUp"]],
  [0x22, ["PageDown"]],
  [0x23, ["End"]],
  [0x24, ["Home"]],
  [0x25, ["ArrowLeft"]],
  [0x26, ["ArrowUp"]],
  [0x27, ["ArrowRight"]],
  [0x28, ["ArrowDown"]],
  [0x2d, ["Insert"]],
  [0x2e, ["Delete"]],
  [0x2f, ["Help"]],
  [0x5d, ["ContextMenu"]],
  [0x6a, ["NumpadMultiply"]],
  [0x6b, ["NumpadAdd"]],
  [0x6d, ["NumpadSubtract"]],
  [0x6e, ["NumpadDecimal"]],
  [0x6f, ["NumpadDivide"]],
  [0xa0, ["ShiftLeft"]],
  [0xa1, ["ShiftRight"]],
  [0xa2, ["ControlLeft"]],
  [0xa3, ["ControlRight"]],
  [0xba, ["Semicolon"]],
  [0xbb, ["Equal"]],
  [0xbc, ["Comma"]],
  [0xbd, ["Minus"]],
  [0xbe, ["Period"]],
  [0xbf, ["Slash"]],
  [0xc0, ["Backquote"]],
  [0xdb, ["BracketLeft"]],
  [0xdc, ["Backslash"]],
  [0xdd, ["BracketRight"]],
  [0xde, ["Quote"]],
]);
for (let c = 0; c < 10; c++) {
  VK_CODES.set(0x30 + c, [`Digit${c}`]);
  VK_CODES.set(0x60 + c, [`Numpad${c}`]);
}
for (let c = 0; c < 26; c++) VK_CODES.set(0x41 + c, [`Key${String.fromCharCode(0x41 + c)}`]);
for (let c = 0; c < 12; c++) VK_CODES.set(0x70 + c, [`F${c + 1}`]);

const NO_CODES: readonly string[] = [];

/** The physical keys that press virtual key `vk` (none for an unknown one). */
export function codesOfKey(vk: number): readonly string[] {
  return VK_CODES.get(vk) ?? NO_CODES;
}

/** The virtual key a physical key presses, for capturing a binding; -1 none. */
export function keyOfCode(code: string): number {
  // The generic Ctrl / Alt / Shift first: a captured Ctrl is VK_CONTROL, as the
  // original's capture of a key reports it.
  if (code === "ControlLeft" || code === "ControlRight") return 0x11;
  if (code === "AltLeft" || code === "AltRight") return 0x12;
  if (code === "ShiftLeft") return 0xa0;
  if (code === "ShiftRight") return 0xa1;
  for (const [vk, codes] of VK_CODES) if (codes.includes(code)) return vk;
  return -1;
}

/** A binding's name as the original writes it ("Keyboard: NumPad8"'s part after the colon). */
export function bindingName(b: Binding): string {
  if (b.device === DEVICE_JOYSTICK) {
    for (const [name, code] of JOY_NAMES) if (code === b.code) return name;
    return "Unknown";
  }
  for (const [name, vk] of KEY_NAMES) if (vk === b.code) return name;
  // The writer spells digits and capital letters itself; nothing else.
  const digit = b.code >= 0x30 && b.code <= 0x39;
  const letter = b.code >= 0x41 && b.code <= 0x5a;
  return digit || letter ? String.fromCharCode(b.code) : "Unknown";
}
