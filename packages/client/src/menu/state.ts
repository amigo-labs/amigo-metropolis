// One state object for the whole menu: the original front end's screen
// (frontend/model.ts), the dialog on top of it and the loading screen.
// runMenu (index.ts) owns it and re-renders on change; App is a pure function
// of it, which is what lets `bun test` render the screen to a string.

import type { MatchConfig } from "@metropolis/sim";
import type { FeScreen } from "./frontend/model";
import type { NetLobby } from "./frontend/netLobby";
import type { MenuChoice } from "./routing";
import type { W9Box } from "./win9x/Win9x";

/** A MessageBoxA on top of the screen, and what its answer does. */
export interface MenuBox extends W9Box {
  readonly kind: "box";
  readonly after?: (answer: string) => void;
}

export type MenuDialog =
  | { readonly kind: "options" }
  | { readonly kind: "save" }
  | { readonly kind: "load" }
  | { readonly kind: "host" }
  | { readonly kind: "join" }
  | MenuBox;

export interface MenuLoading {
  /** The row's loading bitmap under /ui/frontend/loading/. */
  readonly file: string;
  /** The bar's fill, 0..200 pixels. */
  readonly fill: number;
}

export interface MenuState {
  screen: FeScreen;
  /** The 640 x 480 screen's scale on this viewport (frontend/stage.ts). */
  scale: number;
  dialog: MenuDialog | null;
  loading: MenuLoading | null;
  /** The networked lobby's START: the session the HOST / JOIN dialog set up. */
  netChoice: MenuChoice | null;
  /** The networked lobby's exchange (netLobby.ts), while the networked set is up. */
  lobby: NetLobby | null;
  /** The agreed config the loading screen is on its way to (online). */
  netStart: MatchConfig | null;
}
