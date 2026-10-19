// Type 94: bursts of nodes drawn as flat screen rectangles (`effect_type94.c`:
// the emit 0x0042b360, the walks 0x0042a150 / 0x0042a6d0, the draw
// 0x0042aa70).
//
// A burst is `node_count` nodes leaving at a uniform heading and a pitch in
// [pitch_lo, pitch_hi) about the emitter's own y axis (row 1 of the node's
// frame; the emitter's frame is (orient_yaw, 0x400 - orient_pitch)), at a
// speed rolled in [speed_lo, speed_hi), from `spawn_radius` out along that
// direction. Each node is pulled toward the wind velocity by its drag and, on
// the linear walk (walk bit 0 clear, 0x0042a150), falls by the gravity
// `(v << 12) / -100`; on the radial walk (walk bit 0, 0x0042a6d0) that same
// factor multiplies the node's own offset from the emitter on every axis — a
// spring of factor / -4096 a second squared, no fall. It is retired under the
// ground (unless +0x32 bit 1) and after `lifetime` ticks (masked to 13 bits; 0
// never counts down), and is drawn as a `size` x `size` rectangle of the
// original's 640x480 screen in its colour doubled. The walks integrate per
// second: positions and velocities in sixteenths of a world unit, `elapsed /
// 300` a frame. A repeat is another burst from the same emitter (its handler
// claims operation 1). All nodes share the original's budget of 700.
//
// The colour (0x0042b090 / 0x0042a550 / 0x0042a4d0) moves by the record's
// step a second (`derived.ramp`): with ramp bit 0 one budget, `(r + g + b of
// colour_a) << 12 / |ramp|`, is spent from blue down to 0, then green, then
// red, and nothing moves once red is 0 — a drain to black that never reads
// colour_b; otherwise each channel walks from colour_a toward colour_b and
// stops there, or with bit 1 turns back at either end. The original applies
// it on one frame in four with four frames' delta; here every frame with its
// own.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import {
  ENGINE_HZ,
  FXF_IN_FRAME,
  FXF_NO_GROUND_TEST,
  type Fx94,
  localToThree,
  NODES_MAX,
  RAMP_BOUNCE,
  RAMP_SINGLE_BUDGET,
  TURN,
  WALK_ADDITIVE,
  WALK_HALF_ALPHA,
  WALK_RADIAL,
  WALK_SUBTRACTIVE,
} from "../../effects/records";
import { FX_OUTPUT, type FxPoses, type FxView, makeAnchors, placeAnchor } from "./common";

/** Sixteenths of a world unit to metres. */
const X16_M = 16 / 8192;
const TO_RAD = (2 * Math.PI) / TURN;

const BLEND_OPAQUE = 0;
const BLEND_HALF = 1;
const BLEND_ADD = 2;
const BLEND_SUB = 3;

/** How a node's colour moves (ramp_flags). */
const RAMP_TOWARD = 0;
const RAMP_BUDGET = 1;
const RAMP_PINGPONG = 2;

/**
 * One node's colour after `s` seconds of its ramp, in place: `rgb` its three
 * bytes, `step` its step a second (one budget in [0], or one per channel),
 * `from` / `to` colour_a and colour_b; a bounce turns its steps in place.
 */
export function rampNode(
  mode: number,
  rgb: Float32Array,
  o: number,
  step: Float32Array,
  from: Float32Array,
  to: Float32Array,
  s: number,
): void {
  if (mode === RAMP_BUDGET) {
    // 0x0042a4d0: red gates; blue, then green, then red, each down to 0.
    if (rgb[o] <= 0) return;
    let left = step[o] * s;
    for (let c = 2; c >= 0 && left > 0; c--) {
      const v = rgb[o + c];
      if (v >= left) {
        rgb[o + c] = v - left;
        left = 0;
      } else {
        rgb[o + c] = 0;
        left -= v;
      }
    }
    return;
  }
  for (let c = 0; c < 3; c++) {
    const k = o + c;
    const d = step[k];
    if (d === 0) continue;
    let v = rgb[k] + d * s;
    const a = from[k];
    const b = to[k];
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    if (mode === RAMP_PINGPONG) {
      // 0x0042a550 with bit 1: at either end the step turns back.
      if (v > hi) {
        v = hi;
        step[k] = -d;
      } else if (v < lo) {
        v = lo;
        step[k] = -d;
      }
    } else if ((d > 0 && v > b) || (d < 0 && v < b)) {
      v = b;
    }
    rgb[k] = v;
  }
}

const VERTEX = /* glsl */ `
attribute vec4 aColour;
attribute float aSize;
uniform float uPixelScale;
varying vec4 vColour;
void main() {
  vColour = aColour;
  gl_PointSize = max(1.0, aSize * uPixelScale);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec4 vColour;
void main() {
  gl_FragColor = vColour;
  ${FX_OUTPUT}
}`;

interface Layer {
  readonly points: THREE.Points;
  readonly position: THREE.BufferAttribute;
  readonly colour: THREE.BufferAttribute;
  readonly size: THREE.BufferAttribute;
  count: number;
}

const local = new Float32Array(3);
const world = new Float32Array(3);

/** v * from_angles(ay, ax, 0) in the row-vector convention (math/matrix.c). */
function frame(
  v0: number,
  v1: number,
  v2: number,
  ay: number,
  ax: number,
  out: Float32Array,
): void {
  const sx = Math.sin(ax);
  const cx = Math.cos(ax);
  const sy = Math.sin(ay);
  const cy = Math.cos(ay);
  const a1 = v1 * cx - v2 * sx;
  const a2 = v1 * sx + v2 * cx;
  out[0] = v0 * cy + a2 * sy;
  out[1] = a1;
  out[2] = -v0 * sy + a2 * cy;
}

/** `game_rand_fx() >> (32 - n)`: a signed roll over n bits. */
function jitter(n: number): number {
  return n <= 0 ? 0 : Math.floor((Math.random() - 0.5) * 2 ** n);
}

export class Nodes {
  readonly cap = NODES_MAX;
  count = 0;
  private readonly x = new Float32Array(NODES_MAX);
  private readonly y = new Float32Array(NODES_MAX);
  private readonly z = new Float32Array(NODES_MAX);
  private readonly vx = new Float32Array(NODES_MAX);
  private readonly vy = new Float32Array(NODES_MAX);
  private readonly vz = new Float32Array(NODES_MAX);
  private readonly wx = new Float32Array(NODES_MAX);
  private readonly wy = new Float32Array(NODES_MAX);
  private readonly wz = new Float32Array(NODES_MAX);
  /** Pull toward the wind, a second. */
  private readonly drag = new Float32Array(NODES_MAX);
  /** m/s² on y; on the radial walk, a factor on the node's offset. */
  private readonly gravity = new Float32Array(NODES_MAX);
  private readonly radial = new Uint8Array(NODES_MAX);
  /** The emitter's point, for the radial walk. */
  private readonly ox = new Float32Array(NODES_MAX);
  private readonly oy = new Float32Array(NODES_MAX);
  private readonly oz = new Float32Array(NODES_MAX);
  private readonly rgb = new Float32Array(NODES_MAX * 3);
  private readonly from = new Float32Array(NODES_MAX * 3);
  private readonly to = new Float32Array(NODES_MAX * 3);
  /** The colour's step a second: the budget in [i * 3], or one per channel. */
  private readonly step = new Float32Array(NODES_MAX * 3);
  private readonly rampMode = new Uint8Array(NODES_MAX);
  private readonly age = new Float32Array(NODES_MAX);
  private readonly life = new Float32Array(NODES_MAX);
  private readonly size = new Uint8Array(NODES_MAX);
  private readonly blend = new Uint8Array(NODES_MAX);
  private readonly ground = new Uint8Array(NODES_MAX);
  private frames = 0;
  private readonly layers: Layer[];
  private readonly uniforms = { uPixelScale: { value: 1 } };
  private readonly anchor = makeAnchors(1);
  /** The ground under (x, z), metres, for the walk's floor test; null: none. */
  groundAt: ((x: number, z: number) => number) | null = null;

  constructor(scene: THREE.Scene) {
    this.layers = [BLEND_OPAQUE, BLEND_HALF, BLEND_ADD, BLEND_SUB].map((b) => {
      const g = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(new Float32Array(NODES_MAX * 3), 3);
      const colour = new THREE.BufferAttribute(new Float32Array(NODES_MAX * 4), 4);
      const size = new THREE.BufferAttribute(new Float32Array(NODES_MAX), 1);
      position.setUsage(THREE.DynamicDrawUsage);
      colour.setUsage(THREE.DynamicDrawUsage);
      size.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("position", position);
      g.setAttribute("aColour", colour);
      g.setAttribute("aSize", size);
      g.setDrawRange(0, 0);
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: this.uniforms,
        transparent: b !== BLEND_OPAQUE,
        depthWrite: b === BLEND_OPAQUE,
      });
      if (b === BLEND_ADD) material.blending = THREE.AdditiveBlending;
      if (b === BLEND_SUB) {
        material.blending = THREE.CustomBlending;
        material.blendEquation = THREE.ReverseSubtractEquation;
        material.blendSrc = THREE.OneFactor;
        material.blendDst = THREE.OneFactor;
      }
      const points = new THREE.Points(g, material);
      points.frustumCulled = false;
      points.matrixAutoUpdate = false;
      points.renderOrder = 10;
      points.updateMatrix();
      scene.add(points);
      return { points, position, colour, size, count: 0 };
    });
  }

  /** One burst of the record at the raise (`cact_effect_type94_emit` 0x0042b360). */
  burst(rec: Fx94, at: Readonly<RaiseAt>): number {
    const a = this.anchor;
    placeAnchor(a, 0, rec, at, false);
    const cx = a.x[0];
    const cy = a.y[0];
    const cz = a.z[0];
    const raiserYaw = (rec.flags & FXF_IN_FRAME) !== 0 ? at.yaw : 0;
    const ey = rec.orientYaw * TO_RAD;
    const ex = (0x400 - rec.orientPitch) * TO_RAD;
    const lo = rec.speedLo === -1 ? rec.speedHi : rec.speedLo;
    const cap = Math.min(rec.nodeCap > 0 ? rec.nodeCap : rec.nodeCount, NODES_MAX);
    const n = Math.min(rec.nodeCount, cap);
    // Masked to 13 bits; 0 never counts down (tables.json type_rules.94 life).
    const life = (rec.life & 0x1fff) > 0 ? rec.life & 0x1fff : Number.POSITIVE_INFINITY;
    const rampMode =
      (rec.rampFlags & RAMP_SINGLE_BUDGET) !== 0
        ? RAMP_BUDGET
        : (rec.rampFlags & RAMP_BOUNCE) !== 0
          ? RAMP_PINGPONG
          : RAMP_TOWARD;
    const blend =
      (rec.walkFlags & WALK_ADDITIVE) !== 0
        ? BLEND_ADD
        : (rec.walkFlags & WALK_SUBTRACTIVE) !== 0
          ? BLEND_SUB
          : (rec.walkFlags & WALK_HALF_ALPHA) !== 0
            ? BLEND_HALF
            : BLEND_OPAQUE;
    // The wind: row 2 of (angle_y, -angle_x) times its speed, in the
    // emitter's frame, sixteenths a second.
    const wy0 = rec.windAngleY * TO_RAD;
    const wx0 = rec.windAngleX * TO_RAD;
    frame(
      Math.sin(wy0) * Math.cos(wx0) * rec.windSpeed,
      Math.sin(wx0) * rec.windSpeed,
      Math.cos(wy0) * Math.cos(wx0) * rec.windSpeed,
      ey,
      ex,
      local,
    );
    localToThree(local[0], local[1], local[2], raiserYaw, world);
    const windX = world[0] * X16_M;
    const windY = world[1] * X16_M;
    const windZ = world[2] * X16_M;
    // +0x72: `(v << 12) / -100`, truncated (0x0042b008): x16 world units a
    // second squared on the linear walk, the spring's factor on the radial.
    const factor = Math.trunc((rec.gravity * 4096) / -100);
    const gravity = factor * X16_M;
    let made = 0;
    for (let k = 0; k < n; k++) {
      const i = this.count;
      if (i >= NODES_MAX) break;
      this.count++;
      made++;
      // A uniform heading, a pitch in the range, and row 1 of that frame.
      const yaw = Math.random() * 2 * Math.PI;
      const pitch = (rec.pitchLo + Math.random() * (rec.pitchHi - rec.pitchLo)) * TO_RAD;
      const d0 = Math.sin(pitch) * Math.sin(yaw);
      const d1 = Math.cos(pitch);
      const d2 = Math.sin(pitch) * Math.cos(yaw);
      frame(d0, d1, d2, ey, ex, local);
      localToThree(local[0], local[1], local[2], raiserYaw, world);
      const speed = lo === rec.speedHi ? rec.speedHi : lo + Math.random() * (rec.speedHi - lo);
      let radius = rec.spawnRadius;
      if (radius < 0) radius = Math.random() * -radius;
      const pj = rec.positionJitter & 15;
      this.x[i] = cx + (world[0] * radius + jitter(pj)) * X16_M;
      this.y[i] = cy + (world[1] * radius + jitter(pj)) * X16_M;
      this.z[i] = cz + (world[2] * radius + jitter(pj)) * X16_M;
      const vj = rec.velocityJitter & 15;
      this.vx[i] = (world[0] * speed + jitter(vj)) * X16_M;
      this.vy[i] = (world[1] * speed + jitter(vj)) * X16_M;
      this.vz[i] = (world[2] * speed + jitter(vj)) * X16_M;
      this.wx[i] = windX;
      this.wy[i] = windY;
      this.wz[i] = windZ;
      let divisor = rec.dragDivisor;
      if (divisor < 0) divisor = Math.max(1, Math.floor(Math.random() * -divisor));
      const coef = divisor > 0 ? (rec.drag * Math.floor(0x1000000 / divisor)) / 4096 : 0;
      this.drag[i] = coef / 4096;
      this.radial[i] = (rec.walkFlags & WALK_RADIAL) !== 0 ? 1 : 0;
      this.gravity[i] = this.radial[i] !== 0 ? factor / 4096 : gravity;
      this.ox[i] = cx;
      this.oy[i] = cy;
      this.oz[i] = cz;
      for (let c = 0; c < 3; c++) {
        this.from[i * 3 + c] = rec.colourA[c];
        this.to[i * 3 + c] = rec.colourB[c];
        this.rgb[i * 3 + c] = rec.colourA[c];
        // The budget is one number; it rides in the first channel's slot.
        this.step[i * 3 + c] =
          rampMode === RAMP_BUDGET ? (c === 0 ? rec.rampStep[0] : 0) : rec.rampStep[c];
      }
      this.rampMode[i] = rampMode;
      this.age[i] = 0;
      this.life[i] = life;
      let size = rec.rectSize;
      if (size < 0) size = 1 + Math.floor(Math.random() * -size);
      this.size[i] = Math.min(7, Math.max(1, size));
      this.blend[i] = blend;
      this.ground[i] = (rec.flags & FXF_NO_GROUND_TEST) !== 0 ? 0 : 1;
    }
    return made;
  }

  reset(): void {
    this.count = 0;
    for (let b = 0; b < this.layers.length; b++) {
      this.layers[b].count = 0;
      this.layers[b].points.geometry.setDrawRange(0, 0);
    }
  }

  /** The walks for `dt` engine ticks, then the rectangles. */
  update(dt: number, _poses: FxPoses | null, view: FxView): void {
    const s = dt / ENGINE_HZ;
    this.frames++;
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const k = this.drag[i];
      let tx = (this.wx[i] - this.vx[i]) * k;
      let ty = (this.wy[i] - this.vy[i]) * k;
      let tz = (this.wz[i] - this.vz[i]) * k;
      if (this.radial[i] !== 0) {
        const f = this.gravity[i];
        tx += (this.x[i] - this.ox[i]) * f;
        ty += (this.y[i] - this.oy[i]) * f;
        tz += (this.z[i] - this.oz[i]) * f;
      } else {
        ty += this.gravity[i];
      }
      this.vx[i] += tx * s;
      this.vy[i] += ty * s;
      this.vz[i] += tz * s;
      this.x[i] += this.vx[i] * s;
      this.y[i] += this.vy[i] * s;
      this.z[i] += this.vz[i] * s;
      rampNode(this.rampMode[i], this.rgb, i * 3, this.step, this.from, this.to, s);
      // The floor, one frame in eight, for a falling node.
      if (
        this.ground[i] !== 0 &&
        this.groundAt &&
        this.vy[i] < 0 &&
        ((this.frames ^ i) & 7) === 0 &&
        this.y[i] < this.groundAt(this.x[i], this.z[i])
      ) {
        this.kill(i);
        continue;
      }
      i++;
    }
    this.draw(view);
  }

  private kill(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.z[i] = this.z[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.wx[i] = this.wx[last];
      this.wy[i] = this.wy[last];
      this.wz[i] = this.wz[last];
      this.drag[i] = this.drag[last];
      this.gravity[i] = this.gravity[last];
      this.radial[i] = this.radial[last];
      this.ox[i] = this.ox[last];
      this.oy[i] = this.oy[last];
      this.oz[i] = this.oz[last];
      for (let c = 0; c < 3; c++) {
        this.rgb[i * 3 + c] = this.rgb[last * 3 + c];
        this.from[i * 3 + c] = this.from[last * 3 + c];
        this.to[i * 3 + c] = this.to[last * 3 + c];
        this.step[i * 3 + c] = this.step[last * 3 + c];
      }
      this.rampMode[i] = this.rampMode[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size[i] = this.size[last];
      this.blend[i] = this.blend[last];
      this.ground[i] = this.ground[last];
    }
    this.count = last;
  }

  private draw(view: FxView): void {
    this.uniforms.uPixelScale.value = view.pixelScale;
    for (let b = 0; b < this.layers.length; b++) this.layers[b].count = 0;
    for (let i = 0; i < this.count; i++) {
      const L = this.layers[this.blend[i]];
      const n = L.count++;
      const p = L.position.array as Float32Array;
      p[n * 3] = this.x[i];
      p[n * 3 + 1] = this.y[i];
      p[n * 3 + 2] = this.z[i];
      const c = L.colour.array as Float32Array;
      // Colour mode 0x30: the node colour doubled.
      const add = this.blend[i] === BLEND_ADD || this.blend[i] === BLEND_SUB;
      for (let k = 0; k < 3; k++) {
        const v = (this.rgb[i * 3 + k] * 2) / 255;
        c[n * 4 + k] = add ? v : Math.min(1, v);
      }
      c[n * 4 + 3] = this.blend[i] === BLEND_HALF ? 0.5 : 1;
      (L.size.array as Float32Array)[n] = this.size[i];
    }
    for (let b = 0; b < this.layers.length; b++) {
      const L = this.layers[b];
      L.points.geometry.setDrawRange(0, L.count);
      L.position.needsUpdate = true;
      L.colour.needsUpdate = true;
      L.size.needsUpdate = true;
    }
  }

  /** Nodes drawn this frame (tests). */
  drawn(): number {
    let n = 0;
    for (let b = 0; b < this.layers.length; b++) n += this.layers[b].count;
    return n;
  }
}
