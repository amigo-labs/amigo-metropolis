// Classify: assign a single role to every NET node.
//
// Roles come from two sources:
//   - ACT config: base / turret / spawn / capture, resolved from the actor's
//     type token and snapped to the nearest NET node within snapRadius.
//   - Graph structure: chokepoint (articulation point on a lane), junction
//     (deg ≥ 3), endpoint (deg 1), else other.
//
// Precedence: base > (other ACT roles) > chokepoint > junction > endpoint >
// other. Chokepoint membership is decided in analyze.ts (it needs the lanes),
// so assignRoles() takes the chokepoint set as input.
//
// Base fallback (PLAN.md §6.4): if ACT yields fewer than two bases, we pick the
// Euclidean-farthest pair of nodes — the classic opposite-corner base layout.

import type { Graph } from "./graph";
import { dist } from "./normalize";
import type { Config, NodeRole, Vec2 } from "./types";
import { NODE_ROLES } from "./types";

export type CanonicalRole = "base" | "turret" | "spawn" | "capture";

const DEFAULT_ROLES: Readonly<Record<CanonicalRole, readonly string[]>> = {
  base: ["base", "hq", "headquarters", "home"],
  turret: ["turret", "gun", "tower", "sentry"],
  spawn: ["spawn", "spawnpoint", "start", "respawn"],
  capture: ["capture", "objective", "point", "flag", "control"],
};

const DEFAULT_SNAP_RADIUS = 0.1;

export interface SnappedActor {
  readonly role: CanonicalRole;
  readonly pos: Vec2;
  /** Nearest NET node index within snapRadius, or null. */
  readonly nodeIndex: number | null;
}

/** Resolve a raw type token to a canonical role using config + defaults. */
export function resolveRole(token: string, config: Config): CanonicalRole | null {
  const table = config.roles;
  const roles: CanonicalRole[] = ["base", "turret", "spawn", "capture"];
  for (const role of roles) {
    const tokens = table?.[role] ?? DEFAULT_ROLES[role];
    for (const t of tokens) {
      if (t.toLowerCase() === token) return role;
    }
  }
  return null;
}

/** Snap role-bearing actors to their nearest NET node. Order-stable by actor. */
export function snapActors(
  actorPositions: readonly Vec2[],
  actorRoles: ReadonlyArray<CanonicalRole | null>,
  graph: Graph,
  config: Config,
): SnappedActor[] {
  const snapRadius = config.snapRadius ?? DEFAULT_SNAP_RADIUS;
  const out: SnappedActor[] = [];
  actorPositions.forEach((pos, i) => {
    const role = actorRoles[i];
    if (!role) return;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    graph.pos.forEach((np, idx) => {
      const d = dist(pos, np);
      if (d < bestD || (d === bestD && idx < best)) {
        bestD = d;
        best = idx;
      }
    });
    out.push({ role, pos, nodeIndex: best >= 0 && bestD <= snapRadius ? best : null });
  });
  return out;
}

const ACTOR_PRIORITY: Readonly<Record<CanonicalRole, number>> = {
  base: 0,
  capture: 1,
  turret: 2,
  spawn: 3,
};

/** Base node indices: from ACT bases, else the Euclidean-farthest node pair. */
export function detectBases(graph: Graph, snapped: readonly SnappedActor[]): number[] {
  const fromActors = new Set<number>();
  for (const s of snapped) {
    if (s.role === "base" && s.nodeIndex !== null) fromActors.add(s.nodeIndex);
  }
  if (fromActors.size >= 2) {
    return [...fromActors].sort((a, b) => a - b);
  }

  // Fallback: farthest-apart pair. Deterministic by (distance, i, j).
  let bi = 0;
  let bj = graph.pos.length > 1 ? 1 : 0;
  let bestD = -1;
  for (let i = 0; i < graph.pos.length; i++) {
    for (let j = i + 1; j < graph.pos.length; j++) {
      const d = dist(graph.pos[i] as Vec2, graph.pos[j] as Vec2);
      if (d > bestD) {
        bestD = d;
        bi = i;
        bj = j;
      }
    }
  }
  return bi === bj ? [bi] : [bi, bj].sort((a, b) => a - b);
}

export interface RoleAssignment {
  readonly roleByIndex: readonly NodeRole[];
  readonly roleCounts: Readonly<Record<NodeRole, number>>;
}

/** Assign one role per node, honouring the precedence order. */
export function assignRoles(
  graph: Graph,
  snapped: readonly SnappedActor[],
  baseSet: ReadonlySet<number>,
  chokepointSet: ReadonlySet<number>,
): RoleAssignment {
  // Highest-priority ACT role per node index.
  const actorRoleByIndex = new Map<number, CanonicalRole>();
  for (const s of snapped) {
    if (s.nodeIndex === null) continue;
    const cur = actorRoleByIndex.get(s.nodeIndex);
    if (cur === undefined || ACTOR_PRIORITY[s.role] < ACTOR_PRIORITY[cur]) {
      actorRoleByIndex.set(s.nodeIndex, s.role);
    }
  }

  const roleByIndex: NodeRole[] = graph.ids.map((_, i) => {
    if (baseSet.has(i)) return "base";
    const actorRole = actorRoleByIndex.get(i);
    if (actorRole) return actorRole;
    if (chokepointSet.has(i)) return "chokepoint";
    const deg = (graph.adj[i] as readonly number[]).length;
    if (deg >= 3) return "junction";
    if (deg === 1) return "endpoint";
    return "other";
  });

  const roleCounts = {} as Record<NodeRole, number>;
  for (const r of NODE_ROLES) roleCounts[r] = 0;
  for (const r of roleByIndex) roleCounts[r]++;

  return { roleByIndex, roleCounts };
}
