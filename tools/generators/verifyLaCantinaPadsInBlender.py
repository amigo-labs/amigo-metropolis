"""
Verify/fix la-cantina turret XY against terrain GLB in Blender.

Alignment = fcop-viz build_map.py (logic bbox centre → glb bbox centre, FLIP_Y=-1).

Pad detection:
  - Sample disk around FCOP actor
  - Prefer a LOCAL elevated island (pad top above local floor), not the whole
    courtyard flat — that was leaving sockels off-centre on large -1.5 plates
  - Discrete inradius centre of that island

Run:
  blender --background --factory-startup --python tools/generators/verifyLaCantinaPadsInBlender.py
  APPLY=1 blender --background --factory-startup --python tools/generators/verifyLaCantinaPadsInBlender.py
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
STEP = 0.1
RADIUS = 2.0
MAX_MOVE = 1.15
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


def logic_centre_viz_or_map(m: dict) -> tuple[float, float]:
    if VIZ_PATH.exists():
        viz = json.loads(VIZ_PATH.read_text(encoding="utf-8"))
        vxs, vzs = [], []
        for g in ("turrets", "neutrals", "bases", "spawns", "pickups"):
            for a in viz.get(g, []):
                vxs.append(a["x"])
                vzs.append(a["z"])
        if vxs:
            return (min(vxs) + max(vxs)) * 0.5, (min(vzs) + max(vzs)) * 0.5
    xs, zs = [], []

    def add(x, z):
        xs.append(float(x))
        zs.append(float(z))

    for s in m["spawns"]:
        add(s["x"], s["y"])
    for b in m["bases"]:
        c = b["core"]
        add(c[0] if isinstance(c, list) else c["x"], c[1] if isinstance(c, list) else c["y"])
        for t in b["turrets"]:
            add(t[0], t[1])
    for t in m.get("turretSpots", []) + m.get("outpostSpots", []):
        add(t[0], t[1])
    for lane in m.get("lanes", []):
        for p in lane:
            add(p[0], p[1])
    return (min(xs) + max(xs)) * 0.5, (min(zs) + max(zs)) * 0.5


def g2b(col, row, lcx, lcy, glb_cx, glb_cy):
    return (col - lcx + glb_cx, FLIP_Y * (row - lcy) + glb_cy)


def ground_z(scene, dg, bx, by) -> float | None:
    hit, loc, *_ = scene.ray_cast(dg, Vector((bx, by, 2000.0)), Vector((0, 0, -1)))
    return float(loc.z) if hit else None


def pad_center(scene, dg, cx, cz, lcx, lcy, glb_cx, glb_cy) -> dict | None:
    bx0, by0 = g2b(cx, cz, lcx, lcy, glb_cx, glb_cy)
    h0 = ground_z(scene, dg, bx0, by0)
    if h0 is None:
        return None

    samples: list[tuple[float, float, float]] = []  # sx, sz, h
    nstep = int(RADIUS / STEP)
    for iz in range(-nstep, nstep + 1):
        for ix in range(-nstep, nstep + 1):
            dx, dz = ix * STEP, iz * STEP
            if dx * dx + dz * dz > RADIUS * RADIUS:
                continue
            sx, sz = cx + dx, cz + dz
            bx, by = g2b(sx, sz, lcx, lcy, glb_cx, glb_cy)
            h = ground_z(scene, dg, bx, by)
            if h is None:
                continue
            samples.append((sx, sz, h))
    if len(samples) < 10:
        return {"x": cx, "z": cz, "y": h0, "n": 0, "d": 0.0, "inR": 0.0, "note": "sparse"}

    hs = sorted(s[2] for s in samples)
    floor_y = hs[max(0, int(len(hs) * 0.15))]
    # Pad island: prefer elevated band above local floor; else tight band on h0
    if h0 >= floor_y + 0.25:
        # Actor already on a raised plate — keep that height (do not climb roofs)
        H = h0
        plate = [s for s in samples if abs(s[2] - H) <= 0.12]
    else:
        # On floor — climb to nearest elevated island within radius
        bins: dict[float, list] = {}
        for s in samples:
            if s[2] < floor_y + 0.3:
                continue
            b = round(s[2] * 8) / 8
            bins.setdefault(b, []).append(s)
        if bins:
            # highest dense island near actor
            best = None
            best_sc = -1e9
            for h, g in bins.items():
                if len(g) < 8:
                    continue
                mx = sum(p[0] for p in g) / len(g)
                mz = sum(p[1] for p in g) / len(g)
                d = math.hypot(mx - cx, mz - cz)
                if d > MAX_MOVE + 0.5:
                    continue
                sc = (h - floor_y) * 100 + min(len(g), 60) - d * 10
                if sc > best_sc:
                    best_sc = sc
                    best = (h, g)
            if best:
                H, plate = best[0], [s for s in samples if abs(s[2] - best[0]) <= 0.12]
            else:
                H, plate = h0, [s for s in samples if abs(s[2] - h0) <= 0.12]
        else:
            H, plate = h0, [s for s in samples if abs(s[2] - h0) <= 0.12]

    if len(plate) < 6:
        return {"x": cx, "z": cz, "y": h0, "n": 0, "d": 0.0, "inR": 0.0, "note": "no-plate"}

    def key(sx, sz):
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

    # If the connected component is huge (courtyard), shrink to samples near actor
    if len(conn) > 180:
        near = [s for s in conn if math.hypot(s[0] - cx, s[1] - cz) <= 1.1]
        if len(near) >= 8:
            conn = near

    pkeys = {key(s[0], s[1]) for s in conn}
    best_in = -1.0
    best_pt = conn[0]
    for s in conn:
        min_e = 1e9
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            r = 1
            while r < 50:
                kk = (round(s[0] / STEP) + di * r, round(s[1] / STEP) + dj * r)
                if kk not in pkeys:
                    break
                r += 1
            dist = r * STEP * (math.sqrt(0.5) if di and dj else 1.0)
            min_e = min(min_e, dist)
        # Prefer larger inradius; slight bias to actor for stability
        near = math.hypot(s[0] - cx, s[1] - cz)
        if min_e > best_in + 0.001 or (
            abs(min_e - best_in) <= 0.001 and near < math.hypot(best_pt[0] - cx, best_pt[1] - cz)
        ):
            best_in = min_e
            best_pt = s

    # Pure inradius centre (sockel sits on geometric pad centre)
    mx, mz = best_pt[0], best_pt[1]
    d = math.hypot(mx - cx, mz - cz)
    if d > MAX_MOVE:
        t = MAX_MOVE / d
        mx = cx + (mx - cx) * t
        mz = cz + (mz - cz) * t

    # 0.125 m quantize (finer than 0.25 — sockel offset was visible at 0.25)
    qx = round(mx * 8) / 8
    qz = round(mz * 8) / 8
    bx, by = g2b(qx, qz, lcx, lcy, glb_cx, glb_cy)
    hy = ground_z(scene, dg, bx, by)
    if hy is None:
        hy = H

    return {
        "x": qx,
        "z": qz,
        "y": float(hy),
        "n": len(conn),
        "d": math.hypot(qx - cx, qz - cz),
        "inR": best_in,
        "h0": h0,
        "plateH": H,
        "note": "ok",
    }


def stamp(heights, size, x, y, meters, radius=1.5):
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


def main() -> None:
    clean_scene()
    scene = bpy.context.scene
    meshes = import_terrain()
    if not meshes:
        print("ERROR: no terrain", file=sys.stderr)
        sys.exit(1)
    glb_cx, glb_cy = bbox_centre_xy(meshes)
    m = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    lcx, lcy = logic_centre_viz_or_map(m)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()

    spots = []
    for bi, b in enumerate(m["bases"]):
        for ti, t in enumerate(b["turrets"]):
            spots.append((f"def{bi}.{ti}", float(t[0]), float(t[1])))
    for i, t in enumerate(m.get("turretSpots", [])):
        spots.append((f"cap{i}", float(t[0]), float(t[1])))
    for i, t in enumerate(m.get("outpostSpots", [])):
        spots.append((f"out{i}", float(t[0]), float(t[1])))

    results = []
    for label, x, z in spots:
        r = pad_center(scene, dg, x, z, lcx, lcy, glb_cx, glb_cy)
        if r is None:
            print(f"{label} NOHIT")
            continue
        entry = {"label": label, "from": [x, z], **r}
        results.append(entry)
        flag = " *" if r["d"] >= 0.15 else ""
        print(
            f"{label:10} ({x:7.3f},{z:7.3f}) → ({r['x']:7.3f},{r['z']:7.3f}) "
            f"d={r['d']:.3f} y={r['y']:.3f} n={r['n']} inR={r['inR']:.2f}{flag}"
        )

    report = {
        "logicCentre": {"x": lcx, "z": lcy},
        "glbCentre": {"x": glb_cx, "y": glb_cy},
        "results": results,
        "offCenter": [r for r in results if r["d"] >= 0.15],
    }
    OUT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT_JSON}")
    print(f"off-centre (>=0.15m): {len(report['offCenter'])} / {len(results)}")

    if APPLY:
        by = {r["label"]: r for r in results}
        for bi, b in enumerate(m["bases"]):
            b["turrets"] = [
                [by[f"def{bi}.{ti}"]["x"], by[f"def{bi}.{ti}"]["z"]]
                if f"def{bi}.{ti}" in by
                else t
                for ti, t in enumerate(b["turrets"])
            ]
        m["turretSpots"] = [
            [by[f"cap{i}"]["x"], by[f"cap{i}"]["z"]] if f"cap{i}" in by else t
            for i, t in enumerate(m.get("turretSpots", []))
        ]
        m["outpostSpots"] = [
            [by[f"out{i}"]["x"], by[f"out{i}"]["z"]] if f"out{i}" in by else t
            for i, t in enumerate(m.get("outpostSpots", []))
        ]
        # Wall-pocket: south outer ring at z=69.5 is blocked
        for bi, b in enumerate(m["bases"]):
            for ti, t in enumerate(b["turrets"]):
                if abs(t[0] - 107.5) < 0.2 and abs(t[1] - 69.5) < 0.2:
                    b["turrets"][ti] = [107.5, 70.0]

        size = m["size"]
        heights = m["heights"]
        for r in results:
            stamp(heights, size, r["x"], r["z"], r["y"])
        for b in m["bases"]:
            c = b["core"]
            stamp(heights, size, c[0] if isinstance(c, list) else c["x"], c[1] if isinstance(c, list) else c["y"], 1)
            stamp(heights, size, b["gate"]["x"], b["gate"]["y"], 1)
            gc = b["groundConsole"]
            stamp(heights, size, gc[0] if isinstance(gc, list) else gc["x"], gc[1] if isinstance(gc, list) else gc["y"], 1)
            ac = b["airConsole"]
            stamp(heights, size, ac[0] if isinstance(ac, list) else ac["x"], ac[1] if isinstance(ac, list) else ac["y"], 1)
            stamp(heights, size, b["pad"]["x"], b["pad"]["y"], 1)
            for t in b["turrets"]:
                stamp(heights, size, t[0], t[1], 1)
        for s in m["spawns"]:
            stamp(heights, size, s["x"], s["y"], 1)
        for r in results:
            if r["label"].startswith("cap") or r["label"].startswith("out"):
                stamp(heights, size, r["x"], r["z"], r["y"])

        MAP_PATH.write_text(json.dumps(m) + "\n", encoding="utf-8")
        print("APPLY wrote", MAP_PATH)


if __name__ == "__main__":
    main()
    try:
        bpy.ops.wm.quit_blender()
    except Exception:
        pass
