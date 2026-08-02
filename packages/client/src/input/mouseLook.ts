// Yaw-only mouse steering for gameplay (input.spec §4.1).
//
// The original has no free aim and no vertical look: you turn the X1 left and
// right, the camera sits behind it at a fixed angle, and the gun points where
// the hull points. This is that model. Mouse X accumulates into a heading;
// mouse Y is read and thrown away rather than never read, so a mouse that
// reports both axes cannot leak pitch in through some later change.
//
// Deliberately NOT render/flyCamera.ts, which also pointer-locks: fly is a
// debug camera with free pitch and its own state, and the two must not share a
// heading. Same split the input/ layer already keeps — this samples SIM input
// per tick, fly poses a camera per frame.
//
// Client-local: the heading never enters the sim. What travels is the aim
// vector it produces, quantized to int8 like every other aim (netcode.spec §2).

/** Radians of yaw per pixel of mouse travel. A local preference (input.spec §8). */
export const DEFAULT_LOOK_SENSITIVITY = 0.0022;

const TAU = Math.PI * 2;

export interface MouseLook {
  /** Current heading in sim radians (atan2(y, x) convention). */
  readonly yaw: number;
  /** Drains accumulated movement into `yaw`. Call once per tick. */
  update(): void;
  /** True while the pointer is locked to the canvas. */
  readonly locked: boolean;
  /** Removes every listener it installed. */
  dispose(): void;
}

export interface MouseLookOptions {
  readonly sensitivity?: number;
  /** Start heading, so the avatar does not snap on the first tick. */
  readonly initialYaw?: number;
  /** Test seam: defaults to the canvas' own document. */
  readonly doc?: Document;
}

/** Wraps to [-PI, PI) so the heading cannot drift into large float territory. */
export function wrapYaw(yaw: number): number {
  let v = (yaw + Math.PI) % TAU;
  if (v < 0) v += TAU;
  return v - Math.PI;
}

export function createMouseLook(
  canvas: HTMLCanvasElement,
  options: MouseLookOptions = {},
): MouseLook {
  const sensitivity = options.sensitivity ?? DEFAULT_LOOK_SENSITIVITY;
  const doc = options.doc ?? canvas.ownerDocument;
  let yaw = wrapYaw(options.initialYaw ?? 0);
  let pendingX = 0;

  const onMouseMove = (e: MouseEvent) => {
    if (doc.pointerLockElement !== canvas) return;
    // movementY is deliberately not read. There is no pitch channel to put it
    // in: the camera's is fixed and the sim has none (inputs.ts is 5 bytes,
    // none of them elevation).
    pendingX += e.movementX;
  };
  const onClick = () => {
    if (doc.pointerLockElement !== canvas) canvas.requestPointerLock();
  };

  doc.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("click", onClick);

  return {
    get yaw() {
      return yaw;
    },
    get locked() {
      return doc.pointerLockElement === canvas;
    },
    update() {
      if (pendingX === 0) return;
      // Screen +X is to the right; sim yaw grows counter-clockwise, so moving
      // the mouse right has to DECREASE it or the avatar turns the wrong way.
      yaw = wrapYaw(yaw - pendingX * sensitivity);
      pendingX = 0;
    },
    dispose() {
      doc.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("click", onClick);
    },
  };
}
