// Client-only shot cosmetics (architecture.md §3 event buffer). Driven like
// audio: pump per tick, update per frame. Never touches sim state; zero
// allocations in the hot path (pools preallocated at createFx).
//
// Hybrid visual language (as much original FCOP as the assets allow):
//   Cpyr particle sprites (public/fx/particles.png) → muzzle, explosion, hit
//   Procedural geometry                               → MG/laser tracers,
//                                                       shockwave rings
// The particle atlas is only fireballs/puffs — no laser or ring frames exist
// in the extract. PYDT carries no labels, so the id->role mapping is read off
// the contact sheet (`bun run gen:fxsheet` -> docs/renders/fx/particles-contact.png)
// rather than guessed; fx.test.ts records what each sprite actually looks like.

import {
  EV_EXPLOSION,
  EV_HIT,
  EV_SHOT,
  EVENT_STRIDE,
  type EventBuffer,
  PRIMARY_RANGE,
  PROJ_HYPER,
  PROJ_MINE,
  PROJ_MORTAR,
  PROJ_SHOCKWAVE,
  PROJ_SPECIAL,
  PROJ_WARDEN,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_SPECIAL,
  shotPayloadToReach,
  shotPayloadWeaponId,
  shotPayloadWeaponReach,
  type WeaponDef,
  weaponById,
} from "@metropolis/sim";
import * as THREE from "three";
import { PROJECTILE_HEX, paletteHex } from "./palette";

/** Must match sim.ts MUZZLE_OFFSET (not exported; keep in lockstep by hand). */
const MUZZLE_OFFSET = 0.6;

const TRACER_CAP = 128;
const MUZZLE_CAP = 64;
const EXPLOSION_CAP = 48;
const SPARK_CAP = 64;
const SHOCKWAVE_CAP = 48;

const TRACER_LIFE = 0.09;
const MUZZLE_LIFE = 0.06;
const EXPLOSION_LIFE = 0.32;
const EXPLOSION_LATE_LIFE = 0.5;
const SPARK_LIFE = 0.1;
const SHOCKWAVE_LIFE = 0.28;

const TRACER_CORE_THICK = 0.1;
const TRACER_HALO_THICK = 0.28;
const MUZZLE_SCALE = 1.4;
const SPARK_SCALE = 0.9;
const EXPLOSION_START = 1.2;
const EXPLOSION_END = 6.5;
const SHOCKWAVE_END = 8;

/**
 * Cpyr particle ids per role, read off the contact sheet (gen:fxsheet).
 *
 * Sizes and paint coverage from that run: 8 is 126x128 at 24% paint and the
 * densest of the set; 5 is 125x126 at 18%, the same ball burnt hollow with a
 * bright yellow rim; 6 is 32x32 at 27% with a strong red; 7 is 16x16 at 31%,
 * the densest per area. 3/11/1/10 are the medium puffs and stay unused.
 */
export const PARTICLE_ID = {
  explosion: 8,
  explosionAlt: 5,
  muzzle: 6,
  spark: 7,
} as const;

const ATLAS_URL = "/fx/particles.png";
const ATLAS_META_URL = "/fx/particles.json";

interface ParticleSpriteRect {
  atlas_x: number;
  atlas_y: number;
  w: number;
  h: number;
}

interface ParticleMeta {
  size: [number, number];
  particles: Array<{ id: number; sprites: ParticleSpriteRect[] }>;
}

/**
 * Fills `out` with world pose `[x, height, z, yaw]` for the event, or returns
 * false when the event has no resolvable position (skip the effect).
 * Supplied by the host (main.ts) — same role as the audio position resolver.
 */
export type FxPoseResolver = (
  type: number,
  a: number,
  b: number,
  c: number,
  out: Float32Array,
) => boolean;

export interface ShotFx {
  /** Drain this tick's events into the pools (call once per sim step). */
  pump(events: EventBuffer, resolve: FxPoseResolver): void;
  /**
   * Age live effects and rewrite instance matrices (call once per frame).
   * Pass the active camera so Cpyr billboards face the viewer.
   */
  update(dtSec: number, camera?: THREE.Camera): void;
  /** Test/debug: live slot counts per pool. */
  debugCounts(): {
    tracers: number;
    muzzles: number;
    explosions: number;
    sparks: number;
    shockwaves: number;
  };
  /** Test/debug: world length of the newest live tracer, or 0 when there is none. */
  debugTracerLength(): number;
  /** True once the original Cpyr atlas has been applied to the sprite pools. */
  readonly atlasReady: boolean;
}

interface Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  /** Extra param: tracer length, explosion end-scale, etc. */
  readonly param: Float32Array;
  count: number;
}

// Module-scope scratch — never allocate inside pump/update.
const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchColor = new THREE.Color();
const camQuat = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const poseScratch = new Float32Array(4);
let hasCamera = false;

function makeAdditiveMaterial(hex: number, opacity = 0.95): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: hex,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function makePool(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  withInstanceColor = false,
): Pool {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 10; // draw on top of solid units
  mesh.updateMatrix();
  if (withInstanceColor) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  }
  scene.add(mesh);
  return {
    mesh,
    life: new Float32Array(capacity),
    maxLife: new Float32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    z: new Float32Array(capacity),
    yaw: new Float32Array(capacity),
    param: new Float32Array(capacity),
    count: 0,
  };
}

function spawn(
  pool: Pool,
  life: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  param: number,
): boolean {
  const i = pool.count;
  if (i >= pool.life.length) return false;
  pool.life[i] = life;
  pool.maxLife[i] = life;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.z[i] = z;
  pool.yaw[i] = yaw;
  pool.param[i] = param;
  pool.count = i + 1;
  return true;
}

function kill(pool: Pool, i: number): void {
  const last = pool.count - 1;
  if (i !== last) {
    pool.life[i] = pool.life[last];
    pool.maxLife[i] = pool.maxLife[last];
    pool.x[i] = pool.x[last];
    pool.y[i] = pool.y[last];
    pool.z[i] = pool.z[last];
    pool.yaw[i] = pool.yaw[last];
    pool.param[i] = pool.param[last];
    if (pool.mesh.instanceColor) {
      scratchColor.fromArray(pool.mesh.instanceColor.array as Float32Array, last * 3);
      pool.mesh.setColorAt(i, scratchColor);
    }
  }
  pool.count = last;
}

function age(pool: Pool, dt: number): void {
  let i = 0;
  while (i < pool.count) {
    pool.life[i] -= dt;
    if (pool.life[i] <= 0) {
      kill(pool, i);
      continue;
    }
    i += 1;
  }
}

function explosionTint(kind: number): number {
  if (kind === PROJ_SPECIAL || kind === PROJ_MORTAR) return PROJECTILE_HEX[6] ?? 0xffa060;
  if (kind === PROJ_WARDEN) return PROJECTILE_HEX[3] ?? paletteHex("warden_bomb");
  if (kind === PROJ_HYPER) return PROJECTILE_HEX[7] ?? 0xffe8a0;
  if (kind === PROJ_MINE) return PROJECTILE_HEX[10] ?? 0xff9040;
  if (kind === PROJ_SHOCKWAVE) return PROJECTILE_HEX[11] ?? 0xa0d8ff;
  return 0xffffff; // original fireball colors when atlas is bound
}

interface HitscanLook {
  length: number;
  core: number;
  halo: number;
  thick: number;
}

/**
 * Tracer colors for an avatar weapon, at the reach the shot actually had.
 *
 * `reach` comes from the event (events.ts `weaponShotPayload`), which never
 * packs a positive reach down to zero — a point-blank shot reports one
 * decimetre rather than rounding into the fallback below. So the fallback only
 * covers a payload that carried no reach at all, i.e. a non-hitscan delivery
 * that has no tracer to size anyway.
 */
function hitscanLook(w: WeaponDef | undefined, reach: number): HitscanLook {
  const vfx = w?.vfx ?? "minigun";
  const length = reach > 0 ? reach : (w?.range ?? 0) || PRIMARY_RANGE;
  if (vfx === "laser") return { length, core: 0xffffff, halo: 0x7ef2ff, thick: 1.1 };
  if (vfx === "flame") return { length, core: 0xffe080, halo: 0xff6020, thick: 1.8 };
  if (vfx === "beam") return { length, core: 0xffffff, halo: 0xd080ff, thick: 1.4 };
  if (vfx === "electric") return { length, core: 0xe8ffff, halo: 0x40c0ff, thick: 1.25 };
  // minigun default
  return { length, core: 0xffffff, halo: 0xffe08a, thick: 1 };
}

/**
 * Tracer for an emplacement or a ground unit, whose reach travels in the event
 * (events.ts SHOT_SLOT_HITSCAN) because it has no weapons.ts entry.
 *
 * These used to resolve to weaponById(0) and draw the Mini-Gun's 40 m bolt. On
 * la-cantina every turret's imported engage_range is 6 m, so 72 emplacements
 * were each firing a tracer seven times longer than the shot behind it. Thinner
 * than the avatar's too — a turret burst should not read as heavier than the
 * player's own gun.
 */
function emplacementLook(reach: number): HitscanLook {
  return { length: reach, core: 0xffffff, halo: 0xffc86a, thick: 0.75 };
}

function findSprite(meta: ParticleMeta, id: number): ParticleSpriteRect | null {
  for (let i = 0; i < meta.particles.length; i++) {
    if (meta.particles[i].id === id && meta.particles[i].sprites.length > 0) {
      return meta.particles[i].sprites[0];
    }
  }
  return null;
}

/** Crops one particle rect from the shared atlas image (NearestFilter, PS1). */
function cropAtlasMap(
  atlas: THREE.Texture,
  rect: ParticleSpriteRect,
  atlasW: number,
  atlasH: number,
): THREE.Texture {
  const map = atlas.clone();
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  // Three UV origin is bottom-left; PYDT y is top-left.
  map.offset.set(rect.atlas_x / atlasW, 1 - (rect.atlas_y + rect.h) / atlasH);
  map.repeat.set(rect.w / atlasW, rect.h / atlasH);
  map.needsUpdate = true;
  return map;
}

function bindSpriteMap(material: THREE.MeshBasicMaterial, map: THREE.Texture): void {
  material.map = map;
  material.color.setHex(0xffffff);
  material.opacity = 1;
  material.needsUpdate = true;
}

export function createFx(scene: THREE.Scene): ShotFx {
  // --- Procedural: laser/MG tracers (core + soft halo) -----------------------
  const tracerGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
  tracerGeom.rotateZ(-Math.PI / 2);
  const tracerCore = makePool(
    scene,
    tracerGeom,
    makeAdditiveMaterial(0xffffff, 0.95),
    TRACER_CAP,
    true,
  );
  const tracerHalo = makePool(
    scene,
    tracerGeom,
    makeAdditiveMaterial(0xffffff, 0.45),
    TRACER_CAP,
    true,
  );

  // --- Procedural: ground shockwave ring (no original ring sprite exists) ----
  const ringGeom = new THREE.RingGeometry(0.42, 0.55, 40);
  ringGeom.rotateX(-Math.PI / 2);
  const shockwaves = makePool(
    scene,
    ringGeom,
    makeAdditiveMaterial(paletteHex("explosion"), 0.75),
    SHOCKWAVE_CAP,
    true,
  );

  // --- Cpyr billboards (planes); solid fallback until atlas loads ------------
  const quadGeom = new THREE.PlaneGeometry(1, 1);
  const muzzleMat = makeAdditiveMaterial(0xfff2a8, 1);
  const explosionMat = makeAdditiveMaterial(0xffffff, 0.9);
  const sparkMat = makeAdditiveMaterial(paletteHex("muzzle"), 1);
  const muzzles = makePool(scene, quadGeom, muzzleMat, MUZZLE_CAP);
  const explosionLateMat = makeAdditiveMaterial(0xffffff, 0.75);
  const explosions = makePool(scene, quadGeom, explosionMat, EXPLOSION_CAP, true);
  const explosionsLate = makePool(scene, quadGeom, explosionLateMat, EXPLOSION_CAP, true);
  const sparks = makePool(scene, quadGeom, sparkMat, SPARK_CAP);

  let atlasReady = false;

  // Fire-and-forget atlas load. Missing file keeps the solid additive fallback
  // so greybox / tests / offline still show shot feedback.
  void loadCpyrAtlas().then((loaded) => {
    if (!loaded) return;
    bindSpriteMap(muzzleMat, loaded.maps.muzzle);
    bindSpriteMap(explosionMat, loaded.maps.explosion);
    bindSpriteMap(explosionLateMat, loaded.maps.explosionLate);
    bindSpriteMap(sparkMat, loaded.maps.spark);
    atlasReady = true;
  });

  function pump(events: EventBuffer, resolve: FxPoseResolver): void {
    const data = events.data;
    const n = events.count;
    for (let i = 0; i < n; i++) {
      const o = i * EVENT_STRIDE;
      const type = data[o];
      const a = data[o + 1];
      const b = data[o + 2];
      const c = data[o + 3];
      if (!resolve(type, a, b, c, poseScratch)) continue;
      const px = poseScratch[0];
      const py = poseScratch[1];
      const pz = poseScratch[2];
      const yaw = poseScratch[3];

      if (type === EV_SHOT) {
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        const mx = px + cos * MUZZLE_OFFSET;
        const mz = pz + sin * MUZZLE_OFFSET;
        const my = py + 0.6; // sim.ts MUZZLE_HEIGHT
        // What `c` means depends on `b` — see events.ts. Slots 0/1/2 are the
        // avatar's and pack a catalog id with the shot's reach;
        // SHOT_SLOT_HITSCAN carries a reach in decimetres; SHOT_SLOT_LAUNCH
        // carries nothing and is a muzzle flash for a shell that renders as its
        // own entity.
        const emplacement = b === SHOT_SLOT_HITSCAN;
        // Only the avatar's three slots index the catalog. Resolving any other
        // slot through weaponById lands on id 0, the Mini-Gun, which is how a
        // bomb launch came to draw a 40 m hitscan streak next to its own shell.
        const avatarSlot = b <= SHOT_SLOT_SPECIAL;
        const w = avatarSlot ? weaponById(shotPayloadWeaponId(c)) : undefined;
        const muzzleScale = w?.vfx === "flame" ? MUZZLE_SCALE * 1.5 : MUZZLE_SCALE;
        spawn(muzzles, MUZZLE_LIFE, mx, my, mz, yaw, muzzleScale);
        // Hitscan weapons get a tracer bolt (gun minigun/laser/flame, special beam).
        // Projectiles already render as entities.
        if (emplacement || w?.delivery === "hitscan") {
          // Length is the shot's own reach, carried in the event — where it hit
          // a body, where a wall stopped it, or the full range. It used to be
          // the weapon's nominal range, so a burst into a wall three metres off
          // still drew forty metres of bolt straight through it.
          const look = emplacement
            ? emplacementLook(shotPayloadToReach(c))
            : hitscanLook(w, shotPayloadWeaponReach(c));
          const half = look.length * 0.5;
          const cx = mx + cos * half;
          const cz = mz + sin * half;
          const coreSlot = tracerCore.count;
          if (spawn(tracerCore, TRACER_LIFE, cx, my, cz, yaw, look.length)) {
            scratchColor.setHex(look.core);
            tracerCore.mesh.setColorAt(coreSlot, scratchColor);
            if (tracerCore.mesh.instanceColor) tracerCore.mesh.instanceColor.needsUpdate = true;
          }
          const haloSlot = tracerHalo.count;
          if (spawn(tracerHalo, TRACER_LIFE, cx, my, cz, yaw, look.length * look.thick)) {
            scratchColor.setHex(look.halo);
            tracerHalo.mesh.setColorAt(haloSlot, scratchColor);
            if (tracerHalo.mesh.instanceColor) tracerHalo.mesh.instanceColor.needsUpdate = true;
          }
        }
      } else if (type === EV_EXPLOSION) {
        // c = projectile kind (mode).
        const endScale =
          c === PROJ_SHOCKWAVE
            ? 9.0
            : c === PROJ_SPECIAL || c === PROJ_MORTAR || c === PROJ_MINE
              ? 5.5
              : c === PROJ_WARDEN
                ? 7.0
                : c === PROJ_HYPER
                  ? 3.2
                  : EXPLOSION_END;
        const slot = explosions.count;
        if (spawn(explosions, EXPLOSION_LIFE, px, py + 0.6, pz, 0, endScale)) {
          scratchColor.setHex(explosionTint(c));
          explosions.mesh.setColorAt(slot, scratchColor);
          if (explosions.mesh.instanceColor) explosions.mesh.instanceColor.needsUpdate = true;
        }
        // Second phase on Cpyr id 5. The contact sheet (gen:fxsheet) settles what
        // the two large sprites are: id 8 is a dense hot ball, id 5 is the same
        // ball burnt hollow with a bright yellow rim. That is a sequence, so it
        // is drawn as one — 8 first, 5 outliving it and expanding past it.
        const lslot = explosionsLate.count;
        if (spawn(explosionsLate, EXPLOSION_LATE_LIFE, px, py + 0.6, pz, 0, endScale * 1.35)) {
          scratchColor.setHex(explosionTint(c));
          explosionsLate.mesh.setColorAt(lslot, scratchColor);
          if (explosionsLate.mesh.instanceColor)
            explosionsLate.mesh.instanceColor.needsUpdate = true;
        }
        // Shockwave rides the ground under the fireball (procedural — no ring sprite).
        const waveEnd =
          c === PROJ_SHOCKWAVE
            ? 14
            : c === PROJ_WARDEN
              ? 10
              : c === PROJ_SPECIAL || c === PROJ_MORTAR || c === PROJ_MINE
                ? 7
                : c === PROJ_HYPER
                  ? 3
                  : SHOCKWAVE_END;
        const wslot = shockwaves.count;
        if (spawn(shockwaves, SHOCKWAVE_LIFE, px, py + 0.15, pz, 0, waveEnd)) {
          const tint = explosionTint(c);
          scratchColor.setHex(tint === 0xffffff ? paletteHex("explosion") : tint);
          shockwaves.mesh.setColorAt(wslot, scratchColor);
          if (shockwaves.mesh.instanceColor) shockwaves.mesh.instanceColor.needsUpdate = true;
        }
      } else if (type === EV_HIT) {
        spawn(sparks, SPARK_LIFE, px, py + 1.0, pz, 0, SPARK_SCALE);
      }
    }
  }

  function writeOriented(
    pool: Pool,
    billboard: boolean,
    scaleFor: (i: number, t: number) => void,
  ): void {
    const n = pool.count;
    for (let i = 0; i < n; i++) {
      const t = 1 - pool.life[i] / pool.maxLife[i];
      scaleFor(i, t);
      scratchPos.set(pool.x[i], pool.y[i], pool.z[i]);
      if (billboard && hasCamera) {
        // True camera-facing sprite (Cpyr frames).
        scratchQuat.copy(camQuat);
      } else {
        scratchQuat.setFromAxisAngle(UP, -pool.yaw[i]);
      }
      scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
      pool.mesh.setMatrixAt(i, scratchMatrix);
    }
    pool.mesh.count = n;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  function update(dtSec: number, camera?: THREE.Camera): void {
    hasCamera = camera !== undefined;
    if (camera) camera.getWorldQuaternion(camQuat);

    if (dtSec > 0) {
      age(tracerCore, dtSec);
      age(tracerHalo, dtSec);
      age(muzzles, dtSec);
      age(explosions, dtSec);
      age(explosionsLate, dtSec);
      age(sparks, dtSec);
      age(shockwaves, dtSec);
    }

    writeOriented(tracerCore, false, (i, t) => {
      const fade = 1 - t;
      scratchScale.set(tracerCore.param[i], TRACER_CORE_THICK * fade, TRACER_CORE_THICK * fade);
    });
    writeOriented(tracerHalo, false, (i, t) => {
      const fade = (1 - t) * 0.85;
      scratchScale.set(tracerHalo.param[i], TRACER_HALO_THICK * fade, TRACER_HALO_THICK * fade);
    });
    writeOriented(muzzles, true, (i, t) => {
      const s = muzzles.param[i] * (1 + t * 0.6);
      const fade = 1 - t;
      scratchScale.set(s * fade, s * fade, s * fade);
    });
    writeOriented(explosions, true, (i, t) => {
      const s = EXPLOSION_START + (explosions.param[i] - EXPLOSION_START) * t;
      const envelope = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75;
      const f = Math.max(0.08, envelope);
      scratchScale.set(s * f, s * f, s * f);
    });
    // Phase two grows past the first ball and fades from a hot rim to nothing.
    // No initial punch-in: by the time this is visible the id-8 ball already
    // did that, and re-doing it reads as two explosions rather than one.
    writeOriented(explosionsLate, true, (i, t) => {
      const s = EXPLOSION_START + (explosionsLate.param[i] - EXPLOSION_START) * Math.sqrt(t);
      const f = Math.max(0.05, 1 - t * t);
      scratchScale.set(s * f, s * f, s * f);
    });
    writeOriented(sparks, true, (i, t) => {
      const s = sparks.param[i] * (1 + t * 0.8);
      const fade = 1 - t;
      scratchScale.set(s * fade, s * fade, s * fade);
    });
    writeOriented(shockwaves, false, (i, t) => {
      // Expanding ground disk; RingGeometry already has thickness in UV space.
      const s = 0.8 + shockwaves.param[i] * t;
      scratchScale.set(s, 1, s);
    });
  }

  return {
    pump,
    update,
    get atlasReady() {
      return atlasReady;
    },
    debugTracerLength: () => (tracerCore.count > 0 ? tracerCore.param[tracerCore.count - 1] : 0),
    debugCounts: () => ({
      tracers: tracerCore.count,
      muzzles: muzzles.count,
      explosions: explosions.count,
      sparks: sparks.count,
      shockwaves: shockwaves.count,
    }),
  };
}

interface LoadedAtlas {
  maps: {
    explosion: THREE.Texture;
    explosionLate: THREE.Texture;
    muzzle: THREE.Texture;
    spark: THREE.Texture;
  };
}

async function loadCpyrAtlas(): Promise<LoadedAtlas | null> {
  try {
    const metaRes = await fetch(ATLAS_META_URL);
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as ParticleMeta;
    const [atlasW, atlasH] = meta.size;

    const expRect = findSprite(meta, PARTICLE_ID.explosion);
    const expLateRect = findSprite(meta, PARTICLE_ID.explosionAlt);
    const muzRect = findSprite(meta, PARTICLE_ID.muzzle);
    const spkRect = findSprite(meta, PARTICLE_ID.spark);
    if (!expRect || !expLateRect || !muzRect || !spkRect) return null;

    const atlas = await loadTexture(ATLAS_URL);
    if (!atlas) return null;
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.magFilter = THREE.NearestFilter;
    atlas.minFilter = THREE.NearestFilter;
    atlas.generateMipmaps = false;
    atlas.needsUpdate = true;

    return {
      maps: {
        explosion: cropAtlasMap(atlas, expRect, atlasW, atlasH),
        explosionLate: cropAtlasMap(atlas, expLateRect, atlasW, atlasH),
        muzzle: cropAtlasMap(atlas, muzRect, atlasW, atlasH),
        spark: cropAtlasMap(atlas, spkRect, atlasW, atlasH),
      },
    };
  } catch {
    return null;
  }
}

function loadTexture(url: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => resolve(tex),
      undefined,
      () => resolve(null),
    );
  });
}
