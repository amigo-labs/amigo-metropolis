// Menu root: the original's front end (docs/specs/ui.md). A pure function of
// (state, props) -- runMenu in index.ts owns the state, the pointer and the
// dialogs, so this has no hooks and `bun test` renders it to a string.
//
// The 640 x 480 screen sits on a stage scaled to the viewport and letterboxed.
// Outside it, in the page's corners, the platform's own small links: Install
// (the PWA) and, on localhost only, the Fly and Sandbox debug modes.

import type { ComponentChildren } from "preact";
import { FrontScreen, LoadingScreen } from "./frontend/Screen";
import { stageStyle } from "./frontend/stage";
import type { MenuState } from "./state";

export interface AppProps {
  state: MenuState;
  /** Reveals Install once beforeinstallprompt has fired. */
  installPrompt?: () => void;
  /** Localhost-only Fly / Sandbox links, passed in so this stays pure. */
  showDebugModes?: boolean;
  onDebug?(mode: "fly" | "sandbox"): void;
  /** The dialogs over the screen (stateful; index.ts renders them). */
  overlay?: ComponentChildren;
}

export function App(props: AppProps) {
  const { state } = props;
  return (
    <div class="fe-root">
      <div class="fe-stage" data-stage style={stageStyle(state.scale)}>
        {state.loading ? (
          <LoadingScreen file={state.loading.file} fill={state.loading.fill} />
        ) : (
          <FrontScreen screen={state.screen} />
        )}
        {props.overlay}
      </div>
      {!state.loading && (props.installPrompt || props.showDebugModes) ? (
        <nav class="fe-platform" aria-label="Platform">
          {props.installPrompt ? (
            <button type="button" class="fe-link" onClick={props.installPrompt}>
              Install
            </button>
          ) : null}
          {props.showDebugModes ? (
            <>
              <button
                type="button"
                class="fe-link fe-link--debug"
                onClick={() => props.onDebug?.("fly")}
              >
                Fly
              </button>
              <button
                type="button"
                class="fe-link fe-link--debug"
                onClick={() => props.onDebug?.("sandbox")}
              >
                Sandbox
              </button>
            </>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
