// Ingest: turn schema-tolerant FCMissionReader JSON into RawNode / RawActor
// arrays. FCMissionReader exports vary by version, so nothing is hard-wired:
// we recursively probe for arrays of coordinate-bearing objects and let the
// user verify / override the mapping via --config (see example.config.json).
//
// GUARDRAIL (PLAN.md §2): only NET + ACT JSON is ever read here. There is no
// code path that touches TIL/OBJ geometry, BMP/PYR textures, or glTF.
//
// Ids are array indices as strings ("0","1",…). Explicit edges and per-node
// neighbour lists therefore reference node INDICES — the simplest scheme that
// survives version drift.

import type { Config, FieldMap, Json, RawActor, RawNode } from "./types";

const DEFAULT_COORD_KEYS = ["x", "y", "z"] as const;
const DEFAULT_NEIGHBOR_FIELDS = ["neighbors", "links", "edges", "adjacent", "connections"];
const DEFAULT_TYPE_FIELDS = ["type", "typeId", "typeID", "kind", "class", "name"];
const DEFAULT_EDGE_KEYS = ["edges", "links", "connections", "adjacency"];

function isObject(v: Json): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v: Json | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Resolve a dotted path (e.g. "map.nodes") to a value, or undefined. */
function getByPath(root: Json, path: string): Json | undefined {
  let cur: Json | undefined = root;
  for (const key of path.split(".")) {
    if (cur === undefined || !isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** True when a value looks like an edge list ([[a,b],…] or [{from,to},…]). */
function looksLikeEdges(v: Json | undefined): boolean {
  if (!Array.isArray(v) || v.length === 0) return false;
  const first = v[0];
  if (first === undefined) return false;
  if (Array.isArray(first)) return first.length >= 2 && isNumber(first[0]) && isNumber(first[1]);
  if (isObject(first)) {
    const fa = first.from ?? first.a ?? first.source;
    const fb = first.to ?? first.b ?? first.target;
    return isNumber(fa) && isNumber(fb);
  }
  return false;
}

/** Probe common top-level keys for an edge list when none is configured. */
function autoDetectEdgesPath(root: Json): string | undefined {
  if (!isObject(root)) return undefined;
  for (const key of DEFAULT_EDGE_KEYS) {
    if (looksLikeEdges(root[key])) return key;
  }
  return undefined;
}

/** A recursively discovered array of point-like objects. */
export interface ArrayCandidate {
  readonly path: string;
  readonly count: number;
  readonly fieldNames: readonly string[];
  readonly sample: Json;
  readonly hasZ: boolean;
}

function coordKeys(fields: FieldMap | undefined): readonly string[] {
  const keys = new Set<string>(DEFAULT_COORD_KEYS);
  if (fields?.x) keys.add(fields.x);
  if (fields?.y) keys.add(fields.y);
  if (fields?.z) keys.add(fields.z);
  return [...keys];
}

/** True when an object looks like it carries a ground position. */
function isPointObject(obj: { [key: string]: Json }, fields: FieldMap | undefined): boolean {
  if (fields?.position) {
    const arr = obj[fields.position];
    if (Array.isArray(arr) && arr.length >= 2 && isNumber(arr[0]) && isNumber(arr[1])) return true;
  }
  if (Array.isArray(obj.position) && obj.position.length >= 2) {
    if (isNumber(obj.position[0]) && isNumber(obj.position[1])) return true;
  }
  let numeric = 0;
  for (const key of coordKeys(fields)) {
    if (isNumber(obj[key])) numeric++;
  }
  return numeric >= 2;
}

/** Whether an object carries a numeric z (or the configured z field). */
function hasZField(obj: { [key: string]: Json }, fields: FieldMap | undefined): boolean {
  const zKey = fields?.z ?? "z";
  return isNumber(obj[zKey]);
}

/** Whether every object in the array carries z (→ ground plane is (x, z)). */
function allHaveZ(
  objs: ReadonlyArray<{ [key: string]: Json }>,
  fields: FieldMap | undefined,
): boolean {
  return objs.length > 0 && objs.every((o) => hasZField(o, fields));
}

/** Recursively find every array of point-like objects, deepest paths included. */
export function findPointArrays(root: Json, fields?: FieldMap): ArrayCandidate[] {
  const out: ArrayCandidate[] = [];
  const visit = (node: Json, path: string): void => {
    if (Array.isArray(node)) {
      const objs = node.filter(isObject);
      if (objs.length > 0 && objs.every((o) => isPointObject(o, fields))) {
        const first = objs[0] as { [key: string]: Json };
        const hasZ = allHaveZ(objs, fields);
        out.push({
          path: path || "(root)",
          count: objs.length,
          fieldNames: Object.keys(first),
          sample: first,
          hasZ,
        });
      }
      // Still descend: nested arrays may hold richer candidates.
      node.forEach((child, i) => {
        visit(child as Json, `${path}[${i}]`);
      });
      return;
    }
    if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(root, "");
  // Stable: largest arrays first, then by path for ties.
  return out.sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
}

/** Pick the point array: the configured path, else the largest candidate. */
function selectArray(
  root: Json,
  explicitPath: string | undefined,
  fields: FieldMap | undefined,
): { array: readonly Json[]; path: string; hasZ: boolean } {
  if (explicitPath) {
    const at = getByPath(root, explicitPath);
    if (!Array.isArray(at)) {
      throw new Error(`config path "${explicitPath}" is not an array`);
    }
    const objs = at.filter(isObject);
    const hasZ = allHaveZ(objs, fields);
    return { array: at, path: explicitPath, hasZ };
  }
  const candidates = findPointArrays(root, fields);
  const best = candidates[0];
  if (!best) throw new Error("no array of coordinate-bearing objects found (try --config)");
  const at = getByPath(root, best.path === "(root)" ? "" : best.path);
  const array = Array.isArray(at) ? at : (root as Json[]);
  return { array, path: best.path, hasZ: best.hasZ };
}

/**
 * Extract ground-plane coords. The vertical axis is dropped: the ground plane
 * is (x, z) when a z field exists across the array, otherwise (x, y).
 */
function groundCoords(
  obj: { [key: string]: Json },
  fields: FieldMap | undefined,
  hasZ: boolean,
): { gx: number; gy: number } | null {
  const posKey = fields?.position;
  const posArr = posKey ? obj[posKey] : obj.position;
  if (Array.isArray(posArr) && posArr.length >= 2) {
    const gx = posArr[0];
    const gy = posArr.length >= 3 ? posArr[2] : posArr[1];
    if (isNumber(gx) && isNumber(gy)) return { gx, gy };
  }
  const xKey = fields?.x ?? "x";
  const yKey = fields?.y ?? "y";
  const zKey = fields?.z ?? "z";
  const gx = obj[xKey];
  const gy = hasZ ? obj[zKey] : obj[yKey];
  if (isNumber(gx) && isNumber(gy)) return { gx, gy };
  return null;
}

function neighborIndices(
  obj: { [key: string]: Json },
  neighborsField: string | undefined,
): string[] {
  const fieldsToTry = neighborsField ? [neighborsField] : DEFAULT_NEIGHBOR_FIELDS;
  for (const f of fieldsToTry) {
    const v = obj[f];
    if (Array.isArray(v)) {
      const ids: string[] = [];
      for (const n of v) {
        if (isNumber(n)) ids.push(String(Math.trunc(n)));
        else if (typeof n === "string") ids.push(n);
      }
      return ids;
    }
  }
  return [];
}

export interface IngestNet {
  readonly nodes: readonly RawNode[];
  readonly hasExplicitEdges: boolean;
  readonly path: string;
  readonly groundAxes: readonly [string, string];
}

export function ingestNet(root: Json, config: Config): IngestNet {
  const fields = config.net?.fields;
  const { array, path, hasZ } = selectArray(root, config.net?.nodesPath, fields);

  const xKey = fields?.x ?? "x";
  const groundAxes: [string, string] = [xKey, hasZ ? (fields?.z ?? "z") : (fields?.y ?? "y")];

  // Explicit edge array (index pairs or {from,to}); becomes per-node neighbours.
  const edgeAdj = new Map<string, Set<string>>();
  let hasExplicitEdges = false;
  const edgesPath = config.net?.edgesPath ?? autoDetectEdgesPath(root);
  if (edgesPath) {
    const edges = getByPath(root, edgesPath);
    if (Array.isArray(edges)) {
      hasExplicitEdges = edges.length > 0;
      for (const e of edges) {
        let a: number | undefined;
        let b: number | undefined;
        if (Array.isArray(e) && e.length >= 2 && isNumber(e[0]) && isNumber(e[1])) {
          a = e[0];
          b = e[1];
        } else if (isObject(e)) {
          const fa = e.from ?? e.a ?? e.source;
          const fb = e.to ?? e.b ?? e.target;
          if (isNumber(fa) && isNumber(fb)) {
            a = fa;
            b = fb;
          }
        }
        if (a === undefined || b === undefined) continue;
        const sa = String(Math.trunc(a));
        const sb = String(Math.trunc(b));
        if (!edgeAdj.has(sa)) edgeAdj.set(sa, new Set());
        if (!edgeAdj.has(sb)) edgeAdj.set(sb, new Set());
        (edgeAdj.get(sa) as Set<string>).add(sb);
        (edgeAdj.get(sb) as Set<string>).add(sa);
      }
    }
  }

  const nodes: RawNode[] = [];
  array.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const g = groundCoords(raw, fields, hasZ);
    if (!g) return;
    const id = String(i);
    const perNode = neighborIndices(raw, config.net?.neighborsField);
    const fromEdges = edgeAdj.get(id);
    if (perNode.length > 0 && !hasExplicitEdges) hasExplicitEdges = true;
    // Merge per-node neighbours with the explicit edge list; sort for stability.
    const merged = new Set<string>(perNode);
    if (fromEdges) for (const n of fromEdges) merged.add(n);
    const neighbors = [...merged].sort((x, y) => Number(x) - Number(y));
    nodes.push({ id, gx: g.gx, gy: g.gy, neighbors });
  });

  return { nodes, hasExplicitEdges, path, groundAxes };
}

export interface IngestAct {
  readonly actors: readonly RawActor[];
  readonly path: string;
}

export function ingestAct(root: Json, config: Config): IngestAct {
  const fields = config.act?.fields;
  const { array, path, hasZ } = selectArray(root, config.act?.actorsPath, fields);
  const typeFields = config.act?.typeField ? [config.act.typeField] : DEFAULT_TYPE_FIELDS;

  const actors: RawActor[] = [];
  array.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const g = groundCoords(raw, fields, hasZ);
    if (!g) return;
    let type = "";
    for (const f of typeFields) {
      const v = raw[f];
      if (typeof v === "string") {
        type = v.toLowerCase();
        break;
      }
      if (isNumber(v)) {
        type = String(Math.trunc(v));
        break;
      }
    }
    actors.push({ id: String(i), gx: g.gx, gy: g.gy, type });
  });
  return { actors, path };
}

/** Tally distinct ACT type tokens with counts + a sample position (list-types). */
export function tallyActorTypes(
  actors: readonly RawActor[],
): ReadonlyArray<{ type: string; count: number; sample: readonly [number, number] }> {
  const tally = new Map<string, { count: number; sample: readonly [number, number] }>();
  for (const a of actors) {
    const existing = tally.get(a.type);
    if (existing) existing.count++;
    else tally.set(a.type, { count: 1, sample: [a.gx, a.gy] });
  }
  return [...tally.entries()]
    .map(([type, v]) => ({ type, count: v.count, sample: v.sample }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
}

export function parseJson(text: string): Json {
  return JSON.parse(text) as Json;
}
