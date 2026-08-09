// Menu root. A pure function of (state, callbacks) — runMenu in index.ts owns
// the state and re-renders on change, so this file has no hooks of its own and
// can be rendered to a string in `bun test` without a DOM.
//
// Layout mirrors the original Precinct Assault console (docs/renders/fcop-ui/
// and the PA main-menu screenshots): left pill column, centre map panel with
// START, bottom loadout strip with rate/damage bars. Live 3D stays as the
// backdrop behind the console frame (docs/specs/ui.md §3).

import { MAP_REGISTRY } from "@metropolis/sim";
import type { AudioEngine } from "../audio/engine";
import type { TexPref } from "../render/texVariants";
import {
  cycleHardpoint,
  fittedWeapons,
  HARDPOINTS,
  type HardpointSpec,
  weaponBarFractions,
} from "./hardpoints";
import type { MenuChoice } from "./routing";
import { ArenaPicker } from "./screens/ArenaPicker";
import { Drawer } from "./screens/Drawer";
import { OnlinePanel } from "./screens/OnlinePanel";
import type { Hardpoint, MenuDrawer, MenuMode, MenuState } from "./state";
import { weaponIconUrl } from "./weaponArt";

export interface AppProps {
  state: MenuState;
  audio: AudioEngine;
  /** Reveals the Install button once beforeinstallprompt has fired. */
  installPrompt?: () => void;
  /** Localhost-only Fly/Sandbox entries. Passed in rather than read from
   *  `location` here, so this stays a pure function of its props. */
  showDebugModes?: boolean;
  update(patch: Partial<MenuState>): void;
  go(choice: MenuChoice): void;
  onSelect(mapId: string): void;
  onTexPref(pref: TexPref): void;
}

function SoloPanel({ state, update }: Pick<AppProps, "state" | "update">) {
  return (
    <>
      <div class="menu-row">
        <label class="menu-label" for="menu-difficulty">
          Difficulty
        </label>
        <input
          id="menu-difficulty"
          class="menu-slider"
          type="range"
          min={1}
          max={10}
          value={state.difficulty}
          onInput={(e) =>
            update({ difficulty: Number((e.currentTarget as HTMLInputElement).value) })
          }
        />
        <span class="menu-value ck-value">{state.difficulty}</span>
      </div>
      <p class="menu-hint">
        Low levels play defensively; higher levels push Juggernauts. START fields the Warden AI.
      </p>
    </>
  );
}

/** Bottom rack: Gun / Heavy / Special stacked; ◀ ▶ cycles each slot in place. */
function LoadoutStrip({
  state,
  update,
}: {
  state: MenuState;
  update(patch: Partial<MenuState>): void;
}) {
  const fitted = fittedWeapons(state.loadout);
  return (
    <div class="menu-loadout-strip">
      {HARDPOINTS.map((spec: HardpointSpec, i) => {
        const w = fitted[i];
        const bars = weaponBarFractions(w, spec.list);
        const hardpoint = i as Hardpoint;
        const idx = state.loadout[spec.key];
        const n = spec.list.length;
        return (
          <div class="menu-loadout-slot" key={spec.key}>
            <div class="menu-loadout-slot-head">
              <span class="menu-loadout-slot-label ck-label">{spec.label}</span>
              <span class="menu-loadout-slot-pos ck-label">
                {idx + 1}/{n}
              </span>
            </div>
            <div class="menu-loadout-cycle">
              <button
                type="button"
                class="menu-loadout-arrow"
                aria-label={`Previous ${spec.label}`}
                onClick={() => update({ loadout: cycleHardpoint(state.loadout, hardpoint, -1) })}
              >
                ◀
              </button>
              <span class="menu-loadout-pick">
                <img
                  class="menu-loadout-icon"
                  src={weaponIconUrl(w.name)}
                  alt=""
                  width={45}
                  height={42}
                  draggable={false}
                />
                <span class="menu-loadout-slot-name" title={w.name}>
                  {w.name}
                </span>
              </span>
              <button
                type="button"
                class="menu-loadout-arrow"
                aria-label={`Next ${spec.label}`}
                onClick={() => update({ loadout: cycleHardpoint(state.loadout, hardpoint, 1) })}
              >
                ▶
              </button>
            </div>
            <span class="menu-bar-row" aria-hidden="true">
              <span class="menu-bar-track">
                <span
                  class="menu-bar menu-bar--rate"
                  style={`width:${(bars.rate * 100).toFixed(0)}%`}
                />
              </span>
              <span class="menu-bar-track">
                <span
                  class="menu-bar menu-bar--damage"
                  style={`width:${(bars.damage * 100).toFixed(0)}%`}
                />
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function App(props: AppProps) {
  const { state, audio, installPrompt, showDebugModes, update, go, onSelect, onTexPref } = props;

  // Clicking the active pill closes the panel again — disclosure pattern.
  const selectMode = (which: MenuMode) => {
    if (!which) return;
    update({ mode: state.mode === which ? null : which, drawer: null });
  };
  const toggleDrawer = (which: MenuDrawer) => {
    if (!which) return;
    update({ drawer: state.drawer === which ? null : which, mode: null });
  };

  const mapName = MAP_REGISTRY.find((m) => m.id === state.mapId)?.displayName ?? state.mapId;
  const modeTitle =
    state.mode === "online" ? "ONLINE" : state.mode === "solo" ? "SOLO" : "PRECINCT ASSAULT";
  const modeSub =
    state.mode === "online" ? "1v1 over the internet" : state.mode === "solo" ? "1 PLAYER" : "map";

  const startMatch = () => {
    // Online has its own Host/Join controls; START only boots a local match.
    if (state.mode === "online") return;
    go({ mode: "warden", difficulty: state.difficulty });
  };

  return (
    <div class="menu">
      {/* Dim the live arena so the console chrome stays legible; the centre
          map panel still sits over a bright 3D backdrop cutout feel. */}
      <div class="menu-scrim" />

      <div class="menu-console ck-bezel">
        <div class="menu-handle menu-handle--left" aria-hidden="true" />
        <div class="menu-handle menu-handle--right" aria-hidden="true" />

        <header class="menu-brand-head">
          <h1 class="menu-title">METROPOLIS</h1>
          <p class="menu-tagline">A Future Cop: Precinct Assault homage</p>
        </header>

        <div class="menu-console-body">
          {/* --- Left pill column (FCOP NEW GAME / PREFERENCES / …) -------- */}
          <nav class="menu-pills" aria-label="Main menu">
            <button
              type="button"
              class={`menu-pill${state.mode === "solo" ? " is-active" : ""}`}
              onClick={() => selectMode("solo")}
            >
              Solo
            </button>
            <button
              type="button"
              class={`menu-pill${state.mode === "online" ? " is-active" : ""}`}
              onClick={() => selectMode("online")}
            >
              Online
            </button>
            <button
              type="button"
              class={`menu-pill${state.drawer === "prefs" ? " is-active" : ""}`}
              onClick={() => toggleDrawer("prefs")}
            >
              Preferences
            </button>
            <button
              type="button"
              class={`menu-pill${state.drawer === "how" ? " is-active" : ""}`}
              onClick={() => toggleDrawer("how")}
            >
              How to play
            </button>
            {installPrompt ? (
              <button type="button" class="menu-pill menu-pill--accent" onClick={installPrompt}>
                Install
              </button>
            ) : null}
            {showDebugModes ? (
              <>
                <button
                  type="button"
                  class="menu-pill menu-pill--debug"
                  onClick={() => go({ mode: "fly" })}
                >
                  Fly
                </button>
                <button
                  type="button"
                  class="menu-pill menu-pill--debug"
                  onClick={() => go({ mode: "sandbox" })}
                >
                  Sandbox
                </button>
              </>
            ) : null}
          </nav>

          {/* --- Centre: mode title, map, options, START ------------------- */}
          <div class="menu-center ck-scroll">
            <header class="menu-center-head">
              <h2 class="menu-mode-title">{modeTitle}</h2>
              <span class="menu-mode-tag ck-label">{modeSub}</span>
            </header>

            <div class="menu-map-panel ck-screen">
              <img
                class="menu-map-preview"
                src={`/models/${encodeURIComponent(state.mapId)}/preview.png`}
                alt=""
                decoding="async"
                onError={(e) => {
                  // Fall back to the arena strip's procedural thumbs — hide the
                  // broken image so the panel still shows the grid + name.
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
            <div class="menu-map-name">{mapName}</div>

            <ArenaPicker mapId={state.mapId} onPick={onSelect} />

            {state.mode === "solo" ? (
              <div class="menu-panel ck-panel">
                <SoloPanel state={state} update={update} />
              </div>
            ) : null}
            {state.mode === "online" ? (
              <div class="menu-panel ck-panel">
                <OnlinePanel state={state} update={update} go={go} />
              </div>
            ) : null}

            <Drawer kind={state.drawer} audio={audio} onTexPref={onTexPref} />

            <div class="menu-start-row">
              <button
                type="button"
                class="menu-start"
                disabled={state.mode === "online"}
                title={
                  state.mode === "online"
                    ? "Host or join from the panel above"
                    : "Start solo match vs the Warden"
                }
                onClick={startMatch}
              >
                Start
              </button>
            </div>
          </div>
        </div>

        <LoadoutStrip state={state} update={update} />
      </div>
    </div>
  );
}
