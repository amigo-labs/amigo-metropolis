// Player 1's controls, read as the original reads them: each binding slot whose
// key or joystick control is down sets its bit of the button word
// (input/bindings.ts, inputs.ts). The table is the original's keyboard preset
// until the controls screen changes it (input/controlsStore.ts); a gamepad
// plays only once a slot is bound to it, as in the original, where its profile
// has to be chosen. Sampled once per sim tick; raw device state never reaches
// the sim (architecture.md §2). The mouse plays no part in a match — the
// original has none.

import { BTN_ESCAPE, type PlayerInput } from "@metropolis/sim";
import {
  type Binding,
  bindingName,
  codesOfKey,
  DEVICE_JOYSTICK,
  DEVICE_KEYBOARD,
  presetTable,
  SLOT_BITS,
  SLOT_COUNT,
  SLOT_NAMES,
} from "./bindings";
import { firstPad, joyControlDown, type PadState } from "./gamepad";
import { isTextEntryTarget } from "./textEntry";
import type { LocalInputSource } from "./types";

/** The Map Key's slot: the client's pause and map screen. */
const SLOT_MAP = 8;
/** The Camera Key's slot: the client's chase-camera cycle. */
const SLOT_CAMERA = 9;

/** The legend for a table: each slot's name and its key, in slot order. */
export function controlsHint(table: readonly Binding[]): string {
  const parts: string[] = [];
  for (let s = 0; s < SLOT_COUNT; s++) parts.push(`${SLOT_NAMES[s]} ${bindingName(table[s])}`);
  return `${parts.join(" · ")} · transform: ${bindingName(table[13])} + ${bindingName(table[5])}`;
}

export class PlayerOneInput implements LocalInputSource {
  readonly label = "Keyboard / Gamepad";
  hint: string;
  /** Player 1's bindings: the original's keyboard preset until changed. */
  private table: Binding[] = presetTable(0, 0);
  /** Any slot bound to the joystick: only then is the pad polled. */
  private usesPad = false;
  private readonly down = new Set<string>();
  private mapWasDown = false;
  private cameraWasDown = false;
  /**
   * While a match runs, the bound keys belong to the game: Tab, Alt and Space
   * would otherwise move focus, open the browser's menu or scroll the page.
   */
  capture = false;
  /** The Map Key's press, while capturing: the original pauses (solo) on it. */
  onMap: (() => void) | null = null;
  /**
   * The Camera Key's press, while capturing: the original cycles its chase
   * cameras on it. Its bit never reaches the sim (inputs.ts BTN_CAMERA).
   */
  onCamera: (() => void) | null = null;

  constructor(target: Window) {
    this.hint = controlsHint(this.table);
    target.addEventListener("keydown", (e) => {
      // Don't steal a key from the pin modal's or the menu's text fields.
      if (isTextEntryTarget(e.target)) return;
      this.down.add(e.code);
      if (!this.capture || !this.isBound(e.code)) return;
      e.preventDefault();
      if (!e.repeat && this.isKeyOf(SLOT_MAP, e.code)) this.onMap?.();
      if (!e.repeat && this.isKeyOf(SLOT_CAMERA, e.code)) this.onCamera?.();
    });
    target.addEventListener("keyup", (e) => {
      if (isTextEntryTarget(e.target)) return;
      this.down.delete(e.code);
      // Alt's release is what opens the browser's menu bar.
      if (this.capture && this.isBound(e.code)) e.preventDefault();
    });
    target.addEventListener("blur", () => this.down.clear());
  }

  /** Player 1's current bindings (a copy). */
  getTable(): Binding[] {
    return this.table.map((b) => ({ device: b.device, code: b.code }));
  }

  /** Replaces the bindings (the controls screen, a profile). */
  setTable(table: readonly Binding[]): void {
    this.table = table.map((b) => ({ device: b.device, code: b.code }));
    this.usesPad = this.table.some((b) => b.device === DEVICE_JOYSTICK);
    this.hint = controlsHint(this.table);
  }

  /** A keyboard is always present. */
  isConnected(): boolean {
    return true;
  }

  private isKeyOf(slot: number, code: string): boolean {
    const b = this.table[slot];
    return b.device === DEVICE_KEYBOARD && codesOfKey(b.code).includes(code);
  }

  private isBound(code: string): boolean {
    if (code === "Escape") return false; // the pause card's
    for (let s = 0; s < SLOT_COUNT; s++) if (this.isKeyOf(s, code)) return true;
    return false;
  }

  /**
   * The pad's Map and Camera Keys, once a frame while capturing: the keyboard's
   * arrive as events, a pad's have to be polled — also while the sim is paused,
   * so the Map Key can resume it.
   */
  pollPad(): void {
    if (!this.usesPad || !this.capture) {
      this.mapWasDown = false;
      this.cameraWasDown = false;
      return;
    }
    const pad = firstPad();
    const map = this.table[SLOT_MAP];
    const mapDown = pad !== null && map.device === DEVICE_JOYSTICK && joyControlDown(pad, map.code);
    if (mapDown && !this.mapWasDown) this.onMap?.();
    this.mapWasDown = mapDown;
    const cam = this.table[SLOT_CAMERA];
    const camDown = pad !== null && cam.device === DEVICE_JOYSTICK && joyControlDown(pad, cam.code);
    if (camDown && !this.cameraWasDown) this.onCamera?.();
    this.cameraWasDown = camDown;
  }

  /** Writes the button word for this tick into `out`. */
  sample(out: PlayerInput): void {
    const pad: PadState | null = this.usesPad ? firstPad() : null;
    let buttons = 0;
    for (let s = 0; s < SLOT_COUNT; s++) {
      const b = this.table[s];
      if (b.device === DEVICE_KEYBOARD) {
        const codes = codesOfKey(b.code);
        for (let c = 0; c < codes.length; c++) {
          if (this.down.has(codes[c])) {
            buttons |= SLOT_BITS[s];
            break;
          }
        }
      } else if (pad !== null && b.device === DEVICE_JOYSTICK && joyControlDown(pad, b.code)) {
        buttons |= SLOT_BITS[s];
      }
    }
    // The fixed Escape binding (the sim cuts it; the pause card reads its key).
    if (this.down.has("Escape")) buttons |= BTN_ESCAPE;
    out.buttons = buttons;
  }
}
