// The debug-only sandbox layer (src/sandbox.ts): free placement of every
// archetype, a guarded despawn, and a live weapon-kit swap.
//
// The determinism angle these tests actually pin: sandbox calls happen BETWEEN
// ticks, and nothing in step() reads sandbox-only state — so two identical
// sandbox scripts must produce identical hash sequences, and the committed
// goldens (replay:verify) must be untouched by this module existing.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE, TEAM_NEUTRAL } from "../src/archetypes";
import { ARCHETYPE_MAX_HP, AVATAR_HP, WARDEN_ALTITUDE, WARDEN_HP } from "../src/balance";
import { createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson, sampleHeight } from "../src/map";
import {
  clearSandboxSpawns,
  despawnSandbox,
  reassertSandboxHp,
  refillSandboxAmmo,
  SANDBOX_SPAWNABLE,
  sandboxLoadout,
  sandboxSpawnableByKey,
  setSandboxLoadout,
  spawnSandbox,
} from "../src/sandbox";
import {
  createSim,
  hash,
  MODE_HOVER,
  type SimState,
  step,
  TURRET_CAPTURABLE,
  TURRET_DEFENSE,
  TURRET_DUMMY,
} from "../src/sim";
import { UNIT_MODE_ASSAULT } from "../src/units";
import { GUNS, HEAVIES, resolveLoadout, SPECIALS } from "../src/weapons";

// Flat 16×16 grid at 4 m cells → 60 m square, one straight lane, one turret
// spot and one outpost spot so the bookkeeping guards have something to guard.
function range(): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  return {
    id: "sandbox-range-test",
    size,
    cellSize: 4,
    waterLevel: -10,
    heights,
    water,
    spawns: [
      { x: 6, y: 54, yaw: 0 },
      { x: 54, y: 54, yaw: 0 },
    ],
    basePlots: [
      { x: 6, y: 54, radius: 6 },
      { x: 54, y: 54, radius: 6 },
    ],
    bases: [
      {
        gate: { x: 14, y: 6, radius: 3 },
        core: [6, 6],
        groundConsole: [6, 14],
        airConsole: [6, 22],
        pad: { x: 6, y: 54, radius: 4 },
        turrets: [[10, 10]],
      },
      {
        gate: { x: 46, y: 6, radius: 3 },
        core: [54, 6],
        groundConsole: [54, 14],
        airConsole: [54, 22],
        pad: { x: 54, y: 54, radius: 4 },
        turrets: [],
      },
    ],
    lanes: [
      [
        [14, 6],
        [46, 6],
      ],
    ],
    turretSpots: [[30, 30]],
    outpostSpots: [[30, 40]],
    dummySpots: [[30, 20]],
  };
}

const rangeSim = (): SimState => createSim(loadMapFromJson(range()), 42);

describe("SANDBOX_SPAWNABLE", () => {
  it("has unique keys and resolves each one", () => {
    const keys = new Set(SANDBOX_SPAWNABLE.map((s) => s.key));
    expect(keys.size).toBe(SANDBOX_SPAWNABLE.length);
    for (const s of SANDBOX_SPAWNABLE) {
      expect(sandboxSpawnableByKey(s.key)).toBe(s);
    }
  });

  it("covers every archetype a human can point a camera at", () => {
    const archetypes = new Set(SANDBOX_SPAWNABLE.map((s) => s.archetype));
    expect(archetypes).toEqual(
      new Set([
        ARCHETYPE.AVATAR,
        ARCHETYPE.RUNNER,
        ARCHETYPE.GUARDIAN,
        ARCHETYPE.JUGGERNAUT,
        ARCHETYPE.FORTRESS,
        ARCHETYPE.TURRET,
        ARCHETYPE.CONSOLE,
        ARCHETYPE.WARDEN,
      ]),
    );
  });

  it("offers all three turret kinds", () => {
    const modes = SANDBOX_SPAWNABLE.filter((s) => s.archetype === ARCHETYPE.TURRET).map(
      (s) => s.mode,
    );
    expect(new Set(modes)).toEqual(new Set([TURRET_DEFENSE, TURRET_DUMMY, TURRET_CAPTURABLE]));
  });

  it("returns -1 for an unknown key", () => {
    expect(spawnSandbox(rangeSim(), "no-such-thing", 0, 30, 30)).toBe(-1);
  });
});

describe("spawnSandbox", () => {
  it("places every entry with the declared archetype, mode and team", () => {
    for (const def of SANDBOX_SPAWNABLE) {
      const sim = rangeSim();
      const id = spawnSandbox(sim, def.key, 0, 30, 30);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(sim.ent.alive[id]).toBe(1);
      expect(sim.ent.archetype[id]).toBe(def.archetype);
      expect(sim.ent.team[id]).toBe(def.teamable ? 0 : TEAM_NEUTRAL);
      expect(sim.ent.posX[id]).toBe(30);
      expect(sim.ent.posY[id]).toBe(30);
      // Units get their lane/patrol bookkeeping in mode; structures keep the
      // declared mode byte verbatim.
      if (!def.isUnit) expect(sim.ent.mode[id]).toBe(def.mode);
    }
  });

  it("gives each entry its archetype's full HP", () => {
    for (const def of SANDBOX_SPAWNABLE) {
      const sim = rangeSim();
      const id = spawnSandbox(sim, def.key, 0, 30, 30);
      const expected =
        def.archetype === ARCHETYPE.WARDEN
          ? WARDEN_HP
          : def.archetype === ARCHETYPE.AVATAR
            ? AVATAR_HP
            : ARCHETYPE_MAX_HP[def.archetype];
      expect(sim.ent.hp[id]).toBe(expected);
    }
  });

  it("sits structures on the terrain and the Warden at cruise altitude", () => {
    const sim = rangeSim();
    const ground = sampleHeight(sim.map, 30, 30);
    const turret = spawnSandbox(sim, "turret-defense", 0, 30, 30);
    expect(sim.ent.height[turret]).toBe(ground);
    const warden = spawnSandbox(sim, "warden", 0, 30, 30);
    expect(sim.ent.height[warden]).toBe(Math.max(ground, sim.map.waterLevel) + WARDEN_ALTITUDE);
  });

  it("keeps yaw and the aim vector consistent for structures", () => {
    const sim = rangeSim();
    // Placed north-west of centre, so the centre-facing yaw points +x/+y.
    const id = spawnSandbox(sim, "turret-defense", 0, 10, 10);
    expect(sim.ent.aimX[id]).toBeGreaterThan(0);
    expect(sim.ent.aimY[id]).toBeGreaterThan(0);
    const len = Math.sqrt(sim.ent.aimX[id] ** 2 + sim.ent.aimY[id] ** 2);
    expect(Math.abs(len - 1)).toBeLessThan(0.01);
  });

  it("forces units onto a team even when neutral is requested", () => {
    const sim = rangeSim();
    const id = spawnSandbox(sim, "runner", -1, 30, 6);
    expect(sim.ent.team[id]).toBe(0);
  });

  // The review finding this pins: systemTargeting reads a turret's target from
  // its OWNER, not its mode (sim.ts) — `ownerId < 0` takes the
  // nearestEnemyAvatar branch. So every requiresOwner entry must come out with a
  // real owner no matter what the panel asked for, or a "Defense" turret is a
  // dummy wearing the wrong label.
  it("gives every requiresOwner entry a real owner when neutral is requested", () => {
    const owned = SANDBOX_SPAWNABLE.filter((s) => s.requiresOwner);
    expect(owned.length).toBeGreaterThan(0);
    for (const def of owned) {
      const sim = rangeSim();
      const id = spawnSandbox(sim, def.key, TEAM_NEUTRAL, 30, 6);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(sim.ent.team[id]).toBe(0);
      expect(sim.ent.ownerId[id]).toBe(0);
    }
  });

  it("never leaves a defense turret on the avatars-only targeting branch", () => {
    for (const team of [0, 1, TEAM_NEUTRAL, -5, Number.NaN]) {
      const sim = rangeSim();
      const id = spawnSandbox(sim, "turret-defense", team, 30, 30);
      expect(sim.ent.mode[id]).toBe(TURRET_DEFENSE);
      // ownerId >= 0 is exactly the condition sim.ts:1322 branches on.
      expect(sim.ent.ownerId[id]).toBeGreaterThanOrEqual(0);
    }
  });

  it("honours neutral for the entries where neutral is meaningful", () => {
    // An unclaimed outpost console IS neutral, and a team-less avatar/Warden is
    // a legitimate inert target — these must not be dragged onto a team.
    for (const def of SANDBOX_SPAWNABLE.filter((s) => s.teamable && !s.requiresOwner)) {
      const sim = rangeSim();
      const id = spawnSandbox(sim, def.key, TEAM_NEUTRAL, 30, 30);
      expect(sim.ent.team[id]).toBe(TEAM_NEUTRAL);
    }
  });

  it("reads a fractional negative team as neutral, not team 0", () => {
    // floor(-0.5) = -1 -> neutral. With Math.trunc this was -0, which fails
    // `t < 0` and silently became team 0.
    const sim = rangeSim();
    const id = spawnSandbox(sim, "console", -0.5, 30, 30);
    expect(sim.ent.team[id]).toBe(TEAM_NEUTRAL);
  });

  it("keeps the dummy turret neutral whatever team is asked for", () => {
    const sim = rangeSim();
    const id = spawnSandbox(sim, "turret-dummy", 1, 30, 30);
    expect(sim.ent.team[id]).toBe(TEAM_NEUTRAL);
  });

  it("passes the unit mode through to spawnUnit", () => {
    const sim = rangeSim();
    const id = spawnSandbox(sim, "guardian", 0, 30, 6, UNIT_MODE_ASSAULT);
    expect(sim.ent.mode[id]).toBe(UNIT_MODE_ASSAULT);
  });

  it("spawns the hover avatar in hover mode", () => {
    const sim = rangeSim();
    const id = spawnSandbox(sim, "avatar-hover", 1, 30, 30);
    expect(sim.ent.mode[id]).toBe(MODE_HOVER);
  });

  it("arms a stand-in avatar with the owning slot's kit capacity", () => {
    const sim = createSim(loadMapFromJson(range()), 42, {
      loadouts: [undefined, { heavy: 1, special: 1 }],
    });
    const id = spawnSandbox(sim, "avatar-walker", 1, 30, 30);
    const kit = resolveLoadout({ gun: 0, heavy: 1, special: 1 });
    expect(sim.ent.ammoA[id]).toBe(kit.heavy.ammo);
    expect(sim.ent.ammoB[id]).toBe(kit.special.ammo);
  });

  it("survives a full entity store by returning -1", () => {
    const sim = rangeSim();
    let last = 0;
    for (let i = 0; i < sim.ent.cap + 8; i++) {
      last = spawnSandbox(sim, "turret-dummy", -1, 30, 30);
      if (last < 0) break;
    }
    expect(last).toBe(-1);
  });

  it("leaves a placed turret simulating like any other turret", () => {
    const sim = rangeSim();
    const id = spawnSandbox(sim, "turret-defense", 0, 30, 30);
    const inputs = createTickInputs();
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.ent.alive[id]).toBe(1);
    expect(sim.ent.hp[id]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });
});

describe("despawnSandbox", () => {
  it("removes a sandbox-placed entity", () => {
    const sim = rangeSim();
    const id = spawnSandbox(sim, "turret-defense", 0, 30, 30);
    expect(despawnSandbox(sim, id)).toBe(true);
    expect(sim.ent.alive[id]).toBe(0);
  });

  it("refuses a player avatar", () => {
    const sim = rangeSim();
    const id = sim.avatarId[0];
    expect(id).toBeGreaterThanOrEqual(0);
    expect(despawnSandbox(sim, id)).toBe(false);
    expect(sim.ent.alive[id]).toBe(1);
  });

  it("refuses map-spot turrets, dummies and consoles", () => {
    const sim = rangeSim();
    for (const id of [
      sim.dummyEntity[0],
      sim.neutralTurretEntity[0],
      sim.baseTurretEntity[0],
      sim.outpostConsole[0],
    ]) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(despawnSandbox(sim, id)).toBe(false);
      expect(sim.ent.alive[id]).toBe(1);
    }
  });

  it("refuses out-of-range, fractional and already-dead ids", () => {
    const sim = rangeSim();
    expect(despawnSandbox(sim, -1)).toBe(false);
    expect(despawnSandbox(sim, sim.ent.cap)).toBe(false);
    expect(despawnSandbox(sim, 1.5)).toBe(false);
    const id = spawnSandbox(sim, "turret-defense", 0, 30, 30);
    expect(despawnSandbox(sim, id)).toBe(true);
    expect(despawnSandbox(sim, id)).toBe(false);
  });
});

describe("clearSandboxSpawns", () => {
  it("clears only what the match is not tracking", () => {
    const sim = rangeSim();
    const bookkept = [
      sim.avatarId[0],
      sim.avatarId[1],
      sim.dummyEntity[0],
      sim.neutralTurretEntity[0],
      sim.baseTurretEntity[0],
      sim.outpostConsole[0],
    ];
    const mine = [
      spawnSandbox(sim, "turret-defense", 0, 30, 30),
      spawnSandbox(sim, "runner", 0, 30, 6),
      spawnSandbox(sim, "warden", 1, 34, 34),
    ];
    expect(clearSandboxSpawns(sim)).toBe(mine.length);
    for (const id of mine) expect(sim.ent.alive[id]).toBe(0);
    for (const id of bookkept) expect(sim.ent.alive[id]).toBe(1);
  });

  it("leaves the match steppable afterwards", () => {
    const sim = rangeSim();
    spawnSandbox(sim, "juggernaut", 1, 30, 6);
    clearSandboxSpawns(sim);
    const inputs = createTickInputs();
    for (let i = 0; i < 60; i++) step(sim, inputs);
    expect(sim.tick).toBe(60);
  });
});

describe("setSandboxLoadout", () => {
  it("swaps the kit and reports it back", () => {
    const sim = rangeSim();
    expect(sandboxLoadout(sim, 0)).toEqual({ gun: 0, heavy: 0, special: 0 });
    setSandboxLoadout(sim, 0, { gun: 2, heavy: 3, special: 1 });
    expect(sandboxLoadout(sim, 0)).toEqual({ gun: 2, heavy: 3, special: 1 });
  });

  it("refills ammo and clears cooldowns on the live avatar", () => {
    const sim = rangeSim();
    const id = sim.avatarId[0];
    sim.ent.ammoA[id] = 0;
    sim.ent.ammoB[id] = 0;
    sim.ent.cooldownA[id] = 99;
    setSandboxLoadout(sim, 0, { gun: 1, heavy: 2, special: 1 });
    const kit = resolveLoadout({ gun: 1, heavy: 2, special: 1 });
    expect(sim.ent.ammoA[id]).toBe(kit.heavy.ammo);
    expect(sim.ent.ammoB[id]).toBe(kit.special.ammo);
    expect(sim.ent.cooldownA[id]).toBe(0);
  });

  it("clamps out-of-range indices and players instead of throwing", () => {
    const sim = rangeSim();
    // Player 99 clamps to the last slot; over-high indices clamp to the last
    // weapon in the slot, negatives to the first.
    setSandboxLoadout(sim, 99, { gun: 99, heavy: -3, special: 99 });
    expect(sandboxLoadout(sim, 1)).toEqual({
      gun: GUNS.length - 1,
      heavy: 0,
      special: SPECIALS.length - 1,
    });
  });

  it("reaches every weapon in the catalog", () => {
    const sim = rangeSim();
    for (let g = 0; g < GUNS.length; g++) {
      for (let h = 0; h < HEAVIES.length; h++) {
        for (let s = 0; s < SPECIALS.length; s++) {
          setSandboxLoadout(sim, 0, { gun: g, heavy: h, special: s });
          expect(sandboxLoadout(sim, 0)).toEqual({ gun: g, heavy: h, special: s });
        }
      }
    }
  });

  it("does not throw with a dead avatar", () => {
    const sim = rangeSim();
    sim.ent.alive[sim.avatarId[0]] = 0;
    setSandboxLoadout(sim, 0, { gun: 1, heavy: 1, special: 1 });
    expect(sandboxLoadout(sim, 0)).toEqual({ gun: 1, heavy: 1, special: 1 });
  });
});

describe("cheat helpers", () => {
  it("refills ammo to the current kit", () => {
    const sim = rangeSim();
    const id = sim.avatarId[0];
    sim.ent.ammoA[id] = 1;
    sim.ent.ammoB[id] = 0;
    refillSandboxAmmo(sim, 0);
    const kit = resolveLoadout({ gun: 0, heavy: 0, special: 0 });
    expect(sim.ent.ammoA[id]).toBe(kit.heavy.ammo);
    expect(sim.ent.ammoB[id]).toBe(kit.special.ammo);
  });

  it("restores avatar HP", () => {
    const sim = rangeSim();
    const id = sim.avatarId[0];
    sim.ent.hp[id] = 3;
    reassertSandboxHp(sim, 0);
    expect(sim.ent.hp[id]).toBe(AVATAR_HP);
  });

  it("no-ops on a dead avatar", () => {
    const sim = rangeSim();
    sim.avatarId[0] = -1;
    refillSandboxAmmo(sim, 0);
    reassertSandboxHp(sim, 0);
    expect(sim.avatarId[0]).toBe(-1);
  });
});

describe("determinism", () => {
  // The contract that keeps the sandbox out of the desync business: identical
  // sandbox calls at identical ticks reproduce the hash sequence exactly.
  function script(): number[] {
    const sim = rangeSim();
    const inputs = createTickInputs();
    const hashes: number[] = [];
    spawnSandbox(sim, "turret-defense", 0, 30, 30);
    spawnSandbox(sim, "runner", 1, 34, 6);
    setSandboxLoadout(sim, 0, { gun: 2, heavy: 3, special: 1 });
    for (let i = 0; i < 90; i++) {
      step(sim, inputs);
      if (i === 30) spawnSandbox(sim, "juggernaut", 0, 20, 6, UNIT_MODE_ASSAULT);
      if (i === 60) clearSandboxSpawns(sim);
      hashes.push(hash(sim));
    }
    return hashes;
  }

  it("reproduces the same hash sequence for the same script", () => {
    expect(script()).toEqual(script());
  });

  it("leaves a plain match's hashes untouched by the loadout swap", () => {
    // Loadout indices are config-only and NOT hashed (SimState.loadoutGun), so
    // swapping the kit must not move the hash on its own.
    const plain = rangeSim();
    const swapped = rangeSim();
    setSandboxLoadout(swapped, 0, { gun: 1, heavy: 2, special: 1 });
    // Ammo IS hashed, so line the two up before comparing.
    refillSandboxAmmo(plain, 0);
    swapped.ent.ammoA[swapped.avatarId[0]] = plain.ent.ammoA[plain.avatarId[0]];
    swapped.ent.ammoB[swapped.avatarId[0]] = plain.ent.ammoB[plain.avatarId[0]];
    expect(hash(swapped)).toBe(hash(plain));
  });
});
