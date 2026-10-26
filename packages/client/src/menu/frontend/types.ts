// The shapes of the original front end's data (frontendData.generated.ts, from
// the RE repo's extracted/frontend/*.json; docs/formats/presentation.md there).

/** One febmp picture: game id `id` is the file bmp{id-1}.png under /ui/frontend/. */
export interface FePicture {
  readonly id: number;
  readonly file: string;
  readonly w: number;
  readonly h: number;
  readonly label: string;
}

/**
 * One panel. Kind 0 lights while held and fires on the release over it; kind 4
 * is a radio button, firing on the press and staying lit (screens.json
 * `conventions.panel_kinds`). Flags: bit 0 held/lit, bit 1 the pointer over
 * it, bit 2 hidden (the click refuses it), bit 3 disabled (not drawn).
 */
export interface FePanel {
  readonly ordinal: number;
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly plain: FePicture | null;
  readonly pressed: FePicture | null;
  readonly hover: FePicture | null;
  readonly flags: number;
  readonly repaint: boolean;
  /** The retail callback's name, which the front end dispatches on. */
  readonly callback: string;
  readonly src: string;
}

/** A menu: entry `selected` drawn at (x, y); flag bit 1 animates, bit 2 locks (hides). */
export interface FeMenu {
  readonly x: number;
  readonly y: number;
  readonly selected: number;
  readonly flags: number;
  readonly animated: boolean;
  readonly entries: readonly FePicture[];
}

export interface FeGroup {
  readonly key: string;
  readonly role: string;
  readonly origin: readonly [number, number];
  readonly backdrop: FePicture | null;
  readonly extra: { readonly name: string; readonly src: string } | null;
  readonly panels: readonly FePanel[];
  readonly menus: readonly FeMenu[];
}

/** One Precinct Assault map button: its row, title plate and loading screen. */
export interface FeMapButton {
  readonly ordinal: number;
  readonly container: string;
  readonly name: string;
  readonly mapId: string;
  readonly titlePlate: FePicture;
  /** File under /ui/frontend/loading/. */
  readonly loading: string;
  readonly briefing: string;
  readonly postMovie: string;
}

export interface FeLoadoutEntry {
  readonly entry: number;
  readonly code: string;
  readonly weapon: string;
  readonly availableOutsideCampaign: boolean;
  readonly needsOptionByte: boolean;
}

export interface FeLoadout {
  readonly slots: readonly {
    readonly slot: number;
    readonly role: string;
    readonly entries: readonly FeLoadoutEntry[];
  }[];
  readonly availabilityOutsideCampaign: readonly number[];
  readonly default: readonly number[];
  readonly skipRule: string;
  readonly timerTicks: number;
  readonly src: readonly string[];
}

/** A dialog control: the template's class, geometry in DLU and its text. */
export interface FeControl {
  readonly id: number;
  readonly cls: string;
  readonly dlu: readonly [number, number, number, number];
  readonly text: string | null;
  readonly styles: readonly string[];
}

export interface FeDialog {
  readonly id: number;
  readonly what: string;
  readonly procedure: string | null;
  readonly dlu: readonly [number, number, number, number];
  readonly font: { readonly face: string; readonly size: number };
  readonly styles: readonly string[];
  /** The template's extended style; 0x200 is WS_EX_CLIENTEDGE. */
  readonly exStyle: number;
  readonly caption: string | null;
  readonly controls: readonly FeControl[];
}

export interface FeUiSound {
  readonly slot: number;
  readonly wave: string;
  readonly url: string;
  readonly playsWhen: readonly string[];
  readonly src: readonly string[];
}

/** One of the original's movies, transcoded for the browser (gen:movies). */
export interface FeMovie {
  /** The file under FE_MOVIE_BASE. */
  readonly file: string;
  /** The original's picture size and rate; the player stretches it to its rectangle. */
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds: number;
  readonly bytes: number;
  readonly sha256: string;
  /** The MIME type with its codecs, for canPlayType. */
  readonly type: string;
  /** The original it was made from (the RE's fixtures/movies/manifest.json). */
  readonly source: { readonly name: string; readonly bytes: number; readonly sha256: string };
}
