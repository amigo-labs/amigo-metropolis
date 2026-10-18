// Type 93: one Cpyr particle node (`effect_type93.c`: the factory 0x0042ecd0,
// the tick 0x0042e8f0; `pyro_place` 0x00436e20, `pyro_draw_instance`
// 0x004373e0), and the particle a trail node carries (type 87, flag 0x2).
//
// A node is the particle the record names by id, at a span of max(scale << 5,
// 0x500) world units. With pyro flag 0x04 (BOX) it is a screen-facing sprite:
// the sprite's rect sits where it sits in its size_pow2 cell, or, while the
// node has a heading (angle_y non-zero), centred and turned by it. Without
// 0x04 it is a world quad (+-span/2, 0, +-span/2) turned by the node's two
// angles. The pyro flags pick the blend (particles.json draw.modes): additive
// (texel x colour doubled, a doubled colour past 0xff submitted twice),
// subtractive, translucent (50 %, colour ignored) or opaque (colour ignored).
//
// Every frame the node falls by `fall`, moves by its velocity, grows, spins,
// and its colour ramps (ramp16) toward colour_to — or, with flag 0x100,
// drains toward black blue first. It lives `lifetime` ticks.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import { FX_PARTICLES } from "../../effects/fcopEffects.generated";
import {
  DEFAULT_SCALE,
  directionOf,
  EMITTER_DRAIN,
  FXF_IN_FRAME,
  type Fx93,
  PYRO_ADDITIVE,
  PYRO_SPRITE,
  PYRO_SUBTRACTIVE,
  PYRO_TRANSLUCENT,
  particleSpan,
  placementScale,
  TURN,
  WORLD_UNITS_PER_METRE,
} from "../../effects/records";
import {
  type Anchors,
  additive,
  copyAnchor,
  type FxPoses,
  type FxView,
  followAnchor,
  halfAlpha,
  makeAnchors,
  placeAnchor,
  prepareMesh,
  rebindAnchors,
  roll,
  subtractive,
} from "./common";

/** The atlas page every particle lives on (public/fx/particles.png). */
export const PARTICLE_ATLAS_URL = "/fx/particles.png";
const ATLAS_SIZE = 256;

/** The blends a pyro node can be drawn with. */
export const BLEND_ADDITIVE = 0;
export const BLEND_SUBTRACTIVE = 1;
export const BLEND_TRANSLUCENT = 2;
export const BLEND_OPAQUE = 3;

/** `0x15e`: the factory refuses a node past 350 live ones. */
export const PARTICLES_MAX = 350;

/** The blend a node's pyro flags pick (particles.json draw.modes). */
export function pyroBlend(pyroFlags: number): number {
  if ((pyroFlags & PYRO_ADDITIVE) !== 0) return BLEND_ADDITIVE;
  if ((pyroFlags & PYRO_SUBTRACTIVE) !== 0) return BLEND_SUBTRACTIVE;
  if ((pyroFlags & PYRO_TRANSLUCENT) !== 0) return BLEND_TRANSLUCENT;
  return BLEND_OPAQUE;
}

const VERTEX = /* glsl */ `
attribute vec4 iRect;
attribute vec4 iColour;
varying vec2 vUv;
varying vec4 vColour;
void main() {
  vUv = iRect.xy + uv * iRect.zw;
  vColour = iColour;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uReady;
varying vec2 vUv;
varying vec4 vColour;
void main() {
  vec4 t = uReady > 0.5 ? texture2D(uAtlas, vUv) : vec4(1.0);
  if (t.a < 0.5) discard;
  gl_FragColor = vec4(t.rgb * vColour.rgb, vColour.a);
}`;

/** A unit quad in its own xy plane, uv with v = 0 at the top (the atlas's rows). */
function quadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 0]),
      3,
    ),
  );
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 3, 1, 1, 3, 2]);
  return g;
}

interface Layer {
  readonly mesh: THREE.InstancedMesh;
  readonly rect: THREE.InstancedBufferAttribute;
  readonly colour: THREE.InstancedBufferAttribute;
  readonly cap: number;
  count: number;
}

const dir = new Float32Array(3);
const m4 = new THREE.Matrix4();
const vx3 = new THREE.Vector3();
const vy3 = new THREE.Vector3();
const vz3 = new THREE.Vector3();
const roll3 = new THREE.Quaternion();
const q = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

export class Particles {
  readonly cap: number;
  count = 0;
  private readonly a: Anchors;
  private readonly rec: (Fx93 | null)[];
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly scale: Float32Array;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly dz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly ay: Float32Array;
  private readonly ax: Float32Array;
  /** The node's colour bytes, and their rates per engine tick. */
  private readonly rgb: Float32Array;
  private readonly rate: Float32Array;
  private readonly layers: Layer[];
  private readonly uniforms = {
    uAtlas: { value: null as THREE.Texture | null },
    uReady: { value: 0 },
  };

  constructor(scene: THREE.Scene, cap = PARTICLES_MAX, transient = 1600) {
    this.cap = cap;
    this.a = makeAnchors(cap);
    this.rec = new Array<Fx93 | null>(cap).fill(null);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.scale = new Float32Array(cap);
    this.dx = new Float32Array(cap);
    this.dy = new Float32Array(cap);
    this.dz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.ay = new Float32Array(cap);
    this.ax = new Float32Array(cap);
    this.rgb = new Float32Array(cap * 3);
    this.rate = new Float32Array(cap * 3);
    const blends = [additive, subtractive, halfAlpha, (m: THREE.ShaderMaterial) => m];
    this.layers = blends.map((blend, b) => {
      // The additive layer also carries the trail nodes' particles.
      const n = b === BLEND_ADDITIVE ? cap + transient : cap;
      const g = quadGeometry();
      const rect = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      const colour = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      rect.setUsage(THREE.DynamicDrawUsage);
      colour.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("iRect", rect);
      g.setAttribute("iColour", colour);
      const material = blend(
        new THREE.ShaderMaterial({
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          uniforms: this.uniforms,
          side: THREE.DoubleSide,
        }),
      );
      const mesh = prepareMesh(new THREE.InstancedMesh(g, material, n), scene);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      return { mesh, rect, colour, cap: n, count: 0 };
    });
  }

  /** The original's atlas page; until it lands the nodes draw as their colour. */
  setAtlas(texture: THREE.Texture): void {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.uniforms.uAtlas.value = texture;
    this.uniforms.uReady.value = 1;
  }

  get atlasReady(): boolean {
    return this.uniforms.uReady.value === 1;
  }

  /** The factory 0x0042ecd0 and its operation 0. False when 350 already live. */
  spawn(rec: Fx93, at: Readonly<RaiseAt>): boolean {
    const i = this.count;
    if (i >= this.cap || rec.particle < 0) return false;
    this.count++;
    placeAnchor(this.a, i, rec, at, false);
    this.rec[i] = rec;
    this.age[i] = 0;
    const ramp = rec.rampTicks >= 16 ? rec.rampTicks / 16 : 0;
    this.life[i] = rec.life > 0 ? rec.life : Math.max(ramp, 30);
    this.scale[i] = placementScale(rec.size, at.raiserScale || DEFAULT_SCALE, at.scale);
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
    this.ay[i] = rec.angleY < 0 ? Math.floor(Math.random() * -rec.angleY) : rec.angleY;
    this.ax[i] = rec.angleX < 0 ? Math.floor(Math.random() * -rec.angleX) : rec.angleX;
    // 0x0042ee70: the rates, per engine tick (the tick steps `rate * frame >> 8`).
    const drain = (rec.emitterFlags & EMITTER_DRAIN) !== 0;
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      this.rgb[i * 3 + k] = rec.colourFrom[k];
      sum += rec.colourFrom[k];
    }
    for (let k = 0; k < 3; k++) {
      this.rate[i * 3 + k] =
        ramp <= 0 ? 0 : drain ? sum / ramp : (rec.colourTo[k] - rec.colourFrom[k]) / ramp;
    }
    return true;
  }

  rebind(token: number, entity: number): void {
    rebindAnchors(this.a, this.count, token, entity);
  }

  reset(): void {
    this.count = 0;
    for (const L of this.layers) {
      L.count = 0;
      L.mesh.count = 0;
    }
  }

  /** The chain-0 tick 0x0042e8f0 for `dt` engine ticks, then the pooled nodes' draw. */
  update(dt: number, poses: FxPoses | null, view: FxView): void {
    for (let b = 0; b < this.layers.length; b++) this.layers[b].count = 0;
    let i = 0;
    while (i < this.count) {
      const rec = this.rec[i] as Fx93;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      if (rec.fall !== 0) this.vy[i] += (rec.fall / 256 / 16 / WORLD_UNITS_PER_METRE) * dt;
      this.dx[i] += this.vx[i] * dt;
      this.dy[i] += this.vy[i] * dt;
      this.dz[i] += this.vz[i] * dt;
      if (rec.grow !== 0) this.scale[i] += (rec.grow / 256) * dt;
      this.ay[i] += (rec.spinY / 256) * dt;
      if ((rec.emitterFlags & 0x04) === 0) this.ax[i] += (rec.spinX / 256) * dt;
      if (rec.rampTicks > 0 && (rec.emitterFlags & 0x30) !== 0) this.ramp(i, rec, dt);
      followAnchor(this.a, i, poses);
      this.drawNode(i, rec, view);
      i++;
    }
  }

  private ramp(i: number, rec: Fx93, dt: number): void {
    const o = i * 3;
    if ((rec.emitterFlags & EMITTER_DRAIN) !== 0) {
      // 0x0042eb40: the amount off blue first, then green, then red; a node
      // whose red is already dark is left alone.
      if (this.rgb[o] <= 0) return;
      let amount = this.rate[o] * dt;
      for (let k = 2; k >= 0 && amount > 0; k--) {
        const take = Math.min(amount, this.rgb[o + k]);
        this.rgb[o + k] -= take;
        amount -= take;
      }
      return;
    }
    for (let k = 0; k < 3; k++) {
      const step = this.rate[o + k] * dt;
      const to = rec.colourTo[k];
      const v = this.rgb[o + k] + step;
      this.rgb[o + k] = step > 0 ? Math.min(v, to) : step < 0 ? Math.max(v, to) : v;
    }
  }

  private drawNode(i: number, rec: Fx93, view: FxView): void {
    const flags = (rec.emitterFlags & 0xff) | 0x40;
    const span = particleSpan(this.scale[i]);
    const x = this.a.x[i] + this.dx[i];
    const y = this.a.y[i] + this.dy[i];
    const z = this.a.z[i] + this.dz[i];
    const o = i * 3;
    this.put(
      rec.particle,
      flags,
      x,
      y,
      z,
      span,
      this.ay[i],
      this.ax[i],
      this.rgb[o],
      this.rgb[o + 1],
      this.rgb[o + 2],
      view,
    );
  }

  /**
   * One pyro node into its blend's layer: particle `index` at (x, y, z) with
   * span `span` metres, the two angles (original units) and the colour bytes.
   * The trails call this for their nodes' particles.
   */
  put(
    index: number,
    flags: number,
    x: number,
    y: number,
    z: number,
    span: number,
    angleY: number,
    angleX: number,
    r: number,
    g: number,
    b: number,
    view: FxView,
  ): void {
    const p = FX_PARTICLES[index];
    if (!p) return;
    const blend = pyroBlend(flags);
    const L = this.layers[blend];
    if (L.count >= L.cap) return;
    const n = L.count++;
    const toRad = (2 * Math.PI) / TURN;
    const k = span / p.sizePow2;
    if ((flags & PYRO_SPRITE) !== 0) {
      // A screen-facing sprite (`draw_sprite`).
      const heading = Math.round(angleY) % TURN !== 0;
      pos.set(x, y, z);
      if (heading && view.has) {
        // Centred, half-extents (w/2, h/2) at the span's scale, turned.
        roll3.setFromAxisAngle(AXIS_Z, -angleY * toRad);
        q.copy(view.quat).multiply(roll3);
      } else {
        q.copy(view.quat);
        if (view.has) {
          // The rect where it sits in its cell, the cell centred on the point.
          const cx = (p.offX + p.w / 2 - p.sizePow2 / 2) * k;
          const cy = -(p.offY + p.h / 2 - p.sizePow2 / 2) * k;
          pos.addScaledVector(view.right, cx).addScaledVector(view.up, cy);
        }
      }
      scl.set(p.w * k, p.h * k, 1);
      m4.compose(pos, q, scl);
    } else {
      // A world quad turned by (angle_y, angle_x): local x is row 0 of the
      // original's frame, local z row 2 — in three's (z, y, x) order.
      const sy = Math.sin(angleY * toRad);
      const cy = Math.cos(angleY * toRad);
      const sx = Math.sin(angleX * toRad);
      const cx = Math.cos(angleX * toRad);
      vx3.set(-sy, 0, cy).multiplyScalar(span);
      vz3.set(cx * cy, -sx, cx * sy).multiplyScalar(span);
      vy3.crossVectors(vx3, vz3).normalize();
      m4.makeBasis(vx3, vz3, vy3);
      m4.setPosition(x, y, z);
    }
    L.mesh.setMatrixAt(n, m4);
    const rect = L.rect.array as Float32Array;
    rect[n * 4] = p.x / ATLAS_SIZE;
    rect[n * 4 + 1] = p.y / ATLAS_SIZE;
    rect[n * 4 + 2] = p.w / ATLAS_SIZE;
    rect[n * 4 + 3] = p.h / ATLAS_SIZE;
    const c = L.colour.array as Float32Array;
    if (blend === BLEND_ADDITIVE || blend === BLEND_SUBTRACTIVE) {
      // The colour doubled; past 0xff the record is submitted twice.
      c[n * 4] = Math.max(0, r) / 127.5;
      c[n * 4 + 1] = Math.max(0, g) / 127.5;
      c[n * 4 + 2] = Math.max(0, b) / 127.5;
      c[n * 4 + 3] = 1;
    } else {
      // Colour mode 0 on a textured record: grey 0x80 doubled to white.
      c[n * 4] = 1;
      c[n * 4 + 1] = 1;
      c[n * 4 + 2] = 1;
      c[n * 4 + 3] = blend === BLEND_TRANSLUCENT ? 0.5 : 1;
    }
  }

  /** After every node of the frame is in: hand the counts to the GPU. */
  flush(): void {
    for (let b = 0; b < this.layers.length; b++) {
      const L = this.layers[b];
      L.mesh.count = L.count;
      L.mesh.instanceMatrix.needsUpdate = true;
      L.rect.needsUpdate = true;
      L.colour.needsUpdate = true;
    }
  }

  /** Nodes drawn this frame in each blend (tests). */
  drawn(blend: number): number {
    return this.layers[blend]?.count ?? 0;
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
      this.ay[i] = this.ay[last];
      this.ax[i] = this.ax[last];
      for (let k = 0; k < 3; k++) {
        this.rgb[i * 3 + k] = this.rgb[last * 3 + k];
        this.rate[i * 3 + k] = this.rate[last * 3 + k];
      }
    }
    this.rec[last] = null;
    this.count = last;
  }
}
