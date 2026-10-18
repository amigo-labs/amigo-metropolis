// "Choose Controller Profile" (template 0xa5, profile_dialog.c 0x00403670):
// Keyboard / Sidewinder Gamepad / Gravis Gamepad fill the (disabled) list with
// what that preset would bind -- the slot's name padded to twenty, ": ", the
// binding -- and remember the choice. A preview only: Ok hands the choice to
// the controls screen, which copies it into its fields.

import { useState } from "preact/hooks";
import { type Binding, PRESET_NAMES, presetTable, SLOT_NAMES } from "../../input/bindings";
import { formatBinding } from "../../input/controlsStore";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import { dialogLayout, W9Button, W9List, W9Window } from "../win9x/Win9x";

const D = FE_DIALOGS.profile;
const PRESET_BUTTONS: readonly number[] = [1130, 1131, 1132];
const LIST = 1136;
const OK = 1133;
const CANCEL = 1134;

/** The list's row order (0x004037d0): left before right, the jinks beside the turns. */
export const PROFILE_ROW_SLOT: readonly number[] = [0, 1, 3, 2, 10, 11, 4, 12, 6, 5, 13, 7, 8, 9];
/** A list line: the name padded to twenty characters, ": ", the binding. */
export function profileLine(slot: number, b: Binding): string {
  return `${SLOT_NAMES[slot].padEnd(20, " ").slice(0, 20)}: ${formatBinding(b)}`;
}

export function profileLines(player: number, preset: number): string[] {
  const table = presetTable(player, preset);
  return PROFILE_ROW_SLOT.map((slot) => profileLine(slot, table[slot]));
}

export function ProfileDialog(props: { player: number; onClose(preset: number | null): void }) {
  const L = dialogLayout(D);
  const [chosen, setChosen] = useState<number | null>(null);
  return (
    <W9Window layout={L} onClose={() => props.onClose(null)}>
      {PRESET_BUTTONS.map((id, i) => (
        <W9Button key={id} rect={L.rect(id)} text={L.text(id)} onClick={() => setChosen(i)} />
      ))}
      <W9List
        rect={L.rect(LIST)}
        items={chosen === null ? [] : profileLines(props.player, chosen)}
        selected={-1}
        disabled
        label={chosen === null ? "Preset" : PRESET_NAMES[chosen]}
      />
      <W9Button
        rect={L.rect(OK)}
        text={L.text(OK)}
        isDefault
        onClick={() => props.onClose(chosen)}
      />
      <W9Button rect={L.rect(CANCEL)} text={L.text(CANCEL)} onClick={() => props.onClose(null)} />
    </W9Window>
  );
}
