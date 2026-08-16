// Measurement harness for the §9 match-resolution question (issue #31, PLAN
// Phase 13): does a match on the Precinct Assault arenas actually RESOLVE, and
// when it does not, what is it stuck on?
//
// Authoring/analysis tool only — nothing here runs in the sim tick path, and
// nothing here is imported by packages/. It exists because every balance knob
// in this area is documented as non-monotone (PLAN.md's 120 s turret-respawn
// trap), so no knob may be turned without this full matrix in hand:
//
//   bun run balance:pa                       # d8 vs idle, 4 arenas x 5 seeds
//   bun run balance:pa -- --scenario all     # + escort / trickle / swap
//   bun run balance:pa -- --difficulty 3,5,8 # difficulty spread
//   bun run balance:pa -- --minutes 15 --seeds 0xc0ffee,1,2,3,4
//
// Scenarios:
//   vs-idle  difficulty-N Warden (team 1) against an idle player — the
//            resolution target: the Warden should raze within ~10 minutes.
//   escort   defender's free production silenced, Warden escorts its own
//            stream (paAttribution.test.ts's push(mapId, true) scenario) —
//            pure throughput of an escorted push.
//   trickle  defender silenced, NO Warden — pillar-1 guard: an unescorted
//            free-production trickle must NOT raze a defended base.
//   swap     vs-idle with the Warden on team 0 — symmetry check.
//
// Per match this reports: resolve time, final core HP, defending emplacements
// alive per minute (respawn-vs-clearance), the Warden goal histogram, and a
// JAM detector — attacking ground units at full HP that displaced less than
// JAM_EPSILON over the last JAM_WINDOW ticks. That signature is what found the
// urban-jungle stall: units wedged at their own base exit, freezing production
// at PA_PRODUCTION_ALIVE_LIMIT forever.

import {
  ARCHETYPE,
  ARCHETYPE_MAX_HP,
  BUG_HUNT_ID,
  createSim,
  createTickInputs,
  getMapById,
  LA_CANTINA_ID,
  PROVING_GROUND_ID,
  type SimState,
  step,
  TICK_HZ,
  URBAN_JUNGLE_ID,
} from "@metropolis/sim";

const ARENAS = [LA_CANTINA_ID, URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID];
const GOAL_NAMES = [
  "IDLE",
  "RETREAT",
  "DEFEND",
  "HARASS",
  "CAPTURE",
  "ESCORT",
  "BUY_GND",
  "BUY_JUG",
  "BUY_AIR",
  "CLAIM",
  "SUPPRESS",
];

const GROUND_UNITS: readonly number[] = [
  ARCHETYPE.RUNNER,
  ARCHETYPE.GUARDIAN,
  ARCHETYPE.JUGGERNAUT,
  ARCHETYPE.FORTRESS,
];

/** Displacement window and threshold for the jam detector. */
const JAM_WINDOW = 300; // ticks (10 s)
const JAM_EPSILON = 0.5; // metres

type Scenario = "vs-idle" | "escort" | "trickle" | "swap";

interface MatchReport {
  arena: string;
  scenario: Scenario;
  seed: number;
  difficulty: number;
  /** Tick the match resolved at, or -1 for a timeout. */
  resolvedTick: number;
  winner: number;
  coreHp: [number, number];
  /** Defending emplacements alive, sampled once per minute. */
  turretsPerMinute: number[];
  /** Ticks spent per Warden goal (index = WGOAL_*). */
  goalTicks: number[];
  /** Peak simultaneous jammed attacker ground units. */
  peakJammed: number;
  /** First tick the jam detector saw >= 3 units jammed at once, or -1. */
  jamOnsetTick: number;
  /** Attacker ground units alive at the end. */
  attackersAlive: number;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value.split(",").map((s) => s.trim());
}

function parseSeeds(value: string | undefined): number[] {
  return parseList(value, ["0xc0ffee", "1", "2", "3", "4"]).map((s) => Number(s) >>> 0);
}

function runMatch(
  arena: string,
  scenario: Scenario,
  seed: number,
  difficulty: number,
  minutes: number,
): MatchReport {
  // getMapById builds fresh MapData per call, so silencing production is local.
  const map = getMapById(arena);
  const wardenTeam = scenario === "swap" ? 0 : 1;
  const defender = 1 - wardenTeam;
  if (scenario === "escort" || scenario === "trickle") {
    (map.bases[defender] as { productionTicks: number }).productionTicks = 0;
  }
  const withWarden = scenario !== "trickle";
  const state: SimState = createSim(
    map,
    seed,
    withWarden ? { wardenPlayer: wardenTeam, wardenDifficulty: difficulty } : {},
  );
  const idle = createTickInputs();
  const maxTicks = minutes * 60 * TICK_HZ;

  const goalTicks = new Array(GOAL_NAMES.length).fill(0);
  const turretsPerMinute: number[] = [];
  const countTurrets = (): number => {
    let turrets = 0;
    const ent = state.ent;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.archetype[id] === ARCHETYPE.TURRET && ent.team[id] === defender)
        turrets += 1;
    }
    return turrets;
  };
  turretsPerMinute.push(countTurrets()); // t=0, so sub-minute matches report too
  const cap = state.ent.posX.length;
  // Jam detector scratch: position of each attacker ground unit one window ago.
  const refX = new Float32Array(cap);
  const refY = new Float32Array(cap);
  const refValid = new Uint8Array(cap);
  let peakJammed = 0;
  let jamOnsetTick = -1;

  for (let t = 0; t < maxTicks && state.winner < 0; t++) {
    step(state, idle);
    if (withWarden && state.wardenGoal < goalTicks.length) goalTicks[state.wardenGoal] += 1;

    const ent = state.ent;
    if (state.tick % (60 * TICK_HZ) === 0) {
      turretsPerMinute.push(countTurrets());
    }
    if (state.tick % JAM_WINDOW === 0) {
      let jammed = 0;
      for (let id = 0; id < ent.high; id++) {
        const isAttackerGround =
          ent.alive[id] && ent.team[id] === wardenTeam && GROUND_UNITS.includes(ent.archetype[id]);
        if (!isAttackerGround) {
          refValid[id] = 0;
          continue;
        }
        const fullHp = ent.hp[id] >= ARCHETYPE_MAX_HP[ent.archetype[id]];
        if (refValid[id] === 1 && fullHp) {
          const dx = ent.posX[id] - refX[id];
          const dy = ent.posY[id] - refY[id];
          if (dx * dx + dy * dy < JAM_EPSILON * JAM_EPSILON) jammed += 1;
        }
        refX[id] = ent.posX[id];
        refY[id] = ent.posY[id];
        refValid[id] = 1;
      }
      if (jammed > peakJammed) peakJammed = jammed;
      if (jammed >= 3 && jamOnsetTick < 0) jamOnsetTick = state.tick;
    }
  }

  let attackersAlive = 0;
  for (let id = 0; id < state.ent.high; id++) {
    if (
      state.ent.alive[id] &&
      state.ent.team[id] === wardenTeam &&
      GROUND_UNITS.includes(state.ent.archetype[id])
    )
      attackersAlive += 1;
  }

  return {
    arena,
    scenario,
    seed,
    difficulty,
    resolvedTick: state.winner >= 0 ? state.tick : -1,
    winner: state.winner,
    coreHp: [state.coreHp[0] ?? 0, state.coreHp[1] ?? 0],
    turretsPerMinute,
    goalTicks,
    peakJammed,
    jamOnsetTick,
    attackersAlive,
  };
}

function fmtSeconds(tick: number): string {
  return tick < 0 ? "timeout" : `${Math.round(tick / TICK_HZ)}s`;
}

function goalSummary(report: MatchReport): string {
  const total = report.goalTicks.reduce((a, b) => a + b, 0);
  if (total === 0) return "-";
  return report.goalTicks
    .map((ticks, i) => ({ name: GOAL_NAMES[i], pct: Math.round((ticks / total) * 100) }))
    .filter((g) => g.pct >= 5)
    .sort((a, b) => b.pct - a.pct)
    .map((g) => `${g.name} ${g.pct}%`)
    .join(" ");
}

function main(): void {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1] ?? "");
  }

  const arenas = parseList(args.get("arenas"), ARENAS);
  const seeds = parseSeeds(args.get("seeds"));
  const minutes = Number(args.get("minutes") ?? "15");
  const difficulties = parseList(args.get("difficulty"), ["8"]).map(Number);
  const scenarioArg = args.get("scenario") ?? "vs-idle";
  const scenarios: Scenario[] =
    scenarioArg === "all"
      ? ["vs-idle", "escort", "trickle", "swap"]
      : (parseList(scenarioArg, ["vs-idle"]) as Scenario[]);
  const asJson = args.has("json");

  const reports: MatchReport[] = [];
  for (const scenario of scenarios) {
    for (const arena of arenas) {
      for (const difficulty of difficulties) {
        for (const seed of seeds) {
          const r = runMatch(arena, scenario, seed, difficulty, minutes);
          reports.push(r);
          if (!asJson) {
            const core = `core ${r.coreHp[0]}/${r.coreHp[1]}`;
            const jam =
              r.peakJammed > 0
                ? ` jam peak ${r.peakJammed}${r.jamOnsetTick >= 0 ? ` @${fmtSeconds(r.jamOnsetTick)}` : ""}`
                : "";
            const turrets = r.turretsPerMinute;
            console.log(
              `${scenario.padEnd(7)} ${arena.padEnd(15)} d${r.difficulty} seed ${r.seed
                .toString(16)
                .padStart(8, "0")}: ${fmtSeconds(r.resolvedTick).padEnd(8)} winner ${
                r.winner
              } ${core} turrets ${turrets[0]}→${turrets[turrets.length - 1]}${jam}`,
            );
            if (r.goalTicks.some((v) => v > 0)) console.log(`        goals: ${goalSummary(r)}`);
          }
        }
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  // Per (scenario, arena) rollup — resolution rate and worst case.
  console.log("\n== rollup ==");
  for (const scenario of scenarios) {
    for (const arena of arenas) {
      const rows = reports.filter((r) => r.scenario === scenario && r.arena === arena);
      if (rows.length === 0) continue;
      const resolved = rows.filter((r) => r.resolvedTick >= 0);
      const worst = rows.reduce((a, b) => {
        const at = a.resolvedTick < 0 ? Number.POSITIVE_INFINITY : a.resolvedTick;
        const bt = b.resolvedTick < 0 ? Number.POSITIVE_INFINITY : b.resolvedTick;
        return bt > at ? b : a;
      });
      console.log(
        `${scenario.padEnd(7)} ${arena.padEnd(15)}: ${resolved.length}/${rows.length} resolved, worst ${fmtSeconds(
          worst.resolvedTick,
        )} (seed ${worst.seed.toString(16)})`,
      );
    }
  }
}

main();
