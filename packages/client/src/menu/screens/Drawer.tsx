// Console drawers: how to play, and a combined preferences (sound + graphics).
//
// Audio and texture preferences are persisted by the modules that own them
// (audio/engine.ts, render/texVariants.ts) — this only drives them. The levels
// are read from the engine on mount rather than mirrored into MenuState,
// because the engine is the source of truth and is also changed from elsewhere.

import { useState } from "preact/hooks";
import type { AudioEngine, LevelKind } from "../../audio/engine";
import { bindingName, presetTable, SLOT_NAMES, SLOT_ROW_ORDER } from "../../input/bindings";
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

/** Player 1's keys in the controls screen's order, then the chord and Escape. */
function controlRows(): (readonly [string, string])[] {
  const table = presetTable(0, 0);
  const rows: (readonly [string, string])[] = SLOT_ROW_ORDER.map((s) => {
    const use = SLOT_USE[s];
    return [bindingName(table[s]), use ? `${SLOT_NAMES[s]} — ${use}` : SLOT_NAMES[s]] as const;
  });
  rows.push([`${bindingName(table[13])} + ${bindingName(table[5])}`, "transform (walker ⇄ hover)"]);
  rows.push(["Escape", "pause"]);
  return rows;
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

export function Drawer({ kind, audio, onTexPref, onBloomPref }: Props) {
  if (!kind) return null;
  return (
    <div class="menu-drawer ck-panel">
      {kind === "how" ? <HowTo /> : null}
      {kind === "prefs" ? (
        <Preferences audio={audio} onTexPref={onTexPref} onBloomPref={onBloomPref} />
      ) : null}
    </div>
  );
}
