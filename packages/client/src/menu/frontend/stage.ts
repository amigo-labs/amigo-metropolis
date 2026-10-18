// The original draws its front end in a 640 x 480 mode; Metropolis draws that
// screen on a 640 x 480 stage scaled to the viewport, letterboxed, with the
// bitmaps pixelated. Pure, for `bun test`.

export const SCREEN_W = 640;
export const SCREEN_H = 480;

/**
 * The largest scale that fits, snapped down to a whole number when that keeps
 * at least 80 % of it: whole scales keep every source pixel the same size.
 */
export function stageScale(viewW: number, viewH: number): number {
  const fit = Math.min(viewW / SCREEN_W, viewH / SCREEN_H);
  if (!(fit > 0)) return 1;
  const whole = Math.floor(fit);
  if (whole >= 1 && whole / fit >= 0.8) return whole;
  return fit;
}

/** A client point to the screen's pixel, whole numbers as WM_MOUSEMOVE gives them. */
export function toScreen(
  clientX: number,
  clientY: number,
  stageLeft: number,
  stageTop: number,
  scale: number,
): [number, number] {
  return [Math.floor((clientX - stageLeft) / scale), Math.floor((clientY - stageTop) / scale)];
}

/** The stage's CSS: centred, scaled from its centre. */
export function stageStyle(scale: number): string {
  return `width:${SCREEN_W}px;height:${SCREEN_H}px;transform:translate(-50%,-50%) scale(${scale})`;
}
