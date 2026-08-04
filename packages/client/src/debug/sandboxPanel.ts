// The ?sandbox=1 overlay: place any unit, turret or console in front of the
// camera, swap the avatar's weapon kit live, and pause/step to inspect a pose.
// Built for eyeballing movement and firing animations without playing a match
// up to the moment the thing you wanted to see happens.
//
// Two rules this file has to respect and does:
//
//  * Renderer rule 1 (zero allocations in the frame loop). None of this runs in
//    the frame loop. `refresh()` is called from main.ts's existing 1 Hz HUD
//    cadence and writes only on change, exactly like refreshDebugLabel; the
//    handlers run on user input. `afterTick()` is the one per-tick entry and it
//    only writes numbers into typed arrays.
//  * Determinism. Every sim touch goes through packages/sim/src/sandbox.ts,
//    which is host-side by contract (see its header). main.ts gates the whole
//    panel on !netMode, so nothing here can reach a lockstep match.

import {
  ARCHETYPE,
  clearSandboxSpawns,
  countAlive,
  despawnSandbox,
  GUNS,
  HEAVIES,
  type Loadout,
  type MapData,
  reassertSandboxHp,
  refillSandboxAmmo,
  SANDBOX_SPAWNABLE,
  type SimState,
  SPECIALS,
  sandboxLoadout,
  setSandboxLoadout,
  spawnSandbox,
  UNIT_MODE_ASSAULT,
  UNIT_MODE_PATROL,
  type WeaponDef,
} from "@metropolis/sim";
import type * as THREE from "three";
import { isTextEntryTarget } from "../input/textEntry";
import { rayHitHeightfield } from "./pinCapture";

/** Slow-motion factors offered by the Time row. */
const TIME_SCALES: readonly number[] = [1, 0.5, 0.25];

/**
 * Where to drop things when the view ray never meets terrain (crosshair on the
 * sky): straight ahead at this many metres. When the ray DOES hit — the normal
 * case — the hit itself is the spawn point, so "spawn" means "spawn under the
 * crosshair" with no distance knob to get wrong.
 */
const SKY_FALLBACK_DISTANCE = 40;
/** Spacing of the "Spawn ×5" cross around the aim point, in metres. */
const ARC_RADIUS = 6;

export interface SandboxPanelDeps {
  /** Live sim, or null before a match is seated. */
  readonly getSim: () => SimState | null;
  readonly getMap: () => MapData;
  /** View 0's camera — the panel spawns along its forward axis. */
  readonly getCamera: () => THREE.Camera | null;
  /** Local player slot the weapon and cheat rows act on. */
  readonly getPlayer: () => number;
  /** Shared with the ?debug harness freeze so the two cannot disagree. */
  readonly setPaused: (paused: boolean) => void;
  readonly getPaused: () => boolean;
  /** Runs n ticks through the frame loop's own runTick. */
  readonly step: (ticks: number) => void;
  /** Re-snapshots both interpolation buffers so a paused scene shows the spawn. */
  readonly resnap: () => void;
  readonly setTimeScale: (scale: number) => void;
  readonly getTimeScale: () => number;
  /** Walk-rig readout, or null when the rig has not loaded. */
  readonly rigInfo: () => { legL: number; legR: number; stride: number } | null;
}

export interface SandboxPanel {
  readonly isOpen: () => boolean;
  readonly setOpen: (open: boolean) => void;
  readonly toggle: () => void;
  /** Call from the 1 Hz HUD cadence. */
  readonly refresh: () => void;
  /** Call once per sim tick, after step(). Applies the cheat toggles. */
  readonly afterTick: () => void;
  readonly dispose: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function weaponLabel(w: WeaponDef): string {
  const ammo = w.ammo > 0 ? `${w.ammo} ammo` : "inf";
  return `${w.damage} dmg · ${w.cooldownTicks}t · ${ammo} · ${w.vfx}`;
}

export function createSandboxPanel(deps: SandboxPanelDeps): SandboxPanel {
  const root = el("div", "sbx");
  const tab = el("button", "sbx-tab", "SANDBOX");
  tab.title = "Toggle the sandbox panel (F2)";
  const body = el("div", "sbx-body");
  root.append(tab, body);

  let open = false;
  // Ids this panel placed, so "Clear spawned" can undo its own work without
  // touching whatever the arena itself seeded.
  const spawnedIds: number[] = [];
  let infiniteAmmo = false;
  let invulnerable = false;

  // --- Spawn ------------------------------------------------------------------
  const spawnSection = el("div", "sbx-section");
  spawnSection.appendChild(el("div", "sbx-label", "Spawn"));

  const kindSelect = el("select", "sbx-select");
  for (const def of SANDBOX_SPAWNABLE) {
    const opt = el("option", undefined, def.label);
    opt.value = def.key;
    kindSelect.appendChild(opt);
  }
  spawnSection.appendChild(kindSelect);

  const kindNote = el("div", "sbx-note");
  spawnSection.appendChild(kindNote);

  const teamRow = el("div", "sbx-row");
  const teamSelect = el("select", "sbx-select");
  // Kept as a handle: for entries that need an owner only THIS option is
  // disabled, so team 0/1 stay pickable (see refresh()).
  let neutralOption: HTMLOptionElement | null = null;
  for (const [label, value] of [
    ["Team 0 (blue)", "0"],
    ["Team 1 (red)", "1"],
    ["Neutral", "-1"],
  ] as const) {
    const opt = el("option", undefined, label);
    opt.value = value;
    if (value === "-1") neutralOption = opt;
    teamSelect.appendChild(opt);
  }
  const modeSelect = el("select", "sbx-select");
  for (const [label, value] of [
    ["Patrol", String(UNIT_MODE_PATROL)],
    ["Assault", String(UNIT_MODE_ASSAULT)],
  ] as const) {
    const opt = el("option", undefined, label);
    opt.value = value;
    modeSelect.appendChild(opt);
  }
  teamRow.append(teamSelect, modeSelect);
  spawnSection.appendChild(teamRow);

  spawnSection.appendChild(el("div", "sbx-mini", "drops under the crosshair"));

  const spawnBtnRow = el("div", "sbx-row");
  const spawnOne = el("button", "sbx-btn sbx-btn--go", "Spawn");
  const spawnFive = el("button", "sbx-btn", "Spawn ×5");
  spawnBtnRow.append(spawnOne, spawnFive);
  spawnSection.appendChild(spawnBtnRow);

  const clearRow = el("div", "sbx-row");
  const clearMine = el("button", "sbx-btn", "Clear spawned");
  const clearAll = el("button", "sbx-btn", "Clear all");
  clearRow.append(clearMine, clearAll);
  spawnSection.appendChild(clearRow);

  const spawnStatus = el("div", "sbx-note");
  spawnSection.appendChild(spawnStatus);

  // --- Weapons ----------------------------------------------------------------
  // Same three-slot shape and the same CSS classes as the menu's weapons screen
  // (menu.ts) — one visual language, and no second stylesheet to keep in sync.
  const weaponSection = el("div", "sbx-section");
  weaponSection.appendChild(el("div", "sbx-label", "Weapons"));
  const kitSummary = el("div", "menu-loadout-summary");
  weaponSection.appendChild(kitSummary);

  const slotLists: Record<keyof Loadout, readonly WeaponDef[]> = {
    gun: GUNS,
    heavy: HEAVIES,
    special: SPECIALS,
  };
  const slotLabels: Record<keyof Loadout, string> = {
    gun: "Gun",
    heavy: "Heavy",
    special: "Special",
  };
  const cards: Record<keyof Loadout, HTMLButtonElement[]> = { gun: [], heavy: [], special: [] };

  for (const key of ["gun", "heavy", "special"] as const) {
    const row = el("div", "menu-weapon-row");
    row.appendChild(el("div", "menu-weapon-slot", slotLabels[key]));
    const picks = el("div", "menu-weapon-picks");
    slotLists[key].forEach((w, i) => {
      const card = el("button", "menu-weapon-card");
      card.appendChild(el("b", undefined, w.name));
      card.appendChild(el("span", undefined, weaponLabel(w)));
      card.addEventListener("click", () => {
        const sim = deps.getSim();
        if (!sim) return;
        setSandboxLoadout(sim, deps.getPlayer(), { ...currentKit(sim), [key]: i });
        refresh();
      });
      cards[key].push(card);
      picks.appendChild(card);
    });
    row.appendChild(picks);
    weaponSection.appendChild(row);
  }

  // --- Time -------------------------------------------------------------------
  const timeSection = el("div", "sbx-section");
  timeSection.appendChild(el("div", "sbx-label", "Time"));
  const timeRow = el("div", "sbx-row");
  const pauseBtn = el("button", "sbx-btn", "Pause");
  const step1 = el("button", "sbx-btn", "+1");
  const step10 = el("button", "sbx-btn", "+10");
  timeRow.append(pauseBtn, step1, step10);
  timeSection.appendChild(timeRow);
  const scaleRow = el("div", "sbx-row");
  const scaleBtns = TIME_SCALES.map((s) => {
    const b = el("button", "sbx-btn", s === 1 ? "1×" : `${s}×`);
    b.addEventListener("click", () => {
      deps.setTimeScale(s);
      refresh();
    });
    scaleRow.appendChild(b);
    return b;
  });
  timeSection.appendChild(scaleRow);

  // --- Cheats -----------------------------------------------------------------
  const cheatSection = el("div", "sbx-section");
  cheatSection.appendChild(el("div", "sbx-label", "Cheats"));
  const ammoBtn = el("button", "sbx-btn", "Infinite ammo");
  const invulnBtn = el("button", "sbx-btn", "Invulnerable");
  const cheatRow = el("div", "sbx-row");
  cheatRow.append(ammoBtn, invulnBtn);
  cheatSection.appendChild(cheatRow);

  // --- Readout ----------------------------------------------------------------
  const readSection = el("div", "sbx-section");
  readSection.appendChild(el("div", "sbx-label", "State"));
  const readout = el("div", "sbx-readout");
  readSection.appendChild(readout);

  body.append(spawnSection, weaponSection, timeSection, cheatSection, readSection);
  document.body.appendChild(root);

  function currentKit(sim: SimState): Loadout {
    return sandboxLoadout(sim, deps.getPlayer());
  }

  /**
   * The ground point under the crosshair, in sim coordinates.
   *
   * Reuses the pin path's heightfield march (debug/pinCapture.ts) so the panel
   * and a verification pin agree on where "there" is — a pin's `hit` and a
   * spawn land on the same spot. Works in the chase cam as well as the fly cam,
   * because it asks the camera for its own forward axis rather than reading the
   * fly rig's yaw/pitch.
   *
   * The hit is used verbatim: an earlier version clamped it to a slider
   * distance, which put the entity somewhere the crosshair was demonstrably not
   * pointing (46 m up at a 0.45 rad pitch, the ray meets ground ~100 m out, and
   * a 24 m clamp dropped everything below the frame).
   */
  function aimPoint(): { x: number; y: number } | null {
    const cam = deps.getCamera();
    const map = deps.getMap();
    if (!cam) return null;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    // Third basis column negated: three cameras look down -Z.
    const dx = -e[8];
    const dy = -e[9];
    const dz = -e[10];
    const hit = rayHitHeightfield(map, e[12], e[13], e[14], dx, dy, dz);
    if (hit.source === "heightfield") return { x: hit.x, y: hit.z };
    // Crosshair on the sky: nothing to hit, so project flat and take the fixed
    // fallback distance.
    const flat = Math.sqrt(dx * dx + dz * dz);
    if (flat === 0) return { x: e[12], y: e[14] };
    return {
      x: e[12] + (dx / flat) * SKY_FALLBACK_DISTANCE,
      y: e[14] + (dz / flat) * SKY_FALLBACK_DISTANCE,
    };
  }

  function place(offsetX: number, offsetY: number): number {
    const sim = deps.getSim();
    if (!sim) return -1;
    const at = aimPoint();
    if (!at) return -1;
    const id = spawnSandbox(
      sim,
      kindSelect.value,
      Number(teamSelect.value),
      at.x + offsetX,
      at.y + offsetY,
      Number(modeSelect.value),
    );
    if (id >= 0) spawnedIds.push(id);
    return id;
  }

  function afterPlace(n: number, wanted: number): void {
    // Re-snapshot so a paused scene shows the new entity right away instead of
    // waiting for the next unpaused tick.
    deps.resnap();
    spawnStatus.textContent =
      n === wanted ? `placed ${n}` : `placed ${n}/${wanted} — entity store full?`;
    refresh();
  }

  spawnOne.addEventListener("click", () => {
    afterPlace(place(0, 0) >= 0 ? 1 : 0, 1);
  });

  spawnFive.addEventListener("click", () => {
    // Fixed offsets rather than a trig ring: five readable positions is all a
    // formation test needs, and it keeps this free of angle maths.
    const offsets: readonly (readonly [number, number])[] = [
      [0, 0],
      [ARC_RADIUS, 0],
      [-ARC_RADIUS, 0],
      [0, ARC_RADIUS],
      [0, -ARC_RADIUS],
    ];
    let n = 0;
    for (const [ox, oy] of offsets) if (place(ox, oy) >= 0) n++;
    afterPlace(n, offsets.length);
  });

  clearMine.addEventListener("click", () => {
    const sim = deps.getSim();
    if (!sim) return;
    let n = 0;
    for (const id of spawnedIds) if (despawnSandbox(sim, id)) n++;
    spawnedIds.length = 0;
    deps.resnap();
    spawnStatus.textContent = `cleared ${n}`;
    refresh();
  });

  clearAll.addEventListener("click", () => {
    const sim = deps.getSim();
    if (!sim) return;
    const n = clearSandboxSpawns(sim);
    spawnedIds.length = 0;
    deps.resnap();
    spawnStatus.textContent = `cleared ${n} (avatars and map-spot structures kept)`;
    refresh();
  });

  pauseBtn.addEventListener("click", () => {
    deps.setPaused(!deps.getPaused());
    refresh();
  });
  step1.addEventListener("click", () => {
    deps.step(1);
    refresh();
  });
  step10.addEventListener("click", () => {
    deps.step(10);
    refresh();
  });
  ammoBtn.addEventListener("click", () => {
    infiniteAmmo = !infiniteAmmo;
    refresh();
  });
  invulnBtn.addEventListener("click", () => {
    invulnerable = !invulnerable;
    refresh();
  });
  kindSelect.addEventListener("change", refresh);
  tab.addEventListener("click", () => {
    setOpen(!open);
  });

  // Overlay idiom (refreshDebugLabel): only write the DOM when the text moved.
  let readoutText: string | null = null;
  let summaryText: string | null = null;

  function refresh(): void {
    const sim = deps.getSim();
    const def = SANDBOX_SPAWNABLE.find((s) => s.key === kindSelect.value);
    kindNote.textContent = def ? def.note : "";
    // Unit mode only means something for RUNNER..FORTRESS; the whole team select
    // is fixed for the always-neutral entries.
    modeSelect.disabled = !def?.isUnit;
    teamSelect.disabled = def !== undefined && !def.teamable;
    // Entries that need an owner lose only the Neutral option, not team 0/1.
    // spawnSandbox would pull a neutral request onto team 0 anyway; snapping the
    // select too keeps the UI from claiming something the spawn will not honour.
    if (neutralOption) {
      const blocked = Boolean(def?.teamable && def.requiresOwner);
      neutralOption.disabled = blocked;
      if (blocked && teamSelect.value === "-1") teamSelect.value = "0";
    }

    if (sim) {
      const kit = currentKit(sim);
      for (const key of ["gun", "heavy", "special"] as const) {
        cards[key].forEach((c, i) => {
          c.classList.toggle("is-active", i === kit[key]);
        });
      }
      const summary = `${GUNS[kit.gun].name} · ${HEAVIES[kit.heavy].name} · ${SPECIALS[kit.special].name}`;
      if (summary !== summaryText) {
        summaryText = summary;
        kitSummary.textContent = summary;
      }
    }

    const paused = deps.getPaused();
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.classList.toggle("is-active", paused);
    const scale = deps.getTimeScale();
    scaleBtns.forEach((b, i) => {
      b.classList.toggle("is-active", TIME_SCALES[i] === scale);
    });
    ammoBtn.classList.toggle("is-active", infiniteAmmo);
    invulnBtn.classList.toggle("is-active", invulnerable);

    const lines: string[] = [];
    if (sim) {
      const p = deps.getPlayer();
      const id = sim.avatarId[p];
      lines.push(`tick ${sim.tick}   entities ${countAlive(sim.ent)}`);
      if (id >= 0) {
        lines.push(
          `hp ${Math.round(sim.ent.hp[id])}  heavy ${sim.ent.ammoA[id]}  special ${sim.ent.ammoB[id]}`,
        );
      } else {
        lines.push("avatar respawning");
      }
      lines.push(`placed by panel ${spawnedIds.length}`);
      lines.push(`turrets alive ${countArchetype(sim, ARCHETYPE.TURRET)}`);
    } else {
      lines.push("no sim");
    }
    const rig = deps.rigInfo();
    if (rig) {
      lines.push(
        `rig legs ${rig.legL.toFixed(2)} / ${rig.legR.toFixed(2)}  stride ${rig.stride.toFixed(2)}`,
      );
    }
    const text = lines.join("\n");
    if (text !== readoutText) {
      readoutText = text;
      readout.textContent = text;
    }
  }

  function countArchetype(sim: SimState, archetype: number): number {
    let n = 0;
    for (let id = 0; id < sim.ent.high; id++) {
      if (sim.ent.alive[id] && sim.ent.archetype[id] === archetype) n++;
    }
    return n;
  }

  function setOpen(next: boolean): void {
    open = next;
    root.classList.toggle("is-open", open);
    tab.textContent = open ? "SANDBOX ▾" : "SANDBOX";
    if (open) refresh();
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== "F2" || e.repeat) return;
    if (isTextEntryTarget(e.target)) return;
    e.preventDefault();
    setOpen(!open);
  };
  addEventListener("keydown", onKey);

  refresh();

  return {
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    refresh: () => {
      if (open) refresh();
    },
    afterTick: () => {
      if (!infiniteAmmo && !invulnerable) return;
      const sim = deps.getSim();
      if (!sim) return;
      const p = deps.getPlayer();
      if (infiniteAmmo) refillSandboxAmmo(sim, p);
      if (invulnerable) reassertSandboxHp(sim, p);
    },
    dispose: () => {
      removeEventListener("keydown", onKey);
      root.remove();
    },
  };
}
