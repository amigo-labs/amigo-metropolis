// Type 89: a screen-facing disc or star at a point (`effect_type89.c`;
// the draw 0x0043cbc0 -> `draw_disc_fan` 0x004271c0 / `draw_spike_star`
// 0x00426ed0).
//
// A disc is a fan of gouraud wedges, the centre colour in the middle and the
// rim colour at the edge; its wedge count is the projected radius rounded down
// to a multiple of four on the original's 640x480 screen, at least four and at
// most the record's cap. A star is `cap` spikes from a short chord through the
// centre (radius >> phase_low) out to the rim, tip in the centre colour. Both
// are additive with the colour bytes doubled (op 0x5b, blend byte 2). The
// radius grows by the record's growth, the point moves by its velocity under
// its y acceleration, and the two colours ramp (ramp300), turning round at the
// ends with flash_flags bit 0.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import {
  bounceChannel,
  DEFAULT_SCALE,
  directionOf,
  FLASH_BOUNCE,
  FLASH_STAR,
  FXF_IN_FRAME,
  type Fx89,
  placementScale,
  ramp300Ticks,
  rampChannel,
  vertexColour,
  WORLD_UNITS_PER_METRE,
  x16ToMetres,
} from "../../effects/records";
import {
  type Anchors,
  additive,
  copyAnchor,
  type FxPoses,
  type FxView,
  followAnchor,
  makeAnchors,
  placeAnchor,
  prepareMesh,
  rebindAnchors,
  roll,
} from "./common";

/** The most wedges or spikes a shipped record asks for. */
const MAX_WEDGES = 20;
/** `CACT_EFX89_DRAW_CULL`: beyond 0x20000 of the eye (plus the radius) nothing draws. */
const CULL_M = 0x20000 / WORLD_UNITS_PER_METRE;

const VERTEX = /* glsl */ `
attribute float aIndex;
attribute float aCorner;
attribute vec3 iCentre;
attribute vec3 iRim;
attribute vec4 iShape;
varying vec3 vColour;
void main() {
  float count = iShape.x;
  vec3 p = vec3(0.0);
  vColour = iCentre;
  if (iShape.z > 0.5) {
    // A spike: the tip on the rim, the base a chord through the centre.
    if (aIndex < count) {
      float a = iShape.y + aIndex * 6.2831853 / count;
      vec2 dir = vec2(cos(a), sin(a));
      if (aCorner < 0.5) {
        p = vec3(dir, 0.0);
      } else {
        float side = aCorner < 1.5 ? 1.0 : -1.0;
        p = vec3(vec2(-dir.y, dir.x) * side * iShape.w, 0.0);
        vColour = iRim;
      }
    }
  } else if (aIndex >= 0.0) {
    // A rim point of the fan; past the count it folds onto the last one.
    float k = min(aIndex, count);
    float a = iShape.y + k * 6.2831853 / count;
    p = vec3(cos(a), sin(a), 0.0);
    vColour = iRim;
  }
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
}`;

function fanGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const index = new Float32Array(MAX_WEDGES + 2);
  index[0] = -1;
  for (let k = 0; k <= MAX_WEDGES; k++) index[k + 1] = k;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((MAX_WEDGES + 2) * 3), 3));
  g.setAttribute("aIndex", new THREE.BufferAttribute(index, 1));
  g.setAttribute("aCorner", new THREE.BufferAttribute(new Float32Array(MAX_WEDGES + 2), 1));
  const tris: number[] = [];
  for (let k = 0; k < MAX_WEDGES; k++) tris.push(0, k + 1, k + 2);
  g.setIndex(tris);
  return g;
}

function starGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = MAX_WEDGES * 3;
  const index = new Float32Array(n);
  const corner = new Float32Array(n);
  for (let s = 0; s < MAX_WEDGES; s++) {
    for (let c = 0; c < 3; c++) {
      index[s * 3 + c] = s;
      corner[s * 3 + c] = c;
    }
  }
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aIndex", new THREE.BufferAttribute(index, 1));
  g.setAttribute("aCorner", new THREE.BufferAttribute(corner, 1));
  return g;
}

interface Layer {
  readonly mesh: THREE.InstancedMesh;
  readonly centre: THREE.InstancedBufferAttribute;
  readonly rim: THREE.InstancedBufferAttribute;
  readonly shape: THREE.InstancedBufferAttribute;
  count: number;
}

function layer(scene: THREE.Scene, geometry: THREE.BufferGeometry, cap: number): Layer {
  const centre = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const rim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const shape = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  centre.setUsage(THREE.DynamicDrawUsage);
  rim.setUsage(THREE.DynamicDrawUsage);
  shape.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("iCentre", centre);
  geometry.setAttribute("iRim", rim);
  geometry.setAttribute("iShape", shape);
  const material = additive(
    new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.DoubleSide,
    }),
  );
  const mesh = prepareMesh(new THREE.InstancedMesh(geometry, material, cap), scene);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  return { mesh, centre, rim, shape, count: 0 };
}

const dir = new Float32Array(3);
const m4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

export class Flashes {
  readonly cap: number;
  count = 0;
  private readonly a: Anchors;
  private readonly rec: (Fx89 | null)[];
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly scale: Float32Array;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly dz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly phase: Float32Array;
  private readonly disc: Layer;
  private readonly star: Layer;

  constructor(scene: THREE.Scene, cap = 160) {
    this.cap = cap;
    this.a = makeAnchors(cap);
    this.rec = new Array<Fx89 | null>(cap).fill(null);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.scale = new Float32Array(cap);
    this.dx = new Float32Array(cap);
    this.dy = new Float32Array(cap);
    this.dz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.disc = layer(scene, fanGeometry(), cap);
    this.star = layer(scene, starGeometry(), cap);
  }

  /** The factory 0x0043cdd0 and its operation 0. False when the pool is full. */
  spawn(rec: Fx89, at: Readonly<RaiseAt>): boolean {
    const i = this.count;
    if (i >= this.cap) return false;
    this.count++;
    placeAnchor(this.a, i, rec, at, false);
    this.rec[i] = rec;
    this.age[i] = 0;
    this.life[i] = rec.life > 0 ? rec.life : Math.max(ramp300Ticks(rec.centreTicks), 30);
    this.scale[i] = placementScale(rec.radius, at.raiserScale || DEFAULT_SCALE, at.scale);
    // Row 2 of the (angle_y, -angle_x) frame times the speed: 1/16 world unit
    // a tick, turned into the raiser's frame with bit 2 (the handler's
    // operation 0, 0x0043cfba).
    const speed = rec.speed / 16 / WORLD_UNITS_PER_METRE;
    if (speed !== 0) {
      const yaw = (rec.flags & FXF_IN_FRAME) !== 0 ? at.yaw : 0;
      directionOf(roll(rec.emitAngleY), roll(rec.emitAngleX), yaw, dir);
      this.vx[i] = dir[0] * speed;
      this.vy[i] = dir[1] * speed;
      this.vz[i] = dir[2] * speed;
    } else {
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.vz[i] = 0;
    }
    this.dx[i] = 0;
    this.dy[i] = 0;
    this.dz[i] = 0;
    this.phase[i] = roll(rec.startAngle);
    return true;
  }

  rebind(token: number, entity: number): void {
    rebindAnchors(this.a, this.count, token, entity);
  }

  reset(): void {
    this.count = 0;
    this.disc.mesh.count = 0;
    this.star.mesh.count = 0;
  }

  /** The chain-1 tick 0x0043c700 for `dt` engine ticks, then the draw. */
  update(dt: number, poses: FxPoses | null, view: FxView): void {
    let i = 0;
    while (i < this.count) {
      const rec = this.rec[i] as Fx89;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      if (rec.gravityY !== 0) this.vy[i] += (rec.gravityY / 256 / 16 / WORLD_UNITS_PER_METRE) * dt;
      this.dx[i] += this.vx[i] * dt;
      this.dy[i] += this.vy[i] * dt;
      this.dz[i] += this.vz[i] * dt;
      this.scale[i] += (rec.radiusGrowth / 256) * dt;
      followAnchor(this.a, i, poses);
      i++;
    }
    this.draw(view);
  }

  private kill(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      copyAnchor(this.a, last, i);
      this.rec[i] = this.rec[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.scale[i] = this.scale[last];
      this.dx[i] = this.dx[last];
      this.dy[i] = this.dy[last];
      this.dz[i] = this.dz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.phase[i] = this.phase[last];
    }
    this.rec[last] = null;
    this.count = last;
  }

  private draw(view: FxView): void {
    const disc = this.disc;
    const star = this.star;
    disc.count = 0;
    star.count = 0;
    for (let i = 0; i < this.count; i++) {
      const rec = this.rec[i] as Fx89;
      const r = x16ToMetres(this.scale[i]);
      if (r <= 0) continue;
      const x = this.a.x[i] + this.dx[i];
      const y = this.a.y[i] + this.dy[i];
      const z = this.a.z[i] + this.dz[i];
      const ex = x - view.pos.x;
      const ey = y - view.pos.y;
      const ez = z - view.pos.z;
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) - r >= CULL_M) continue;
      const isStar = (rec.flashFlags & FLASH_STAR) !== 0;
      const L = isStar ? star : disc;
      const n = L.count++;
      // The wedge count: the 480-line pixel radius rounded down to a multiple
      // of four, at least four, at most the cap (0x004271f8).
      const px = (r * view.focal480) / view.depth(x, y, z);
      let wedges = Math.floor(px / 4) * 4;
      if (wedges < 4) wedges = 4;
      if (isStar || wedges > rec.wedgeCap) wedges = rec.wedgeCap;
      if (wedges > MAX_WEDGES) wedges = MAX_WEDGES;
      const t = this.age[i];
      const bounce = (rec.flashFlags & FLASH_BOUNCE) !== 0;
      const ct = ramp300Ticks(rec.centreTicks);
      const rt = ramp300Ticks(rec.rimTicks);
      const ramp = bounce ? bounceChannel : rampChannel;
      const c = L.centre.array as Float32Array;
      const m = L.rim.array as Float32Array;
      for (let k = 0; k < 3; k++) {
        c[n * 3 + k] = vertexColour(ramp(rec.centreFrom[k], rec.centreTo[k], ct, t));
        m[n * 3 + k] = vertexColour(ramp(rec.rimFrom[k], rec.rimTo[k], rt, t));
      }
      const s = L.shape.array as Float32Array;
      s[n * 4] = wedges;
      s[n * 4 + 1] = this.phase[i];
      s[n * 4 + 2] = isStar ? 1 : 0;
      // The star's inner chord: radius >> phase_low.
      s[n * 4 + 3] = 1 / 2 ** Math.min(rec.phaseLow & 31, 16);
      pos.set(x, y, z);
      scl.set(r, r, r);
      m4.compose(pos, view.quat, scl);
      L.mesh.setMatrixAt(n, m4);
    }
    flush(disc);
    flush(star);
  }
}

function flush(L: Layer): void {
  L.mesh.count = L.count;
  L.mesh.instanceMatrix.needsUpdate = true;
  L.centre.needsUpdate = true;
  L.rim.needsUpdate = true;
  L.shape.needsUpdate = true;
}
