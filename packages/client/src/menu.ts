// Title screen + menu flow (PLAN Phase 7). This is the "understand the game"
// half of the phase DoD — a stranger opens the bare URL and sees the title, the
// objective, and one click per mode. Deep links (?warden=4, ?splitscreen,
// ?online=CODE, ?play, ?debug) skip the menu entirely, so shareable URLs and the
// test harnesses are untouched (see main.ts `explicitMode`).
//
// Choosing a mode navigates by rewriting the query string and letting main.ts
// boot that mode on reload — the same param-driven path every deep link takes.
// That keeps this file free of any sim/render coupling: it only builds a URL and
// tweaks audio volumes (which persist to localStorage and survive the reload).

import type { AudioEngine } from "./audio/engine";

export type MenuChoice =
  | { mode: "solo" } // sandbox vs the scripted feeder opponent
  | { mode: "warden"; difficulty: number } // vs the Phase 4 AI
  | { mode: "couch" } // local splitscreen
  | { mode: "online"; code: string }; // 1v1 lockstep

/**
 * Pure mapping from a menu choice to the query string main.ts understands.
 * Kept separate from the DOM so it is unit-testable.
 */
export function buildModeQuery(choice: MenuChoice): string {
  switch (choice.mode) {
    case "solo":
      return "?play=1";
    case "warden": {
      const d = Math.max(1, Math.min(10, Math.trunc(choice.difficulty) || 1));
      return `?warden=${d}`;
    }
    case "couch":
      return "?splitscreen";
    case "online":
      // Encode defensively: valid codes are unaffected, but an unexpected value
      // can't smuggle extra query params (& / =) into the URL.
      return `?online=${encodeURIComponent(choice.code.toUpperCase())}`;
  }
}

/** 5 upper-case alphanumerics, matching main.ts's room-code validation. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{5}$/.test(code) ? code : null;
}

// Ambiguous glyphs (0/O, 1/I) dropped so spoken/typed codes survive.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomRoomCode(rand: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return code;
}

export interface MenuOptions {
  audio: AudioEngine;
}

/** Handle returned by runMenu so a late `beforeinstallprompt` can add Install. */
export interface MenuHandle {
  /** Reveals the Install button and wires it to `prompt`. */
  offerInstall(prompt: () => void): void;
}

/**
 * Navigates to `choice`, carrying over the relay override so online play works
 * against a non-default relay set on the current URL (?relay=…).
 */
function go(choice: MenuChoice): void {
  const query = buildModeQuery(choice);
  const relay = new URLSearchParams(location.search).get("relay");
  location.search = relay ? `${query}&relay=${encodeURIComponent(relay)}` : query;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

/** Builds and mounts the title/menu overlay. A mode choice navigates the page. */
export function runMenu(opts: MenuOptions): MenuHandle {
  const { audio } = opts;

  const root = el("div", "menu");
  const card = el("div", "menu-card");
  root.appendChild(card);

  card.appendChild(el("div", "menu-kicker", "arena strategy-action · solo · couch · online"));
  card.appendChild(el("h1", "menu-title", "DISTRICT&nbsp;BREACH"));
  card.appendChild(
    el(
      "p",
      "menu-objective",
      "Break the enemy base's gate before they break yours. Drive your avatar, " +
        "capture turrets and outposts, and buy waves of units to push a lane.",
    ),
  );

  // --- Mode buttons ---------------------------------------------------------
  const modes = el("div", "menu-modes");
  const soloBtn = el("button", "menu-mode", "<b>Solo</b><span>vs the Warden AI</span>");
  const couchBtn = el("button", "menu-mode", "<b>Couch</b><span>2 players, splitscreen</span>");
  const onlineBtn = el("button", "menu-mode", "<b>Online</b><span>1v1 over the internet</span>");
  modes.append(soloBtn, couchBtn, onlineBtn);
  card.appendChild(modes);

  // A single sub-panel below the buttons reveals the chosen mode's options.
  const panel = el("div", "menu-panel");
  panel.style.display = "none";
  card.appendChild(panel);

  let active: "solo" | "online" | null = null;
  const setActive = (which: "solo" | "online" | null): void => {
    active = which;
    soloBtn.classList.toggle("is-active", which === "solo");
    onlineBtn.classList.toggle("is-active", which === "online");
    panel.style.display = which ? "block" : "none";
    panel.replaceChildren();
    if (which === "solo") buildSoloPanel();
    else if (which === "online") buildOnlinePanel();
  };

  function buildSoloPanel(): void {
    const row = el("div", "menu-row");
    const label = el("label", "menu-label", "Difficulty");
    const value = el("span", "menu-value", "4");
    const slider = el("input", "menu-slider") as HTMLInputElement;
    slider.id = "menu-difficulty";
    label.htmlFor = slider.id;
    slider.type = "range";
    slider.min = "1";
    slider.max = "10";
    slider.value = "4";
    slider.oninput = () => {
      value.textContent = slider.value;
    };
    row.append(label, slider, value);
    panel.appendChild(row);
    panel.appendChild(
      el(
        "p",
        "menu-hint",
        "Low levels play defensively; higher levels push Juggernauts. " +
          "Prefer a target dummy? <a href='?play=1'>Open the sandbox</a>.",
      ),
    );
    const start = el("button", "menu-go", "Start match");
    start.onclick = () => go({ mode: "warden", difficulty: Number(slider.value) });
    panel.appendChild(start);
  }

  function buildOnlinePanel(): void {
    const row = el("div", "menu-row");
    const input = el("input", "menu-code") as HTMLInputElement;
    input.type = "text";
    input.maxLength = 5;
    input.placeholder = "CODE";
    input.setAttribute("aria-label", "Room code");
    input.autocapitalize = "characters";
    input.spellcheck = false;
    const join = el("button", "menu-go", "Join") as HTMLButtonElement;
    const err = el("div", "menu-err");
    const tryJoin = (): void => {
      const code = normalizeRoomCode(input.value);
      if (!code) {
        err.textContent = "Enter a 5-character room code.";
        return;
      }
      go({ mode: "online", code });
    };
    input.oninput = () => {
      input.value = input.value.toUpperCase();
      err.textContent = "";
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") tryJoin();
    };
    join.onclick = tryJoin;
    row.append(input, join);
    panel.appendChild(row);

    const host = el("button", "menu-go menu-go--ghost", "Host a new room");
    host.onclick = () => go({ mode: "online", code: randomRoomCode() });
    panel.appendChild(host);
    panel.appendChild(
      el(
        "p",
        "menu-hint",
        "Host, then share the 5-character code. Both players enter the same code " +
          "to join the same room. Same code = same match seed.",
      ),
    );
  }

  soloBtn.onclick = () => setActive(active === "solo" ? null : "solo");
  onlineBtn.onclick = () => setActive(active === "online" ? null : "online");
  couchBtn.onclick = () => go({ mode: "couch" });

  // --- Footer: how-to, settings, install ------------------------------------
  const footer = el("div", "menu-footer");
  const howBtn = el("button", "menu-link", "How to play");
  const setBtn = el("button", "menu-link", "Sound");
  // Install starts hidden; offerInstall() reveals it if the browser offers PWA
  // install (the beforeinstallprompt event usually fires after this mounts).
  const installBtn = el("button", "menu-link menu-link--accent", "Install");
  installBtn.style.display = "none";
  footer.append(howBtn, setBtn, installBtn);
  card.appendChild(footer);

  const drawer = el("div", "menu-drawer");
  drawer.style.display = "none";
  card.appendChild(drawer);
  let drawerKind: "how" | "sound" | null = null;
  const toggleDrawer = (kind: "how" | "sound"): void => {
    drawerKind = drawerKind === kind ? null : kind;
    howBtn.classList.toggle("is-active", drawerKind === "how");
    setBtn.classList.toggle("is-active", drawerKind === "sound");
    drawer.style.display = drawerKind ? "block" : "none";
    drawer.replaceChildren();
    if (drawerKind === "how") buildHowTo();
    else if (drawerKind === "sound") buildSound();
  };
  howBtn.onclick = () => toggleDrawer("how");
  setBtn.onclick = () => toggleDrawer("sound");

  function buildHowTo(): void {
    drawer.appendChild(el("h2", "menu-h2", "Controls"));
    const table = el("div", "menu-keys");
    const keys: [string, string][] = [
      ["WASD / arrows", "drive"],
      ["Mouse", "aim"],
      ["LMB / RMB / MMB", "primary / special / heavy"],
      ["Q", "transform (walker ⇄ hover)"],
      ["Space", "jump"],
      ["hold E", "buy / claim / capture at a console"],
    ];
    for (const [k, v] of keys) {
      const r = el("div", "menu-key-row");
      r.append(el("kbd", undefined, k), el("span", undefined, v));
      table.appendChild(r);
    }
    drawer.appendChild(table);
    drawer.appendChild(el("h2", "menu-h2", "Winning"));
    drawer.appendChild(
      el(
        "p",
        "menu-hint",
        "Earn points from kills, captures, and a steady trickle. Spend them at " +
          "your base consoles to field Runners, Guardians, and heavy units, then " +
          "escort a push through a lane and breach the enemy gate. Gamepads work " +
          "too — in Couch, press A to join.",
      ),
    );
  }

  function buildSound(): void {
    const vols = audio.getVolumes();
    const kinds: [import("./audio/engine").VolumeKind, string][] = [
      ["master", "Master"],
      ["sfx", "Effects"],
      ["music", "Music"],
    ];
    for (const [kind, name] of kinds) {
      const row = el("div", "menu-row");
      const label = el("label", "menu-label", name);
      const value = el("span", "menu-value", String(Math.round(vols[kind] * 100)));
      const slider = el("input", "menu-slider") as HTMLInputElement;
      slider.id = `menu-vol-${kind}`;
      label.htmlFor = slider.id;
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.value = String(Math.round(vols[kind] * 100));
      slider.oninput = () => {
        const v = Number(slider.value) / 100;
        value.textContent = slider.value;
        audio.setVolume(kind, v);
        if (kind !== "music") audio.preview(kind === "master" ? "capture" : "shot");
      };
      row.append(label, slider, value);
      drawer.appendChild(row);
    }
    drawer.appendChild(
      el("p", "menu-hint", "Music is off by default. Settings are saved on this device."),
    );
  }

  card.appendChild(
    el(
      "div",
      "menu-credits",
      "Original mechanics homage · zero original IP · CC0 assets. " + "A working-title prototype.",
    ),
  );

  document.body.appendChild(root);

  return {
    offerInstall(prompt: () => void): void {
      installBtn.onclick = () => prompt();
      installBtn.style.display = "";
    },
  };
}
