// The original front end's screen, as a pure state machine (no DOM, no
// Preact), so `bun test` drives it. Everything here is read from the
// decompiled C the generated data cites:
//
//   panel_click.c      the pointer walk: hover, press, release, leave; kind 0
//                      fires on the release over it, kind 4 on the press; a
//                      press over no panel plays UI sound 3; every fired panel
//                      plays UI sound 0 before its callback (0x0040b820)
//   panel_callbacks.c  what each panel does
//   screen_sets.c      the gate (BRIEFING, the film strip, Bug Hunt, the
//                      COMPLETED stamp) and the WAITING plates' lock
//   screen_draw.c      the animated menus' one shared countdown (0x42)
//   frame_step_game.c  a won Precinct Assault level: the map's progress
//
// The screen is one of two sets (screens.json `screen_sets`): `pa_1p`, solo
// against the Sky Captain, and `net_pa`, the networked lobby. Metropolis has
// no Crime War and no local second player, so the PRECINCT ASSAULT / CRIME WAR
// and 1 PLAYER / 2 PLAYER buttons are refused (fcop-fidelity.md "Front end").

import { GUNS, HEAVIES, type Loadout, SPECIALS, type WeaponDef } from "@metropolis/sim";
import { FE_GROUPS, FE_LOADOUT, FE_PA_MAPS, FE_SETS } from "./frontendData.generated";
import type { FeGroup, FeMenu, FePanel, FePicture } from "./types";

export type SetName = keyof typeof FE_SETS;
export type GroupRole = "main" | "left" | "right" | "radio";
/** The draw and click order of a set's four groups (comp_a, comp_b, comp_c, group). */
export const ROLES: readonly GroupRole[] = ["main", "left", "right", "radio"];

// Panel flag bits (fcop/frontend.h).
export const FLAG_HELD = 1;
export const FLAG_OVER = 2;
export const FLAG_HIDDEN = 4;
export const FLAG_DISABLED = 8;
// Menu flag bits.
export const MENU_ANIMATE = 2;
export const MENU_LOCKED = 4;

/** The shared countdown of every animated menu, DAT_004876a8, in ms. */
export const ANIMATE_RELOAD = FE_LOADOUT.timerTicks;

/** UI sound slots (ui_sounds.json). */
export const SND_CLICK = 0;
export const SND_START = 1;
export const SND_LEVEL = 2;
export const SND_REFUSED = 3;
export const SND_DIFFICULTY = 4;
export const SND_LOADOUT = 5;
export const SND_LOADOUT_REFUSED = 8;

/** Precinct Assault map rows (screens.json `pa_maps`); row 5 is Bug Hunt. */
export const PA_ROWS = FE_PA_MAPS.length;
export const BUG_HUNT_ROW = 5;
/** Sky Captain levels 1..10 are sub-picks 0..9; a map's level byte 10 is finished. */
export const LEVELS = 10;
export const LEVEL_FINISHED = 10;

/**
 * The saved-config block's bytes Metropolis keeps (0x00511e00..), the part of
 * the original's 0x44 bytes a Precinct Assault game reads.
 */
export interface FeConfig {
  /** 0x00511e00, the picked PA map row. */
  pick0: number;
  /** 0x00511e07 + map: the level each map has been played up to, 0..10. */
  paLevel: number[];
  /** 0x00511e0d + map: the Sky Captain level picked on each map, 0..9. */
  subpick: number[];
  /** 0x00511e14/15: each player's HARD / NORMAL / EASY entry (0 / 1 / 2). */
  difficulty: number[];
  /** 0x00511e16..1b: each player's three loadout entries, 0..4 per slot. */
  loadout: number[][];
  /** 0x00511e24: Bug Hunt shown (every other map finished). */
  bugHunt: boolean;
  /**
   * Metropolis' "Kampagnenwaffen" game rule (the owner's decision, not the
   * original's): the loadout columns offer each slot's fifth weapon, as the
   * original's do once Crime War sets its option bytes. Off by default, the
   * original's Precinct Assault. A preference: NEW GAME keeps it.
   */
  campaignWeapons: boolean;
}

/** NEW GAME's config (config.c:97-123), Precinct Assault: Metropolis has no Crime War. */
export function newGameConfig(): FeConfig {
  return {
    pick0: 1, // Urban Jungle
    paLevel: [0, 0, 0, 0, 0, 0],
    subpick: [0, 0, 0, 0, 0, 0],
    difficulty: [1, 1],
    loadout: [
      [0, 0, 0],
      [0, 0, 0],
    ],
    bugHunt: false,
    campaignWeapons: false,
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return n < lo || n > hi ? fallback : n;
}

/** A stored config back into range; anything malformed takes NEW GAME's value. */
export function normalizeConfig(raw: unknown): FeConfig {
  const base = newGameConfig();
  if (raw === null || typeof raw !== "object") return base;
  const r = raw as Partial<Record<keyof FeConfig, unknown>>;
  const arr = (v: unknown, n: number): unknown[] => (Array.isArray(v) ? v : []).slice(0, n);
  const out = newGameConfig();
  out.pick0 = clampInt(r.pick0, 0, PA_ROWS - 1, base.pick0);
  const lv = arr(r.paLevel, PA_ROWS);
  const sp = arr(r.subpick, PA_ROWS);
  for (let i = 0; i < PA_ROWS; i++) {
    out.paLevel[i] = clampInt(lv[i], 0, LEVEL_FINISHED, 0);
    out.subpick[i] = Math.min(clampInt(sp[i], 0, LEVELS - 1, 0), out.paLevel[i]);
  }
  const df = arr(r.difficulty, 2);
  for (let p = 0; p < 2; p++) out.difficulty[p] = clampInt(df[p], 0, 2, 1);
  out.campaignWeapons = r.campaignWeapons === true;
  const lo = arr(r.loadout, 2);
  for (let p = 0; p < 2; p++) {
    const row = arr(lo[p], 3);
    for (let s = 0; s < 3; s++) {
      const e = clampInt(row[s], 0, 4, 0);
      out.loadout[p][s] = entryAllowed(s, e, out.campaignWeapons) ? e : 0;
    }
  }
  out.bugHunt = bugHuntUnlocked(out.paLevel);
  if (out.pick0 === BUG_HUNT_ROW && !out.bugHunt) out.pick0 = base.pick0;
  return out;
}

// --- the loadout --------------------------------------------------------------

/**
 * The option bytes 0x00511e04..06, which only the Crime War campaign's
 * scripts set (each slot's fifth weapon). Metropolis has no campaign: zero,
 * unless the "Kampagnenwaffen" rule is on, which sets all three -- the
 * original's rule with the bytes a finished campaign leaves.
 */
export function optionBytes(campaign: boolean): readonly number[] {
  return campaign ? [1, 1, 1] : [0, 0, 0];
}

/**
 * Whether the original's arrows may land on an entry (panel_callbacks.c:483-563):
 * the availability row outside the campaign, and entry 4 skipped while the
 * slot's option byte is zero.
 */
export function originalAllows(slot: number, entry: number, campaign = false): boolean {
  if (entry === 4 && optionBytes(campaign)[slot] === 0) return false;
  return FE_LOADOUT.availabilityOutsideCampaign[slot * 5 + entry] === 1;
}

/** The weapon a slot's entry names (the front end's picture, its own name). */
export function entryWeapon(slot: number, entry: number): string {
  return FE_LOADOUT.slots[slot].entries[entry].weapon;
}

const SIM_LISTS: readonly (readonly WeaponDef[])[] = [GUNS, HEAVIES, SPECIALS];

/** The sim catalogue index of a slot's entry, matched by name; -1 when the sim lacks it. */
export function simIndexOf(slot: number, entry: number): number {
  const name = entryWeapon(slot, entry);
  return SIM_LISTS[slot].findIndex((w) => w.name === name);
}

/** The front end's entry of a sim catalogue index (0 when unknown). */
export function entryOfSim(slot: number, index: number): number {
  const name = SIM_LISTS[slot][index]?.name;
  const e = FE_LOADOUT.slots[slot].entries.findIndex((x) => x.weapon === name);
  return e < 0 ? 0 : e;
}

/**
 * Whether Metropolis offers an entry: the original's rule, and a weapon the
 * sim has. With no campaign the two agree on all ten (menuFrontend.test.ts);
 * under the "Kampagnenwaffen" rule the fifth entries join once the sim's
 * catalogue carries them by name.
 */
export function entryAllowed(slot: number, entry: number, campaign = false): boolean {
  return originalAllows(slot, entry, campaign) && simIndexOf(slot, entry) >= 0;
}

/** A column's entries with anything the rule no longer offers back on entry 0. */
export function allowedEntries(entries: readonly number[], campaign: boolean): number[] {
  return entries.map((e, slot) => (entryAllowed(slot, e, campaign) ? e : 0));
}

/** A column's three entries as the sim's loadout. */
export function loadoutOfEntries(entries: readonly number[]): Loadout {
  const at = (slot: number): number => Math.max(0, simIndexOf(slot, entries[slot]));
  return { gun: at(0), heavy: at(1), special: at(2) };
}

/** The sim's loadout as a column's entries. */
export function entriesOfLoadout(l: Loadout): number[] {
  return [entryOfSim(0, l.gun), entryOfSim(1, l.heavy), entryOfSim(2, l.special)];
}

/**
 * One loadout arrow (0x00409fe0): steps the slot's menu, wrapping, until it
 * lands on an allowed entry. Answers the new entry; equal to `entry` when
 * nothing else is allowed (UI sound 8 then, 5 when it moved).
 */
export function stepLoadout(
  slot: number,
  entry: number,
  forward: boolean,
  campaign = false,
): number {
  let e = entry;
  // Retail loops until it lands; five steps reach every entry once.
  for (let i = 0; i < 5; i++) {
    e = forward ? (e + 1) % 5 : (e + 4) % 5;
    if (entryAllowed(slot, e, campaign)) return e;
  }
  return entry;
}

/** HARD / NORMAL / EASY chevron (0x0040a4c0): ordinal 6 steps back, 7 forward, wrapping. */
export function stepDifficulty(entry: number, ordinal: number): number {
  return ordinal === 6 ? (entry + 2) % 3 : (entry + 1) % 3;
}

// --- the Sky Captain level and the maps' progress ------------------------------

/**
 * A level chevron (0x0040ac20): ordinal 0 up while the shown level is below
 * the map's reached level, ordinal 1 down while above 0; the menu wraps, so on
 * a finished map (level byte 10) up from level 10 lands on level 1. Answers
 * the new sub-pick, or null for a refused (silent) press.
 */
export function stepLevel(sub: number, reached: number, ordinal: number): number | null {
  if (ordinal === 0) {
    if (sub >= reached) return null;
    return (sub + 1) % LEVELS;
  }
  if (sub === 0) return null;
  return sub - 1;
}

/** 0x00409630's loop: Bug Hunt is shown once the first five maps are finished. */
export function bugHuntUnlocked(paLevel: readonly number[]): boolean {
  for (let i = 0; i < BUG_HUNT_ROW; i++) if (paLevel[i] <= 9) return false;
  return true;
}

/** COMPLETED and the film strip (frontend_gate_panels): the picked map's level byte past 9. */
export function mapFinished(config: FeConfig, row: number = config.pick0): boolean {
  return config.paLevel[row] > 9;
}

/**
 * A won Precinct Assault match against the Sky Captain (frame_step_game.c,
 * 0x00409630): only a win at the map's picked level counts, and only at the
 * level the map has been played up to (or on a finished map). Below level 9
 * the map moves on a level, sub-pick and reached level together; from 9 the
 * map is finished (level byte 10) and Bug Hunt's gate is asked again.
 * Answers whether the config changed.
 */
export function recordPaWin(config: FeConfig, row: number, playedSub: number): boolean {
  if (row < 0 || row >= PA_ROWS) return false;
  const sub = config.subpick[row];
  if (sub !== playedSub) return false;
  const level = config.paLevel[row];
  if (!(sub >= level || level === LEVEL_FINISHED)) return false;
  if (level < 9) {
    config.subpick[row] = sub + 1;
    config.paLevel[row] = level + 1;
  } else {
    config.paLevel[row] = LEVEL_FINISHED;
    config.bugHunt = bugHuntUnlocked(config.paLevel);
  }
  return true;
}

/** The PA row of a Metropolis arena id, -1 for none. */
export function rowOfMap(mapId: string): number {
  return FE_PA_MAPS.findIndex((m) => m.mapId === mapId);
}

// --- the screen -----------------------------------------------------------------

export interface FeNet {
  /** This side hosts: only the host picks the map (net_lock). */
  hosting: boolean;
  /** The "Connected To:" second line. */
  peer: string;
  /** The host's "Kampagnenwaffen" rule, which the lobby shows on both sides. */
  campaignWeapons: boolean;
}

export interface FeScreen {
  set: SetName;
  config: FeConfig;
  /** Held / over bits of every panel, per group key. */
  flags: Record<string, number[]>;
  /** The animated menus' selection, per group key and menu index. */
  anim: Record<string, number[]>;
  /** DAT_004876a8, ms. */
  timer: number;
  pointerX: number;
  pointerY: number;
  buttons: number;
  /** The networked lobby's side; null on the offline set. */
  net: FeNet | null;
  /** The lobby's ready bits, which unlock the WAITING plates. */
  ready: [boolean, boolean];
}

/**
 * Whether the "Kampagnenwaffen" rule is on for this screen: the config's
 * offline, the host's in the networked lobby.
 */
export function campaignRule(screen: FeScreen): boolean {
  return screen.net ? screen.net.campaignWeapons : screen.config.campaignWeapons;
}

export function groupOf(screen: FeScreen, role: GroupRole): FeGroup {
  return FE_GROUPS[FE_SETS[screen.set][role]];
}

export function createScreen(config: FeConfig, set: SetName = "pa_1p"): FeScreen {
  const flags: Record<string, number[]> = {};
  const anim: Record<string, number[]> = {};
  for (const key of Object.keys(FE_GROUPS)) {
    const g = FE_GROUPS[key];
    flags[key] = g.panels.map(() => 0);
    anim[key] = g.menus.map((m) => m.selected);
  }
  return {
    set,
    config,
    flags,
    anim,
    timer: ANIMATE_RELOAD,
    pointerX: -1,
    pointerY: -1,
    buttons: 0,
    net: null,
    ready: [false, false],
  };
}

/** Into the networked lobby (HOST / JOIN accepted) or back out of it (CANCEL). */
export function enterSet(screen: FeScreen, set: SetName, net: FeNet | null): void {
  screen.set = set;
  screen.net = net;
  screen.ready = [false, false];
  for (const key of Object.keys(screen.flags)) screen.flags[key].fill(0);
}

/** Which column a group is: 0 left, 1 right, -1 neither. */
function columnOf(group: FeGroup): number {
  if (group.key === "column_left") return 0;
  if (group.key === "column_right") return 1;
  return -1;
}

/**
 * The loadout and difficulty a column shows. On the networked set they are the
 * defaults: Metropolis' online handshake carries neither (fcop-fidelity.md F9).
 */
export function columnPicks(
  screen: FeScreen,
  which: number,
): { loadout: number[]; difficulty: number } {
  if (screen.net) return { loadout: [0, 0, 0], difficulty: 1 };
  return { loadout: screen.config.loadout[which], difficulty: screen.config.difficulty[which] };
}

/**
 * The flags a panel is drawn and clicked with: its held / over bits plus what
 * the gate says (frontend_gate_panels, 0x0040b0c0) -- a radio panel lit when
 * its row is the pick.
 */
export function panelFlags(screen: FeScreen, group: FeGroup, index: number): number {
  const p = group.panels[index];
  let f = screen.flags[group.key][index];
  const c = screen.config;
  if (p.callback === "frontend_panel_radio") {
    f = (f & ~FLAG_HELD) | (p.ordinal === c.pick0 ? FLAG_HELD : 0);
    if (p.ordinal === BUG_HUNT_ROW && !c.bugHunt) f |= FLAG_HIDDEN;
  }
  if (p.callback === "frontend_panel_replay") {
    // No movie to replay in a lobby; offline, only a finished map offers it.
    if (screen.net || !mapFinished(c)) f |= FLAG_DISABLED;
  }
  if (p.callback === "frontend_panel_briefing") f |= FLAG_DISABLED; // PA: always
  // Metropolis: the online handshake carries no loadout or difficulty, so the
  // lobby's columns offer nothing to press (fcop-fidelity.md F9).
  if (screen.net && columnOf(group) >= 0) f |= FLAG_DISABLED;
  return f;
}

/** The picture a panel shows: pressed while held, hover while over, else plain. */
export function panelPicture(panel: FePanel, flags: number): FePicture | null {
  if (flags & FLAG_DISABLED) return null;
  if (flags & FLAG_HELD && panel.pressed) return panel.pressed;
  if (flags & FLAG_OVER && panel.hover) return panel.hover;
  return panel.plain;
}

/** The entry a menu shows, or -1 while it is locked. */
export function menuSelection(screen: FeScreen, group: FeGroup, index: number): number {
  const m: FeMenu = group.menus[index];
  const c = screen.config;
  const col = columnOf(group);
  if (col >= 0) {
    const picks = columnPicks(screen, col);
    if (index <= 2) return picks.loadout[index];
    if (index <= 5) return picks.loadout[index - 3];
    if (index === 6) return picks.difficulty;
    // Element 10, WAITING: locked until that player is ready (0x0040c970).
    if (index === 10 && !screen.ready[col]) return -1;
    return screen.anim[group.key][index];
  }
  if (group.key === "sky_captain") return c.subpick[c.pick0];
  if (group.key === "radio_pa") {
    if (index === 0) return c.pick0; // the title plates, in row order
    return mapFinished(c) ? 0 : -1; // COMPLETED
  }
  // The mode and players plates: PRECINCT ASSAULT, 1 PLAYER.
  return m.animated ? screen.anim[group.key][index] : m.selected;
}

/**
 * One frontend step for the animated menus (0x0040b500), over the set's first
 * three groups as frontend_step updates them: every unlocked animated menu
 * charges `deltaMs` against the one countdown and steps on a negative result.
 * Answers whether anything moved.
 */
export function tickMenus(screen: FeScreen, deltaMs: number): boolean {
  let moved = false;
  for (const role of ["main", "left", "right"] as const) {
    const g = groupOf(screen, role);
    for (let i = 0; i < g.menus.length; i++) {
      const m = g.menus[i];
      if (!(m.flags & MENU_ANIMATE)) continue;
      if (menuSelection(screen, g, i) < 0) continue; // locked
      screen.timer -= deltaMs;
      if (screen.timer < 0) {
        screen.timer = ANIMATE_RELOAD;
        const a = screen.anim[g.key];
        a[i] = (a[i] + 1) % m.entries.length;
        moved = true;
      }
    }
  }
  return moved;
}

// --- the pointer -------------------------------------------------------------------

/** What a panel's callback asks of the menu beyond the screen itself. */
export type FeAction =
  | "new_game"
  | "load_game"
  | "save_game"
  | "host"
  | "join"
  | "options"
  | "start"
  | "cancel"
  | "refused_help"
  | "refused_quit"
  | "refused_players"
  | "refused_mode"
  | "refused_briefing"
  | "refused_replay";

export interface FeResult {
  /** UI sound slots, in the order the original plays them. */
  sounds: number[];
  actions: FeAction[];
  /** Whether anything drawn changed. */
  redraw: boolean;
}

function emptyResult(): FeResult {
  return { sounds: [], actions: [], redraw: false };
}

function hit(panel: FePanel, x: number, y: number): boolean {
  return x >= panel.x && x < panel.x + panel.w && y >= panel.y && y < panel.y + panel.h;
}

/**
 * One panel's share of a pointer event (0x0040b820). Answers whether the
 * button was down over it ("pressed").
 */
function clickPanel(screen: FeScreen, group: FeGroup, index: number, out: FeResult): boolean {
  const panel = group.panels[index];
  const own = screen.flags[group.key];
  const before = panelFlags(screen, group, index);
  if (before & (FLAG_HIDDEN | FLAG_DISABLED)) return false;
  let flags = before;
  let fire = false;
  let pressed = false;
  const kind = panel.kind;
  if (hit(panel, screen.pointerX, screen.pointerY)) {
    if (kind >= 0 && kind <= 3) flags |= FLAG_OVER; // 0x0040bb00
    if (screen.buttons & 1) {
      // 0x0040ba50: kind 0 held; kinds 1 and 4 held and fire.
      flags |= FLAG_HELD;
      if (kind === 1 || kind === 4) fire = true;
      pressed = true;
    } else if (kind === 0) {
      // 0x0040bad0: a held kind-0 button fires on the release over it.
      if (flags & FLAG_HELD) fire = true;
      flags &= ~FLAG_HELD;
    }
  } else if (kind >= 0 && kind <= 3) {
    flags &= ~(FLAG_HELD | FLAG_OVER); // 0x0040bb20
  }

  if (flags !== before) {
    out.redraw = true;
    if (panel.repaint) {
      if (panel.callback === "frontend_panel_radio" && radioRefused(screen)) {
        out.sounds.push(SND_REFUSED); // 0x0040b92a; flags = 0, nothing fired
        own[index] = 0;
        return false;
      }
      own.fill(0); // 0x0040ba20: the whole group dark, then this one back
    }
    own[index] = flags & (FLAG_HELD | FLAG_OVER);
  }
  if (fire) {
    out.sounds.push(SND_CLICK);
    runCallback(screen, panel, out);
  }
  return pressed;
}

/** A joiner's map press is refused (radio_refused: link up, not hosting). */
function radioRefused(screen: FeScreen): boolean {
  return screen.net !== null && !screen.net.hosting;
}

function walk(screen: FeScreen, out: FeResult): boolean {
  let pressed = false;
  for (const role of ROLES) {
    const g = groupOf(screen, role);
    for (let i = 0; i < g.panels.length; i++) pressed = clickPanel(screen, g, i, out) || pressed;
  }
  return pressed;
}

/** WM_MOUSEMOVE (0x0040bb40): a moved pointer walks every panel. */
export function pointerMove(screen: FeScreen, x: number, y: number): FeResult {
  const out = emptyResult();
  if (x === screen.pointerX && y === screen.pointerY) return out;
  screen.pointerX = x;
  screen.pointerY = y;
  walk(screen, out);
  return out;
}

/**
 * A button down or up (0x0040bbe0): left is mask 1, middle 2, right 4; only
 * bit 0 presses, and a down over no panel plays UI sound 3.
 */
export function pointerButton(
  screen: FeScreen,
  x: number,
  y: number,
  mask: number,
  down: boolean,
): FeResult {
  const out = emptyResult();
  screen.pointerX = x;
  screen.pointerY = y;
  const buttons = down ? screen.buttons | mask : screen.buttons & ~mask;
  if (buttons === screen.buttons) return out;
  screen.buttons = buttons;
  const pressed = walk(screen, out);
  if (down && !pressed) out.sounds.push(SND_REFUSED);
  return out;
}

/** The pointer left the screen: nothing is over a panel any more. */
export function pointerLeave(screen: FeScreen): FeResult {
  return pointerMove(screen, -1, -1);
}

// --- the callbacks -------------------------------------------------------------------

function runCallback(screen: FeScreen, panel: FePanel, out: FeResult): void {
  const c = screen.config;
  const refuse = (action: FeAction): void => {
    out.sounds.push(SND_REFUSED);
    out.actions.push(action);
  };
  switch (panel.callback) {
    case "frontend_panel_new_game":
      out.actions.push("new_game");
      return;
    case "frontend_panel_load_game":
      out.actions.push("load_game");
      return;
    case "frontend_panel_save_game":
      out.actions.push("save_game");
      return;
    case "frontend_panel_host":
      out.actions.push("host");
      return;
    case "frontend_panel_join":
      out.actions.push("join");
      return;
    case "frontend_panel_options":
      out.actions.push("options");
      return;
    case "frontend_panel_cancel":
      out.actions.push("cancel");
      return;
    case "frontend_panel_start":
      out.sounds.push(SND_START);
      out.actions.push("start");
      return;
    // The original plays a movie the repo does not have (multibrf.mpg) ...
    case "frontend_panel_help":
      refuse("refused_help");
      return;
    case "frontend_panel_briefing":
      refuse("refused_briefing");
      return;
    case "frontend_panel_replay":
      refuse("refused_replay");
      return;
    // ... quits to a desktop a browser does not have ...
    case "frontend_panel_quit":
      refuse("refused_quit");
      return;
    // ... and steps a second local player and a Crime War Metropolis lacks.
    case "frontend_panel_players":
      refuse("refused_players");
      return;
    case "frontend_panel_game_mode":
      refuse("refused_mode");
      return;
    case "frontend_panel_column_arrow_0":
    case "frontend_panel_column_arrow_1": {
      const which = panel.callback.endsWith("1") ? 1 : 0;
      if (panel.ordinal > 5) return;
      const slot = panel.ordinal % 3;
      const before = c.loadout[which][slot];
      const now = stepLoadout(slot, before, panel.ordinal < 3, campaignRule(screen));
      c.loadout[which][slot] = now;
      out.sounds.push(now !== before ? SND_LOADOUT : SND_LOADOUT_REFUSED);
      out.redraw = true;
      return;
    }
    case "frontend_panel_pick_chevron_0":
    case "frontend_panel_pick_chevron_1": {
      const which = panel.callback.endsWith("1") ? 1 : 0;
      c.difficulty[which] = stepDifficulty(c.difficulty[which], panel.ordinal);
      out.sounds.push(SND_DIFFICULTY);
      out.redraw = true;
      return;
    }
    case "frontend_panel_radio":
      // The row whose ordinal is the panel's becomes pick 0; the title plate,
      // the level picker (from the map's saved level), the gate and the stamp
      // follow from it.
      c.pick0 = panel.ordinal;
      out.redraw = true;
      return;
    case "frontend_panel_level": {
      const next = stepLevel(c.subpick[c.pick0], c.paLevel[c.pick0], panel.ordinal);
      if (next === null) return; // a refused press is silent
      c.subpick[c.pick0] = next;
      out.sounds.push(SND_LEVEL);
      out.redraw = true;
      return;
    }
  }
}
