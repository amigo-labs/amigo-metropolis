// The original's in-game menu (template 0xa6, ingame_dialog.c 0x004040e0):
// one row of four buttons, Resume Game, Abort Game, Audio, Controller, with no
// caption. Resume answers 0 and Abort 1 (the mission is left); Audio opens the
// audio dialog and re-applies the levels however it closes; Controller opens
// the controls screen. Its procedure ignores IDCANCEL, so Escape does nothing
// while it is up.

import { useState } from "preact/hooks";
import type { AudioEngine } from "../../audio/engine";
import type { Binding } from "../../input/bindings";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import { dialogLayout, W9Button, W9Window } from "../win9x/Win9x";
import { AudioDialog } from "./AudioDialog";
import { ControlsDialog } from "./ControlsDialog";

const D = FE_DIALOGS.in_game;
export const INGAME_RESUME = 1138;
export const INGAME_ABORT = 1137;
export const INGAME_AUDIO = 1139;
export const INGAME_CONTROLLER = 1140;

export function InGameDialog(props: {
  audio: AudioEngine;
  onResume(): void;
  onAbort(): void;
  onControls?(tables: Binding[][]): void;
}) {
  const L = dialogLayout(D);
  const [sub, setSub] = useState<"audio" | "controls" | null>(null);
  return (
    <>
      <W9Window layout={L} label="Game Menu">
        <W9Button
          rect={L.rect(INGAME_RESUME)}
          text={L.text(INGAME_RESUME)}
          isDefault
          autoFocus
          onClick={props.onResume}
        />
        <W9Button rect={L.rect(INGAME_ABORT)} text={L.text(INGAME_ABORT)} onClick={props.onAbort} />
        <W9Button
          rect={L.rect(INGAME_AUDIO)}
          text={L.text(INGAME_AUDIO)}
          onClick={() => setSub("audio")}
        />
        <W9Button
          rect={L.rect(INGAME_CONTROLLER)}
          text={L.text(INGAME_CONTROLLER)}
          onClick={() => setSub("controls")}
        />
      </W9Window>
      {sub === "audio" ? <AudioDialog audio={props.audio} onClose={() => setSub(null)} /> : null}
      {sub === "controls" ? (
        <ControlsDialog onClose={() => setSub(null)} onControls={props.onControls} />
      ) : null}
    </>
  );
}
