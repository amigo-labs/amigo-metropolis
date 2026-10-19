// The in-game menu (dialog 0xa6) as an island over the match.
//
// docs/specs/ui.md §1: this is in-match UI, and it is a Preact island outside
// the frame loop. It mounts on Escape, renders only on its own input events
// and unmounts on close; nothing in it runs per frame, and the frame loop
// never calls into it. It shares its dialogs (Audio, Controller) with the
// menu's PREFERENCES.

import { render } from "preact";
import type { AudioEngine } from "../audio/engine";
import type { Binding } from "../input/bindings";
import { InGameDialog } from "./dialogs/InGameDialog";
import { stageScale, stageStyle } from "./frontend/stage";

export interface InGameMenu {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createInGameMenu(opts: {
  audio: AudioEngine;
  onResume(): void;
  onAbort(): void;
  onControls(tables: Binding[][]): void;
}): InGameMenu {
  let root: HTMLDivElement | null = null;

  const draw = (): void => {
    if (!root) return;
    render(
      <div class="ig-root">
        <div class="fe-stage ig-stage" style={stageStyle(stageScale(innerWidth, innerHeight))}>
          <InGameDialog
            audio={opts.audio}
            onResume={() => {
              close();
              opts.onResume();
            }}
            onAbort={() => {
              close();
              opts.onAbort();
            }}
            onControls={opts.onControls}
          />
        </div>
      </div>,
      root,
    );
  };

  const onResize = (): void => draw();

  function close(): void {
    if (!root) return;
    removeEventListener("resize", onResize);
    render(null, root);
    root.remove();
    root = null;
  }

  return {
    open(): void {
      if (root) return;
      root = document.createElement("div");
      root.className = "ig-host";
      document.body.appendChild(root);
      addEventListener("resize", onResize);
      draw();
    },
    close,
    isOpen: () => root !== null,
  };
}
