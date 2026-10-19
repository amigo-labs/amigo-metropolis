// The original's HUD is laid out for a 640 x 480 screen (RE hud.json: flat rects
// in 640 units, text in a 320 x 240 space doubled, quads in a 2560 x 1920 raw
// space). Metropolis draws it on any window by one rule:
//
//   scale    s = min(width / 640, height / 480) — the 4:3 box that fits
//   x        left half of the 640 space (x < 320) anchors to the left edge (x·s);
//            right half to the right edge (width - (640 - x)·s)
//   y        top half anchors to the top (y·s); bottom half to the bottom
//            (height - (480 - y)·s)
//
// On a 4:3 window that is the original's screen exactly. On a wider one the HUD
// keeps its height and its two columns move out to the edges with the wider
// view (the radar and the weapons stay bottom-/top-left, the score plates and
// the opponent's gauge top-/bottom-right), never stretching. On a narrower one
// the rows do the same vertically.
//
// Each element is its own canvas, drawn in 640 units at an integer multiple of
// the original's pixels (`k` = s rounded, at least 1) with smoothing off, so the
// font and the atlas texels scale as crisp blocks; CSS takes the last non-integer
// step. Raw DOM, written on layout and on change only (docs/specs/ui.md §1).

export const HUD_W = 640;
export const HUD_H = 480;

/** The HUD's scale in a `vw` x `vh` viewport. */
export function hudScale(vw: number, vh: number): number {
  return Math.min(vw / HUD_W, vh / HUD_H);
}

/** A placed rect, CSS px. */
export interface PlacedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Places the 640-space rect (x, y, w, h) in a `vw` x `vh` viewport (rule above). */
export function placeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  out: PlacedRect,
): PlacedRect {
  const s = hudScale(vw, vh);
  out.left = x < HUD_W / 2 ? x * s : vw - (HUD_W - x) * s;
  out.top = y < HUD_H / 2 ? y * s : vh - (HUD_H - y) * s;
  out.width = w * s;
  out.height = h * s;
  return out;
}

/** The backing store's multiple of the original's pixels at scale `s`. */
export function pixelMultiple(s: number): number {
  return Math.max(1, Math.round(s));
}

/** One HUD canvas at a fixed 640-space rect. */
export interface HudCanvas {
  readonly el: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** The rect in 640 units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Current backing multiple; drawing is in 640 units (the context is scaled). */
  k: number;
  /** Set by place() when the backing store was resized and must be redrawn. */
  dirty: boolean;
  /** Re-places the canvas for a viewport (CSS px, origin the viewport's). */
  place(vw: number, vh: number): void;
  /** Clears the whole canvas, drawing at its own origin (0, 0 = the rect's corner). */
  clear(): void;
  /** Clears the whole canvas, drawing in the 640 space (x, y as the original's). */
  begin(): void;
}

const scratch: PlacedRect = { left: 0, top: 0, width: 0, height: 0 };

/** Builds a canvas for the 640-space rect and appends it to `parent`. */
export function hudCanvas(
  parent: HTMLElement,
  x: number,
  y: number,
  w: number,
  h: number,
  className = "",
): HudCanvas {
  const el = document.createElement("canvas");
  el.className = `mhud-c ${className}`.trim();
  el.width = w;
  el.height = h;
  parent.appendChild(el);
  const ctx = el.getContext("2d") as CanvasRenderingContext2D;
  const c: HudCanvas = {
    el,
    ctx,
    x,
    y,
    w,
    h,
    k: 1,
    dirty: true,
    place(vw, vh) {
      placeRect(x, y, w, h, vw, vh, scratch);
      const st = el.style;
      st.left = `${Math.round(scratch.left)}px`;
      st.top = `${Math.round(scratch.top)}px`;
      st.width = `${Math.round(scratch.width)}px`;
      st.height = `${Math.round(scratch.height)}px`;
      const k = pixelMultiple(hudScale(vw, vh));
      if (k !== c.k || el.width !== w * k) {
        c.k = k;
        el.width = w * k;
        el.height = h * k;
        c.dirty = true;
      }
      ctx.setTransform(c.k, 0, 0, c.k, 0, 0);
      ctx.imageSmoothingEnabled = false;
    },
    clear() {
      ctx.setTransform(c.k, 0, 0, c.k, 0, 0);
      ctx.clearRect(0, 0, w, h);
    },
    begin() {
      ctx.setTransform(c.k, 0, 0, c.k, -x * c.k, -y * c.k);
      ctx.clearRect(x, y, w, h);
    },
  };
  return c;
}
