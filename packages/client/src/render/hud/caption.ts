// The camera caption: the chase camera's name, for 900 ticks after a Camera Key
// press and at the view's construct, pen at text (2, 60) — (4, 120) at 640 x 480
// — in text colour 8 (RE camera.json caption; draw.c:1396-1398). Raw DOM, one
// canvas, redrawn only when the name changes; shown and hidden by class.

import "./hud.css";
import { CAMERA_CAPTION, CAMERA_NAMES, FONT3_HEIGHT } from "../fcopPresentation.generated";
import { type BitmapFont, drawText, hudFont, textWidth } from "./bitmapText";
import { type HudCanvas, hudCanvas } from "./hudLayout";

export interface CameraCaption {
  /** Shows camera `name` while `visible`; draws only on a change. */
  update(name: number, visible: boolean): void;
  /** Re-places the caption for a viewport (CSS px). */
  layout(vw: number, vh: number): void;
  destroy(): void;
}

export function createCameraCaption(parent: HTMLElement = document.body): CameraCaption {
  const root = document.createElement("div");
  root.className = "mhud mhud-caption";
  parent.appendChild(root);
  const font: BitmapFont = hudFont();
  let width = 0;
  for (const n of CAMERA_NAMES) width = Math.max(width, textWidth(n));
  const x = CAMERA_CAPTION.text320[0] * 2;
  const y = CAMERA_CAPTION.text320[1] * 2;
  const canvas: HudCanvas = hudCanvas(root, x, y, width + 4, FONT3_HEIGHT + 6);
  let drawn = -1;
  let shown = false;
  let fontWasReady = false;
  canvas.el.style.visibility = "hidden";
  return {
    update(name, visible) {
      if (visible !== shown) {
        shown = visible;
        canvas.el.style.visibility = visible ? "visible" : "hidden";
      }
      if (!visible) return;
      if (name === drawn && !canvas.dirty && fontWasReady === font.ready) return;
      fontWasReady = font.ready;
      drawn = name;
      canvas.dirty = false;
      canvas.clear();
      // The pen sits at the canvas origin; the glyphs' own offsets do the rest.
      drawText(canvas.ctx, font, CAMERA_NAMES[name] ?? "", 0, 0, CAMERA_CAPTION.colour);
    },
    layout(vw, vh) {
      canvas.place(vw, vh);
    },
    destroy() {
      root.remove();
    },
  };
}
