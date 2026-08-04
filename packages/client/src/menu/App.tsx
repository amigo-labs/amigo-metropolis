// Menu root. A pure function of (state, callbacks) — runMenu in index.ts owns
// the state and re-renders on change, so this file has no hooks of its own and
// can be rendered to a string in `bun test` without a DOM.

import type { AudioEngine } from "../audio/engine";
import type { TexPref } from "../render/texVariants";
import { loadoutSummary } from "./hardpoints";
import type { MenuChoice } from "./routing";
import { ArenaPicker } from "./screens/ArenaPicker";
import { Drawer } from "./screens/Drawer";
import { OnlinePanel } from "./screens/OnlinePanel";
import { Weapons } from "./screens/Weapons";
import type { MenuDrawer, MenuMode, MenuState } from "./state";

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

function SoloPanel({ state, update, go }: Pick<AppProps, "state" | "update" | "go">) {
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
        Low levels play defensively; higher levels push Juggernauts. Prefer a target dummy?{" "}
        {/* In-process like every other choice; the href stays for
            middle-click/copy. */}
        <a
          href="?play=1"
          onClick={(e) => {
            e.preventDefault();
            go({ mode: "solo" });
          }}
        >
          Open the sandbox
        </a>
        .
      </p>
      <button
        type="button"
        class="menu-go"
        onClick={() => go({ mode: "warden", difficulty: state.difficulty })}
      >
        Start match
      </button>
    </>
  );
}

export function App(props: AppProps) {
  const { state, audio, installPrompt, showDebugModes, update, go, onSelect, onTexPref } = props;

  if (state.stage === "weapons") {
    return (
      <div class="menu-stage ck-bezel">
        <div class="menu-screen ck-screen">
          <Weapons state={state} update={update} onDone={() => update({ stage: "rail" })} />
        </div>
      </div>
    );
  }

  // Clicking the active mode closes it again — the panel is a disclosure, and
  // the button is its handle.
  const toggleMode = (which: MenuMode) => update({ mode: state.mode === which ? null : which });
  const toggleDrawer = (which: MenuDrawer) =>
    update({ drawer: state.drawer === which ? null : which });

  return (
    <div class="menu">
      {/* Left-edge scrim: darkens the arena behind the rail so text stays
          legible while the rest of the map reads bright and immersive. */}
      <div class="menu-scrim" />
      <div class="menu-rail ck-scroll">
        <div class="menu-brand">
          <div class="ck-label">arena strategy-action · solo · online</div>
          <h1 class="menu-title">METROPOLIS</h1>
          <p class="menu-objective">
            Break the enemy base's gate before they break yours. Drive your avatar, capture turrets
            and outposts, and buy waves of units to push a lane.
          </p>
        </div>

        <ArenaPicker mapId={state.mapId} onPick={onSelect} />

        <section class="menu-section">
          <div class="ck-label">Weapons</div>
          <button
            type="button"
            class="menu-loadout ck-panel"
            onClick={() => update({ stage: "weapons" })}
          >
            <span class="menu-loadout-kit ck-value">{loadoutSummary(state.loadout)}</span>
            <span class="menu-loadout-cta">Arm the X1-Alpha →</span>
          </button>
        </section>

        <div class="menu-modes">
          <button
            type="button"
            class={`menu-mode ck-panel${state.mode === "solo" ? " is-active" : ""}`}
            onClick={() => toggleMode("solo")}
          >
            <b>Solo</b>
            <span>vs the Warden AI</span>
          </button>
          <button
            type="button"
            class={`menu-mode ck-panel${state.mode === "online" ? " is-active" : ""}`}
            onClick={() => toggleMode("online")}
          >
            <b>Online</b>
            <span>1v1 over the internet</span>
          </button>
          {/* Localhost-only: free-fly debug over the sandbox. */}
          {showDebugModes ? (
            <>
              <button
                type="button"
                class="menu-mode menu-mode--debug"
                onClick={() => go({ mode: "fly" })}
              >
                <b>Fly</b>
                <span>debug cam · mesh units · turrets</span>
              </button>
              <button
                type="button"
                class="menu-mode menu-mode--debug"
                onClick={() => go({ mode: "sandbox" })}
              >
                <b>Sandbox</b>
                <span>spawn units + turrets · all weapons</span>
              </button>
            </>
          ) : null}
        </div>

        {state.mode ? (
          <div class="menu-panel ck-panel">
            {state.mode === "solo" ? (
              <SoloPanel state={state} update={update} go={go} />
            ) : (
              <OnlinePanel state={state} update={update} go={go} />
            )}
          </div>
        ) : null}

        <div class="menu-footer">
          <button
            type="button"
            class={`menu-link${state.drawer === "how" ? " is-active" : ""}`}
            onClick={() => toggleDrawer("how")}
          >
            How to play
          </button>
          <button
            type="button"
            class={`menu-link${state.drawer === "sound" ? " is-active" : ""}`}
            onClick={() => toggleDrawer("sound")}
          >
            Sound
          </button>
          <button
            type="button"
            class={`menu-link${state.drawer === "gfx" ? " is-active" : ""}`}
            onClick={() => toggleDrawer("gfx")}
          >
            Graphics
          </button>
          {installPrompt ? (
            <button type="button" class="menu-link menu-link--accent" onClick={installPrompt}>
              Install
            </button>
          ) : null}
        </div>

        <Drawer kind={state.drawer} audio={audio} onTexPref={onTexPref} />

        <div class="menu-credits">
          A Future Cop: Precinct Assault homage · a working-title prototype.
        </div>
      </div>
    </div>
  );
}
