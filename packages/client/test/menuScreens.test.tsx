// Menu screens rendered to a string. No jsdom: App is a pure function of
// (state, callbacks) precisely so this is possible.
//
// Scope note. `preact-render-to-string` cannot render the hook-using screens
// here, because bun's workspace resolution gives it its own preact instance
// (three copies land in node_modules/.bun, and hook state lives on the client
// copy's vnodes). That is why App, ArenaPicker and Weapons are deliberately
// hook-free — and why OnlinePanel and the Sound/Graphics drawers, which are
// genuinely stateful, are exercised in a browser instead of here.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact-render-to-string";
import { App, type AppProps } from "../src/menu/App";
import { Weapons } from "../src/menu/screens/Weapons";
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

describe("rail", () => {
  test("shows the title, the objective and every arena", () => {
    const html = renderApp(baseState());
    expect(html).toContain("METROPOLIS");
    expect(html).toContain("Break the enemy base's gate");
    expect(html).toContain("Urban Jungle");
  });

  test("summarises the fitted loadout without opening the weapons screen", () => {
    expect(renderApp(baseState())).toContain("Powered Mini-Gun");
  });

  test("the mode panel appears only once a mode is picked", () => {
    expect(renderApp(baseState())).not.toContain("menu-panel");
    expect(renderApp(baseState({ mode: "solo" }))).toContain("menu-panel");
  });

  test("debug modes are off unless the caller asks for them", () => {
    expect(renderApp(baseState())).not.toContain("menu-mode--debug");
    expect(renderApp(baseState(), { showDebugModes: true })).toContain("menu-mode--debug");
  });

  test("Install appears only once beforeinstallprompt has fired", () => {
    expect(renderApp(baseState())).not.toContain(">Install<");
    expect(renderApp(baseState(), { installPrompt: noop })).toContain(">Install<");
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

describe("weapons screen", () => {
  const weapons = (state: MenuState) =>
    render(<Weapons state={state} update={noop} onDone={noop} />);

  test("lists all three hardpoints with slot position and catalog size", () => {
    const html = weapons(baseState({ stage: "weapons" }));
    // Catalog sizes after #48 drop-ins: 4 guns, 6 heavies, 3 specials.
    expect(html).toContain("Gun (1/4)");
    expect(html).toContain("Heavy (1/6)");
    expect(html).toContain("Special (1/3)");
  });

  test("shows only the weapon fitted to each hardpoint, not the catalog", () => {
    // The original shows one weapon per slot; a visible list would be a
    // different screen entirely.
    const html = weapons(
      baseState({ stage: "weapons", loadout: { gun: 1, heavy: 0, special: 0 } }),
    );
    expect(html).toContain("Gun (2/4)");
    expect(html).not.toContain("Powered Mini-Gun");
  });

  test("marks the selected hardpoint and only that one", () => {
    const html = weapons(baseState({ stage: "weapons", hardpoint: 2 }));
    const boxes = html.split("wpn-box");
    expect(boxes[1]).not.toContain("is-active");
    expect(boxes[2]).not.toContain("is-active");
    expect(boxes[3]).toContain("is-active");
  });

  test("offers Ready and states the controls", () => {
    const html = weapons(baseState({ stage: "weapons" }));
    expect(html).toContain("Ready");
    expect(html).toContain("select hardpoint");
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
