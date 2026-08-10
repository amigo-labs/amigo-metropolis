import { describe, expect, test } from "bun:test";
import { createMouseLook, DEFAULT_LOOK_SENSITIVITY, wrapYaw } from "../src/input/mouseLook";

/**
 * Minimal DOM stand-in. bun:test has no browser, and the whole surface here is
 * two listeners plus `pointerLockElement`, so a real DOM would be more moving
 * parts than the thing under test.
 */
function harness(locked = true) {
  const listeners = new Map<string, ((e: MouseEvent) => void)[]>();
  const add = (type: string, fn: (e: MouseEvent) => void) => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  };
  const remove = (type: string, fn: (e: MouseEvent) => void) => {
    const list = listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  let requested = 0;
  const canvas = {
    addEventListener: add,
    removeEventListener: remove,
    requestPointerLock: () => {
      requested++;
    },
  };
  const doc = {
    addEventListener: add,
    removeEventListener: remove,
    get pointerLockElement() {
      return locked ? canvas : null;
    },
  };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    doc: doc as unknown as Document,
    move(movementX: number, movementY: number) {
      for (const fn of listeners.get("mousemove") ?? []) fn({ movementX, movementY } as MouseEvent);
    },
    click() {
      for (const fn of listeners.get("click") ?? []) fn({} as MouseEvent);
    },
    get requested() {
      return requested;
    },
    count(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

describe("mouse look — yaw only", () => {
  test("mouse X turns; mouse Y does nothing at all", () => {
    const h = harness();
    const look = createMouseLook(h.canvas, { doc: h.doc, initialYaw: 0 });

    h.move(0, 500);
    look.update();
    expect(look.yaw).toBe(0);

    h.move(100, -500);
    look.update();
    expect(look.yaw).toBeCloseTo(100 * DEFAULT_LOOK_SENSITIVITY, 10);
  });

  test("moving the mouse right turns the avatar right", () => {
    // The chase rig sits behind the ground-forward (cos yaw, 0, sin yaw), and
    // three's camera right is forward x up = +Z at yaw 0. d(forward)/d(yaw) is
    // +Z there as well, so a rightward drag has to INCREASE the heading.
    //
    // This asserted `< 0` for as long as the bug shipped, with a confident
    // comment about sim yaw growing counter-clockwise. It does — on a chart with
    // +y up. On screen sim y is three z, which runs down the view, so the
    // player sees the opposite rotation. A magnitude-only test cannot catch
    // this; the sign is the whole test.
    const h = harness();
    const look = createMouseLook(h.canvas, { doc: h.doc, initialYaw: 0 });
    h.move(50, 0);
    look.update();
    expect(look.yaw).toBeGreaterThan(0);
  });

  test("movement only accumulates while the pointer is locked", () => {
    const h = harness(false);
    const look = createMouseLook(h.canvas, { doc: h.doc, initialYaw: 0.5 });
    h.move(400, 0);
    look.update();
    expect(look.yaw).toBe(0.5);
    expect(look.locked).toBe(false);
  });

  test("clicking an unlocked canvas asks for the lock", () => {
    const h = harness(false);
    createMouseLook(h.canvas, { doc: h.doc });
    h.click();
    expect(h.requested).toBe(1);
  });

  test("the heading stays wrapped instead of winding up", () => {
    const h = harness();
    const look = createMouseLook(h.canvas, { doc: h.doc, initialYaw: 0 });
    for (let i = 0; i < 200; i++) {
      h.move(100, 0);
      look.update();
    }
    expect(look.yaw).toBeGreaterThan(-Math.PI);
    expect(look.yaw).toBeLessThanOrEqual(Math.PI);
  });

  test("update with no movement is a no-op, so a held heading does not drift", () => {
    const h = harness();
    const look = createMouseLook(h.canvas, { doc: h.doc, initialYaw: 1.234 });
    for (let i = 0; i < 100; i++) look.update();
    expect(look.yaw).toBe(1.234);
  });

  test("dispose removes both listeners", () => {
    const h = harness();
    const look = createMouseLook(h.canvas, { doc: h.doc });
    expect(h.count("mousemove")).toBe(1);
    expect(h.count("click")).toBe(1);
    look.dispose();
    expect(h.count("mousemove")).toBe(0);
    expect(h.count("click")).toBe(0);
  });

  test("wrapYaw maps onto [-PI, PI)", () => {
    // Half-open at +PI: exactly-PI comes back as -PI. Same heading either way,
    // and it keeps the wrap a single modulo.
    expect(wrapYaw(0)).toBe(0);
    expect(wrapYaw(Math.PI)).toBeCloseTo(-Math.PI, 10);
    expect(wrapYaw(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 10);
    expect(wrapYaw(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 10);
    expect(wrapYaw(7 * Math.PI)).toBeCloseTo(-Math.PI, 10);
  });
});
