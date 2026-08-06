// Menu screens rendered to a string. No jsdom: App is a pure function of
// (state, callbacks) precisely so this is possible.
//
// Scope note. `preact-render-to-string` cannot render the hook-using screens
// here, because bun's workspace resolution gives it its own preact instance
// (three copies land in node_modules/.bun, and hook state lives on the client
// copy's vnodes). That is why App and ArenaPicker are deliberately hook-free —
// and why OnlinePanel and the Preferences drawer, which are genuinely stateful,
// are exercised in a browser instead of here.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact-render-to-string";
import { App, type AppProps } from "../src/menu/App";
import { initialMenuState, type MenuState } from "../src/menu/state";

function baseState(patch: Partial<MenuState> = {}): MenuState {
  return { ...initialMenuState(), ...patch };
}

const noop = () => {};
// Only reached by the drawers, which these tests never open.
const audio = {} as unknown as AppProps["audio"];

function renderApp(state: MenuState, extra: Partial<AppProps> = {}): string {
  return render(
    <App
      state={state}
      audio={audio}
      update={noop}
      go={noop}
      onSelect={noop}
      onTexPref={noop}
      {...extra}
    />,
  );
}

describe("console rail", () => {
  test("shows the PA title, arena name and every arena card", () => {
    const html = renderApp(baseState());
    expect(html).toContain("PRECINCT ASSAULT");
    expect(html).toContain("METROPOLIS");
    expect(html).toContain("Urban Jungle");
    expect(html).toContain("Start");
  });

  test("lists left-column pills for modes and drawers", () => {
    const html = renderApp(baseState());
    expect(html).toContain("Solo");
    expect(html).toContain("Online");
    expect(html).toContain("Preferences");
    expect(html).toContain("How to play");
    // Weapons are fitted on the bottom strip — no separate screen entry.
    expect(html).not.toContain(">Weapons<");
  });

  test("summarises the fitted loadout on the bottom strip with cycle arrows", () => {
    const html = renderApp(baseState());
    expect(html).toContain("Powered Mini-Gun");
    expect(html).toContain("menu-bar--rate");
    expect(html).toContain("menu-bar--damage");
    expect(html).toContain("menu-loadout-arrow");
    expect(html).toContain("Previous Gun");
    expect(html).toContain("Next Special");
  });

  test("the mode panel appears only once a mode is picked", () => {
    expect(renderApp(baseState())).not.toContain("menu-panel");
    expect(renderApp(baseState({ mode: "solo" }))).toContain("menu-panel");
  });

  test("debug modes are off unless the caller asks for them", () => {
    expect(renderApp(baseState())).not.toContain("menu-pill--debug");
    expect(renderApp(baseState(), { showDebugModes: true })).toContain("menu-pill--debug");
  });

  test("Install appears only once beforeinstallprompt has fired", () => {
    expect(renderApp(baseState())).not.toContain(">Install<");
    expect(renderApp(baseState(), { installPrompt: noop })).toContain(">Install<");
  });

  test("START is the confirming action on the console (enabled for solo)", () => {
    // OnlinePanel uses hooks and cannot be string-rendered (see file header),
    // so the disabled-in-online branch is browser-only. Solo path stays pure.
    const html = renderApp(baseState({ mode: "solo" }));
    expect(html).toContain("menu-start");
    expect(html).not.toMatch(/menu-start[^>]*disabled/);
  });
});

describe("state survives a panel switch", () => {
  // The bug the port exists to fix: difficulty used to live only in a DOM node
  // that replaceChildren() threw away when the panel was toggled.
  test("difficulty renders from state, not from the slider's own value", () => {
    expect(renderApp(baseState({ mode: "solo", difficulty: 9 }))).toContain('value="9"');
    expect(renderApp(baseState({ mode: "solo", difficulty: 2 }))).toContain('value="2"');
  });

  test("leaving the panel and returning renders the same value again", () => {
    const chosen = baseState({ mode: "solo", difficulty: 7 });
    expect(renderApp(chosen)).toContain('value="7"');
    const away = { ...chosen, mode: null };
    expect(renderApp(away)).not.toContain("menu-difficulty");
    expect(renderApp({ ...away, mode: "solo" as const })).toContain('value="7"');
  });
});

describe("escaping", () => {
  // Lobby names are other players' text (docs/specs/ui.md §1). JSX escapes
  // children, and preactToolchain.test.tsx pins that mechanism. What this adds
  // is the guarantee that no screen opts out of it — stronger than checking one
  // rendered string, because it covers every file including ones added later.
  test("no menu or HUD source uses dangerouslySetInnerHTML", () => {
    const roots = ["src/menu", "src/ui", "src/render/hud"];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        // The attribute form only: these files talk *about* the rule in their
        // comments, and a bare substring match would flag the documentation.
        else if (
          /\.tsx?$/.test(name) &&
          /dangerouslySetInnerHTML\s*=/.test(readFileSync(full, "utf8"))
        ) {
          offenders.push(full);
        }
      }
    };
    for (const r of roots) walk(join(import.meta.dir, "..", r));
    expect(offenders).toEqual([]);
  });

  test("text rendered into a screen is escaped", () => {
    const html = renderApp(baseState({ mapId: '"><script>alert(1)</script>' }));
    expect(html).not.toContain("<script>");
  });
});
