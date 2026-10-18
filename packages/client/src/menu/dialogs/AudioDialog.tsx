// The original's Audio dialog (template 0x98, audio_dialog.c 0x00402930):
// three trackbars 0..127 -- Sound Effects, Music, Movies -- "Off" to "Max".
// Nothing moves while it is open: the levels are read back and applied only on
// Ok; Cancel leaves them.

import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { AudioEngine, AudioLevels, LevelKind } from "../../audio/engine";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import { dialogLayout, W9Button, W9Static, W9Trackbar, W9Window } from "../win9x/Win9x";

const D = FE_DIALOGS.audio;
/** Trackbar id, label id, level: the dialog's three rows in its order. */
export const AUDIO_ROWS: readonly (readonly [number, number, LevelKind])[] = [
  [1124, 1120, "sfx"],
  [1119, 1121, "music"],
  [1122, 1123, "movies"],
];
const OK = 1104;
const CANCEL = 1105;
const OFF = 1150;
const MAX = 1153;

export function AudioDialog(props: { audio: AudioEngine; onClose(): void }) {
  const L = dialogLayout(D);
  const [levels, setLevels] = useState<AudioLevels>(() => props.audio.getLevels());
  const ok = (): void => {
    for (const [, , kind] of AUDIO_ROWS) props.audio.setLevel(kind, levels[kind]);
    props.onClose();
  };
  return (
    <W9Window layout={L} label="Audio">
      <W9Static rect={L.rect(OFF)} text={L.text(OFF)} />
      <W9Static rect={L.rect(MAX)} text={L.text(MAX)} />
      {AUDIO_ROWS.map(([track, label, kind]) => (
        <Fragment key={track}>
          <W9Static rect={L.rect(label)} text={L.text(label)} />
          <W9Trackbar
            rect={L.rect(track)}
            min={0}
            max={0x7f}
            value={levels[kind]}
            label={L.text(label)}
            onChange={(v) => setLevels({ ...levels, [kind]: v })}
          />
        </Fragment>
      ))}
      <W9Button rect={L.rect(OK)} text={L.text(OK)} autoFocus onClick={ok} />
      <W9Button rect={L.rect(CANCEL)} text={L.text(CANCEL)} onClick={props.onClose} />
    </W9Window>
  );
}
