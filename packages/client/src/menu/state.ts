// One state object for the whole menu.
//
// This is the fix for the bug the old menu carried: setActive() and
// toggleDrawer() each did panel.replaceChildren() and rebuilt their subtree, so
// every value that lived only in a DOM node — the difficulty slider, the room
// code, the lobby name and password — was destroyed by switching panels. Here
// the values live in state and the panels are a function of it, so switching
// away and back is free.

import {
  DIFFICULTY_NORMAL,
  type Loadout,
  MAP_REGISTRY,
  normalizeDifficulty,
  normalizeLoadout,
} from "@metropolis/sim";

export type MenuMode = "solo" | "online" | null;
/** Console drawers: how-to, the controls, and preferences (sound + graphics). */
export type MenuDrawer = "how" | "controls" | "prefs" | null;
/** Hardpoint index: 0 Gun, 1 Heavy, 2 Special — the original's slot order. */
export type Hardpoint = 0 | 1 | 2;

export interface MenuState {
  mapId: string;
  loadout: Loadout;
  mode: MenuMode;
  drawer: MenuDrawer;
  /** Warden skill. Survives leaving and re-entering the solo panel. */
  difficulty: number;
  /**
   * The player's own difficulty, the original's HARD / NORMAL / EASY word
   * (0 / 1 / 2; DIFFICULTY_PLATES). NORMAL by default, as the original's.
   */
  playerDifficulty: number;
  roomCode: string;
  roomError: string;
  lobbyName: string;
  lobbyPassword: string;
  lobbyPublic: boolean;
}

/**
 * Resolves the arena a deep link asked for, so ?map= keeps its pick through the
 * menu. Unknown ids quietly fall back to the first arena — which is also
 * main.ts's boot backdrop, so no initial preview swap is needed.
 *
 * Separate from initialMenuState because reading the URL is the one thing that
 * would stop the state from being constructible in a test.
 */
export function mapIdFromParams(params: URLSearchParams): string {
  const id = params.get("map");
  return MAP_REGISTRY.some((m) => m.id === id) ? (id as string) : MAP_REGISTRY[0].id;
}

export function initialMenuState(
  initialLoadout?: Loadout,
  mapId?: string,
  playerDifficulty: number = DIFFICULTY_NORMAL,
): MenuState {
  return {
    mapId: mapId ?? MAP_REGISTRY[0].id,
    loadout: normalizeLoadout(initialLoadout),
    mode: null,
    drawer: null,
    difficulty: 4,
    playerDifficulty: normalizeDifficulty(playerDifficulty),
    roomCode: "",
    roomError: "",
    lobbyName: "",
    lobbyPassword: "",
    lobbyPublic: true,
  };
}
