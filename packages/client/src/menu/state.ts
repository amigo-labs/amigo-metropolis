// One state object for the whole menu.
//
// This is the fix for the bug the old menu carried: setActive() and
// toggleDrawer() each did panel.replaceChildren() and rebuilt their subtree, so
// every value that lived only in a DOM node — the difficulty slider, the room
// code, the lobby name and password — was destroyed by switching panels. Here
// the values live in state and the panels are a function of it, so switching
// away and back is free.

import { type Loadout, MAP_REGISTRY, normalizeLoadout } from "@metropolis/sim";
import { loadoutFromParams } from "./routing";

/** Which full-screen stage is showing. Weapons is its own screen in the
 *  original too — it needs the width for the hardpoint column and the X1
 *  render, which the rail does not have. */
export type MenuStage = "rail" | "weapons";

export type MenuMode = "solo" | "online" | null;
export type MenuDrawer = "how" | "sound" | "gfx" | null;
/** Hardpoint index: 0 Gun, 1 Heavy, 2 Special — the original's slot order. */
export type Hardpoint = 0 | 1 | 2;

export interface MenuState {
  stage: MenuStage;
  mapId: string;
  loadout: Loadout;
  hardpoint: Hardpoint;
  mode: MenuMode;
  drawer: MenuDrawer;
  /** Warden skill. Survives leaving and re-entering the solo panel. */
  difficulty: number;
  roomCode: string;
  roomError: string;
  lobbyName: string;
  lobbyPassword: string;
  lobbyPublic: boolean;
}

export function initialMenuState(initialLoadout?: Loadout): MenuState {
  // Pre-select a ?map= already on the URL so arena deep links keep their pick
  // through the menu; unknown ids quietly fall back to the first arena (which
  // is also main.ts's boot backdrop, so no initial preview swap is needed).
  const urlMapId = new URLSearchParams(location.search).get("map");
  const mapId = MAP_REGISTRY.some((m) => m.id === urlMapId)
    ? (urlMapId as string)
    : MAP_REGISTRY[0].id;
  return {
    stage: "rail",
    mapId,
    loadout: normalizeLoadout(initialLoadout),
    hardpoint: 0,
    mode: null,
    drawer: null,
    difficulty: 4,
    roomCode: "",
    roomError: "",
    lobbyName: "",
    lobbyPassword: "",
    lobbyPublic: true,
  };
}

/** Reads ?gun=&heavy=&special= for callers that boot straight into the menu. */
export function loadoutFromLocation(): Loadout {
  return loadoutFromParams(new URLSearchParams(location.search));
}
