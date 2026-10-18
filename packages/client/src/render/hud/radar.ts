// The radar (RE hud.json radar; src/game/frame/hud_radar.c): GlblData page
// 11's disc, 112 x 112 at (4, 4) at 640 x 480, appended twice at half alpha
// (op 0x8c, a byte-identical second record).
//
// Raw DOM: one canvas in the 640 space (hudLayout.ts), drawn on change.

import { HUD } from "../fcopPresentation.generated";
import { hudPage11 } from "./hudArt";
import { type HudCanvas, hudCanvas } from "./hudLayout";

export interface Radar {
  /** Draws the radar for this frame (the local X1's interpolated pose). */
  refresh(
    match: Float32Array,
    snapshot: Float32Array,
    count: number,
    clock: number,
    selfX: number,
    selfY: number,
    facing: number,
    down: boolean,
  ): void;
  /** Re-places the radar for a viewport (CSS px). */
  layout(vw: number, vh: number): void;
}

/** The radar's canvas covers the disc and the rim's ticks (radius 60 about (60, 60)). */
const AREA = 120;

export function createRadar(parent: HTMLElement, _mapId: string, _slot: number): Radar {
  const page = hudPage11();
  const canvas: HudCanvas = hudCanvas(parent, 0, 0, AREA, AREA);
  let drawnReady = false;
  return {
    refresh() {
      if (!canvas.dirty && drawnReady === page.ready) return;
      canvas.dirty = false;
      drawnReady = page.ready;
      canvas.begin();
      drawDisc(canvas.ctx, page.image, page.ready);
    },
    layout(vw, vh) {
      canvas.place(vw, vh);
    },
  };
}

/** The disc, twice at half alpha: 0.75 of the texture over what is behind it. */
export function drawDisc(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  ready: boolean,
): void {
  if (!ready) return;
  const d = HUD.radar.disc;
  const b = HUD.radar.box;
  ctx.globalAlpha = 0.5;
  ctx.drawImage(image, d[0], d[1], d[2], d[3], b[0], b[1], b[2], b[3]);
  ctx.drawImage(image, d[0], d[1], d[2], d[3], b[0], b[1], b[2], b[3]);
  ctx.globalAlpha = 1;
}
