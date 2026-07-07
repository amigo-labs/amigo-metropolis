import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { countAlive, createEntityStore, despawn, spawn } from "../src/entities";

describe("entity store", () => {
  it("assigns dense ids from zero", () => {
    const s = createEntityStore(8);
    expect(spawn(s, ARCHETYPE.AVATAR, 0)).toBe(0);
    expect(spawn(s, ARCHETYPE.RUNNER, 1)).toBe(1);
    expect(spawn(s, ARCHETYPE.RUNNER, 0)).toBe(2);
    expect(s.high).toBe(3);
    expect(countAlive(s)).toBe(3);
  });

  it("recycles freed ids LIFO before growing the watermark", () => {
    const s = createEntityStore(8);
    spawn(s, ARCHETYPE.RUNNER, 0);
    spawn(s, ARCHETYPE.RUNNER, 0);
    spawn(s, ARCHETYPE.RUNNER, 0);
    despawn(s, 1);
    despawn(s, 0);
    expect(spawn(s, ARCHETYPE.RUNNER, 1)).toBe(0);
    expect(spawn(s, ARCHETYPE.RUNNER, 1)).toBe(1);
    expect(spawn(s, ARCHETYPE.RUNNER, 1)).toBe(3);
    expect(s.high).toBe(4);
  });

  it("returns -1 when full instead of throwing", () => {
    const s = createEntityStore(2);
    expect(spawn(s, ARCHETYPE.RUNNER, 0)).toBe(0);
    expect(spawn(s, ARCHETYPE.RUNNER, 0)).toBe(1);
    expect(spawn(s, ARCHETYPE.RUNNER, 0)).toBe(-1);
    despawn(s, 0);
    expect(spawn(s, ARCHETYPE.RUNNER, 0)).toBe(0);
  });

  it("zeroes all fields on despawn so freed slots hash like unused ones", () => {
    const a = createEntityStore(8);
    const b = createEntityStore(8);
    // a: spawn two, mutate, despawn the first. b: only ever spawn the second.
    const id0 = spawn(a, ARCHETYPE.AVATAR, 1);
    a.posX[id0] = 12.5;
    a.posY[id0] = -3;
    a.hp[id0] = 300;
    a.yaw[id0] = 1.25;
    a.animState[id0] = 2;
    const id1a = spawn(a, ARCHETYPE.RUNNER, 0);
    a.posX[id1a] = 7;
    despawn(a, id0);

    spawn(b, ARCHETYPE.RUNNER, 0); // takes id 0 in b
    // Rebuild b so entity layout matches a: id 0 free, id 1 the runner.
    const c = createEntityStore(8);
    spawn(c, ARCHETYPE.AVATAR, 1);
    const id1c = spawn(c, ARCHETYPE.RUNNER, 0);
    c.posX[id1c] = 7;
    despawn(c, 0);

    expect(a.bytes.slice(0, a.fieldBytes)).toEqual(c.bytes.slice(0, c.fieldBytes));
  });

  it("iterates alive entities in dense id order", () => {
    const s = createEntityStore(8);
    spawn(s, ARCHETYPE.RUNNER, 0);
    spawn(s, ARCHETYPE.GUARDIAN, 0);
    spawn(s, ARCHETYPE.TURRET, 0);
    despawn(s, 1);
    const seen: number[] = [];
    for (let id = 0; id < s.high; id++) {
      if (s.alive[id]) seen.push(id);
    }
    expect(seen).toEqual([0, 2]);
  });

  it("keeps the free-list Int32Array 4-byte aligned for odd caps", () => {
    const s = createEntityStore(7);
    expect(s.freeList.byteOffset % 4).toBe(0);
    expect(spawn(s, ARCHETYPE.RUNNER, 0)).toBe(0);
    despawn(s, 0);
    expect(s.freeList[0]).toBe(0);
  });
});
