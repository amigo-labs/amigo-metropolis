// The keyboard (player 1), read as the original reads it: each binding slot
// whose key is down sets its bit of the button word (input/bindings.ts,
// inputs.ts). Sampled once per sim tick; raw key state never reaches the sim
// (architecture.md §2). The mouse plays no part in a match — the original has
// none.

import { BTN_ESCAPE, type PlayerInput } from "@metropolis/sim";
import {
  type Binding,
  bindingName,
  codesOfKey,
  DEVICE_KEYBOARD,
  presetTable,
  SLOT_BITS,
  SLOT_COUNT,
  SLOT_NAMES,
} from "./bindings";
import { isTextEntryTarget } from "./textEntry";
import type { LocalInputSource } from "./types";

/** The legend for a table: each slot's name and its key, in slot order. */
export function controlsHint(table: readonly Binding[]): string {
  const parts: string[] = [];
  for (let s = 0; s < SLOT_COUNT; s++) parts.push(`${SLOT_NAMES[s]} ${bindingName(table[s])}`);
  return `${parts.join(" · ")} · transform: ${bindingName(table[13])} + ${bindingName(table[5])}`;
}

export class PlayerOneInput implements LocalInputSource {
  readonly label = "Keyboard";
  hint: string;
  /** Player 1's bindings: the original's keyboard preset until changed. */
  private table: Binding[] = presetTable(0, 0);
  private readonly down = new Set<string>();
  /**
   * While a match runs, the bound keys belong to the game: Tab, Alt and Space
   * would otherwise move focus, open the browser's menu or scroll the page.
   */
  capture = false;

  constructor(target: Window) {
    this.hint = controlsHint(this.table);
    target.addEventListener("keydown", (e) => {
      // Don't steal a key from the pin modal's or the menu's text fields.
      if (isTextEntryTarget(e.target)) return;
      this.down.add(e.code);
      if (this.capture && this.isBound(e.code)) e.preventDefault();
    });
    target.addEventListener("keyup", (e) => {
      if (isTextEntryTarget(e.target)) return;
      this.down.delete(e.code);
      // Alt's release is what opens the browser's menu bar.
      if (this.capture && this.isBound(e.code)) e.preventDefault();
    });
    target.addEventListener("blur", () => this.down.clear());
  }

  /** Replaces the bindings (the controls screen, a profile). */
  setTable(table: readonly Binding[]): void {
    this.table = table.map((b) => ({ device: b.device, code: b.code }));
    this.hint = controlsHint(this.table);
  }

  /** A keyboard is always present. */
  isConnected(): boolean {
    return true;
  }

  private isBound(code: string): boolean {
    if (code === "Escape") return false; // the pause card's
    for (let s = 0; s < SLOT_COUNT; s++) {
      const b = this.table[s];
      if (b.device === DEVICE_KEYBOARD && codesOfKey(b.code).includes(code)) return true;
    }
    return false;
  }

  /** Writes the button word for this tick into `out`. Allocation-free. */
  sample(out: PlayerInput): void {
    let buttons = 0;
    for (let s = 0; s < SLOT_COUNT; s++) {
      const b = this.table[s];
      if (b.device !== DEVICE_KEYBOARD) continue;
      const codes = codesOfKey(b.code);
      for (let c = 0; c < codes.length; c++) {
        if (this.down.has(codes[c])) {
          buttons |= SLOT_BITS[s];
          break;
        }
      }
    }
    // The fixed Escape binding (the sim cuts it; the pause card reads its key).
    if (this.down.has("Escape")) buttons |= BTN_ESCAPE;
    out.buttons = buttons;
  }
}
