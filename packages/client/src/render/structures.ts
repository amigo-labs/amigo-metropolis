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

export function buildBaseStructures(scene: THREE.Scene, map: MapData): void {
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

    // Core: indestructible centerpiece — chunky tower with a cap.
    const ch = sampleHeight(map, base.core.x, base.core.y);
    parts.push(box(4.4, 7, 4.4, base.core.x, ch + 3.5, base.core.y));
    parts.push(box(5.6, 1.2, 5.6, base.core.x, ch + 7.6, base.core.y));

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
        flatShading: true,
        // Structures sit a shade darker than units — the ramp's dark tone.
        color: new THREE.Color(teamRamp(team).dark),
      }),
    );
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
  }
}
