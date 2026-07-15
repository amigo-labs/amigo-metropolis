// Title screen + menu flow (PLAN Phase 7; redesigned in the menu-redesign pass).
// A stranger opens the bare URL and sees the title, the objective, a live 3D
// arena backdrop, and one click per mode. Deep links (?warden=4, ?online=CODE,
// ?play, ?debug) skip the menu entirely, so shareable URLs and the test
// harnesses are untouched (see main.ts `explicitMode`).
//
// The layout is immersive: the zoomed arena fills the screen while a slim glass
// rail docks the controls. The arena picker doubles as a preview — selecting a
// card swaps the live backdrop to that arena via opts.onSelect, and each card
// shows a rendered minimap of the map.
//
// Choosing a mode emits a MenuChoice through opts.onChoice; main.ts starts the
// picked mode in-process (no reload — the live menu world morphs into the
// match) and pushState()s the matching deep-link query. This file stays free of
// any renderer/sim coupling beyond static map metadata: it reads MAP_REGISTRY
// and loads MapData (via getMapById) only to draw the picker minimaps. The
// picked arena rides along on every MenuChoice as `mapId`.

import { getMapById, MAP_REGISTRY } from "@metropolis/sim";
import type { AudioEngine } from "./audio/engine";
import { MUSIC_OPTIONS, parseMusicSelection } from "./audio/tracks";
import { hashLobbyPassword, storeP2pBootstrap } from "./net/p2pSession";
import { drawArenaThumbnail } from "./render/arenaThumb";

export type MenuChoice =
  | { mode: "solo" } // sandbox vs the scripted feeder opponent
  | { mode: "warden"; difficulty: number } // vs the Phase 4 AI
  | { mode: "online"; code: string } // 1v1 lockstep via the relay
  | { mode: "p2p"; code: string }; // 1v1 lockstep, lobby-brokered P2P

/**
 * Pure mapping from a menu choice to the query string main.ts understands.
 * Kept separate from the DOM so it is unit-testable. `mapId` (the picker's
 * arena) rides along as the ?map= deep-link param main.ts already reads.
 */
export function buildModeQuery(choice: MenuChoice, mapId?: string): string {
  let query: string;
  switch (choice.mode) {
    case "solo":
      query = "?play=1";
      break;
    case "warden": {
      const d = Math.max(1, Math.min(10, Math.trunc(choice.difficulty) || 1));
      query = `?warden=${d}`;
      break;
    }
    case "online":
      // Encode defensively: valid codes are unaffected, but an unexpected value
      // can't smuggle extra query params (& / =) into the URL.
      query = `?online=${encodeURIComponent(choice.code.toUpperCase())}`;
      break;
    case "p2p":
      query = `?p2p=${encodeURIComponent(choice.code.toUpperCase())}`;
      break;
  }
  return mapId ? `${query}&map=${encodeURIComponent(mapId)}` : query;
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
  /** Called once when the player picks a mode; main.ts starts it in-process.
   *  `mapId` is the arena picked in the menu's persistent arena gallery. */
  onChoice(choice: MenuChoice, mapId: string): void;
  /** Called whenever the arena selection changes so the live 3D backdrop can
   *  preview the picked arena. `mapId` is the newly selected arena. */
  onSelect(mapId: string): void;
}

/** Handle returned by runMenu so a late `beforeinstallprompt` can add Install. */
export interface MenuHandle {
  /** Reveals the Install button and wires it to `prompt`. */
  offerInstall(prompt: () => void): void;
  /** Fades the menu out and removes it from the DOM. */
  dismiss(): void;
}

/** HTTP(S) base for /api reads: the ?relay ws override translated, else same-origin. */
function apiBase(): string {
  const relay = new URLSearchParams(location.search).get("relay");
  if (!relay) return "";
  return relay.replace(/\/+$/, "").replace(/^ws(s?):/, "http$1:");
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

/** Builds and mounts the title/menu overlay. A mode choice emits onChoice. */
export function runMenu(opts: MenuOptions): MenuHandle {
  const { audio } = opts;
  const go = opts.onChoice;

  const root = el("div", "menu");
  // A scrim on the left keeps the rail legible over the bright arena backdrop.
  root.appendChild(el("div", "menu-scrim"));
  const rail = el("div", "menu-rail");
  root.appendChild(rail);

  // --- Brand header ---------------------------------------------------------
  const brand = el("div", "menu-brand");
  brand.appendChild(el("div", "menu-kicker", "arena strategy-action · solo · online"));
  brand.appendChild(el("h1", "menu-title", "METROPOLIS"));
  brand.appendChild(
    el(
      "p",
      "menu-objective",
      "Break the enemy base's gate before they break yours. Drive your avatar, " +
        "capture turrets and outposts, and buy waves of units to push a lane.",
    ),
  );
  rail.appendChild(brand);

  // --- Arena gallery (persistent; applies to whichever mode is started) ------
  // Pre-select a ?map= already on the URL so arena deep links keep their pick
  // through the menu; unknown ids quietly fall back to the first arena (which
  // is also main.ts's boot backdrop, so no initial preview swap is needed).
  const urlMapId = new URLSearchParams(location.search).get("map");
  let selectedMapId = MAP_REGISTRY.some((m) => m.id === urlMapId)
    ? (urlMapId as string)
    : MAP_REGISTRY[0].id;

  const arenaSection = el("div", "menu-section");
  arenaSection.appendChild(el("div", "menu-section-label", "Arena"));
  const grid = el("div", "menu-arena-grid");
  const arenaCards: HTMLButtonElement[] = [];
  for (const info of MAP_REGISTRY) {
    const card = el("button", "menu-arena-card");
    card.type = "button";
    card.setAttribute("aria-label", info.displayName);
    const thumb = el("canvas", "menu-arena-thumb") as HTMLCanvasElement;
    thumb.width = 200;
    thumb.height = 200;
    try {
      drawArenaThumbnail(thumb, getMapById(info.id));
    } catch {
      // A missing or malformed map JSON must not blank the whole menu — the
      // card just shows its name over an empty tile.
    }
    const name = el("span", "menu-arena-name");
    name.textContent = info.displayName;
    card.append(thumb, name);
    card.onclick = () => selectArena(info.id);
    grid.appendChild(card);
    arenaCards.push(card);
  }
  arenaSection.appendChild(grid);
  rail.appendChild(arenaSection);

  function selectArena(id: string): void {
    selectedMapId = id;
    for (let i = 0; i < arenaCards.length; i++) {
      arenaCards[i].classList.toggle("is-active", MAP_REGISTRY[i].id === id);
    }
    opts.onSelect(id);
  }
  // Initial highlight only — the backdrop already boots on this arena, so we
  // deliberately don't fire onSelect here (avoids a redundant scene rebuild).
  for (let i = 0; i < arenaCards.length; i++) {
    arenaCards[i].classList.toggle("is-active", MAP_REGISTRY[i].id === selectedMapId);
  }

  // --- Mode buttons ---------------------------------------------------------
  const modes = el("div", "menu-modes");
  const soloBtn = el("button", "menu-mode", "<b>Solo</b><span>vs the Warden AI</span>");
  const onlineBtn = el("button", "menu-mode", "<b>Online</b><span>1v1 over the internet</span>");
  modes.append(soloBtn, onlineBtn);
  rail.appendChild(modes);

  // A single sub-panel below the buttons reveals the chosen mode's options
  // (solo difficulty, or the online lobby). Hidden until a mode is picked.
  const panel = el("div", "menu-panel");
  panel.style.display = "none";
  rail.appendChild(panel);

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
    const hint = el(
      "p",
      "menu-hint",
      "Low levels play defensively; higher levels push Juggernauts. " +
        "Prefer a target dummy? <a href='?play=1'>Open the sandbox</a>.",
    );
    // In-process like every other choice; the href stays for middle-click/copy.
    const sandbox = hint.querySelector("a");
    if (sandbox) {
      sandbox.onclick = (e) => {
        e.preventDefault();
        go({ mode: "solo" }, selectedMapId);
      };
    }
    panel.appendChild(hint);
    const start = el("button", "menu-go", "Start match");
    start.onclick = () => go({ mode: "warden", difficulty: Number(slider.value) }, selectedMapId);
    panel.appendChild(start);
  }

  function buildOnlinePanel(): void {
    // Join by code (relay): the lightweight path — both players type the same
    // 5-char code to meet in a room (same code = same match seed).
    panel.appendChild(el("h2", "menu-h2", "Join by code"));
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
      go({ mode: "online", code }, selectedMapId);
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
    panel.appendChild(err);

    const host = el("button", "menu-go menu-go--ghost", "Host a new room");
    host.onclick = () => go({ mode: "online", code: randomRoomCode() }, selectedMapId);
    panel.appendChild(host);
    panel.appendChild(
      el(
        "p",
        "menu-hint",
        "Host, then share the 5-character code. Both players enter the same code " +
          "to join the same room.",
      ),
    );
    buildP2pSection();
  }

  // --- P2P lobby browser (hosting.spec.md §3.1) -------------------------------
  // Lists open public lobbies from /api/lobbies and hosts new ones. Match
  // traffic runs peer-to-peer over WebRTC; the room-code relay above stays as
  // the fallback path. Lobby names are other players' text — always assigned
  // via textContent, never innerHTML.
  function buildP2pSection(): void {
    panel.appendChild(el("h2", "menu-h2", "Public lobbies"));
    const list = el("div", "menu-lobbies");
    const hint = el("div", "menu-hint", "Loading lobbies…");
    panel.append(list, hint);

    const joinLobby = async (lobbyId: string, password?: string): Promise<void> => {
      const passwordHash = password ? await hashLobbyPassword(lobbyId, password) : undefined;
      storeP2pBootstrap(lobbyId, { role: "join", passwordHash });
      go({ mode: "p2p", code: lobbyId }, selectedMapId);
    };

    const lobbyRow = (lobby: {
      lobbyId: string;
      name: string;
      hasPassword: boolean;
    }): HTMLElement => {
      const row = el("div", "menu-lobby");
      const name = el("span", "menu-lobby-name");
      name.textContent = `${lobby.hasPassword ? "\u{1F512} " : ""}${lobby.name || lobby.lobbyId}`;
      const join = el("button", "menu-go", "Join") as HTMLButtonElement;
      join.onclick = () => {
        if (!lobby.hasPassword) {
          void joinLobby(lobby.lobbyId);
          return;
        }
        if (row.querySelector("input")) return; // password field already shown
        const pw = el("input", "menu-code") as HTMLInputElement;
        pw.type = "password";
        pw.placeholder = "password";
        pw.setAttribute("aria-label", `Password for ${lobby.name}`);
        const submit = (): void => void joinLobby(lobby.lobbyId, pw.value);
        pw.onkeydown = (e) => {
          if (e.key === "Enter") submit();
        };
        join.textContent = "Go";
        join.onclick = submit;
        row.insertBefore(pw, join);
        pw.focus();
      };
      row.append(name, join);
      return row;
    };

    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${apiBase()}/api/lobbies`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          lobbies: { lobbyId: string; name: string; hasPassword: boolean }[];
        };
        list.replaceChildren(...data.lobbies.map(lobbyRow));
        hint.textContent = data.lobbies.length ? "" : "No open lobbies right now — host one below.";
      } catch {
        hint.textContent = "Lobby list unavailable (offline or the server is asleep).";
      }
      void loadBudget();
    };

    // "Sold out" path (hosting.spec.md §6): if the budget gatekeeper has no
    // capacity left, grey out hosting up front instead of failing the create.
    const loadBudget = async (): Promise<void> => {
      try {
        const res = await fetch(`${apiBase()}/api/budget`);
        if (!res.ok) return;
        const budget = (await res.json()) as { available: boolean; retryAtMs: number | null };
        create.disabled = !budget.available;
        budgetHint.textContent = budget.available
          ? ""
          : "Sold out for today — free capacity resets at midnight UTC.";
      } catch {
        // no budget info — leave hosting enabled; the server still enforces it
      }
    };
    const refresh = el("button", "menu-go menu-go--ghost", "Refresh list");
    refresh.onclick = () => void load();
    panel.appendChild(refresh);

    // Hosting: name + optional password + visibility, then a fresh code.
    panel.appendChild(el("h2", "menu-h2", "Host a lobby"));
    const nameRow = el("div", "menu-row");
    const nameInput = el("input", "menu-code menu-code--text") as HTMLInputElement;
    nameInput.type = "text";
    nameInput.maxLength = 40;
    nameInput.placeholder = "Lobby name";
    nameInput.setAttribute("aria-label", "Lobby name");
    nameRow.appendChild(nameInput);
    panel.appendChild(nameRow);
    const pwRow = el("div", "menu-row");
    const pwInput = el("input", "menu-code menu-code--text") as HTMLInputElement;
    pwInput.type = "password";
    pwInput.placeholder = "Password (optional)";
    pwInput.setAttribute("aria-label", "Lobby password (optional)");
    pwRow.appendChild(pwInput);
    panel.appendChild(pwRow);
    const pubLabel = el("label", "menu-check");
    const pubCheck = el("input") as HTMLInputElement;
    pubCheck.type = "checkbox";
    pubCheck.checked = true;
    pubLabel.append(pubCheck, document.createTextNode("List publicly (else share the code)"));
    panel.appendChild(pubLabel);
    const create = el("button", "menu-go", "Create lobby");
    const budgetHint = el("p", "menu-err");
    create.onclick = async () => {
      const code = randomRoomCode();
      const passwordHash = pwInput.value ? await hashLobbyPassword(code, pwInput.value) : undefined;
      storeP2pBootstrap(code, {
        role: "host",
        name: nameInput.value.trim() || `Lobby ${code}`,
        visibility: pubCheck.checked ? "public" : "private",
        passwordHash,
      });
      go({ mode: "p2p", code }, selectedMapId);
    };
    panel.appendChild(create);
    panel.appendChild(budgetHint);
    panel.appendChild(
      el(
        "p",
        "menu-hint",
        "P2P matches connect directly between both browsers. Private lobbies are " +
          "joined by sharing the code; passwords are checked by the server and " +
          "never sent in plain text.",
      ),
    );
    void load();
  }

  soloBtn.onclick = () => setActive(active === "solo" ? null : "solo");
  onlineBtn.onclick = () => setActive(active === "online" ? null : "online");

  // --- Footer: how-to, settings, install ------------------------------------
  const footer = el("div", "menu-footer");
  const howBtn = el("button", "menu-link", "How to play");
  const setBtn = el("button", "menu-link", "Sound");
  // Install starts hidden; offerInstall() reveals it if the browser offers PWA
  // install (the beforeinstallprompt event usually fires after this mounts).
  const installBtn = el("button", "menu-link menu-link--accent", "Install");
  installBtn.style.display = "none";
  footer.append(howBtn, setBtn, installBtn);
  rail.appendChild(footer);

  const drawer = el("div", "menu-drawer");
  drawer.style.display = "none";
  rail.appendChild(drawer);
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
          "escort a push through a lane and breach the enemy gate.",
      ),
    );
  }

  function buildSound(): void {
    const vols = audio.getVolumes();

    // Track picker first — picking a track is the on/off switch; the Music
    // slider below is only its level (bumped to 60 when a pick would be mute).
    const trackRow = el("div", "menu-row");
    const trackLabel = el("label", "menu-label", "Track");
    const select = el("select", "menu-select") as HTMLSelectElement;
    select.id = "menu-music-track";
    trackLabel.htmlFor = select.id;
    for (const opt of MUSIC_OPTIONS) {
      const o = el("option", undefined, opt.name) as HTMLOptionElement;
      o.value = opt.id;
      select.appendChild(o);
    }
    select.value = audio.getMusicTrack();
    const trackErr = el("div", "menu-err");
    trackRow.append(trackLabel, select);
    drawer.append(trackRow, trackErr);

    let musicSlider: HTMLInputElement | undefined;
    let musicValue: HTMLSpanElement | undefined;
    select.onchange = () => {
      trackErr.textContent = "";
      const sel = parseMusicSelection(select.value);
      if (sel !== "off" && audio.getVolumes().music === 0) {
        audio.setVolume("music", 0.6);
        if (musicSlider) musicSlider.value = "60";
        if (musicValue) musicValue.textContent = "60";
      }
      void audio.setMusicTrack(sel).then((res) => {
        if (res === "missing") {
          trackErr.textContent = "Track file not found — drop mp3s into /music/.";
          select.value = audio.getMusicTrack();
        }
      });
    };

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
      if (kind === "music") {
        musicSlider = slider;
        musicValue = value;
      }
      row.append(label, slider, value);
      drawer.appendChild(row);
    }
    drawer.appendChild(
      el(
        "p",
        "menu-hint",
        "Pick a track to turn music on (off by default). Settings are saved on this device.",
      ),
    );
  }

  rail.appendChild(
    el("div", "menu-credits", "A Future Cop: Precinct Assault homage · a working-title prototype."),
  );

  document.body.appendChild(root);

  return {
    offerInstall(prompt: () => void): void {
      installBtn.onclick = () => prompt();
      installBtn.style.display = "";
    },
    dismiss(): void {
      root.classList.add("is-leaving");
      let removed = false;
      const remove = (): void => {
        if (removed) return;
        removed = true;
        root.remove();
      };
      // transitionend can be swallowed (display changes, reduced motion) — the
      // timeout guarantees the DOM never keeps a dead overlay around.
      root.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 500);
    },
  };
}
