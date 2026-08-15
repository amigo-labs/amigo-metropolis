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

import type { Loadout } from "@metropolis/sim";
import { render } from "preact";
import type { AudioEngine } from "../audio/engine";
import type { TexPref } from "../render/texVariants";
import { attachNavFocus, type NavFocusHandle } from "../ui/navFocus";
import "../ui/cockpit.css";
import "./menu.css";
import { App } from "./App";
import { isLocalhost, type MenuChoice } from "./routing";
import { initialMenuState, type MenuState, mapIdFromParams } from "./state";

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
   *  `loadout` is the gun/heavy/special kit from the console strip. */
  onChoice(choice: MenuChoice, mapId: string, loadout: Loadout): void;
  /** Called whenever the arena selection changes so the live 3D backdrop can
   *  preview the picked arena. `mapId` is the newly selected arena. */
  onSelect(mapId: string): void;
  /** Called when the Graphics drawer changes the texture preference so main.ts
   *  can apply it to the live arena immediately (persistence happens there). */
  onTexPref(pref: TexPref): void;
  /** Called when the Graphics drawer toggles bloom (persisted by the drawer). */
  onBloomPref(enabled: boolean): void;
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

  let state: MenuState = initialMenuState(
    opts.initialLoadout,
    mapIdFromParams(new URLSearchParams(location.search)),
  );
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
    // A re-render that removes the focused control (panel/drawer swap) drops
    // focus to <body>; without a focused element the keyboard/gamepad nav is
    // stranded (ui.md §4 — the visible ring is functional, not decoration).
    // Only restore when focus was INSIDE the menu before the redraw: macOS
    // Safari/Firefox never focus a clicked <button>, so "activeElement is
    // <body>" alone would steal focus to the first control on every click.
    const hadFocus = root.contains(document.activeElement);
    state = { ...state, ...patch };
    draw();
    if (hadFocus && !root.contains(document.activeElement)) {
      nav?.focusFirst();
    }
  }

  const onCancel = (): void => {
    if (state.drawer) update({ drawer: null });
    else if (state.mode) update({ mode: null });
  };

  function draw(): void {
    render(
      App({
        state,
        audio: opts.audio,
        installPrompt,
        showDebugModes: isLocalhost(),
        update,
        go,
        onSelect: selectArena,
        onTexPref: opts.onTexPref,
        onBloomPref: opts.onBloomPref,
      }),
      root,
    );
  }

  draw();
  nav = attachNavFocus(root, { onCancel });
  // Give keyboard/gamepad users a starting point: without this the first
  // arrow press navigates from <body> and no ring is visible (ui.md §4).
  nav.focusFirst();

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
