// Original arena scenery (fcop-fidelity.md G2, G10): every type-11 record
// (DynamicProp) of the arena's own mission, drawn with that mission's own Cobjs
// (public/models/props/<mapId>/, tools/generators/units/manifest.ts
// ARENA_SCENERY) where, how high, which way and when the original stands it —
// render/arenaScenery.generated.ts, which `bun run gen:scenery` reads out of the
// mission's bytes and scripts:
//
// - the height is the record construct's own (RE turret_part.c 0x0041cf70):
//   `terrain_height_at` on the record's layer, the topmost surface for all but
//   three flags of each arena, so a flag on a deck stands on the deck instead
//   of inside it;
// - the yaw is the record's `My(yaw)`, which three draws as a turn of
//   pi/2 - yaw about +y on the glb, not mirrored (render/recordYaw.ts, the one
//   mapping every record angle takes);
// - an outpost's console (Cobj 29) stands until the outpost is claimed, and the
//   claim brings up its two terminals (27 and 33 on Mp) — the activation script
//   destroys the one and spawns the others (RE docs/behavior/precinct-assault.md
//   "Outposts"). The outpost's owner is the side of its console in the snapshot
//   (render/arenaUnits.ts `outpostSides`), which is also what colours its flags;
// - a base's two heavy terminals (the Dreadnought's and the Flying Fortress's,
//   Cobj 34 / 35 on Mp) stand once the poll that opens the base's heavy zones
//   has requested them (fn30 / fn31, at the first 50 points it sees): the
//   placements the sim's map names `heavyZones.terminals`, shown while the
//   match snapshot's MATCH_SLOT_TERMINALS for that base is 1.
//
// The outpost flags (Cobj 28 on all six arenas; RE pa_models.json
// `outpost_flag`): the claim script sets every flag of the outpost's group to the
// claimer's texture offset (v 25 for side 1, 51 for side 2; RE mission_frame.c
// 1102-1107), the per-instance offset the units wear (render/teamUv.ts), and
// their cloth is the model's six-frame morph, track 0 stepped by the frame
// delta from the mission's start (RE turret_part.c 0x0041cee2): every flag of
// the arena on the same frame, a frame each 20/300 s.
//
// Render-only, and one-way: nothing here feeds the sim. Each model is one
// InstancedMesh with an instance per record, its matrix written at load;
// `updateProps` runs per frame, allocates nothing and writes only what changed —
// an instance shown or hidden by a claim, a flag's offset, the cloth's frame.
//
// Same tolerance as the unit and map loaders: an absent or broken .glb costs
// that model's scenery and nothing else. There is no greybox stand-in on
// purpose — the textured terrain already carries the arena's buildings, and
// these are the separate actors on top of it, so their absence reads as a
// plainer arena rather than a broken one.

import { MATCH_SLOT_TERMINALS, type MapData, matchSlotOffset } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  type ArenaScenery,
  SCENERY_PLACEMENTS,
  type SceneryMorph,
  type SceneryPlacement,
} from "./arenaScenery.generated";
import { arenaUnitsFor } from "./arenaUnits";
import { disposeSubtree } from "./meshMap";
import { recordTurn } from "./recordYaw";
import {
  atlasOffset,
  createTeamUvAttribute,
  patchTeamUv,
  prepareTeamUvMask,
  TEAM_UV_ATTR,
} from "./teamUv";

const loader = new GLTFLoader();

const UP = new THREE.Vector3(0, 1, 0);
/** The engine clock a frame delta is counted in (RE fcop/clock.h). */
const ENGINE_HZ = 300;

/**
 * The arena's model for a Cobj id: tools/generators/units/manifest.ts
 * PROP_MODELS writes `props/<mapId>/prop-<cobj>.glb`, and propUrls.test.ts
 * holds every placement of every arena to a committed file there.
 */
export function propModelUrl(mapId: string, cobj: number): string {
  return `/models/props/${mapId}/prop-${String(cobj).padStart(3, "0")}.glb`;
}

/** The arena's scenery, or null for a map the RE has no mission for (test-128). */
export function sceneryOf(mapId: string): ArenaScenery | null {
  return SCENERY_PLACEMENTS[mapId] ?? null;
}

/** Whether a placement stands while its outpost is (or is not) claimed. */
export function propShown(p: SceneryPlacement, claimed: boolean): boolean {
  if (p.show === "always") return true;
  return (p.show === "claimed") === claimed;
}

/**
 * The base (team) whose heavy terminals a placement is — one of the Csac
 * templates its heavy poll requests, `map.bases[t].heavyZones.terminals` — or
 * -1 for any other placement.
 */
export function terminalBaseOf(map: MapData, p: SceneryPlacement): number {
  for (let t = 0; t < map.bases.length; t++) {
    const terminals = map.bases[t].heavyZones?.terminals ?? [];
    if (terminals.some((id) => p.record === `Csac ${id}`)) return t;
  }
  return -1;
}

/**
 * The frame a looping morph shows `seconds` into the mission: track 0 starts
 * at frame 0 and steps a frame per `period` / 300 s (RE `cact_anim_step`).
 */
export function propMorphFrame(morph: SceneryMorph, seconds: number): number {
  const frames = Math.floor((seconds * ENGINE_HZ) / morph.period);
  return frames % morph.frames;
}

/** One model of the arena, once loaded. */
interface PropMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly placements: readonly SceneryPlacement[];
  /** Per instance: its standing matrix, written back when it is shown. */
  readonly matrices: Float32Array;
  /** Per instance: 1 shown, 0 hidden, -1 unwritten. */
  readonly shown: Int8Array;
  /** Per instance: the base whose heavy terminal it is (terminalBaseOf), or -1. */
  readonly base: Int8Array;
  /** Some instance stands by its outpost's claim or its base's terminals. */
  readonly stateful: boolean;
  /** The outpost flags: per instance the side shown, and the offset per side. */
  readonly flags: {
    readonly attr: THREE.InstancedBufferAttribute;
    readonly side: Int8Array;
    /** [unclaimed, side 1, side 2] as u, v pairs, atlas units. */
    readonly bySide: Float32Array;
  } | null;
  /**
   * The cloth: the morph, the frame shown (-1 unwritten), and the mesh's morph
   * texture — a row per instance, the base influence then one per target. An
   * InstancedMesh morphs only through its texture (three's InstancedMesh keeps
   * no shared influences), so every row holds the same frame.
   */
  readonly morph: {
    readonly track: SceneryMorph;
    readonly texture: THREE.DataTexture;
    readonly len: number;
    frame: number;
  } | null;
}

let meshes: PropMesh[] = [];
/** Seconds of sim time since the arena's scenery loaded: the morphs' clock. */
let clock = 0;
/** A zero-scale matrix: how an instance that does not stand is drawn. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const scratch = new THREE.Matrix4();

/**
 * Per frame, after the entity sweep: `sideOf[k]` is the side (0 nobody's, 1,
 * 2) holding outpost k; `match` the match snapshot (its MATCH_SLOT_TERMINALS);
 * `simDtSec` the sim time the frame advanced (0 while paused). Shows and hides
 * what a claim or a base's heavy poll changes, colours the flags, steps the
 * cloth. Writes only on a change.
 */
export function updateProps(
  sideOf: ArrayLike<number>,
  match: ArrayLike<number>,
  simDtSec: number,
): void {
  clock += simDtSec;
  for (let m = 0; m < meshes.length; m++) {
    const pm = meshes[m];
    let matricesDirty = false;
    if (pm.stateful) {
      for (let i = 0; i < pm.placements.length; i++) {
        const p = pm.placements[i];
        const b = pm.base[i];
        const claimed = p.outpost >= 0 && (sideOf[p.outpost] ?? 0) !== 0;
        const up =
          b >= 0 ? match[matchSlotOffset(b) + MATCH_SLOT_TERMINALS] === 1 : propShown(p, claimed);
        const shown = up ? 1 : 0;
        if (pm.shown[i] === shown) continue;
        pm.shown[i] = shown;
        if (shown === 1) scratch.fromArray(pm.matrices, i * 16);
        pm.mesh.setMatrixAt(i, shown === 1 ? scratch : HIDDEN);
        matricesDirty = true;
      }
    }
    if (matricesDirty) pm.mesh.instanceMatrix.needsUpdate = true;
    const f = pm.flags;
    if (f) {
      const a = f.attr.array as Float32Array;
      let dirty = false;
      for (let i = 0; i < pm.placements.length; i++) {
        const k = pm.placements[i].outpost;
        const side = k >= 0 ? (sideOf[k] ?? 0) : 0;
        if (f.side[i] === side) continue;
        f.side[i] = side;
        a[i * 2] = f.bySide[side * 2];
        a[i * 2 + 1] = f.bySide[side * 2 + 1];
        dirty = true;
      }
      if (dirty) f.attr.needsUpdate = true;
    }
    const morph = pm.morph;
    if (morph) {
      const frame = propMorphFrame(morph.track, clock);
      if (frame !== morph.frame) {
        morph.frame = frame;
        // Frame k + 1 is target k at weight 1 (gen:units); frame 0 is the base,
        // which relative targets always count in full.
        const a = morph.texture.image.data as Float32Array;
        for (let i = 0; i < pm.placements.length; i++) {
          const row = i * morph.len;
          a[row] = 1;
          for (let k = 1; k < morph.len; k++) a[row + k] = k === frame ? 1 : 0;
        }
        morph.texture.needsUpdate = true;
      }
    }
  }
}

/**
 * Kicks off one async load per distinct model of the arena's scenery. Fire and
 * forget: each model's InstancedMesh joins the arena group when its .glb
 * arrives. Forgets the previous arena's meshes (their group is disposed by the
 * caller).
 */
export function loadProps(map: MapData, group: THREE.Object3D, cancelled?: () => boolean): void {
  meshes = [];
  clock = 0;
  const scenery = sceneryOf(map.id);
  if (!scenery) return;
  const byModel = new Map<number, SceneryPlacement[]>();
  for (const p of scenery.placements) {
    const list = byModel.get(p.cobj);
    if (list) list.push(p);
    else byModel.set(p.cobj, [p]);
  }
  for (const [cobj, placements] of byModel) {
    addPropMesh(map, scenery, group, cobj, placements, cancelled);
  }
}

/** The standing matrix of each placement, in placement order. */
export function propMatrices(placements: readonly SceneryPlacement[]): Float32Array {
  const out = new Float32Array(placements.length * 16);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const matrix = new THREE.Matrix4();
  placements.forEach((p, i) => {
    // Sim (x, y) is the ground plane and three's Y is up; the model's own
    // origin is its contact point, and `h` is the height the record stands at.
    position.set(p.x, p.h, p.y);
    quaternion.setFromAxisAngle(UP, recordTurn(p.yaw));
    matrix.compose(position, quaternion, scale);
    matrix.toArray(out, i * 16);
  });
  return out;
}

function addPropMesh(
  map: MapData,
  scenery: ArenaScenery,
  group: THREE.Object3D,
  cobj: number,
  placements: readonly SceneryPlacement[],
  cancelled?: () => boolean,
): void {
  const url = propModelUrl(map.id, cobj);
  loader.loadAsync(url).then(
    (gltf) => {
      // Stale (the arena was swapped while this loaded): free the loader's
      // resources instead of merging into a group that already left the scene.
      if (cancelled?.()) {
        disposeSubtree(gltf.scene);
        return;
      }
      // Init-time: allocations here are fine (same call as meshMap.ts's Box3).
      gltf.scene.updateMatrixWorld(true);
      const geometries: THREE.BufferGeometry[] = [];
      // The pipeline emits ONE material per prop, its colour entirely in a
      // single packed atlas. Keep that texture, drop the loader's material.
      let atlas: THREE.Texture | null = null;
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone();
        // gen:units writes the one node with the identity matrix, which is
        // what keeps a morph's deltas (applyMatrix4 leaves them alone) right.
        geometry.applyMatrix4(mesh.matrixWorld);
        geometries.push(geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          const std = material as THREE.MeshStandardMaterial;
          if (std.isMeshStandardMaterial && std.map && !atlas) atlas = std.map;
          material.dispose(); // material only — the kept map texture survives
        }
      });
      if (geometries.length === 0) {
        console.warn(`[props] empty prop asset at ${url}, skipping`);
        return;
      }
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
      if (!merged) {
        console.warn(`[props] unmergeable prop asset at ${url}, skipping`);
        return;
      }
      // No quarter-turn bake into the geometry, unlike unitMeshes.ts: the turn
      // is each record's own (recordTurn), in the instance matrix.

      // One material per model, never shared: rebuildArena disposes materials
      // and their maps by traversal, so a texture shared between two prop
      // meshes would be disposed twice.
      const material = new THREE.MeshStandardMaterial({
        flatShading: true,
        vertexColors: merged.hasAttribute("color"),
        map: atlas,
      });
      const flag = arenaUnitsFor(map.id).outpostFlag;
      let flags: PropMesh["flags"] = null;
      if (cobj === flag.cobj) {
        patchTeamUv(material);
        prepareTeamUvMask(merged);
        const attr = createTeamUvAttribute(placements.length);
        merged.setAttribute(TEAM_UV_ATTR, attr);
        const bySide = new Float32Array(6);
        for (let side = 0; side < 3; side++) {
          atlasOffset(atlas, flag.uv[side].u, flag.uv[side].v, bySide, side * 2);
        }
        flags = { attr, side: new Int8Array(placements.length).fill(-1), bySide };
      }
      const mesh = new THREE.InstancedMesh(merged, material, placements.length);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      const matrices = propMatrices(placements);
      const base = Int8Array.from(placements, (p) => terminalBaseOf(map, p));
      const bound = (i: number) => placements[i].show !== "always" || base[i] >= 0;
      const stateful = placements.some((_, i) => bound(i));
      for (let i = 0; i < placements.length; i++) {
        // A claim- or poll-bound instance is written by the first updateProps.
        if (bound(i)) mesh.setMatrixAt(i, HIDDEN);
        else mesh.setMatrixAt(i, scratch.fromArray(matrices, i * 16));
      }
      mesh.instanceMatrix.needsUpdate = true;

      const track = scenery.morphs[cobj];
      const targets = merged.morphAttributes.position?.length ?? 0;
      let morph: PropMesh["morph"] = null;
      if (track && targets === track.frames - 1) {
        const len = targets + 1;
        const texture = new THREE.DataTexture(
          new Float32Array(len * placements.length),
          len,
          placements.length,
          THREE.RedFormat,
          THREE.FloatType,
        );
        texture.needsUpdate = true;
        mesh.morphTexture = texture;
        morph = { track, texture, len, frame: -1 };
      } else if (track) {
        console.warn(`[props] ${url}: ${targets} morph targets for ${track.frames} frames`);
      }
      group.add(mesh);
      meshes.push({
        mesh,
        placements,
        matrices,
        shown: new Int8Array(placements.length).fill(stateful ? -1 : 1),
        base,
        stateful,
        flags,
        morph,
      });
    },
    () => {
      console.warn(`[props] no prop asset at ${url}, skipping`);
    },
  );
}
