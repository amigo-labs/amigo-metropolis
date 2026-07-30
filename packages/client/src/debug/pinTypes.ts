// Verification pin payload — debug-only bridge from fly mode to the agent.
// No sim coupling; pure data the pin server / download path writes to disk.
//
// v2 is additive over v1: every v1 field kept its name and meaning, so a reader
// written against v1 still works. New in v2 — the things an agent could not
// otherwise get at: dynamic entities near the hit, a second top-down shot with
// its exact camera params, the console tail, the sim hash, and client/GPU info.

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

/**
 * One live entity near the hit, decoded from the sim snapshot (stride 10,
 * architecture.md §3). `archetype` / `anim` are names, not numbers: the agent
 * reads these, and a raw `3` means nothing without the table.
 */
export interface PinEntity {
  readonly id: number;
  readonly archetype: string;
  readonly team: number;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly yaw: number;
  readonly anim: readonly string[];
  /**
   * Snapshot slot 8, verbatim: `hp / ARCHETYPE_MAX_HP[archetype]`. Usually 0..1,
   * but NOT always a fraction — a map that overrides HP per spot (la-cantina's
   * `turretHp` is 500 against a TURRET max of 100) reports >1. Passed through
   * unclamped so the number matches the sim rather than looking tidy.
   */
  readonly hpFrac: number;
  readonly aux: number;
  readonly dist: number;
}

/**
 * Camera params of one saved shot, enough to map a pixel back to a world/grid
 * position without a renderer. `world` is the axis-aligned area the frame
 * covers (ortho only); a perspective shot leaves it null and the agent treats
 * the image as qualitative.
 */
export interface PinShot {
  readonly file: string;
  readonly kind: "fly" | "top";
  readonly projection: "perspective" | "orthographic";
  readonly width: number;
  readonly height: number;
  readonly camera: PinCamera;
  /** Vertical FOV in degrees (perspective) — null for ortho. */
  readonly fov: number | null;
  /** World-space extent covered, ortho only: [minX, minZ, maxX, maxZ]. */
  readonly world: readonly [number, number, number, number] | null;
}

export interface PinConsoleEntry {
  readonly level: "log" | "info" | "warn" | "error" | "debug";
  readonly text: string;
  /** Tick the entry was captured at, or null outside a running sim. */
  readonly tick: number | null;
}

export interface PinClientInfo {
  readonly viewport: readonly [number, number];
  readonly dpr: number;
  readonly gpu: string | null;
  readonly texVariant: string | null;
  readonly greyboxStructures: boolean;
  readonly commit: string | null;
}

/**
 * How faithfully `bun run pin:drive reshoot` can recreate this moment.
 *
 * - `static`: nothing movable was in range, so map/seed/render + camera pose
 *   fully determine the frame. A reshoot is a real before/after.
 * - `approximate`: live entities were in range. Without a recorded replay a
 *   reshoot re-runs a *fresh* sim to the same tick — the terrain and placement
 *   match, the units do not. Not evidence on its own.
 */
export type PinReproduction = "static" | "approximate";

export interface VerificationPin {
  readonly version: 2;
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
  // --- v2 ---
  readonly entities: readonly PinEntity[];
  readonly shots: readonly PinShot[];
  readonly console: readonly PinConsoleEntry[];
  /** FNV-1a state hash of the pinned tick, or null with no sim. */
  readonly simHash: number | null;
  readonly client: PinClientInfo;
  readonly reproduction: PinReproduction;
  /** Pin this one was shot as a follow-up to (reshoot chains). */
  readonly parentId: string | null;
  /** Who took it: the human hotkey, or an agent via metropolisPin. */
  readonly origin: "hotkey" | "agent";
}
