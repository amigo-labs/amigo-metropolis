// The damaged arms (fcop-fidelity.md G13): an actor the tick just hit draws in
// `cact_model_shade_face`'s other table (0x00428ff0) -- red whole, green and
// blue halved -- for one frame.
//
// The original's flag is `CACT_FLAG_DAMAGED`, bit 25 of the actor's flags.
// Damage that lands sets it (`cact_base_op11` 0x0041a7bf, `cact_base_op9`
// 0x0041a73c; the player's `player_credit_amount` on the mech and its partner
// both, 0x00446649..), a turret's parts and a Dreadnought's guns take their
// owner's every tick (turret.c 674-690, mount.c 0x0042580a), and
// `cact_model_submit` hands it to the draw (0x004280d6). Nothing else clears it
// but the registry pass, which runs at the top of every frame before the actors
// tick (`mission_update` 0x00407473 -> 0x0043b520: 0x02000000 cleared on every
// actor it keeps). So an actor hit in a tick is drawn red in the frame that
// follows and in no other.
//
// Here the tick is the sim's: every EV_HIT of a step whose damage is positive
// (applyDamage pushes none for an invulnerable avatar or a console, as the
// original's immune flag refuses the store) marks its target until the next
// step, and the frames drawn in between draw it red. The meshes read the mark
// per instance off HIT_ATTRIBUTE (render/fcopModel.ts), written here on a
// change only. A power-up pickup blinks the same way (pickup.c 0x0041e590:
// block-B ammunition, while the frame clock's bit 7 is set): render/pickups.ts.
//
// Renderer rules: preallocated; noteHits and writeHit allocate nothing.

import { EV_HIT, EVENT_STRIDE, type EventBuffer, MAX_ENTITIES } from "@metropolis/sim";
import * as THREE from "three";
import { HIT_ATTRIBUTE } from "./fcopModel";

/** Per entity id: 1 while the latest step hit it. */
const marked = new Uint8Array(MAX_ENTITIES);
/** The ids marked, so the next step clears only those. */
const markedIds = new Int32Array(MAX_ENTITIES);
let markedCount = 0;

/**
 * One sim step's events: the targets of its positive EV_HITs are hit until
 * the next step, every earlier mark cleared (the registry pass). Per step.
 */
export function noteHits(events: EventBuffer): void {
  for (let i = 0; i < markedCount; i++) marked[markedIds[i]] = 0;
  markedCount = 0;
  const d = events.data;
  for (let i = 0; i < events.count; i++) {
    const e = i * EVENT_STRIDE;
    if (d[e] !== EV_HIT || d[e + 3] <= 0) continue;
    const id = d[e + 1];
    if (id < 0 || id >= MAX_ENTITIES || marked[id] === 1) continue;
    marked[id] = 1;
    markedIds[markedCount++] = id;
  }
}

/** Whether entity `id` was hit in the latest step: `CACT_FLAG_DAMAGED`. */
export function isHit(id: number): boolean {
  return id >= 0 && id < MAX_ENTITIES && marked[id] === 1;
}

/** Forgets every mark (an arena swap, a new match). */
export function clearHits(): void {
  for (let i = 0; i < markedCount; i++) marked[markedIds[i]] = 0;
  markedCount = 0;
}

/** A mesh's per-instance flag, all clear. Load time only. */
export function createHitAttribute(capacity: number): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  return attr;
}

/**
 * Sets slot `slot`'s flag on `mesh` when it changed; a mesh without the
 * attribute (a greybox stand-in, an unlit model) is left alone.
 */
export function writeHit(mesh: THREE.InstancedMesh, slot: number, hit: boolean): void {
  const attr = mesh.geometry.getAttribute(HIT_ATTRIBUTE) as
    | THREE.InstancedBufferAttribute
    | undefined;
  if (!attr || slot >= attr.count) return;
  // Written every call and uploaded on a change only (`needsUpdate = false`
  // bumps no version): a branch the frame loop seldom takes has no type
  // feedback and deopts it into allocating (render/avatarRig.ts placeX1).
  const a = attr.array as Float32Array;
  const v = hit ? 1 : 0;
  const changed = a[slot] !== v;
  a[slot] = v;
  attr.needsUpdate = changed;
}
