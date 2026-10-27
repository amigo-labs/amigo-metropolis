// The original front end's screen model (menu/frontend/model.ts) against the
// RE's data and the decompiled C it cites. No DOM: the model is pure.

import { describe, expect, test } from "bun:test";
import { GUNS, HEAVIES, MAP_REGISTRY, SPECIALS } from "@metropolis/sim";
import {
  FE_GROUPS,
  FE_LOADOUT,
  FE_PA_MAPS,
  FE_SETS,
} from "../src/menu/frontend/frontendData.generated";
import {
  ANIMATE_RELOAD,
  allowedEntries,
  BUG_HUNT_ROW,
  bugHuntUnlocked,
  createScreen,
  EXTRA_ALL,
  EXTRA_K9_DRONE,
  EXTRA_PLASMA_FLARE,
  EXTRA_WEAPONS,
  enterSet,
  entriesOfLoadout,
  entryAllowed,
  entryWeapon,
  extraBitOf,
  extraRule,
  type FeScreen,
  FLAG_DISABLED,
  FLAG_HELD,
  FLAG_HIDDEN,
  groupOf,
  LEVEL_FINISHED,
  loadoutOfEntries,
  mapFinished,
  menuSelection,
  newGameConfig,
  normalizeConfig,
  originalAllows,
  panelFlags,
  panelPicture,
  pointerButton,
  pointerMove,
  recordPaWin,
  rowOfMap,
  SND_CLICK,
  SND_DIFFICULTY,
  SND_LEVEL,
  SND_LOADOUT,
  SND_REFUSED,
  SND_START,
  simIndexOf,
  stepDifficulty,
  stepLevel,
  stepLoadout,
  tickMenus,
} from "../src/menu/frontend/model";
import {
  EMPTY_SLOT,
  emptySaveFile,
  finishedMapEndsSession,
  loadFromSlot,
  parseSaveFile,
  saveToSlot,
  slotNames,
} from "../src/menu/frontend/progress";
import { stageScale, toScreen } from "../src/menu/frontend/stage";

function panel(screen: FeScreen, groupKey: string, callback: string, ordinal: number) {
  const g = FE_GROUPS[groupKey];
  const p = g.panels.find((x) => x.callback === callback && x.ordinal === ordinal);
  if (!p) throw new Error(`${groupKey} has no ${callback} ${ordinal}`);
  void screen;
  return p;
}

/** A click at a panel's top-left pixel: move, press, release. */
function click(screen: FeScreen, x: number, y: number) {
  const sounds: number[] = [];
  const actions: string[] = [];
  for (const r of [
    pointerMove(screen, x, y),
    pointerButton(screen, x, y, 1, true),
    pointerButton(screen, x, y, 1, false),
  ]) {
    sounds.push(...r.sounds);
    actions.push(...r.actions);
  }
  return { sounds, actions };
}

describe("the screen data", () => {
  test("solo is the PA one-player set, online the networked PA set", () => {
    expect(FE_SETS.pa_1p).toMatchObject({
      main: "main_offline",
      left: "column_left",
      right: "sky_captain",
      radio: "radio_pa",
    });
    expect(FE_SETS.net_pa).toMatchObject({
      main: "main_network",
      left: "column_left",
      right: "column_right",
      radio: "radio_pa",
    });
  });

  test("the main group: backdrop bmp064 at (0, 0), the eight buttons at x 68, START at (420, 291)", () => {
    const g = FE_GROUPS.main_offline;
    expect(g.origin).toEqual([0, 0]);
    expect(g.backdrop?.file).toBe("bmp064.png");
    const left = g.panels.filter((p) => p.x === 68).map((p) => [p.callback.slice(15), p.y]);
    expect(left).toEqual([
      ["new_game", 32],
      ["load_game", 62],
      ["save_game", 92],
      ["host", 147],
      ["join", 177],
      ["options", 229],
      ["help", 259],
      ["quit", 289],
    ]);
    const start = g.panels.find((p) => p.callback === "frontend_panel_start");
    expect([start?.x, start?.y, start?.kind]).toEqual([420, 291, 0]);
  });

  test("the six map buttons are radio panels at the original's places, Bug Hunt the sixth", () => {
    const g = FE_GROUPS.radio_pa;
    const radios = g.panels.filter((p) => p.kind === 4);
    expect(radios.map((p) => [p.ordinal, p.x, p.y, p.pressed?.file])).toEqual([
      [0, 321, 145, "bmp089.png"],
      [1, 490, 171, "bmp138.png"],
      [2, 419, 136, "bmp041.png"],
      [3, 443, 230, "bmp141.png"],
      [4, 484, 97, "bmp011.png"],
      [5, 342, 165, "bmp009.png"],
    ]);
    expect(radios.every((p) => p.plain === null)).toBe(true);
    expect(FE_PA_MAPS.map((m) => m.mapId)).toEqual([
      "proving-ground",
      "urban-jungle",
      "hollywood-keys",
      "venice-beach",
      "la-cantina",
      "bug-hunt",
    ]);
    expect(FE_PA_MAPS[4].loading).toBe("Load.png");
  });

  test("every PA row is a Metropolis arena, and every arena a PA row", () => {
    const ids = new Set(MAP_REGISTRY.map((m) => m.id));
    for (const m of FE_PA_MAPS) expect(ids.has(m.mapId)).toBe(true);
    for (const m of MAP_REGISTRY) expect(rowOfMap(m.id)).toBeGreaterThanOrEqual(0);
  });
});

describe("the pointer", () => {
  test("a kind-0 button lights while held and fires on the release over it", () => {
    const s = createScreen(newGameConfig());
    const g = groupOf(s, "main");
    const i = g.panels.findIndex((p) => p.callback === "frontend_panel_options");
    pointerMove(s, 70, 230);
    const down = pointerButton(s, 70, 230, 1, true);
    expect(down.sounds).toEqual([]);
    expect(panelFlags(s, g, i) & FLAG_HELD).toBe(FLAG_HELD);
    expect(panelPicture(g.panels[i], panelFlags(s, g, i))?.file).toBe("bmp092.png");
    const up = pointerButton(s, 70, 230, 1, false);
    expect(up.sounds).toEqual([SND_CLICK]);
    expect(up.actions).toEqual(["options"]);
  });

  test("a press that slides off fires nothing", () => {
    const s = createScreen(newGameConfig());
    pointerMove(s, 70, 230);
    pointerButton(s, 70, 230, 1, true);
    pointerMove(s, 5, 5);
    expect(pointerButton(s, 5, 5, 1, false).actions).toEqual([]);
  });

  test("a press over no panel plays UI sound 3", () => {
    const s = createScreen(newGameConfig());
    expect(pointerButton(s, 5, 5, 1, true).sounds).toEqual([SND_REFUSED]);
    // A right press reaches every panel as "up": also sound 3.
    const t = createScreen(newGameConfig());
    expect(pointerButton(t, 70, 230, 4, true).sounds).toEqual([SND_REFUSED]);
  });

  test("START plays 0 then 1 and asks for the start", () => {
    const s = createScreen(newGameConfig());
    expect(click(s, 421, 292)).toEqual({ sounds: [SND_CLICK, SND_START], actions: ["start"] });
  });

  test("a map press fires on the press, lights it alone and picks the row", () => {
    const s = createScreen(newGameConfig());
    expect(s.config.pick0).toBe(1); // Urban Jungle
    pointerMove(s, 485, 98);
    const r = pointerButton(s, 485, 98, 1, true);
    expect(r.sounds).toEqual([SND_CLICK]);
    expect(s.config.pick0).toBe(4); // La Cantina
    const g = groupOf(s, "radio");
    const lit = g.panels.filter((_, i) => panelFlags(s, g, i) & FLAG_HELD).map((p) => p.ordinal);
    expect(lit).toEqual([4]);
    expect(menuSelection(s, g, 0)).toBe(4); // the title plate
  });

  test("the PA/CW and 1P/2P buttons and QUIT are refused with sound 3", () => {
    for (const [x, y, action] of [
      [466, 33, "refused_mode"],
      [466, 63, "refused_players"],
      [70, 290, "refused_quit"],
    ] as const) {
      const s = createScreen(newGameConfig());
      expect(click(s, x, y)).toEqual({ sounds: [SND_CLICK, SND_REFUSED], actions: [action] });
    }
  });

  test("HELP asks for its movie with sound 0 alone (the menu refuses when it cannot play)", () => {
    const s = createScreen(newGameConfig());
    expect(click(s, 70, 260)).toEqual({ sounds: [SND_CLICK], actions: ["help"] });
  });

  test("BRIEFING is disabled in Precinct Assault: not drawn, a press there is over nothing", () => {
    const s = createScreen(newGameConfig());
    const g = groupOf(s, "main");
    const i = g.panels.findIndex((p) => p.callback === "frontend_panel_briefing");
    expect(panelFlags(s, g, i) & FLAG_DISABLED).toBe(FLAG_DISABLED);
    expect(pointerButton(s, 276, 292, 1, true).sounds).toEqual([SND_REFUSED]);
  });

  test("on the networked set a joiner's map press is refused, a host's is not", () => {
    const s = createScreen(newGameConfig());
    enterSet(s, "net_pa", { hosting: false, peer: "x", extraWeapons: 0 });
    pointerMove(s, 485, 98);
    // The refusal answers "not pressed", so the press is also over nothing:
    // sound 3 twice, as retail's 0x0040b92a and 0x0040bccc both play it.
    expect(pointerButton(s, 485, 98, 1, true).sounds).toEqual([SND_REFUSED, SND_REFUSED]);
    expect(s.config.pick0).toBe(1);
    const h = createScreen(newGameConfig());
    enterSet(h, "net_pa", { hosting: true, peer: "x", extraWeapons: 0 });
    pointerMove(h, 485, 98);
    pointerButton(h, 485, 98, 1, true);
    expect(h.config.pick0).toBe(4);
  });
});

describe("the loadout column", () => {
  test("the original's rule offers exactly the ten weapons the sim always has", () => {
    // The sim's other five wait on their switches (SimOptions.extraWeapons).
    const lists = [GUNS, HEAVIES, SPECIALS];
    for (let slot = 0; slot < 3; slot++) {
      for (let e = 0; e < 5; e++) {
        const i = simIndexOf(slot, e);
        expect(i >= 0).toBe(true); // every entry names a sim weapon now
        expect(originalAllows(slot, e)).toBe(lists[slot][i].extraBit === 0);
        expect(entryAllowed(slot, e)).toBe(originalAllows(slot, e));
        // The menu's switch is the sim's bit.
        expect(extraBitOf(slot, e)).toBe(lists[slot][i].extraBit);
      }
    }
    const offered = [0, 1, 2].map((s) => [0, 1, 2, 3, 4].filter((e) => entryAllowed(s, e)).length);
    expect(offered).toEqual(lists.map((l) => l.filter((w) => w.extraBit === 0).length));
    const all = [0, 1, 2].map(
      (s) => [0, 1, 2, 3, 4].filter((e) => entryAllowed(s, e, EXTRA_ALL)).length,
    );
    expect(all).toEqual([GUNS.length, HEAVIES.length, SPECIALS.length]);
  });

  test("outside the campaign 13 of 15 are available; the three fifths need Crime War", () => {
    const avail = FE_LOADOUT.availabilityOutsideCampaign.filter((v) => v === 1).length;
    expect(avail).toBe(13);
    const fifths = FE_LOADOUT.slots.map((s) => s.entries[4].weapon);
    expect(fifths).toEqual(["Riot Shield", "K-9 Drone", "Grenade Launcher"]);
    for (let slot = 0; slot < 3; slot++) expect(entryAllowed(slot, 4)).toBe(false);
  });

  test("an arrow steps, wrapping, past the entries it may not land on", () => {
    // Heavy: Hell Fire, Concussion, Hyper Velocity, (Fusion Torpedo), (K-9 Drone).
    expect(stepLoadout(1, 2, true)).toBe(0);
    expect(stepLoadout(1, 0, false)).toBe(2);
    // Special: Mortar, Mines, (Plasma Flare), Shockwave, (Grenade).
    expect(stepLoadout(2, 1, true)).toBe(3);
    expect(stepLoadout(2, 3, true)).toBe(0);
  });

  test("a moved arrow plays 0 then 5", () => {
    const s = createScreen(newGameConfig());
    expect(click(s, 154, 334).sounds).toEqual([SND_CLICK, SND_LOADOUT]);
    expect(s.config.loadout[0][0]).toBe(1);
  });

  test("the front end's entries map to the sim's catalogue by name, both ways", () => {
    expect(loadoutOfEntries([1, 2, 3])).toEqual({ gun: 2, heavy: 2, special: 2 });
    expect(entriesOfLoadout({ gun: 2, heavy: 2, special: 2 })).toEqual([1, 2, 3]);
    expect(GUNS[loadoutOfEntries([1, 0, 0]).gun].name).toBe("Flamethrower");
  });

  test("the difficulty chevrons: right steps back, left forward, wrapping, sound 4", () => {
    expect(stepDifficulty(1, 6)).toBe(0);
    expect(stepDifficulty(0, 6)).toBe(2);
    expect(stepDifficulty(2, 7)).toBe(0);
    const s = createScreen(newGameConfig());
    const r = click(s, 4, 454); // the left chevron, ordinal 7
    expect(r.sounds).toEqual([SND_CLICK, SND_DIFFICULTY]);
    expect(s.config.difficulty[0]).toBe(2); // NORMAL -> EASY
  });

  test("online this side edits its own column and sees the peer's, whose arrows refuse", () => {
    const s = createScreen(newGameConfig());
    s.config.loadout[0] = [1, 1, 1];
    enterSet(s, "net_pa", {
      hosting: true,
      peer: "x",
      extraWeapons: 0,
      peerPicks: { loadout: [3, 2, 3], difficulty: 0 },
    });
    const left = groupOf(s, "left");
    const right = groupOf(s, "right");
    expect(menuSelection(s, left, 0)).toBe(1);
    expect(menuSelection(s, right, 0)).toBe(3);
    expect(menuSelection(s, right, 6)).toBe(0); // HARD
    expect(panelFlags(s, left, 0) & (FLAG_HIDDEN | FLAG_DISABLED)).toBe(0);
    // 0x0040c430: the other column's rows and chevrons hidden -- drawn, refused.
    expect(panelFlags(s, right, 0) & FLAG_HIDDEN).toBe(FLAG_HIDDEN);
    expect(panelFlags(s, right, 7) & FLAG_HIDDEN).toBe(FLAG_HIDDEN);
    expect(click(s, 154, 334).actions).toEqual(["net_loadout"]);
    expect(s.config.loadout[0][0]).toBe(2);
    const before = s.config.loadout[1].slice();
    expect(click(s, 480, 334).actions).toEqual([]);
    expect(s.config.loadout[1]).toEqual(before);
    expect(click(s, 4, 454).actions).toEqual(["net_difficulty"]);
  });

  test("the joiner edits the right column (player 2), the host's map is not its to press", () => {
    const s = createScreen(newGameConfig());
    enterSet(s, "net_pa", { hosting: false, peer: "x", extraWeapons: 0 });
    expect(click(s, 480, 334).actions).toEqual(["net_loadout"]);
    expect(s.config.loadout[1][0]).toBe(1);
    expect(panelFlags(s, groupOf(s, "left"), 0) & FLAG_HIDDEN).toBe(FLAG_HIDDEN);
  });
});

describe("the Spielregeln: five extra-weapon switches (the owner's, all off)", () => {
  test("each extra entry is offered exactly while its switch is on", () => {
    expect(newGameConfig().extraWeapons).toBe(0);
    expect(EXTRA_WEAPONS.map((x) => [x.slot, x.entry, entryWeapon(x.slot, x.entry)])).toEqual([
      [0, 4, "Riot Shield"],
      [1, 4, "K-9 Drone"],
      [2, 4, "Grenade Launcher"],
      [1, 3, "Fusion Torpedo"],
      [2, 2, "Plasma Flare"],
    ]);
    for (const x of EXTRA_WEAPONS) {
      expect(originalAllows(x.slot, x.entry)).toBe(false);
      expect(originalAllows(x.slot, x.entry, x.bit)).toBe(true);
      expect(originalAllows(x.slot, x.entry, EXTRA_ALL & ~x.bit)).toBe(false);
      // Offered once the sim's catalogue carries the weapon by its name.
      expect(entryAllowed(x.slot, x.entry, x.bit)).toBe(simIndexOf(x.slot, x.entry) >= 0);
    }
    // Every other entry is the original's rule, whatever the switches.
    for (let slot = 0; slot < 3; slot++) {
      for (let e = 0; e < 5; e++) {
        if (extraBitOf(slot, e) !== 0) continue;
        expect(originalAllows(slot, e, EXTRA_ALL)).toBe(originalAllows(slot, e));
      }
    }
    // The two the original's PA row turns off (DAT_00487610).
    expect(FE_LOADOUT.availabilityOutsideCampaign[1 * 5 + 3]).toBe(0);
    expect(FE_LOADOUT.availabilityOutsideCampaign[2 * 5 + 2]).toBe(0);
  });

  test("off, the arrows keep the original's skip rule", () => {
    expect(stepLoadout(0, 3, true)).toBe(0);
    expect(stepLoadout(2, 1, true)).toBe(3); // past Plasma Flare
    expect(stepLoadout(1, 2, true, EXTRA_K9_DRONE)).toBe(simIndexOf(1, 4) >= 0 ? 4 : 0);
  });

  test("the switches are kept with the config; an entry whose switch is off goes back to 0", () => {
    expect(normalizeConfig({ ...newGameConfig(), extraWeapons: 0b10101 }).extraWeapons).toBe(21);
    expect(normalizeConfig({ ...newGameConfig(), extraWeapons: 99 }).extraWeapons).toBe(0);
    expect(normalizeConfig({ ...newGameConfig(), extraWeapons: "on" }).extraWeapons).toBe(0);
    expect(allowedEntries([4, 3, 2], 0)).toEqual([0, 0, 0]);
    expect(allowedEntries([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  test("the networked screen reads the host's switches, offline the config's", () => {
    const s = createScreen({ ...newGameConfig(), extraWeapons: EXTRA_PLASMA_FLARE });
    expect(extraRule(s)).toBe(EXTRA_PLASMA_FLARE);
    enterSet(s, "net_pa", { hosting: false, peer: "x", extraWeapons: 0 });
    expect(extraRule(s)).toBe(0);
  });
});

describe("the Sky Captain's level and the maps' progress", () => {
  test("a fresh game plays level 1 only: up is refused, silently", () => {
    expect(stepLevel(0, 0, 0)).toBeNull();
    expect(stepLevel(0, 0, 1)).toBeNull();
    const s = createScreen(newGameConfig());
    const p = panel(s, "sky_captain", "frontend_panel_level", 0);
    expect(click(s, p.x, p.y).sounds).toEqual([SND_CLICK]);
  });

  test("the chevrons stop at the map's reached level, and wrap past 10 on a finished map", () => {
    expect(stepLevel(2, 3, 0)).toBe(3);
    expect(stepLevel(3, 3, 0)).toBeNull();
    expect(stepLevel(3, 3, 1)).toBe(2);
    expect(stepLevel(9, LEVEL_FINISHED, 0)).toBe(0);
    const s = createScreen(newGameConfig());
    s.config.paLevel[1] = 2;
    const p = panel(s, "sky_captain", "frontend_panel_level", 0);
    expect(click(s, p.x, p.y).sounds).toEqual([SND_CLICK, SND_LEVEL]);
    expect(s.config.subpick[1]).toBe(1);
  });

  test("a win at the frontier moves the map a level; a win below it does not", () => {
    const c = newGameConfig();
    expect(recordPaWin(c, 0, 0)).toBe(true);
    expect([c.subpick[0], c.paLevel[0]]).toEqual([1, 1]);
    c.subpick[0] = 0; // replaying level 1
    expect(recordPaWin(c, 0, 0)).toBe(false);
    expect(c.paLevel[0]).toBe(1);
    // A win at a level other than the picked one is not this map's.
    c.subpick[0] = 1;
    expect(recordPaWin(c, 0, 4)).toBe(false);
  });

  test("winning level 10 finishes the map: COMPLETED, the film strip offered", () => {
    const c = newGameConfig();
    c.paLevel[2] = 9;
    c.subpick[2] = 9;
    c.pick0 = 2;
    expect(recordPaWin(c, 2, 9)).toBe(true);
    expect(c.paLevel[2]).toBe(LEVEL_FINISHED);
    expect(mapFinished(c)).toBe(true);
    const s = createScreen(c);
    const g = groupOf(s, "radio");
    expect(menuSelection(s, g, 1)).toBe(0); // the stamp
    const film = g.panels.findIndex((p) => p.callback === "frontend_panel_replay");
    expect(panelFlags(s, g, film) & FLAG_DISABLED).toBe(0);
  });

  test("Bug Hunt shows once the first five maps are finished", () => {
    const c = newGameConfig();
    const s = createScreen(c);
    const g = groupOf(s, "radio");
    expect(panelFlags(s, g, BUG_HUNT_ROW) & FLAG_HIDDEN).toBe(FLAG_HIDDEN);
    // Hidden: a press there (clear of Proving Ground's rectangle) is over no panel.
    expect(pointerButton(s, 360, 200, 1, true).sounds).toEqual([SND_REFUSED]);
    for (let row = 0; row < 4; row++) c.paLevel[row] = LEVEL_FINISHED;
    expect(bugHuntUnlocked(c.paLevel)).toBe(false);
    c.paLevel[4] = 9;
    c.subpick[4] = 9;
    recordPaWin(c, 4, 9);
    expect(c.bugHunt).toBe(true);
    expect(panelFlags(s, g, BUG_HUNT_ROW) & FLAG_HIDDEN).toBe(0);
  });

  test("a stored config is brought back into range", () => {
    const c = normalizeConfig({
      pick0: 5,
      paLevel: [10, 3, 99, -1, 0, 0],
      subpick: [9, 7, 0, 0, 0, 0],
      loadout: [[4, 3, 2]],
      difficulty: [7],
    });
    expect(c.pick0).toBe(1); // Bug Hunt is not unlocked
    expect(c.paLevel).toEqual([10, 3, 0, 0, 0, 0]);
    expect(c.subpick.slice(0, 2)).toEqual([9, 3]);
    expect(c.loadout[0]).toEqual([0, 0, 0]);
    expect(c.difficulty).toEqual([1, 1]);
  });
});

describe("the networked lobby's screen", () => {
  const net = (hosting: boolean): FeScreen => {
    const s = createScreen(newGameConfig());
    enterSet(s, "net_pa", { hosting, peer: "x", extraWeapons: 0 });
    return s;
  };
  const startPanel = (s: FeScreen) => {
    const g = groupOf(s, "main");
    return { g, i: g.panels.findIndex((p) => p.callback === "frontend_panel_start") };
  };

  test("START is off while this side is ready; any button takes the ready back first", () => {
    const s = net(true);
    const { g, i } = startPanel(s);
    const p = g.panels[i];
    expect(click(s, p.x, p.y).actions).toEqual(["start"]);
    s.ready[0] = true; // the lobby's answer
    expect(panelFlags(s, g, i) & FLAG_DISABLED).toBe(FLAG_DISABLED);
    // 0x0040bbe0: the press anywhere un-readies before it is walked.
    const r = pointerButton(s, 600, 10, 1, true);
    expect(r.actions).toEqual(["unready"]);
    expect(s.ready[0]).toBe(false);
    expect(panelFlags(s, g, i) & FLAG_DISABLED).toBe(0);
    // The peer's ready bit is not ours to take back.
    pointerButton(s, 600, 10, 1, false);
    s.ready[1] = true;
    expect(pointerButton(s, 600, 10, 1, true).actions).toEqual([]);
  });

  test("WAITING over a ready player, either column", () => {
    const s = net(false);
    s.ready[0] = true;
    expect(menuSelection(s, groupOf(s, "left"), 10)).toBe(0);
    expect(menuSelection(s, groupOf(s, "right"), 10)).toBe(-1);
  });

  test("2 PLAYER on the plate, the mode button the host's alone", () => {
    for (const hosting of [true, false]) {
      const s = net(hosting);
      const g = groupOf(s, "main");
      expect(menuSelection(s, g, 1)).toBe(1);
      const mode = g.panels.findIndex((p) => p.callback === "frontend_panel_game_mode");
      expect((panelFlags(s, g, mode) & FLAG_DISABLED) !== 0).toBe(!hosting);
    }
  });

  test("the host's map press goes to the joiner", () => {
    const s = net(true);
    pointerMove(s, 485, 98);
    expect(pointerButton(s, 485, 98, 1, true).actions).toEqual(["net_map"]);
  });
});

describe("the animated menus", () => {
  test("one shared countdown of 0x42 steps the strips in turn", () => {
    expect(ANIMATE_RELOAD).toBe(0x42);
    const s = createScreen(newGameConfig());
    const g = groupOf(s, "left");
    // Three strips animate in solo; WAITING is locked.
    expect(menuSelection(s, g, 10)).toBe(-1);
    let steps = 0;
    for (let i = 0; i < 100; i++) if (tickMenus(s, 10)) steps++;
    // 3 strips x 100 frames charge 10 ms each against the 66 ms countdown; it
    // steps when the result goes negative, so every seventh charge.
    expect(steps).toBe(Math.floor((3 * 100) / 7));
  });

  test("WAITING shows over a ready player", () => {
    const s = createScreen(newGameConfig());
    s.ready[0] = true;
    expect(menuSelection(s, groupOf(s, "left"), 10)).toBe(0);
  });
});

describe("SAVE GAME and LOAD GAME", () => {
  test("twenty slots, empty ones listed as -EMPTY-", () => {
    const f = emptySaveFile();
    expect(slotNames(f)).toEqual(new Array(20).fill(EMPTY_SLOT));
  });

  test("a save needs a name; a load needs a named slot", () => {
    const f = emptySaveFile();
    const c = newGameConfig();
    c.paLevel[0] = 4;
    expect(saveToSlot(f, 3, "", c)).toBe("Must enter a name.");
    expect(saveToSlot(f, 3, "Sergeant", c)).toBeNull();
    expect(loadFromSlot(f, 2)).toBeNull();
    const back = loadFromSlot(f, 3);
    expect(back?.paLevel[0]).toBe(4);
    expect(parseSaveFile(JSON.parse(JSON.stringify(f))).slots[3]?.name).toBe("Sergeant");
  });
});

describe("the stage", () => {
  test("scales whole when that keeps 80 %, else to fit", () => {
    expect(stageScale(1920, 1080)).toBe(2);
    expect(stageScale(1280, 960)).toBe(2);
    expect(stageScale(1366, 768)).toBeCloseTo(1.6);
    expect(stageScale(320, 240)).toBe(0.5);
  });

  test("a client point to the screen's pixel", () => {
    expect(toScreen(110, 60, 100, 50, 2)).toEqual([5, 5]);
    expect(toScreen(99, 49, 100, 50, 2)).toEqual([-1, -1]);
  });
});

describe("frame_step_game 0x004097a8", () => {
  test("only Bug Hunt, the sixth map, leaves for the front end on another round", () => {
    expect(finishedMapEndsSession("bug-hunt")).toBe(true);
    for (const id of [
      "urban-jungle",
      "proving-ground",
      "la-cantina",
      "hollywood-keys",
      "venice-beach",
    ])
      expect(finishedMapEndsSession(id)).toBe(false);
    expect(finishedMapEndsSession("layered-test")).toBe(false);
  });
});
