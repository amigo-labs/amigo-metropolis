// Debug-only sandbox helpers: place any archetype anywhere, swap the avatar's
// weapon kit mid-match, top up ammo/HP. For eyeballing movement and firing
// animations without replaying a whole match to reach the thing you wanted to
// look at.
//
// NOTHING HERE RUNS INSIDE step(). That is the whole reason this is its own
// file: every function below is called from the host (the client's ?sandbox=1
// panel, tests) between ticks, exactly like the existing metropolisSpawn debug
// hook does with spawnUnit. Consequences, and why the determinism rules stay
// intact:
//
//   * No system reads any state written only by these functions, so the golden
//     replays hash identically (CLAUDE.md rule 6). If a golden ever moves after
//     a change in this file, something in the tick started reading sandbox
//     state and that commit is wrong.
//   * The arithmetic still obeys rule 1/2 (simMath LUTs, no transcendentals)
//     because sandbox-spawned entities are then simulated by the normal
//     systems and must be bit-identical on every peer that got the same call.
//   * Callers are solo-only by construction. Spawning into a lockstep match
//     would desync the peer that did not spawn, which is why the client gates
//     the panel on !netMode.
//
// Deliberate gap: sandbox spawns get NO map-spot bookkeeping (dummyEntity,
// neutralTurretEntity, baseTurretEntity, outpostConsole). Those arrays are
// indexed by map feature, and a free-placed entity has no feature. So:
//   - sandbox turrets and consoles never respawn after they die, and
//   - a sandbox TURRET_CAPTURABLE stays dormant forever, because the capture
//     system iterates map.turretSpots, not entities.
// For capture behaviour, use the arena's own pads — every FCOP arena has them.

import { ARCHETYPE, type Archetype, TEAM_NEUTRAL } from "./archetypes";
import { ARCHETYPE_MAX_HP, AVATAR_HP, MAX_PLAYERS, WARDEN_ALTITUDE, WARDEN_HP } from "./balance";
import { despawn, spawn } from "./entities";
import { sampleHeight, worldExtent } from "./map";
import {
  MODE_HOVER,
  MODE_WALKER,
  type SimState,
  spawnUnit,
  TURRET_CAPTURABLE,
  TURRET_DEFENSE,
  TURRET_DUMMY,
} from "./sim";
import { atan2Poly, cosLUT, sinLUT } from "./simMath";
import { UNIT_MODE_PATROL } from "./units";
import { type Loadout, normalizeLoadout, resolveLoadout } from "./weapons";

/** One entry per thing the sandbox panel can place. */
export interface SandboxSpawnable {
  /** Stable key used by the client panel's picker and by tests. */
  readonly key: string;
  /** Human label for the picker. */
  readonly label: string;
  readonly archetype: number;
  /** EntityStore.mode for the spawned entity (turret kind / avatar mode). */
  readonly mode: number;
  /** False for entities that are always neutral (dummy turret, capturable pad). */
  readonly teamable: boolean;
  /**
   * True when the entity only behaves as advertised with a real owner, so a
   * neutral request is pulled onto team 0 rather than honoured.
   *
   * This exists because systemTargeting picks a turret's target from its OWNER,
   * not its mode (sim.ts): `ownerId < 0` takes the nearestEnemyAvatar branch, so
   * a neutral TURRET_DEFENSE quietly engages avatars only — a dummy wearing a
   * defense turret's label. Units need an owner for the same class of reason:
   * the targeting system cannot classify a team-less unit.
   *
   * False where neutral is a meaningful state in its own right: an unclaimed
   * outpost console IS neutral, and a team-less avatar or Warden is a legitimate
   * inert target for an animation test.
   */
  readonly requiresOwner: boolean;
  /** True for RUNNER..FORTRESS, which route through spawnUnit and take a unit mode. */
  readonly isUnit: boolean;
  /** Short note shown in the panel; documents the caveats above where they bite. */
  readonly note: string;
}

/**
 * The single source of truth for what the sandbox can place. The client panel
 * builds its picker from this list so there is no second copy to drift.
 */
export const SANDBOX_SPAWNABLE: readonly SandboxSpawnable[] = [
  {
    key: "runner",
    label: "Runner",
    archetype: ARCHETYPE.RUNNER,
    mode: UNIT_MODE_PATROL,
    teamable: true,
    requiresOwner: true,
    isUnit: true,
    note: "Ground unit. Joins the nearest lane node and walks it.",
  },
  {
    key: "guardian",
    label: "Guardian",
    archetype: ARCHETYPE.GUARDIAN,
    mode: UNIT_MODE_PATROL,
    teamable: true,
    requiresOwner: true,
    isUnit: true,
    note: "Air unit. Orbits, then assaults in ASSAULT mode.",
  },
  {
    key: "juggernaut",
    label: "Juggernaut",
    archetype: ARCHETYPE.JUGGERNAUT,
    mode: UNIT_MODE_PATROL,
    teamable: true,
    requiresOwner: true,
    isUnit: true,
    note: "Heavy ground unit — the slowest walk cycle.",
  },
  {
    key: "fortress",
    label: "Fortress",
    archetype: ARCHETYPE.FORTRESS,
    mode: UNIT_MODE_PATROL,
    teamable: true,
    requiresOwner: true,
    isUnit: true,
    note: "Heavy air unit.",
  },
  {
    key: "turret-defense",
    label: "Turret (Defense)",
    archetype: ARCHETYPE.TURRET,
    mode: TURRET_DEFENSE,
    teamable: true,
    requiresOwner: true,
    isUnit: false,
    note: "Full targeting — needs an owner, so a neutral pick lands on team 0.",
  },
  {
    key: "turret-dummy",
    label: "Turret (Dummy)",
    archetype: ARCHETYPE.TURRET,
    mode: TURRET_DUMMY,
    teamable: false,
    requiresOwner: false,
    isUnit: false,
    note: "Neutral target practice — engages avatars only, never units.",
  },
  {
    key: "turret-capturable",
    label: "Turret (Capturable)",
    archetype: ARCHETYPE.TURRET,
    mode: TURRET_CAPTURABLE,
    teamable: false,
    requiresOwner: false,
    isUnit: false,
    note: "Dormant mesh only: capture runs off map turret spots, not entities.",
  },
  {
    key: "console",
    label: "Outpost console",
    archetype: ARCHETYPE.CONSOLE,
    mode: 0,
    teamable: true,
    requiresOwner: false,
    isUnit: false,
    note: "Mesh + hitbox; neutral is fine. Claiming runs off map outpost spots.",
  },
  {
    key: "warden",
    label: "Warden (superplane)",
    archetype: ARCHETYPE.WARDEN,
    mode: MODE_WALKER,
    teamable: true,
    requiresOwner: false,
    isUnit: false,
    note: "Placed at cruise altitude. Only the AI-driven slot gets a brain.",
  },
  {
    key: "avatar-walker",
    label: "Avatar (walker)",
    archetype: ARCHETYPE.AVATAR,
    mode: MODE_WALKER,
    teamable: true,
    requiresOwner: false,
    isUnit: false,
    note: "A second mech as a target. Inert unless it is a player's own avatar.",
  },
  {
    key: "avatar-hover",
    label: "Avatar (hover)",
    archetype: ARCHETYPE.AVATAR,
    mode: MODE_HOVER,
    teamable: true,
    requiresOwner: false,
    isUnit: false,
    note: "Same, in hover form.",
  },
];

const BY_KEY: ReadonlyMap<string, SandboxSpawnable> = (() => {
  const m = new Map<string, SandboxSpawnable>();
  for (const s of SANDBOX_SPAWNABLE) m.set(s.key, s);
  return m;
})();

/** Look up a spawnable by key; undefined if unknown. */
export function sandboxSpawnableByKey(key: string): SandboxSpawnable | undefined {
  return BY_KEY.get(key);
}

/**
 * Places one `SANDBOX_SPAWNABLE` entry at (x, y).
 *
 * Units route through the existing `spawnUnit` with `forward = true`, so they
 * join the lane graph at the nearest node instead of walking in from base —
 * which is what you want when you dropped one in front of the camera to watch
 * it move. Everything else gets its fields written here, following the private
 * spawners in sim.ts field for field.
 *
 * Returns the entity id, or -1 for an unknown key or a full entity store.
 */
export function spawnSandbox(
  state: SimState,
  key: string,
  team: number,
  x: number,
  y: number,
  unitMode: number = UNIT_MODE_PATROL,
): number {
  const def = BY_KEY.get(key);
  if (def === undefined) return -1;
  // Three cases, one expression: always-neutral entries ignore the request, the
  // ones that need an owner pull a neutral request onto team 0, and the rest get
  // what was asked for. `requiresOwner` covers the units AND the defense turret
  // — see its doc comment for why a neutral one is a dummy in disguise.
  const requested = def.teamable ? clampTeam(team) : TEAM_NEUTRAL;
  const t = def.requiresOwner && requested < 0 ? 0 : requested;

  if (def.isUnit) {
    return spawnUnit(state, def.archetype, t, x, y, unitMode, true);
  }

  const ent = state.ent;
  const id = spawn(ent, def.archetype as Archetype, t);
  if (id < 0) return -1;
  ent.posX[id] = x;
  ent.posY[id] = y;
  const ground = sampleHeight(state.map, x, y);
  ent.height[id] =
    def.archetype === ARCHETYPE.WARDEN
      ? Math.max(ground, state.map.waterLevel) + WARDEN_ALTITUDE
      : ground;
  ent.hp[id] = maxHpFor(def.archetype);
  ent.ownerId[id] = t;
  ent.mode[id] = def.mode;
  // Face the arena centre, same convention as the outpost consoles — a turret
  // dropped at the edge then reads toward the midfield instead of off-map.
  const mid = worldExtent(state.map) * 0.5;
  const yaw = atan2Poly(mid - y, mid - x);
  ent.yaw[id] = yaw;
  ent.aimX[id] = cosLUT(yaw);
  ent.aimY[id] = sinLUT(yaw);
  if (def.archetype === ARCHETYPE.AVATAR) {
    // A stand-in avatar should be able to take and return fire, so give it the
    // kit capacity of the slot it nominally belongs to.
    const kit = kitFor(state, t < 0 ? 0 : t);
    ent.ammoA[id] = kit.heavy.ammo;
    ent.ammoB[id] = kit.special.ammo;
  }
  return id;
}

/**
 * Despawns a sandbox-placed entity.
 *
 * Refuses any id the match itself is tracking (a player avatar, a map-spot
 * turret/console), because those slots hold the id in a bookkeeping array and
 * freeing it behind their back leaves a dangling reference the respawn systems
 * would then act on. Returns true when the entity was actually removed.
 */
export function despawnSandbox(state: SimState, id: number): boolean {
  const ent = state.ent;
  if (!Number.isInteger(id) || id < 0 || id >= ent.cap) return false;
  if (!ent.alive[id]) return false;
  if (isBookkept(state, id)) return false;
  despawn(ent, id);
  return true;
}

/** True when a match bookkeeping array still references `id`. */
function isBookkept(state: SimState, id: number): boolean {
  return (
    contains(state.avatarId, id) ||
    contains(state.dummyEntity, id) ||
    contains(state.neutralTurretEntity, id) ||
    contains(state.baseTurretEntity, id) ||
    contains(state.baseDefenceEntity, id) ||
    contains(state.outpostConsole, id)
  );
}

function contains(arr: Int32Array, id: number): boolean {
  for (let i = 0; i < arr.length; i++) if (arr[i] === id) return true;
  return false;
}

/**
 * Despawns every sandbox-placeable entity the match is not tracking, and
 * returns how many went. Leaves avatars, map-spot turrets and consoles alone,
 * so "clear" cannot strand the respawn systems.
 */
export function clearSandboxSpawns(state: SimState): number {
  const ent = state.ent;
  let n = 0;
  // Dense id order (rule 5) — the store's own iteration contract.
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    if (ent.archetype[id] === ARCHETYPE.PROJECTILE) continue;
    if (isBookkept(state, id)) continue;
    despawn(ent, id);
    n++;
  }
  return n;
}

/**
 * Swaps `player`'s weapon kit mid-match.
 *
 * Cheap and safe because the loadout arrays are config-only and NOT hashed
 * (see SimState.loadoutGun) — every tick re-resolves the kit from them, so the
 * next shot simply uses the new weapon. Ammo and cooldowns on the live avatar
 * are reset to the new kit so a swap does not leave the old weapon's spent
 * magazine behind.
 */
export function setSandboxLoadout(
  state: SimState,
  player: number,
  loadout: Partial<Loadout>,
): void {
  const p = clampPlayer(player);
  const kit = normalizeLoadout(loadout);
  state.loadoutGun[p] = kit.gun;
  state.loadoutHeavy[p] = kit.heavy;
  state.loadoutSpecial[p] = kit.special;
  const id = state.avatarId[p];
  if (id < 0 || !state.ent.alive[id]) return;
  const resolved = resolveLoadout(kit);
  state.ent.ammoA[id] = resolved.heavy.ammo;
  state.ent.ammoB[id] = resolved.special.ammo;
  state.ent.cooldownA[id] = 0;
  state.ent.cooldownB[id] = 0;
  state.ent.cooldownC[id] = 0;
}

/** The kit `player` is currently carrying (for panel readouts). */
export function sandboxLoadout(state: SimState, player: number): Loadout {
  const p = clampPlayer(player);
  return {
    gun: state.loadoutGun[p],
    heavy: state.loadoutHeavy[p],
    special: state.loadoutSpecial[p],
  };
}

/** Tops `player`'s heavy/special ammo back up — the panel's infinite-ammo tick. */
export function refillSandboxAmmo(state: SimState, player: number): void {
  const p = clampPlayer(player);
  const id = state.avatarId[p];
  if (id < 0 || !state.ent.alive[id]) return;
  const kit = kitFor(state, p);
  state.ent.ammoA[id] = kit.heavy.ammo;
  state.ent.ammoB[id] = kit.special.ammo;
}

/** Restores `player`'s avatar to full HP — the panel's invulnerable tick. */
export function reassertSandboxHp(state: SimState, player: number): void {
  const p = clampPlayer(player);
  const id = state.avatarId[p];
  if (id < 0 || !state.ent.alive[id]) return;
  state.ent.hp[id] = maxHpFor(state.ent.archetype[id]);
}

function kitFor(state: SimState, player: number) {
  return resolveLoadout({
    gun: state.loadoutGun[player],
    heavy: state.loadoutHeavy[player],
    special: state.loadoutSpecial[player],
  });
}

function maxHpFor(archetype: number): number {
  if (archetype === ARCHETYPE.WARDEN) return WARDEN_HP;
  if (archetype === ARCHETYPE.AVATAR) return AVATAR_HP;
  return ARCHETYPE_MAX_HP[archetype];
}

// floor, not trunc. Not a determinism point — Math.trunc is IEEE-exact and
// spec-pinned like floor — but trunc(-0.5) is -0, and `-0 < 0` is false, so a
// fractional negative team slid past the neutral check below and became team 0.
// floor(-0.5) is -1, which is what "negative means neutral" is supposed to do.
// It also keeps this file on the same helper as the other 37 floor sites in the
// sim, and inside CLAUDE.md rule 2's written allowlist.
function clampTeam(team: number): number {
  if (!Number.isFinite(team)) return 0;
  const t = Math.floor(team);
  if (t < 0) return TEAM_NEUTRAL;
  return Math.min(t, MAX_PLAYERS - 1);
}

function clampPlayer(player: number): number {
  if (!Number.isFinite(player)) return 0;
  return Math.min(Math.max(Math.floor(player), 0), MAX_PLAYERS - 1);
}
