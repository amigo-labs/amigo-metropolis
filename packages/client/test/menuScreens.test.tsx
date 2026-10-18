// The front end rendered to a string. No jsdom: App and the screen are pure
// functions of the state precisely so this is possible.
//
// Scope note. `preact-render-to-string` cannot render the hook-using dialogs
// here, because bun's workspace resolution gives it its own preact instance
// (three copies land in node_modules/.bun, and hook state lives on the client
// copy's vnodes). That is why App and the screen are hook-free -- and why the
// dialogs' pure parts are tested in menuDialogs.test.ts and the dialogs
// themselves in a browser.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "preact-render-to-string";
import { App, type AppProps } from "../src/menu/App";
import { createScreen, enterSet, newGameConfig } from "../src/menu/frontend/model";
import type { MenuState } from "../src/menu/state";

function baseState(patch: Partial<MenuState> = {}): MenuState {
  return {
    screen: createScreen(newGameConfig()),
    scale: 2,
    dialog: null,
    loading: null,
    netChoice: null,
    ...patch,
  };
}

function renderApp(state: MenuState, extra: Partial<AppProps> = {}): string {
  return render(<App state={state} {...extra} />);
}

/** The pictures drawn, in draw order. */
function pictures(html: string): string[] {
  return [...html.matchAll(/src="\/ui\/frontend\/([^"]+)"/g)].map((m) => m[1]);
}

describe("the main screen", () => {
  test("draws the PA one-player set's four groups in order, backdrops first", () => {
    const pics = pictures(renderApp(baseState()));
    expect(pics[0]).toBe("bmp064.png"); // the dossier frame
    expect(pics).toContain("bmp065.png"); // the left column
    expect(pics).toContain("bmp067.png"); // SKY CAPTAIN / LEVEL
    expect(pics.indexOf("bmp071.png")).toBeGreaterThan(pics.indexOf("bmp067.png")); // the map last
    expect(pics).not.toContain("bmp066.png"); // no right player column in 1P
  });

  test("the left column of eight buttons, the plates, START; BRIEFING is not drawn", () => {
    const pics = pictures(renderApp(baseState()));
    for (const f of [
      "bmp081.png", // NEW GAME
      "bmp062.png", // LOAD GAME
      "bmp134.png", // SAVE GAME
      "bmp042.png", // HOST GAME
      "bmp049.png", // JOIN GAME
      "bmp091.png", // PREFERENCES
      "bmp034.png", // HELP
      "bmp097.png", // QUIT
      "bmp085.png", // PRECINCT ASSAULT
      "bmp000.png", // 1 PLAYER
      "bmp129.png", // START
    ]) {
      expect(pics).toContain(f);
    }
    expect(pics).not.toContain("bmp006.png"); // BRIEFING, disabled in PA
  });

  test("the picked map lit, its title plate; Bug Hunt and COMPLETED hidden on a new game", () => {
    const pics = pictures(renderApp(baseState()));
    expect(pics).toContain("bmp138.png"); // Urban Jungle lit
    expect(pics).toContain("bmp137.png"); // its title plate
    expect(pics).not.toContain("bmp089.png"); // Proving Ground unlit
    expect(pics).not.toContain("bmp009.png"); // Bug Hunt
    expect(pics).not.toContain("bmp017.png"); // COMPLETED
  });

  test("the loadout column, NORMAL, the red walker, level 1 and its taunt", () => {
    const pics = pictures(renderApp(baseState()));
    expect(pics).toContain("bmp073.png"); // Powered Mini-Gun icon
    expect(pics).toContain("bmp074.png"); // its panel
    expect(pics).toContain("bmp039.png"); // Hell Fire 2000
    expect(pics).toContain("bmp078.png"); // Mortar Launcher
    expect(pics).toContain("bmp083.png"); // NORMAL
    expect(pics).toContain("bmp148.png"); // the red walker
    expect(pics).toContain("bmp102.png"); // level 1
    expect(pics).toContain("bmp112.png"); // "Come out, come out wherever you are..."
    expect(pics).not.toContain("bmp143.png"); // WAITING is locked offline
  });

  test("a finished map shows COMPLETED and the film strip", () => {
    const c = newGameConfig();
    c.paLevel[1] = 10;
    const pics = pictures(renderApp(baseState({ screen: createScreen(c) })));
    expect(pics).toContain("bmp017.png");
    expect(pics).toContain("bmp079.png");
  });

  test("the networked set: CANCEL, both columns, the Connected To caption", () => {
    const s = createScreen(newGameConfig());
    enterSet(s, "net_pa", { hosting: true, peer: "Room ABCDE" });
    const html = renderApp(baseState({ screen: s }));
    const pics = pictures(html);
    expect(pics).toContain("bmp173.png"); // CANCEL
    expect(pics).toContain("bmp066.png"); // the right player column
    expect(pics).toContain("bmp147.png"); // the blue walker
    expect(pics).not.toContain("bmp081.png"); // no NEW GAME
    expect(html).toContain("Connected To:");
    expect(html).toContain("  Room ABCDE");
  });

  test("the stage is scaled and the bitmaps pixelated", () => {
    const html = renderApp(baseState({ scale: 3 }));
    expect(html).toContain("scale(3)");
    expect(html).toContain('class="fe-pic"');
  });

  test("the loading screen: the row's bitmap and the bar's fill", () => {
    const html = renderApp(baseState({ loading: { file: "LdConF.png", fill: 120 } }));
    expect(html).toContain("/ui/frontend/loading/LdConF.png");
    expect(html).toContain("bmp175.png");
    expect(html).toMatch(/left:220px;top:274px;width:120px;height:12px/);
  });
});

describe("the platform's links", () => {
  test("debug modes only when asked for, Install only once offered", () => {
    expect(renderApp(baseState())).not.toContain(">Fly<");
    expect(renderApp(baseState(), { showDebugModes: true })).toContain(">Fly<");
    expect(renderApp(baseState(), { showDebugModes: true })).toContain(">Sandbox<");
    expect(renderApp(baseState())).not.toContain(">Install<");
    expect(renderApp(baseState(), { installPrompt: () => {} })).toContain(">Install<");
  });

  test("none of the invented menu is left: no title, pills or How to play", () => {
    const html = renderApp(baseState(), { showDebugModes: true });
    expect(html).not.toContain("METROPOLIS");
    expect(html).not.toContain("How to play");
    expect(html).not.toContain("menu-pill");
  });
});

describe("escaping", () => {
  // Lobby names are other players' text (docs/specs/ui.md §1). JSX escapes
  // children, and preactToolchain.test.tsx pins that mechanism. What this adds
  // is the guarantee that no screen opts out of it.
  test("no menu or HUD source uses dangerouslySetInnerHTML", () => {
    const roots = ["src/menu", "src/ui", "src/render/hud"];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
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

  test("a session name is escaped on the Connected To line", () => {
    const s = createScreen(newGameConfig());
    enterSet(s, "net_pa", { hosting: false, peer: '"><script>alert(1)</script>' });
    expect(renderApp(baseState({ screen: s }))).not.toContain("<script>");
  });
});
