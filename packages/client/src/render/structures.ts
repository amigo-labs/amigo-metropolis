// Static base structures (gate, core, consoles, ammo pad) built once from
// map data. They never move, so each base becomes ONE merged mesh with a
// static matrix — no per-frame cost at all. Ring turrets are live entities
// and render through the greybox instancing path instead.

import { type MapData, sampleHeight } from "@metropolis/sim";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { teamRamp } from "./palette";

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

export function buildBaseStructures(scene: THREE.Object3D, map: MapData): void {
  for (let team = 0; team < map.bases.length; team++) {
    const base = map.bases[team];
    const parts: THREE.BufferGeometry[] = [];

    // Gate: two pillars flanking the opening + crossbar, oriented so the
    // opening faces away from the core (toward the arena approach).
    const g = base.gate;
    const gh = sampleHeight(map, g.x, g.y);
    const inYaw = Math.atan2(base.core.y - g.y, base.core.x - g.x);
    const px = -Math.sin(inYaw); // perpendicular to the approach, sim space
    const py = Math.cos(inYaw);
    for (const s of [-1, 1]) {
      parts.push(box(1.4, 7, 1.4, g.x + px * g.radius * s, gh + 3.5, g.y + py * g.radius * s));
    }
    const bar = new THREE.BoxGeometry(1.2, 1.1, g.radius * 2 + 1.4);
    bar.rotateY(-inYaw);
    bar.translate(g.x, gh + 7.05, g.y);
    parts.push(bar);

    // Core: indestructible centerpiece — chunky tower with a beveled cap
    // (narrower edge box above the cap slab reads as a chamfer).
    const ch = sampleHeight(map, base.core.x, base.core.y);
    parts.push(box(4.4, 7, 4.4, base.core.x, ch + 3.5, base.core.y));
    parts.push(box(5.6, 1.2, 5.6, base.core.x, ch + 7.6, base.core.y));
    parts.push(box(4.8, 0.5, 4.8, base.core.x, ch + 8.45, base.core.y));

    // Consoles: ground = square pedestal, air = pedestal with an antenna,
    // both with a slab pad so the buy spot reads on the ground.
    for (const [c, antenna] of [
      [base.groundConsole, false],
      [base.airConsole, true],
    ] as const) {
      const h = sampleHeight(map, c.x, c.y);
      parts.push(box(3.4, 0.25, 3.4, c.x, h + 0.125, c.y));
      parts.push(box(1.0, 1.3, 1.0, c.x, h + 0.9, c.y));
      parts.push(box(1.4, 0.35, 1.0, c.x, h + 1.7, c.y));
      if (antenna) {
        parts.push(box(0.15, 2.4, 0.15, c.x, h + 3.0, c.y));
      }
    }

    // Ammo/repair pad: flat disc.
    const pad = new THREE.CylinderGeometry(base.pad.radius, base.pad.radius, 0.3, 16);
    const ph = sampleHeight(map, base.pad.x, base.pad.y);
    pad.translate(base.pad.x, ph + 0.15, base.pad.y);
    parts.push(pad);

    const mesh = new THREE.Mesh(
      mergeGeometries(parts),
      new THREE.MeshStandardMaterial({
        // Structures sit a shade darker than units — the ramp's dark tone,
        // with a faint team-colored glow so bases read at a distance.
        color: new THREE.Color(teamRamp(team).dark),
        metalness: 0.3,
        roughness: 0.55,
        emissive: new THREE.Color(teamRamp(team).base),
        emissiveIntensity: 0.25,
      }),
    );
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
  }
}

/** Static markers at avatar spawns + neutral outposts (render-only). */
export function buildSpawnMarkers(scene: THREE.Object3D, map: MapData): void {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of map.spawns) {
    const h = sampleHeight(map, s.x, s.y);
    const ring = new THREE.CylinderGeometry(1.6, 1.8, 0.3, 20);
    ring.translate(s.x, h + 0.15, s.y);
    parts.push(ring);
  }
  for (const o of map.outpostSpots) {
    const h = sampleHeight(map, o.x, o.y);
    const post = new THREE.CylinderGeometry(0.6, 0.8, 3.2, 12);
    post.translate(o.x, h + 1.6, o.y);
    parts.push(post);
  }
  if (parts.length === 0) return;
  const mesh = new THREE.Mesh(
    mergeGeometries(parts),
    new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.2, roughness: 0.6 }),
  );
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
}
