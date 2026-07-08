// Assignment screen (PLAN Phase 5): "press A to join". Players claim local
// slots with a controller (A) or the keyboard (Enter); once every needed slot
// is filled, Start (or Enter) begins the match. Resolves with one input source
// per slot, in slot order, and tears its overlay + listeners + poll loop down.
//
// This is a sandbox lobby, deliberately minimal — the real title/menu flow is
// Phase 7. It exists so splitscreen has a device-assignment step that works
// with any mix of gamepads and (for solo testing) the keyboard.

import { GamepadInput } from "./input/gamepad";
import type { PlayerOneInput } from "./input/keyboard";
import type { LocalInputSource } from "./input/types";

export interface LocalAssignment {
  readonly slot: number;
  readonly input: LocalInputSource;
}

interface Slot {
  input: LocalInputSource | null;
  /** Gamepad index bound here, or -1 for keyboard / empty. */
  padIndex: number;
}

// Standard Gamepad button indices used by the lobby only.
const BTN_A = 0;
const BTN_START = 9;

export function runLobby(opts: {
  needed: number;
  keyboard: PlayerOneInput;
}): Promise<LocalAssignment[]> {
  const { needed, keyboard } = opts;
  const slots: Slot[] = [];
  for (let i = 0; i < needed; i++) slots.push({ input: null, padIndex: -1 });

  const overlay = document.createElement("div");
  overlay.id = "lobby";
  document.body.appendChild(overlay);

  return new Promise<LocalAssignment[]>((resolve) => {
    let raf = 0;
    // Edge-detection state, indexed by gamepad slot.
    const prevA: boolean[] = [];
    const prevStart: boolean[] = [];
    let keyboardAssigned = false;

    const isPadTaken = (index: number): boolean =>
      slots.some((s) => s.padIndex === index && s.input !== null);
    const filledCount = (): number => slots.reduce((n, s) => n + (s.input ? 1 : 0), 0);
    const nextFreeSlot = (): number => slots.findIndex((s) => s.input === null);

    const assign = (input: LocalInputSource, padIndex: number): void => {
      const k = nextFreeSlot();
      if (k < 0) return;
      slots[k].input = input;
      slots[k].padIndex = padIndex;
    };

    const start = (): void => {
      if (filledCount() < needed) return;
      cancelAnimationFrame(raf);
      removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(slots.map((s, i) => ({ slot: i, input: s.input as LocalInputSource })));
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Enter") return;
      e.preventDefault();
      if (!keyboardAssigned && nextFreeSlot() >= 0) {
        keyboardAssigned = true;
        assign(keyboard, -1);
      } else if (filledCount() >= needed) {
        start();
      }
    };
    addEventListener("keydown", onKey);

    const render = (padCount: number): void => {
      const rows = slots
        .map((s, i) => {
          const who = s.input
            ? `<b>${s.input.label}</b> ✓`
            : "press <b>A</b> on a controller to join";
          return `<div class="lobby-slot">Player ${i + 1}: ${who}</div>`;
        })
        .join("");
      const ready = filledCount() >= needed;
      const footer = ready
        ? '<div class="lobby-go">press <b>Start</b> (or <b>Enter</b>) to begin</div>'
        : `<div class="lobby-hint">${padCount} controller${padCount === 1 ? "" : "s"} detected · keyboard joins with <b>Enter</b></div>`;
      overlay.innerHTML = `<div class="lobby-card"><h1>Couch splitscreen</h1>${rows}${footer}</div>`;
    };

    const poll = (): void => {
      const pads = navigator.getGamepads?.() ?? [];
      let padCount = 0;
      for (let g = 0; g < pads.length; g++) {
        const p = pads[g];
        if (!p?.connected) {
          prevA[g] = false;
          prevStart[g] = false;
          continue;
        }
        padCount++;
        const aDown = p.buttons[BTN_A]?.pressed ?? false;
        const startDown = p.buttons[BTN_START]?.pressed ?? false;
        // A (rising edge): claim a slot for this pad if it hasn't got one.
        if (aDown && !prevA[g] && !isPadTaken(g) && nextFreeSlot() >= 0) {
          assign(new GamepadInput(g), g);
        }
        // Start (rising edge): begin once every slot is filled.
        if (startDown && !prevStart[g]) start();
        prevA[g] = aDown;
        prevStart[g] = startDown;
      }
      render(padCount);
      raf = requestAnimationFrame(poll);
    };
    poll();
  });
}
