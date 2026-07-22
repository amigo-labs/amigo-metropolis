# Parametric arena overlay builder for Blender (run via execute_blender_code:
#   MAP_ID=...; GLB_PATH=...; DATA_PATH=...; OUT_DIR=...; FLIP_Y=-1
#   exec(open(r".../build_map.py").read())
# Sets a global `_RESULT` dict. Aligns logic bbox centre -> glb bbox centre
# (per-map, parameter-free); by default flips row->Blender-Y (glTF Z import flip).
import bpy, bmesh, json, os, math, traceback
from mathutils import Vector

try:
    FLIP_Y = float(globals().get("FLIP_Y", -1.0))
    scene = bpy.context.scene

    # --- 1. clean (keep lights + camera + world) ---
    for o in list(bpy.data.objects):
        if o.type not in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections):
        if c.name != "Scene Collection":
            try: bpy.data.collections.remove(c)
            except Exception: pass
    for m in list(bpy.data.meshes):
        if m.users == 0: bpy.data.meshes.remove(m)

    # --- 2. import glb ---
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)
    imported = [o for o in bpy.data.objects if o not in before]
    terrain = [o for o in imported if o.type == "MESH"]
    tcol = bpy.data.collections.new("Terrain"); scene.collection.children.link(tcol)
    for o in imported:
        for c in list(o.users_collection): c.objects.unlink(o)
        tcol.objects.link(o)
    bpy.context.view_layer.update()

    # --- 3. glb bbox centre (Blender world) ---
    mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
    for o in terrain:
        for cor in o.bound_box:
            w = o.matrix_world @ Vector(cor)
            for i in range(3):
                mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
    glb_cx = (mn.x + mx.x) / 2; glb_cy = (mn.y + mx.y) / 2
    glb_size = max(mx.x - mn.x, mx.y - mn.y)

    # --- 4. data + logic bbox centre ---
    D = json.load(open(DATA_PATH))
    xs, zs = [], []
    for g in ("triggers", "turrets", "neutrals", "bases", "spawns", "pickups"):
        for a in D[g]: xs.append(a["x"]); zs.append(a["z"])
    for ln in D["lanes"]:
        for n in ln["nodes"]: xs.append(n["x"]); zs.append(n["z"])
    lcx = (min(xs) + max(xs)) / 2; lcy = (min(zs) + max(zs)) / 2

    def g2b(col, row):
        return (col - lcx + glb_cx, FLIP_Y * (row - lcy) + glb_cy)

    dg = bpy.context.evaluated_depsgraph_get()
    def ground_z(bx, by):
        hit, loc, *_ = scene.ray_cast(dg, Vector((bx, by, 2000.0)), Vector((0, 0, -1)))
        return loc.z if hit else 0.0

    # --- 5. PRECOMPUTE all placements (terrain only in scene -> clean raycasts) ---
    def pc(col, row):
        bx, by = g2b(col, row); return (bx, by, ground_z(bx, by))
    P = {
        "turrets": [(pc(t["x"], t["z"]), t.get("team")) for t in D["turrets"]],
        "neutrals": [pc(t["x"], t["z"]) for t in D["neutrals"]],
        "bases": [(pc(b["x"], b["z"]), b.get("team")) for b in D["bases"]],
        "spawns": [pc(s["x"], s["z"]) for s in D["spawns"]],
        "pickups": [pc(p["x"], p["z"]) for p in D["pickups"]],
        "triggers": [(pc(t["x"], t["z"]), max(t["w"],1.2), max(t["l"],1.2), t["kind"]) for t in D["triggers"]],
        "lanes": [[pc(n["x"], n["z"]) for n in ln["nodes"]] for ln in D["lanes"]],
    }

    # --- 6. materials (reuse-or-create) ---
    def mat_emit(name, rgb, s=3.0):
        m = bpy.data.materials.get(name)
        if m: return m
        m = bpy.data.materials.new(name); m.use_nodes = True
        nt = m.node_tree; nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission")
        em.inputs[0].default_value = (*rgb, 1.0); em.inputs[1].default_value = s
        nt.links.new(em.outputs[0], out.inputs[0]); return m
    def mat_trans(name, rgb, a):
        m = bpy.data.materials.get(name)
        if m: return m
        m = bpy.data.materials.new(name); m.use_nodes = True
        b = m.node_tree.nodes.get("Principled BSDF")
        b.inputs["Base Color"].default_value = (*rgb, 1.0)
        b.inputs["Emission Color"].default_value = (*rgb, 1.0)
        b.inputs["Emission Strength"].default_value = 0.6
        b.inputs["Alpha"].default_value = a
        try: m.blend_method = "BLEND"
        except Exception: pass
        try: m.surface_render_method = "BLENDED"
        except Exception: pass
        return m
    COL = {"t1": (0.15,0.45,1.0), "t2": (1.0,0.32,0.15), "neutral": (0.88,0.88,0.92),
           "spawn": (0.2,1.0,0.35), "pickup": (1.0,0.2,0.9), "laneA": (0.2,0.55,1.0), "laneB": (1.0,0.45,0.15)}
    M = {k: mat_emit("M_"+k, v, 1.7) for k, v in COL.items()}
    MT = {k: mat_trans("MT_"+k, c, a) for k, c, a in
          (("proximity",(1.0,0.12,0.08),0.22), ("watch",(1.0,0.82,0.1),0.30), ("button",(0.1,0.7,1.0),0.38))}

    # --- 7. build ---
    ov = bpy.data.collections.new("Overlay"); scene.collection.children.link(ov)
    c_lanes = bpy.data.collections.new("Lanes"); ov.children.link(c_lanes)
    c_trig = bpy.data.collections.new("Triggers"); ov.children.link(c_trig)
    c_mark = bpy.data.collections.new("Markers"); ov.children.link(c_mark)

    def prim(kind, **kw):
        bm = bmesh.new()
        if kind == "cube": bmesh.ops.create_cube(bm, size=1.0)
        elif kind == "cyl": bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=20, radius1=kw["r"], radius2=kw["r"], depth=kw["h"])
        elif kind == "cone": bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=20, radius1=kw["r"], radius2=0.0, depth=kw["h"])
        elif kind == "ico": bmesh.ops.create_icosphere(bm, subdivisions=2, radius=kw["r"])
        me = bpy.data.meshes.new(kind); bm.to_mesh(me); bm.free(); return me
    def place(me, name, x, y, z, coll, mat, scale=None):
        o = bpy.data.objects.new(name, me); o.location = (x, y, z)
        me.materials.append(mat); coll.objects.link(o)
        if scale: o.scale = scale
        return o

    for i, ((bx,by,gz), team) in enumerate(P["turrets"]):
        place(prim("cyl", r=1.25, h=3.0), f"TURR_{i}", bx, by, gz+1.5, c_mark, M["t1" if team==1 else "t2"])
    for i, (bx,by,gz) in enumerate(P["neutrals"]):
        place(prim("cyl", r=1.1, h=2.6), f"NEUT_{i}", bx, by, gz+1.3, c_mark, M["neutral"])
    for i, ((bx,by,gz), team) in enumerate(P["bases"]):
        place(prim("cube"), f"BASE_t{team}", bx, by, gz+3.0, c_mark, M["t1" if team==1 else "t2"], (6,6,6))
    for i, (bx,by,gz) in enumerate(P["spawns"]):
        place(prim("cone", r=2.0, h=5.0), f"SPAWN_{i}", bx, by, gz+2.5, c_mark, M["spawn"])
    for i, (bx,by,gz) in enumerate(P["pickups"]):
        place(prim("ico", r=1.2), f"PICKUP_{i}", bx, by, gz+1.8, c_mark, M["pickup"])
    VIS_H = 3.5
    for i, ((bx,by,gz), w, l, kind) in enumerate(P["triggers"]):
        place(prim("cube"), f"TRG_{kind}_{i}", bx, by, gz+VIS_H/2, c_trig, MT[kind], (w, l, VIS_H))
    lm = [M["laneA"], M["laneB"], M["neutral"]]
    for li, verts3 in enumerate(P["lanes"]):
        verts = [(x, y, z+0.4) for (x,y,z) in verts3]
        me = bpy.data.meshes.new(f"LANE_{li}")
        me.from_pydata(verts, D["lanes"][li]["edges"], []); me.update()
        o = bpy.data.objects.new(f"LANE_{li}", me); me.materials.append(lm[li % len(lm)])
        c_lanes.objects.link(o)
        o.modifiers.new("Skin", "SKIN")
        for sv in me.skin_vertices[0].data: sv.radius = (0.7, 0.7)
        o.modifiers.new("Subsurf", "SUBSURF").levels = 1

    # --- 8. lighting / view / world ---
    scene.view_settings.view_transform = "Standard"
    if scene.world is None: scene.world = bpy.data.worlds.new("W")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    if bg: bg.inputs[0].default_value = (0.35,0.38,0.45,1.0); bg.inputs[1].default_value = 1.25
    for nm, e, rot in (("KeySun",3.2,(math.radians(55),0,math.radians(30))),
                       ("FillSun",1.6,(math.radians(-40),0,math.radians(-150))),
                       ("TopSun",2.2,(0,0,0))):
        o = bpy.data.objects.get(nm)
        if o is None:
            ld = bpy.data.lights.new(nm, "SUN"); o = bpy.data.objects.new(nm, ld); scene.collection.objects.link(o)
        o.data.energy = e; o.rotation_euler = rot

    # --- 9. camera + renders ---
    cam = bpy.data.objects.get("RenderCam")
    if cam is None:
        cd = bpy.data.cameras.new("RenderCam"); cam = bpy.data.objects.new("RenderCam", cd); scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"; cam.data.clip_end = 5000.0
    scene.camera = cam
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try: scene.render.engine = eng; break
        except Exception: continue
    scene.render.resolution_x = 1680; scene.render.resolution_y = 1260
    scene.render.image_settings.file_format = "PNG"
    os.makedirs(OUT_DIR, exist_ok=True)
    tgt = Vector((glb_cx, glb_cy, 0.0))

    def render(path): scene.render.filepath = path; bpy.ops.render.render(write_still=True)

    # top-down (all)
    cam.location = (glb_cx, glb_cy, 1200.0); cam.rotation_euler = (0,0,0)
    cam.data.ortho_scale = glb_size * 1.02
    render(os.path.join(OUT_DIR, f"{MAP_ID}-top.png"))
    # iso (all)
    el = math.radians(56); az = math.radians(45)
    dirv = Vector((math.cos(el)*math.cos(az), math.cos(el)*math.sin(az), math.sin(el)))
    cam.location = tgt + dirv * 900.0
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.ortho_scale = glb_size * 1.05
    render(os.path.join(OUT_DIR, f"{MAP_ID}-iso.png"))
    # neutrals-only top (pad alignment check)
    for o in bpy.data.objects:
        if o.name.startswith(("TURR_","BASE_","SPAWN_","PICKUP_","TRG_","LANE_")): o.hide_render = True
    cam.location = (glb_cx, glb_cy, 1200.0); cam.rotation_euler = (0,0,0)
    cam.data.ortho_scale = glb_size * 1.02
    render(os.path.join(OUT_DIR, f"{MAP_ID}-neutcheck.png"))
    for o in bpy.data.objects: o.hide_render = False

    _RESULT = {"ok": True, "map": MAP_ID, "flip_y": FLIP_Y,
               "glb_center": [round(glb_cx,2), round(glb_cy,2)], "glb_size": round(glb_size,1),
               "logic_center": [round(lcx,2), round(lcy,2)], "terrain_meshes": len(terrain),
               "off_x": round(glb_cx - lcx, 2)}
except Exception as e:
    _RESULT = {"ok": False, "error": str(e), "tb": traceback.format_exc()[-1500:]}
result = _RESULT
