// Console drawers: how to play, and a combined preferences (sound + graphics).
//
// Audio and texture preferences are persisted by the modules that own them
// (audio/engine.ts, render/texVariants.ts) — this only drives them. Volume and
// track are read from the engine on mount rather than mirrored into MenuState,
// because the engine is the source of truth and is also changed from elsewhere.

import { useState } from "preact/hooks";
import type { AudioEngine, VolumeKind } from "../../audio/engine";
import { MUSIC_OPTIONS, parseMusicSelection } from "../../audio/tracks";
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

const CONTROLS: readonly (readonly [string, string])[] = [
  ["WASD / arrows", "drive"],
  ["Mouse", "aim"],
  ["LMB / RMB / MMB", "primary / special / heavy"],
  ["Q", "transform (walker ⇄ hover)"],
  ["Space", "jump"],
  ["hold E", "buy / claim / capture at a console"],
];

const VOLUMES: readonly (readonly [VolumeKind, string])[] = [
  ["master", "Master"],
  ["sfx", "Effects"],
  ["music", "Music"],
];

function HowTo() {
  return (
    <>
      <h2 class="menu-h2">Controls</h2>
      <div class="menu-keys">
        {CONTROLS.map(([k, v]) => (
          <div class="menu-key-row" key={k}>
            <kbd>{k}</kbd>
            <span>{v}</span>
          </div>
        ))}
      </div>
      <h2 class="menu-h2">Winning</h2>
      <p class="menu-hint">
        Earn points from kills, captures, and a steady trickle. Spend them at your base consoles to
        field Runners, Guardians, and heavy units, then escort a push through a lane and breach the
        enemy gate.
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
  const [vols, setVols] = useState(() => audio.getVolumes());
  const [track, setTrack] = useState(() => audio.getMusicTrack());
  const [trackErr, setTrackErr] = useState("");

  const setVolume = (kind: VolumeKind, pct: number): void => {
    const v = pct / 100;
    audio.setVolume(kind, v);
    setVols({ ...audio.getVolumes() });
    if (kind !== "music") audio.preview(kind === "master" ? "capture" : "shot");
  };

  return (
    <>
      {/* Track picker first — picking a track is the on/off switch; the Music
          slider below is only its level (bumped to 60 when a pick would be
          mute). */}
      <div class="menu-row">
        <label class="menu-label" for="menu-music-track">
          Track
        </label>
        <select
          id="menu-music-track"
          class="menu-select"
          value={track}
          onChange={(e) => {
            // Parse before storing: parseMusicSelection is what narrows an
            // arbitrary option value to a MusicSelection, and it also normalizes
            // anything unexpected instead of putting it in state.
            const sel = parseMusicSelection((e.currentTarget as HTMLSelectElement).value);
            setTrackErr("");
            setTrack(sel);
            if (sel !== "off" && audio.getVolumes().music === 0) {
              audio.setVolume("music", 0.6);
              setVols({ ...audio.getVolumes() });
            }
            void audio.setMusicTrack(sel).then((res) => {
              if (res === "missing") {
                setTrackErr("Track file not found — drop mp3s into /music/.");
                setTrack(audio.getMusicTrack());
              }
            });
          }}
        >
          {MUSIC_OPTIONS.map((opt) => (
            <option value={opt.id} key={opt.id}>
              {opt.name}
            </option>
          ))}
        </select>
      </div>
      {trackErr ? <div class="menu-err">{trackErr}</div> : null}

      {VOLUMES.map(([kind, name]) => (
        <div class="menu-row" key={kind}>
          <label class="menu-label" for={`menu-vol-${kind}`}>
            {name}
          </label>
          <input
            id={`menu-vol-${kind}`}
            class="menu-slider"
            type="range"
            min={0}
            max={100}
            value={Math.round(vols[kind] * 100)}
            onInput={(e) => setVolume(kind, Number((e.currentTarget as HTMLInputElement).value))}
          />
          <span class="menu-value ck-value">{Math.round(vols[kind] * 100)}</span>
        </div>
      ))}
      <p class="menu-hint">
        Pick a track to turn music on (off by default). Settings are saved on this device.
      </p>
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
