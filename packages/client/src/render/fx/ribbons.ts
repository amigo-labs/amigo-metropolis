// Everything the original draws as a camera-facing ribbon: type 87 trails
// (`effect_type87.c`, the tick 0x00449430, the draw 0x00448970), type 88
// links (`effect_link*.c`), the tracers (`tracer_spawn` 0x0043c120, the quad
// 0x0043c680), the Mini Gun's ribbon (`player_draw_gun_ribbon` 0x00448010)
// and the bolts: the world rounds whose Cobj is line facers (`cobj_prim_emit`'s
// line arm 0x004289cc), a textured quad between two points.
//
// Two dynamic meshes, rebuilt every frame into preallocated buffers: the
// textured one (a trail with its rect, the ribbon) and the gouraud one (the
// colour on the centre line, black at the edges: an untextured trail, a link
// strand, a tracer). Both additive with the colour doubled.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import { FX_BOLTS, FX_EXE, FX_TRAIL_ATLAS } from "../../effects/fcopEffects.generated";
import {
  DEFAULT_SCALE,
  directionOf,
  ENGINE_HZ,
  FXF_DIE_WITH_REFERENCE,
  type Fx87,
  type Fx88,
  LINK_FAR_NO_WIDTH,
  placementScale,
  ramp16Ticks,
  TRAIL_GROUND,
  TRAIL_HEAD_WORLD,
  TRAIL_NO_HEAD,
  TRAIL_NODE_PARTICLE_INDEX,
  TRAIL_NODES_MAX,
  TRAIL_PARTICLE,
  TRAIL_RETIRE_EMPTY,
  TRAIL_STOP_AT_ONCE,
  TRAIL_UNTEXTURED,
  TRAIL_VELOCITY,
  trailColour,
  trailNodeLife,
  vertexColour,
  WORLD_UNITS_PER_METRE,
  x16ToMetres,
} from "../../effects/records";
import {
  type Anchors,
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
import type { Particles } from "./particles";

/** The trails' synthetic head: a half-width floored at 3 units of the 480-line screen. */
const MIN_PX = 3;
/** The textured mesh's vertices, the gouraud mesh's. */
const TEXTURED_VERTS = 8192;
const PLAIN_VERTS = 32768;
/** The longest polyline one call writes (a trail's 40 nodes and its head, a link strand). */
const MAX_POINTS = 64;
/** Pyro flags of a trail node's particle (derived.node_particle: translucent | sprite | additive). */
const NODE_PARTICLE_FLAGS = 0x16;
/** A node's particle exists while its span (half-width << 5) is past 0x500. */
const NODE_PARTICLE_MIN = 0x500;

const VERTEX = /* glsl */ `
attribute vec3 aColour;
varying vec3 vColour;
varying vec2 vUv;
void main() {
  vColour = aColour;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TEXTURED_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uReady;
varying vec3 vColour;
varying vec2 vUv;
void main() {
  vec4 t = uReady > 0.5 ? texture2D(uMap, vUv) : vec4(0.5);
  if (t.a < 0.5) discard;
  gl_FragColor = vec4(t.rgb * vColour, 1.0);
}`;

const PLAIN_FRAGMENT = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
}`;

/** A ribbon mesh's buffers, filled from scratch every frame. */
class RibbonBuffer {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly colour: Float32Array;
  readonly uv: Float32Array;
  readonly index: Uint32Array;
  private readonly g: THREE.BufferGeometry;
  private readonly attrs: THREE.BufferAttribute[] = [];
  v = 0;
  n = 0;

  constructor(scene: THREE.Scene, maxVerts: number, material: THREE.ShaderMaterial) {
    this.pos = new Float32Array(maxVerts * 3);
    this.colour = new Float32Array(maxVerts * 3);
    this.uv = new Float32Array(maxVerts * 2);
    this.index = new Uint32Array(maxVerts * 3);
    this.g = new THREE.BufferGeometry();
    const attr = (a: Float32Array | Uint32Array, size: number) => {
      const b = new THREE.BufferAttribute(a, size);
      b.setUsage(THREE.DynamicDrawUsage);
      return b;
    };
    this.attrs.push(attr(this.pos, 3), attr(this.colour, 3), attr(this.uv, 2), attr(this.index, 1));
    this.g.setAttribute("position", this.attrs[0]);
    this.g.setAttribute("aColour", this.attrs[1]);
    this.g.setAttribute("uv", this.attrs[2]);
    this.g.setIndex(this.attrs[3]);
    this.g.setDrawRange(0, 0);
    this.mesh = prepareMesh(new THREE.Mesh(this.g, material), scene);
  }

  begin(): void {
    this.v = 0;
    this.n = 0;
  }

  /** Room for `verts` more vertices and `tris` more triangles. */
  room(verts: number, tris: number): boolean {
    return this.v + verts <= this.pos.length / 3 && this.n + tris * 3 <= this.index.length;
  }

  vertex(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    u: number,
    w: number,
  ): number {
    const v = this.v++;
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.colour[v * 3] = r;
    this.colour[v * 3 + 1] = g;
    this.colour[v * 3 + 2] = b;
    this.uv[v * 2] = u;
    this.uv[v * 2 + 1] = w;
    return v;
  }

  tri(a: number, b: number, c: number): void {
    this.index[this.n++] = a;
    this.index[this.n++] = b;
    this.index[this.n++] = c;
  }

  end(): void {
    this.g.setDrawRange(0, this.n);
    for (let k = 0; k < this.attrs.length; k++) this.attrs[k].needsUpdate = true;
  }
}

// --- the polyline scratch ------------------------------------------------------
const px = new Float32Array(MAX_POINTS);
const py = new Float32Array(MAX_POINTS);
const pz = new Float32Array(MAX_POINTS);
const hw = new Float32Array(MAX_POINTS);
const cr = new Float32Array(MAX_POINTS);
const cg = new Float32Array(MAX_POINTS);
const cb = new Float32Array(MAX_POINTS);
const sx = new Float32Array(MAX_POINTS);
const sy = new Float32Array(MAX_POINTS);
const sz = new Float32Array(MAX_POINTS);
const rgb3 = new Float32Array(3);
const dir = new Float32Array(3);

/**
 * The screen-facing side vector at each of the `n` points: the tangent
 * crossed with the line of sight, times the half-width (floored at `minPx`
 * 480-line pixels when it is positive).
 */
function sides(n: number, view: FxView, minPx: number): void {
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : i;
    const b = i < n - 1 ? i + 1 : i;
    const tx = px[b] - px[a];
    const ty = py[b] - py[a];
    const tz = pz[b] - pz[a];
    const vx = view.pos.x - px[i];
    const vy = view.pos.y - py[i];
    const vz = view.pos.z - pz[i];
    let x = ty * vz - tz * vy;
    let y = tz * vx - tx * vz;
    let z = tx * vy - ty * vx;
    let len = Math.sqrt(x * x + y * y + z * z);
    if (len < 1e-9) {
      x = view.right.x;
      y = view.right.y;
      z = view.right.z;
      len = 1;
    }
    let w = hw[i];
    if (minPx > 0 && w > 0) {
      const floor = (minPx * view.depth(px[i], py[i], pz[i])) / view.focal480;
      if (w < floor) w = floor;
    }
    sx[i] = (x / len) * w;
    sy[i] = (y / len) * w;
    sz[i] = (z / len) * w;
  }
}

/** Gouraud strip: the colour on the centre line, black on both edges (op 0x5c). */
function plainStrip(buf: RibbonBuffer, n: number, view: FxView, minPx: number): void {
  if (n < 2 || !buf.room(n * 3, (n - 1) * 4)) return;
  sides(n, view, minPx);
  const base = buf.v;
  for (let i = 0; i < n; i++) {
    buf.vertex(px[i] - sx[i], py[i] - sy[i], pz[i] - sz[i], 0, 0, 0, 0, 0);
    buf.vertex(px[i], py[i], pz[i], cr[i], cg[i], cb[i], 0, 0);
    buf.vertex(px[i] + sx[i], py[i] + sy[i], pz[i] + sz[i], 0, 0, 0, 0, 0);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 3;
    const b = a + 3;
    buf.tri(a, a + 1, b + 1);
    buf.tri(a, b + 1, b);
    buf.tri(a + 1, a + 2, b + 2);
    buf.tri(a + 1, b + 2, b + 1);
  }
}

/**
 * Textured strip: one quad a segment with the rect (u0..u1 across, v0..v1
 * along), the two points' colours on its ends (op 0xdc).
 */
function texturedStrip(
  buf: RibbonBuffer,
  n: number,
  view: FxView,
  minPx: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): void {
  if (n < 2 || !buf.room((n - 1) * 4, (n - 1) * 2)) return;
  sides(n, view, minPx);
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1;
    const a = buf.vertex(px[i] - sx[i], py[i] - sy[i], pz[i] - sz[i], cr[i], cg[i], cb[i], u0, v0);
    const b = buf.vertex(px[i] + sx[i], py[i] + sy[i], pz[i] + sz[i], cr[i], cg[i], cb[i], u1, v0);
    const c = buf.vertex(px[j] + sx[j], py[j] + sy[j], pz[j] + sz[j], cr[j], cg[j], cb[j], u1, v1);
    const d = buf.vertex(px[j] - sx[j], py[j] - sy[j], pz[j] - sz[j], cr[j], cg[j], cb[j], u0, v1);
    buf.tri(a, b, c);
    buf.tri(a, c, d);
  }
}

/**
 * The line arm's quad (0x00428b44): out and in at end 0, in and out at end 1,
 * each corner with its own (u, v) from `uv` (texels of the arena's row).
 */
function cornerQuad(
  buf: RibbonBuffer,
  view: FxView,
  uv: readonly number[],
  rowV: number,
  w: number,
  h: number,
): void {
  if (!buf.room(4, 2)) return;
  sides(2, view, 0);
  const a = buf.vertex(
    px[0] + sx[0],
    py[0] + sy[0],
    pz[0] + sz[0],
    cr[0],
    cg[0],
    cb[0],
    uv[0] / w,
    (rowV + uv[1]) / h,
  );
  const b = buf.vertex(
    px[0] - sx[0],
    py[0] - sy[0],
    pz[0] - sz[0],
    cr[0],
    cg[0],
    cb[0],
    uv[2] / w,
    (rowV + uv[3]) / h,
  );
  const c = buf.vertex(
    px[1] - sx[1],
    py[1] - sy[1],
    pz[1] - sz[1],
    cr[1],
    cg[1],
    cb[1],
    uv[4] / w,
    (rowV + uv[5]) / h,
  );
  const d = buf.vertex(
    px[1] + sx[1],
    py[1] + sy[1],
    pz[1] + sz[1],
    cr[1],
    cg[1],
    cb[1],
    uv[6] / w,
    (rowV + uv[7]) / h,
  );
  buf.tri(a, b, c);
  buf.tri(a, c, d);
}

// --- the classes -------------------------------------------------------------------

const TRAILS = 48;
const LINKS = 16;
const LINK_POINTS = 33 * 10;
const TRACERS = 16;
/** One per player slot that can be firing a Mini Gun. */
const RIBBONS = 4;
/** Bolts drawn a frame: the round buckets' capacity (render/greybox.ts) and more. */
const BOLTS = 512;

export class Ribbons {
  private readonly textured: RibbonBuffer;
  private readonly plain: RibbonBuffer;
  private readonly uniforms = {
    uMap: { value: null as THREE.Texture | null },
    uReady: { value: 0 },
  };
  /** The arena's row in trails.png. */
  private trailRow = 0;

  // trails
  trails = 0;
  private readonly ta: Anchors = makeAnchors(TRAILS);
  private readonly trec: (Fx87 | null)[] = new Array<Fx87 | null>(TRAILS).fill(null);
  private readonly tAge = new Float32Array(TRAILS);
  private readonly tScale = new Float32Array(TRAILS);
  private readonly tHold = new Float32Array(TRAILS);
  private readonly tEmit = new Uint8Array(TRAILS);
  private readonly tBank = new Uint8Array(TRAILS);
  private readonly tId = new Uint16Array(TRAILS);
  private readonly tNodes = new Uint8Array(TRAILS);
  /** Per node, newest first: position, velocity (m a tick), half-width (x16), age. */
  private readonly nx = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly ny = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly nz = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly nvx = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly nvy = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly nvz = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly nhw = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly nage = new Float32Array(TRAILS * TRAIL_NODES_MAX);
  private readonly ncut = new Uint8Array(TRAILS * TRAIL_NODES_MAX);

  // links
  links = 0;
  private readonly la: Anchors = makeAnchors(LINKS);
  private readonly lrec: (Fx88 | null)[] = new Array<Fx88 | null>(LINKS).fill(null);
  private readonly lAge = new Float32Array(LINKS);
  private readonly lLife = new Float32Array(LINKS);
  private readonly lRelay = new Float32Array(LINKS);
  private readonly lNext = new Uint8Array(LINKS);
  private readonly lScatter = new Float32Array(LINKS);
  /** The far end: fixed (a target) or 0 (scattered around end 0 at each lay). */
  private readonly lFixed = new Uint8Array(LINKS);
  private readonly lex = new Float32Array(LINKS);
  private readonly ley = new Float32Array(LINKS);
  private readonly lez = new Float32Array(LINKS);
  /** Per strand: when it was laid (link age), its points. */
  private readonly sLaid = new Float32Array(LINKS * 10);
  private readonly spx = new Float32Array(LINKS * LINK_POINTS);
  private readonly spy = new Float32Array(LINKS * LINK_POINTS);
  private readonly spz = new Float32Array(LINKS * LINK_POINTS);

  // tracers
  tracers = 0;
  private readonly trx = new Float32Array(TRACERS);
  private readonly try_ = new Float32Array(TRACERS);
  private readonly trz = new Float32Array(TRACERS);
  private readonly trdx = new Float32Array(TRACERS);
  private readonly trdy = new Float32Array(TRACERS);
  private readonly trdz = new Float32Array(TRACERS);
  private readonly trTotal = new Float32Array(TRACERS);
  private readonly trHead = new Float32Array(TRACERS);
  private readonly trLength = new Float32Array(TRACERS);
  private readonly trWidth = new Float32Array(TRACERS);
  private readonly trSpeed = new Float32Array(TRACERS);
  private readonly trRgb = new Float32Array(TRACERS * 3);

  // the Mini Gun's ribbon
  private readonly ribbonEntity = new Int32Array(RIBBONS).fill(-1);
  private readonly ribbonLeft = new Float32Array(RIBBONS);
  private readonly ribbonX = new Float32Array(RIBBONS);
  private readonly ribbonY = new Float32Array(RIBBONS);
  private readonly ribbonZ = new Float32Array(RIBBONS);
  private readonly ribbonYaw = new Float32Array(RIBBONS);

  // the bolts queued this frame (main.ts's entity pass), and how many the last drew
  bolts = 0;
  boltsDrawn = 0;
  private readonly bRow = new Uint8Array(BOLTS);
  private readonly bx = new Float32Array(BOLTS);
  private readonly by = new Float32Array(BOLTS);
  private readonly bz = new Float32Array(BOLTS);
  private readonly bdx = new Float32Array(BOLTS);
  private readonly bdy = new Float32Array(BOLTS);
  private readonly bdz = new Float32Array(BOLTS);

  /** The ground under (x, z), for the trails' GROUND bit; null none. */
  groundAt: ((x: number, z: number) => number) | null = null;

  constructor(scene: THREE.Scene) {
    const material = (fragment: string, uniforms: Record<string, THREE.IUniform>) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: fragment,
        uniforms,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      });
      m.blending = THREE.AdditiveBlending;
      return m;
    };
    this.textured = new RibbonBuffer(
      scene,
      TEXTURED_VERTS,
      material(TEXTURED_FRAGMENT, this.uniforms),
    );
    this.plain = new RibbonBuffer(scene, PLAIN_VERTS, material(PLAIN_FRAGMENT, {}));
  }

  setAtlas(texture: THREE.Texture): void {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.uniforms.uMap.value = texture;
    this.uniforms.uReady.value = 1;
  }

  /** The arena whose tex10 the trail rect comes from. */
  setTrailRow(row: number): void {
    this.trailRow = row;
  }

  reset(): void {
    this.trails = 0;
    this.links = 0;
    this.tracers = 0;
    this.ribbonLeft.fill(0);
    this.ribbonEntity.fill(-1);
    this.bolts = 0;
    this.boltsDrawn = 0;
    this.textured.begin();
    this.plain.begin();
    this.textured.end();
    this.plain.end();
  }

  rebind(token: number, entity: number): void {
    rebindAnchors(this.ta, this.trails, token, entity);
    rebindAnchors(this.la, this.links, token, entity);
  }

  // --- type 87 --------------------------------------------------------------------

  /**
   * The factory 0x00449cc0: a trail whose emission point rides its reference
   * (the frame's position, or the instance's own with head_world). `hold` is a
   * sustained weapon's countdown in engine ticks, 0 for none.
   */
  trail(bank: number, id: number, rec: Fx87, at: Readonly<RaiseAt>, hold: number): boolean {
    const i = this.trails;
    if (i >= TRAILS) return false;
    this.trails++;
    placeAnchor(this.ta, i, rec, at, (rec.trailFlags & TRAIL_HEAD_WORLD) === 0);
    this.trec[i] = rec;
    this.tAge[i] = 0;
    this.tScale[i] = placementScale(rec.halfWidth, at.raiserScale || DEFAULT_SCALE, at.scale);
    this.tHold[i] = hold;
    this.tEmit[i] = 1;
    this.tBank[i] = bank;
    this.tId[i] = id;
    this.tNodes[i] = 0;
    // The first node at the emission point, so the chain has a head to measure from.
    this.addNode(i, rec);
    return true;
  }

  /** The sustain's refresh: the trail of (bank, id) riding `attach` holds on. */
  hold(bank: number, id: number, attach: number, ticks: number): boolean {
    let found = false;
    for (let i = 0; i < this.trails; i++) {
      if (
        this.tBank[i] === bank &&
        this.tId[i] === id &&
        this.ta.ref[i] === attach &&
        this.tEmit[i]
      ) {
        this.tHold[i] = ticks;
        found = true;
      }
    }
    return found;
  }

  private addNode(i: number, rec: Fx87): void {
    const count = this.tNodes[i];
    if (count >= TRAIL_NODES_MAX) return;
    const base = i * TRAIL_NODES_MAX;
    // Newest first: shift the chain down one.
    for (let k = count; k > 0; k--) this.moveNode(base + k - 1, base + k);
    this.tNodes[i] = count + 1;
    this.nx[base] = this.ta.x[i];
    this.ny[base] = this.ta.y[i];
    this.nz[base] = this.ta.z[i];
    this.nhw[base] = this.tScale[i];
    this.nage[base] = 0;
    this.ncut[base] = 0;
    if ((rec.trailFlags & TRAIL_VELOCITY) !== 0 && rec.emitSpeed !== 0) {
      // Row 2 of the frame times the speed: 1/16 world unit a tick, in the
      // reference's frame (the trail's frame is the reference's).
      directionOf(roll(rec.emitAngleY), roll(rec.emitAngleX), this.ta.yaw[i], dir);
      const speed = rec.emitSpeed / 16 / WORLD_UNITS_PER_METRE;
      const j = rec.velocityJitter / 16 / WORLD_UNITS_PER_METRE;
      this.nvx[base] = dir[0] * speed + (Math.random() - 0.5) * j;
      this.nvy[base] = dir[1] * speed + (Math.random() - 0.5) * j;
      this.nvz[base] = dir[2] * speed + (Math.random() - 0.5) * j;
    } else {
      this.nvx[base] = 0;
      this.nvy[base] = 0;
      this.nvz[base] = 0;
    }
  }

  private moveNode(from: number, to: number): void {
    this.nx[to] = this.nx[from];
    this.ny[to] = this.ny[from];
    this.nz[to] = this.nz[from];
    this.nvx[to] = this.nvx[from];
    this.nvy[to] = this.nvy[from];
    this.nvz[to] = this.nvz[from];
    this.nhw[to] = this.nhw[from];
    this.nage[to] = this.nage[from];
    this.ncut[to] = this.ncut[from];
  }

  /** `cact_effect_trail_tick` 0x00449430 for `dt` engine ticks. */
  private tickTrails(dt: number, poses: FxPoses | null): void {
    let i = 0;
    while (i < this.trails) {
      const rec = this.trec[i] as Fx87;
      this.tAge[i] += dt;
      // The reference gone, the sustain run out, or the lifetime's mark:
      // stop emitting; with STOP_AT_ONCE that is the end of it.
      let stop = false;
      if (!followAnchor(this.ta, i, poses)) {
        stop = true;
        if ((rec.flags & FXF_DIE_WITH_REFERENCE) !== 0) {
          this.killTrail(i);
          continue;
        }
      }
      if (this.tHold[i] > 0) {
        this.tHold[i] -= dt;
        if (this.tHold[i] <= 0) stop = true;
      }
      if (rec.life > 0 && this.tAge[i] >= rec.life) stop = true;
      if (stop && this.tEmit[i]) {
        this.tEmit[i] = 0;
        if ((rec.trailFlags & TRAIL_STOP_AT_ONCE) !== 0) {
          this.killTrail(i);
          continue;
        }
      }
      const base = i * TRAIL_NODES_MAX;
      // New nodes: one per `spacing` from the head node to the point.
      if (this.tEmit[i] && (rec.trailFlags & TRAIL_NO_HEAD) === 0) {
        const head = this.tNodes[i] > 0 ? base : -1;
        const spacing = x16ToMetres(Math.max(1, rec.spacing));
        let d = Number.POSITIVE_INFINITY;
        if (head >= 0) {
          const dx = this.ta.x[i] - this.nx[head];
          const dy = this.ta.y[i] - this.ny[head];
          const dz = this.ta.z[i] - this.nz[head];
          d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        let emit = head < 0 ? 1 : Math.floor(d / spacing);
        while (emit-- > 0 && this.tNodes[i] < TRAIL_NODES_MAX) this.addNode(i, rec);
      }
      // Every node: colour, width, motion; finished ones go back to the pool
      // behind a finished newer one (the walk's predecessor rule).
      const grow = (rec.widthRate / 256) * dt;
      const gravity = (rec.gravity / 256 / 16 / WORLD_UNITS_PER_METRE) * dt;
      const keep = rec.drag !== 0 ? (1 - rec.drag / 4096) ** (dt / 10) : 1;
      const life = trailNodeLife(rec.stageTicks);
      let kept = 0;
      let prevDone = true;
      const n = this.tNodes[i];
      for (let k = 0; k < n; k++) {
        const s = base + k;
        this.nage[s] += dt;
        this.nhw[s] += grow;
        if ((rec.trailFlags & TRAIL_VELOCITY) !== 0) {
          this.nvy[s] += gravity;
          this.nvx[s] *= keep;
          this.nvy[s] *= keep;
          this.nvz[s] *= keep;
          this.nx[s] += this.nvx[s] * dt;
          this.ny[s] += this.nvy[s] * dt;
          this.nz[s] += this.nvz[s] * dt;
        }
        const done = this.nage[s] >= life;
        let cut = this.ncut[s] !== 0;
        if (
          !cut &&
          (rec.trailFlags & TRAIL_GROUND) !== 0 &&
          this.groundAt &&
          this.ny[s] < this.groundAt(this.nx[s], this.nz[s])
        ) {
          this.ncut[s] = 1;
          cut = false; // cut on the next pass, as the original's end bit is
        }
        if (cut) break; // this node and every older one go back
        if (!(done && prevDone)) {
          if (kept !== k) this.moveNode(s, base + kept);
          kept++;
        }
        prevDone = done;
      }
      this.tNodes[i] = kept;
      // An empty chain retires with RETIRE_EMPTY (0x0044947d), and a stopped one always.
      if (kept === 0 && ((rec.trailFlags & TRAIL_RETIRE_EMPTY) !== 0 || !this.tEmit[i])) {
        this.killTrail(i);
        continue;
      }
      i++;
    }
  }

  private killTrail(i: number): void {
    const last = this.trails - 1;
    if (i !== last) {
      copyAnchor(this.ta, last, i);
      this.trec[i] = this.trec[last];
      this.tAge[i] = this.tAge[last];
      this.tScale[i] = this.tScale[last];
      this.tHold[i] = this.tHold[last];
      this.tEmit[i] = this.tEmit[last];
      this.tBank[i] = this.tBank[last];
      this.tId[i] = this.tId[last];
      this.tNodes[i] = this.tNodes[last];
      const a = i * TRAIL_NODES_MAX;
      const b = last * TRAIL_NODES_MAX;
      for (let k = 0; k < this.tNodes[last]; k++) this.moveNode(b + k, a + k);
    }
    this.trec[last] = null;
    this.trails = last;
  }

  private drawTrails(view: FxView, particles: Particles): void {
    const atlas = FX_TRAIL_ATLAS;
    const v0 = (this.trailRow * atlas.rowHeight) / atlas.height;
    const v1 = (this.trailRow * atlas.rowHeight + atlas.trail.h) / atlas.height;
    const u0 = atlas.trail.x / atlas.width;
    const u1 = (atlas.trail.x + atlas.trail.w) / atlas.width;
    for (let i = 0; i < this.trails; i++) {
      const rec = this.trec[i] as Fx87;
      const base = i * TRAIL_NODES_MAX;
      let n = 0;
      // The synthetic head node at the emission point (unless no_head).
      if (this.tEmit[i] && (rec.trailFlags & TRAIL_NO_HEAD) === 0) {
        px[n] = this.ta.x[i];
        py[n] = this.ta.y[i];
        pz[n] = this.ta.z[i];
        hw[n] = x16ToMetres(this.tScale[i]);
        cr[n] = vertexColour(rec.stageRgb[0]);
        cg[n] = vertexColour(rec.stageRgb[1]);
        cb[n] = vertexColour(rec.stageRgb[2]);
        n++;
      }
      const nodes = this.tNodes[i];
      for (let k = 0; k < nodes && n < MAX_POINTS; k++) {
        const s = base + k;
        trailColour(rec.stageRgb, rec.stageTicks, this.nage[s], rgb3);
        px[n] = this.nx[s];
        py[n] = this.ny[s];
        pz[n] = this.nz[s];
        hw[n] = x16ToMetres(this.nhw[s]);
        cr[n] = vertexColour(rgb3[0]);
        cg[n] = vertexColour(rgb3[1]);
        cb[n] = vertexColour(rgb3[2]);
        if ((rec.trailFlags & TRAIL_PARTICLE) !== 0 && this.nhw[s] * 32 > NODE_PARTICLE_MIN) {
          particles.put(
            TRAIL_NODE_PARTICLE_INDEX,
            NODE_PARTICLE_FLAGS,
            px[n],
            py[n],
            pz[n],
            (this.nhw[s] * 32) / WORLD_UNITS_PER_METRE,
            0,
            0,
            rgb3[0],
            rgb3[1],
            rgb3[2],
            view,
          );
        }
        n++;
      }
      if (rec.rect < 0 || (rec.trailFlags & TRAIL_UNTEXTURED) !== 0)
        plainStrip(this.plain, n, view, MIN_PX);
      else texturedStrip(this.textured, n, view, MIN_PX, u0, v0, u1, v1);
    }
  }

  // --- type 88 --------------------------------------------------------------------

  /**
   * The link 0x0043eea0: `strands` jagged strands from end 0 (the raiser) to
   * end 1 (the raise's far end, or a point scattered on a flat disc around end
   * 0), each laid again in turn every original frame and fading to black over
   * `fade` (ramp16).
   */
  link(rec: Fx88, at: Readonly<RaiseAt>): boolean {
    const i = this.links;
    if (i >= LINKS) return false;
    this.links++;
    placeAnchor(this.la, i, rec, at, true);
    this.lrec[i] = rec;
    this.lAge[i] = 0;
    const fade = ramp16Ticks(rec.fadeTicks);
    this.lLife[i] = rec.life > 0 ? rec.life : Math.max(fade, 10);
    this.lRelay[i] = 0;
    this.lNext[i] = 0;
    this.lScatter[i] = x16ToMetres(
      Math.abs(placementScale(rec.scatter, at.raiserScale || DEFAULT_SCALE, at.scale)),
    );
    this.lFixed[i] = Number.isNaN(at.endX) ? 0 : 1;
    this.lex[i] = at.endX;
    this.ley[i] = at.endY;
    this.lez[i] = at.endZ;
    const strands = Math.min(10, Math.max(1, rec.strands));
    for (let s = 0; s < strands; s++) this.lay(i, s, rec);
    return true;
  }

  /** `cact_effect_link_build_strand` 0x0043d810: one strand's random walk. */
  private lay(i: number, s: number, rec: Fx88): void {
    const count = Math.min(32, Math.max(1, rec.segments));
    const o = (i * 10 + s) * 33;
    const x0 = this.la.x[i];
    const y0 = this.la.y[i];
    const z0 = this.la.z[i];
    let x1 = this.lex[i];
    let y1 = this.ley[i];
    let z1 = this.lez[i];
    if (this.lFixed[i] === 0) {
      const a = Math.random() * 2 * Math.PI;
      const r = Math.sqrt(Math.random()) * this.lScatter[i];
      x1 = x0 + Math.cos(a) * r;
      y1 = y0;
      z1 = z0 + Math.sin(a) * r;
    }
    this.spx[o] = x0;
    this.spy[o] = y0;
    this.spz[o] = z0;
    this.spx[o + count] = x1;
    this.spy[o + count] = y1;
    this.spz[o + count] = z1;
    let dx = x1 - x0;
    let dy = y1 - y0;
    let dz = z1 - z0;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length > 1e-6) {
      dx /= length;
      dy /= length;
      dz /= length;
    }
    // The perpendicular retail picks (dropping a component under 0.8), unnormalised, and the binormal.
    let qx: number;
    let qy: number;
    let qz: number;
    if (Math.abs(dx) < 0.8) {
      qx = 0;
      qy = -dz;
      qz = dy;
    } else {
      qx = dz;
      qy = 0;
      qz = -dx;
    }
    const bx = dz * qy - dy * qz;
    const by = dx * qz - dz * qx;
    const bz = dy * qx - dx * qy;
    // Every lateral offset a multiple of half the amplitude's unit (`v >> 7`).
    const unit = ((rec.amplitude >> 7) * 16) / WORLD_UNITS_PER_METRE;
    const step = length / count;
    let lx = 0;
    let ly = 0;
    let lz = 0;
    let scale = 1;
    const decay = 1 / count;
    for (let k = 1; k < count; k++) {
      const pl = (Math.floor(Math.random() * 5) - 2) * 0.5 * unit;
      const pt = (Math.floor(Math.random() * 5) - 2) * 0.5 * unit;
      lx += pl * qx + pt * bx;
      ly += pl * qy + pt * by;
      lz += pl * qz + pt * bz;
      // One, two or three half-steps past the running base, which then moves on two.
      const along = (k - 1) * step + (Math.floor(Math.random() * 3) + 1) * 0.5 * step;
      this.spx[o + k] = x0 + dx * along + lx * scale;
      this.spy[o + k] = y0 + dy * along + ly * scale;
      this.spz[o + k] = z0 + dz * along + lz * scale;
      scale -= decay;
    }
    this.sLaid[i * 10 + s] = this.lAge[i];
  }

  private tickLinks(dt: number, poses: FxPoses | null): void {
    let i = 0;
    while (i < this.links) {
      const rec = this.lrec[i] as Fx88;
      this.lAge[i] += dt;
      if (this.lAge[i] >= this.lLife[i]) {
        this.killLink(i);
        continue;
      }
      if (!followAnchor(this.la, i, poses) && (rec.flags & FXF_DIE_WITH_REFERENCE) !== 0) {
        this.killLink(i);
        continue;
      }
      // relay_period 0 in every shipped record: one strand laid again a frame.
      this.lRelay[i] += dt;
      const strands = Math.min(10, Math.max(1, rec.strands));
      while (this.lRelay[i] >= 10) {
        this.lRelay[i] -= 10;
        this.lay(i, this.lNext[i], rec);
        this.lNext[i] = (this.lNext[i] + 1) % strands;
      }
      i++;
    }
  }

  private killLink(i: number): void {
    const last = this.links - 1;
    if (i !== last) {
      copyAnchor(this.la, last, i);
      this.lrec[i] = this.lrec[last];
      this.lAge[i] = this.lAge[last];
      this.lLife[i] = this.lLife[last];
      this.lRelay[i] = this.lRelay[last];
      this.lNext[i] = this.lNext[last];
      this.lScatter[i] = this.lScatter[last];
      this.lFixed[i] = this.lFixed[last];
      this.lex[i] = this.lex[last];
      this.ley[i] = this.ley[last];
      this.lez[i] = this.lez[last];
      for (let s = 0; s < 10; s++) this.sLaid[i * 10 + s] = this.sLaid[last * 10 + s];
      const a = i * LINK_POINTS;
      const b = last * LINK_POINTS;
      for (let k = 0; k < LINK_POINTS; k++) {
        this.spx[a + k] = this.spx[b + k];
        this.spy[a + k] = this.spy[b + k];
        this.spz[a + k] = this.spz[b + k];
      }
    }
    this.lrec[last] = null;
    this.links = last;
  }

  private drawLinks(view: FxView): void {
    for (let i = 0; i < this.links; i++) {
      const rec = this.lrec[i] as Fx88;
      const count = Math.min(32, Math.max(1, rec.segments));
      const strands = Math.min(10, Math.max(1, rec.strands));
      const fade = ramp16Ticks(rec.fadeTicks);
      const w0 = x16ToMetres(rec.endHalfWidth);
      const w1 = (rec.linkFlags & LINK_FAR_NO_WIDTH) !== 0 ? 0 : w0;
      for (let s = 0; s < strands; s++) {
        const t = this.lAge[i] - this.sLaid[i * 10 + s];
        const f = fade > 0 ? Math.max(0, 1 - t / fade) : 1;
        if (f <= 0) continue;
        const o = (i * 10 + s) * 33;
        for (let k = 0; k <= count; k++) {
          px[k] = this.spx[o + k];
          py[k] = this.spy[o + k];
          pz[k] = this.spz[o + k];
          hw[k] = w0 + ((w1 - w0) * k) / count;
          cr[k] = vertexColour(rec.rgb[0] * f);
          cg[k] = vertexColour(rec.rgb[1] * f);
          cb[k] = vertexColour(rec.rgb[2] * f);
        }
        // A strand collapses to a line rather than to nothing: floor it at a pixel.
        plainStrip(this.plain, count + 1, view, 1);
      }
    }
  }

  // --- tracers ----------------------------------------------------------------------

  /**
   * `tracer_spawn` 0x0043c120: a segment `length` (x16) long sliding from the
   * muzzle to the end at `speed` world units a second, `width / 4` (x16) to
   * either side, its colour on the centre line at the midpoint.
   */
  tracer(
    kind: "world" | "laserA" | "laserB",
    x: number,
    y: number,
    z: number,
    ex: number,
    ey: number,
    ez: number,
  ): boolean {
    const i = this.tracers;
    if (i >= TRACERS) return false;
    const t = FX_EXE.tracers[kind];
    const dx = ex - x;
    const dy = ey - y;
    const dz = ez - z;
    const total = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (total < 1e-4) return false;
    this.tracers++;
    this.trx[i] = x;
    this.try_[i] = y;
    this.trz[i] = z;
    this.trdx[i] = dx / total;
    this.trdy[i] = dy / total;
    this.trdz[i] = dz / total;
    this.trTotal[i] = total;
    this.trHead[i] = 0;
    this.trLength[i] = x16ToMetres(t.length);
    this.trWidth[i] = x16ToMetres(t.width / 4);
    const speed =
      t.speed + (t.speedSpread > 0 ? Math.floor(Math.random() * t.speedSpread) & 0x1f000 : 0);
    this.trSpeed[i] = speed / WORLD_UNITS_PER_METRE;
    for (let k = 0; k < 3; k++) this.trRgb[i * 3 + k] = vertexColour(t.rgb[k]);
    return true;
  }

  private tickTracers(dt: number): void {
    let i = 0;
    while (i < this.tracers) {
      this.trHead[i] += (this.trSpeed[i] * dt) / ENGINE_HZ;
      // It dies when the head reaches the end.
      if (this.trHead[i] >= this.trTotal[i]) {
        this.killTracer(i);
        continue;
      }
      i++;
    }
  }

  private killTracer(i: number): void {
    const last = this.tracers - 1;
    if (i !== last) {
      this.trx[i] = this.trx[last];
      this.try_[i] = this.try_[last];
      this.trz[i] = this.trz[last];
      this.trdx[i] = this.trdx[last];
      this.trdy[i] = this.trdy[last];
      this.trdz[i] = this.trdz[last];
      this.trTotal[i] = this.trTotal[last];
      this.trHead[i] = this.trHead[last];
      this.trLength[i] = this.trLength[last];
      this.trWidth[i] = this.trWidth[last];
      this.trSpeed[i] = this.trSpeed[last];
      for (let k = 0; k < 3; k++) this.trRgb[i * 3 + k] = this.trRgb[last * 3 + k];
    }
    this.tracers = last;
  }

  private drawTracers(view: FxView): void {
    for (let i = 0; i < this.tracers; i++) {
      const head = this.trHead[i];
      const tail = Math.max(0, head - this.trLength[i]);
      const mid = (head + tail) / 2;
      for (let k = 0; k < 3; k++) {
        const d = k === 0 ? tail : k === 1 ? mid : head;
        px[k] = this.trx[i] + this.trdx[i] * d;
        py[k] = this.try_[i] + this.trdy[i] * d;
        pz[k] = this.trz[i] + this.trdz[i] * d;
        hw[k] = k === 1 ? this.trWidth[i] : 0;
        const c = k === 1 ? 1 : 0;
        cr[k] = this.trRgb[i * 3] * c;
        cg[k] = this.trRgb[i * 3 + 1] * c;
        cb[k] = this.trRgb[i * 3 + 2] * c;
      }
      plainStrip(this.plain, 3, view, 0);
    }
  }

  // --- the Mini Gun's ribbon -------------------------------------------------------

  /**
   * The view's gun block names the Mini Gun this frame (0x00459aa6): the ribbon
   * from the gun's point 0 along its facing, `ticks` engine ticks long (until
   * the next shot sets it again).
   */
  ribbon(entity: number, x: number, y: number, z: number, yaw: number, ticks: number): void {
    let slot = -1;
    for (let k = 0; k < RIBBONS; k++) {
      if (this.ribbonEntity[k] === entity) slot = k;
    }
    if (slot < 0) {
      for (let k = 0; k < RIBBONS; k++) {
        if (this.ribbonLeft[k] <= 0) {
          slot = k;
          break;
        }
      }
    }
    if (slot < 0) return;
    this.ribbonEntity[slot] = entity;
    this.ribbonLeft[slot] = ticks;
    this.ribbonX[slot] = x;
    this.ribbonY[slot] = y;
    this.ribbonZ[slot] = z;
    this.ribbonYaw[slot] = yaw;
  }

  private drawRibbons(
    dt: number,
    poses: FxPoses | null,
    view: FxView,
    muzzleF: number,
    muzzleU: number,
  ): void {
    const atlas = FX_TRAIL_ATLAS;
    const r = FX_EXE.ribbon;
    const half = x16ToMetres(r.halfWidth);
    const length = r.length / WORLD_UNITS_PER_METRE;
    for (let k = 0; k < RIBBONS; k++) {
      if (this.ribbonLeft[k] <= 0) continue;
      this.ribbonLeft[k] -= dt;
      const e = this.ribbonEntity[k];
      let x = this.ribbonX[k];
      let y = this.ribbonY[k];
      let z = this.ribbonZ[k];
      let yaw = this.ribbonYaw[k];
      if (poses && e >= 0 && poses.live[e] !== 0) {
        const o = e * 4;
        yaw = poses.table[o + 3];
        x = poses.table[o] + Math.cos(yaw) * muzzleF;
        y = poses.table[o + 1] + muzzleU;
        z = poses.table[o + 2] + Math.sin(yaw) * muzzleF;
      }
      // One of the three frames every draw (game_rand() % 3, 0x0044809a).
      const f = atlas.ribbon[Math.floor(Math.random() * atlas.ribbon.length)];
      const rowV = this.trailRow * atlas.rowHeight;
      const c = vertexColour(r.rgb[0]);
      px[0] = x;
      py[0] = y;
      pz[0] = z;
      px[1] = x + Math.cos(yaw) * length;
      py[1] = y;
      pz[1] = z + Math.sin(yaw) * length;
      hw[0] = half;
      hw[1] = half;
      cr[0] = c;
      cg[0] = c;
      cb[0] = c;
      cr[1] = c;
      cg[1] = c;
      cb[1] = c;
      // The flame stands with its tip at the top of the frame: tip at the far end.
      texturedStrip(
        this.textured,
        2,
        view,
        0,
        f[0] / atlas.width,
        (rowV + f[3]) / atlas.height,
        f[2] / atlas.width,
        (rowV + f[1]) / atlas.height,
      );
    }
  }

  // --- the bolts --------------------------------------------------------------------

  /**
   * A world round of a bolt row at (x, y, z) heading along the unit (dx, dy,
   * dz), drawn this frame. False when the row is not a bolt (it wears a model).
   */
  bolt(row: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
    if (FX_BOLTS[row] === undefined) return false;
    const i = this.bolts;
    if (i >= BOLTS) return true;
    this.bolts++;
    this.bRow[i] = row;
    this.bx[i] = x;
    this.by[i] = y;
    this.bz[i] = z;
    this.bdx[i] = dx;
    this.bdy[i] = dy;
    this.bdz[i] = dz;
    return true;
  }

  private drawBolts(view: FxView): void {
    const atlas = FX_TRAIL_ATLAS;
    const rowV = this.trailRow * atlas.rowHeight;
    for (let i = 0; i < this.bolts; i++) {
      const lines = FX_BOLTS[this.bRow[i]];
      if (!lines) continue;
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k];
        px[0] = this.bx[i] + this.bdx[i] * l.z0;
        py[0] = this.by[i] + this.bdy[i] * l.z0;
        pz[0] = this.bz[i] + this.bdz[i] * l.z0;
        px[1] = this.bx[i] + this.bdx[i] * l.z1;
        py[1] = this.by[i] + this.bdy[i] * l.z1;
        pz[1] = this.bz[i] + this.bdz[i] * l.z1;
        hw[0] = l.half0;
        hw[1] = l.half1;
        // Colour mode 0x30: the face's bytes doubled (draw_submit 0x00456a49).
        const r = vertexColour(l.rgb[0]);
        const g = vertexColour(l.rgb[1]);
        const b = vertexColour(l.rgb[2]);
        cr[0] = r;
        cg[0] = g;
        cb[0] = b;
        cr[1] = r;
        cg[1] = g;
        cb[1] = b;
        cornerQuad(this.textured, view, l.uv, rowV, atlas.width, atlas.height);
      }
    }
    this.boltsDrawn = this.bolts;
    this.bolts = 0;
  }

  /** Ribbons drawn this frame (tests): live trails, links, tracers. */
  counts(): {
    trails: number;
    links: number;
    tracers: number;
    ribbons: number;
    bolts: number;
  } {
    let ribbons = 0;
    for (let k = 0; k < RIBBONS; k++) if (this.ribbonLeft[k] > 0) ribbons++;
    return {
      trails: this.trails,
      links: this.links,
      tracers: this.tracers,
      ribbons,
      bolts: this.boltsDrawn,
    };
  }

  update(
    dt: number,
    poses: FxPoses | null,
    view: FxView,
    particles: Particles,
    muzzleF: number,
    muzzleU: number,
  ): void {
    this.tickTrails(dt, poses);
    this.tickLinks(dt, poses);
    this.tickTracers(dt);
    this.textured.begin();
    this.plain.begin();
    this.drawTrails(view, particles);
    this.drawLinks(view);
    this.drawTracers(view);
    this.drawRibbons(dt, poses, view, muzzleF, muzzleU);
    this.drawBolts(view);
    this.textured.end();
    this.plain.end();
  }
}
