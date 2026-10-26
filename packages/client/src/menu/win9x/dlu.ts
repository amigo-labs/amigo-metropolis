// Dialog units to pixels, as Windows' MapDialogRect does it, and the window
// metrics a Windows 95/98 dialog frame adds. Pure, so `bun test` checks it.
//
// A dialog template's geometry is in dialog units: x px = dlu * cx / 4,
// y px = dlu * cy / 8, where (cx, cy) are the dialog font's base units -- the
// average width of its letters and its height (dialogs.json `_about`).
// MapDialogRect converts each edge with MulDiv, which rounds to nearest.

export interface BaseUnits {
  readonly cx: number;
  readonly cy: number;
  /** The CSS that stands in for the dialog font. */
  readonly css: string;
}

/**
 * Base units of the four faces the templates name, at 96 dpi. MS Sans Serif 8
 * (and MS Shell Dlg 8, which Windows 9x maps to it) is the well-known 6 x 13.
 * Small Fonts 7 and Courier 10 are estimates from those raster faces' cells
 * (fcop-fidelity.md F14): the retail metrics are not measured, and the
 * executable does not carry them -- USER32 takes them from the system's raster
 * font files when it builds the dialog (RE M3-OQ).
 */
export const FONT_BASE_UNITS: Readonly<Record<string, BaseUnits>> = {
  "MS Sans Serif 8": {
    cx: 6,
    cy: 13,
    css: '11px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Arial, sans-serif',
  },
  "MS Shell Dlg 8": {
    cx: 6,
    cy: 13,
    css: '11px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Arial, sans-serif',
  },
  "Small Fonts 7": {
    cx: 5,
    cy: 11,
    css: '9px "Small Fonts", Tahoma, Verdana, Arial, sans-serif',
  },
  "Courier 10": { cx: 8, cy: 13, css: '13px Courier, "Courier New", monospace' },
};

export function baseUnitsOf(font: { readonly face: string; readonly size: number }): BaseUnits {
  return FONT_BASE_UNITS[`${font.face} ${font.size}`] ?? FONT_BASE_UNITS["MS Sans Serif 8"];
}

/** Windows' MulDiv for the non-negative values a template holds: a * b / c, rounded. */
export function mulDiv(a: number, b: number, c: number): number {
  const p = a * b;
  return p >= 0 ? Math.floor((2 * p + c) / (2 * c)) : -Math.floor((-2 * p + c) / (2 * c));
}

export interface PxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** MapDialogRect over a template rectangle [x, y, cx, cy]. */
export function mapDialogRect(dlu: readonly number[], bu: BaseUnits): PxRect {
  const [x, y, w, h] = dlu;
  const left = mulDiv(x, bu.cx, 4);
  const top = mulDiv(y, bu.cy, 8);
  const right = mulDiv(x + w, bu.cx, 4);
  const bottom = mulDiv(y + h, bu.cy, 8);
  return { left, top, width: right - left, height: bottom - top };
}

/** SM_CXDLGFRAME / SM_CYDLGFRAME: DS_MODALFRAME's 3D frame, each side. */
export const DLG_FRAME = 3;
/** SM_CYCAPTION at small fonts: the caption bar, its bottom line included. */
export const CAPTION_HEIGHT = 19;
/** WS_EX_CLIENTEDGE's sunken edge, each side. */
export const CLIENT_EDGE = 2;

/** The window a template makes: its client size plus the frame, caption and edge. */
export function dialogWindowSize(
  dlu: readonly number[],
  bu: BaseUnits,
  caption: boolean,
  clientEdge: boolean,
): { width: number; height: number; client: PxRect } {
  const client = mapDialogRect([0, 0, dlu[2], dlu[3]], bu);
  const edge = clientEdge ? CLIENT_EDGE : 0;
  return {
    width: client.width + 2 * (DLG_FRAME + edge),
    height: client.height + 2 * (DLG_FRAME + edge) + (caption ? CAPTION_HEIGHT : 0),
    client,
  };
}

/** DS_CENTER: the window centred on the 640 x 480 screen. */
export function centreOnScreen(width: number, height: number): { left: number; top: number } {
  return { left: Math.floor((640 - width) / 2), top: Math.floor((480 - height) / 2) };
}
