// The data contracts for mapalyze.
//
// Two families of types live here:
//   1. Schema-TOLERANT input types — FCMissionReader exports vary by version, so
//      we never hard-wire a schema. We accept unknown-shaped JSON and probe it.
//   2. The MapAnalysis OUTPUT contract — the only thing that leaves the tool and
//      the only thing that may be committed. See PLAN.md §5.2.
//
// Guardrail (PLAN.md §2): the output is ALWAYS normalized to a unit square and
// quantized to a grid. No raw world coordinates ever appear in MapAnalysis.

// ---------------------------------------------------------------------------
// Input-tolerant types
// ---------------------------------------------------------------------------

/** Any JSON value, as parsed. We narrow at the edges, never trust the shape. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A raw point on the ground plane, extracted from an arbitrary input object. */
export interface RawPoint {
  /** Stable id derived from array index (NET) or actor index (ACT). */
  readonly id: string;
  /** First ground-plane axis (raw world units). */
  readonly gx: number;
  /** Second ground-plane axis (raw world units). */
  readonly gy: number;
}

/** A raw NET node plus any explicit adjacency the export happened to carry. */
export interface RawNode extends RawPoint {
  /** Neighbour ids as strings; empty when the export has no edges. */
  readonly neighbors: readonly string[];
}

/** A raw ACT actor: a positioned prop with a best-effort type label. */
export interface RawActor extends RawPoint {
  /** Raw type token from the export (id or name), lower-cased; "" if absent. */
  readonly type: string;
}

/** Field-name / role overrides. Every field is optional; sensible defaults apply. */
export interface Config {
  readonly net?: {
    /** Dotted path to the node array; auto-detected when omitted. */
    readonly nodesPath?: string;
    readonly fields?: FieldMap;
    /** Dotted path to an explicit edge array (pairs or {from,to} objects). */
    readonly edgesPath?: string;
    /** Per-node neighbour field name, e.g. "neighbors" | "links" | "edges". */
    readonly neighborsField?: string;
  };
  readonly act?: {
    readonly actorsPath?: string;
    readonly fields?: FieldMap;
    /** Field carrying the actor type token. */
    readonly typeField?: string;
  };
  readonly graph?: {
    /** How to synthesize edges when the export has none. */
    readonly inferEdges?: "knn" | "radius";
    readonly k?: number;
    /** Radius in RAW world units (pre-normalization). */
    readonly radius?: number;
  };
  /** Role token → canonical NodeRole mapping (tokens are matched case-insensitively). */
  readonly roles?: Readonly<Record<string, readonly string[]>>;
  /** Quantization grid; positions snap to multiples of 1/grid. Default 100. */
  readonly grid?: number;
  /**
   * Max distance (normalized units) an ACT actor may be from a NET node to
   * claim its role. Default = a few grid cells.
   */
  readonly snapRadius?: number;
}

export interface FieldMap {
  readonly x?: string;
  readonly y?: string;
  readonly z?: string;
  readonly id?: string;
  /** Field carrying `[x, y, z]` (or `[x, y]`); takes precedence over x/y/z. */
  readonly position?: string;
}

// ---------------------------------------------------------------------------
// Output contract — MapAnalysis (PLAN.md §5.2)
// ---------------------------------------------------------------------------

/** Normalized + quantized ground position in [0,1]². Never a world coordinate. */
export type Vec2 = readonly [number, number];

export type NodeRole =
  | "base"
  | "spawn"
  | "turret"
  | "capture"
  | "junction"
  | "chokepoint"
  | "endpoint"
  | "other";

export const NODE_ROLES: readonly NodeRole[] = [
  "base",
  "spawn",
  "turret",
  "capture",
  "junction",
  "chokepoint",
  "endpoint",
  "other",
];

export type SymmetryType = "mirror-x" | "mirror-y" | "rot180" | "none";

export interface MapAnalysis {
  readonly schema: "mapalyze/1";
  readonly provenance: "abstracted-analysis";
  readonly label: string;
  readonly space: {
    readonly normalized: true;
    readonly grid: number;
    readonly note: "relative, quantized — not a geometric reconstruction";
  };
  readonly topology: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly components: number;
    readonly roleCounts: Readonly<Record<NodeRole, number>>;
  };
  readonly bases: ReadonlyArray<{ readonly id: string; readonly pos: Vec2 }>;
  readonly lanes: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly hops: number;
    readonly lengthNorm: number;
    readonly lengthRatio: number;
  }>;
  readonly chokepoints: ReadonlyArray<{
    readonly pos: Vec2;
    readonly degree: number;
    readonly onLanes: ReadonlyArray<string>;
  }>;
  readonly turrets: ReadonlyArray<{ readonly pos: Vec2; readonly nearestLane: string }>;
  readonly spawns: ReadonlyArray<{ readonly pos: Vec2; readonly nearestBase: string }>;
  readonly symmetry: {
    readonly type: SymmetryType;
    readonly score: number;
  };
  readonly summary: string;
}
