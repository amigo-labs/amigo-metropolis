"""
Verify la-cantina turret spots against the terrain GLB in Blender.

Same alignment as docs/renders/fcop-viz/build_map.py (logic bbox centre → glb
bbox centre, FLIP_Y=-1 for glTF Z→Blender -Y).

For each spot: sample the flat plate at the first-hit height, compute plate
centroid + discrete inradius centre, report offset, write suggested snaps.

Run:
  blender --background --python tools/generators/verifyLaCantinaPadsInBlender.py

Optional env:
  APPLY=1  rewrite packages/sim/maps/la-cantina.json with corrected XY + height stamps
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
GLB = ROOT / "packages/client/public/models/la-cantina/la-cantina.glb"
MAP_PATH = ROOT / "packages/sim/maps/la-cantina.json"
VIZ_PATH = ROOT / "docs/renders/fcop-viz/viz_data_la-cantina.json"
OUT_JSON = ROOT / "docs/renders/fcop-viz/la-cantina-pad-verify.json"
FLIP_Y = -1.0
HS = 0.03125
STEP = 0.12
RADIUS = 2.4
MAX_MOVE = 1.0
APPLY = os.environ.get("APPLY", "0") == "1"


def clean_scene() -> None:
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections):
        if c.name != "Scene Collection":
            try:
                bpy.data.collections.remove(c)
            except Exception:
                pass
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)


def import_terrain() -> list:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(GLB))
    imported = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    return [o for o in imported if o.type == "MESH"]


def bbox_centre_xy(meshes: list) -> tuple[float, float]:
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in meshes:
        for cor in o.bound_box:
            w = o.matrix_world @ Vector(cor)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return (mn.x + mx.x) * 0.5, (mn.y + mx.y) * 0.5


def logic_centre_from_map(m: dict) -> tuple[float, float]:
    xs: list[float] = []
    zs: list[float] = []

    def add(x: float, z: float) -> None:
        xs.append(float(x))
        zs.append(float(z))

    for s in m["spawns"]:
        add(s["x"], s["y"])
    for b in m["bases"]:
        c = b["core"]
        add(c[0] if isinstance(c, list) else c["x"], c[1] if isinstance(c, list) else c["y"])
        for t in b["turrets"]:
            add(t[0], t[1])
    for t in m.get("turretSpots", []) + m.get("dummySpots", []) + m.get("outpostSpots", []):
        add(t[0], t[1])
    for lane in m.get("lanes", []):
        for p in lane:
            add(p[0], p[1])
    return (min(xs) + max(xs)) * 0.5, (min(zs) + max(zs)) * 0.5


def g2b(col: float, row: float, lcx: float, lcy: float, glb_cx: float, glb_cy: float):
    return (col - lcx + glb_cx, FLIP_Y * (row - lcy) + glb_cy)


def b2g(bx: float, by: float, lcx: float, lcy: float, glb_cx: float, glb_cy: float):
    col = bx - glb_cx + lcx
    row = FLIP_Y * (by - glb_cy) + lcy
    return col, row


def ground_z(scene, dg, bx: float, by: float) -> float | None:
    hit, loc, *_ = scene.ray_cast(dg, Vector((bx, by, 2000.0)), Vector((0, 0, -1)))
    return float(loc.z) if hit else None


def pad_center(
    scene,
    dg,
    cx: float,
    cz: float,
    lcx: float,
    lcy: float,
    glb_cx: float,
    glb_cy: float,
) -> dict | None:
    """Find plate centre under (cx,cz) in sim coords. Returns sim xy + height."""
    bx0, by0 = g2b(cx, cz, lcx, lcy, glb_cx, glb_cy)
    h0 = ground_z(scene, dg, bx0, by0)
    if h0 is None:
        return None

    # Prefer elevated plate near seed if local floor is much lower
    samples: list[tuple[float, float, float, float, float]] = []  # simx,simz,bx,by,h
    for iz in range(-int(RADIUS / STEP), int(RADIUS / STEP) + 1):
        for ix in range(-int(RADIUS / STEP), int(RADIUS / STEP) + 1):
            dx = ix * STEP
            dz = iz * STEP
            if dx * dx + dz * dz > RADIUS * RADIUS:
                continue
            sx, sz = cx + dx, cz + dz
            bx, by = g2b(sx, sz, lcx, lcy, glb_cx, glb_cy)
            h = ground_z(scene, dg, bx, by)
            if h is None:
                continue
            samples.append((sx, sz, bx, by, h))
    if len(samples) < 8:
        return {"x": cx, "z": cz, "y": h0, "n": 0, "d": 0.0, "note": "sparse"}

    # Lock plate height to first-hit under the FCOP actor (fcop-viz style).
    # Climbing to higher roofs put towers on skyline decks instead of the pad
    # Vorsprung the user marks — only re-center XY on the local plate.
    best_h = h0
    plate = [s for s in samples if abs(s[4] - h0) <= 0.15]
    if len(plate) < 4:
        return {"x": cx, "z": cz, "y": h0, "n": 0, "d": 0.0, "note": "no-plate"}

    def key(sx: float, sz: float) -> tuple[int, int]:
        return (round(sx / STEP), round(sz / STEP))

    pmap = {key(s[0], s[1]): s for s in plate}
    seed = min(plate, key=lambda s: math.hypot(s[0] - cx, s[1] - cz))
    stack = [seed]
    seen = {key(seed[0], seed[1])}
    conn = [seed]
    while stack:
        cur = stack.pop()
        for di, dj in (
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (1, -1),
            (-1, 1),
            (-1, -1),
        ):
            k = (round(cur[0] / STEP) + di, round(cur[1] / STEP) + dj)
            if k in seen:
                continue
            n = pmap.get(k)
            if not n:
                continue
            seen.add(k)
            stack.append(n)
            conn.append(n)

    # Inradius centre on discrete plate
    pkeys = {key(s[0], s[1]) for s in conn}
    best_in = -1.0
    best_pt = conn[0]
    for s in conn:
        min_e = 1e9
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            r = 1
            while r < 40:
                kk = (round(s[0] / STEP) + di * r, round(s[1] / STEP) + dj * r)
                if kk not in pkeys:
                    break
                r += 1
            dist = r * STEP * (math.sqrt(0.5) if di and dj else 1.0)
            min_e = min(min_e, dist)
        if min_e > best_in:
            best_in = min_e
            best_pt = s

    cx2 = sum(s[0] for s in conn) / len(conn)
    cz2 = sum(s[1] for s in conn) / len(conn)
    mx = best_pt[0] * 0.55 + cx2 * 0.45
    mz = best_pt[1] * 0.55 + cz2 * 0.45
    d = math.hypot(mx - cx, mz - cz)
    if d > MAX_MOVE:
        t = MAX_MOVE / d
        mx = cx + (mx - cx) * t
        mz = cz + (mz - cz) * t

    bx, by = g2b(mx, mz, lcx, lcy, glb_cx, glb_cy)
    hy = ground_z(scene, dg, bx, by)
    if hy is None or abs(hy - best_h) > 0.45:
        mx, mz = best_pt[0], best_pt[1]
        hy = best_pt[4]

    # quantize 0.25 m (map convention)
    qx = round(mx * 4) / 4
    qz = round(mz * 4) / 4
    bx, by = g2b(qx, qz, lcx, lcy, glb_cx, glb_cy)
    hy = ground_z(scene, dg, bx, by) or hy

    return {
        "x": qx,
        "z": qz,
        "y": float(hy),
        "n": len(conn),
        "d": math.hypot(qx - cx, qz - cz),
        "inR": best_in,
        "h0": h0,
        "plateH": best_h,
        "note": "ok",
    }


def main() -> None:
    clean_scene()
    scene = bpy.context.scene
    meshes = import_terrain()
    if not meshes:
        print("ERROR: no terrain meshes", file=sys.stderr)
        sys.exit(1)
    glb_cx, glb_cy = bbox_centre_xy(meshes)
    m = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    lcx, lcy = logic_centre_from_map(m)
    # Prefer viz logic centre if available (stable vs drifting map features)
    if VIZ_PATH.exists():
        viz = json.loads(VIZ_PATH.read_text(encoding="utf-8"))
        vxs, vzs = [], []
        for g in ("turrets", "neutrals", "bases", "spawns", "pickups"):
            for a in viz.get(g, []):
                vxs.append(a["x"])
                vzs.append(a["z"])
        if vxs:
            lcx = (min(vxs) + max(vxs)) * 0.5
            lcy = (min(vzs) + max(vzs)) * 0.5

    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()

    spots: list[tuple[str, float, float]] = []
    for bi, b in enumerate(m["bases"]):
        for ti, t in enumerate(b["turrets"]):
            spots.append((f"def{bi}.{ti}", float(t[0]), float(t[1])))
    for i, t in enumerate(m.get("turretSpots", [])):
        spots.append((f"cap{i}", float(t[0]), float(t[1])))
    for i, t in enumerate(m.get("outpostSpots", [])):
        spots.append((f"out{i}", float(t[0]), float(t[1])))

    results = []
    bad = []
    for label, x, z in spots:
        r = pad_center(scene, dg, x, z, lcx, lcy, glb_cx, glb_cy)
        if r is None:
            bad.append({"label": label, "x": x, "z": z, "err": "nohit"})
            continue
        entry = {"label": label, "from": [x, z], **r}
        results.append(entry)
        flag = " *" if r["d"] >= 0.25 else ""
        print(
            f"{label:10} ({x:7.2f},{z:7.2f}) → ({r['x']:7.2f},{r['z']:7.2f}) "
            f"d={r['d']:.2f} y={r['y']:.3f} plate={r.get('plateH', r['y']):.2f} "
            f"n={r['n']} inR={r.get('inR', 0):.2f}{flag}"
        )

    report = {
        "logicCentre": {"x": lcx, "z": lcy},
        "glbCentre": {"x": glb_cx, "y": glb_cy},
        "flipY": FLIP_Y,
        "results": results,
        "bad": bad,
        "offCenter": [r for r in results if r["d"] >= 0.25],
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT_JSON}")
    print(f"off-centre (>=0.25m): {len(report['offCenter'])} / {len(results)}")

    if APPLY:
        # Apply snaps
        by_label = {r["label"]: r for r in results}

        def apply_list(lst: list, prefix: str) -> list:
            out = []
            for i, t in enumerate(lst):
                r = by_label.get(f"{prefix}{i}")
                if r:
                    out.append([r["x"], r["z"]])
                else:
                    out.append(t)
            return out

        for bi, b in enumerate(m["bases"]):
            nt = []
            for ti, t in enumerate(b["turrets"]):
                r = by_label.get(f"def{bi}.{ti}")
                nt.append([r["x"], r["z"]] if r else t)
            b["turrets"] = nt
        m["turretSpots"] = apply_list(m.get("turretSpots", []), "cap")
        m["outpostSpots"] = apply_list(m.get("outpostSpots", []), "out")

        # Stamp heights
        size = m["size"]
        heights = m["heights"]

        def stamp(x: float, y: float, meters: float, radius: float = 1.45) -> None:
            q = int(round(meters / HS))
            i0 = int(math.floor(x - radius))
            i1 = int(math.ceil(x + radius))
            j0 = int(math.floor(y - radius))
            j1 = int(math.ceil(y + radius))
            for j in range(j0, j1 + 1):
                for i in range(i0, i1 + 1):
                    if j < 0 or j >= size or i < 0 or i >= size:
                        continue
                    dx = i + 0.5 - x
                    dy = j + 0.5 - y
                    if dx * dx + dy * dy > (radius + 0.4) ** 2:
                        continue
                    heights[j][i] = q

        for r in results:
            stamp(r["x"], r["z"], r["y"])
        # base shelves
        for b in m["bases"]:
            core = b["core"]
            stamp(core[0] if isinstance(core, list) else core["x"], core[1] if isinstance(core, list) else core["y"], 1)
            stamp(b["gate"]["x"], b["gate"]["y"], 1)
            gc = b["groundConsole"]
            stamp(gc[0] if isinstance(gc, list) else gc["x"], gc[1] if isinstance(gc, list) else gc["y"], 1)
            ac = b["airConsole"]
            stamp(ac[0] if isinstance(ac, list) else ac["x"], ac[1] if isinstance(ac, list) else ac["y"], 1)
            stamp(b["pad"]["x"], b["pad"]["y"], 1)
            for t in b["turrets"]:
                # keep mesh pad height from results if available else 1 for ring
                stamp(t[0], t[1], 1)
        for s in m["spawns"]:
            stamp(s["x"], s["y"], 1)
        # re-stamp caps with their mesh y
        for r in results:
            if r["label"].startswith("cap") or r["label"].startswith("out"):
                stamp(r["x"], r["z"], r["y"])

        MAP_PATH.write_text(json.dumps(m) + "\n", encoding="utf-8")
        # FNV pin
        import struct

        flat = []
        for j in range(size):
            for i in range(size):
                flat.append(heights[j][i] * HS)
        # simple print of hash via bun externally
        print("APPLY wrote", MAP_PATH)
        print("recompute heightsPin with: bun -e \"...\"")


if __name__ == "__main__":
    main()
    # Blender --python keeps running unless we quit
    try:
        bpy.ops.wm.quit_blender()
    except Exception:
        pass
