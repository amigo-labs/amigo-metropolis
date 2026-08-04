// Weapons screen, after the original's hardpoint layout
// (docs/renders/fcop-ui/weapons-screen.png).
//
// Left: the X1-Alpha. Centre: three stacked hardpoint boxes showing only the
// weapon currently fitted. Right of each: slot name, the fitted weapon's name,
// and its numbers. "Ready" confirms and returns to the rail.
//
// It is its own full-screen stage because it is one in the original, and
// because the rail is 444px wide — not enough for the X1 render beside a
// hardpoint column.

import type { WeaponDef } from "@metropolis/sim";
import { TICK_HZ } from "@metropolis/sim";
import { cycleHardpoint, HARDPOINTS } from "../hardpoints";
import type { Hardpoint, MenuState } from "../state";

interface Props {
  state: MenuState;
  update(patch: Partial<MenuState>): void;
  onDone(): void;
}

/** Placeholder art until weapon meshes exist — see CREDITS/PLAN. The silhouette
 *  differs per slot so the three boxes never read as the same object. */
function WeaponGlyph({ slot }: { slot: number }) {
  // Gun: a barrel. Heavy: a pod. Special: a warhead. Drawn rather than shipped
  // so the screen is complete before the render pipeline produces stills.
  const paths = [
    "M6 26h44l10 6-10 6H6z",
    "M10 20h40a8 8 0 0 1 8 8v8a8 8 0 0 1-8 8H10z",
    "M8 32c12-14 30-14 42 0-12 14-30 14-42 0z",
  ];
  return (
    <svg class="wpn-glyph" viewBox="0 0 68 64" aria-hidden="true">
      <title>weapon</title>
      <path d={paths[slot]} />
    </svg>
  );
}

function statLine(w: WeaponDef): string {
  // Cadence in shots/second reads better than a tick cooldown, and matches how
  // the original presents its bars rather than its internals.
  const rps = w.cooldownTicks > 0 ? TICK_HZ / w.cooldownTicks : 0;
  const ammo = w.ammo > 0 ? `${w.ammo} rounds` : "infinite";
  return `${w.damage} dmg · ${rps.toFixed(1)}/s · ${ammo}`;
}

export function Weapons({ state, update, onDone }: Props) {
  const select = (hardpoint: Hardpoint) => update({ hardpoint });
  const cycle = (hardpoint: Hardpoint, delta: number) =>
    update({ hardpoint, loadout: cycleHardpoint(state.loadout, hardpoint, delta) });

  return (
    <div class="wpn">
      <div class="wpn-head">
        <div class="ck-label">X1-Alpha</div>
        <h2 class="ck-title wpn-title">Weapons</h2>
      </div>

      <div class="wpn-body">
        {/* The X1 still shot comes from tools/render/render_assets.py, which
            needs Blender. Until the file exists, the frame hides itself and its
            grid track — sized `auto` — collapses to nothing, so the rack centres
            instead of sitting beside a blank half-screen. Done by hiding the
            element rather than by component state so this screen stays a pure
            function of its props. */}
        <div class="wpn-mech">
          <img
            class="wpn-mech-img"
            src="/models/units/avatar-walker.png"
            alt=""
            decoding="async"
            onError={(e) => {
              const frame = (e.currentTarget as HTMLElement).parentElement;
              if (frame) frame.style.display = "none";
            }}
          />
        </div>

        <ul class="wpn-rack">
          {HARDPOINTS.map((spec, i) => {
            const hardpoint = i as Hardpoint;
            const index = state.loadout[spec.key];
            const weapon = spec.list[index];
            const active = state.hardpoint === hardpoint;
            return (
              <li class="wpn-row" key={spec.key}>
                <button
                  type="button"
                  class={`wpn-box ck-panel${active ? " is-active" : ""}`}
                  aria-label={`${spec.label}: ${weapon.name}. Next option.`}
                  onFocus={() => select(hardpoint)}
                  onClick={() => cycle(hardpoint, 1)}
                >
                  <WeaponGlyph slot={i} />
                </button>
                <div class="wpn-info">
                  <div class="wpn-slot ck-label">
                    {/* The original prints the fitted weapon's position in its
                        slot, 1-based — "Gun (5)" is the fifth gun, not a count
                        of five guns. */}
                    {spec.label} ({index + 1}/{spec.list.length})
                  </div>
                  <div class="wpn-name">{weapon.name}</div>
                  <div class="wpn-blurb">{weapon.blurb}</div>
                  <div class="wpn-stats ck-value">{statLine(weapon)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div class="wpn-foot">
        <button type="button" class="wpn-ready" onClick={onDone}>
          Ready
        </button>
        <p class="wpn-hint">
          <b>Up / Down</b> select hardpoint · <b>Left / Right</b> change weapon · <b>Esc</b> back
        </p>
      </div>
    </div>
  );
}
