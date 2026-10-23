// Which world row each round in flight came from, and which launch effect
// rides it.
//
// The original names the round a shot spawned in the same call that raises
// its launch effect on it (`cact_weapon_discharge` 0x0044df29: "rides the new
// round, attached"), and the round's model is the row's projectile Cobj. The
// sim spawns the round as a PROJECTILE entity and says only that a shot went
// out (EV_SHOT, SHOT_SLOT_LAUNCH) — the round appears in the next snapshot.
// So a launch is noted when its event is pumped, and the next snapshot's new
// projectiles are matched to the launches of that tick by where they spawned
// (the shooter's muzzle: `spawnStraight`). Presentation only: nothing here is
// read back by the sim.
//
// A round also carries the impact its death raises: every launched round has
// the direct flag 0x40000 (the type-7 and type-0x0f constructs' `or ecx,
// 0x840002`, 0x00423d50 / 0x004242d5; the missile's 0x00422fc6), so
// `cact_effect_emit` 0x0042b910 starts its +0x20 — the weapon block's +0x1a —
// as the effect id itself (0x0042b92e), in the bank of its owner
// (`cact_effect_bank` 0x0042bf50: 1 for the player's partner, which launches
// every player round, else 0). So the launch notes the block's impact and its
// bank, and the round's death reads them back (`impact`).
//
// And the block it came from: the two blocks of a player weapon may name two
// models (the Fusion Torpedo's and the Plasma Flare's star is Cobj 46 in block
// A, 47 in block B; RE pa_models.json `player_weapons`), and the shot's
// SHOT_POWERED bit is the only word of it. A burst's fragments are copies of
// their shell, model and all (`cact_round_advance` 0x00423f97, a `rep movsd` of
// the whole round): a new round no launch named takes the block of a block-B
// round of its kind that stood within reach in the last snapshot.

import { MAX_ENTITIES } from "@metropolis/sim";

/** The first pending-round token; launch n of a tick is `ROUND_TOKEN - n`. */
export const ROUND_TOKEN = -2;

/** Launches one tick can carry (every PA turret firing at once is 72). */
export const MAX_LAUNCHES = 128;
/** How far from its muzzle a new round can be (one tick of the fastest round). */
const BIND_RADIUS_M = 3;
/** Block-B rounds remembered from one snapshot to the next (their fragments' shells). */
const MAX_SHELLS = 128;

/** Snapshot fields (sim.ts writeSnapshot). */
const S_ID = 0;
const S_ARCH = 1;
const S_X = 3;
const S_Y = 4;
const S_HEIGHT = 5;
const S_AUX = 9;
/** ARCHETYPE.PROJECTILE (archetypes.ts). */
const PROJECTILE = 6;

export type BindListener = (token: number, entity: number) => void;

export class RoundTracker {
  /** Per entity: the world row its round came from (0 unknown or a player's). */
  readonly row = new Uint8Array(MAX_ENTITIES);
  /** Per entity: the impact its death raises (0 none known) and that impact's bank. */
  readonly impactId = new Uint16Array(MAX_ENTITIES);
  readonly impactBank = new Uint8Array(MAX_ENTITIES);
  /** Per entity: 1 when its round came out of its weapon's block B (the power-up magazine). */
  readonly powered = new Uint8Array(MAX_ENTITIES);
  /** The last `impact`'s round: its impact id (0 none known) and bank. */
  lastImpactId = 0;
  lastImpactBank = 0;
  /** Per entity: its projectile kind in the last snapshot, -1 not a projectile. */
  private readonly kind = new Int16Array(MAX_ENTITIES).fill(-1);
  private readonly launchX = new Float32Array(MAX_LAUNCHES);
  private readonly launchZ = new Float32Array(MAX_LAUNCHES);
  private readonly launchRow = new Uint8Array(MAX_LAUNCHES);
  private readonly launchImpact = new Uint16Array(MAX_LAUNCHES);
  private readonly launchBank = new Uint8Array(MAX_LAUNCHES);
  private readonly launchPowered = new Uint8Array(MAX_LAUNCHES);
  private launches = 0;
  /** The last snapshot's block-B rounds: where each stood, and its kind. */
  private readonly shellX = new Float32Array(MAX_SHELLS);
  private readonly shellZ = new Float32Array(MAX_SHELLS);
  private readonly shellKind = new Int16Array(MAX_SHELLS);
  private shells = 0;
  private readonly listeners: BindListener[] = [];

  addListener(l: BindListener): void {
    if (!this.listeners.includes(l)) this.listeners.push(l);
  }

  /** A new match: nothing in flight is known. */
  reset(): void {
    this.row.fill(0);
    this.impactId.fill(0);
    this.impactBank.fill(0);
    this.powered.fill(0);
    this.kind.fill(-1);
    this.launches = 0;
    this.shells = 0;
  }

  /**
   * A shot launched a round from (x, z) — the muzzle — this tick, of world row
   * `row` (0 a player's), whose death raises `impact` in `bank`; `powered` when
   * it came out of the weapon's block B. Returns the token its launch effects
   * ride until the round is known, or -1 when the tick is full.
   */
  launch(x: number, z: number, row: number, bank = 0, impact = 0, powered = false): number {
    if (this.launches >= MAX_LAUNCHES) return -1;
    const n = this.launches++;
    this.launchX[n] = x;
    this.launchZ[n] = z;
    this.launchRow[n] = row;
    this.launchBank[n] = bank;
    this.launchImpact[n] = impact;
    this.launchPowered[n] = powered ? 1 : 0;
    return ROUND_TOKEN - n;
  }

  /**
   * A round died at (x, z) this tick (EV_ROUND_IMPACT / EV_EXPLOSION): the
   * nearest projectile in `snap` (the tick's own, before it ran). Its id is
   * forgotten, so a round that takes the id in the same tick reads as new.
   * Returns its height, or NaN when there is none within reach; its impact
   * and bank are left in `lastImpactId` / `lastImpactBank`.
   */
  impact(x: number, z: number, snap: Float32Array, count: number, stride: number): number {
    this.lastImpactId = 0;
    this.lastImpactBank = 0;
    let best = -1;
    let bestD = 4;
    for (let c = 0; c < count; c++) {
      const o = c * stride;
      if (snap[o + S_ARCH] !== PROJECTILE) continue;
      const dx = snap[o + S_X] - x;
      const dz = snap[o + S_Y] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best < 0) return Number.NaN;
    const id = snap[best + S_ID];
    if (id >= 0 && id < MAX_ENTITIES) {
      this.kind[id] = -1;
      this.lastImpactId = this.impactId[id];
      this.lastImpactBank = this.impactBank[id];
    }
    return snap[best + S_HEIGHT];
  }

  /**
   * The snapshot after the tick: every projectile not seen before is matched
   * to the nearest launch of the tick, and every launch is answered — bound
   * to its round, or to -1 (it stays where it was raised, as the original's
   * does "at the muzzle when no round came back").
   */
  bind(snap: Float32Array, count: number, stride: number): void {
    let open = this.launches;
    for (let c = 0; c < count; c++) {
      const o = c * stride;
      const id = snap[o + S_ID];
      if (id < 0 || id >= MAX_ENTITIES) continue;
      if (snap[o + S_ARCH] !== PROJECTILE) {
        this.kind[id] = -1;
        continue;
      }
      const k = snap[o + S_AUX];
      const fresh = this.kind[id] !== k;
      this.kind[id] = k;
      if (!fresh) continue;
      this.row[id] = 0;
      this.impactId[id] = 0;
      this.impactBank[id] = 0;
      this.powered[id] = 0;
      let best = -1;
      let bestD = BIND_RADIUS_M * BIND_RADIUS_M;
      for (let n = 0; open > 0 && n < this.launches; n++) {
        if (this.launchRow[n] === 255) continue; // taken
        const dx = snap[o + S_X] - this.launchX[n];
        const dz = snap[o + S_Y] - this.launchZ[n];
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best < 0) {
        // No launch: a burst's fragment wears its shell's model.
        this.powered[id] = this.shellNear(snap[o + S_X], snap[o + S_Y], k);
        continue;
      }
      this.row[id] = this.launchRow[best];
      this.impactId[id] = this.launchImpact[best];
      this.impactBank[id] = this.launchBank[best];
      this.powered[id] = this.launchPowered[best];
      this.launchRow[best] = 255;
      open--;
      for (let i = 0; i < this.listeners.length; i++) this.listeners[i](ROUND_TOKEN - best, id);
    }
    for (let n = 0; n < this.launches; n++) {
      if (this.launchRow[n] === 255) continue;
      for (let i = 0; i < this.listeners.length; i++) this.listeners[i](ROUND_TOKEN - n, -1);
    }
    this.launches = 0;
    // This snapshot's block-B rounds, for the next one's fragments.
    this.shells = 0;
    for (let c = 0; c < count && this.shells < MAX_SHELLS; c++) {
      const o = c * stride;
      const id = snap[o + S_ID];
      if (id < 0 || id >= MAX_ENTITIES || snap[o + S_ARCH] !== PROJECTILE) continue;
      if (this.powered[id] === 0) continue;
      this.shellX[this.shells] = snap[o + S_X];
      this.shellZ[this.shells] = snap[o + S_Y];
      this.shellKind[this.shells] = snap[o + S_AUX];
      this.shells++;
    }
  }

  /** 1 when a block-B round of `kind` stood within reach of (x, z) in the last snapshot. */
  private shellNear(x: number, z: number, kind: number): number {
    const reach = BIND_RADIUS_M * BIND_RADIUS_M;
    for (let n = 0; n < this.shells; n++) {
      if (this.shellKind[n] !== kind) continue;
      const dx = x - this.shellX[n];
      const dz = z - this.shellZ[n];
      if (dx * dx + dz * dz < reach) return 1;
    }
    return 0;
  }
}
