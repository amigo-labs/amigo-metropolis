// Type 90: the raiser's model broken into flying faces (`effect_type90.c`,
// the filler 0x004388a0, the draw 0x00438140: "the reference's model broken
// into up to `count` of its triangles and quads, each flying and turning on
// its own and drawn with the model's own face").
//
// Drawn here with the dying unit's own mesh and material: `count` of its
// triangles (0..50, 20 with flag 0x08, 50 when out of range), each leaving
// its place on the model at a speed rolled in the record's magnitude range
// plus the drift (drift scale range along the drift direction), turning about
// an axis of its own, falling. What is approximated: the RE has transcribed
// the filler but not named the units of the magnitude and drift words; they
// are read here as sixteenths of a world unit a second, and the fall is the
// original's mortar gravity (6 m/s², docs/behavior/combat.md). One mesh per
// archetype, preallocated.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import { directionOf, type Fx90, TURN } from "../../effects/records";
import { prepareMesh } from "./common";

/** The model a dying archetype is drawn with: main.ts hands the greybox bucket's. */
export type ShatterSource = (
  archetype: number,
) => { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] } | null;

const FACES_MAX = 50;
/** Faces in flight per archetype at once. */
const FACES_PER_KIND = 150;
const KINDS = 9;
const GRAVITY = 6;
const X16_M = 16 / 8192;
const TO_RAD = (2 * Math.PI) / TURN;

interface Kind {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly pos: Float32Array;
  readonly uv: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  /** Per face: its three vertices about its centroid, model space turned to the world's yaw. */
  readonly local: Float32Array;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly cz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly ax: Float32Array;
  readonly ay: Float32Array;
  readonly az: Float32Array;
  readonly spin: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  count: number;
}

const q = new THREE.Quaternion();
const axis = new THREE.Vector3();
const v = new THREE.Vector3();
const dir = new Float32Array(3);

export class Shatter {
  private readonly kinds: Kind[] = [];
  /** Where the dying models come from (main.ts); null draws nothing. */
  source: ShatterSource | null = null;

  constructor(scene: THREE.Scene) {
    for (let k = 0; k < KINDS; k++) {
      const n = FACES_PER_KIND * 3;
      const geometry = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      const normal = new Float32Array(n * 3);
      const colour = new Float32Array(n * 3).fill(1);
      for (const [name, a, size] of [
        ["position", pos, 3],
        ["uv", uv, 2],
        ["normal", normal, 3],
        ["color", colour, 3],
      ] as const) {
        const attr = new THREE.BufferAttribute(a, size);
        attr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, attr);
      }
      geometry.setDrawRange(0, 0);
      const mesh = prepareMesh(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()), scene);
      mesh.visible = false;
      const f = FACES_PER_KIND;
      this.kinds.push({
        mesh,
        geometry,
        pos,
        uv,
        normal,
        colour,
        local: new Float32Array(f * 9),
        cx: new Float32Array(f),
        cy: new Float32Array(f),
        cz: new Float32Array(f),
        vx: new Float32Array(f),
        vy: new Float32Array(f),
        vz: new Float32Array(f),
        ax: new Float32Array(f),
        ay: new Float32Array(f),
        az: new Float32Array(f),
        spin: new Float32Array(f),
        age: new Float32Array(f),
        life: new Float32Array(f),
        count: 0,
      });
    }
  }

  /** The filler 0x004388a0 on the raiser's model. False with no model to break. */
  spawn(rec: Fx90, at: Readonly<RaiseAt>): boolean {
    const kind = this.kinds[at.archetype];
    const src = at.archetype >= 0 && this.source ? this.source(at.archetype) : null;
    if (!kind || !src) return false;
    const g = src.geometry;
    const position = g.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position) return false;
    const uv = g.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const normal = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const colour = g.getAttribute("color") as THREE.BufferAttribute | undefined;
    const index = g.getIndex();
    const tris = Math.floor((index ? index.count : position.count) / 3);
    if (tris === 0) return false;
    kind.mesh.material = src.material;
    kind.mesh.visible = true;
    let count = rec.count;
    if ((rec.shatterFlags & 0x08) !== 0) count = 20;
    if (count < 0 || count > FACES_MAX) count = FACES_MAX;
    count = Math.min(count, tris);
    const c = Math.cos(-at.yaw);
    const s = Math.sin(-at.yaw);
    const life = rec.life > 0 ? rec.life / 300 : 1;
    for (let n = 0; n < count; n++) {
      const f = kind.count;
      if (f >= FACES_PER_KIND) break;
      kind.count++;
      const t = Math.floor(Math.random() * tris);
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        // The model's frame (+X forward) turned by the raiser's yaw, as the
        // instance matrix main.ts writes turns it.
        const lx = position.getX(vi);
        const ly = position.getY(vi);
        const lz = position.getZ(vi);
        const wx = lx * c + lz * s;
        const wz = -lx * s + lz * c;
        kind.local[f * 9 + k * 3] = wx;
        kind.local[f * 9 + k * 3 + 1] = ly;
        kind.local[f * 9 + k * 3 + 2] = wz;
        mx += wx / 3;
        my += ly / 3;
        mz += wz / 3;
        const o = (f * 3 + k) * 3;
        const o2 = (f * 3 + k) * 2;
        kind.uv[o2] = uv ? uv.getX(vi) : 0;
        kind.uv[o2 + 1] = uv ? uv.getY(vi) : 0;
        kind.normal[o] = normal ? normal.getX(vi) : 0;
        kind.normal[o + 1] = normal ? normal.getY(vi) : 1;
        kind.normal[o + 2] = normal ? normal.getZ(vi) : 0;
        kind.colour[o] = colour ? colour.getX(vi) : 1;
        kind.colour[o + 1] = colour ? colour.getY(vi) : 1;
        kind.colour[o + 2] = colour ? colour.getZ(vi) : 1;
      }
      for (let k = 0; k < 3; k++) {
        kind.local[f * 9 + k * 3] -= mx;
        kind.local[f * 9 + k * 3 + 1] -= my;
        kind.local[f * 9 + k * 3 + 2] -= mz;
      }
      kind.cx[f] = at.x + mx;
      kind.cy[f] = at.y + my;
      kind.cz[f] = at.z + mz;
      // Outward from the model's middle at the rolled magnitude, plus the drift.
      let ox = mx;
      let oy = my + 0.3;
      let oz = mz;
      const len = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      ox /= len;
      oy /= len;
      oz /= len;
      const speed = (rec.magnitudeLo + Math.random() * (rec.magnitudeHi - rec.magnitudeLo)) * X16_M;
      const drift =
        (rec.driftScaleLo + Math.random() * (rec.driftScaleHi - rec.driftScaleLo)) * X16_M;
      directionOf(rec.driftAngleY * TO_RAD, rec.driftAngleX * TO_RAD, 0, dir);
      kind.vx[f] = ox * speed + dir[0] * drift;
      kind.vy[f] = oy * speed + dir[1] * drift;
      kind.vz[f] = oz * speed + dir[2] * drift;
      axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      kind.ax[f] = axis.x;
      kind.ay[f] = axis.y;
      kind.az[f] = axis.z;
      kind.spin[f] = (Math.random() * 2 - 1) * 8;
      kind.age[f] = 0;
      kind.life[f] = life;
    }
    return true;
  }

  reset(): void {
    for (let k = 0; k < this.kinds.length; k++) {
      this.kinds[k].count = 0;
      this.kinds[k].geometry.setDrawRange(0, 0);
      this.kinds[k].mesh.visible = false;
    }
  }

  /** Faces in flight (tests). */
  faces(): number {
    let n = 0;
    for (let k = 0; k < this.kinds.length; k++) n += this.kinds[k].count;
    return n;
  }

  update(dtTicks: number): void {
    const dt = dtTicks / 300;
    for (let k = 0; k < this.kinds.length; k++) {
      const kind = this.kinds[k];
      if (kind.count === 0) continue;
      let f = 0;
      while (f < kind.count) {
        kind.age[f] += dt;
        if (kind.age[f] >= kind.life[f]) {
          this.kill(kind, f);
          continue;
        }
        kind.vy[f] -= GRAVITY * dt;
        kind.cx[f] += kind.vx[f] * dt;
        kind.cy[f] += kind.vy[f] * dt;
        kind.cz[f] += kind.vz[f] * dt;
        f++;
      }
      for (let i = 0; i < kind.count; i++) {
        axis.set(kind.ax[i], kind.ay[i], kind.az[i]);
        q.setFromAxisAngle(axis, kind.spin[i] * kind.age[i]);
        for (let c = 0; c < 3; c++) {
          v.set(
            kind.local[i * 9 + c * 3],
            kind.local[i * 9 + c * 3 + 1],
            kind.local[i * 9 + c * 3 + 2],
          );
          v.applyQuaternion(q);
          const o = (i * 3 + c) * 3;
          kind.pos[o] = kind.cx[i] + v.x;
          kind.pos[o + 1] = kind.cy[i] + v.y;
          kind.pos[o + 2] = kind.cz[i] + v.z;
        }
      }
      kind.geometry.setDrawRange(0, kind.count * 3);
      (kind.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute("uv") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      if (kind.count === 0) kind.mesh.visible = false;
    }
  }

  private kill(kind: Kind, f: number): void {
    const last = kind.count - 1;
    if (f !== last) {
      for (let k = 0; k < 9; k++) kind.local[f * 9 + k] = kind.local[last * 9 + k];
      for (let k = 0; k < 9; k++) {
        kind.normal[f * 9 + k] = kind.normal[last * 9 + k];
        kind.colour[f * 9 + k] = kind.colour[last * 9 + k];
      }
      for (let k = 0; k < 6; k++) kind.uv[f * 6 + k] = kind.uv[last * 6 + k];
      kind.cx[f] = kind.cx[last];
      kind.cy[f] = kind.cy[last];
      kind.cz[f] = kind.cz[last];
      kind.vx[f] = kind.vx[last];
      kind.vy[f] = kind.vy[last];
      kind.vz[f] = kind.vz[last];
      kind.ax[f] = kind.ax[last];
      kind.ay[f] = kind.ay[last];
      kind.az[f] = kind.az[last];
      kind.spin[f] = kind.spin[last];
      kind.age[f] = kind.age[last];
      kind.life[f] = kind.life[last];
    }
    kind.count = last;
  }
}
