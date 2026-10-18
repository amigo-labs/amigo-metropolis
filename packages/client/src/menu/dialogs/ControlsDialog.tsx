// The original's controls screen (template 0x71, controls_dialog.c
// 0x00402bb0): Player 1 and Player 2, fourteen bordered fields each beside the
// fourteen action labels, each holding one binding as text
// ("Keyboard: NumPad8"); "Select Default Profile" per player, Ok bottom left,
// Cancel bottom right.
//
// The selected field is drawn inverted; the dialog opens on player 1's Move
// Forward *without* drawing it, and a click moves the selection. A keyboard
// hook writes every key into the selected field and swallows it; a key the
// formatter cannot name beeps -- Beep(400, 500) -- and is passed on. A 250 ms
// timer polls the pad the same way. Bindings change only on Ok; Cancel
// discards. Both players' tables are edited and stored, as the original's
// controls file holds them, though Metropolis drives only player 1.

import { useEffect, useState } from "preact/hooks";
import {
  type Binding,
  DEVICE_JOYSTICK,
  DEVICE_KEYBOARD,
  keyOfCode,
  presetTable,
} from "../../input/bindings";
import { formatBinding, loadControls, saveControls } from "../../input/controlsStore";
import { firstJoyControl, firstPad } from "../../input/gamepad";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import { uiSounds } from "../frontend/uiSound";
import { dialogLayout, W9Button, W9Static, W9Window } from "../win9x/Win9x";
import { ProfileDialog } from "./ProfileDialog";

const D = FE_DIALOGS.controls;

/**
 * The 28 field ids in slot order, player 1's fourteen then player 2's
 * (controls_dialog.c FIELD_IDS): slot k's field sits beside slot k's label.
 */
export const CONTROLS_FIELD_IDS: readonly (readonly number[])[] = [
  [
    0x406, 0x407, 0x3ff, 0x408, 0x409, 0x419, 0x41d, 0x414, 0x428, 0x429, 0x423, 0x420, 0x40a,
    0x40d,
  ],
  [
    0x40b, 0x40e, 0x402, 0x411, 0x412, 0x41c, 0x41f, 0x417, 0x42a, 0x42b, 0x425, 0x422, 0x413,
    0x410,
  ],
];
/** "Select Default Profile", per player. */
export const CONTROLS_PROFILE_IDS: readonly number[] = [1135, 1136];
const OK = 1027;
const CANCEL = 1028;
/** The joystick poll, SetTimer(hdlg, 1, 250). */
export const PAD_POLL_MS = 250;

/** The labels: every static of the template without a border. */
const LABELS = D.controls.filter((c) => c.cls === "Static" && !c.styles.includes("WS_BORDER"));

/** A key as the hook writes it: its binding, or null for one the formatter cannot name. */
export function bindingOfKey(code: string): Binding | null {
  const vk = keyOfCode(code);
  if (vk < 0) return null;
  const b = { device: DEVICE_KEYBOARD, code: vk };
  return formatBinding(b) === "Unknown" ? null : b;
}

export function ControlsDialog(props: {
  onClose(): void;
  /** Ok saved the tables; player 1's applies at once. */
  onControls?(tables: Binding[][]): void;
}) {
  const L = dialogLayout(D);
  const [tables, setTables] = useState<Binding[][]>(() => loadControls());
  const [sel, setSel] = useState({ player: 0, slot: 0, drawn: false });
  const [profileFor, setProfileFor] = useState<number | null>(null);

  const write = (b: Binding): void => {
    setTables((t) => {
      const next = t.map((row) => row.map((x) => ({ ...x })));
      next[sel.player][sel.slot] = b;
      return next;
    });
  };

  useEffect(() => {
    if (profileFor !== null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      const b = bindingOfKey(e.code);
      if (!b) {
        uiSounds.beep(400, 500);
        return; // passed on
      }
      e.preventDefault();
      e.stopPropagation();
      write(b);
    };
    const timer = setInterval(() => {
      const pad = firstPad();
      const code = pad ? firstJoyControl(pad) : -1;
      if (code >= 0) write({ device: DEVICE_JOYSTICK, code });
    }, PAD_POLL_MS);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearInterval(timer);
    };
  });

  const ok = (): void => {
    saveControls(tables);
    props.onControls?.(tables);
    props.onClose();
  };

  return (
    <>
      <W9Window layout={L} label="Controller Configuration">
        {LABELS.map((c) => (
          <W9Static
            key={c.id}
            rect={L.rect(c.id)}
            text={c.text ?? ""}
            align={c.styles.includes("SS_CENTER") ? "center" : "left"}
            middle={c.styles.includes("SS_CENTERIMAGE")}
          />
        ))}
        {CONTROLS_FIELD_IDS.map((ids, player) =>
          ids.map((id, slot) => (
            <W9Static
              key={id}
              id={`ctl-field-${player}-${slot}`}
              rect={L.rect(id)}
              text={formatBinding(tables[player][slot])}
              align="center"
              middle
              border
              inverted={sel.drawn && sel.player === player && sel.slot === slot}
              onClick={() => setSel({ player, slot, drawn: true })}
            />
          )),
        )}
        {CONTROLS_PROFILE_IDS.map((id, player) => (
          <W9Button
            key={id}
            rect={L.rect(id)}
            text={L.text(id)}
            onClick={() => setProfileFor(player)}
          />
        ))}
        <W9Button rect={L.rect(OK)} text={L.text(OK)} isDefault onClick={ok} />
        <W9Button rect={L.rect(CANCEL)} text={L.text(CANCEL)} onClick={props.onClose} />
      </W9Window>
      {profileFor !== null ? (
        <ProfileDialog
          player={profileFor}
          onClose={(preset) => {
            // The chosen preset is copied into that player's fields.
            if (preset !== null) {
              setTables((t) =>
                t.map((row, p) => (p === profileFor ? presetTable(p, preset) : row)),
              );
            }
            setProfileFor(null);
          }}
        />
      ) : null}
    </>
  );
}
