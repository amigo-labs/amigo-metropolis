// Title screen + menu flow (PLAN Phase 7; ported to Preact in the UI pass).
//
// A stranger opens the bare URL and sees the title, the objective, a live 3D
// arena backdrop, and one click per mode. Deep links (?warden=4, ?online=CODE,
// ?play, ?debug) skip the menu entirely, so shareable URLs and the test
// harnesses are untouched (see main.ts `explicitMode`).
//
// Choosing a mode emits a MenuChoice through opts.onChoice; main.ts starts the
// picked mode in-process (no reload — the live menu world morphs into the
// match) and pushState()s the matching deep-link query. This file stays free of
// any renderer/sim coupling beyond static map metadata.
//
// runMenu owns the state and re-renders on change, rather than letting App hold
// it in a hook: the public API here is imperative (offerInstall, dismiss), and
// a plain object plus a render() call reaches that from the outside without
// smuggling a ref out of the tree. It also keeps App a pure function of its
// props, which is what lets `bun test` render screens to a string.

import { type Loadout, normalizeLoadout } from "@metropolis/sim";
import { render } from "preact";
import type { AudioEngine } from "../audio/engine";
import type { TexPref } from "../render/texVariants";
import { attachNavFocus, type NavFocusHandle } from "../ui/navFocus";
import "../ui/cockpit.css";
import "./menu.css";
import { App } from "./App";
import { cycleHardpoint, stepHardpoint } from "./hardpoints";
import type { MenuChoice } from "./routing";
import { initialMenuState, type MenuState } from "./state";

// Re-exported so `import { buildModeQuery } from "./menu"` keeps working for
// main.ts and the routing tests. The implementations are pure and live apart
// from the DOM on purpose (docs/specs/ui.md §5).
export {
  apiBase,
  buildModeQuery,
  isLocalhost,
  loadoutFromParams,
  type MenuChoice,
  normalizeRoomCode,
  randomRoomCode,
} from "./routing";

export interface MenuOptions {
  audio: AudioEngine;
  /** Called once when the player picks a mode; main.ts starts it in-process.
   *  `mapId` is the arena picked in the menu's persistent arena gallery.
   *  `loadout` is the gun/heavy/special kit (Future Cop weapons screen). */
  onChoice(choice: MenuChoice, mapId: string, loadout: Loadout): void;
  /** Called whenever the arena selection changes so the live 3D backdrop can
   *  preview the picked arena. `mapId` is the newly selected arena. */
  onSelect(mapId: string): void;
  /** Called when the Graphics drawer changes the texture preference so main.ts
   *  can apply it to the live arena immediately (persistence happens there). */
  onTexPref(pref: TexPref): void;
  /** Optional initial loadout (e.g. from ?gun= URL). */
  initialLoadout?: Loadout;
}

/** Handle returned by runMenu so a late `beforeinstallprompt` can add Install. */
export interface MenuHandle {
  /** Reveals the Install button and wires it to `prompt`. */
  offerInstall(prompt: () => void): void;
  /** Fades the menu out and removes it from the DOM. */
  dismiss(): void;
}

/** Builds and mounts the title/menu overlay. A mode choice emits onChoice. */
export function runMenu(opts: MenuOptions): MenuHandle {
  const root = document.createElement("div");
  root.className = "menu-root";
  document.body.appendChild(root);

  let state: MenuState = initialMenuState(opts.initialLoadout);
  let installPrompt: (() => void) | undefined;
  let nav: NavFocusHandle | undefined;

  const go = (choice: MenuChoice): void => {
    opts.onChoice(choice, state.mapId, { ...state.loadout });
  };

  const selectArena = (mapId: string): void => {
    if (mapId === state.mapId) return;
    update({ mapId });
    opts.onSelect(mapId);
  };

  function update(patch: Partial<MenuState>): void {
    const stageChanged = patch.stage !== undefined && patch.stage !== state.stage;
    state = { ...state, ...patch };
    draw();
    // Switching stage replaces the whole tree, so whatever had focus is gone
    // and focus has fallen to <body>. Put it back inside the new screen or the
    // pad appears dead until the player reaches for the mouse.
    if (stageChanged) nav?.focusFirst();
  }

  /**
   * Left/right on the weapons screen cycles the fitted weapon instead of moving
   * focus. Claimed here rather than in a keydown handler because gamepad
   * directions never become DOM events — navFocus offers both paths to the same
   * hook (docs/specs/ui.md §4).
   */
  const onDirection = (dir: "up" | "down" | "left" | "right"): boolean => {
    if (state.stage !== "weapons") return false;
    if (dir === "left" || dir === "right") {
      update({ loadout: cycleHardpoint(state.loadout, state.hardpoint, dir === "left" ? -1 : 1) });
      return true;
    }
    // Vertical still moves focus, and each hardpoint box syncs state.hardpoint
    // on focus — but update it here too so a move is never a frame behind.
    update({ hardpoint: stepHardpoint(state.hardpoint, dir === "up" ? -1 : 1) });
    return false;
  };

  const onCancel = (): void => {
    if (state.stage === "weapons") update({ stage: "rail" });
    else if (state.drawer) update({ drawer: null });
    else if (state.mode) update({ mode: null });
  };

  function draw(): void {
    render(
      App({
        state,
        audio: opts.audio,
        installPrompt,
        update,
        go,
        onSelect: selectArena,
        onTexPref: opts.onTexPref,
      }),
      root,
    );
  }

  draw();
  nav = attachNavFocus(root, { onCancel, onDirection });

  return {
    offerInstall(prompt: () => void): void {
      installPrompt = prompt;
      draw();
    },
    dismiss(): void {
      nav?.detach();
      nav = undefined;
      root.classList.add("is-leaving");
      let removed = false;
      const remove = (): void => {
        if (removed) return;
        removed = true;
        // Unmount before dropping the node so effects (the lobby fetch) tear
        // down instead of resolving into a detached tree.
        render(null, root);
        root.remove();
      };
      // transitionend can be swallowed (display changes, reduced motion) — the
      // timeout guarantees the DOM never keeps a dead overlay around.
      root.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 500);
    },
  };
}

/** Kept for callers that want the normalized kit without mounting the menu. */
export function normalizeMenuLoadout(loadout?: Loadout): Loadout {
  return normalizeLoadout(loadout);
}
