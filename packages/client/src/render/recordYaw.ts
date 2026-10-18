// One record angle, one turn (fcop-fidelity.md G12): how an angle a record of
// the original stores (4096 a turn) stands a model in the sim and in three.
//
// The chain, from the RE:
//
// - the record's halfword is the actor's yaw: a type-11 prop's at payload +0x22,
//   a turret base part's at +0x42 (`turret_part_construct`, turret_part.c
//   0x0041cf70: `movsx [edi + 0x46]` on the turret path, `[edi + 0x26]` on the
//   other, edi the payload less four), a turret gun's at +0x34
//   (`turret_construct` 0x0041c222), a lift's at +0x32 of its own block;
// - the construct writes `My(a)` word by word (0x0041d092..0x0041d0d3), the
//   builder's own single-angle case (math_matrix_from_angles, fcop/matrix.h):
//   rows (cos a, 0, -sin a), (0, 1, 0), (sin a, 0, cos a);
// - the engine is row-vector (v' = v * M, row r the image of basis vector r)
//   and the draw keeps it: `camera_place_to_view` (0x004347c0) carries the
//   placement's three rows and its translation through the view as four
//   vectors, so a model vertex v lands at v * M + position. The model's +z goes
//   to the game's (sin a, 0, cos a);
// - the actors frame the sim and the terrain are built in swaps the game's x
//   and z (sim x = game z, sim y = game x), so that heading is the sim's
//   (cos a, sin a): the record angle IS the sim yaw. That is what the X1Alpha's
//   spawn facing already proves (enrichArena.ts out0Spawns, facing the gate) and
//   what every unit's motion does (nose along its heading, +z forward);
// - every Cobj glb the RE exports (tools/gfx/obj_mesh.py, extract_objects.py,
//   the pickup and lift packs too) is the Cobj with its x negated, left- to
//   right-handed. The swap and the negation are both mirrors and cancel: in
//   three the model turns by pi/2 - a about +y and is not mirrored, its winding
//   kept (front faces stay front faces).
//
// So one mapping: sim yaw = a, three turn = pi/2 - a. A geometry that carries
// the units' quarter turn baked (unitMeshes.ts, the turret and Dreadnought parts
// in arenaUnits.ts: rotateY(pi/2)) turns by pi/2 - a - pi/2 = -a.

/** The original's angle unit: 4096 a turn (fcop/math.h MATH_TURN). */
export const RECORD_TURN = 4096;

/** The quarter turn unitMeshes.ts and arenaUnits.ts bake into a unit's geometry. */
export const BAKED_TURN = Math.PI / 2;

/** The sim's yaw for a record angle: heading (cos, sin) on the sim's (x, y). */
export function recordYaw(raw: number): number {
  return (raw * 2 * Math.PI) / RECORD_TURN;
}

/** Three's turn about +y that stands an RE glb at sim yaw `yaw`: pi/2 - yaw, no mirror. */
export function yawTurn(yaw: number): number {
  return Math.PI / 2 - yaw;
}

/** Three's turn about +y for a record angle, on an RE glb as exported. */
export function recordTurn(raw: number): number {
  return yawTurn(recordYaw(raw));
}
