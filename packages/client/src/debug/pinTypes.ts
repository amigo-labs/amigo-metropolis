// Verification pin payload — debug-only bridge from fly mode to the agent.
// No sim coupling; pure data the pin server / download path writes to disk.

export interface PinCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface PinHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Grid column (sim x / cellSize), floored. */
  readonly col: number;
  /** Grid row (sim y / cellSize), floored. */
  readonly row: number;
  readonly source: "heightfield" | "miss";
}

export interface PinNearby {
  readonly kind: string;
  readonly id?: number;
  readonly x: number;
  readonly z: number;
  readonly dist: number;
}

export interface VerificationPin {
  readonly version: 1;
  readonly createdAt: string;
  readonly mapId: string;
  readonly url: string;
  readonly render: string;
  readonly seed: number | null;
  readonly tick: number | null;
  readonly camera: PinCamera;
  readonly hit: PinHit;
  readonly nearby: readonly PinNearby[];
  /** User problem text from the pin modal (may be empty). */
  readonly notes: string;
}
