// The original's front end (PLAN.md Phase 14, wave 7; docs/specs/ui.md).
//
// A stranger opens the bare URL and sees Future Cop's own screen: the
// Precinct Assault map, NEW GAME ... QUIT, the loadout column, the Sky
// Captain's level and taunt, START. Deep links (?warden=4, ?online=CODE,
// ?play, ?debug) skip it entirely, so shareable URLs and the test harnesses
// are untouched (main.ts `explicitMode`).
//
// runMenu owns the state: the screen model (frontend/model.ts, pure), the
// dialog on top and the loading screen. The mouse drives it as it drives the
// original -- there is no keyboard or gamepad navigation layer. A START emits a
// MenuChoice through opts.onChoice once the loading screen's bar is full;
// main.ts starts the mode in-process and pushState()s its deep link.

import type { Loadout } from "@metropolis/sim";
import { type ComponentChildren, h, render } from "preact";
import type { AudioEngine } from "../audio/engine";
import type { Binding } from "../input/bindings";
import type { TexPref } from "../render/texVariants";
import "../ui/cockpit.css";
import "./menu.css";
import { App } from "./App";
import { HostDialog, JoinDialog } from "./dialogs/NetDialogs";
import { OptionsDialog } from "./dialogs/OptionsDialog";
import { SaveLoadDialog } from "./dialogs/SaveLoadDialog";
import { FE_PA_MAPS } from "./frontend/frontendData.generated";
import {
  createScreen,
  enterSet,
  type FeAction,
  type FeResult,
  loadoutOfEntries,
  newGameConfig,
  pointerButton,
  pointerMove,
  tickMenus,
} from "./frontend/model";
import { loadConfig, storeConfig } from "./frontend/progress";
import { stageScale, toScreen } from "./frontend/stage";
import { uiSounds } from "./frontend/uiSound";
import { isLocalhost, type MenuChoice } from "./routing";
import type { MenuDialog, MenuState } from "./state";
import { W9MessageBox } from "./win9x/Win9x";

export { recordSoloWin } from "./frontend/progress";
export { createInGameMenu, type InGameMenu } from "./inGame";
// Re-exported so `import { buildModeQuery } from "./menu"` keeps working for
// main.ts and the routing tests. The implementations are pure and live apart
// from the DOM on purpose (docs/specs/ui.md §5).
export {
  apiBase,
  buildModeQuery,
  DIFFICULTY_PLATES,
  difficultyFromParams,
  isLocalhost,
  loadoutFromParams,
  type MenuChoice,
  normalizeRoomCode,
  randomRoomCode,
} from "./routing";

export interface MenuOptions {
  audio: AudioEngine;
  /** A START (or a localhost debug link): main.ts starts the mode in-process. */
  onChoice(choice: MenuChoice, mapId: string, loadout: Loadout, difficulty: number): void;
  /** START was pressed on `mapId`: the loading screen is up, the arena may load under it. */
  onSelect(mapId: string): void;
  /** PREFERENCES changed the texture option (persisted already). */
  onTexPref(pref: TexPref): void;
  /** The controls screen saved; player 1's table applies at once. */
  onControls(table: Binding[]): void;
}

/** Handle returned by runMenu so a late `beforeinstallprompt` can add Install. */
export interface MenuHandle {
  /** Reveals the Install link and wires it to `prompt`. */
  offerInstall(prompt: () => void): void;
  /** Fades the menu out and removes it from the DOM. */
  dismiss(): void;
}

/**
 * How long the loading screen's bar takes to fill. The original's follows the
 * container read (res_stream_progress); Metropolis streams its arena, so the
 * bar is timed (fcop-fidelity.md F18).
 */
export const LOADING_MS = 1000;
/** The full bar holds this long before the match. */
export const LOADING_HOLD_MS = 150;

/** The bar's fill at `elapsed` ms: progress in 1024ths, times 200 / 1024 (launch.c). */
export function loadingFill(elapsedMs: number): number {
  const progress = Math.floor(Math.min(1, Math.max(0, elapsedMs / LOADING_MS)) * 1024);
  return Math.floor((progress * 200) / 1024);
}

/** Builds and mounts the front end. A START emits onChoice. */
export function runMenu(opts: MenuOptions): MenuHandle {
  const root = document.createElement("div");
  root.className = "menu-root";
  document.body.appendChild(root);
  uiSounds.preload();

  const state: MenuState = {
    screen: createScreen(loadConfig()),
    scale: stageScale(innerWidth, innerHeight),
    dialog: null,
    loading: null,
    netChoice: null,
  };
  let installPrompt: (() => void) | undefined;
  let raf = 0;
  let last = performance.now();
  let loadingStart = -1;
  let gone = false;

  const config = () => state.screen.config;

  const go = (choice: MenuChoice, mapId: string, loadout: Loadout, difficulty: number): void => {
    if (gone) return;
    opts.onChoice(choice, mapId, loadout, difficulty);
  };

  const pickedMap = (): string => FE_PA_MAPS[config().pick0].mapId;

  const open = (dialog: MenuDialog | null): void => {
    state.dialog = dialog;
    draw();
  };

  const start = (): void => {
    if (state.screen.net && state.netChoice) {
      // The lobby's START: Metropolis connects here (the original's ready
      // exchange is not modelled, fcop-fidelity.md F9). The host's map wins.
      go(state.netChoice, pickedMap(), loadoutOfEntries([0, 0, 0]), 1);
      return;
    }
    const row = config().pick0;
    state.loading = { file: FE_PA_MAPS[row].loading, fill: 0 };
    loadingStart = performance.now();
    opts.onSelect(FE_PA_MAPS[row].mapId);
    draw();
  };

  const act = (a: FeAction): void => {
    switch (a) {
      case "new_game":
        open({
          kind: "box",
          text: "Are You Sure You Want To Start A New Game?",
          caption: "New Game",
          icon: "none",
          buttons: ["Yes", "No"],
          after: (answer) => {
            if (answer !== "Yes") return;
            state.screen.config = newGameConfig();
            storeConfig(state.screen.config);
          },
        });
        return;
      case "load_game":
        open({ kind: "load" });
        return;
      case "save_game":
        open({ kind: "save" });
        return;
      case "host":
        open({ kind: "host" });
        return;
      case "join":
        open({ kind: "join" });
        return;
      case "options":
        open({ kind: "options" });
        return;
      case "start":
        start();
        return;
      case "cancel":
        enterSet(state.screen, "pa_1p", null);
        state.netChoice = null;
        return;
      default:
        // The refused buttons have played their sound (model.ts).
        return;
    }
  };

  const handle = (r: FeResult): void => {
    uiSounds.playAll(r.sounds);
    for (const a of r.actions) act(a);
    if (r.redraw || r.actions.length > 0) {
      if (!state.screen.net) storeConfig(state.screen.config);
      draw();
    }
  };

  const stageXY = (e: PointerEvent): [number, number] => {
    const stage = root.querySelector("[data-stage]") as HTMLElement | null;
    if (!stage) return [-1, -1];
    const r = stage.getBoundingClientRect();
    return toScreen(e.clientX, e.clientY, r.left, r.top, state.scale);
  };
  const blocked = (): boolean => state.dialog !== null || state.loading !== null || gone;
  const MASKS = [1, 2, 4];

  const onMove = (e: PointerEvent): void => {
    if (blocked()) return;
    const [x, y] = stageXY(e);
    handle(pointerMove(state.screen, x, y));
  };
  const onDown = (e: PointerEvent): void => {
    if (blocked()) return;
    if ((e.target as Element | null)?.closest?.(".fe-platform")) return;
    e.preventDefault();
    const [x, y] = stageXY(e);
    handle(pointerButton(state.screen, x, y, MASKS[e.button] ?? 1, true));
  };
  const onUp = (e: PointerEvent): void => {
    if (gone) return;
    if (blocked()) {
      // A release while a dialog is up still lets go of the button.
      state.screen.buttons &= ~(MASKS[e.button] ?? 1);
      return;
    }
    const [x, y] = stageXY(e);
    handle(pointerButton(state.screen, x, y, MASKS[e.button] ?? 1, false));
  };
  const onContext = (e: Event): void => e.preventDefault();
  const onResize = (): void => {
    state.scale = stageScale(innerWidth, innerHeight);
    draw();
  };
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerdown", onDown);
  addEventListener("pointerup", onUp);
  root.addEventListener("contextmenu", onContext);
  addEventListener("resize", onResize);

  // The frontend's step: the animated menus' one countdown, and the loading bar.
  const step = (now: number): void => {
    if (gone) return;
    const dt = Math.min(250, now - last);
    last = now;
    let redraw = false;
    if (state.loading) {
      const elapsed = now - loadingStart;
      const fill = loadingFill(elapsed);
      if (fill !== state.loading.fill) {
        state.loading = { ...state.loading, fill };
        redraw = true;
      }
      if (elapsed >= LOADING_MS + LOADING_HOLD_MS) {
        state.loading = { ...state.loading, fill: 200 };
        const c = config();
        const row = c.pick0;
        go(
          { mode: "warden", difficulty: c.subpick[row] + 1 },
          FE_PA_MAPS[row].mapId,
          loadoutOfEntries(c.loadout[0]),
          c.difficulty[0],
        );
        return;
      }
    } else if (!state.dialog && tickMenus(state.screen, dt)) {
      redraw = true;
    }
    if (redraw) draw();
    raf = requestAnimationFrame(step);
  };

  function overlay(): ComponentChildren {
    const d = state.dialog;
    if (!d) return null;
    const close = (): void => open(null);
    switch (d.kind) {
      case "options":
        return h(OptionsDialog, {
          audio: opts.audio,
          onClose: close,
          onTexPref: opts.onTexPref,
          onControls: (t: Binding[][]) => opts.onControls(t[0]),
        });
      case "save":
      case "load":
        return h(SaveLoadDialog, {
          mode: d.kind,
          config: state.screen.config,
          onDone: (res) => {
            if (res?.loaded) {
              state.screen.config = res.loaded;
              storeConfig(res.loaded);
            }
            open(res?.box ? { kind: "box", ...res.box } : null);
          },
        });
      case "host":
      case "join":
        return h(d.kind === "host" ? HostDialog : JoinDialog, {
          onDone: (r) => {
            if (r) {
              state.netChoice = r.choice;
              enterSet(state.screen, "net_pa", { hosting: r.hosting, peer: r.peer });
            }
            open(null);
          },
        });
      case "box":
        return h(W9MessageBox, {
          text: d.text,
          caption: d.caption,
          icon: d.icon,
          buttons: d.buttons,
          onAnswer: (answer: string) => {
            open(null);
            d.after?.(answer);
            draw();
          },
        });
    }
  }

  function draw(): void {
    if (gone) return;
    render(
      App({
        state,
        installPrompt,
        showDebugModes: isLocalhost(),
        onDebug: (mode) => {
          const c = config();
          go({ mode }, pickedMap(), loadoutOfEntries(c.loadout[0]), c.difficulty[0]);
        },
        overlay: overlay(),
      }),
      root,
    );
  }

  draw();
  raf = requestAnimationFrame(step);

  return {
    offerInstall(prompt: () => void): void {
      installPrompt = prompt;
      draw();
    },
    dismiss(): void {
      if (gone) return;
      gone = true;
      cancelAnimationFrame(raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerdown", onDown);
      removeEventListener("pointerup", onUp);
      root.removeEventListener("contextmenu", onContext);
      removeEventListener("resize", onResize);
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
