// Console drawers: how to play, and a combined preferences (sound + graphics).
//
// Audio and texture preferences are persisted by the modules that own them
// (audio/engine.ts, render/texVariants.ts) — this only drives them. The levels
// are read from the engine on mount rather than mirrored into MenuState,
// because the engine is the source of truth and is also changed from elsewhere.

import { useEffect, useState } from "preact/hooks";
import type { AudioEngine, LevelKind } from "../../audio/engine";
import {
  type Binding,
  bindingName,
  DEVICE_JOYSTICK,
  DEVICE_KEYBOARD,
  keyOfCode,
  PRESET_NAMES,
  presetTable,
  SLOT_NAMES,
  SLOT_ROW_ORDER,
} from "../../input/bindings";
import { loadControls, saveControls } from "../../input/controlsStore";
import { firstJoyControl, firstPad } from "../../input/gamepad";
import {
  loadBloomPref,
  loadTexPref,
  parseTexPref,
  saveBloomPref,
  saveTexPref,
  type TexPref,
} from "../../render/texVariants";
import type { MenuDrawer } from "../state";

interface Props {
  kind: MenuDrawer;
  audio: AudioEngine;
  onTexPref(pref: TexPref): void;
  onBloomPref(enabled: boolean): void;
  onControls?(table: Binding[]): void;
}

/** What each slot does, beside its name (the original's controls, input.spec.md). */
const SLOT_USE: readonly string[] = [
  "",
  "",
  "",
  "",
  "",
  "press: capture a turret, claim an outpost, buy one unit, ride a lift",
  "",
  "hover: brake",
  "",
  "",
  "strafe",
  "strafe",
  "",
  "the next target in front",
];

/** A binding as the screens show it: the key, or the pad's control. */
function shownBinding(b: Binding): string {
  return b.device === DEVICE_JOYSTICK ? `Pad ${bindingName(b)}` : bindingName(b);
}

/** Player 1's keys in the controls screen's order, then the chord and Escape. */
function controlRows(): (readonly [string, string])[] {
  const table = loadControls()[0];
  const rows: (readonly [string, string])[] = SLOT_ROW_ORDER.map((s) => {
    const use = SLOT_USE[s];
    return [shownBinding(table[s]), use ? `${SLOT_NAMES[s]} — ${use}` : SLOT_NAMES[s]] as const;
  });
  rows.push([
    `${shownBinding(table[13])} + ${shownBinding(table[5])}`,
    "transform (walker ⇄ hover)",
  ]);
  rows.push(["Escape", "pause"]);
  return rows;
}

/**
 * The original's controls screen (`controls_dialog.c`): a row per binding slot,
 * in its order; pick a row, then press the key or the pad button, or push the
 * stick, that should do it. "Select Default Profile" puts back one of the three
 * shipped presets — the keyboard's, the Sidewinder's or the Gravis' — and OK
 * saves (input/controlsStore.ts). Player 1's column only: Metropolis has no
 * second local player. Its look is the menu's until the front end is the
 * original's.
 */
function Controls({ onControls }: { onControls?(table: Binding[]): void }) {
  const [tables, setTables] = useState<Binding[][]>(() => loadControls());
  const [capturing, setCapturing] = useState(-1);
  const table = tables[0];

  const bind = (slot: number, b: Binding): void => {
    const next = tables.map((t) => t.map((x) => ({ ...x })));
    next[0][slot] = b;
    setTables(next);
    setCapturing(-1);
  };

  useEffect(() => {
    if (capturing < 0) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(-1); // the fixed binding: cancels, binds nothing
        return;
      }
      const vk = keyOfCode(e.code);
      if (vk >= 0) bind(capturing, { device: DEVICE_KEYBOARD, code: vk });
    };
    // A pad's control binds once everything has been let go first, so the
    // button that picked the row is not taken for its binding.
    let released = false;
    let raf = 0;
    const poll = (): void => {
      const pad = firstPad();
      const down = pad ? firstJoyControl(pad) : -1;
      if (down < 0) released = true;
      else if (released) {
        bind(capturing, { device: DEVICE_JOYSTICK, code: down });
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    window.addEventListener("keydown", onKey, true);
    raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      cancelAnimationFrame(raf);
    };
  });

  return (
    <>
      <h2 class="menu-h2">Controls</h2>
      <div class="menu-keys">
        {SLOT_ROW_ORDER.map((s) => (
          <div class="menu-key-row" key={s}>
            <span>{SLOT_NAMES[s]}</span>
            <button
              type="button"
              class={`menu-key-bind${capturing === s ? " is-active" : ""}`}
              onClick={() => setCapturing(capturing === s ? -1 : s)}
            >
              {capturing === s ? "press a key…" : shownBinding(table[s])}
            </button>
          </div>
        ))}
      </div>
      <div class="menu-row">
        <label class="menu-label" for="menu-controls-profile">
          Select Default Profile
        </label>
        <select
          id="menu-controls-profile"
          class="menu-select"
          value=""
          onChange={(e) => {
            const i = Number((e.currentTarget as HTMLSelectElement).value);
            if (!(i >= 0 && i < PRESET_NAMES.length)) return;
            setTables([presetTable(0, i), tables[1]]);
            setCapturing(-1);
          }}
        >
          <option value="">Choose Controller Profile…</option>
          {PRESET_NAMES.map((name, i) => (
            <option value={String(i)} key={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div class="menu-row">
        <button
          type="button"
          class="menu-pill"
          onClick={() => {
            saveControls(tables);
            onControls?.(tables[0]);
          }}
        >
          OK
        </button>
        <button
          type="button"
          class="menu-pill"
          onClick={() => {
            setTables(loadControls());
            setCapturing(-1);
          }}
        >
          Cancel
        </button>
      </div>
      <p class="menu-hint">
        Transform: {shownBinding(table[13])} + {shownBinding(table[5])}. A gamepad plays once its
        profile is chosen or a row is bound to it. Without a numeric keypad, bind the movement keys
        here. Escape stays the pause.
      </p>
    </>
  );
}

/**
 * The original's "Audio Controls" dialog (retail 0x00402930): three trackbars,
 * 0..127, in the order every arm visits them, with the dialog's own labels.
 * There is no master level.
 */
const LEVELS: readonly (readonly [LevelKind, string])[] = [
  ["sfx", "Sound Effects Volume"],
  ["music", "Music Volume"],
  ["movies", "Movies Volume"],
];

function HowTo() {
  return (
    <>
      <h2 class="menu-h2">Controls</h2>
      <div class="menu-keys">
        {controlRows().map(([k, v]) => (
          <div class="menu-key-row" key={k}>
            <kbd>{k}</kbd>
            <span>{v}</span>
          </div>
        ))}
      </div>
      <h2 class="menu-h2">Winning</h2>
      <p class="menu-hint">
        Earn points when enemy units, turrets and avatars fall and when you capture turrets. Spend
        them at your base's purchase spots to field Runners and Guardians and, once you hold 50, a
        Juggernaut or a Fortress, then escort a push through a lane and breach the enemy gate.
      </p>
    </>
  );
}

function Graphics({
  onTexPref,
  onBloomPref,
}: {
  onTexPref(pref: TexPref): void;
  onBloomPref(enabled: boolean): void;
}) {
  const [pref, setPref] = useState<TexPref>(loadTexPref());
  const [bloom, setBloom] = useState<boolean>(loadBloomPref());
  return (
    <>
      <div class="menu-row">
        <label class="menu-label" for="menu-gfx-textures">
          Textures
        </label>
        <select
          id="menu-gfx-textures"
          class="menu-select"
          value={pref}
          onChange={(e) => {
            const next = parseTexPref((e.currentTarget as HTMLSelectElement).value) ?? "hd";
            setPref(next);
            saveTexPref(next);
            onTexPref(next);
          }}
        >
          {/* HD is the shipped ESRGAN atlas; Classic is the 1998 source texels.
              Takes effect on the textured map path; greybox ignores it. */}
          <option value="hd">HD (upscaled)</option>
          <option value="original">Classic</option>
        </select>
      </div>
      <div class="menu-row">
        <label class="menu-label" for="menu-gfx-bloom">
          Bloom
        </label>
        <select
          id="menu-gfx-bloom"
          class="menu-select"
          value={bloom ? "on" : "off"}
          onChange={(e) => {
            const next = (e.currentTarget as HTMLSelectElement).value === "on";
            setBloom(next);
            saveBloomPref(next);
            onBloomPref(next);
          }}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
    </>
  );
}

function Sound({ audio }: { audio: AudioEngine }) {
  const [levels, setLevels] = useState(() => audio.getLevels());

  const setLevel = (kind: LevelKind, v: number): void => {
    audio.setLevel(kind, v);
    setLevels(audio.getLevels());
  };

  return (
    <>
      {LEVELS.map(([kind, name]) => (
        <div class="menu-row" key={kind}>
          <label class="menu-label" for={`menu-vol-${kind}`}>
            {name}
          </label>
          <input
            id={`menu-vol-${kind}`}
            class="menu-slider"
            type="range"
            min={0}
            max={127}
            value={levels[kind]}
            onInput={(e) => setLevel(kind, Number((e.currentTarget as HTMLInputElement).value))}
          />
          <span class="menu-value ck-value">{levels[kind]}</span>
        </div>
      ))}
      <p class="menu-hint">Settings are saved on this device.</p>
    </>
  );
}

function Preferences({
  audio,
  onTexPref,
  onBloomPref,
}: {
  audio: AudioEngine;
  onTexPref(pref: TexPref): void;
  onBloomPref(enabled: boolean): void;
}) {
  return (
    <>
      <h2 class="menu-h2">Sound</h2>
      <Sound audio={audio} />
      <h2 class="menu-h2">Graphics</h2>
      <Graphics onTexPref={onTexPref} onBloomPref={onBloomPref} />
    </>
  );
}

export function Drawer({ kind, audio, onTexPref, onBloomPref, onControls }: Props) {
  if (!kind) return null;
  return (
    <div class="menu-drawer ck-panel">
      {kind === "how" ? <HowTo /> : null}
      {kind === "controls" ? <Controls onControls={onControls} /> : null}
      {kind === "prefs" ? (
        <Preferences audio={audio} onTexPref={onTexPref} onBloomPref={onBloomPref} />
      ) : null}
    </div>
  );
}
