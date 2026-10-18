// Type 92: an expanding ring or sphere (`effect_type92.c`, the tick
// 0x00418860; the ring 0x00418de0, `draw_sphere` 0x00418080).
//
// The ring is a flat annulus in the y = 0 plane of its own frame, from the
// radius to radius + thickness (and on to radius + 2 x thickness with the
// double-band bit, the inner colour again at the far edge), drawn with the
// record's own segment count, gouraud from the inner colour to the outer,
// additive. The narrow bit draws only the first half of each 45-degree wedge
// (a dashed ring); the cone bit only the two wedges about +z. The sphere is
// the same radius drawn as a whole sphere shaded by latitude in the camera's
// frame, the inner colour at the poles to the outer at the equator, additive.
//
// Every frame the radius grows by `(delta * rate) >> 8`, the rate decays while
// the decay is positive (floored at 0x1000), the frame spins, and every colour
// byte loses `(elapsed * fade) >> 8`, the fade sized from the brightest byte
// so the record's parameter is a ramp300 length (0x004199d0). It retires when
// all six bytes are dark or the radius reaches its maximum.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import {
  DEFAULT_SCALE,
  directionOf,
  FXF_IN_FRAME,
  type Fx92,
  placementScale,
  SHELL_CONE,
  SHELL_DOUBLE,
  SHELL_NARROW,
  SHELL_SPHERE,
  SHELL_SWAP,
  TURN,
  vertexColour,
  x16ToMetres,
} from "../../effects/records";
import {
  type Anchors,
  additive,
  copyAnchor,
  FX_OUTPUT,
  type FxPoses,
  type FxView,
  followAnchor,
  makeAnchors,
  placeAnchor,
  prepareMesh,
  rebindAnchors,
} from "./common";

const MAX_SEGMENTS = 64;

const RING_VERTEX = /* glsl */ `
attribute float aSeg;
attribute float aBand;
attribute vec4 iRad;
attribute vec3 iInner;
attribute vec3 iOuter;
varying vec3 vColour;
varying float vAngle;
varying float vFlags;
void main() {
  float seg = iRad.w;
  float a = 6.2831853 * min(aSeg, seg) / seg;
  float band = aBand;
  float doubled = mod(floor(iRad.z + 0.5), 2.0);
  if (band > 1.5 && doubled < 0.5) band = 1.0;
  float r = iRad.x + band * iRad.y;
  vColour = band > 0.5 && band < 1.5 ? iOuter : iInner;
  vAngle = a;
  vFlags = iRad.z;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix *
    vec4(sin(a) * r, 0.0, cos(a) * r, 1.0);
}`;

// Narrow (flags bit 2): the first half of each 45-degree wedge; cone (bit 4):
// the two wedges either side of +z.
const RING_FRAGMENT = /* glsl */ `
varying vec3 vColour;
varying float vAngle;
varying float vFlags;
void main() {
  float f = floor(vFlags + 0.5);
  float narrow = mod(floor(f / 2.0), 2.0);
  float cone = mod(floor(f / 4.0), 2.0);
  if (narrow > 0.5 && fract(vAngle / 0.78539816) > 0.5) discard;
  if (cone > 0.5) {
    float a = vAngle > 3.14159265 ? vAngle - 6.2831853 : vAngle;
    if (abs(a) > 0.78539816) discard;
  }
  gl_FragColor = vec4(vColour, 1.0);
  ${FX_OUTPUT}
}`;

const SPHERE_VERTEX = /* glsl */ `
attribute vec3 iInner;
attribute vec3 iOuter;
uniform vec3 uCamUp;
varying vec3 vColour;
void main() {
  vec3 n = normalize(mat3(instanceMatrix) * normal);
  float pole = abs(dot(n, uCamUp));
  vColour = mix(iOuter, iInner, pole);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const SPHERE_FRAGMENT = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
  ${FX_OUTPUT}
}`;

function ringGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = (MAX_SEGMENTS + 1) * 3;
  const seg = new Float32Array(n);
  const band = new Float32Array(n);
  for (let k = 0; k <= MAX_SEGMENTS; k++) {
    for (let b = 0; b < 3; b++) {
      seg[k * 3 + b] = k;
      band[k * 3 + b] = b;
    }
  }
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aSeg", new THREE.BufferAttribute(seg, 1));
  g.setAttribute("aBand", new THREE.BufferAttribute(band, 1));
  const tris: number[] = [];
  for (let k = 0; k < MAX_SEGMENTS; k++) {
    for (let b = 0; b < 2; b++) {
      const a0 = k * 3 + b;
      const a1 = a0 + 1;
      const b0 = (k + 1) * 3 + b;
      const b1 = b0 + 1;
      tris.push(a0, b0, a1, a1, b0, b1);
    }
  }
  g.setIndex(tris);
  return g;
}

interface RingLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly rad: THREE.InstancedBufferAttribute;
  readonly inner: THREE.InstancedBufferAttribute;
  readonly outer: THREE.InstancedBufferAttribute;
}

const dir = new Float32Array(3);
const m4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const quat = new THREE.Quaternion();
const normal = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

export class Shells {
  readonly cap: number;
  count = 0;
  private readonly a: Anchors;
  private readonly rec: (Fx92 | null)[];
  private readonly age: Float32Array;
  private readonly radius: Float32Array;
  private readonly rate: Float32Array;
  private readonly decay: Float32Array;
  private readonly fade: Float32Array;
  /** Six colour bytes per instance: inner rgb, outer rgb. */
  private readonly colour: Float32Array;
  private readonly angleY: Float32Array;
  private readonly angleX: Float32Array;
  private readonly ring: RingLayer;
  private readonly sphere: RingLayer;
  private readonly sphereMaterial: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, cap = 64) {
    this.cap = cap;
    this.a = makeAnchors(cap);
    this.rec = new Array<Fx92 | null>(cap).fill(null);
    this.age = new Float32Array(cap);
    this.radius = new Float32Array(cap);
    this.rate = new Float32Array(cap);
    this.decay = new Float32Array(cap);
    this.fade = new Float32Array(cap);
    this.colour = new Float32Array(cap * 6);
    this.angleY = new Float32Array(cap);
    this.angleX = new Float32Array(cap);
    const ringMaterial = additive(
      new THREE.ShaderMaterial({
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
        side: THREE.DoubleSide,
      }),
    );
    this.ring = this.layer(scene, ringGeometry(), ringMaterial, cap);
    this.sphereMaterial = additive(
      new THREE.ShaderMaterial({
        vertexShader: SPHERE_VERTEX,
        fragmentShader: SPHERE_FRAGMENT,
        uniforms: { uCamUp: { value: new THREE.Vector3(0, 1, 0) } },
        side: THREE.DoubleSide,
      }),
    );
    this.sphere = this.layer(scene, new THREE.SphereGeometry(1, 24, 16), this.sphereMaterial, cap);
  }

  private layer(
    scene: THREE.Scene,
    geometry: THREE.BufferGeometry,
    material: THREE.ShaderMaterial,
    cap: number,
  ): RingLayer {
    const rad = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const inner = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const outer = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    rad.setUsage(THREE.DynamicDrawUsage);
    inner.setUsage(THREE.DynamicDrawUsage);
    outer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iRad", rad);
    geometry.setAttribute("iInner", inner);
    geometry.setAttribute("iOuter", outer);
    const mesh = prepareMesh(new THREE.InstancedMesh(geometry, material, cap), scene);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    return { mesh, rad, inner, outer };
  }

  /** The factory 0x004196e0 and its handler's construct. */
  spawn(rec: Fx92, at: Readonly<RaiseAt>): boolean {
    const i = this.count;
    if (i >= this.cap) return false;
    this.count++;
    placeAnchor(this.a, i, rec, at, false);
    this.rec[i] = rec;
    this.age[i] = 0;
    this.radius[i] = placementScale(rec.startRadius, at.raiserScale || DEFAULT_SCALE, at.scale);
    this.rate[i] = rec.growth;
    this.decay[i] = rec.decay;
    for (let k = 0; k < 3; k++) {
      this.colour[i * 6 + k] = rec.inner[k];
      this.colour[i * 6 + 3 + k] = rec.outer[k];
    }
    // 0x004199d0: ((0x80000000 / (2400 * v)) >> 4) * brightest >> 4, a word.
    let fade = 0;
    if (rec.fade >= 16 && (rec.shellFlags & SHELL_SWAP) === 0) {
      let bright = 0;
      for (let k = 0; k < 6; k++) bright = Math.max(bright, this.colour[i * 6 + k]);
      const recip = Math.floor(0x80000000 / (2400 * rec.fade));
      fade = (((recip >>> 4) * bright) >>> 4) & 0xffff;
    }
    this.fade[i] = fade;
    this.angleY[i] = rec.angleY;
    this.angleX[i] = rec.angleX;
    return true;
  }

  rebind(token: number, entity: number): void {
    rebindAnchors(this.a, this.count, token, entity);
  }

  reset(): void {
    this.count = 0;
    this.ring.mesh.count = 0;
    this.sphere.mesh.count = 0;
  }

  /** The chain-2 tick 0x00418860 for `dt` engine ticks, then the draw. */
  update(dt: number, poses: FxPoses | null, view: FxView): void {
    let i = 0;
    while (i < this.count) {
      const rec = this.rec[i] as Fx92;
      this.age[i] += dt;
      let done = rec.life > 0 && this.age[i] >= rec.life;
      if (this.fade[i] > 0) {
        const step = (this.fade[i] / 256) * dt;
        let dark = 0;
        for (let k = 0; k < 6; k++) {
          const v = this.colour[i * 6 + k] - step;
          this.colour[i * 6 + k] = v > 0 ? v : 0;
          if (v <= 0) dark++;
        }
        if (dark === 6) done = true;
      }
      this.radius[i] += (this.rate[i] / 256) * dt;
      this.angleY[i] += (rec.spinY / 256) * dt;
      this.angleX[i] += (rec.spinX / 256) * dt;
      if (this.decay[i] > 0) {
        this.rate[i] -= (this.decay[i] / 128) * dt;
        if (this.rate[i] < 0x1000) {
          this.rate[i] = 0x1000;
          this.decay[i] = 0;
        }
      }
      if (this.radius[i] >= rec.maxRadius) done = true;
      if (done) {
        this.kill(i);
        continue;
      }
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
      this.radius[i] = this.radius[last];
      this.rate[i] = this.rate[last];
      this.decay[i] = this.decay[last];
      this.fade[i] = this.fade[last];
      for (let k = 0; k < 6; k++) this.colour[i * 6 + k] = this.colour[last * 6 + k];
      this.angleY[i] = this.angleY[last];
      this.angleX[i] = this.angleX[last];
    }
    this.rec[last] = null;
    this.count = last;
  }

  private draw(view: FxView): void {
    let rings = 0;
    let spheres = 0;
    (this.sphereMaterial.uniforms.uCamUp.value as THREE.Vector3).copy(view.up);
    for (let i = 0; i < this.count; i++) {
      const rec = this.rec[i] as Fx92;
      const r = x16ToMetres(this.radius[i]);
      if (r <= 0) continue;
      const sphere = (rec.shellFlags & SHELL_SPHERE) !== 0;
      const L = sphere ? this.sphere : this.ring;
      const n = sphere ? spheres++ : rings++;
      const inner = L.inner.array as Float32Array;
      const outer = L.outer.array as Float32Array;
      for (let k = 0; k < 3; k++) {
        inner[n * 3 + k] = vertexColour(this.colour[i * 6 + k]);
        outer[n * 3 + k] = vertexColour(this.colour[i * 6 + 3 + k]);
      }
      pos.set(this.a.x[i], this.a.y[i], this.a.z[i]);
      if (sphere) {
        scl.set(r, r, r);
        m4.compose(pos, IDENTITY, scl);
      } else {
        // The frame (angle_y, 0x400 - angle_x): its y axis is the direction
        // (angle_y, angle_x), turned into the raiser's frame with bit 2.
        const yaw = (rec.flags & FXF_IN_FRAME) !== 0 ? this.a.yaw[i] : 0;
        const toRad = (2 * Math.PI) / TURN;
        directionOf(this.angleY[i] * toRad, this.angleX[i] * toRad, yaw, dir);
        normal.set(dir[0], dir[1], dir[2]);
        quat.setFromUnitVectors(Y, normal);
        scl.set(1, 1, 1);
        m4.compose(pos, quat, scl);
        const rad = L.rad.array as Float32Array;
        rad[n * 4] = r;
        rad[n * 4 + 1] = x16ToMetres(rec.thickness);
        rad[n * 4 + 2] =
          ((rec.shellFlags & SHELL_DOUBLE) !== 0 ? 1 : 0) +
          ((rec.shellFlags & SHELL_NARROW) !== 0 ? 2 : 0) +
          ((rec.shellFlags & SHELL_CONE) !== 0 ? 4 : 0);
        rad[n * 4 + 3] = Math.min(MAX_SEGMENTS, Math.max(8, rec.segments));
      }
      L.mesh.setMatrixAt(n, m4);
    }
    flush(this.ring, rings);
    flush(this.sphere, spheres);
  }
}

function flush(L: RingLayer, n: number): void {
  L.mesh.count = n;
  L.mesh.instanceMatrix.needsUpdate = true;
  L.rad.needsUpdate = true;
  L.inner.needsUpdate = true;
  L.outer.needsUpdate = true;
}
