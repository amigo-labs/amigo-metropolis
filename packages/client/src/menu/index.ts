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
import { type GameRules, OptionsDialog } from "./dialogs/OptionsDialog";
import { SaveLoadDialog } from "./dialogs/SaveLoadDialog";
import { FE_PA_MAPS } from "./frontend/frontendData.generated";
import {
  allowedEntries,
  createScreen,
  enterSet,
  type FeAction,
  type FeResult,
  loadoutOfEntries,
  newGameConfig,
  pointerButton,
  pointerMove,
  rowOfMap,
  SND_REFUSED,
  tickMenus,
} from "./frontend/model";
import {
  MOVIE_BOX_FULL,
  type MovieBox,
  type MovieEnd,
  type MoviePlayback,
  movieBoxHelp,
  playMovie,
} from "./frontend/movie";
import { NetLobby } from "./frontend/netLobby";
import { loadConfig, storeConfig } from "./frontend/progress";
import { stageScale, toScreen } from "./frontend/stage";
import { uiSounds } from "./frontend/uiSound";
import { isLocalhost, type MenuChoice } from "./routing";
import type { MenuDialog, MenuState } from "./state";
import { W9MessageBox } from "./win9x/Win9x";

export { finishedMapEndsSession, recordSoloWin } from "./frontend/progress";

/**
 * frame_step_game's finished arm (0x00409762..0x00409794): the map's
 * post-mission movie over the whole width, on a cleared screen, waited out
 * before the session goes on. The front end is down: Space or a left click
 * skips it (0x0045a666, 0x0045a85e).
 */
export function playPostMissionMovie(mapId: string, audio: AudioEngine): Promise<MovieEnd> {
  const row = rowOfMap(mapId);
  if (row < 0) return Promise.resolve("unavailable");
  return playMovie(FE_PA_MAPS[row].postMovie, MOVIE_BOX_FULL, {
    level: audio.getLevels().movies,
    frontEnd: false,
    clearFirst: true,
  }).done;
}
export { createInGameMenu, type InGameMenu } from "./inGame";
// Re-exported so `import { buildModeQuery } from "./menu"` keeps working for
// main.ts and the routing tests. The implementations are pure and live apart
// from the DOM on purpose (docs/specs/ui.md §5).
export {
  apiBase,
  buildModeQuery,
  DIFFICULTY_PLATES,
  difficultyFromParams,
  extraFromParams,
  isLocalhost,
  loadoutFromParams,
  type MenuChoice,
  normalizeRoomCode,
  randomRoomCode,
} from "./routing";

export interface MenuOptions {
  audio: AudioEngine;
  /** A START (or a localhost debug link): main.ts starts the mode in-process. */
  onChoice(
    choice: MenuChoice,
    mapId: string,
    loadout: Loadout,
    difficulty: number,
    rules: GameRules,
  ): void;
  /**
   * HOST / JOIN pressed: open the chosen session under `lobby`, which then
   * reports its progress and the peer's messages (main.ts wires the lockstep).
   */
  openNet(choice: MenuChoice, lobby: NetLobby): void;
  /** START was pressed on `mapId`: the loading screen is up, the arena may load under it. */
  onSelect(mapId: string): void;
  /** PREFERENCES changed the texture option (persisted already). */
  onTexPref(pref: TexPref): void;
  /** The controls screen saved; player 1's table applies at once. */
  onControls(table: Binding[]): void;
  /**
   * The boot's two movies before the screen takes input: `ea_logo` waited out,
   * then `intro` under the front end (game_main 0x0045af0d, 0x0045af46). Only
   * the bare URL's first mount asks for them; `?movies=0` leaves them out.
   */
  bootMovies?: boolean;
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
    lobby: null,
    netStart: null,
  };
  let installPrompt: (() => void) | undefined;
  let raf = 0;
  let last = performance.now();
  let loadingStart = -1;
  let gone = false;
  /** The movie on the screen (frontend/movie.ts): the front end is frozen under it. */
  let movie: MoviePlayback | null = null;

  /**
   * movie_play over the front end: nothing steps or takes a click while it
   * runs; afterwards the screen is drawn again (frontend_first_frame). A movie
   * this browser cannot show is today's refusal, sound 3.
   */
  const showMovie = (
    name: string,
    box: MovieBox,
    then?: (end: MovieEnd) => void,
    frontEnd = true,
    clearFirst = false,
  ): void => {
    if (gone || movie) return;
    const playing = playMovie(name, box, {
      level: opts.audio.getLevels().movies,
      frontEnd,
      clearFirst,
      stopUiSound: () => uiSounds.stop(),
    });
    movie = playing;
    void playing.done.then((end) => {
      if (movie === playing) movie = null;
      if (gone) return;
      if (end === "unavailable" && frontEnd && !then) uiSounds.play(SND_REFUSED);
      last = performance.now();
      draw();
      then?.(end);
    });
  };
  const fullScreen = (): boolean => !!document.fullscreenElement;

  const config = () => state.screen.config;

  const go = (choice: MenuChoice, mapId: string, loadout: Loadout, difficulty: number): void => {
    if (gone) return;
    opts.onChoice(choice, mapId, loadout, difficulty, {
      extraWeapons: config().extraWeapons,
    });
  };

  const pickedMap = (): string => FE_PA_MAPS[config().pick0].mapId;

  const open = (dialog: MenuDialog | null): void => {
    state.dialog = dialog;
    draw();
  };

  /** HOST / JOIN pressed: a lobby on the local config's picks, and main.ts opens it. */
  const connect = (choice: MenuChoice, name: string): NetLobby => {
    const c = config();
    const lobby = new NetLobby({
      name,
      picks: [0, 1].map((p) => ({ loadout: [...c.loadout[p]], difficulty: c.difficulty[p] })),
      mapRow: c.pick0,
      extraWeapons: c.extraWeapons,
    });
    opts.openNet(choice, lobby);
    return lobby;
  };

  /** CANCEL, or the peer gone: frontend_begin(1), back to the offline set. */
  const leaveLobby = (): void => {
    state.lobby?.close();
    state.lobby = null;
    state.netChoice = null;
    enterSet(state.screen, "pa_1p", null);
  };

  /** The lobby's news onto the networked screen (and the two ways out of it). */
  const syncLobby = (): void => {
    const lobby = state.lobby;
    const net = state.screen.net;
    if (!lobby || !net) return;
    const own = lobby.slot;
    const peer = lobby.picks[lobby.peerSlot];
    net.hosting = lobby.hosting;
    net.peer = lobby.peerName;
    net.extraWeapons = lobby.extraWeapons;
    net.peerPicks = { loadout: [...peer.loadout], difficulty: peer.difficulty };
    state.screen.ready = [lobby.ready[0], lobby.ready[1]];
    config().loadout[own] = [...lobby.picks[own].loadout];
    // input.c 0x09: setup choice 0 writes the joiner's pick 0.
    if (!lobby.hosting && lobby.mapRow >= 0 && lobby.mapRow < FE_PA_MAPS.length) {
      config().pick0 = lobby.mapRow;
    }
    if (lobby.phase === "gone" && state.dialog?.kind !== "box") {
      // 0x18: "The other player has dissconnected." (retail's typo), then
      // frontend_begin(1).
      open({
        kind: "box",
        text: "The other player has dissconnected.",
        caption: "Network",
        icon: "stop",
        buttons: ["OK"],
        after: leaveLobby,
      });
      return;
    }
    if (lobby.phase === "started" && lobby.config && !state.netStart) {
      // Both ready: the original's next state 4, the loading screen.
      const cfg = lobby.config;
      state.netStart = cfg;
      const row = rowOfMap(cfg.mapId);
      state.loading = { file: FE_PA_MAPS[row >= 0 ? row : config().pick0].loading, fill: 0 };
      loadingStart = performance.now();
      opts.onSelect(cfg.mapId);
    }
    draw();
  };

  const start = (): void => {
    if (state.screen.net && state.lobby) {
      // The lobby's START (0x00409f60): this side's ready bit, to the peer;
      // both set is the start (the host's begin, netLobby.ts).
      state.lobby.setReady(true);
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
            // The game rules are a preference, not a game: NEW GAME keeps them.
            const rule = config().extraWeapons;
            state.screen.config = newGameConfig();
            state.screen.config.extraWeapons = rule;
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
      // HELP: multibrf.mpg in Precinct Assault (0x00409c4e), 512 x 288.
      case "help":
        showMovie("multibrf.mpg", movieBoxHelp(fullScreen()));
        return;
      // BRIEFING: the row's briefing (0x00409dfa) -- disabled in PA by the gate.
      case "briefing":
        showMovie(FE_PA_MAPS[config().pick0].briefing, movieBoxHelp(fullScreen()));
        return;
      // The film strip: the row's post-mission movie, full width (0x0040ac08).
      case "replay":
        showMovie(FE_PA_MAPS[config().pick0].postMovie, MOVIE_BOX_FULL, undefined, true, true);
        return;
      case "cancel":
        leaveLobby();
        return;
      case "unready":
        state.lobby?.setReady(false);
        return;
      case "net_loadout":
        if (state.lobby) state.lobby.setLoadout(config().loadout[state.lobby.slot]);
        return;
      case "net_difficulty":
        if (state.lobby) state.lobby.setDifficulty(config().difficulty[state.lobby.slot]);
        return;
      case "net_map":
        state.lobby?.setMapRow(config().pick0);
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
  // Both ready is the start: the screen takes no more clicks while the host's
  // START is on its way (the original's next state 4).
  const blocked = (): boolean =>
    movie !== null ||
    state.dialog !== null ||
    state.loading !== null ||
    gone ||
    (state.screen.net !== null && !!state.lobby?.bothReady);
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
        const agreed = state.netStart;
        if (agreed && state.netChoice && state.lobby) {
          const own = state.lobby.slot;
          go(state.netChoice, agreed.mapId, agreed.loadouts[own], agreed.difficulties[own]);
          return;
        }
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
    } else if (!state.dialog && !movie && tickMenus(state.screen, dt)) {
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
          // In the networked lobby the rules are the host's, the joiner's greyed.
          rules: { extraWeapons: state.lobby ? state.lobby.extraWeapons : config().extraWeapons },
          rulesLocked: !!state.lobby && !state.lobby.hosting,
          onRules: (r: GameRules) => {
            if (state.lobby) {
              state.lobby.setExtraWeapons(r.extraWeapons);
              return;
            }
            const c = config();
            c.extraWeapons = r.extraWeapons;
            // A weapon whose switch went off goes back to entry 0.
            for (let p = 0; p < 2; p++) c.loadout[p] = allowedEntries(c.loadout[p], r.extraWeapons);
            storeConfig(c);
            draw();
          },
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
          onConnect: connect,
          onDone: (r) => {
            if (r) {
              // EndDialog(1) once linked: the networked set, the peer named.
              state.netChoice = r.choice;
              state.lobby = r.lobby;
              state.netStart = null;
              enterSet(state.screen, "net_pa", {
                hosting: r.lobby.hosting,
                peer: r.lobby.peerName,
                extraWeapons: r.lobby.extraWeapons,
              });
              r.lobby.onChange = syncLobby;
              state.dialog = null;
              syncLobby();
              return;
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
  if (opts.bootMovies) {
    // ea_logo with the front end down (a left click or Space skips it), then
    // intro with it up (any button skips it), both on a cleared screen.
    showMovie(
      "ea_logo.mpg",
      MOVIE_BOX_FULL,
      () => showMovie("intro.mpg", MOVIE_BOX_FULL, () => {}, true, true),
      false,
      true,
    );
  }

  return {
    offerInstall(prompt: () => void): void {
      installPrompt = prompt;
      draw();
    },
    dismiss(): void {
      if (gone) return;
      gone = true;
      movie?.stop();
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
