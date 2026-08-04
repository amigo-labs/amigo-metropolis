// Keyboard + gamepad focus movement for the menu (docs/specs/ui.md §4).
//
// Deliberately framework-free: it walks live DOM through querySelectorAll, so
// the Preact menu and the raw-DOM overlays (a pause menu, later) can both use
// it without an adapter. The geometry lives in navResolve.ts, pure and tested.
//
// Polling, not requestAnimationFrame: navigator.getGamepads() allocates a fresh
// array on every call, and this module is meant to survive being attached
// during a match, where renderer rule 1 (zero allocations in the frame loop)
// applies. A 16 Hz interval is well clear of the ~7 Hz key-repeat this drives,
// so nothing is lost by staying off the frame loop.

import { STICK_DEADZONE, stickWithDeadzone, type Vec2 } from "../input/gamepadMapping";
import { type NavDir, type NavRect, resolveNav } from "./navResolve";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Gamepad poll period. See the header for why this is not rAF-driven. */
const POLL_MS = 60;
/** Hold-to-repeat: first repeat after this, then every REPEAT_MS. */
const REPEAT_DELAY_MS = 400;
const REPEAT_MS = 140;

/** W3C "standard" mapping: D-pad and the two face buttons we use. */
const BTN_A = 0;
const BTN_B = 1;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

export interface NavFocusOptions {
  /** B / Escape. Backing out of a panel is the menu's business, not ours. */
  onCancel?: () => void;
}

export interface NavFocusHandle {
  /** Focus the first element — call after mount and after a screen change. */
  focusFirst(): void;
  /** Stop listening and drop the poll timer. */
  detach(): void;
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function focusables(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

/**
 * True when the focused control needs left/right for itself. Sliders adjust,
 * text fields move the caret, selects change option — so horizontal is theirs
 * and vertical is always navigation. That split is also what the original's
 * weapons screen does ("Select Hardpoint: up/down"), so it is not a compromise.
 */
function consumesHorizontal(el: Element | null): boolean {
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return (
      el.type === "range" ||
      el.type === "text" ||
      el.type === "password" ||
      el.type === "number" ||
      el.type === "search"
    );
  }
  return false;
}

const KEY_DIRS: Readonly<Record<string, NavDir>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function attachNavFocus(scope: HTMLElement, opts: NavFocusOptions = {}): NavFocusHandle {
  // Scratch reused across polls so the interval allocates nothing of its own.
  const stick: Vec2 = { x: 0, y: 0 };
  let heldDir: NavDir | null = null;
  let nextRepeatAt = 0;
  let prevA = false;
  let prevB = false;

  const move = (dir: NavDir): void => {
    const els = focusables(scope);
    if (els.length === 0) return;
    // Rects are read fresh per move: a re-render or a resize between two key
    // presses would otherwise navigate against a stale layout.
    const rects: NavRect[] = els.map((el) => el.getBoundingClientRect());
    const current = els.indexOf(document.activeElement as HTMLElement);
    const next = resolveNav(rects, current, dir);
    if (next >= 0 && next !== current) els[next].focus();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      opts.onCancel?.();
      return;
    }
    const dir = KEY_DIRS[e.key];
    if (!dir) return;
    if ((dir === "left" || dir === "right") && consumesHorizontal(document.activeElement)) return;
    // Vertical arrows would otherwise scroll the rail out from under the focus.
    e.preventDefault();
    move(dir);
  };

  const poll = (): void => {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]?.connected) {
        pad = pads[i];
        break;
      }
    }
    if (!pad) {
      heldDir = null;
      prevA = false;
      prevB = false;
      return;
    }

    const a = pad.buttons[BTN_A]?.pressed ?? false;
    if (a && !prevA && document.activeElement instanceof HTMLElement) {
      document.activeElement.click();
    }
    prevA = a;

    const b = pad.buttons[BTN_B]?.pressed ?? false;
    if (b && !prevB) opts.onCancel?.();
    prevB = b;

    // D-pad first: it is unambiguous. Fall back to the left stick, taking the
    // dominant axis so a diagonal push picks one direction instead of both.
    let dir: NavDir | null = null;
    if (pad.buttons[DPAD_UP]?.pressed) dir = "up";
    else if (pad.buttons[DPAD_DOWN]?.pressed) dir = "down";
    else if (pad.buttons[DPAD_LEFT]?.pressed) dir = "left";
    else if (pad.buttons[DPAD_RIGHT]?.pressed) dir = "right";
    else if (stickWithDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEADZONE, stick) > 0) {
      if (Math.abs(stick.y) >= Math.abs(stick.x)) dir = stick.y < 0 ? "up" : "down";
      else dir = stick.x < 0 ? "left" : "right";
    }

    if (!dir) {
      heldDir = null;
      return;
    }
    if ((dir === "left" || dir === "right") && consumesHorizontal(document.activeElement)) return;

    const now = performance.now();
    if (dir !== heldDir) {
      heldDir = dir;
      nextRepeatAt = now + REPEAT_DELAY_MS;
      move(dir);
    } else if (now >= nextRepeatAt) {
      nextRepeatAt = now + REPEAT_MS;
      move(dir);
    }
  };

  scope.addEventListener("keydown", onKeyDown);
  const timer = setInterval(poll, POLL_MS);

  return {
    focusFirst(): void {
      const els = focusables(scope);
      if (els.length === 0) return;
      const rects: NavRect[] = els.map((el) => el.getBoundingClientRect());
      const first = resolveNav(rects, -1, "down");
      if (first >= 0) els[first].focus();
    },
    detach(): void {
      scope.removeEventListener("keydown", onKeyDown);
      clearInterval(timer);
    },
  };
}
