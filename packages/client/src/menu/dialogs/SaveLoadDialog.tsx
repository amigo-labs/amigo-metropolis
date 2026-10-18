// SAVE GAME / LOAD GAME: the original's one dialog for both (template 0xa3,
// save_dialog.c 0x00403a50) over its twenty named slots -- a bordered caption
// ("Save Game" or "Load Game"), the editable slot list, Ok and Cancel. Ok ends
// the dialog whatever the worker did; the opener then shows the worker's box.

import { useState } from "preact/hooks";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import type { FeConfig } from "../frontend/model";
import {
  loadFromSlot,
  loadSaveFile,
  SAVE_NAME_MAX,
  type SaveFile,
  saveToSlot,
  slotNames,
  storeSaveFile,
} from "../frontend/progress";
import { dialogLayout, type W9Box, W9Button, W9Combo, W9Static, W9Window } from "../win9x/Win9x";

const D = FE_DIALOGS.save_load;
const OK = 1112;
const CANCEL = 1113;
const LIST = 1115;
const TITLE = 1116;

/** The worker's answer: the box to show and, for a load, the config. */
export interface SaveLoadResult {
  box: W9Box | null;
  loaded: FeConfig | null;
}

/** What Ok does (0x00403e20 / 0x00403f10), pure over the file. */
export function runSaveLoad(
  mode: "save" | "load",
  file: SaveFile,
  slot: number,
  name: string,
  config: FeConfig,
): SaveLoadResult {
  if (mode === "load") {
    const loaded = loadFromSlot(file, slot);
    if (!loaded) {
      return {
        box: box("Not a valid save.", "Load Game", "stop"),
        loaded: null,
      };
    }
    return { box: box("Game Loaded Successfully", "Load Game", "info"), loaded };
  }
  const refused = saveToSlot(file, slot, name, config);
  if (refused) return { box: box(refused, "Save Game", "stop"), loaded: null };
  return { box: box("Game Saved Successfully.", "Save Game", "info"), loaded: null };
}

function box(text: string, caption: string, icon: "info" | "stop"): W9Box {
  return { text, caption, icon, buttons: ["OK"] };
}

export function SaveLoadDialog(props: {
  mode: "save" | "load";
  config: FeConfig;
  onDone(result: SaveLoadResult | null): void;
}) {
  const L = dialogLayout(D);
  const [file] = useState<SaveFile>(() => loadSaveFile());
  const names = slotNames(file);
  const [slot, setSlot] = useState(file.slot);
  const [text, setText] = useState(names[file.slot]);
  const [open, setOpen] = useState(false);
  const ok = (): void => {
    const result = runSaveLoad(props.mode, file, slot, text, props.config);
    if (props.mode === "save" || result.loaded) storeSaveFile(file);
    props.onDone(result);
  };
  return (
    <W9Window layout={L} label={props.mode === "save" ? "Save Game" : "Load Game"}>
      <W9Static
        rect={L.rect(TITLE)}
        text={props.mode === "save" ? "Save Game" : "Load Game"}
        border
        middle
      />
      <W9Combo
        rect={L.rect(LIST)}
        items={names}
        selected={slot}
        open={open}
        editable
        text={text}
        label="Saved games"
        lineHeight={13}
        onToggle={() => setOpen(!open)}
        onPick={(i) => {
          setSlot(i);
          setText(names[i]);
          setOpen(false);
        }}
        onText={(v) => setText(v.slice(0, SAVE_NAME_MAX))}
      />
      <W9Button rect={L.rect(OK)} text={L.text(OK)} isDefault autoFocus onClick={ok} />
      <W9Button rect={L.rect(CANCEL)} text={L.text(CANCEL)} onClick={() => props.onDone(null)} />
    </W9Window>
  );
}
