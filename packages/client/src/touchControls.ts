// On-screen touch control overlay (dumb DOM, no input logic): two floating
// virtual-stick visuals plus one button element per TOUCH_BUTTONS entry.
// Created once at boot (touch mode only) and revealed per match — the desktop
// DOM never gains these elements. All pointer *logic* (who owns which stick,
// button bits) lives in input/touch.ts; this module only builds elements and
// moves them. CSS lives in index.html (.touch-* classes), matching how the
// menu / HUD styles are shipped.

import type { TouchButtonSpec } from "./input/touchMapping";

export type StickSide = "move" | "aim";

export interface TouchControlsHandle {
  /** Full-screen pointer surface the input source listens on. */
  readonly root: HTMLDivElement;
  /** One element per TOUCH_BUTTONS entry, same order. */
  readonly buttons: readonly HTMLDivElement[];
  /**
   * Positions a stick's base+knob (viewport CSS px; knob offset relative to
   * the base center) and toggles its visibility. Write-only visual update —
   * called from pointer events, not the frame loop.
   */
  setStick(side: StickSide, baseX: number, baseY: number, knobDx: number, knobDy: number): void;
  hideStick(side: StickSide): void;
  /** Toggles button pressed styling (the bit itself lives in the source). */
  setButtonDown(index: number, down: boolean): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

function makeStick(): { base: HTMLDivElement; knob: HTMLDivElement } {
  const base = document.createElement("div");
  base.className = "touch-stick";
  base.style.display = "none";
  const knob = document.createElement("div");
  knob.className = "touch-knob";
  base.appendChild(knob);
  return { base, knob };
}

export function createTouchControls(specs: readonly TouchButtonSpec[]): TouchControlsHandle {
  const root = document.createElement("div");
  root.className = "touch-root";
  root.style.display = "none";

  const move = makeStick();
  const aim = makeStick();
  root.appendChild(move.base);
  root.appendChild(aim.base);

  const cluster = document.createElement("div");
  cluster.className = "touch-buttons";
  const buttons: HTMLDivElement[] = [];
  for (const spec of specs) {
    const el = document.createElement("div");
    el.className = "touch-btn";
    el.dataset.action = spec.id;
    el.textContent = spec.label;
    cluster.appendChild(el);
    buttons.push(el);
  }
  root.appendChild(cluster);
  document.body.appendChild(root);

  const stickOf = (side: StickSide) => (side === "move" ? move : aim);

  return {
    root,
    buttons,
    setStick(side, baseX, baseY, knobDx, knobDy) {
      const s = stickOf(side);
      s.base.style.display = "block";
      s.base.style.transform = `translate(${baseX}px, ${baseY}px)`;
      s.knob.style.transform = `translate(${knobDx}px, ${knobDy}px)`;
    },
    hideStick(side) {
      stickOf(side).base.style.display = "none";
    },
    setButtonDown(index, down) {
      buttons[index]?.classList.toggle("is-down", down);
    },
    show() {
      root.style.display = "block";
    },
    hide() {
      root.style.display = "none";
    },
    dispose() {
      root.remove();
    },
  };
}
